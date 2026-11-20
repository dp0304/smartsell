import { type Context, type Data } from '@smartsell/contracts';
import { isExpired, purgeExpiredObservations } from './intel-observations.js';
import { evaluateAlerts, isIntelFreshnessIssue, isIntelSourceGap, trend } from './intel-signals.js';
import { notify } from '../workspace/notifications.js';
import type { Membership } from '../../identity.js';
import { classifyMention } from './intel-mentions.js';

const day = 86_400_000;
const eventTypes = new Set([
  'intel.observation.recorded',
  'intel.alert.raised',
  'intel.mention.classification_requested',
  'ingest.data_gap.detected',
  'ingest.quality_issue.opened',
  'ingest.data_source.status_changed',
  'ingest.sync_run.failed',
  'ingest.sync_run.completed',
]);
export const intelAcceptsEvent = (type: string): boolean => eventTypes.has(type);

export function applyIntelEvent(ctx: Context, event: Data) {
  const payload = (event.payload ?? {}) as Data;
  if (event.type === 'intel.observation.recorded' && Array.isArray(payload.observation_ids)) {
    return evaluateAlerts(ctx, { observations: payload.observation_ids });
  }
  if (event.type === 'intel.alert.raised') {
    const alert = ctx.list('alert').find(row => row.id === payload.alert_id);
    if (!alert) return;
    const members = (ctx as Context & { activeWorkspaceMembers?: Membership[] }).activeWorkspaceMembers ?? [];
    const recipients = new Set(Array.isArray(alert.recipients) ? alert.recipients : []);
    for (const member of members) {
      if (!recipients.has(member.userId) || member.scopes?.length) continue;
      const stale = alert.alert_type === 'source_stale';
      notify(ctx, member.userId, stale ? 'intel_source_stale' : 'intel_signal', stale ? 'Monitoring source is stale' : 'Monitoring rule matched', {
        resource_type: 'alert', resource_id: alert.id, brand_id: alert.brand_id ?? null, dedupe_key: `intel-alert:${alert.id}`,
      });
    }
    return;
  }
  if (event.type === 'ingest.data_gap.detected' || event.type === 'ingest.quality_issue.opened') {
    const kind = event.type === 'ingest.data_gap.detected' ? 'data_gap' : 'quality_issue';
    const record = ctx.list(kind).find(row => row.id === payload[`${kind}_id`]);
    const applies = record && (kind === 'data_gap' ? isIntelSourceGap(record) : isIntelFreshnessIssue(record));
    const sourceId = record?.data_source_id;
    if (applies && typeof sourceId === 'string') return evaluateAlerts(ctx, { sourceId, checkFreshnessOnly: true });
  }
  if (['ingest.sync_run.completed', 'ingest.sync_run.failed', 'ingest.data_source.status_changed'].includes(String(event.type)) && typeof payload.data_source_id === 'string') {
    return evaluateAlerts(ctx, { sourceId: payload.data_source_id, checkFreshnessOnly: event.type !== 'ingest.sync_run.completed' });
  }
  if (event.type === 'intel.mention.classification_requested' && typeof payload.mention_id === 'string') {
    return classifyMention(ctx, payload.mention_id);
  }
}

export function scanIntelFreshness(ctx: Context) {
  return evaluateAlerts(ctx, { checkFreshnessOnly: true });
}

export function scanIntel(ctx: Context) {
  scanIntelFreshness(ctx);
  const purge = purgeExpiredObservations(ctx);
  for (const row of ctx.list('mention').filter(row => isExpired(ctx, row))) {
    for (const label of ctx.list('mention_label').filter(label => label.mention_id === row.id)) ctx.remove('mention_label', label.id);
    ctx.remove('mention', row.id);
  }
  const to = new Date(`${ctx.now.slice(0, 10)}T00:00:00.000Z`).toISOString();
  const from = new Date(Date.parse(to) - day).toISOString();
  const existing = ctx.list('topic_trend_point');
  for (const topic of ctx.list('topic')) {
    if (!existing.some(row => row.topic_id === topic.id && (row.period as Data)?.to === to)) {
      ctx.create('topic_trend_point', trend(ctx, topic, { from, to }));
    }
  }
  return purge;
}
