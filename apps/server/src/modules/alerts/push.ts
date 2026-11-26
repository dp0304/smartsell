import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Problem, type AlertChannelConfig, type Context, type Data, type Input, type OwnerAlertKind, type Row } from '@smartsell/contracts';
import { fromAgent } from '../../agent-actor.js';
import { presenceSince } from '../worker/presence.js';
import { KIND_LABEL, firstSentence } from './copy.js';
import { ALERT_KIND, CHANNEL_KIND, PREFERENCE_KIND, TEST_KIND, alertHooks, find, invalidArgs, localStamp, preferences, webUrl,
  workspaceTimezone } from './model.js';
import type { PushDelivery } from './raise.js';
import { scanAlertReminders } from './reminders.js';
import { EgressDenied, publicFetch } from '../../integration/public-egress.js';
import { publicAddress } from '../traffic/probe.js';
import { isIP } from 'node:net';

export type PushKind = AlertChannelConfig['kind'];
export const PUSH_KINDS: readonly PushKind[] = ['ntfy', 'bark', 'telegram'];
/** First attempt plus three retries (§5.9, §10.1: "推播失敗時記錄並重試 3 次"). */
export const PUSH_RETRIES = 3;
export const PUSH_MAX_ATTEMPTS = 1 + PUSH_RETRIES;
/** Wait before retry n (after attempt n failed). */
export const PUSH_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000];
const SEND_LEASE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DELIVERIES_PER_CYCLE = 20;

// ---------- Token sealing (alert_channel tokens are encrypted at rest, §3.1) ----------

function sealingKey(): Buffer {
  const configured = alertHooks().secretKey;
  if (configured?.byteLength === 32) return Buffer.from(configured);
  const secret = process.env.APP_SECRET;
  if (secret) return createHash('sha256').update(`smartsell:alert-channel:v1:${secret}`).digest();
  throw new Problem(503, 'ALERT_SECRET_UNAVAILABLE', 'The hub has no key to protect push tokens. Configure APP_SECRET and restart the hub.');
}
const aad = (ctx: Context, kind: PushKind) => Buffer.from(JSON.stringify(['smartsell.alert_channel', ctx.tenantId, ctx.workspaceId, kind]));

export function sealToken(ctx: Context, kind: PushKind, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(), iv);
  cipher.setAAD(aad(ctx, kind));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

export function openToken(ctx: Context, kind: PushKind, sealed: unknown): string | undefined {
  if (typeof sealed !== 'string' || !sealed.startsWith('v1.')) return undefined;
  try {
    const data = Buffer.from(sealed.slice(3), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(), data.subarray(0, 12));
    decipher.setAAD(aad(ctx, kind));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  } catch { return undefined; }
}

// ---------- Channel settings (hub_alerts_get_channels / hub_alerts_update_channels) ----------

const object = (value: unknown, path: string): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : invalidArgs(`${path} must be an object`, path);
function only(value: Data, allowed: readonly string[], path: string) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) invalidArgs(`Unknown field ${path ? `${path}.` : ''}${extra}. Allowed: ${allowed.join(', ')}`, path ? `${path}.${extra}` : extra);
}
function pushUrl(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 500) return invalidArgs(`${path} must be an http(s) URL of at most 500 characters`, path);
  let url: URL;
  try { url = new URL(value.trim()); } catch { return invalidArgs(`${path} must be an http(s) URL`, path); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    return invalidArgs(`${path} must be an http(s) URL without credentials or fragment`, path);
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (!segments.length) return invalidArgs(`${path} must include the topic or device key in its path`, path);
  // S6: outside the hub, refuse what is plainly inside the network now; sending checks the resolved address again.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!alertHooks().privateEgress && (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !publicAddress(host)))) {
    return invalidArgs(`${path} must be a public address; this server does not send push to private networks`, path);
  }
  return `${url.origin}/${segments.join('/')}${url.search}`;
}
function secretValue(value: unknown, path: string, pattern: RegExp, hint: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !pattern.test(value.trim())) return invalidArgs(`${path} ${hint}`, path);
  return value.trim();
}

/**
 * E46 (SEC-1): for Bark and a public ntfy topic the URL path is the only credential. An Agent reader gets the origin and a
 * short fingerprint of the secret (the last 4 characters of a long one); the query, which may carry `auth=`, is hidden.
 */
export function maskPushUrl(kind: 'ntfy' | 'bark', value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return '****'; }
  const segments = url.pathname.split('/').filter(Boolean);
  const hide = (secret: string) => secret.length >= 12 ? `****${secret.slice(-4)}` : '****';
  // Bark: https://api.day.app/<device key>[/…]; ntfy: https://ntfy.sh[/<base path>]/<topic>.
  const path = kind === 'bark' ? [hide(segments[0] ?? '')] : [...segments.slice(0, -1), hide(segments.at(-1) ?? '')];
  return `${url.origin}/${path.join('/')}${url.search ? '?****' : ''}`;
}

export function channelView(ctx: Context, row: Row) {
  const base = { id: row.id, enabled: row.enabled !== false, last_test: row.last_test ?? null, last_delivery: row.last_delivery ?? null };
  // The person on the settings page sees the full URL (they type it there); an Agent credential never does (E46).
  const url = (kind: 'ntfy' | 'bark') => fromAgent(ctx) ? maskPushUrl(kind, String(row.url)) : String(row.url);
  const config: AlertChannelConfig = row.kind === 'ntfy' ? { kind: 'ntfy', url: url('ntfy'), token_set: typeof row.token_sealed === 'string' }
    : row.kind === 'bark' ? { kind: 'bark', url: url('bark') }
      : { kind: 'telegram', chat_id: String(row.chat_id), token_set: typeof row.token_sealed === 'string' };
  return { ...config, ...base };
}

export function getChannels(ctx: Context) {
  return {
    channels: ctx.list(CHANNEL_KIND).sort((a, b) => PUSH_KINDS.indexOf(a.kind as PushKind) - PUSH_KINDS.indexOf(b.kind as PushKind)).map(row => channelView(ctx, row)),
    preferences: preferences(ctx),
    settings_url: webUrl(ctx, 'notifications'),
  };
}

/**
 * PUT /hub/alerts/channels (ADMIN, human only). `channels` replaces the whole set (at most one per kind).
 * A token that is omitted keeps the stored one; `null` clears it. Tokens are sealed and never returned.
 */
export function updateChannels(ctx: Context, { body }: Input) {
  only(body, ['channels', 'preferences'], '');
  if (body.channels === undefined && body.preferences === undefined) invalidArgs('Send channels, preferences or both');
  if (body.preferences !== undefined) {
    const prefs = object(body.preferences, 'preferences');
    only(prefs, ['published', 'daily_summary'], 'preferences');
    for (const key of Object.keys(prefs)) if (typeof prefs[key] !== 'boolean') invalidArgs(`preferences.${key} must be a boolean`, `preferences.${key}`);
    const existing = ctx.list(PREFERENCE_KIND)[0];
    if (existing) ctx.update(PREFERENCE_KIND, existing.id, prefs);
    else ctx.create(PREFERENCE_KIND, { published: true, daily_summary: true, ...prefs });
  }
  if (body.channels !== undefined) {
    if (!Array.isArray(body.channels) || body.channels.length > PUSH_KINDS.length) invalidArgs('channels must be an array of at most 3 entries', 'channels');
    const current = new Map(ctx.list(CHANNEL_KIND).map(row => [String(row.kind), row]));
    const seen = new Set<string>();
    const writes = (body.channels as unknown[]).map((raw, index) => {
      const path = `channels[${index}]`;
      const item = object(raw, path);
      const kind = item.kind;
      if (typeof kind !== 'string' || !(PUSH_KINDS as readonly string[]).includes(kind)) return invalidArgs(`${path}.kind must be one of ${PUSH_KINDS.join(', ')}`, `${path}.kind`);
      if (seen.has(kind)) invalidArgs(`Only one ${kind} channel is allowed`, `${path}.kind`);
      seen.add(kind);
      const previous = current.get(kind);
      const enabled = item.enabled === undefined ? true : typeof item.enabled === 'boolean' ? item.enabled : invalidArgs(`${path}.enabled must be a boolean`, `${path}.enabled`);
      if (kind === 'ntfy') {
        only(item, ['kind', 'url', 'token', 'enabled'], path);
        const token = secretValue(item.token, `${path}.token`, /^[A-Za-z0-9_.-]{8,200}$/, 'must be an ntfy access token');
        return { kind, previous, values: { kind, enabled, url: pushUrl(item.url, `${path}.url`), chat_id: null }, token };
      }
      if (kind === 'bark') {
        only(item, ['kind', 'url', 'enabled'], path);
        return { kind, previous, values: { kind, enabled, url: pushUrl(item.url, `${path}.url`), chat_id: null }, token: null };
      }
      only(item, ['kind', 'chat_id', 'bot_token', 'enabled'], path);
      const chatId = typeof item.chat_id === 'string' && /^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(item.chat_id.trim()) ? item.chat_id.trim()
        : invalidArgs(`${path}.chat_id must be a numeric chat id or @channel name`, `${path}.chat_id`);
      const token = secretValue(item.bot_token, `${path}.bot_token`, /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/, 'must be a Telegram bot token (123456:ABC…)');
      if (token === null || (token === undefined && typeof previous?.token_sealed !== 'string')) invalidArgs(`${path}.bot_token is required`, `${path}.bot_token`);
      return { kind, previous, values: { kind, enabled, url: null, chat_id: chatId }, token };
    });
    for (const [kind, row] of current) if (!seen.has(kind)) ctx.remove(CHANNEL_KIND, row.id);
    for (const write of writes) {
      const token_sealed = write.token === undefined ? write.previous?.token_sealed ?? null
        : write.token === null ? null : sealToken(ctx, write.kind as PushKind, write.token);
      const changed = !write.previous || write.previous.url !== write.values.url || write.previous.chat_id !== write.values.chat_id || write.token !== undefined;
      const values = { ...write.values, token_sealed, ...(changed && { last_test: null, last_delivery: null }) };
      if (write.previous) ctx.update(CHANNEL_KIND, write.previous.id, values);
      else ctx.create(CHANNEL_KIND, values);
    }
  }
  ctx.emit('alerts.channels.updated', { kinds: ctx.list(CHANNEL_KIND).map(row => row.kind) });
  return getChannels(ctx);
}

/** POST /hub/alerts/test (ADMIN, human only): queue one test push per enabled channel. Sent by the drain, outside any transaction. */
export function queueTest(ctx: Context, { body }: Input) {
  only(body, [], '');
  const channels = ctx.list(CHANNEL_KIND).filter(row => row.enabled !== false);
  if (!channels.length) invalidArgs('No push channel is configured. Add ntfy, Bark or Telegram first.', 'channels');
  const deliveries: PushDelivery[] = channels.map(row => ({ channel_id: row.id, kind: row.kind as PushKind, status: 'pending', attempts: 0,
    next_attempt_at: ctx.now, lease_until: null, last_error: null, sent_at: null }));
  const test = ctx.create(TEST_KIND, { status: 'queued', at: ctx.now, deliveries, requested_by: ctx.actorId });
  for (const row of channels) ctx.update(CHANNEL_KIND, row.id, { last_test: { test_id: test.id, at: ctx.now, status: 'queued', error: null } });
  return { test_id: test.id, status: 'queued', channels: deliveries.map(delivery => delivery.kind) };
}

// ---------- Message format (§5.9 channel 3, §12.1 risk 13) ----------

export interface PushMessage { title: string; message: string; url: string; severity: 'urgent' | 'normal' | 'info' }

/** Only machine, account, local time, one sentence and the link. Never the alert body, captions or media. */
export function formatPush(alert: Row, zone: string): PushMessage {
  const lines = [
    ...(typeof alert.machine_label === 'string' ? [`機器：${alert.machine_label}`] : []),
    ...(typeof alert.channel_label === 'string' ? [`帳號：${alert.channel_label}`] : []),
    `時間：${localStamp(String(alert.at ?? alert.created_at), zone)}`,
    firstSentence(String(alert.title ?? '')),
    String(alert.web_url ?? ''),
  ];
  return { title: `SmartSell · ${KIND_LABEL[alert.kind as OwnerAlertKind] ?? '通知'}`, message: lines.join('\n'), url: String(alert.web_url ?? ''),
    severity: (alert.severity as PushMessage['severity']) ?? 'normal' };
}

export function formatTestPush(ctx: Context, at: string): PushMessage {
  const url = webUrl(ctx, 'notifications');
  return { title: 'SmartSell · 測試', message: [`時間：${localStamp(at, workspaceTimezone(ctx))}`, '這是一則測試通知；收到就表示手機推播設定正確。', url].join('\n'),
    url, severity: 'normal' };
}

// ---------- Senders ----------

export interface ChannelSecrets { kind: PushKind; url: string | null; chat_id: string | null; token: string | null }
export type SendResult = { ok: true } | { ok: false; error: string };

async function readJson(response: Response): Promise<Data | undefined> {
  try { return await response.json() as Data; } catch { return undefined; }
}

/**
 * One HTTP request to the configured service. Errors never contain the URL or a token. Outside the hub the request goes
 * through the customer egress guard (S6): the host is resolved once, must be public, and that address is pinned.
 */
export async function sendPush(channel: ChannelSecrets, message: PushMessage,
  fetcher: typeof fetch = alertHooks().fetch ?? (alertHooks().privateEgress ? fetch : publicFetch),
  timeoutMs = alertHooks().pushTimeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<SendResult> {
  const json = (url: string, body: Data, headers: Record<string, string> = {}) => fetcher(url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body),
  });
  try {
    if (channel.kind === 'ntfy') {
      // JSON publishing goes to the server root with the topic in the body, so titles may be UTF-8.
      const url = new URL(channel.url ?? '');
      const segments = url.pathname.split('/').filter(Boolean);
      const topic = segments.pop() ?? '';
      const root = `${url.origin}/${segments.map(segment => `${segment}/`).join('')}`;
      const response = await json(root, {
        topic, title: message.title, message: message.message, click: message.url,
        priority: message.severity === 'urgent' ? 5 : message.severity === 'info' ? 2 : 3, tags: message.severity === 'urgent' ? ['warning'] : [],
      }, channel.token ? { authorization: `Bearer ${channel.token}` } : {});
      return response.ok ? { ok: true } : { ok: false, error: `ntfy HTTP ${response.status}` };
    }
    if (channel.kind === 'bark') {
      const response = await json(channel.url ?? '', {
        title: message.title, body: message.message, url: message.url, group: 'SmartSell',
        level: message.severity === 'urgent' ? 'timeSensitive' : message.severity === 'info' ? 'passive' : 'active',
      });
      const data = await readJson(response);
      return response.ok && (data?.code === undefined || data.code === 200) ? { ok: true } : { ok: false, error: `Bark HTTP ${response.status}` };
    }
    const base = (alertHooks().telegramApiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    const response = await json(`${base}/bot${channel.token ?? ''}/sendMessage`, {
      chat_id: channel.chat_id, text: `${message.title}\n${message.message}`, disable_notification: message.severity === 'info',
      link_preview_options: { is_disabled: true },
    });
    const data = await readJson(response);
    if (response.ok && data?.ok === true) return { ok: true };
    const description = typeof data?.description === 'string' ? `: ${data.description.replace(/\d{3,20}:[A-Za-z0-9_-]{20,}/g, '[token]').slice(0, 120)}` : '';
    return { ok: false, error: `Telegram HTTP ${response.status}${description}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (error instanceof EgressDenied) return { ok: false, error: 'destination_not_public' };
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error' };
  }
}

// ---------- Drain: claim in a short transaction, send outside it, record in another (§0 principle 8) ----------

export type AlertTransaction = <T>(run: (ctx: Context) => T | Promise<T>) => Promise<T>;
interface SendJob { source: 'alert' | 'test'; row_id: string; channel_id: string; attempts: number; channel: ChannelSecrets; message: PushMessage }
interface SendOutcome { job: SendJob; result: SendResult }

const due = (delivery: PushDelivery, now: number) => (delivery.status === 'pending' && Date.parse(delivery.next_attempt_at ?? '') <= now) ||
  (delivery.status === 'sending' && Date.parse(delivery.lease_until ?? '') <= now);

function rollup(deliveries: PushDelivery[]): string {
  if (!deliveries.length) return 'none';
  if (deliveries.some(delivery => delivery.status === 'pending' || delivery.status === 'sending')) return 'pending';
  if (deliveries.every(delivery => delivery.status === 'sent')) return 'sent';
  return deliveries.every(delivery => delivery.status === 'failed') ? 'failed' : 'partial';
}

export function claimDeliveries(ctx: Context, nowMs: number): SendJob[] {
  const now = new Date(nowMs).toISOString();
  const zone = workspaceTimezone(ctx);
  const jobs: SendJob[] = [];
  const sources: { source: SendJob['source']; kind: string; rows: Row[] }[] = [
    { source: 'test', kind: TEST_KIND, rows: ctx.list(TEST_KIND).filter(row => row.status === 'queued' || row.status === 'sending') },
    { source: 'alert', kind: ALERT_KIND, rows: ctx.list(ALERT_KIND).filter(row => row.push_status === 'pending').sort((a, b) => Number(a.seq) - Number(b.seq)) },
  ];
  for (const { source, kind, rows } of sources) {
    for (const row of rows) {
      if (jobs.length >= DELIVERIES_PER_CYCLE) break;
      const deliveries = (row.deliveries as PushDelivery[] | undefined ?? []).map(delivery => ({ ...delivery }));
      let touched = false;
      for (const delivery of deliveries) {
        if (jobs.length >= DELIVERIES_PER_CYCLE || !due(delivery, nowMs)) continue;
        touched = true;
        // A send whose lease ran out (the hub stopped mid-request) counts as an attempt, so a crash loop cannot push forever.
        if (delivery.status === 'sending') {
          delivery.attempts += 1;
          if (delivery.attempts >= (source === 'test' ? 1 : PUSH_MAX_ATTEMPTS)) {
            Object.assign(delivery, { status: 'failed', last_error: 'interrupted', lease_until: null, next_attempt_at: null });
            continue;
          }
        }
        const channel = find(ctx, CHANNEL_KIND, delivery.channel_id);
        const token = channel && typeof channel.token_sealed === 'string' ? openToken(ctx, delivery.kind, channel.token_sealed) : null;
        const missing = !channel || channel.enabled === false ? 'channel_removed'
          : token === undefined ? 'token_unavailable' : channel.kind === 'telegram' && !token ? 'token_missing' : undefined;
        if (missing) {
          Object.assign(delivery, { status: 'failed', last_error: missing, lease_until: null, next_attempt_at: null });
          continue;
        }
        Object.assign(delivery, { status: 'sending', lease_until: new Date(nowMs + SEND_LEASE_MS).toISOString() });
        jobs.push({ source, row_id: row.id, channel_id: delivery.channel_id, attempts: delivery.attempts,
          channel: { kind: delivery.kind, url: typeof channel!.url === 'string' ? channel!.url : null,
            chat_id: typeof channel!.chat_id === 'string' ? channel!.chat_id : null, token: token ?? null },
          message: source === 'alert' ? formatPush(row, zone) : formatTestPush(ctx, String(row.at ?? now)) });
      }
      if (touched) ctx.update(kind, row.id, source === 'alert' ? { deliveries, push_status: rollup(deliveries) }
        : { deliveries, status: rollup(deliveries) === 'pending' ? 'sending' : rollup(deliveries) });
    }
  }
  return jobs;
}

export function recordOutcomes(ctx: Context, outcomes: SendOutcome[], nowMs: number) {
  const now = new Date(nowMs).toISOString();
  const byRow = Map.groupBy(outcomes, outcome => `${outcome.job.source}/${outcome.job.row_id}`);
  for (const group of byRow.values()) {
    const { source, row_id } = group[0]!.job;
    const kind = source === 'alert' ? ALERT_KIND : TEST_KIND;
    const row = find(ctx, kind, row_id);
    if (!row) continue;
    const deliveries = (row.deliveries as PushDelivery[] | undefined ?? []).map(delivery => ({ ...delivery }));
    for (const { job, result } of group) {
      const delivery = deliveries.find(item => item.channel_id === job.channel_id);
      if (!delivery || delivery.status !== 'sending' || delivery.attempts !== job.attempts) continue;
      const attempts = delivery.attempts + 1;
      // A test push gets one attempt so the settings page shows the result right away.
      const limit = source === 'test' ? 1 : PUSH_MAX_ATTEMPTS;
      const next: Partial<PushDelivery> = result.ok ? { status: 'sent', sent_at: now, next_attempt_at: null, last_error: null }
        : attempts >= limit ? { status: 'failed', next_attempt_at: null, last_error: result.error }
          : { status: 'pending', last_error: result.error,
            next_attempt_at: new Date(nowMs + PUSH_BACKOFF_MS[Math.min(attempts, PUSH_BACKOFF_MS.length) - 1]!).toISOString() };
      Object.assign(delivery, next, { attempts, lease_until: null });
      const channel = find(ctx, CHANNEL_KIND, job.channel_id);
      if (channel && next.status !== 'pending') {
        const summary = { at: now, status: next.status, error: delivery.last_error, attempts };
        ctx.update(CHANNEL_KIND, channel.id, source === 'test' ? { last_test: { test_id: row.id, ...summary } } : { last_delivery: { alert_id: row.id, ...summary } });
      }
    }
    const status = rollup(deliveries);
    ctx.update(kind, row.id, source === 'alert' ? { deliveries, push_status: status } : { deliveries, status: status === 'pending' ? 'sending' : status });
  }
}

export interface AlertDrainOptions {
  now?: () => number; reminderIntervalMs?: number; fetch?: typeof fetch;
  /** AO-4: when this hub process started (default: presence tracking start, presence.ts). */
  hubStartedAt?: () => string;
}

/**
 * Background drain for the hub process (`BackgroundDrain` in runtime.ts). Every call: scan reminders (throttled),
 * claim due push deliveries, send them outside any transaction, record the outcome.
 */
export function createAlertsDrain(options: AlertDrainOptions = {}) {
  const lastScan = new Map<string, number>();
  // Without an injected clock, time comes from the transaction (ctx.now), like every other schedule.
  const clock = (ctx: Context) => options.now?.() ?? Date.parse(ctx.now);
  return async function alertsDrain(transact: AlertTransaction): Promise<void> {
    const jobs = await transact(ctx => {
      const now = clock(ctx);
      const previous = lastScan.get(ctx.workspaceId);
      if (previous === undefined || now - previous >= (options.reminderIntervalMs ?? 15_000)) {
        lastScan.set(ctx.workspaceId, now);
        scanAlertReminders(ctx, { hubStartedAt: options.hubStartedAt?.() ?? presenceSince() });
      }
      return claimDeliveries(ctx, now);
    });
    if (!jobs.length) return;
    const outcomes = await Promise.all(jobs.map(async job => ({ job, result: await sendPush(job.channel, job.message, options.fetch) })));
    await transact(ctx => recordOutcomes(ctx, outcomes, clock(ctx)));
  };
}
