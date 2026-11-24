import { Problem, type Context, type OwnerAlert, type OwnerAlertKind, type Ref, type Row } from '@smartsell/contracts';
import { notify, ownerAlertNotificationType, ownerRecipients } from '../workspace/notifications.js';
import { ALERT_KIND, CHANNEL_KIND, OPTIONAL_ALERT_KINDS, OWNER_ALERT_KINDS, SEVERITIES, boundDevice, channelLabel, find, localLabel,
  machineLabel, preferences, webUrl, workspaceTimezone, type OptionalAlertKind } from './model.js';

/** C13 input (phase1-design §11.2). `title` must be one owner-readable sentence and never contain a caption. */
export interface RaiseAlertInput {
  kind: OwnerAlertKind; severity: OwnerAlert['severity']; dedupe_key: string;
  title: string; body: string; machine_id?: string; social_account_id?: string; post_id?: string;
}
/** Extra fields S10's own triggers attach. */
export interface RaiseAlertExtra { job_id?: string; web_url?: string }

export interface PushDelivery {
  channel_id: string; kind: 'ntfy' | 'bark' | 'telegram'; status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number; next_attempt_at: string | null; lease_until: string | null; last_error: string | null; sent_at: string | null;
}

const clip = (value: unknown, max: number) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function nextAlertSeq(ctx: Context): number {
  return ctx.list(ALERT_KIND).reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0) + 1;
}

function pendingDeliveries(ctx: Context): PushDelivery[] {
  return ctx.list(CHANNEL_KIND).filter(row => row.enabled !== false).sort((a, b) => String(a.kind).localeCompare(String(b.kind)))
    .map(row => ({ channel_id: row.id, kind: row.kind as PushDelivery['kind'], status: 'pending', attempts: 0, next_attempt_at: ctx.now,
      lease_until: null, last_error: null, sent_at: null }));
}

/**
 * Write one owner alert, mirror it into the in-app notification feed and queue push deliveries.
 * Returns the new row, or undefined when (kind, dedupe_key) was already raised or the owner switched the kind off.
 * Runs inside the caller's transaction and does no IO: push is sent later by the alerts drain (§11.2 C13).
 * Throws only on programming errors (unknown kind or severity, empty dedupe key); missing machine, channel or post rows are tolerated.
 */
export function createOwnerAlert(ctx: Context, input: RaiseAlertInput & RaiseAlertExtra): Row | undefined {
  if (!OWNER_ALERT_KINDS.includes(input.kind)) throw new Problem(422, 'INVALID_ARGUMENTS', `Unknown owner alert kind: ${String(input.kind)}`);
  if (!SEVERITIES.includes(input.severity)) throw new Problem(422, 'INVALID_ARGUMENTS', `Unknown owner alert severity: ${String(input.severity)}`);
  const key = clip(input.dedupe_key, 300);
  if (!key) throw new Problem(422, 'INVALID_ARGUMENTS', 'dedupe_key is required');
  if ((OPTIONAL_ALERT_KINDS as readonly string[]).includes(input.kind) && !preferences(ctx)[input.kind as OptionalAlertKind]) return undefined;
  const dedupe = `${input.kind}:${key}`;
  if (ctx.list(ALERT_KIND).some(row => row.dedupe_key === dedupe)) return undefined;

  const post = find(ctx, 'publish_target', input.post_id);
  const accountId = input.social_account_id ?? (typeof post?.social_account_id === 'string' ? post.social_account_id : undefined);
  const machineId = input.machine_id ?? boundDevice(ctx, accountId);
  const machine = machineLabel(ctx, machineId);
  const channel = channelLabel(ctx, accountId);
  const zone = workspaceTimezone(ctx);
  const postLabel = post ? [channel, localLabel(post.scheduled_at, zone, ctx.now)].filter(Boolean).join(' ') || '貼文' : undefined;
  const links = {
    machine_web_url: machineId ? webUrl(ctx, 'machine', machineId) : null,
    channel_web_url: accountId ? webUrl(ctx, 'channel', accountId) : null,
    post_web_url: input.post_id ? webUrl(ctx, 'post', input.post_id) : null,
  };
  const target = input.web_url ?? links.post_web_url ?? links.channel_web_url ?? links.machine_web_url ?? webUrl(ctx, 'today');
  const deliveries = pendingDeliveries(ctx);
  const title = clip(input.title, 300) || '有一則通知';
  const row = ctx.create(ALERT_KIND, {
    kind: input.kind, severity: input.severity, title, body: clip(input.body, 2000) || title, dedupe_key: dedupe,
    seq: nextAlertSeq(ctx), at: ctx.now,
    machine_id: machineId ?? null, machine_label: machineId ? machine ?? '機器' : null,
    social_account_id: accountId ?? null, channel_label: accountId ? channel ?? '帳號' : null,
    post_id: input.post_id ?? null, post_label: input.post_id ? postLabel ?? '貼文' : null,
    job_id: input.job_id ?? null, web_url: target, ...links,
    read_at: null, deliveries, push_status: deliveries.length ? 'pending' : 'none',
  });
  for (const recipient of ownerRecipients(ctx)) {
    notify(ctx, recipient, ownerAlertNotificationType, title, {
      resource_type: ALERT_KIND, resource_id: row.id, owner_alert_kind: input.kind, severity: input.severity, web_url: target,
      dedupe_key: `owner_alert:${row.id}`,
    });
  }
  // Bumps the workspace stream revision so the web bell refetches views_alerts (Appendix D note 6).
  ctx.emit('alerts.owner_alert.created', { alert_id: row.id, kind: input.kind, severity: input.severity, seq: row.seq });
  return row;
}

/** C13: the single entry point other streams call. Idempotent per (kind, dedupe_key). */
export function raiseAlert(ctx: Context, input: RaiseAlertInput): void {
  createOwnerAlert(ctx, input);
}

const ref = (id: unknown, label: unknown, url: unknown): Ref | null => typeof id === 'string' && id
  ? { id, label: typeof label === 'string' ? label : '', web_url: typeof url === 'string' ? url : '' } : null;

export function toOwnerAlert(row: Row): OwnerAlert {
  return {
    id: row.id, kind: row.kind as OwnerAlertKind, severity: row.severity as OwnerAlert['severity'], title: String(row.title ?? ''),
    body: String(row.body ?? ''), at: String(row.at ?? row.created_at),
    machine: ref(row.machine_id, row.machine_label, row.machine_web_url), channel: ref(row.social_account_id, row.channel_label, row.channel_web_url),
    post: ref(row.post_id, row.post_label, row.post_web_url), web_url: String(row.web_url ?? ''),
    read_at: typeof row.read_at === 'string' ? row.read_at : null,
  };
}

export function alertRows(ctx: Context, filter: { unread?: boolean; machine_id?: string; after_seq?: number } = {}): Row[] {
  return ctx.list(ALERT_KIND).filter(row => (!filter.unread || row.read_at == null) &&
    (!filter.machine_id || row.machine_id === filter.machine_id) &&
    (filter.after_seq === undefined || Number(row.seq) > filter.after_seq))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
}

export const latestAlertSeq = (ctx: Context) => ctx.list(ALERT_KIND).reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0);
export const unreadAlerts = (ctx: Context) => ctx.list(ALERT_KIND).filter(row => row.read_at == null).length;
