import type { Schedule, Subscriber } from '../operations.js';
import { prepareScheduledReports } from '../modules/analytics/reports.js';
import { canReadReportNotice, notify, type NotificationContext } from '../modules/workspace/notifications.js';

export const reportSchedule: Schedule = { id: 'analytics.reports', run: prepareScheduledReports };

export const reportSubscriber: Subscriber = {
  id: 'analytics.report-subscriptions',
  accepts: type => type === 'analytics.report_version.finalized',
  run(ctx, event) {
    const { report_id, version_id } = (event.data ?? {}) as Record<string, unknown>;
    if (typeof report_id !== 'string' || typeof version_id !== 'string') return;
    const { notificationRecipient } = ctx as NotificationContext;
    for (const row of ctx.list('subscription')) {
      if (row.resource_type !== 'report' || row.resource_id !== report_id || row.muted || row.active === false || typeof row.user_id !== 'string') continue;
      const recipient = notificationRecipient?.(row.user_id, 'reports_get');
      if (!recipient || !canReadReportNotice(recipient, report_id, version_id)) continue;
      notify(ctx, row.user_id, 'report_finalized', 'A subscribed report is ready', {
        resource_type: 'report', resource_id: report_id, report_version_id: version_id, dedupe_key: `report:${version_id}`,
      });
    }
  },
};
