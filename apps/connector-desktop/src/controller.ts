import { generateKeyPairSync } from 'node:crypto';
import { fields, opaqueId, parseConnectorClaim, type ConnectorClaim } from '../../../packages/connector-tasks/src/tasks.ts';
import { createSignedHttpTransport, pairOverHttp, SignedDeviceClient } from '../../connector/src/device-client.ts';
import { PermitError } from '../../connector/src/permit.ts';
import { ConnectorRun, type AssistObservation, type IdentityObservation, type LocalDriver, type PostResult, type Report, type TerminalResult } from '../../connector/src/workflow.ts';
import type { LocalState } from '../../connector/src/preflight.ts';
import { challengeReasons, creators, isPublish, parseReceipt } from './policy.ts';
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

type Options = {
  origin?: string;
  version: string;
  platform: 'darwin' | 'win32';
  vault: Vault;
  openExternal(url: string): Promise<void>;
  pickMedia(signal: AbortSignal): Promise<Task['media'] | undefined>;
  fetcher?: typeof fetch;
  now?: () => number;
};

export class DesktopConnector {
  #pairing?: Pairing;
  #abort = new AbortController();
  #active?: Task;
  #connected = false;
  #online = false;
  #busy = false;
  #storageIssue = false;
  #message = '';
  #now: () => number;

  constructor(private readonly options: Options) {
    this.#now = options.now ?? Date.now;
    try { this.#pairing = options.vault.load(); }
    catch { this.#storageIssue = true; }
  }

  snapshot() {
    const active = this.#active;
    const task = active?.claim.task;
    return {
      origin: this.options.origin, paired: Boolean(this.#pairing), device: this.#pairing?.device, workspace: this.#pairing?.workspace,
      serviceMatches: !this.#pairing || this.#pairing.origin === this.options.origin,
      connected: this.#connected, online: this.#online, busy: this.#busy, storageIssue: this.#storageIssue,
      secureStorage: this.options.vault.available(), message: this.#message,
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
    if (!paired || paired.origin !== this.options.origin) throw new Error('当前服务的设备尚未配对。');
    return new SignedDeviceClient(paired.workspace, paired.device, paired.key, createSignedHttpTransport(paired.origin, this.#fetch(signal)), this.#now);
  }

  async #operation(fn: (signal: AbortSignal) => Promise<void>) {
    if (this.#busy) throw new Error('上一项操作仍在进行。');
    this.#busy = true;
    const signal = this.#abort.signal;
    try { await fn(signal); }
    finally { this.#busy = false; }
  }

  async pair(input: unknown) {
    await this.#operation(async signal => {
      const row = fields(input, ['workspace', 'code', 'name', 'ownsDevice']);
      const { origin, platform, vault } = this.options;
      if (!origin || this.#pairing || this.#storageIssue || !vault.available() || row.ownsDevice !== true ||
        typeof row.code !== 'string' || typeof row.name !== 'string') throw new Error('请确认设备所有权、服务配置及系统安全存储。');
      const workspace = opaqueId(row.workspace, 'workspace_id');
      const name = row.name.trim();
      const { privateKey: key } = generateKeyPairSync('ed25519');
      const device = await pairOverHttp(origin, workspace, row.code, platform, name, key,
        { userInitiated: true, ownsDevice: true }, this.#fetch(signal));
      signal.throwIfAborted();
      try { vault.save({ origin, workspace, device, name, key }); }
      catch { throw new Error(`无法保存配对。请在工作台撤销设备 ${device} 后重新配对。`); }
      this.#pairing = { origin, workspace, device, name, key };
      this.#message = '已配对。请手动连接。';
    });
  }

  async connect() {
    await this.#operation(async signal => {
      await this.#client(signal).heartbeat(this.options.version);
      signal.throwIfAborted();
      this.#connected = this.#online = true;
      this.#message = '已连接。由你主动领取任务。';
    });
  }

  stop() {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#connected = this.#online = false;
    const active = this.#active;
    if (active && !active.pending) {
      active.pending = this.#report(active, active.until ? { kind: 'outcome_unknown' } : this.#blocked('assist_closed'));
    }
    if (active) {
      active.media = [];
      active.run = undefined;
      active.receipt = undefined;
    }
    this.#message = '已停止本机操作。请停止操作已打开的官方页面。';
  }

  disconnect() {
    this.stop();
    this.#message = '已断开。配对仍保留，可手动重新连接。';
  }

  forget() {
    this.stop();
    this.options.vault.clear();
    this.#pairing = this.#active = undefined;
    this.#storageIssue = false;
    this.#message = '已注销本机配对。请在工作台撤销服务端设备。';
  }

  async tick() {
    const active = this.#active;
    if (active && this.#now() >= Date.parse(active.claim.lease_expires_at)) {
      this.stop();
      this.#active = undefined;
      this.#message = '任务租约已过期。请到工作台核实结果。';
    }
    if (!this.#connected || this.#busy) return;
    await this.#operation(async signal => {
      try {
        await this.#client(signal).heartbeat(this.options.version);
        signal.throwIfAborted();
        this.#online = true;
      } catch (error) {
        if (signal.aborted) return;
        this.stop();
        this.#message = error instanceof PermitError && [401, 403, 404].includes(error.status)
          ? '设备授权已失效或服务拒绝请求。请在工作台检查设备。' : '心跳失败，已停止本机操作。';
      }
    });
  }

  #requireConnection() {
    if (!this.#connected || !this.#online) throw new Error('请先连接服务。');
  }

  async claim() {
    await this.#operation(async signal => {
      this.#requireConnection();
      if (this.#active) throw new Error('请先处理当前任务。');
      const client = this.#client(signal);
      const input = await client.claim();
      signal.throwIfAborted();
      if (!input) { this.#message = '暂无待领取任务。'; return; }
      const claim = parseConnectorClaim(input);
      const active: Task = { claim, portal: false, media: [], identity: { kind: 'login_expired' }, observation: 'waiting' };
      this.#active = active;
      const task = claim.task;
      if (task.target.channel === 'mobile' || (isPublish(task) && task.payload.revision.draft)) {
        await this.#send(active, this.#blocked('unsupported'), signal);
        return;
      }
      this.#message = '已领取。请在专用浏览器配置中核对账号。';
    });
  }

  #live() {
    this.#requireConnection();
    const active = this.#active;
    if (!active || active.pending || this.#now() >= Date.parse(active.claim.lease_expires_at)) throw new Error('当前没有可操作的任务。');
    return active;
  }

  async openCreator() {
    await this.#operation(async signal => {
      const active = this.#live();
      const target = active.claim.task.target;
      if (target.channel !== 'browser') throw new Error('当前设备仅支持桌面浏览器交付。');
      await this.options.openExternal(creators[target.app]);
      signal.throwIfAborted();
      active.portal = true;
    });
  }

  async verifySession(input: unknown) {
    await this.#operation(async signal => {
      this.#requireConnection();
      if (this.#active) throw new Error('请先处理当前任务。');
      const row = fields(input, ['session', 'observed', 'confirmed']);
      if (row.confirmed !== true) throw new Error('请确认已在专用浏览器配置核对实际账号。');
      const status = await this.#client(signal).reportIdentity('browser', opaqueId(row.session, 'session'), opaqueId(row.observed, 'observed'));
      signal.throwIfAborted();
      this.#message = status === 'verified' ? '工作台已核验浏览器账号。' : '账号核验未通过。请在工作台检查绑定。';
    });
  }

  async selectMedia() {
    await this.#operation(async signal => {
      const active = this.#live();
      if (!isPublish(active.claim.task) || active.until) throw new Error('当前任务不能选取媒体。');
      const picked = await this.options.pickMedia(signal);
      signal.throwIfAborted();
      if (this.#live() !== active) throw new Error('任务已结束。');
      if (picked) active.media = picked;
    });
  }

  async confirm(input: unknown) {
    await this.#operation(async signal => {
      const active = this.#live();
      const task = active.claim.task;
      if (!active.portal || active.until || task.target.channel !== 'browser') throw new Error('请先打开官方页面。');
      const row = fields(input, ['observed', 'confirmed']);
      const observed = opaqueId(row.observed, 'observed');
      if (row.confirmed !== true) throw new Error('请确认账号所有权、专用浏览器配置及任务内容。');
      if (observed !== task.platform_identity) {
        await this.#send(active, this.#blocked('identity_mismatch'), signal);
        return;
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
      } else {
        await this.#advance(active, signal);
      }
    });
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
      submitAuto: () => { throw new Error('桌面端仅支持人工交付。'); },
      capture: () => active.receipt,
      // Visibility uses the fixed signed report after explicit confirmation in finish().
      verify: () => { throw new Error('需要人工确认作品可见性。'); },
      pushMedia: () => false,
      cleanup: () => false,
    };
  }

  async finish(input: unknown) {
    await this.#operation(async signal => {
      const active = this.#live();
      const task = active.claim.task;
      const row = fields(input, ['result'], ['receipt']);
      if (!active.run || !active.until || task.target.channel !== 'browser') throw new Error('请先确认实际登录的账号。');
      if (row.result === 'unknown' || this.#now() >= active.until) {
        await this.#send(active, { kind: 'outcome_unknown' }, signal);
      } else if (task.kind === 'post.verify_visible' && (row.result === 'visible' || row.result === 'not_visible')) {
        await this.#send(active, { kind: 'visibility_checked', visible: row.result === 'visible' }, signal);
      } else if ((isPublish(task) && row.result === 'submitted') || (task.kind === 'post.capture_result' && row.result === 'captured')) {
        const expected = task.kind === 'post.capture_result' ? task.payload.platform_post_id : undefined;
        if (row.receipt !== undefined) active.receipt = parseReceipt(row.receipt, task.target.app, expected);
        if (task.kind === 'post.capture_result' && !active.receipt) throw new Error('请提供预登记的脱敏证据。');
        const prior = active.run.report();
        if (prior?.kind === 'accepted' || prior?.kind === 'result_captured') {
          if (!active.receipt) throw new Error('请提供更正后的证据，或选择结果未知。');
          await this.#send(active, { ...prior, ...active.receipt }, signal);
        } else {
          active.observation = 'submitted';
          await this.#advance(active, signal);
        }
      } else {
        throw new Error('无效的任务结果。');
      }
    });
  }

  async block(input: unknown) {
    await this.#operation(async signal => {
      const active = this.#live();
      const row = fields(input, ['reason']);
      const reason = challengeReasons.find(item => item === row.reason);
      if (!reason) throw new Error('无效的中止原因。');
      await this.#send(active, active.until ? { kind: 'outcome_unknown' } : this.#blocked(reason), signal);
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
    } else if (result.kind !== 'awaiting_submit_permit') {
      await this.#send(active, result, signal);
    }
  }

  #report(active: Task, result: TerminalResult): Report {
    return { ...result, attempt_id: active.claim.task.attempt_id, fencing_token: active.claim.fencing_token };
  }

  async #send(active: Task, result: TerminalResult, signal: AbortSignal) {
    active.pending = this.#report(active, result);
    await this.#flush(active, signal);
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
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof PermitError && error.status === 422 && (report.kind === 'accepted' || report.kind === 'result_captured')) {
        active.pending = undefined;
        throw new Error('服务拒绝了证据。请核对预登记记录后重新回填，或标记结果未知。');
      }
      if (error instanceof PermitError && error.status === 409) {
        this.stop();
        this.#active = undefined;
        throw new Error('服务未接受该任务令牌。请在工作台核实任务和结果。');
      }
      throw new Error('回填未获确认。可重试同一条报告，请勿重复提交作品。');
    }
  }

  async retryReport() {
    await this.#operation(async signal => {
      if (!this.#active?.pending) throw new Error('没有待重试的报告。');
      await this.#flush(this.#active, signal);
    });
  }
}
