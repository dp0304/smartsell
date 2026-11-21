import { DesktopError } from './errors.ts';
import { defaultLanguage, translate, type DesktopLanguage } from '../ui/i18n.mjs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fields, opaqueId, parseConnectorClaim, type ConnectorClaim } from '../../../packages/connector-tasks/src/tasks.ts';
import { createSignedHttpTransport, pairOverHttp, SignedDeviceClient, type DeviceBindings } from '../../connector/src/device-client.ts';
import { PermitError } from '../../connector/src/permit.ts';
import { ConnectorRun, type AssistObservation, type IdentityObservation, type LocalDriver, type PostResult, type Report, type TerminalResult } from '../../connector/src/workflow.ts';
import type { LocalState } from '../../connector/src/preflight.ts';
import { challengeReasons, creators, isPublish, parseReceipt, sellerPortal } from './policy.ts';
import { serviceOrigin } from './service-settings.ts';
import type { readCatalogFile } from './catalog-file.ts';
import type { Pairing, Vault } from './vault.ts';

const handoffWindow = 60_000;
type Task = {
  claim: ConnectorClaim;
  portal: boolean;
  media: { name: string; hash: string }[];
  identity: IdentityObservation;
  observation: AssistObservation;
  run?: ConnectorRun;
  receipt?: PostResult;
  until?: number;
  pending?: Report;
};

type CatalogJob = NonNullable<Awaited<ReturnType<SignedDeviceClient['claimCatalog']>>>;
type CatalogFile = Awaited<ReturnType<typeof readCatalogFile>>;
type CatalogTask = { job: CatalogJob; file?: CatalogFile; uploadDigest?: string; leaseEnded?: boolean };

type ConnectionIssue = 'stopped' | 'heartbeat' | 'authorization' | 'connect' | 'lease' | 'fence';
type ActivityAction = 'pair' | 'connect' | 'disconnect' | 'stop' | 'forget' | 'heartbeat' | 'lease' |
  'claim' | 'creator' | 'verify' | 'media' | 'confirm' | 'report' | 'block' | 'retry' |
  'service' | 'catalogClaim' | 'catalogPortal' | 'catalogFile' | 'catalogUpload' | 'catalogLease';
type ActivityResult = { tone: 'success' | 'neutral' | 'warning' | 'error'; result: string; values: (string | number)[] };
type ActivityContext = {
  app?: ConnectorClaim['task']['target']['app']; kind?: ConnectorClaim['task']['kind'];
  catalogProvider?: CatalogJob['provider']; catalogStore?: string;
};
type Activity = ActivityContext & ActivityResult & { id: number; action: ActivityAction; time: string };

const success = (result: string, ...values: (string | number)[]): ActivityResult => ({ tone: 'success', result, values });
const neutral = (result: string, ...values: (string | number)[]): ActivityResult => ({ tone: 'neutral', result, values });
const warning = (result: string, ...values: (string | number)[]): ActivityResult => ({ tone: 'warning', result, values });
const failure = (result: string, ...values: (string | number)[]): ActivityResult => ({ tone: 'error', result, values });

type Options = {
  origin?: string;
  version: string;
  platform: 'darwin' | 'win32';
  vault: Vault;
  openExternal(url: string): Promise<void>;
  pickMedia(signal: AbortSignal): Promise<Task['media'] | undefined>;
  pickCatalog?(signal: AbortSignal): Promise<CatalogFile | undefined>;
  saveOrigin?(origin: string): void;
  fetcher?: typeof fetch;
  now?: () => number;
};

export class DesktopConnector {
  #pairing?: Pairing;
  #abort = new AbortController();
  #active?: Task;
  #catalog?: CatalogTask;
  #catalogResult?: Awaited<ReturnType<SignedDeviceClient['uploadCatalog']>>;
  #catalogNotice = '';
  #connected = false;
  #online = false;
  #bindings?: DeviceBindings;
  #busy = false;
  #storageIssue = false;
  #message = '';
  #connectionIssue?: ConnectionIssue;
  #activity: Activity[] = [];
  #activityId = 0;
  #now: () => number;

  constructor(private readonly options: Options) {
    this.#now = options.now ?? Date.now;
    try { this.#pairing = options.vault.load(); }
    catch { this.#storageIssue = true; }
  }

  snapshot(language: DesktopLanguage = defaultLanguage) {
    const active = this.#active;
    const task = active?.claim.task;
    const catalog = this.#catalog;
    return {
      origin: this.options.origin, paired: Boolean(this.#pairing), device: this.#pairing?.device, workspace: this.#pairing?.workspace,
      serviceMatches: !this.#pairing || this.#pairing.origin === this.options.origin,
      connected: this.#connected, online: this.#online, busy: this.#busy, storageIssue: this.#storageIssue,
      connectionIssue: this.#connectionIssue, bindings: this.#bindings, activity: this.#activity.map(({ result, values, ...activity }) => ({
        ...activity, result: translate(language, result, ...values),
      })),
      secureStorage: Boolean(this.options.origin) && this.options.vault.available(), message: translate(language, this.#message),
      canSetOrigin: Boolean(this.options.saveOrigin && !this.#pairing && !this.#storageIssue),
      catalogNotice: translate(language, this.#catalogNotice), catalogResult: this.#catalogResult,
      catalog: catalog && {
        id: catalog.job.id, store: catalog.job.store_name, provider: catalog.job.provider,
        externalId: catalog.job.external_store_id, expires: catalog.job.expires_at,
        expired: Boolean(catalog.leaseEnded || this.#now() >= Date.parse(catalog.job.expires_at)),
        canOpenPortal: Boolean(sellerPortal(catalog.job)), uploadUnconfirmed: Boolean(catalog.uploadDigest),
        file: catalog.file && { name: catalog.file.name, size: catalog.file.size },
      },
      task: task && active && {
        id: task.attempt_id, kind: task.kind, app: task.target.app, channel: task.target.channel, binding: task.binding_id,
        profile: task.target.channel === 'browser' ? task.target.profile_id : undefined, identity: task.platform_identity,
        revision: isPublish(task) ? task.payload.revision : undefined, expires: active.claim.lease_expires_at,
        expectedPost: 'platform_post_id' in task.payload ? task.payload.platform_post_id : undefined,
        portal: active.portal, media: active.media.map(media => ({ name: media.name, hash: media.hash })),
        until: active.until, pending: active.pending?.kind,
      },
    };
  }

  #fetch(signal: AbortSignal): typeof fetch {
    return (input, init) => {
      signal.throwIfAborted();
      return (this.options.fetcher ?? fetch)(input, {
        ...init, credentials: 'omit', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
    };
  }

  #client(signal: AbortSignal) {
    const paired = this.#pairing;
    if (!paired || paired.origin !== this.options.origin) throw DesktopError.create('当前服务的设备尚未配对。');
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
    if (this.#busy) throw DesktopError.create('上一项操作仍在进行。');
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
    if (!this.options.saveOrigin || this.#pairing || this.#storageIssue || this.#busy) throw DesktopError.create('当前不能更改服务地址。');
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
      const { origin, platform, vault } = this.options;
      if (!origin || this.#pairing || this.#storageIssue || !vault.available() || row.ownsDevice !== true ||
        typeof row.code !== 'string' || typeof row.name !== 'string') throw DesktopError.create('请确认设备所有权、服务配置及系统安全存储。');
      const workspace = opaqueId(row.workspace, 'workspace_id');
      const name = row.name.trim();
      const { privateKey: key } = generateKeyPairSync('ed25519');
      const device = await pairOverHttp(origin, workspace, row.code, platform, name, key,
        { userInitiated: true, ownsDevice: true }, this.#fetch(signal));
      signal.throwIfAborted();
      try { vault.save({ origin, workspace, device, name, key }); }
      catch { throw DesktopError.create('无法保存配对。请在工作台撤销设备 {0} 后重新配对。', device); }
      this.#pairing = { origin, workspace, device, name, key };
      this.#message = '已配对。请手动连接。';
      return success('配对已保存');
    });
  }

  async connect() {
    await this.#operation('connect', async signal => {
      let bindings;
      try { bindings = await this.#client(signal).heartbeatWithBindings(this.options.version); }
      catch (error) {
        if (!signal.aborted && !this.#connected) this.#connectionIssue = this.#isAuthorizationError(error) ? 'authorization' : 'connect';
        throw error;
      }
      signal.throwIfAborted();
      this.#connected = this.#online = true;
      this.#bindings = bindings;
      this.#connectionIssue = undefined;
      this.#message = '已连接。由你主动领取任务。';
      return success('服务已确认在线');
    });
  }

  #halt(issue?: ConnectionIssue) {
    this.#connectionIssue = issue;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#connected = this.#online = false;
    this.#bindings = undefined;
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
    this.#pairing = this.#active = undefined;
    this.#catalog = this.#catalogResult = undefined;
    this.#catalogNotice = '';
    this.#storageIssue = false;
    this.#message = '已注销本机配对。请在工作台撤销服务端设备。';
    this.#record('forget', success('本机配对已注销'));
  }

  async tick() {
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
      const bindings = await this.#client(signal).heartbeatWithBindings(this.options.version);
      signal.throwIfAborted();
      this.#bindings = bindings;
      this.#online = true;
    } catch (error) {
      if (signal.aborted) return;
      const authorization = this.#isAuthorizationError(error);
      this.#halt(authorization ? 'authorization' : 'heartbeat');
      this.#message = authorization ? '设备授权已失效或服务拒绝请求。请在工作台检查设备。' : '心跳失败，已停止本机操作。';
      this.#record('heartbeat', failure(this.#message), this.#context());
    } finally { this.#busy = false; }
  }

  #isAuthorizationError(error: unknown) {
    return error instanceof PermitError && [401, 403, 404].includes(error.status);
  }

  #requireConnection() {
    if (!this.#connected || !this.#online) throw DesktopError.create('请先连接服务。');
  }

  #catalogExpired(task: CatalogTask) {
    return task.leaseEnded || this.#now() >= Date.parse(task.job.expires_at);
  }

  #liveCatalog() {
    this.#requireConnection();
    if (!this.#catalog || this.#catalogExpired(this.#catalog)) throw DesktopError.create('商品任务租约已结束。请在工作台核对状态后重新领取。');
    return this.#catalog;
  }

  #requireIdle() {
    if (this.#active || (this.#catalog && !this.#catalogExpired(this.#catalog))) throw DesktopError.create('请先处理当前任务。');
  }

  async claimCatalog() {
    await this.#operation('catalogClaim', async signal => {
      this.#requireConnection();
      this.#requireIdle();
      const job = await this.#client(signal).claimCatalog();
      signal.throwIfAborted();
      if (!job) {
        this.#catalogNotice = '此设备暂无可领取的商品任务。';
        return neutral('此设备暂无商品任务');
      }
      if (this.#now() >= Date.parse(job.expires_at)) throw DesktopError.create('商品任务租约已过期，请重新领取。');
      this.#catalog = { job };
      this.#catalogResult = undefined;
      this.#catalogNotice = '';
      return success('商品任务已领取');
    });
  }

  async openCatalogPortal() {
    await this.#operation('catalogPortal', async signal => {
      const { job } = this.#liveCatalog();
      const url = sellerPortal(job);
      if (!url) throw DesktopError.create('任务未提供受支持的官方卖家后台地址。');
      await this.options.openExternal(url);
      signal.throwIfAborted();
      return success('已请求系统浏览器打开官方卖家后台');
    });
  }

  async selectCatalogFile() {
    await this.#operation('catalogFile', async signal => {
      const task = this.#liveCatalog();
      if (!this.options.pickCatalog) throw DesktopError.create('当前无法选择商品导出表。');
      const file = await this.options.pickCatalog(signal);
      signal.throwIfAborted();
      this.#liveCatalog();
      if (!file) return neutral('已取消选择商品表');
      if (task.uploadDigest && task.uploadDigest !== createHash('sha256').update(file.csv).digest('hex')) {
        throw DesktopError.create('上次提交尚未确认，请选回同一份商品表或到工作台核对。');
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
        throw DesktopError.create('请核对官方页面上显示的实际店铺 ID，并确认导出内容后重试。');
      }
      const file = task.file;
      if (!file) throw DesktopError.create('请先选择商品导出表。');
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
        this.#catalogNotice = '';
        return success('商品数据已送工作台预览');
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PermitError && [409, 410].includes(error.status)) {
          task.leaseEnded = true;
          task.file = undefined;
          throw DesktopError.create('服务未接受此任务租约。请在工作台确认是否已收到预览。');
        }
        if (error instanceof PermitError && [400, 413, 422].includes(error.status)) {
          task.uploadDigest = priorDigest;
          throw DesktopError.create('服务拒绝了商品表。请检查格式、大小与商品列后重新选择。');
        }
        throw error;
      }
    });
  }

  async claim() {
    await this.#operation('claim', async signal => {
      this.#requireConnection();
      this.#requireIdle();
      const client = this.#client(signal);
      const input = await client.claim();
      signal.throwIfAborted();
      if (!input) { this.#message = '暂无待领取任务。'; return neutral('暂无待领取任务'); }
      const claim = parseConnectorClaim(input);
      const active: Task = { claim, portal: false, media: [], identity: { kind: 'login_expired' }, observation: 'waiting' };
      this.#active = active;
      const task = claim.task;
      if (task.target.channel === 'mobile' || (isPublish(task) && task.payload.revision.draft)) {
        return { ...await this.#send(active, this.#blocked('unsupported'), signal), app: task.target.app, kind: task.kind };
      }
      this.#message = '已领取。请在专用浏览器配置中核对账号。';
      return success('任务已领取');
    });
  }

  #live() {
    this.#requireConnection();
    const active = this.#active;
    if (!active || active.pending || this.#now() >= Date.parse(active.claim.lease_expires_at)) throw DesktopError.create('当前没有可操作的任务。');
    return active;
  }

  async openCreator() {
    await this.#operation('creator', async signal => {
      const active = this.#live();
      const target = active.claim.task.target;
      if (target.channel !== 'browser') throw DesktopError.create('当前设备仅支持桌面浏览器交付。');
      await this.options.openExternal(creators[target.app]);
      signal.throwIfAborted();
      active.portal = true;
      return success('打开页面的请求已交给系统浏览器');
    });
  }

  async openSessionCreator(app: unknown) {
    if (app !== 'douyin' && app !== 'xhs') throw DesktopError.create('平台无效。');
    await this.#operation('creator', async signal => {
      this.#requireConnection();
      this.#requireIdle();
      await this.options.openExternal(creators[app]);
      signal.throwIfAborted();
      return success('打开页面的请求已交给系统浏览器');
    }, { app });
  }

  async verifySession(input: unknown) {
    await this.#operation('verify', async signal => {
      this.#requireConnection();
      this.#requireIdle();
      const row = fields(input, ['session', 'observed', 'confirmed']);
      if (row.confirmed !== true) throw DesktopError.create('请确认已在专用浏览器配置核对实际账号。');
      const status = await this.#client(signal).reportIdentity('browser', opaqueId(row.session, 'session'), opaqueId(row.observed, 'observed'));
      signal.throwIfAborted();
      this.#message = status === 'verified' ? '工作台已核验浏览器账号。' : '账号核验未通过。请在工作台检查绑定。';
      return status === 'verified' ? success('工作台已核验账号') : warning('账号核验未通过');
    });
  }

  async selectMedia() {
    await this.#operation('media', async signal => {
      const active = this.#live();
      if (!isPublish(active.claim.task) || active.until) throw DesktopError.create('当前任务不能选取媒体。');
      const picked = await this.options.pickMedia(signal);
      signal.throwIfAborted();
      if (this.#live() !== active) throw DesktopError.create('任务已结束。');
      if (!picked) return neutral('已取消选择');
      active.media = picked;
      return success('已读取 {0} 个本机文件的 SHA-256', picked.length);
    });
  }

  async confirm(input: unknown) {
    await this.#operation('confirm', async signal => {
      const active = this.#live();
      const task = active.claim.task;
      if (!active.portal || active.until || task.target.channel !== 'browser') throw DesktopError.create('请先打开官方页面。');
      const row = fields(input, ['observed', 'confirmed']);
      const observed = opaqueId(row.observed, 'observed');
      if (row.confirmed !== true) throw DesktopError.create('请确认账号所有权、专用浏览器配置及任务内容。');
      if (observed !== task.platform_identity) {
        return this.#send(active, this.#blocked('identity_mismatch'), signal);
      }
      const client = this.#client(signal);
      if (!isPublish(task)) await client.ready(active.claim, observed);
      signal.throwIfAborted();
      active.identity = { kind: 'signed_in', platform_identity: observed };
      active.run = new ConnectorRun(active.claim, this.#driver(active, signal), client, this.#now, handoffWindow,
        async (claim, identity) => {
          await client.ready(claim, identity);
          signal.throwIfAborted();
        });
      active.run.applyHeartbeat('assist');
      if (task.kind === 'post.capture_result' || task.kind === 'post.verify_visible') {
        active.until = Date.parse(active.claim.lease_expires_at);
        this.#message = '请在官方页面核实原作品。';
        return success('已核对账号，等待人工核实原作品');
      }
      return this.#advance(active, signal);
    });
  }

  #driver(active: Task, signal: AbortSignal): LocalDriver {
    const task = active.claim.task;
    if (task.target.channel !== 'browser') throw DesktopError.create('浏览器任务配置无效。');
    const state: LocalState = {
      host: this.options.platform, phase: 'P0b', phones: [],
      pairing: { device_id: this.#pairing!.device, workspace_id: this.#pairing!.workspace, owned: true, revoked: false },
      bindings: [{ id: task.binding_id, workspace_id: task.workspace_id, account_id: task.account_id, connector_device_id: task.connector_device_id,
        platform_identity: task.platform_identity, owned: true, verified: true, consent_confirmed: true, dedicated: true, ...task.target }],
    };
    return {
      state: () => state,
      identity: () => active.identity,
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
      submitAuto: () => { throw DesktopError.create('桌面端仅支持人工交付。'); },
      capture: () => active.receipt,
      // Visibility uses the fixed signed report after explicit confirmation in finish().
      verify: () => { throw DesktopError.create('需要人工确认作品可见性。'); },
      pushMedia: () => false,
      cleanup: () => false,
    };
  }

  async finish(input: unknown) {
    await this.#operation('report', async signal => {
      const active = this.#live();
      const task = active.claim.task;
      const row = fields(input, ['result'], ['receipt']);
      if (!active.run || !active.until || task.target.channel !== 'browser') throw DesktopError.create('请先确认实际登录的账号。');
      if (row.result === 'unknown' || this.#now() >= active.until) {
        return this.#send(active, { kind: 'outcome_unknown' }, signal);
      } else if (task.kind === 'post.verify_visible' && (row.result === 'visible' || row.result === 'not_visible')) {
        return this.#send(active, { kind: 'visibility_checked', visible: row.result === 'visible' }, signal);
      } else if ((isPublish(task) && row.result === 'submitted') || (task.kind === 'post.capture_result' && row.result === 'captured')) {
        const expected = task.kind === 'post.capture_result' ? task.payload.platform_post_id : undefined;
        if (row.receipt !== undefined) active.receipt = parseReceipt(row.receipt, task.target.app, expected);
        if (task.kind === 'post.capture_result' && !active.receipt) throw DesktopError.create('请提供预登记的脱敏证据。');
        const prior = active.run.report();
        if (prior?.kind === 'accepted' || prior?.kind === 'result_captured') {
          if (!active.receipt) throw DesktopError.create('请提供更正后的证据，或选择结果未知。');
          return this.#send(active, { ...prior, ...active.receipt }, signal);
        }
        active.observation = 'submitted';
        return this.#advance(active, signal);
      } else {
        throw DesktopError.create('无效的任务结果。');
      }
    });
  }

  async block(input: unknown) {
    await this.#operation('block', async signal => {
      const active = this.#live();
      const row = fields(input, ['reason']);
      const reason = challengeReasons.find(item => item === row.reason);
      if (!reason) throw DesktopError.create('无效的中止原因。');
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
    if (this.#now() >= Date.parse(active.claim.lease_expires_at)) throw DesktopError.create('任务租约已过期。请在工作台核实。');
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
            captcha: '中止报告已送达：验证码', risk_control: '中止报告已送达：风控提示',
            app_prompt: '中止报告已送达：平台弹窗', login_expired: '中止报告已送达：登录失效',
            identity_mismatch: '中止报告已送达：账号不匹配', media_unverified: '中止报告已送达：媒体校验未通过',
            unsupported: '中止报告已送达：当前版本不支持此任务',
          };
          const reason = reasons[report.reason];
          return warning(reason ?? '中止报告已送达');
        }
        case 'result_captured': return success('作品证据已回填');
        case 'visibility_checked': return report.visible ? success('已回填观察结果：作品可见') : warning('已回填观察结果：作品不可见');
        default: return success('任务报告已送达');
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof PermitError && error.status === 422 && (report.kind === 'accepted' || report.kind === 'result_captured')) {
        active.pending = undefined;
        throw DesktopError.create('服务拒绝了证据。请核对预登记记录后重新回填，或标记结果未知。');
      }
      if (error instanceof PermitError && error.status === 409) {
        this.#record('report', failure('服务拒绝任务令牌，结果需核实'), this.#context());
        this.#halt('fence');
        this.#active = undefined;
        throw DesktopError.create('服务未接受该任务令牌。请在工作台核实任务和结果。');
      }
      throw DesktopError.create('回填未获确认。可重试同一条报告，请勿重复提交作品。');
    }
  }

  async retryReport() {
    await this.#operation('retry', async signal => {
      if (!this.#active?.pending) throw DesktopError.create('没有待重试的报告。');
      return this.#flush(this.#active, signal);
    });
  }
}
