import { ADMIN, READ, type Context, type Input, type Operation, type OwnerAlert } from '@smartsell/contracts';
import { ALERT_KIND, invalidArgs } from './model.js';
import { getChannels, queueTest, updateChannels } from './push.js';
import { alertRows, toOwnerAlert, unreadAlerts } from './raise.js';
import { alertReminderSchedule } from './reminders.js';
import { alertTriggerSubscriber } from './triggers.js';

/** Owner alerts (phase1-design §5.9, S10). C13: other streams import `raiseAlert` from here. */
export { raiseAlert, createOwnerAlert, toOwnerAlert, unreadAlerts, type RaiseAlertInput } from './raise.js';
export { registerAgentAlertStream, ALERT_STREAM_PATH, type AlertStreamCredentials, type AlertStreamPrincipal } from './stream.js';
export { createAlertsDrain, formatPush, sendPush, type AlertTransaction } from './push.js';
export { configureAlerts, type AlertHooks } from './model.js';
export { scanAlertReminders } from './reminders.js';
export { alertJobStatus, alertLateFact, alertOfflineStaleSettings, alertHandleChanged, alertApprovalCreated, alertUploadDone, alertUploadFailed, applyAlertEvent } from './triggers.js';

/** GET /views/alerts: newest first. Unknown query parameters are rejected (§9.7). */
export function viewAlerts(ctx: Context, { query }: Input): OwnerAlert[] {
  const unknown = Object.keys(query).find(key => key !== 'unread');
  if (unknown) invalidArgs(`Unknown query parameter ${unknown}. Allowed: unread`, unknown);
  if (query.unread !== undefined && !['true', 'false'].includes(query.unread)) invalidArgs('unread must be true or false', 'unread');
  return alertRows(ctx, { unread: query.unread === 'true' }).reverse().map(toOwnerAlert);
}

/** POST /hub/alerts/read: `{ids:[…]}` or `{all:true}`. */
export function markAlertsRead(ctx: Context, { body }: Input) {
  const extra = Object.keys(body).find(key => key !== 'ids' && key !== 'all');
  if (extra) invalidArgs(`Unknown field ${extra}. Allowed: ids, all`, extra);
  const all = body.all === true;
  if (body.all !== undefined && typeof body.all !== 'boolean') invalidArgs('all must be a boolean', 'all');
  const ids = body.ids === undefined ? undefined
    : Array.isArray(body.ids) && body.ids.length <= 500 && body.ids.every(id => typeof id === 'string' && id) ? new Set(body.ids as string[])
      : invalidArgs('ids must be an array of at most 500 alert ids', 'ids');
  if (all === !!ids) invalidArgs('Send either ids or all:true', ids ? 'all' : 'ids');
  if (ids) {
    const known = new Set(ctx.list(ALERT_KIND).map(row => row.id));
    const missing = [...ids].find(id => !known.has(id));
    if (missing) invalidArgs(`Unknown alert id ${missing}`, 'ids');
  }
  let updated = 0;
  for (const row of ctx.list(ALERT_KIND)) {
    if (row.read_at != null || (ids && !ids.has(row.id))) continue;
    ctx.update(ALERT_KIND, row.id, { read_at: ctx.now });
    updated++;
  }
  if (updated) ctx.emit('alerts.owner_alert.read', { count: updated });
  return { updated, unread: unreadAlerts(ctx) };
}

export const operations: Operation[] = [
  { method: 'GET', path: '/views/alerts', name: 'views_alerts', roles: READ, summary: 'List owner alerts (machine, account and post links), newest first',
    contract: { query: ['unread'] }, run: viewAlerts },
  { method: 'GET', path: '/hub/alerts/channels', name: 'hub_alerts_get_channels', roles: ADMIN,
    summary: 'Read phone push channels (ntfy, Bark, Telegram) and which optional alerts are on; tokens are never returned, and for an Agent the Bark key and ntfy topic in the URL are masked (E46)', run: getChannels },
  { method: 'PUT', path: '/hub/alerts/channels', name: 'hub_alerts_update_channels', roles: ADMIN,
    summary: 'Replace phone push channels and optional alert preferences (human only)', run: updateChannels },
  { method: 'POST', path: '/hub/alerts/test', name: 'hub_alerts_test', roles: ADMIN, accepted: true,
    summary: 'Queue one test push to every enabled channel; the result appears in hub_alerts_get_channels (human only)', run: queueTest },
  { method: 'POST', path: '/hub/alerts/read', name: 'hub_alerts_read', roles: READ, summary: 'Mark owner alerts as read', run: markAlertsRead },
];

export const schedules = [alertReminderSchedule];
export const subscribers = [alertTriggerSubscriber];
