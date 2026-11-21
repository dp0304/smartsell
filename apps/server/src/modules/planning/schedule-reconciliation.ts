import { Problem, type Context } from '@smartsell/contracts';
import { entries, locate, object } from '../../../../../packages/domain/src/publishing/index.js';
import { connectionContext, type AccountServices } from '../account/oauth.js';

export const platformScheduleOperation = 'publishing_reconcile_platform_schedule';
const capability = 'scheduled_post_read';
type Schedule = { external_schedule_id: string; social_account_id: string; platform_scheduled_at: string; caption: string };

/** Read one page from the connected Page. Provider schedule IDs never become platform_post records here. */
export async function readPlatformSchedule(ctx: Context, accountId: string, cursor?: string) {
  const account = ctx.get('social_account', accountId);
  if (account.provider !== 'meta_facebook') {
    throw new Problem(422, 'PLATFORM_SCHEDULE_UNSUPPORTED', 'Scheduled post reconciliation is available for Facebook Pages.');
  }
  if (cursor != null && (!cursor || cursor.length > 2048)) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid schedule cursor.');
  const services = (ctx as Context & { planningAccountServices?: AccountServices }).planningAccountServices;
  const links = ctx.list('social_account_connection').filter(link => link.social_account_id === account.id && link.status === 'active' && !link.revoked_at);
  for (const link of links) {
    const connection = locate(ctx, 'connection', link.connection_id);
    if (!services || account.status !== 'active' || typeof account.external_account_id !== 'string' || !connection || connection.revoked_at ||
        connection.provider !== account.provider || connection.brand_id !== account.brand_id || connection.purpose !== 'social') continue;
    const adapter = services.adapter?.('meta_facebook', connection.platform_app_id as string | undefined);
    if (!adapter || !Array.isArray(connection.scopes) || !['pages_manage_posts', 'pages_read_engagement'].every(scope => (connection.scopes as string[]).includes(scope))) continue;
    let auth;
    try { auth = connectionContext(ctx, connection, services, account.external_account_id); }
    catch (error) { if (error instanceof Problem) continue; throw error; }
    try {
      for await (const page of adapter.sync(capability, cursor ?? null, auth)) {
        const scheduled = new Map<string, Schedule>();
        for (const item of entries(page.items)) {
          const external_schedule_id = item.id;
          const rawTime = item.scheduled_publish_time;
          const at = typeof rawTime === 'number' || typeof rawTime === 'string' && /^\d+$/.test(rawTime) ? Number(rawTime) * 1000 : Date.parse(String(rawTime));
          if (typeof external_schedule_id !== 'string' || !/^\d+(?:_\d+)?$/.test(external_schedule_id) || item.is_published !== false ||
              object(item.from).id !== account.external_account_id || !Number.isFinite(at) || at <= 0 || at > 8.64e15) continue;
          scheduled.set(external_schedule_id, { external_schedule_id, social_account_id: account.id,
            platform_scheduled_at: new Date(at).toISOString(), caption: typeof item.message === 'string' ? item.message : '' });
        }
        return { entries: [...scheduled.values()], next_cursor: page.nextCursor };
      }
    } catch {
      throw new Problem(502, 'PLATFORM_SCHEDULE_READ_FAILED', 'Facebook did not return the authorized schedule page.');
    }
  }
  throw new Problem(409, 'PLATFORM_SCHEDULE_AUTHORIZATION_REQUIRED', 'Connect the Facebook Page with permission to read scheduled posts.');
}
