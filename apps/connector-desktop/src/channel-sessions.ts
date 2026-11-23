import { setTimeout as wait } from 'node:timers/promises';
import { fields } from '../../../packages/connector-tasks/src/tasks.ts';
import type { ChannelSelection } from '../../connector/src/device-client.ts';
import { channelId, channels, channelRows, registrationPlatform, type ChannelId, type Observation } from './channels.ts';
import { ChromeUnavailable, type ChannelBrowser } from './chrome.ts';
import { creators } from './policy.ts';
import { socialIdentityMatches, socialStatusPlatforms, type SocialStatusClaim, type SocialStatusChannel, type SocialStatusResult } from '../../connector/src/social-status.ts';

const freshness = 30 * 60_000;
const verifyWindow = 8000;
type Status = 'unverified' | 'login' | 'verified' | 'expired' | 'changed';
type Checked = { identity: string; checkedAt: number; session: number };
export type ChannelState = {
  status: Status;
  identity?: string;
  checkedAt?: string;
  registrationPlatform?: string;
  previousIdentity?: string;
  note?: string;
  unavailable?: boolean;
  busy?: 'open' | 'verify';
};
export type BrowserTaskTab = { openAttempted?: boolean; menuAttempted?: boolean; available?: boolean };
type RecordState = { status: Status; last?: Checked; detected?: string; note?: string; unavailable?: boolean; missedProof?: number };

export class ChannelSessions {
  #records = new Map<ChannelId, RecordState>();
  #run = new AbortController();
  #busy?: { id: ChannelId; action: NonNullable<ChannelState['busy']> };
  #polling = false;
  #taskOpening = false;
  #setupSession?: number;
  #setupError?: string;
  #revision = 0;

  constructor(private readonly browser: ChannelBrowser, private readonly now = Date.now) {}

  #record(id: ChannelId): RecordState {
    let record = this.#records.get(id);
    if (!record) {
      record = { status: 'unverified' };
      this.#records.set(id, record);
    }
    if (record.status === 'verified' && (!record.last || record.last.session !== this.browser.session || this.now() - record.last.checkedAt >= freshness)) {
      record.status = 'expired';
      record.note = 'Chrome 会话已关闭或验证已过期，请重新验证。';
    }
    return record;
  }

  snapshot() {
    return Object.fromEntries([...this.#records.keys()].map(id => {
      const { status, last, note, detected, unavailable } = this.#record(id);
      const platform = status === 'verified' && last ? registrationPlatform(id, last.identity) : undefined;
      const result: ChannelState = {
        status, note, unavailable, identity: status === 'changed' ? detected : last?.identity,
        checkedAt: last ? new Date(last.checkedAt).toISOString() : undefined,
        ...(platform && { registrationPlatform: platform }),
        previousIdentity: status === 'changed' ? last?.identity : undefined,
        busy: this.#busy?.id === id ? this.#busy.action : undefined,
      };
      return [id, result];
    }));
  }

  chromeSetup() {
    return { connected: Boolean(this.browser.session && this.#setupSession === this.browser.session), error: this.#setupError };
  }

  async connectChrome(taskSignal: AbortSignal) {
    if (this.#busy || this.#taskOpening || this.#polling) throw new Error('另一项 Chrome 操作正在进行，请稍后重试。');
    if (!this.browser.connect) throw new Error('专用 Chrome 连接不可用。');
    const signal = AbortSignal.any([this.#run.signal, taskSignal]);
    signal.throwIfAborted();
    this.#taskOpening = true;
    this.#setupError = undefined;
    this.#setupSession = undefined;
    try {
      await this.browser.connect(signal);
      signal.throwIfAborted();
      this.#setupSession = this.browser.session;
    } catch (error) {
      if (!signal.aborted) this.#setupError = error instanceof Error ? error.message : '无法连接专用 Chrome，请重试。';
      throw error;
    } finally { this.#taskOpening = false; }
  }

  suspend() {
    this.#revision++;
    this.#run.abort();
    this.#run = new AbortController();
    for (const record of this.#records.values()) {
      if (record.status !== 'verified') continue;
      record.status = 'expired';
      record.note = '本机操作已停止，请重新验证。';
    }
  }

  async #action(id: ChannelId, action: NonNullable<ChannelState['busy']>, perform: (record: RecordState, signal: AbortSignal) => Promise<void>) {
    if (this.#busy || this.#taskOpening) throw new Error('另一项 Chrome 操作正在进行。');
    this.#revision++;
    const record = this.#record(id);
    const signal = this.#run.signal;
    record.unavailable = false;
    record.note = undefined;
    this.#busy = { id, action };
    try { await perform(record, signal); }
    catch (error) {
      if (signal.aborted) return;
      record.unavailable = error instanceof ChromeUnavailable;
      record.note = error instanceof Error ? error.message : 'Chrome 操作失败，请重试。';
      if (action === 'verify' && record.status === 'verified') record.status = 'expired';
    } finally { this.#busy = undefined; }
  }

  async open(value: unknown) {
    const id = channelId(value);
    return this.#action(id, 'open', async (record, signal) => {
      await this.browser.recoverTabs?.([id], signal);
      signal.throwIfAborted();
      if (await this.browser.hasTab(id)) await this.browser.focus(id, signal);
      else await this.browser.open(id, channels[id].page, signal);
      signal.throwIfAborted();
      record.note = '已打开专用 Chrome。完成登录或切换账号后，返回此处验证。';
    });
  }

  // Both task handoffs and channel verification use the dedicated Chrome profile.
  async openTask(id: string, url: string, taskSignal: AbortSignal) {
    if (this.#busy || this.#taskOpening) throw new Error('请等待当前 Chrome 渠道操作完成。');
    this.#revision++;
    this.#taskOpening = true;
    const signal = AbortSignal.any([taskSignal, this.#run.signal]);
    try {
      if (id === 'douyin' || id === 'xhs') {
        await this.browser.recoverTabs?.([id], signal);
        if (await this.browser.hasTab(id)) return await this.browser.focus(id, signal);
      }
      await this.browser.open(id, url, signal);
    } finally { this.#taskOpening = false; }
  }

  observeOpenTab(id: ChannelId, signal: AbortSignal) {
    return this.#observeTab(id, signal);
  }

  observeTaskTab(id: keyof typeof creators, state: BrowserTaskTab, signal: AbortSignal) {
    return this.#observeTab(id, signal, { url: creators[id], state });
  }

  async #observeTab(id: ChannelId, taskSignal: AbortSignal, task?: { url: string; state: BrowserTaskTab; allowMenu?: boolean }): Promise<Observation> {
    taskSignal.throwIfAborted();
    const initialSession = this.browser.session;
    if (this.#busy || this.#taskOpening || (!initialSession && (!task || task.state.openAttempted))) return { kind: 'unknown' };
    this.#taskOpening = true;
    this.#revision++;
    const signal = AbortSignal.any([taskSignal, this.#run.signal]);
    try {
      const opening = task && !task.state.openAttempted ? task : undefined;
      if (opening) opening.state.openAttempted = true;
      if (task) task.state.available = false;
      await this.browser.recoverTabs?.([id], signal);
      const present = await this.browser.hasTab(id);
      signal.throwIfAborted();
      if (!task && initialSession !== this.browser.session) return { kind: 'unknown' };
      if (!present) {
        if (!opening) return { kind: 'unknown' };
        await this.browser.open(id, opening.url, signal);
      }
      signal.throwIfAborted();
      const session = this.browser.session;
      let observed = await this.browser.inspect(id, signal);
      signal.throwIfAborted();
      if (session !== this.browser.session) return { kind: 'unknown' };
      if (task && task.allowMenu !== false && observed.kind === 'unknown' && observed.control && !task.state.menuAttempted) {
        task.state.menuAttempted = true;
        await this.browser.click(id, observed.control, signal);
        signal.throwIfAborted();
        observed = await this.browser.inspect(id, signal);
        signal.throwIfAborted();
        if (session !== this.browser.session) return { kind: 'unknown' };
      }
      if (task) task.state.available = true;
      this.#observe(this.#record(id), observed, false);
      return observed;
    } catch {
      signal.throwIfAborted();
      return { kind: 'unknown' };
    } finally { this.#taskOpening = false; }
  }

  async readSocialStatus(claim: SocialStatusClaim, signal: AbortSignal): Promise<SocialStatusResult> {
    if (claim.mode === 'recent_posts') return { channels: [await this.#readRecentPosts(claim, signal)] };
    const result: SocialStatusChannel[] = [];
    for (const platform of claim.platform ? [claim.platform] : socialStatusPlatforms) {
      signal.throwIfAborted();
      const observation = claim.platform ? await this.#readDirectedStatus(platform, signal) : await this.observeOpenTab(platform, signal);
      if (observation.kind === 'login') result.push({ platform, status: 'login_required' });
      else if (observation.kind !== 'identity') result.push({ platform, status: 'unverified' });
      else if (claim.expected_identity && !socialIdentityMatches(platform, observation.identity, claim.expected_identity)) result.push({ platform, status: 'identity_mismatch' });
      else result.push({ platform, status: 'verified', identity: observation.identity });
    }
    return { channels: result };
  }

  async #readDirectedStatus(platform: ChannelId, signal: AbortSignal): Promise<Observation> {
    const tab = { url: channels[platform].page, state: {}, allowMenu: false };
    const attempts = platform === 'x' ? 12 : 6;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const observation = await this.#observeTab(platform, signal, tab);
      if (observation.kind !== 'unknown' || !this.browser.session) return observation;
      await wait(300, undefined, { signal });
    }
    return { kind: 'unknown' };
  }

  async #readRecentPosts(claim: SocialStatusClaim, taskSignal: AbortSignal): Promise<SocialStatusChannel> {
    const platform = claim.platform ?? 'x';
    if (platform !== 'x' || !this.browser.readRecentX) return { platform, status: 'unsupported' };
    if (this.#busy || this.#taskOpening) return { platform, status: 'unverified' };
    this.#taskOpening = true;
    this.#revision++;
    const signal = AbortSignal.any([taskSignal, this.#run.signal]);
    try {
      signal.throwIfAborted();
      await this.browser.recoverTabs?.(['x'], signal);
      const present = await this.browser.hasTab('x');
      signal.throwIfAborted();
      if (!present) await this.browser.open('x', channels.x.page, signal);
      signal.throwIfAborted();
      const result = await this.browser.readRecentX(claim.expected_identity, signal);
      signal.throwIfAborted();
      switch (result.kind) {
        case 'posts':
          if (claim.expected_identity && !socialIdentityMatches(platform, result.identity, claim.expected_identity)) return { platform, status: 'identity_mismatch' };
          return { platform, status: 'verified', identity: result.identity, posts: result.posts };
        case 'identity_mismatch': case 'login_required': return { platform, status: result.kind };
        default: return { platform, status: 'unverified' };
      }
    } catch {
      signal.throwIfAborted();
      return { platform, status: 'unverified' };
    } finally { this.#taskOpening = false; }
  }

  #observe(record: RecordState, observed: Observation, verifying: boolean) {
    if (observed.kind === 'login') {
      record.status = 'login';
      record.note = '请在专用 Chrome 完成登录、验证码或二次验证，再返回验证。';
      return;
    }
    if (observed.kind !== 'identity') {
      if (observed.invalidated && record.status === 'verified') {
        record.status = 'expired';
        record.note = '当前页面未能确认上次身份，请回到官方账号或店铺页重新验证。';
      }
      return;
    }
    const last = record.last;
    if (last && last.identity !== observed.identity && (record.status !== 'changed' || record.detected !== observed.identity || !verifying)) {
      record.status = 'changed';
      record.detected = observed.identity;
      record.note = '检测到 Chrome 中的身份变化。核对后再次点击验证。';
    } else if (verifying) {
      record.last = { identity: observed.identity, checkedAt: this.now(), session: this.browser.session };
      record.status = 'verified';
      record.detected = record.note = undefined;
    }
  }

  async verify(value: unknown) {
    const id = channelId(value);
    return this.#action(id, 'verify', async (record, signal) => {
      await this.browser.recoverTabs?.([id], signal);
      signal.throwIfAborted();
      if (await this.browser.hasTab(id)) await this.browser.focus(id, signal);
      else await this.browser.open(id, channels[id].page, signal);
      const deadline = Date.now() + verifyWindow;
      let clicked = false;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const result = await this.browser.inspect(id, signal).catch((): Observation => ({ kind: 'unknown' }));
        signal.throwIfAborted();
        if (result.kind !== 'unknown') {
          this.#observe(record, result, true);
          return;
        }
        if (result.control && !clicked) {
          clicked = true;
          await this.browser.click(id, result.control, signal);
        }
        await wait(350, undefined, { signal });
      }
      if (record.status === 'verified') record.status = 'expired';
      record.note = '未读到唯一的账号或店铺身份。请在同一 Chrome 标签页打开账号菜单或店铺资料后重试。';
    });
  }

  async scan(signal: AbortSignal) {
    if (this.#busy || this.#taskOpening) throw new Error('另一项 Chrome 操作正在进行。');
    this.#taskOpening = true;
    this.#revision++;
    signal = AbortSignal.any([signal, this.#run.signal]);
    try {
      await this.browser.recoverTabs?.(channelRows.map(row => row.id), signal);
      for (const { id } of channelRows) {
        signal.throwIfAborted();
        const record = this.#record(id);
        record.unavailable = false;
        if (!await this.browser.hasTab(id)) {
          if (record.status === 'verified') record.status = 'expired';
          record.note = '专用 Chrome 中没有此渠道的官方标签页。请打开官方页面后检查。';
          continue;
        }
        signal.throwIfAborted();
        const session = this.browser.session;
        let observed;
        try { observed = await this.browser.inspect(id, signal); }
        catch {
          signal.throwIfAborted();
          if (record.status === 'verified') record.status = 'expired';
          record.note = '读取官方页面失败，请检查网络和 Chrome 标签页后重试。';
          continue;
        }
        signal.throwIfAborted();
        if (session !== this.browser.session || observed.kind === 'unknown') {
          if (record.status === 'verified') record.status = 'expired';
          record.note = '请在专用 Chrome 打开账号或店铺资料，再检查身份。';
          continue;
        }
        this.#observe(record, observed, record.status !== 'changed');
      }
    } finally { this.#taskOpening = false; }
  }

  async recheck(value: unknown, signal: AbortSignal): Promise<ChannelSelection[]> {
    if (!Array.isArray(value) || !value.length || value.length > channelRows.length) throw new Error('请至少选择一个已验证渠道。');
    if (this.#busy || this.#taskOpening) throw new Error('另一项 Chrome 操作正在进行。');
    const checked = new Map<ChannelId, { identity: string; platform: string; proof: Checked }>();
    for (const item of value) {
      const row = fields(item, ['id', 'identity', 'checkedAt']);
      const id = channelId(row.id);
      const { last, status } = this.#record(id);
      const platform = last && registrationPlatform(id, last.identity);
      if (checked.has(id) || !last || !platform || status !== 'verified' || last.identity !== row.identity ||
        new Date(last.checkedAt).toISOString() !== row.checkedAt) throw new Error('所选渠道的验证已更改或过期，请重新检查并勾选。');
      checked.set(id, { identity: last.identity, platform, proof: last });
    }
    signal = AbortSignal.any([signal, this.#run.signal]);
    this.#revision++;
    this.#taskOpening = true;
    try {
      const selections: ChannelSelection[] = [];
      for (const [id, { identity, platform, proof }] of checked) {
        signal.throwIfAborted();
        const record = this.#record(id);
        let observed: Observation = { kind: 'unknown', invalidated: true };
        try {
          if (await this.browser.hasTab(id)) observed = await this.browser.inspect(id, signal);
        } catch {
          signal.throwIfAborted();
          throw new Error(`${channels[id].name} 检查失败。请检查网络或标签页后重试。`);
        }
        signal.throwIfAborted();
        this.#observe(record, observed, false);
        if (observed.kind !== 'identity' || observed.identity !== identity || this.browser.session !== proof.session ||
          this.#record(id).status !== 'verified') {
          if (record.status === 'verified') record.status = 'expired';
          throw new Error(`${channels[id].name} 的登录或身份已变化。请重新验证并勾选。`);
        }
        selections.push({ kind: channels[id].group === 'social' ? 'social' : 'store', platform, external_id: identity,
          observed_at: new Date(this.now()).toISOString() });
      }
      if ([...checked.keys()].some(id => this.#record(id).status !== 'verified')) throw new Error('所选渠道的验证已过期，请重新检查。');
      return selections;
    } finally { this.#taskOpening = false; }
  }

  async poll() {
    if (this.#busy || this.#taskOpening || this.#polling) return;
    const revision = this.#revision;
    const signal = this.#run.signal;
    this.#polling = true;
    try {
      for (const id of this.#records.keys()) {
        const record = this.#record(id);
        if (record.status !== 'verified') continue;
        const present = await this.browser.hasTab(id).catch(() => true);
        if (signal.aborted || revision !== this.#revision) break;
        if (!present) {
          record.status = 'expired';
          record.note = '验证使用的 Chrome 标签页已关闭或离开官方页面，请重新验证。';
          continue;
        }
        const result = await this.browser.inspect(id, signal).catch((): Observation => ({ kind: 'unknown' }));
        if (signal.aborted || revision !== this.#revision) break;
        this.#observe(record, result, false);
      }
    } finally { this.#polling = false; }
  }
}
