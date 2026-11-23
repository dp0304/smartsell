import { createHash, generateKeyPairSync } from 'node:crypto';
import { hostname } from 'node:os';
import { fields, opaqueId, type ConnectorClaim } from '../../../packages/connector-tasks/src/tasks.ts';
import { channelSelectionKey, createSignedHttpTransport, pairOverHttp, SignedDeviceClient, type ChannelRegistration, type DeviceBindings, type ZhihuStatsClaim, type ZhihuStatsResult, type ZhihuLoginCheckResult } from '../../connector/src/device-client.ts';
import type { BrowserTaskTab, ChannelSessions } from './channel-sessions.ts';
import { channelRows, registrationPlatform } from './channels.ts';
import { parseWorkbenchAddress, requestWorkbenchGrant } from './worker-pairing.ts';
import { PermitError } from '../../connector/src/permit.ts';
import { ConnectorRun, type AssistObservation, type LocalDriver, type PostResult, type Report, type TerminalResult } from '../../connector/src/workflow.ts';
import type { LocalState } from '../../connector/src/preflight.ts';
import { challengeReasons, creators, isPublish, parseReceipt, sellerPortal } from './policy.ts';
import { serviceOrigin } from './service-settings.ts';
import type { readCatalogFile } from './catalog-file.ts';
import type { Pairing, Vault } from './vault.ts';
import type { ZhihuBrowser } from './zhihu-chrome.ts';
import { parseSocialStatusResult, socialStatusPlatforms, type SocialStatusClaim, type SocialStatusResult } from '../../connector/src/social-status.ts';

const handoffWindow = 60_000;
const browserClaimDenied = '工作台拒绝了社媒任务。此运行期间已暂停社媒领单，请在工作台核对任务授权。';
class TaskNotAuthorized extends Error {}

async function isTaskDenial(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return false;
      chunks.push(value);
    }
    const { error } = fields(JSON.parse(Buffer.concat(chunks).toString('utf8')), ['error']);
    return fields(error, ['code']).code === 'CONNECTOR_TASK_NOT_AUTHORIZED';
  } catch { return false; }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

type Task = {
  claim: ConnectorClaim;
  portal: boolean;
  tab: BrowserTaskTab;
  authorizationDenied?: boolean;
  media: { name: string; hash: string }[];
  identityMatched: boolean;
  observation: AssistObservation;
  run?: ConnectorRun;
  receipt?: PostResult;
  until?: number;
  pending?: Report;
};

type PendingBrowserIdentity = NonNullable<Awaited<ReturnType<SignedDeviceClient['desktopHeartbeat']>>['pendingIdentity']>;
type CatalogJob = NonNullable<Awaited<ReturnType<SignedDeviceClient['claimCatalog']>>>;
type CatalogFile = Awaited<ReturnType<typeof readCatalogFile>>;
type CatalogTask = { job: CatalogJob; file?: CatalogFile; uploadDigest?: string; leaseEnded?: boolean };
type SocialStatusTask = { claim: SocialStatusClaim; expires: number; abort: AbortController; pending?: SocialStatusResult; retry?: boolean };
type ZhihuTask = { claim: ZhihuStatsClaim; expires: number; abort: AbortController; pending?: ZhihuStatsResult | ZhihuLoginCheckResult; retry?: boolean };
const zhihuManual = {
  manual: '知乎：未确认页面状态，请在专用 Chrome 核对，未发送报告。',
  challenge: '知乎：发现验证或安全提示，请在专用 Chrome 手动处理，未发送报告。',
  'sign-in-unrecognized': '知乎：未识别到可确认的官方登录控件，未发送报告。',
  'off-origin': '知乎：页面不在指定官方站点，未发送报告。',
  'page-error': '知乎：官方页面显示错误，未发送报告。',
};

type ConnectionIssue = 'stopped' | 'heartbeat' | 'authorization' | 'connect' | 'lease' | 'fence';
type ActivityAction = 'pair' | 'connect' | 'disconnect' | 'stop' | 'forget' | 'heartbeat' | 'lease' |
  'claim' | 'creator' | 'verify' | 'media' | 'confirm' | 'report' | 'block' | 'retry' |
  'service' | 'chromeConnect' | 'catalogClaim' | 'catalogPortal' | 'catalogFile' | 'catalogUpload' | 'catalogLease' | 'socialStatus' | 'zhihu' | 'channelScan' | 'channelRegister';
type ActivityResult = { tone: 'success' | 'neutral' | 'warning' | 'error'; result: string };
type ActivityContext = {
  app?: ConnectorClaim['task']['target']['app']; kind?: ConnectorClaim['task']['kind'];
  catalogProvider?: CatalogJob['provider']; catalogStore?: string;
};
type Activity = ActivityContext & ActivityResult & { id: number; action: ActivityAction; time: string };

const success = (result: string): ActivityResult => ({ tone: 'success', result });
const neutral = (result: string): ActivityResult => ({ tone: 'neutral', result });
const warning = (result: string): ActivityResult => ({ tone: 'warning', result });
const failure = (result: string): ActivityResult => ({ tone: 'error', result });

type Options = {
  origin?: string;
  version: string;
  platform: 'darwin' | 'win32';
  vault: Vault;
  openPlatform(id: string, url: string, signal: AbortSignal): Promise<void>;
  pickMedia(signal: AbortSignal): Promise<Task['media'] | undefined>;
  pickCatalog?(signal: AbortSignal): Promise<CatalogFile | undefined>;
  zhihu?: ZhihuBrowser;
  saveOrigin?(origin: string): void;
  openAuthorization?(url: string): Promise<void>;
  channels?: ChannelSessions;
  machineName?: string;
  fetcher?: typeof fetch;
  now?: () => number;
};

export class DesktopConnector {
  #pairing?: Pairing;
  #abort = new AbortController();
  #active?: Task;
  #catalog?: CatalogTask;
  #catalogResult?: Awaited<ReturnType<SignedDeviceClient['uploadCatalog']>>;
  #pendingIdentity?: PendingBrowserIdentity;
  #browserClaimDenied = false;
  #zhihu?: ZhihuTask;
  #socialStatus?: SocialStatusTask;
  #socialStatusAvailable = false;
  #connected = false;
  #online = false;
  #bindings?: DeviceBindings;
  #busy = false;
  #storageIssue = false;
  #storageVerified = false;
  #storageCheckFailed = false;
  #message = '';
  #connectionIssue?: ConnectionIssue;
  #activity: Activity[] = [];
  #activityId = 0;
  #now: () => number;
  #machineName: string;
  #authorization?: AbortController;
  #registrations = new Map<string, ChannelRegistration>();

  constructor(private readonly options: Options) {
    this.#now = options.now ?? Date.now;
    this.#machineName = (options.machineName ?? hostname()).replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100).trimEnd() || 'SmartSell Desktop';
    try {
      this.#pairing = options.vault.load();
      this.#storageVerified = Boolean(this.#pairing);
    } catch { this.#storageIssue = this.#storageCheckFailed = true; }
  }

  get #canStorePairing() {
    const { vault } = this.options;
    return !this.#storageIssue && (vault.check ? this.#storageVerified : vault.available());
  }

  checkStorage() {
    if (this.#busy || this.#pairing) throw new Error('当前不能检查系统安全存储。');
    const { vault } = this.options;
    this.#storageVerified = false;
    try {
      if (vault.check) vault.check();
      else if (!vault.available()) throw new Error('系统安全存储不可用。');
      if (this.#storageIssue) this.#pairing = vault.load();
      this.#storageIssue = this.#storageCheckFailed = false;
      this.#storageVerified = true;
    } catch {
      this.#storageCheckFailed = true;
      throw new Error('未能验证系统安全存储。请检查系统授权后重试。');
    }
  }

  snapshot() {
    const active = this.#active;
    const task = active?.claim.task;
    const catalog = this.#catalog;
    return {
      origin: this.options.origin, paired: Boolean(this.#pairing), device: this.#pairing?.device, workspace: this.#pairing?.workspace,
      serviceMatches: !this.#pairing || this.#pairing.origin === this.options.origin,
      connected: this.#connected, online: this.#online, busy: this.#busy, storageIssue: this.#storageIssue,
      connectionIssue: this.#connectionIssue, bindings: this.#bindings, pendingBrowserAccounts: this.#pendingIdentity?.length ?? 0, activity: this.#activity.slice(),
      secureStorage: this.options.vault.check ? this.#storageVerified : Boolean(this.options.origin) && this.options.vault.available(),
      storageCheckFailed: this.#storageCheckFailed, platform: this.options.platform, message: this.#message,
      machineName: this.#machineName,
      canPairWorkbench: Boolean(this.options.saveOrigin && !this.#pairing && this.#canStorePairing),
      canSetOrigin: Boolean(this.options.saveOrigin && !this.#pairing && !this.#storageIssue),
      awaitingAuthorization: Boolean(this.#authorization),
      registrations: [...this.#registrations.values()],
      catalogResult: this.#catalogResult,
      socialStatus: this.#socialStatus && { expires: this.#socialStatus.claim.lease_expires_at, pending: Boolean(this.#socialStatus.pending) },
      zhihu: this.#zhihu && { mode: this.#zhihu.claim.mode ?? 'stats', expires: this.#zhihu.claim.lease_expires_at, pending: Boolean(this.#zhihu.pending) },
      catalog: catalog && {
        id: catalog.job.id, store: catalog.job.store_name, provider: catalog.job.provider,
        externalId: catalog.job.external_store_id, expires: catalog.job.expires_at,
        expired: Boolean(catalog.leaseEnded || this.#now() >= Date.parse(catalog.job.expires_at)),
        canOpenPortal: Boolean(sellerPortal(catalog.job)), uploadUnconfirmed: Boolean(catalog.uploadDigest),
        file: catalog.file && { name: catalog.file.name, size: catalog.file.size },
      },
      task: task && active && {
        id: task.attempt_id, kind: task.kind, app: task.target.app, channel: task.target.channel, binding: task.binding_id,
        identity: task.platform_identity,
        revision: isPublish(task) ? task.payload.revision : undefined, expires: active.claim.lease_expires_at,
        expectedPost: 'platform_post_id' in task.payload ? task.payload.platform_post_id : undefined,
        portal: active.portal, identityMatched: active.identityMatched, media: active.media.map(media => ({ name: media.name, hash: media.hash })),
        until: active.until, pending: active.pending?.kind,
      },
    };
  }

  #fetch(signal: AbortSignal): typeof fetch {
    return async (input, init) => {
      signal.throwIfAborted();
      const response = await (this.options.fetcher ?? fetch)(input, {
        ...init, credentials: 'omit', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      // Only these signed routes can return a task-scoped authorization denial.
      if (response.status === 403 && input instanceof URL && input.origin === this.#pairing?.origin &&
        (input.pathname === '/api/v1/device/claim' || /^\/api\/v1\/attempts\/[^/]+\/ready$/.test(input.pathname)) &&
        await isTaskDenial(response)) throw new TaskNotAuthorized();
      return response;
    };
  }

  #client(signal: AbortSignal) {
    const paired = this.#pairing;
    if (!paired || paired.origin !== this.options.origin) throw new Error('当前服务的设备尚未配对。');
    return new SignedDeviceClient(paired.workspace, paired.device, paired.key, createSignedHttpTransport(paired.origin, this.#fetch(signal)), this.#now);
  }

  #context(): ActivityContext {
    const task = this.#active?.claim.task;
    if (task) return { app: task.target.app, kind: task.kind };
    const catalog = this.#catalog;
    if (catalog && !this.#catalogExpired(catalog)) return this.#catalogContext(catalog);
    return {};
  }

  #catalogContext({ job }: CatalogTask): ActivityContext {
    return { catalogProvider: job.provider, catalogStore: job.store_name };
  }

  #record(action: ActivityAction, result: ActivityResult, context: ActivityContext = {}) {
    this.#activity.unshift({ id: ++this.#activityId, action, time: new Date(this.#now()).toISOString(), ...result, ...context });
    if (this.#activity.length > 30) this.#activity.pop();
  }

  async #operation(action: ActivityAction, fn: (signal: AbortSignal) => Promise<ActivityResult>, context = this.#context()) {
    if (this.#busy) throw new Error('上一项操作仍在进行。');
    this.#busy = true;
    const signal = this.#abort.signal;
    try {
      const result = await fn(signal);
      if (!signal.aborted) this.#record(action, result, action === 'claim' || action === 'catalogClaim' ? this.#context() : context);
    } catch (error) {
      if (!signal.aborted) this.#record(action, failure(action === 'report' || action === 'retry' ? '回填未完成' : '操作失败'), context);
      throw error;
    } finally { this.#busy = false; }
  }

  setOrigin(input: unknown) {
    if (!this.options.saveOrigin || this.#pairing || this.#storageIssue || this.#busy) throw new Error('当前不能更改服务地址。');
    const origin = serviceOrigin(input);
    this.options.saveOrigin(origin);
    this.options.origin = origin;
    this.#connectionIssue = undefined;
    this.#message = '服务地址已保存。请使用此服务工作台提供的配对信息。';
    this.#record('service', success('服务地址已保存'));
  }

  async pair(input: unknown) {
    await this.#operation('pair', async signal => {
      const row = fields(input, ['workspace', 'code', 'name', 'ownsDevice']);
      const { origin, platform } = this.options;
      if (!origin || this.#pairing || !this.#canStorePairing || row.ownsDevice !== true ||
        typeof row.code !== 'string' || typeof row.name !== 'string') throw new Error('请确认设备所有权、服务配置及系统安全存储。');
      const workspace = opaqueId(row.workspace, 'workspace_id');
      const name = row.name.trim();
      await this.#pairDevice(origin, workspace, row.code, platform, name, signal);
      this.#message = '已配对。请手动连接。';
      return success('配对已保存');
    });
  }

  async #pairDevice(origin: string, workspace: string, code: string, platform: Options['platform'], name: string, signal: AbortSignal) {
    const { privateKey: key } = generateKeyPairSync('ed25519');
    const device = await pairOverHttp(origin, workspace, code, platform, name, key,
      { userInitiated: true, ownsDevice: true }, this.#fetch(signal));
    signal.throwIfAborted();
    try { this.options.vault.save({ origin, workspace, device, name, key }); }
    catch {
      this.#storageVerified = false;
      this.#storageCheckFailed = true;
      throw new Error(`无法保存配对。请在工作台撤销设备 ${device}，检查系统安全存储后重新配对。`);
    }
    this.#pairing = { origin, workspace, device, name, key };
  }

  async pairWorkbench(input: unknown) {
    await this.#operation('pair', async signal => {
      const { url, ownsDevice } = fields(input, ['url', 'ownsDevice']);
      const { platform, saveOrigin, openAuthorization } = this.options;
      if (ownsDevice !== true || !saveOrigin || this.#pairing || !this.#canStorePairing) {
        throw new Error('请选择本机并确认设备授权，系统安全存储须可用。');
      }
      const address = parseWorkbenchAddress(url);
      let { workspace, code } = address;
      if (!workspace || !code) {
        if (!openAuthorization) throw new Error('无法打开系统浏览器授权。');
        const authorization = new AbortController();
        this.#authorization = authorization;
        this.#message = '请在系统浏览器选择工作区并授权本机 Worker。';
        try {
          ({ workspace, code } = await requestWorkbenchGrant(address, this.#machineName, openAuthorization,
            AbortSignal.any([signal, authorization.signal])));
        } catch (error) {
          if (authorization.signal.aborted) {
            this.#message = '已取消浏览器授权。';
            return neutral('已取消浏览器授权');
          }
          if (!signal.aborted) this.#message = '';
          throw error;
        } finally { this.#authorization = undefined; }
      }
      signal.throwIfAborted();
      this.#message = '';
      saveOrigin(address.origin);
      this.options.origin = address.origin;
      try { await this.#pairDevice(address.origin, workspace, code, platform, this.#machineName, signal); }
      catch (error) {
        if (error instanceof PermitError) throw new Error('工作台拒绝了配对。请重新授权或复制新的 Worker 配对网址。');
        throw error;
      }
      try { await this.#connectDevice(signal); }
      catch (error) {
        signal.throwIfAborted();
        this.#message = '配对已保存。请检查网络和工作台设备授权，然后重新连接。';
        return warning('配对已保存，等候连接');
      }
      return success('配对已保存，工作台已确认在线');
    });
    void this.#pollWork();
  }

  cancelAuthorization() { this.#authorization?.abort(); }

  async #connectDevice(signal: AbortSignal) {
    try { await this.#heartbeat(signal); }
    catch (error) {
      if (!signal.aborted && !this.#connected) this.#connectionIssue = this.#isAuthorizationError(error) ? 'authorization' : 'connect';
      throw error;
    }
    signal.throwIfAborted();
    this.#connected = this.#online = true;
    this.#connectionIssue = undefined;
    this.#message = this.#browserClaimDenied ? browserClaimDenied : this.#pendingIdentity ? '已连接。Worker 会自动接收分配到本机的任务。'
      : '已连接。此服务版本未确认支持浏览器专用领单，社媒任务暂不可接收。';
  }

  async connect() {
    await this.#operation('connect', async signal => {
      await this.#connectDevice(signal);
      return success('服务已确认在线');
    });
    void this.#pollWork();
  }

  async connectChrome() {
    await this.#operation('chromeConnect', async signal => {
      if (!this.options.channels) throw new Error('专用 Chrome 连接不可用。');
      await this.options.channels.connectChrome(signal);
      return success('已连接专用 Google Chrome');
    });
  }

  async scanChannels() {
    await this.#operation('channelScan', async signal => {
      if (!this.#connected || !this.#online || !this.options.channels) throw new Error('请先连接本机 Worker。');
      await this.options.channels.scan(signal);
      return success('已检查专用 Chrome 的渠道');
    });
  }

  async registerChannels(input: unknown) {
    await this.#operation('channelRegister', async signal => {
      const row = fields(input, ['confirmed', 'selections']);
      if (!this.#connected || !this.#online || !this.options.channels || row.confirmed !== true) throw new Error('请连接本机 Worker，并确认要登记的渠道。');
      const client = this.#client(signal);
      const selections = await this.options.channels.recheck(row.selections, signal);
      try {
        const registrations = await client.registerChannels(selections);
        signal.throwIfAborted();
        for (const registration of registrations) this.#registrations.set(channelSelectionKey(registration), registration);
        this.#message = `工作台已确认登记 ${registrations.length} 个渠道。`;
        return success(this.#message);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PermitError && error.status === 409) throw new Error('工作台发现渠道绑定冲突。请在工作台检查是否已绑定其他设备，再重试。');
        if (error instanceof PermitError && error.status === 403) throw new Error('工作台未授权此设备登记渠道。请让工作区管理员检查设备授权。');
        if (error instanceof PermitError && error.status === 401) {
          this.#halt('authorization');
          throw new Error('本机设备授权已失效。请在工作台检查设备后重新连接。');
        }
        if (error instanceof PermitError && error.status === 422) throw new Error('工作台未接受本次渠道信息。请重新检查渠道与本机时间后重试。');
        throw new Error('未收到工作台的渠道登记确认。请检查网络后重试。');
      }
    });
  }

  #halt(issue?: ConnectionIssue) {
    this.#connectionIssue = issue;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#connected = this.#online = false;
    this.#bindings = this.#pendingIdentity = undefined;
    if (issue === 'authorization') this.#registrations.clear();
    this.#socialStatusAvailable = false;
    const social = this.#socialStatus;
    if (social && !(issue === 'heartbeat' && social.pending && social.retry)) {
      social.abort.abort();
      social.pending = undefined;
      social.retry = false;
      if (issue === 'fence' || issue === 'authorization') this.#socialStatus = undefined;
    }
    const zhihu = this.#zhihu;
    // A transient heartbeat failure can follow a lost report response. Keep only
    // that exact retryable report for manual reconnect; never resume observation.
    if (zhihu && !(issue === 'heartbeat' && zhihu.pending && zhihu.retry)) {
      zhihu.abort.abort();
      zhihu.pending = undefined;
      zhihu.retry = false;
      // Never resume the stopped task. Remember its lease only to keep the worker serial.
      if (issue === 'fence' || issue === 'authorization') this.#zhihu = undefined;
    }
    if (this.#catalog) this.#catalog.file = undefined;
    const active = this.#active;
    if (active && !active.pending) {
      active.pending = this.#report(active, active.until ? { kind: 'outcome_unknown' } : this.#blocked('assist_closed'));
    }
    if (active) {
      active.media = [];
      active.run = undefined;
      active.receipt = undefined;
    }
  }

  stop() {
    this.#halt('stopped');
    this.#message = '已停止本机操作。请停止操作已打开的官方页面。';
    this.#record('stop', warning('本机操作已停止'), this.#context());
  }

  disconnect() {
    this.#halt();
    this.#message = '已断开。配对仍保留，可手动重新连接。';
    this.#record('disconnect', neutral('已断开，配对已保留'));
  }

  forget() {
    this.#halt();
    try { this.options.vault.clear(); }
    catch (error) {
      this.#record('forget', failure('无法清除本机配对'));
      throw error;
    }
    this.#activity = [];
    this.#pairing = this.#active = this.#zhihu = this.#socialStatus = undefined;
    this.#browserClaimDenied = false;
    this.#catalog = this.#catalogResult = undefined;
    this.#registrations.clear();
    this.#storageIssue = false;
    this.#message = '已注销本机配对。请在工作台撤销服务端设备。';
    this.#record('forget', success('本机配对已注销'));
  }

  async tick() {
    this.#expireZhihu();
    this.#expireSocialStatus();
    const catalog = this.#catalog;
    if (catalog && !catalog.leaseEnded && this.#catalogExpired(catalog)) {
      catalog.leaseEnded = true;
      catalog.file = undefined;
      this.#record('catalogLease', warning('租约过期，请到工作台核实'), this.#catalogContext(catalog));
    }
    const active = this.#active;
    if (active && this.#now() >= Date.parse(active.claim.lease_expires_at)) {
      this.#record('lease', warning('租约过期，需到工作台核实结果'), this.#context());
      this.#halt('lease');
      this.#active = undefined;
      this.#message = '任务租约已过期。请到工作台核实结果。';
    }
    if (!this.#connected || this.#busy) return;
    this.#busy = true;
    const signal = this.#abort.signal;
    try {
      await this.#heartbeat(signal);
      this.#online = true;
    } catch (error) {
      if (signal.aborted) return;
      const authorization = this.#isAuthorizationError(error);
      this.#halt(authorization ? 'authorization' : 'heartbeat');
      this.#message = authorization ? '设备授权已失效或服务拒绝请求。请在工作台检查设备。' : '心跳失败，已停止本机操作。';
      this.#record('heartbeat', failure(this.#message), this.#context());
    } finally { this.#busy = false; }
    await this.#pollWork();
  }

  async #heartbeat(signal: AbortSignal) {
    const { bindings, pendingIdentity, socialStatus } = await this.#client(signal).desktopHeartbeat(this.options.version);
    signal.throwIfAborted();
    this.#bindings = bindings;
    this.#pendingIdentity = pendingIdentity;
    this.#socialStatusAvailable = socialStatus;
  }

  async #pollWork() {
    if (!this.#connected || !this.#online || this.#busy || (this.#catalog && !this.#catalogExpired(this.#catalog))) return;
    const signal = this.#abort.signal;
    this.#busy = true;
    let action: ActivityAction = 'claim';
    try {
      const client = this.#client(signal);
      if (this.#active) {
        const active = this.#active;
        if (!active.pending && !active.until && !active.identityMatched) await this.#prepareBrowserTask(active, signal);
        return;
      }
      if (this.#zhihu) {
        if (this.#zhihu.retry) await this.#sendZhihu(this.#zhihu, signal);
        return;
      }
      if (this.#socialStatus) {
        if (this.#socialStatusAvailable && this.#socialStatus.retry) await this.#sendSocialStatus(this.#socialStatus, signal);
        return;
      }
      if (this.#pendingIdentity) {
        await this.#recheckBindings(client, this.#pendingIdentity, signal);
        const claim = this.#browserClaimDenied ? null : await client.claim(undefined, 'browser').catch(error => {
          if (!(error instanceof TaskNotAuthorized)) throw error;
          signal.throwIfAborted();
          // A refused claim has no attempt ID or cursor. Polling again could select the same task.
          this.#browserClaimDenied = true;
          this.#message = browserClaimDenied;
          this.#record('claim', warning(browserClaimDenied));
          return null;
        });
        signal.throwIfAborted();
        if (claim) {
          if (Date.parse(claim.lease_expires_at) <= this.#now()) throw new Error('Browser claim expired');
          const active: Task = { claim, portal: false, tab: {}, media: [], identityMatched: false, observation: 'waiting' };
          this.#active = active;
          this.#record('claim', success('已收到工作台派发的浏览器任务'), this.#context());
          await this.#prepareBrowserTask(active, signal);
          return;
        }
      }
      action = 'zhihu';
      const zhihu = this.options.zhihu && await client.claimZhihuStats().catch(error => this.#optionalClaim(error));
      signal.throwIfAborted();
      if (zhihu) {
        await this.#runZhihu(zhihu, signal);
        return;
      }
      if (this.#socialStatusAvailable && this.options.channels) {
        action = 'socialStatus';
        const social = await client.claimSocialStatus().catch(error => this.#optionalClaim(error));
        signal.throwIfAborted();
        if (social) {
          await this.#runSocialStatus(social, signal);
          return;
        }
      }
      action = 'catalogClaim';
      const job = await client.claimCatalog().catch(error => this.#optionalClaim(error));
      signal.throwIfAborted();
      if (!job) return;
      if (Date.parse(job.expires_at) <= this.#now()) throw new Error('Catalog claim expired');
      this.#catalog = { job };
      this.#catalogResult = undefined;
      this.#record('catalogClaim', success('已收到工作台派发的商品任务'), this.#context());
    } catch (error) {
      if (signal.aborted) return;
      const authorization = this.#isAuthorizationError(error);
      this.#halt(authorization ? 'authorization' : 'heartbeat');
      this.#message = authorization ? '设备授权已失效或服务拒绝请求。请在工作台检查设备。' : '未能确认工作台任务状态，已停止接收任务。请检查连接后重试。';
      this.#record(action, failure(this.#message), this.#context());
    } finally { this.#busy = false; }
  }

  #optionalClaim(error: unknown): null {
    if (error instanceof PermitError && error.status === 404) return null;
    throw error;
  }

  async #recheckBindings(client: SignedDeviceClient, pending: PendingBrowserIdentity, signal: AbortSignal) {
    const channels = this.options.channels;
    if (!channels) return;
    for (const { id, group } of channelRows) {
      if (group !== 'social') continue;
      const candidates = pending.filter(binding => registrationPlatform(id, binding.identity) === binding.platform);
      if (!candidates.length) continue;
      const observed = await channels.observeOpenTab(id, signal);
      signal.throwIfAborted();
      if (observed.kind !== 'identity') continue;
      const matches = candidates.filter(binding => binding.identity === observed.identity);
      if (matches.length !== 1) continue;
      const [binding] = matches;
      try {
        const status = await client.reportIdentity('browser', binding.sessionId, observed.identity, binding.bindingId);
        signal.throwIfAborted();
        if (status === 'verified') this.#pendingIdentity = pending.filter(item => item !== binding);
        this.#record('verify', status === 'verified' ? success('工作台已复核本机账号') : warning('工作台未确认账号复核'));
      } catch (error) {
        // The binding may have changed after the heartbeat. Re-read it next time.
        if (!(error instanceof PermitError && error.status === 409)) throw error;
      }
      return;
    }
  }

  #expireSocialStatus() {
    const task = this.#socialStatus;
    if (task && this.#now() >= task.expires) {
      task.abort.abort();
      this.#socialStatus = undefined;
      this.#record('socialStatus', warning('社媒查询租约已到期，请到工作台核实结果。'));
    }
  }

  async #runSocialStatus(claim: SocialStatusClaim, signal: AbortSignal) {
    const task: SocialStatusTask = { claim, expires: Date.parse(claim.lease_expires_at), abort: new AbortController() };
    this.#socialStatus = task;
    const remaining = task.expires - this.#now();
    if (remaining <= 0) { this.#expireSocialStatus(); return; }
    const browserSignal = AbortSignal.any([signal, task.abort.signal, AbortSignal.timeout(Math.min(25_000, remaining))]);
    let result: SocialStatusResult;
    try {
      result = parseSocialStatusResult(await this.options.channels!.readSocialStatus(claim, browserSignal), claim);
      browserSignal.throwIfAborted();
    } catch {
      const platforms = claim.platform ? [claim.platform] : claim.mode === 'recent_posts' ? ['x'] as const : socialStatusPlatforms;
      result = { channels: platforms.map(platform => ({ platform, status: 'unverified' })) };
    }
    signal.throwIfAborted();
    this.#expireSocialStatus();
    if (this.#socialStatus !== task || task.abort.signal.aborted) return;
    task.pending = result;
    await this.#sendSocialStatus(task, signal);
  }

  async #sendSocialStatus(task: SocialStatusTask, signal: AbortSignal) {
    const remaining = task.expires - this.#now();
    if (this.#socialStatus !== task || !task.pending || remaining <= 0) { this.#expireSocialStatus(); return; }
    const reportSignal = AbortSignal.any([signal, task.abort.signal, AbortSignal.timeout(Math.min(10_000, remaining))]);
    try {
      const status = await this.#client(reportSignal).reportSocialStatus(task.claim, task.pending);
      signal.throwIfAborted();
      this.#expireSocialStatus();
      if (this.#socialStatus !== task) return;
      this.#socialStatus = undefined;
      this.#record('socialStatus', status === 'completed' ? success('工作台已确认社媒查询回填。') : warning('社媒查询受限，工作台已收到状态。'));
    } catch (error) {
      if (signal.aborted || this.#socialStatus !== task) return;
      if (error instanceof PermitError && [401, 403, 404, 409, 410].includes(error.status)) {
        this.#halt(this.#isAuthorizationError(error) ? 'authorization' : 'fence');
        this.#message = '服务未接受社媒查询回报，请到工作台核实设备和任务状态。';
        this.#record('socialStatus', warning(this.#message));
        return;
      }
      this.#expireSocialStatus();
      if (this.#socialStatus !== task) return;
      const retry = !(error instanceof PermitError) || error.status === 429 || error.status >= 500;
      if (task.retry !== retry) this.#record('socialStatus', warning(retry
        ? '社媒查询回报尚未确认，仅会重试同一回报。' : '服务拒绝了社媒查询回报，请到工作台核实。'));
      task.retry = retry;
    }
  }

  #expireZhihu() {
    if (this.#zhihu && this.#now() >= this.#zhihu.expires) {
      this.#zhihu.abort.abort();
      this.#zhihu = undefined;
      this.#record('zhihu', warning('知乎：任务租约已到期，请到工作台核实结果。'));
    }
  }

  async #runZhihu(claim: ZhihuStatsClaim, signal: AbortSignal) {
    const browser = this.options.zhihu!;
    const task: ZhihuTask = { claim, expires: Date.parse(claim.lease_expires_at), abort: new AbortController() };
    this.#zhihu = task;
    const remaining = task.expires - this.#now();
    if (remaining <= 0) { this.#expireZhihu(); return; }
    const browserSignal = AbortSignal.any([signal, task.abort.signal, AbortSignal.timeout(Math.min(25_000, remaining))]);
    let result: Awaited<ReturnType<ZhihuBrowser['read'] | ZhihuBrowser['checkLogin']>>;
    try {
      await browser.openLogin(browserSignal);
      browserSignal.throwIfAborted();
      result = claim.mode === 'login_check' ? await browser.checkLogin(browserSignal)
        : await browser.read(claim.profile_slug, browserSignal);
      browserSignal.throwIfAborted();
    } catch { result = 'manual'; }
    signal.throwIfAborted();
    this.#expireZhihu();
    if (this.#zhihu !== task) return;
    if (result === 'signed_in') task.pending = { status: 'completed' };
    else if (result === 'login_required') task.pending = { status: 'blocked', reason: 'login_required' };
    else if (typeof result === 'string') { this.#record('zhihu', warning(zhihuManual[result])); return; }
    else task.pending = result;
    await this.#sendZhihu(task, signal);
  }

  async #sendZhihu(task: ZhihuTask, signal: AbortSignal) {
    const remaining = task.expires - this.#now();
    if (this.#zhihu !== task || !task.pending || remaining <= 0) { this.#expireZhihu(); return; }
    const { id, fencing_token } = task.claim;
    const result = task.pending;
    const reportSignal = AbortSignal.any([signal, task.abort.signal, AbortSignal.timeout(Math.min(10_000, remaining))]);
    try {
      await this.#client(reportSignal).reportZhihuStats({ id, fencing_token, result });
      signal.throwIfAborted();
      if (this.#zhihu !== task) return;
      this.#zhihu = undefined;
      const outcome = result.status === 'completed'
        ? success(task.claim.mode === 'login_check' ? '知乎：已确认登录状态，未读取或提交统计。' : '知乎：工作台已确认只读统计回填。')
        : warning(result.reason === 'login_required' ? '知乎：已报告需要在专用 Chrome 手动登录，未提交统计。'
          : result.reason === 'identity_mismatch' ? '知乎：账号不匹配，已报告中止，未提交统计。' : '知乎：已报告无法确认可见统计。');
      this.#record('zhihu', outcome);
    } catch (error) {
      if (signal.aborted || this.#zhihu !== task) return;
      if (error instanceof PermitError && [401, 403, 404, 409, 410].includes(error.status)) {
        this.#halt(this.#isAuthorizationError(error) ? 'authorization' : 'fence');
        this.#message = '服务未接受知乎任务报告。请到工作台核实设备和任务状态。';
        this.#record('zhihu', warning(this.#message));
        return;
      }
      this.#expireZhihu();
      if (this.#zhihu !== task) return;
      const retry = !(error instanceof PermitError) || error.status === 429 || error.status >= 500;
      if (task.retry !== retry) this.#record('zhihu', warning(retry
        ? '知乎：报告尚未确认，仅会重试同一报告，不会重复读取。' : '知乎：报告被拒绝，请到工作台核实。'));
      task.retry = retry;
    }
  }

  #isAuthorizationError(error: unknown) {
    return error instanceof PermitError && [401, 403, 404].includes(error.status);
  }

  #requireConnection() {
    if (!this.#connected || !this.#online) throw new Error('请先连接服务。');
  }

  #catalogExpired(task: CatalogTask) {
    return task.leaseEnded || this.#now() >= Date.parse(task.job.expires_at);
  }

  #liveCatalog() {
    this.#requireConnection();
    if (!this.#catalog || this.#catalogExpired(this.#catalog)) throw new Error('商品任务租约已结束。请在工作台核对状态。');
    return this.#catalog;
  }

  async openCatalogPortal() {
    await this.#operation('catalogPortal', async signal => {
      const { job } = this.#liveCatalog();
      const url = sellerPortal(job);
      if (!url) throw new Error('任务未提供受支持的官方卖家后台地址。');
      await this.options.openPlatform(job.provider, url, signal);
      signal.throwIfAborted();
      return success('已在专用浏览器打开官方卖家后台');
    });
  }

  async selectCatalogFile() {
    await this.#operation('catalogFile', async signal => {
      const task = this.#liveCatalog();
      if (!this.options.pickCatalog) throw new Error('当前无法选择商品导出表。');
      task.file = undefined;
      const file = await this.options.pickCatalog(signal);
      signal.throwIfAborted();
      this.#liveCatalog();
      if (!file) return neutral('已取消选择商品表');
      if (task.uploadDigest && task.uploadDigest !== createHash('sha256').update(file.csv).digest('hex')) {
        throw new Error('上次提交尚未确认，请选回同一份商品表或到工作台核对。');
      }
      task.file = file;
      return success('商品表已在本机检查');
    });
  }

  async uploadCatalog(input: unknown) {
    await this.#operation('catalogUpload', async signal => {
      const task = this.#liveCatalog();
      const { observed, confirmed } = fields(input, ['observed', 'confirmed']);
      if (confirmed !== true || typeof observed !== 'string' || observed.trim() !== task.job.external_store_id) {
        throw new Error('请核对官方页面上显示的实际店铺 ID，并确认导出内容后重试。');
      }
      const file = task.file;
      if (!file) throw new Error('请先选择商品导出表。');
      const client = this.#client(signal);
      await client.heartbeat(this.options.version);
      signal.throwIfAborted();
      this.#liveCatalog();
      const priorDigest = task.uploadDigest;
      task.uploadDigest = createHash('sha256').update(file.csv).digest('hex');
      try {
        const result = await client.uploadCatalog(task.job, task.job.external_store_id, { csv: file.csv });
        signal.throwIfAborted();
        this.#catalogResult = result;
        this.#catalog = undefined;
        return success('商品数据已送工作台预览');
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PermitError && [409, 410].includes(error.status)) {
          task.leaseEnded = true;
          task.file = undefined;
          throw new Error('服务未接受此任务租约。请在工作台确认是否已收到预览。');
        }
        if (error instanceof PermitError && [400, 413, 422].includes(error.status)) {
          task.uploadDigest = priorDigest;
          throw new Error('服务拒绝了商品表。请检查格式、大小与商品列后重新选择。');
        }
        throw error;
      }
    });
  }

  async #prepareBrowserTask(active: Task, signal: AbortSignal) {
    const task = active.claim.task;
    const context = this.#context();
    if (task.target.channel !== 'browser' || (isPublish(task) && task.payload.revision.draft)) {
      this.#record('report', await this.#send(active, this.#blocked('unsupported'), signal), context);
      return;
    }
    const blocked = await this.#checkTaskIdentity(active, signal, true);
    if (this.#now() >= Date.parse(active.claim.lease_expires_at)) return;
    if (blocked) {
      this.#record('report', await this.#send(active, blocked, signal), context);
      return;
    }
    if (!active.identityMatched) {
      this.#message = active.portal ? '等待从专用 Chrome 确认账号。请完成必要登录并显示账号资料。'
        : '等待从专用 Chrome 确认账号。当前未读到可用的官方标签页。';
      return;
    }
    if (task.kind === 'session.verify_identity') {
      try { await this.#ready(active, task.platform_identity, signal); }
      catch (error) {
        if (!(error instanceof TaskNotAuthorized)) throw error;
        this.#record('report', await this.#send(active, this.#blocked('approval_invalid'), signal), context);
        return;
      }
      signal.throwIfAborted();
      this.#live();
      this.#record('verify', await this.#send(active, { kind: 'identity_verified' }, signal), context);
      return;
    }
    this.#message = '已核对 Chrome 账号。请按当前任务提示完成人工交接。';
  }

  async #checkTaskIdentity(active: Task, signal: AbortSignal, prepare = false): Promise<TerminalResult | undefined> {
    const task = active.claim.task;
    if (task.target.channel !== 'browser') throw new Error('浏览器任务配置无效。');
    const remaining = Date.parse(active.claim.lease_expires_at) - this.#now();
    if (remaining <= 0) {
      if (prepare) return;
      throw new Error('任务已结束。');
    }
    const lease = AbortSignal.timeout(remaining);
    const browserSignal = AbortSignal.any([signal, lease]);
    const channels = this.options.channels;
    const scheduled = prepare ? channels?.observeTaskTab(task.target.app, active.tab, browserSignal)
      : channels?.observeOpenTab(task.target.app, browserSignal);
    const observation = await scheduled?.catch(error => {
      if (!lease.aborted) throw error;
    });
    signal.throwIfAborted();
    if (prepare && this.#now() >= Date.parse(active.claim.lease_expires_at)) return;
    if (this.#live() !== active || lease.aborted) throw new Error('任务已结束。');
    if (active.tab.available) active.portal = true;
    active.identityMatched = observation?.kind === 'identity' && observation.identity === task.platform_identity;
    if (observation?.kind === 'login') return this.#blocked('login_expired');
    if (observation?.kind === 'identity' && !active.identityMatched) return this.#blocked('identity_mismatch');
  }

  #live() {
    this.#requireConnection();
    const active = this.#active;
    if (!active || active.pending || this.#now() >= Date.parse(active.claim.lease_expires_at)) throw new Error('当前没有可操作的任务。');
    return active;
  }

  async openCreator() {
    await this.#operation('creator', async signal => {
      const active = this.#live();
      const target = active.claim.task.target;
      if (target.channel !== 'browser') throw new Error('当前设备仅支持桌面浏览器交付。');
      await this.options.openPlatform(target.app, creators[target.app], signal);
      signal.throwIfAborted();
      active.portal = true;
      return success('已在专用 Chrome 打开官方页面');
    });
  }

  async selectMedia() {
    await this.#operation('media', async signal => {
      const active = this.#live();
      if (!isPublish(active.claim.task) || active.until) throw new Error('当前任务不能选取媒体。');
      const picked = await this.options.pickMedia(signal);
      signal.throwIfAborted();
      if (this.#live() !== active) throw new Error('任务已结束。');
      if (!picked) return neutral('已取消选择');
      active.media = picked;
      return success(`已读取 ${picked.length} 个本机文件的 SHA-256`);
    });
  }

  async confirm(input: unknown) {
    await this.#operation('confirm', async signal => {
      const active = this.#live();
      const task = active.claim.task;
      if (!active.portal || active.until || task.target.channel !== 'browser') throw new Error('请先打开官方页面。');
      const row = fields(input, ['confirmed']);
      if (row.confirmed !== true) throw new Error('请确认账号所有权、专用浏览器配置及任务内容。');
      const blocked = await this.#checkTaskIdentity(active, signal);
      if (blocked) return this.#send(active, blocked, signal);
      if (!active.identityMatched) throw new Error('未能从官方页面确认实际登录的账号。请打开账号资料后重试。');
      const observed = task.platform_identity;
      const client = this.#client(signal);
      if (!isPublish(task)) {
        try { await this.#ready(active, observed, signal); }
        catch (error) {
          if (!(error instanceof TaskNotAuthorized)) throw error;
          return this.#send(active, this.#blocked('approval_invalid'), signal);
        }
      }
      signal.throwIfAborted();
      this.#live();
      active.run = new ConnectorRun(active.claim, this.#driver(active, signal), client, this.#now, handoffWindow,
        (_claim, identity) => this.#ready(active, identity, signal));
      active.run.applyHeartbeat('assist');
      if (task.kind === 'post.capture_result' || task.kind === 'post.verify_visible') {
        active.until = Date.parse(active.claim.lease_expires_at);
        this.#message = '请在官方页面核实原作品。';
        return success('已核对账号，等待人工核实原作品');
      }
      return this.#advance(active, signal);
    });
  }

  async #ready(active: Task, identity: string, signal: AbortSignal) {
    try { await this.#client(signal).ready(active.claim, identity); }
    catch (error) {
      if (error instanceof TaskNotAuthorized) active.authorizationDenied = true;
      if (!signal.aborted && this.#isAuthorizationError(error)) {
        this.#message = '设备授权已失效或服务拒绝请求。请在工作台检查设备。';
        this.#record('heartbeat', failure(this.#message), this.#context());
        this.#halt('authorization');
      }
      throw error;
    }
    signal.throwIfAborted();
  }

  #driver(active: Task, signal: AbortSignal): LocalDriver {
    const task = active.claim.task;
    if (task.target.channel !== 'browser') throw new Error('浏览器任务配置无效。');
    const state: LocalState = {
      host: this.options.platform, phase: 'P0b', phones: [],
      pairing: { device_id: this.#pairing!.device, workspace_id: this.#pairing!.workspace, owned: true, revoked: false },
      bindings: [{ id: task.binding_id, workspace_id: task.workspace_id, account_id: task.account_id, connector_device_id: task.connector_device_id,
        platform_identity: task.platform_identity, owned: true, verified: true, consent_confirmed: true, dedicated: true, ...task.target }],
    };
    return {
      state: () => state,
      identity: () => ({ kind: 'signed_in', platform_identity: task.platform_identity }),
      approvalValid: () => true, // Claimed frozen content and signed ready are validated by the service.
      mediaAvailable: refs => {
        const selected = active.media.map(media => media.hash).sort();
        return refs.length === selected.length && refs.map(ref => ref.sha256).sort().every((hash, index) => hash === selected[index]);
      },
      draftMatches: () => false,
      stage: () => {}, // The user has already staged and reviewed the revision in the official page.
      openAssist: (_task, expiresAt) => {
        signal.throwIfAborted();
        active.until = expiresAt;
      },
      observeAssist: () => active.observation,
      closeAssist: () => 'unknown',
      submitAuto: () => { throw new Error('桌面端仅支持人工交付。'); },
      capture: () => active.receipt,
      // Visibility uses the fixed signed report after explicit confirmation in finish().
      verify: () => { throw new Error('需要人工确认作品可见性。'); },
      pushMedia: () => false,
      cleanup: () => false,
    };
  }

  async finish(input: unknown) {
    await this.#operation('report', async signal => {
      const active = this.#live();
      const task = active.claim.task;
      const row = fields(input, ['result'], ['receipt']);
      if (!active.run || !active.until || task.target.channel !== 'browser') throw new Error('请先确认实际登录的账号。');
      if (row.result === 'unknown' || this.#now() >= active.until) {
        return this.#send(active, { kind: 'outcome_unknown' }, signal);
      } else if (task.kind === 'post.verify_visible' && (row.result === 'visible' || row.result === 'not_visible')) {
        return this.#send(active, { kind: 'visibility_checked', visible: row.result === 'visible' }, signal);
      } else if ((isPublish(task) && row.result === 'submitted') || (task.kind === 'post.capture_result' && row.result === 'captured')) {
        const expected = task.kind === 'post.capture_result' ? task.payload.platform_post_id : undefined;
        if (row.receipt !== undefined) active.receipt = parseReceipt(row.receipt, task.target.app, expected);
        if (task.kind === 'post.capture_result' && !active.receipt) throw new Error('请提供预登记的脱敏证据。');
        const prior = active.run.report();
        if (prior?.kind === 'accepted' || prior?.kind === 'result_captured') {
          if (!active.receipt) throw new Error('请提供更正后的证据，或选择结果未知。');
          return this.#send(active, { ...prior, ...active.receipt }, signal);
        }
        active.observation = 'submitted';
        return this.#advance(active, signal);
      } else {
        throw new Error('无效的任务结果。');
      }
    });
  }

  async block(input: unknown) {
    await this.#operation('block', async signal => {
      const active = this.#live();
      const row = fields(input, ['reason']);
      const reason = challengeReasons.find(item => item === row.reason);
      if (!reason) throw new Error('无效的中止原因。');
      return this.#send(active, active.until ? { kind: 'outcome_unknown' } : this.#blocked(reason), signal);
    });
  }

  #blocked(reason: Extract<TerminalResult, { kind: 'blocked' }>['reason']): TerminalResult {
    return { kind: 'blocked', reason, handoff: this.#active?.claim.task.kind === 'tiktok.app.publish' ? 'awaiting_creator_action' : 'manual',
      ...(['captcha', 'risk_control', 'identity_mismatch'].includes(reason) && { auto_stop: reason as 'captcha' | 'risk_control' | 'identity_mismatch' }) };
  }

  async #advance(active: Task, signal: AbortSignal) {
    const result = await active.run!.advance();
    signal.throwIfAborted();
    if (active.authorizationDenied) return this.#send(active, this.#blocked('approval_invalid'), signal);
    if (result.kind === 'awaiting_user_click') {
      this.#message = '请在官方页面亲自提交一次，再回填结果。';
      return neutral('已交接，等待人工提交');
    }
    if (result.kind === 'awaiting_submit_permit') return neutral('等待提交许可');
    return this.#send(active, result, signal);
  }

  #report(active: Task, result: TerminalResult): Report {
    return { ...result, attempt_id: active.claim.task.attempt_id, fencing_token: active.claim.fencing_token };
  }

  async #send(active: Task, result: TerminalResult, signal: AbortSignal) {
    active.pending = this.#report(active, result);
    return this.#flush(active, signal);
  }

  async #flush(active: Task, signal: AbortSignal) {
    const report = active.pending!;
    if (this.#now() >= Date.parse(active.claim.lease_expires_at)) throw new Error('任务租约已过期。请在工作台核实。');
    try {
      const { status } = fields(await this.#client(signal).report(report), ['status']);
      signal.throwIfAborted();
      const expected = report.kind === 'accepted' || report.kind === 'outcome_unknown' ? 'outcome_unknown' : 'completed';
      if (status !== expected) throw new Error('Unexpected report acknowledgement');
      this.#active = undefined;
      this.#message = expected === 'outcome_unknown' ? '已回填。请在工作台核实发布结果。' : '任务结果已回填。';
      switch (report.kind) {
        case 'accepted': return warning('人工提交已回填，发布结果待核实');
        case 'outcome_unknown': return warning('已回填，结果未知');
        case 'blocked': {
          const reasons: Partial<Record<typeof report.reason, string>> = {
            captcha: '验证码', risk_control: '风控提示', app_prompt: '平台弹窗', login_expired: '登录失效',
            identity_mismatch: '账号不匹配', media_unverified: '媒体校验未通过', approval_invalid: '工作台拒绝了任务授权', unsupported: '当前版本不支持此任务',
          };
          const reason = reasons[report.reason];
          return warning(reason ? `中止报告已送达：${reason}` : '中止报告已送达');
        }
        case 'result_captured': return success('作品证据已回填');
        case 'visibility_checked': return report.visible ? success('已回填观察结果：作品可见') : warning('已回填观察结果：作品不可见');
        default: return success('任务报告已送达');
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof PermitError && error.status === 422 && (report.kind === 'accepted' || report.kind === 'result_captured')) {
        active.pending = undefined;
        throw new Error('服务拒绝了证据。请核对预登记记录后重新回填，或标记结果未知。');
      }
      if (this.#isAuthorizationError(error)) {
        this.#halt('authorization');
        this.#message = '设备授权已失效或服务拒绝请求。请在工作台检查设备。';
        this.#record('report', failure(this.#message), this.#context());
        throw new Error(this.#message);
      }
      if (error instanceof PermitError && error.status === 409) {
        this.#record('report', failure('服务拒绝任务令牌，结果需核实'), this.#context());
        this.#halt('fence');
        this.#active = undefined;
        throw new Error('服务未接受该任务令牌。请在工作台核实任务和结果。');
      }
      throw new Error('回填未获确认。可重试同一条报告，请勿重复提交作品。');
    }
  }

  async retryReport() {
    await this.#operation('retry', async signal => {
      if (!this.#active?.pending) throw new Error('没有待重试的报告。');
      return this.#flush(this.#active, signal);
    });
  }
}
