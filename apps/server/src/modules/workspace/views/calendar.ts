import { ADMIN, READ, type Context, type EffectiveMode, type Input, type Operation, type PostStatus, type RouteKind, type Row } from '@smartsell/contracts';
import { excerpt, caption, isHubProvider } from './hub-model.js';
import { postSummaryOf } from './posts.js';
import { operations as adsOperations } from '../../ads/workspace-operations.js';
import { addDays, dayStart, localDay } from '../../analytics/shared.js';
import { COMMERCE_WRITE } from '../../commerce/store-operations.js';
import { workspace } from '../brands.js';
import { brandScope, invalid, timezone } from '../shared.js';
import { canReadTask } from '../tasks.js';

// Read-model for the agent-first web view. Contract: docs/agent-first-design.md 3.4.

export interface ViewPeriod { from: string; to: string; tz: string; days: string[]; start: number; end: number }
const isDate = (value: string) => /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function dateParam(value: string | undefined, key: string) {
  if (value !== undefined && !isDate(value)) invalid(`Invalid ${key}`);
  return value;
}
/** Inclusive local-date period; `start`/`end` are the instants bounding it in `tz` (end exclusive). */
export function viewPeriod(ctx: Context, query: Record<string, string | undefined>, fallbackDays: number, fixedZone?: string): ViewPeriod {
  const tz = fixedZone ?? (query.tz === undefined ? String(workspace(ctx).default_timezone || 'UTC') : timezone(query.tz));
  let from = dateParam(query.from, 'from'), to = dateParam(query.to, 'to');
  to ??= from ? addDays(from, fallbackDays - 1) : localDay(ctx.now, tz);
  from ??= addDays(to, 1 - fallbackDays);
  if (from > to) invalid('from must not follow to');
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (days.length === 366) invalid('A period can span at most 366 days');
    days.push(day);
  }
  return { from, to, tz, days, start: dayStart(from, tz), end: dayStart(addDays(to, 1), tz) };
}
/** The equally long period immediately before `period`. */
export function previousPeriod(period: ViewPeriod): ViewPeriod {
  const n = period.days.length;
  const from = addDays(period.from, -n), to = addDays(period.from, -1);
  return { from, to, tz: period.tz, days: period.days.map(day => addDays(day, -n)), start: dayStart(from, period.tz), end: period.start };
}
export function campaignScope(ctx: Context, brand: string | undefined, campaignId: string | undefined) {
  if (campaignId === undefined) return undefined;
  const campaign = ctx.get('campaign', campaignId);
  if (brand !== undefined && campaign.brand_id !== brand) invalid('Campaign does not belong to the selected brand');
  return campaign;
}
/** Advertising rows visible to the caller under the ads module's own account grants. */
export function adsReadScope(ctx: Context, input: Input): Context {
  const scope = adsOperations.find(op => op.name === 'ads_list_accounts')?.scopeContext;
  return scope ? scope(ctx, input) : ctx;
}
export const platformName = (value: unknown) => {
  const name = typeof value === 'string' && value ? value : null;
  return name === 'meta_instagram' ? 'instagram' : name === 'meta_facebook' ? 'facebook' : name;
};
export const text = (value: unknown) => typeof value === 'string' && value ? value : null;
const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const iso = (at: number) => new Date(at).toISOString();
const byId = (rows: Row[]) => new Map(rows.map(row => [row.id, row]));

export const calendarKinds = ['publish', 'post', 'plan', 'milestone', 'production_due', 'deliverable_due', 'live', 'ad_flight', 'promotion'] as const;
export type CalendarKind = typeof calendarKinds[number];
type NeedsHuman = 'approval' | 'late_decision' | 'outcome_unknown' | 'needs_owner' | 'missed' | null;
export interface CalendarEvent {
  id: string; kind: CalendarKind; starts_at: string; ends_at: string | null; all_day: boolean; title: string; status: string | null;
  platform: string | null; brand_id: string | null; campaign_id: string | null; social_account_id: string | null;
  resource: { type: string; id: string }; needs_human: NeedsHuman; permalink: string | null;
  /** Phase 1 publish events on hub channels (§9.7): the same post status, route and links as the post page. */
  post_id?: string; post_status?: PostStatus; channel?: { id: string; provider: string; handle: string | null };
  machine?: { id: string; name: string; online: boolean } | null; route_kind?: RouteKind; mode?: EffectiveMode; url?: string | null;
}
export interface CalendarOptions { period: ViewPeriod; kinds?: readonly CalendarKind[]; brand_id?: string; campaign_id?: string; input?: Input }

const FINAL_TARGET = ['cancelled', 'superseded'];
const PUBLISH_TASK_OPERATIONS = new Set(['publish', 'publish_story', 'publish_short', 'publish_schedule']);
const CLOSED_AS: Record<string, string> = { matched_native: 'published', manual_done: 'published', published: 'published', expired_skipped: 'expired', failed_final: 'failed' };
const OPEN_APPROVAL = ['pending', 'open', 'in_progress', 'requested', 'submitted'];
// Mirrors the planning module's display status so the calendar shows the same state as the publish target page.
function displayStatus(target: Row, task: Row | undefined, unresolved: boolean) {
  if (target.plan_status === 'cancel_requested') return 'cancel_requested';
  const sideEffects = Array.isArray(task?.pending_side_effects) && task.pending_side_effects.length > 0;
  if (task?.status === 'outcome_unknown' || unresolved || sideEffects && task?.status === 'manual') return 'outcome_unknown';
  if (target.plan_status === 'closed') return CLOSED_AS[String(target.close_reason)] ?? text(task?.status) ?? text(target.close_reason) ?? 'closed';
  if (target.plan_status === 'ready') return ['queued', 'running', 'accepted'].includes(String(task?.status)) ? 'executing' : text(task?.status) ?? 'scheduled';
  return text(target.plan_status);
}
function promotionState(row: Row, now: string) {
  if (['draft', 'cancelled'].includes(String(row.state))) return String(row.state);
  return now < String(row.valid_from) ? 'scheduled' : now >= String(row.valid_until) ? 'expired' : 'active';
}

export function sourceAvailability(ctx: Context, kind: CalendarKind, input: Input): 'available' | 'no_permission' {
  if (kind === 'promotion') return COMMERCE_WRITE.some(role => role === ctx.role) ? 'available' : 'no_permission';
  if (kind === 'ad_flight' && !ADMIN.includes(ctx.role)) {
    return ctx.list('ad_account').length > 0 && adsReadScope(ctx, input).list('ad_account').length === 0 ? 'no_permission' : 'available';
  }
  return 'available';
}

/** Every dated item in the workspace as one calendar event stream. Exported for the home view. */
export function calendarEvents(ctx: Context, options: CalendarOptions): CalendarEvent[] {
  const { period } = options;
  const input = options.input ?? { body: {}, params: {}, query: {} };
  const wanted = new Set((options.kinds ?? calendarKinds).filter(kind => sourceAvailability(ctx, kind, input) === 'available'));
  const want = (kind: CalendarKind) => wanted.has(kind);
  const brandOk = (value: unknown) => options.brand_id === undefined || value === options.brand_id;
  const campaignOk = (value: unknown) => options.campaign_id === undefined || value === options.campaign_id;
  const inRange = (start: number, end?: number) => Number.isFinite(start) && (Number.isFinite(end) && end! > start
    ? start < period.end && end! > period.start : start >= period.start && start < period.end);
  const events: CalendarEvent[] = [];
  const add = (kind: CalendarKind, type: string, id: string, start: number, values: Partial<CalendarEvent> & { title: string }, end?: number) => {
    if (!inRange(start, end)) return;
    events.push({ id: `${kind}:${id}`, kind, starts_at: iso(start), ends_at: Number.isFinite(end) && end! > start ? iso(end!) : null, all_day: false,
      status: null, platform: null, brand_id: null, campaign_id: null, social_account_id: null, needs_human: null, permalink: null,
      ...values, resource: { type, id } });
  };
  const accounts = byId(ctx.list('social_account'));
  const targets = byId(ctx.list('publish_target'));
  const items = byId(ctx.list('content_item'));
  const shownTargets = new Set<string>();

  if (want('publish') || want('post')) {
    const posts = ctx.list('platform_post');
    if (want('publish')) {
      const tasks = ctx.list('execution_task');
      const taskById = byId(tasks);
      const tasksByTarget = new Map<unknown, Row>();
      for (const task of tasks) {
        if (task.operation && !PUBLISH_TASK_OPERATIONS.has(String(task.operation))) continue;
        if (!tasksByTarget.has(task.publish_target_id)) tasksByTarget.set(task.publish_target_id, task);
      }
      const unresolved = new Set(ctx.list('execution_attempt').filter(row => row.status === 'unknown' && row.side_effect_possible !== false)
        .map(row => row.task_id ?? row.execution_task_id));
      const approvals = byId(ctx.list('approval_request'));
      const postByTarget = new Map<unknown, Row>();
      for (const post of posts) {
        if (!post.publish_target_id) continue;
        const verified = ['system_verified', 'manual_confirmed'].includes(String(post.verification));
        if (verified || !postByTarget.has(post.publish_target_id)) postByTarget.set(post.publish_target_id, post);
      }
      for (const target of targets.values()) {
        if (FINAL_TARGET.includes(String(target.plan_status)) || !brandOk(target.brand_id) || !campaignOk(target.campaign_id)) continue;
        const manualDate = target.scheduled_at == null && typeof target.local_scheduled_at === 'string' && isDate(target.local_scheduled_at);
        const post = postByTarget.get(target.id);
        const start = manualDate ? dayStart(String(target.local_scheduled_at), String(target.schedule_tz || period.tz)) : time(target.scheduled_at ?? post?.published_at);
        if (!inRange(start)) continue;
        const linked = taskById.get(String(target.execution_task_id));
        const task = linked && linked.publish_target_id === target.id && (!linked.operation || PUBLISH_TASK_OPERATIONS.has(String(linked.operation))) ? linked : tasksByTarget.get(target.id);
        const status = displayStatus(target, task, !!task && unresolved.has(task.id));
        const late = task && [task.sub_status, task.substatus].includes('late_awaiting_decision');
        const approval = target.plan_status === 'awaiting_approval' && OPEN_APPROVAL.includes(String(approvals.get(String(target.approval_request_id))?.status));
        const account = accounts.get(String(target.social_account_id));
        shownTargets.add(target.id);
        if (isHubProvider(account?.provider) && ctx.list('channel_settings').some(row => row.social_account_id === account!.id)) {
          // Phase 1 posts (hub channels with channel_settings, §3.3): one derivation for status and route (§9.7); the title names
          // the account and the caption (H05). Older accounts without channel settings keep the legacy event below.
          const post = postSummaryOf(ctx, target);
          const words = excerpt(caption(ctx, target).replace(/\s+/g, ' ').trim(), 40);
          add('publish', 'publish_target', target.id, start, {
            all_day: manualDate, title: `${post.channel.label}${words ? ` · ${words}` : ''}`, status: post.status, platform: platformName(account?.provider),
            brand_id: text(target.brand_id), campaign_id: text(target.campaign_id), social_account_id: text(target.social_account_id), permalink: post.url,
            needs_human: post.status === 'awaiting_approval' ? 'approval' : post.status === 'unknown' ? 'outcome_unknown' : post.status === 'needs_owner' ? 'needs_owner'
              : post.status === 'missed' ? 'missed' : null,
            post_id: post.post_id, post_status: post.status, channel: { id: post.channel.id, provider: post.channel.provider, handle: post.channel.handle },
            machine: post.machine ? { id: post.machine.id, name: post.machine.name, online: post.machine.online } : null,
            route_kind: post.route_kind, mode: post.mode, url: post.url,
          });
          continue;
        }
        add('publish', 'publish_target', target.id, start, {
          all_day: manualDate, title: text(target.title) ?? text(items.get(String(target.content_item_id))?.title) ?? text(account?.display_name) ?? 'Publication',
          status, platform: platformName(account?.platform ?? account?.provider), brand_id: text(target.brand_id), campaign_id: text(target.campaign_id),
          social_account_id: text(target.social_account_id), permalink: text(post?.permalink),
          needs_human: status === 'outcome_unknown' ? 'outcome_unknown' : late ? 'late_decision' : approval ? 'approval' : null,
        });
      }
    }
    if (want('post')) for (const post of posts) {
      if (post.publish_target_id && shownTargets.has(String(post.publish_target_id))) continue;
      const target = targets.get(String(post.publish_target_id));
      const account = accounts.get(String(post.social_account_id));
      const brand = post.brand_id ?? target?.brand_id ?? account?.brand_id;
      const campaign = post.campaign_id ?? target?.campaign_id;
      if (!brandOk(brand) || !campaignOk(campaign)) continue;
      const caption = text(post.caption) ?? text(post.text);
      add('post', 'platform_post', post.id, time(post.published_at), {
        title: text(post.title) ?? text(target?.title) ?? text(items.get(String(post.content_item_id ?? target?.content_item_id))?.title)
          ?? (caption && caption.slice(0, 80)) ?? text(account?.display_name) ?? text(account?.handle) ?? 'Post',
        status: text(post.post_status) ?? 'published', platform: platformName(post.platform ?? post.provider ?? account?.provider),
        brand_id: text(brand), campaign_id: text(campaign), social_account_id: text(post.social_account_id), permalink: text(post.permalink),
      });
    }
  }
  if (want('plan')) for (const campaign of ctx.list('campaign')) {
    if (!brandOk(campaign.brand_id) || !campaignOk(campaign.id) || campaign.status === 'cancelled') continue;
    add('plan', 'campaign', campaign.id, time(campaign.starts_at), { all_day: true, title: text(campaign.name) ?? 'Campaign',
      status: text(campaign.status), brand_id: text(campaign.brand_id), campaign_id: campaign.id }, time(campaign.ends_at));
  }
  if (want('milestone') || want('production_due')) for (const task of ctx.list('work_item')) {
    const type = task.type ?? task.kind;
    const milestone = type === 'milestone' || task.kind === 'campaign_milestone';
    if (!(milestone ? want('milestone') : want('production_due') && type === 'production_task' && !['done', 'cancelled'].includes(String(task.status)))) continue;
    const item = items.get(String(task.content_item_id ?? (task.subject_ref as { id?: unknown } | undefined)?.id));
    const brand = task.brand_id ?? item?.brand_id, campaign = task.campaign_id ?? item?.campaign_id;
    if (!canReadTask(ctx, task) || !brandOk(brand) || !campaignOk(campaign)) continue;
    add(milestone ? 'milestone' : 'production_due', 'work_item', task.id, time(task.due_at), { title: text(task.title) ?? (milestone ? 'Milestone' : 'Production task'),
      status: text(task.status), brand_id: text(brand), campaign_id: text(campaign) });
  }
  if (want('production_due')) for (const item of items.values()) {
    if (item.archived_at || item.production_stage === 'archived' || !brandOk(item.brand_id) || !campaignOk(item.campaign_id)) continue;
    add('production_due', 'content_item', item.id, time(item.production_due_at), { title: text(item.title) ?? 'Content', status: text(item.production_stage),
      brand_id: text(item.brand_id), campaign_id: text(item.campaign_id) });
  }
  if (want('deliverable_due') || want('live')) {
    const collaborations = byId(ctx.list('collaboration'));
    const creators = byId(ctx.list('creator'));
    const creatorName = (collaboration?: Row) => text(creators.get(String(collaboration?.creator_id))?.display_name);
    if (want('deliverable_due')) for (const row of ctx.list('deliverable')) {
      const collaboration = collaborations.get(String(row.collaboration_id));
      if (row.status === 'cancelled' || !brandOk(collaboration?.brand_id) || !campaignOk(collaboration?.campaign_id)) continue;
      const name = creatorName(collaboration);
      add('deliverable_due', 'deliverable', row.id, time(row.due_at), { title: [name, text(row.kind)].filter(Boolean).join(' · ') || 'Creator deliverable',
        status: text(row.status), platform: platformName(row.platform), brand_id: text(collaboration?.brand_id), campaign_id: text(collaboration?.campaign_id),
        needs_human: row.status === 'submitted' ? 'approval' : null });
    }
    if (want('live')) for (const row of ctx.list('live_session')) {
      const collaboration = collaborations.get(String(row.collaboration_id));
      const campaign = row.campaign_id ?? collaboration?.campaign_id;
      if (row.status === 'cancelled' || !brandOk(collaboration?.brand_id) || !campaignOk(campaign)) continue;
      add('live', 'live_session', row.id, time(row.scheduled_at), { title: creatorName(collaboration) ?? 'Live session', status: text(row.status),
        platform: platformName(row.platform), brand_id: text(collaboration?.brand_id), campaign_id: text(campaign) });
    }
  }
  if (want('ad_flight')) {
    const scoped = adsReadScope(ctx, input);
    const adAccounts = byId(scoped.list('ad_account'));
    const revisions = byId(ctx.list('ad_proposal_revision'));
    for (const proposal of scoped.list('ad_proposal')) {
      if (proposal.status === 'rejected' || !brandOk(proposal.brand_id) || !campaignOk(proposal.campaign_id)) continue;
      const schedule = revisions.get(String(proposal.current_revision_id))?.schedule as { starts_at?: unknown; ends_at?: unknown } | undefined;
      add('ad_flight', 'ad_proposal', proposal.id, time(schedule?.starts_at), { title: text(proposal.name) ?? 'Ad proposal', status: text(proposal.status),
        platform: text(adAccounts.get(String(proposal.ad_account_id))?.provider), brand_id: text(proposal.brand_id), campaign_id: text(proposal.campaign_id),
        needs_human: proposal.status === 'in_review' ? 'approval' : null }, time(schedule?.ends_at));
    }
  }
  if (want('promotion')) {
    const stores = byId(ctx.list('store'));
    const campaigns = byId(ctx.list('campaign'));
    for (const row of ctx.list('promotion')) {
      const brand = stores.get(String(row.store_id))?.brand_id ?? campaigns.get(String(row.campaign_id))?.brand_id;
      if (!brandOk(brand) || !campaignOk(row.campaign_id)) continue;
      add('promotion', 'promotion', row.id, time(row.valid_from), { title: text(row.name) ?? 'Promotion', status: promotionState(row, ctx.now),
        brand_id: text(brand), campaign_id: text(row.campaign_id) }, time(row.valid_until));
    }
  }
  return events.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || calendarKinds.indexOf(a.kind) - calendarKinds.indexOf(b.kind) || a.id.localeCompare(b.id));
}

export function calendarView(ctx: Context, input: Input) {
  const { query } = input;
  const period = viewPeriod(ctx, query, 7);
  const brand = brandScope(ctx, query.brand_id);
  const campaign = campaignScope(ctx, brand, query.campaign_id);
  const kinds = query.kinds === undefined ? [...calendarKinds] : [...new Set(query.kinds.split(',').map(kind => kind.trim()).filter(Boolean))].map(kind =>
    (calendarKinds as readonly string[]).includes(kind) ? kind as CalendarKind : invalid(`Unknown calendar kind ${kind}`));
  const events = calendarEvents(ctx, { period, kinds, brand_id: brand, campaign_id: campaign?.id, input });
  return { range: { from: period.from, to: period.to, tz: period.tz }, events,
    sources: kinds.map(kind => ({ kind, availability: sourceAvailability(ctx, kind, input) })), as_of: ctx.now };
}

export const calendarViewOperations: Operation[] = [
  { method: 'GET', path: '/views/calendar', name: 'views_calendar', roles: READ, summary: 'Read every dated plan, publication, deadline, flight and promotion as calendar events',
    contract: { query: ['from', 'to', 'tz', 'brand_id', 'kinds', 'campaign_id'] }, run: calendarView },
];
