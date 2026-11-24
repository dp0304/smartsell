// Worker resident mode (§8.2, §8.16, §8.17): pairing with a name, automatic
// connection whenever the vault holds a pairing, the S6 runtime started
// through createWorkerRuntime(), and the C11 events turned into OS
// notifications, the idle-sleep blocker, the update prompt and UI state.
// Nothing here imports Electron; the shell passes the platform pieces in.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOMATION_NOTICE, AUTOMATION_NOTICE_VERSION, RISK_TERMS_VERSION, type DevicePosture, type RemoteAccess } from '@smartsell/contracts';
import { pairOverHttp } from '../../../connector/src/device-client.ts';
import { PermitError } from '../../../connector/src/permit.ts';
import { enrollChannel, registerEnrolledChannel, type EnrolledChannel } from '../runtime/enroll.ts';
import { RuntimeEventBus, type ConnectionEvent, type LocalJobView } from '../runtime/events.ts';
import { createWorkerRuntime, type WorkerRuntime, type WorkerRuntimeOptions } from '../runtime/worker.ts';
import type { AppSettings } from '../service-settings.ts';
import { VaultLockedError, type Pairing, type Vault } from '../vault.ts';
import { parseWorkbenchAddress, requestWorkbenchGrant } from '../worker-pairing.ts';
import { COPY, type Notifier } from './notify.ts';
import { postureAdvice } from './posture.ts';
import type { PowerGuard } from './power.ts';
import type { UpdateManager } from './update.ts';

/** createPairingRequest's rule: 1–100 characters, no surrounding spaces, no control characters. */
export function sanitizeMachineName(input: unknown, fallback: string) {
  const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100).trim();
  const name = typeof input === 'string' ? clean(input) : '';
  return name || clean(fallback).replace(/\.local$/i, '') || 'SmartSell Worker';
}

export interface EnrollmentView {
  provider: 'x' | 'tiktok'; status: 'waiting_login' | 'detected' | 'registering' | 'registered' | 'failed';
  identity: string | null; handle: string | null; label: string | null; notice: string; error: string | null; note: string | null;
}

export interface WorkerShellDeps {
  userData: string;
  platform: 'darwin' | 'win32';
  version: string;
  hostname: string;
  vault: Vault;
  notifier: Pick<Notifier, 'notify' | 'reset'>;
  power: Pick<PowerGuard, 'onJobsHeld' | 'hold' | 'release'>;
  posture: { current(): DevicePosture | null; remote(): RemoteAccess | null; start(): void; stop(): void };
  autostart: { set(enabled: boolean): boolean; enabled(): boolean };
  settings: { load(): AppSettings; save(patch: Partial<AppSettings>): AppSettings };
  openExternal(url: string): Promise<void>;
  bundledClip: string | null;
  /** Builds the update prompt for this pairing (signed downloads need the device key). */
  updates(pairing: Pairing, runtime: WorkerRuntime): UpdateManager;
  onChange(): void;
  log(message: string, detail?: object): void;
  /** Test seams. */
  createRuntime?(options: WorkerRuntimeOptions): WorkerRuntime;
  pair?: typeof pairOverHttp;
  grant?: typeof requestWorkbenchGrant;
  enroll?: typeof enrollChannel;
  register?: typeof registerEnrolledChannel;
  vaultRetryMs?: number;
}

export type WorkerPhase = 'unpaired' | 'pairing' | 'vault_locked' | 'running' | 'device_revoked';

const PROFILE_KEY = /^[a-z0-9-]{8,64}$/;

export class WorkerShell {
  readonly #d: WorkerShellDeps;
  readonly events = new RuntimeEventBus();
  #phase: WorkerPhase = 'unpaired';
  #pairing?: Pairing;
  #runtime?: WorkerRuntime;
  #updates?: UpdateManager;
  #connection: ConnectionEvent | null = null;
  #jobs: LocalJobView[] = [];
  #message: string | null = null;
  #pairAbort?: AbortController;
  #enrollAbort?: AbortController;
  #enrollment: EnrollmentView | null = null;
  #enrolled?: EnrolledChannel;
  #vaultTimer?: ReturnType<typeof setTimeout>;

  constructor(deps: WorkerShellDeps) {
    this.#d = deps;
    const events = this.events;
    events.on('jobs_held', event => deps.power.onJobsHeld(event));
    events.on('local_alert', alert => {
      // WA-8: an alert about a job waiting on this machine (the owner's Post click, a challenge) opens that job's Chrome.
      const jobId = alert.kind !== 'missed' ? alert.job_id : undefined;
      const action = jobId ? () => { this.openJobChrome(jobId).catch(error => deps.log('open job chrome failed', { error: String(error) })); } : undefined;
      deps.notifier.notify({ title: alert.title, body: alert.body, url: alert.web_url, urgent: alert.kind !== 'owner_click', ...(action && { action }) });
    });
    events.on('hub_unreachable', event => {
      deps.notifier.notify({ title: COPY.hubUnreachableTitle, body: COPY.hubUnreachable(this.machineName, event.jobs_due_2h), urgent: true, key: `hub_unreachable:${event.since}` });
    });
    events.on('vault_locked', () => {
      this.#phase = 'vault_locked';
      deps.notifier.notify({ title: COPY.vaultLockedTitle, body: COPY.vaultLocked(this.machineName, deps.platform), urgent: true, key: 'vault_locked' });
      deps.onChange();
    });
    events.on('update_available', event => { this.#updates?.offer(event); deps.onChange(); });
    events.on('connection', event => {
      this.#connection = event;
      if (event.state === 'device_revoked') {
        this.#phase = 'device_revoked';
        deps.notifier.notify({ title: COPY.deviceRevokedTitle, body: COPY.deviceRevoked(this.machineName, event.message), urgent: true, key: 'device_revoked' });
      }
      deps.onChange();
    });
    events.on('jobs_changed', event => { this.#jobs = event.jobs; deps.onChange(); });
  }

  get phase() { return this.#phase; }
  get runtime() { return this.#runtime; }
  get pairing() { return this.#pairing; }
  get updates() { return this.#updates; }
  get machineName() { return this.#pairing?.name ?? sanitizeMachineName(undefined, this.#d.hostname); }

  /** Loads the pairing; connects automatically when there is one (the 「請手動連線」 step is gone, §8.2). */
  start() {
    clearTimeout(this.#vaultTimer);
    let pairing: Pairing | undefined;
    try { pairing = this.#d.vault.load(); }
    catch (error) {
      this.#d.log('vault could not be read', { error: String(error), locked: error instanceof VaultLockedError });
      this.events.emit('vault_locked');
      // The keychain may be unlocked later (the owner answers the prompt): try again.
      this.#vaultTimer = setTimeout(() => this.retryVault(), this.#d.vaultRetryMs ?? 60_000);
      this.#vaultTimer.unref?.();
      return;
    }
    if (!pairing) { this.#phase = 'unpaired'; this.#d.onChange(); return; }
    this.#startRuntime(pairing);
  }

  retryVault() {
    if (this.#phase !== 'vault_locked') return;
    this.#d.notifier.reset('vault_locked');
    this.start();
  }

  #startRuntime(pairing: Pairing) {
    this.#pairing = pairing;
    const create = this.#d.createRuntime ?? createWorkerRuntime;
    const runtime = create({
      dataDir: this.#d.userData,
      identity: { origin: pairing.origin, workspaceId: pairing.workspace, deviceId: pairing.device, privateKey: pairing.key, machineName: pairing.name },
      clientVersion: this.#d.version, bundledClip: this.#d.bundledClip, events: this.events,
      posture: () => this.#d.posture.current(), remoteAccess: () => this.#d.posture.remote(), log: this.#d.log,
    });
    this.#runtime = runtime;
    this.#updates = this.#d.updates(pairing, runtime);
    this.#phase = 'running';
    this.#d.posture.start();
    runtime.start();
    this.#d.onChange();
  }

  /**
   * Pairing (§2.9 step 3): the owner pastes the hub address and names the machine; the hub page opens in the
   * browser, the owner approves, and the code comes straight back to this App. A code may also be typed
   * (headless/E2E parity). The first successful pairing turns on the login item.
   */
  async pair(input: { hub: unknown; name: unknown; workspace?: unknown; code?: unknown; owns: unknown }) {
    if (this.#phase === 'running' || this.#phase === 'pairing') throw new Error('這台機器已經配對；要重新配對請先在「進階」登出本機配對。');
    if (input.owns !== true) throw new Error('請確認這台機器是你的，或你有權管理它。');
    const address = parseWorkbenchAddress(input.hub);
    const name = sanitizeMachineName(input.name, this.#d.hostname);
    const abort = new AbortController();
    this.#pairAbort = abort;
    this.#phase = 'pairing';
    this.#message = '請在剛開啟的瀏覽器登入中樞，按「核准」。';
    this.#d.onChange();
    try {
      let workspace = typeof input.workspace === 'string' && input.workspace ? input.workspace : address.workspace;
      let code = typeof input.code === 'string' && input.code ? input.code.trim() : address.code;
      if (!workspace || !code) ({ workspace, code } = await (this.#d.grant ?? requestWorkbenchGrant)(address, name, this.#d.openExternal, abort.signal));
      const { privateKey: key } = generateKeyPairSync('ed25519');
      let device: string;
      try {
        device = await (this.#d.pair ?? pairOverHttp)(address.origin, workspace, code, this.#d.platform, name, key, { userInitiated: true, ownsDevice: true });
      } catch (error) {
        if (error instanceof PermitError || (error as Error | undefined)?.name === 'PermitError') throw new Error('中樞拒絕了配對（配對碼可能已過期）。請重新按「配對」。');
        throw new Error('連不上中樞。請確認這台機器已加入同一個 tailnet，再重試。');
      }
      const pairing: Pairing = { origin: address.origin, workspace, device, name, key };
      try { this.#d.vault.save(pairing); }
      catch { throw new Error(`無法保存配對。請在中樞撤銷機器 ${name}，確認系統安全儲存可用後重新配對。`); }
      const settings = this.#d.settings.save({ role: 'worker' });
      // §8.2: after the first successful pairing; the setting can be switched off later.
      if (settings.autostart !== false) { this.#d.autostart.set(true); this.#d.settings.save({ autostart: true }); }
      this.#message = `已配對為「${name}」。`;
      this.#startRuntime(pairing);
      return { device_id: device, name };
    } catch (error) {
      this.#phase = 'unpaired';
      this.#message = error instanceof Error ? error.message : String(error);
      this.#d.onChange();
      throw error;
    } finally { this.#pairAbort = undefined; }
  }

  cancelPairing() { this.#pairAbort?.abort(); }

  setAutostart(enabled: boolean) {
    const applied = this.#d.autostart.set(enabled);
    this.#d.settings.save({ autostart: enabled });
    this.#d.onChange();
    return applied;
  }

  // ---------- 新增帳號 (§8.16) ----------

  /** Opens a new Chrome profile on the platform; the owner signs in there (captcha and 2FA are the owner's). */
  addAccount(provider: unknown) {
    const runtime = this.#requireRuntime();
    if (provider !== 'x' && provider !== 'tiktok') throw new Error('第 1 階段只能新增 X 或 TikTok。');
    this.#enrollAbort?.abort();
    const abort = new AbortController();
    this.#enrollAbort = abort;
    this.#enrolled = undefined;
    this.#enrollment = { provider, status: 'waiting_login', identity: null, handle: null, label: null, notice: AUTOMATION_NOTICE.zh_hant, error: null, note: null };
    this.#d.onChange();
    void (this.#d.enroll ?? enrollChannel)({ profiles: runtime.profiles, drivers: runtime.drivers, selectors: runtime.selectors, platformUrl: runtime.platformUrl },
      provider, { signal: abort.signal, keepOpen: true })
      .then(channel => {
        if (abort.signal.aborted || !this.#enrollment) return;
        this.#enrolled = channel;
        const shown = channel.handle ? `@${channel.handle}` : channel.identity;
        this.#enrollment = { ...this.#enrollment, status: 'detected', identity: channel.identity, handle: channel.handle,
          label: `${provider === 'x' ? 'X' : 'TikTok'} ${shown}` };
        this.#d.onChange();
      })
      .catch(error => {
        if (abort.signal.aborted || !this.#enrollment) return;
        this.#enrollment = { ...this.#enrollment, status: 'failed', error: error instanceof Error && /[㐀-鿿]/.test(error.message) ? error.message : '沒有偵測到登入的帳號，請重試。' };
        this.#d.onChange();
      });
    return this.#enrollment;
  }

  /** 「加入」: only now channels.register is called, with the automation notice version the owner just saw. */
  async confirmAccount() {
    const runtime = this.#requireRuntime();
    const channel = this.#enrolled;
    if (!channel || this.#enrollment?.status !== 'detected') throw new Error('還沒有偵測到要加入的帳號。');
    this.#enrollment = { ...this.#enrollment, status: 'registering' };
    this.#d.onChange();
    try {
      const result = await (this.#d.register ?? registerEnrolledChannel)(runtime.hub, channel);
      const hubKey = registeredProfileKey(result);
      let note: string | null = null;
      if (hubKey && hubKey !== channel.profileKey) note = await adoptProfileKey(runtime.profiles, channel.profileKey, hubKey, this.#d.log);
      this.#enrollment = { ...this.#enrollment, status: 'registered', note: note ?? `已加入。代按發布需要在網頁的帳號頁確認風險（條款版本 ${RISK_TERMS_VERSION}）；在那之前，到點時會請你在這台機器按「發布」。` };
      this.#enrolled = undefined;
      this.#d.onChange();
      return { profile_key: hubKey ?? channel.profileKey };
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number((error as { status: unknown }).status) : null;
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : null;
      const message = code === 'AUTOMATION_NOTICE_OUTDATED' ? '中樞的自動化告知已更新，請更新 SmartSell Worker 後再加入。'
        : status === 409 ? '這個帳號已綁定到別台機器。請先在網頁的帳號頁把它改綁到這台機器。'
          : '中樞沒有確認這次登記，請檢查網路後重試。';
      this.#enrollment = { ...this.#enrollment!, status: 'detected', error: message };
      this.#d.onChange();
      throw new Error(message);
    }
  }

  cancelAccount() {
    this.#enrollAbort?.abort();
    this.#enrollAbort = undefined;
    this.#enrollment = null;
    this.#enrolled = undefined;
    this.#d.onChange();
  }

  // ---------- 帳號與任務的按鈕 ----------

  #channel(socialAccountId: unknown) {
    const runtime = this.#requireRuntime();
    const channel = runtime.snapshot().channels.find(item => item.social_account_id === socialAccountId);
    if (!channel) throw new Error('找不到這個帳號；它可能已改綁到別台機器。');
    return { runtime, channel };
  }

  /** 「開啟 Chrome」: brings this account's Chrome to the front and keeps it open for the owner. */
  async openChrome(socialAccountId: unknown, path?: string) {
    const { runtime, channel } = this.#channel(socialAccountId);
    // Without a page to open, an already open window only needs to come to the front (even while a job uses it).
    if (!path && await runtime.profiles.bringToFront(channel.profile_key)) return;
    const lease = await acquireForOwner(runtime, channel.profile_key);
    try {
      if (path && (channel.provider === 'x' || channel.provider === 'tiktok')) await lease.page.goto(runtime.platformUrl(channel.provider, path));
      await lease.page.bringToFront();
      lease.pin(true);
    } finally { lease.release(); }
  }

  /** 「重新登入」: opens the platform's identity page in this account's profile for the owner to sign in. */
  async reLogin(socialAccountId: unknown) {
    const { runtime, channel } = this.#channel(socialAccountId);
    const driver = channel.provider === 'x' || channel.provider === 'tiktok' ? runtime.drivers.get(channel.provider) : undefined;
    await this.openChrome(socialAccountId, driver?.enrollPath ?? '/');
  }

  /** 「檢查登入」: read-only identity probe in the account's own profile (no posting, no clicks). */
  async checkLogin(socialAccountId: unknown): Promise<{ state: 'verified' | 'identity_mismatch' | 'login_required'; identity: string | null }> {
    const { runtime, channel } = this.#channel(socialAccountId);
    if (channel.provider !== 'x' && channel.provider !== 'tiktok') throw new Error('這個平台在第 1 階段沒有驅動。');
    try {
      const seen = await (this.#d.enroll ?? enrollChannel)({ profiles: runtime.profiles, drivers: runtime.drivers, selectors: runtime.selectors, platformUrl: runtime.platformUrl },
        channel.provider, { profileKey: channel.profile_key, timeoutMs: 20_000, keepOpen: true });
      const same = seen.identity.toLowerCase() === channel.expected_identity.toLowerCase();
      return { state: same ? 'verified' : 'identity_mismatch', identity: seen.identity };
    } catch { return { state: 'login_required', identity: null }; }
  }

  /**
   * 「開啟該 Chrome 處理」 for a needs_owner job. While the runner observes that tab read-only (captcha, sign-in, the
   * owner's Post click) it holds the profile, so the open tab is brought to the front without waiting for the lock.
   */
  async openJobChrome(jobId: unknown) {
    const runtime = this.#requireRuntime();
    const job = typeof jobId === 'string' ? runtime.runner.views().find(item => item.job_id === jobId) : undefined;
    if (!job) throw new Error('找不到這個任務。');
    if (await runtime.profiles.bringToFront(job.profile_key)) return;
    const lease = await acquireForOwner(runtime, job.profile_key);
    try { await lease.page.bringToFront(); lease.pin(true); } finally { lease.release(); }
  }

  emergencyStop() { this.#requireRuntime().emergencyStop(); this.#d.onChange(); }
  resume() { this.#requireRuntime().resume(); this.#d.onChange(); }

  /** 「登出本機配對」: stops the runtime and deletes the local key; the hub still lists the machine until revoked on the web. */
  async forget() {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#updates = undefined;
    await runtime?.stop().catch(() => {});
    this.#d.power.release();
    this.#d.posture.stop();
    this.#d.vault.clear();
    this.#pairing = undefined;
    this.#phase = 'unpaired';
    this.#message = '已登出本機配對。請在網頁的機器頁撤銷這台機器。';
    this.#d.onChange();
  }

  /** 「刪除舊版 Chrome 資料」 (§8.3): the old shared `platform-chrome/` folder, never a per-account profile. */
  deleteLegacyChrome() {
    const dir = join(this.#d.userData, 'platform-chrome');
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  async stop() {
    clearTimeout(this.#vaultTimer);
    this.#enrollAbort?.abort();
    await this.#runtime?.stop().catch(() => {});
    this.#d.posture.stop();
    this.#d.power.release();
  }

  #requireRuntime() {
    if (!this.#runtime || this.#phase !== 'running') throw new Error('這台機器還沒有配對或尚未連線。');
    return this.#runtime;
  }

  snapshot() {
    const runtime = this.#runtime;
    const snap = runtime?.snapshot();
    const state = runtime?.store.state();
    const posture = this.#d.posture.current();
    const remote = this.#d.posture.remote();
    const pairing = this.#pairing;
    const channelChecks = state?.channel_checks ?? {};
    const jobs = (snap?.jobs ?? this.#jobs).map(job => ({ ...job, needs_owner: needsOwner(job) }));
    return {
      phase: this.#phase, message: this.#message, machine_name: this.machineName,
      hub_origin: pairing?.origin ?? null, workspace_id: pairing?.workspace ?? null, device_id: pairing?.device ?? null,
      machine_url: pairing ? `${pairing.origin}/app/${encodeURIComponent(pairing.workspace)}/machines/${encodeURIComponent(pairing.device)}` : null,
      connection: snap?.connection ?? (this.#phase === 'vault_locked' ? 'vault_locked' : 'unpaired'),
      connection_message: snap?.message ?? this.#connection?.message ?? null,
      next_retry_at: snap?.next_retry_at ?? null, last_success_at: snap?.last_success_at ?? null,
      clock_offset_ms: snap?.clock_offset_ms ?? null, clock_warning: snap?.clock_warning ?? false,
      machine_paused: snap?.machine?.paused ?? false, pause_all: snap?.machine?.pause_all ?? false,
      emergency_stop: snap?.emergency_stop ?? false, outbox_depth: snap?.outbox_depth ?? 0,
      channels: (snap?.channels ?? []).map(channel => ({
        social_account_id: channel.social_account_id, provider: channel.provider, handle: channel.handle, profile_key: channel.profile_key,
        effective_mode: channel.effective_mode, paused: channel.paused, last_login_check_at: channelChecks[channel.social_account_id] ?? null,
        blocked: jobs.some(job => job.social_account_id === channel.social_account_id && job.needs_owner),
        web_url: pairing ? `${pairing.origin}/app/${encodeURIComponent(pairing.workspace)}/channels/${encodeURIComponent(channel.social_account_id)}` : null,
      })),
      jobs, posture, remote_access: remote, posture_advice: postureAdvice(posture, remote),
      update: this.#updates?.snapshot() ?? null, enrollment: this.#enrollment,
      autostart: this.#d.autostart.enabled(), automation_notice_version: AUTOMATION_NOTICE_VERSION,
    };
  }
}

/**
 * WA-8 (§8.17): a job needs the owner when it is blocked, or while its filled draft waits for the owner's Post click
 * (assist, or a caption handed over): the runner keeps that job in `running`. An emergency stop is answered with the
 * App's 「恢復」, not in the job's Chrome.
 */
export function needsOwner(job: Pick<LocalJobView, 'state' | 'blocker'>) {
  if (!job.blocker || job.blocker.code === 'owner_stopped') return false;
  return job.state === 'blocked' || job.blocker.code === 'owner_click_required' || job.blocker.code === 'caption_rejected';
}

/** S2 returns the hub's profile_key in each registration; it is fixed once created (S2 ledger item 11). */
export function registeredProfileKey(result: unknown): string | null {
  const list = Array.isArray(result) ? result : (result as { registrations?: unknown } | null)?.registrations;
  const first = Array.isArray(list) ? list[0] as { profile_key?: unknown } | undefined : undefined;
  return typeof first?.profile_key === 'string' && PROFILE_KEY.test(first.profile_key) ? first.profile_key : null;
}

/** Takes the profile for an owner action; a job that keeps using it for 30 s turns into a readable message. */
async function acquireForOwner(runtime: WorkerRuntime, profileKey: string) {
  try { return await runtime.profiles.acquire(profileKey, AbortSignal.timeout(30_000)); }
  catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('這個帳號的 Chrome 正在執行任務，請稍後再試。');
    throw error;
  }
}

/** What adopting the hub's profile key needs from runtime/profiles.ts. */
export interface AdoptableProfiles { root: string; dirFor(key: string): string; close(key: string): Promise<void> | void }

/**
 * Re-registering an account the hub already knows keeps the hub's profile key. Move the fresh sign-in there when
 * that folder does not exist yet on this machine (the enrolment Chrome is closed first and must have exited);
 * otherwise keep the old folder and tell the owner.
 */
export async function adoptProfileKey(profiles: AdoptableProfiles, from: string, to: string, log?: (message: string, detail?: object) => void): Promise<string> {
  const source = profiles.dirFor(from), target = profiles.dirFor(to);
  if (existsSync(target)) return '這個帳號之前已加入這台機器，會繼續使用原本的 Chrome 資料夾；若那裡的登入已過期，請按「重新登入」。';
  try {
    await profiles.close(from);
    renameSync(source, target);
    return '已加入，並沿用中樞記錄的 Chrome 資料夾。';
  } catch (error) {
    log?.('profile adoption failed', { from, to, error: String(error) });
    return '已加入，但剛才登入的 Chrome 資料夾沒能改成中樞記錄的名稱；到點時若顯示未登入，請按「重新登入」。';
  }
}
