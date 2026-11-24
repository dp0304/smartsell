import type { Context } from '@smartsell/contracts';
import { localMinute, locate, time } from '../../../../../../packages/domain/src/publishing/index.js';
import { workspaceZone } from './hub-model.js';

/**
 * Every web_url the hub hands out (phase1-design §9.6): PUBLIC_ORIGIN + /app/<ws> + the route of routes.tsx. One builder so
 * MCP results, owner alerts and the dashboard link to the same pages. There is no media page in phase 1.
 */
export const WEB_URL_KINDS = ['post', 'machine', 'channel', 'today', 'calendar', 'notifications', 'alerts', 'channels', 'machines', 'setup'] as const;
export type WebUrlKind = typeof WEB_URL_KINDS[number];

let origin: string | undefined;
/** The hub's public origin (config.origin). Called once at bootstrap; tests may call it again. */
export function configureViewLinks(options: { publicOrigin?: string }) {
  origin = options.publicOrigin?.replace(/\/+$/, '') || undefined;
}
export function viewOrigin() {
  return (origin ?? process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3401}`).replace(/\/+$/, '');
}

/** Monday of the week that holds `at` in `zone` (calendar `week=`; readCalendarParams ignores `date`). */
export function weekOf(at: string, zone: string): string {
  const day = localMinute(at, zone).slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  return new Date(date.getTime() - (weekday - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** The path under /app/<ws> for a link kind (exported for the route test). */
export function webPath(kind: WebUrlKind, id?: string, week?: string): string {
  const segment = id ? encodeURIComponent(id) : '';
  switch (kind) {
    case 'post': return `/posts/${segment}`;
    case 'machine': return `/machines/${segment}`;
    case 'channel': return `/channels/${segment}`;
    case 'machines': return '/machines';
    case 'channels': return '/channels';
    // S10 uses 'notifications' for the push settings page; 'alerts' is the list behind the bell.
    case 'notifications': return '/settings/notifications';
    case 'alerts': return '/notifications';
    case 'setup': return '/get-started';
    case 'calendar': return `/calendar?view=week${week ? `&week=${week}` : ''}${id ? `&event=publish:${segment}` : ''}`;
    case 'today': default: return '';
  }
}

/** C7 webUrl(ctx, kind, id): an absolute link to a dashboard page. A calendar link with a post id opens that post's week. */
export function webUrl(ctx: Context, kind: WebUrlKind, id?: string): string {
  const base = `${viewOrigin()}/app/${encodeURIComponent(ctx.workspaceId)}`;
  if (kind !== 'calendar') return `${base}${webPath(kind, id)}`;
  const target = id ? locate(ctx, 'publish_target', id) : undefined;
  const at = typeof target?.scheduled_at === 'string' && Number.isFinite(time(target.scheduled_at)) ? target.scheduled_at : ctx.now;
  return `${base}${webPath('calendar', id, weekOf(at, workspaceZone(ctx)))}`;
}
