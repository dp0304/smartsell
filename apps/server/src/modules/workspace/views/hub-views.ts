import { READ, type Context, type Input, type MediaRecentItem, type Operation } from '@smartsell/contracts';
import { locate } from '../../../../../../packages/domain/src/publishing/index.js';
import { channelDetail, channelSummaries } from './channels.js';
import { strictQuery, invalidQuery, str } from './hub-model.js';
import { machineDetail, machineSummaries } from './machines.js';
import { jobDetail, listPosts, postDetail, postsQuery } from './posts.js';
import { buildOverview, buildToday, todayQuery } from './today.js';

/**
 * Phase 1 read models behind the owner dashboard (phase1-design §9.7). Unknown query parameters answer 422 (the runner strips
 * `cursor`, and `limit` unless the operation sets ownsLimit, E22). views_alerts is S10's (modules/alerts).
 */

/** §9.7 views_media_recent: the newest owned assets for the dry-run picker. */
export function mediaRecent(ctx: Context): MediaRecentItem[] {
  return ctx.list('asset').filter(row => row.ownership === 'owned' && ['video', 'image'].includes(String(row.kind)) && !row.archived_at && row.status !== 'archived')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20).map(asset => {
      const version = locate(ctx, 'asset_version', asset.current_version_id) ?? ctx.list('asset_version').find(row => row.asset_id === asset.id);
      const file = locate(ctx, 'file_object', version?.file_object_id);
      const session = ctx.list('media_upload_session').filter(row => row.media_id === asset.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      const status = (['ready', 'processing', 'uploading', 'failed'] as const).find(value => value === asset.status) ?? (file ? 'ready' : 'processing');
      return { media_id: asset.id, filename: str(file?.original_filename) ?? str(session?.filename) ?? str(asset.title) ?? asset.id, kind: asset.kind === 'image' ? 'image' : 'video',
        bytes: Number(file?.size_bytes ?? session?.bytes ?? 0) || 0, status, thumbnail_url: null, created_at: String(asset.created_at) };
    });
}

const PROVIDERS = ['x', 'tiktok', 'youtube', 'meta_instagram', 'meta_facebook'];
function channelFilter(query: Record<string, string | undefined>) {
  strictQuery(query, ['provider', 'machine_id']);
  if (query.provider !== undefined && !PROVIDERS.includes(query.provider)) invalidQuery('provider', `provider must be one of ${PROVIDERS.join(', ')}`);
  return { provider: query.provider, machine_id: query.machine_id };
}
function bool(query: Record<string, string | undefined>, key: string) {
  const value = query[key];
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') invalidQuery(key, `${key} must be true or false`);
  return value === 'true';
}
const none = ({ query }: Input) => strictQuery(query, []);

export const hubViewOperations: Operation[] = [
  { method: 'GET', path: '/views/overview', name: 'views_overview', roles: READ, summary: 'Read the workspace time zone, machines, channels, today counts and what waits for the owner',
    contract: { query: [] }, run: (ctx, input) => { none(input); return buildOverview(ctx); } },
  { method: 'GET', path: '/views/today', name: 'views_today', roles: READ, summary: 'Read Today: what needs the owner, the next 48 hours by content, machines and recent posts',
    contract: { query: ['tz'] }, run: (ctx, { query }) => buildToday(ctx, todayQuery(query)) },
  { method: 'GET', path: '/views/machines', name: 'views_machines_list', roles: READ, summary: 'List paired machines with online state, queue, warnings and channels',
    contract: { query: ['include_offline'] }, run: (ctx, { query }) => {
      strictQuery(query, ['include_offline']);
      return machineSummaries(ctx, { includeOffline: bool(query, 'include_offline') });
    } },
  { method: 'GET', path: '/views/machines/:id', name: 'views_machine_get', roles: READ, summary: 'Read one machine: settings warnings, channels, queue, history and drivers',
    contract: { query: [] }, run: (ctx, input) => { none(input); return machineDetail(ctx, input.params.id!); } },
  { method: 'GET', path: '/views/channels', name: 'views_channels_list', roles: READ, summary: 'List channels with machine, login, mode, approval, limits and readiness',
    contract: { query: ['provider', 'machine_id'] }, run: (ctx, { query }) => channelSummaries(ctx, channelFilter(query)) },
  { method: 'GET', path: '/views/channels/:id', name: 'views_channel_get', roles: READ, summary: 'Read one channel: readiness, settings, risk terms, checks, dry runs and posts',
    contract: { query: [] }, run: (ctx, input) => { none(input); return channelDetail(ctx, input.params.id!); } },
  { method: 'GET', path: '/views/posts', name: 'views_posts_list', roles: READ, summary: 'List posts by local date, status, channel or machine',
    contract: { query: ['from', 'to', 'status', 'channel_id', 'machine_id', 'limit'] },
    // E22: the result is an object, so the runner passes `limit` through (ownsLimit); without one the page reads up to 200 rows.
    ownsLimit: true, run: (ctx, { query }) => listPosts(ctx, { limit: 200, ...postsQuery(query) }) },
  { method: 'GET', path: '/views/posts/:id', name: 'views_post_get', roles: READ, summary: 'Read one post: content, media, channel and machine, approval, timeline, result and owner actions',
    contract: { query: [] }, run: (ctx, input) => { none(input); return postDetail(ctx, input.params.id!); } },
  { method: 'GET', path: '/views/jobs/:id', name: 'views_job_get', roles: READ, summary: 'Read one Worker job with its timeline',
    contract: { query: [] }, run: (ctx, input) => { none(input); return jobDetail(ctx, input.params.id!); } },
  { method: 'GET', path: '/views/media/recent', name: 'views_media_recent', roles: READ, summary: 'List the 20 newest owned media for the dry-run picker',
    contract: { query: [] }, run: (ctx, input) => { none(input); return mediaRecent(ctx); } },
];
