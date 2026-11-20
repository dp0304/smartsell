import { Problem, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { haltSources, policy } from '../account/auto-control.js';
import { workspace } from './brands.js';
import { listNotifications, subscriptions } from './notifications.js';
import { brandScope, inBrand, instant, invalid, isManager, limit, open, str, timestamp } from './shared.js';
import { canFollow, type WorkspaceReadContext } from './search.js';

const severityOrder = { blocker: 0, high: 1, normal: 2, info: 3 };
type Severity = keyof typeof severityOrder;
export interface PendingItem {
  provider: string; kind: string; severity: Severity; title: string;
  resource: { type: string; id: string }; brand_id?: unknown; owner?: unknown; due_at?: unknown;
  impact?: number; source_updated_at: string; action: { label: string; route: string }; sources?: string[];
  terms_renewal?: { social_account_id: string; limits: Data };
}
interface PendingResult { items: PendingItem[]; total: number; as_of: string }
export interface PendingItemProvider {
  key: string;
  list(ctx: WorkspaceReadContext, options: { brand_id?: string; limit: number }): PendingResult | Promise<PendingResult>;
}
export interface WorkspaceOverviewContext extends WorkspaceReadContext {
  workspacePendingProviders?: readonly PendingItemProvider[];
  workspaceProviderAvailable?(provider: string): boolean;
}
const find = (ctx: Context, kind: string, value: unknown) => value === undefined ? undefined : ctx.list(kind).find(row => row.id === value);
const key = (value: unknown) => typeof value === 'string' ? value : undefined;
const is = (row: Row, ...states: string[]) => states.includes(String(row.status));
const taskForMe = (ctx: Context, row: Row) => row.assignee_id === ctx.actorId && row.assignee_type === 'user';
function belongsToMe(ctx: Context, row: Row) {
  const steps = row.steps as { approvers?: { roles?: string[]; user_ids?: string[] } }[] | undefined;
  const approvers = steps?.[Number(row.current_step) - 1]?.approvers;
  if (approvers) return ['owner', 'admin', 'manager', 'reviewer'].includes(ctx.role) && !!(approvers.roles?.includes(ctx.role) || approvers.user_ids?.includes(ctx.actorId));
  return [row.assignee_user_id, row.owner_id, row.assignee_id, row.reviewer_user_id, row.reviewer_id, row.approver_id].includes(ctx.actorId)
    || (Array.isArray(row.approver_ids) && row.approver_ids.includes(ctx.actorId));
}
function pending(provider: string, kind: string, type: string, path: string, row: Row, severity: Severity, title: string, extra: Partial<PendingItem> = {}): PendingItem {
  return { provider, kind, severity, title, resource: { type, id: row.id }, brand_id: row.brand_id,
    owner: row.assignee_id ?? row.owner_id ?? row.assignee_user_id, due_at: row.due_at ?? row.scheduled_at,
    source_updated_at: row.updated_at, action: { label: 'Open', route: `${path}/${encodeURIComponent(row.id)}` }, ...extra };
}
const byPending = (a: PendingItem, b: PendingItem) => severityOrder[a.severity] - severityOrder[b.severity]
  || (timestamp(a.due_at) || Infinity) - (timestamp(b.due_at) || Infinity) || (b.impact ?? 0) - (a.impact ?? 0)
  || b.source_updated_at.localeCompare(a.source_updated_at) || a.resource.id.localeCompare(b.resource.id);

const projections: Record<string, (ctx: WorkspaceReadContext) => PendingItem[]> = {
  'workspace.work_items': ctx => ctx.list('work_item').filter(row => open(row) && taskForMe(ctx, row) && (timestamp(row.due_at) < nextDay(ctx) || row.blocked_reason === 'missing_asset'))
    .map(row => pending('workspace.work_items', row.blocked_reason === 'missing_asset' ? 'missing_asset' : 'work_due', 'work_item', '/work-items', row, timestamp(row.due_at) < timestamp(ctx.now) ? 'high' : 'normal', key(row.title) ?? 'Work item due')),
  'planning.approvals': ctx => ctx.list('approval_request').filter(row => is(row, 'pending', 'open', 'in_progress', 'requested', 'submitted') && belongsToMe(ctx, row))
    .map(row => pending('planning.approvals', 'approval', 'approval_request', '/approvals', row, 'normal', 'Approval requested', { brand_id: row.brand_id ?? find(ctx, 'publish_target', row.resource_id)?.brand_id })),
  'planning.missed': ctx => {
    const tasks = new Map(ctx.list('execution_task').map(row => [row.publish_target_id, row]));
    const end = nextDay(ctx);
    return ctx.list('publish_target').filter(row => {
      const status = String(tasks.get(row.id)?.status ?? row.plan_status ?? row.status);
      return status === 'missed' || ['scheduled', 'queued', 'ready'].includes(status) && timestamp(row.scheduled_at) < end;
    }).map(row => {
      const missed = (tasks.get(row.id)?.status ?? row.plan_status ?? row.status) === 'missed' || timestamp(row.scheduled_at) <= timestamp(ctx.now);
      return pending('planning.missed', missed ? 'missed_publish' : 'publish_due_today', 'publish_target', '/publish-targets', row, missed ? 'high' : 'info', missed ? 'Publication missed its scheduled time' : 'Publication scheduled today');
    });
  },
  'execution.attention': ctx => ctx.list('execution_task').filter(row => is(row, 'failed', 'failed_permanent', 'failed_retryable', 'outcome_unknown', 'verifying', 'manual', 'manual_required', 'awaiting_manual', 'awaiting_user_click', 'needs_manual', 'needs_verification'))
    .map(row => pending('execution.attention', String(row.status), 'execution_task', '/execution/tasks', row, is(row, 'outcome_unknown', 'verifying', 'needs_verification') ? 'blocker' : 'high', 'Publication requires attention', { brand_id: row.brand_id ?? find(ctx, 'publish_target', row.publish_target_id)?.brand_id })),
  'account.health': ctx => {
    if (!isManager(ctx)) return [];
    const relatedBrand = (row: Row) => row.brand_id ?? find(ctx, 'social_account', row.social_account_id)?.brand_id;
    const expiredConnection = (row: Row) => is(row, 'active', 'authorized') && timestamp(row.expires_at) <= timestamp(ctx.now);
    const kinds = [
      ['connection', '/connections', (row: Row) => is(row, 'expired', 'revoked', 'reauth_required', 'reauthorization_required', 'needs_reauth') || expiredConnection(row), 'Connection authorization requires attention'],
      ['connector_device', '/devices', (row: Row) => is(row, 'offline', 'identity_mismatch') || (row.status === 'active' && timestamp(ctx.now) - timestamp(row.last_seen_at) >= 90_000), 'Connector requires attention'],
      ['mobile_device', '/mobile-devices', (row: Row) => is(row, 'offline'), 'Paired phone is offline'],
      ['mobile_app_binding', '/mobile-app-bindings', (row: Row) => is(row, 'identity_mismatch') || row.identity_status === 'identity_mismatch', 'Paired phone account identity mismatch'],
      ['account_execution_binding', '/account-execution-bindings', (row: Row) => !!row.auto_stop_reason && !find(ctx, 'account_block', row.auto_stop_block_id), 'Automatic mode requires attention'],
      ['account_block', '/account-blocks', (row: Row) => row.resolved_at == null && !is(row, 'resolved', 'closed') && ['auto_failure_streak', 'captcha', 'platform_restriction', 'identity_mismatch'].includes(String(row.kind)), 'Automatic mode blocked'],
    ] as const;
    const rows = kinds.flatMap(([type, path, filter, title]) => ctx.list(type).filter(filter).map(row => {
      const terms = type === 'account_execution_binding' && row.auto_stop_reason === 'terms_outdated';
      const socialAccount = key(row.social_account_id);
      const terms_renewal = terms && socialAccount && ['owner', 'admin'].includes(ctx.role) ? {
        social_account_id: socialAccount,
        limits: { max_per_hour: row.max_per_hour, min_interval_seconds: row.min_interval_seconds, daily_cap: row.daily_cap, allowed_windows: row.allowed_windows },
      } : undefined;
      const kind = row.auto_stop_reason ?? row.kind ?? (type === 'connection' && (expiredConnection(row) || is(row, 'reauthorization_required', 'reauth_required', 'needs_reauth')) ? 'expired' : row.status) ?? type;
      return pending('account.health', String(kind), type, path, row, 'high', terms ? 'Review the updated automatic mode terms and re-enable automatic mode' : title,
        { brand_id: relatedBrand(row), ...(terms_renewal && { terms_renewal }) });
    }));
    for (const binding of ctx.list('account_execution_binding').filter(row => row.auto_halted === true)) {
      rows.push(pending('account.health', 'account_emergency_stop', 'account_execution_binding', '/account-execution-bindings',
        binding, 'blocker', 'Account automatic mode is stopped', { brand_id: relatedBrand(binding), sources: ['account'] }));
    }
    const autoPolicy = policy(ctx);
    const sources = haltSources(ctx);
    if (!sources.length && autoPolicy?.halted === true && autoPolicy.halted_by_workspace === undefined && !Array.isArray(autoPolicy.ops_halt_rule_ids)) {
      sources.push('workspace');
    }
    if (sources.length) {
      rows.push({ provider: 'account.health', kind: 'connector_auto_halted', severity: 'blocker', title: 'Automatic mode emergency stop active',
        resource: { type: 'workspace', id: ctx.workspaceId }, sources, source_updated_at: autoPolicy?.updated_at ?? ctx.now,
        action: { label: 'Open settings', route: '/settings' } });
    }
    return rows;
  },
  'ingest.health': ctx => ctx.list('data_source').flatMap(row => {
    const latest = ctx.list('sync_run').filter(run => run.data_source_id === row.id).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.updated_at.localeCompare(a.updated_at))[0];
    const failed = latest ? is(latest, 'failed', 'partial_failure') : is(row, 'failed', 'sync_failed', 'error');
    const stale = row.freshness_status === 'stale' || is(row, 'stale', 'delayed');
    return failed || stale ? [pending('ingest.health', failed ? 'sync_failed' : 'sync_delayed', 'data_source', '/data-sources', row, 'high', failed ? 'Data synchronization failed' : 'Data synchronization is delayed', { source_updated_at: latest?.updated_at ?? row.updated_at })] : [];
  }),
  'inbox.queue': ctx => ctx.list('conversation').filter(row => is(row, 'open') && (!row.assignee_user_id || row.assignee_user_id === ctx.actorId))
    .map(row => pending('inbox.queue', row.assignee_user_id ? 'pending_reply' : 'unassigned_conversation', 'conversation', '/conversations', row, row.priority === 'urgent' ? 'high' : 'normal', row.assignee_user_id ? 'Conversation needs a reply' : 'Conversation is unassigned')),
  'commerce.risks': ctx => ctx.list('listing').filter(row => is(row, 'low_stock', 'out_of_stock') || row.stock_status === 'low_stock' || row.stock_status === 'out_of_stock')
    .map(row => pending('commerce.risks', 'inventory_risk', 'listing', '/listings', row, 'high', 'Listing inventory requires attention')),
  'campaign.risks': ctx => ctx.list('work_item').filter(row => row.type === 'milestone' && open(row) && timestamp(row.due_at) < timestamp(ctx.now))
    .map(row => pending('campaign.risks', 'milestone_delayed', 'work_item', '/work-items', row, 'high', key(row.title) ?? 'Campaign milestone delayed')),
  'creator.due': ctx => ctx.list('deliverable').filter(row => is(row, 'overdue') || (is(row, 'open', 'in_progress', 'pending') && timestamp(row.due_at) < nextDay(ctx)))
    .map(row => pending('creator.due', 'deliverable_due', 'deliverable', '/deliverables', row, timestamp(row.due_at) < timestamp(ctx.now) ? 'high' : 'normal', 'Creator deliverable due')),
};

function day(instant: number, tz: string) {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string) => values.find(value => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function nextDay(ctx: Context): number {
  const tz = String(workspace(ctx).default_timezone);
  let low = timestamp(ctx.now), high = low + 36 * 3_600_000;
  const current = day(low, tz);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (day(middle, tz) === current) low = middle; else high = middle;
  }
  return high;
}
async function timed<T>(run: () => T | Promise<T>, ms = 800): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Provider timed out')), ms); })]);
  } finally { clearTimeout(timer); }
}
export async function today(ctx: WorkspaceOverviewContext, { query }: Input) {
  const brand = brandScope(ctx, query.brand_id);
  const size = limit(query.limit);
  const providers = new Map<string, PendingItemProvider>();
  for (const [provider, project] of Object.entries(projections)) providers.set(provider, { key: provider, list: () => {
    const items = project(ctx).filter(item => (brand === undefined || item.brand_id === brand) || item.kind === 'connector_auto_halted').sort(byPending);
    return { items: items.slice(0, size), total: items.length, as_of: ctx.now };
  } });
  for (const provider of ctx.workspacePendingProviders ?? []) providers.set(provider.key, provider);
  const outcomes = await Promise.all([...providers].map(async ([provider, adapter]) => {
    try {
      if (ctx.workspaceProviderAvailable?.(provider) === false) throw Error('Provider unavailable');
      const result = await timed(() => adapter.list(ctx, { brand_id: brand, limit: size }));
      const items = result.items.filter(item => (brand === undefined || item.brand_id === brand) || item.kind === 'connector_auto_halted');
      // A provider total can be used only when its returned sample respects the requested brand scope.
      return { items, provider, availability: 'available', total: items.length === result.items.length ? result.total : items.length, as_of: result.as_of };
    } catch { return { items: [], provider, availability: 'unavailable', total: null, as_of: null }; }
  }));
  const unique = new Map<string, PendingItem>();
  for (const { items } of outcomes) for (const item of items) {
    const key = JSON.stringify([item.kind, item.resource.type, item.resource.id]);
    const previous = unique.get(key);
    unique.set(key, previous ? { ...previous, sources: [...new Set([...(previous.sources ?? []), ...(item.sources ?? [])])] } : item);
  }
  return { items: [...unique.values()].sort(byPending).slice(0, size), providers: outcomes.map(({ items, ...meta }) => meta),
    skipped_steps: ctx.list('onboarding_progress').filter(row => row.status === 'skipped').map(row => ({ step_key: row.step_key, skip_reason: row.skip_reason, check_result: row.check_result })), as_of: ctx.now };
}

export function workspaceContext(ctx: WorkspaceReadContext, { query }: Input) {
  const scope = brandScope(ctx, query.brand_id);
  const prefs = workspace(ctx);
  const brands = ctx.list('brand').filter(row => (scope === undefined || row.id === scope) && row.status !== 'archived');
  const ids = new Set(brands.map(row => row.id));
  const accounts = ctx.list('social_account').filter(row => (ids.has(String(row.brand_id)) || (scope === undefined && row.brand_id == null)) && !is(row, 'archived', 'disabled') && (ctx.canReadWorkspaceResource?.('social_account', row) ?? ctx.role !== 'agent'))
    .map(({ id, brand_id, provider, handle, display_name, status }) => ({ id, brand_id, provider, handle, display_name, status }));
  return { workspace_id: ctx.workspaceId, role: ctx.role, timezone: prefs.default_timezone, currency: prefs.reporting_currency, ui_locale: prefs.default_ui_locale,
    task_scope: query.task_scope, brands, markets: ctx.list('market').filter(row => ids.has(String(row.brand_id)) && is(row, 'active')), accounts };
}

export function personalInbox(ctx: WorkspaceReadContext, input: Input) {
  const tasks = ctx.list('work_item').filter(row => open(row) && taskForMe(ctx, row));
  const limitValue = limit(input.query.limit);
  const mentions = listNotifications(ctx, { ...input, query: { type: 'mentioned', limit: String(limitValue) } }).items;
  const approvals = projections['planning.approvals']!(ctx).filter(item => !tasks.some(row => row.resource_type === 'approval_request' && row.resource_id === item.resource.id));
  const items = [...tasks.map(row => pending('workspace.work_items', row.type === 'review_task' ? 'approval' : 'work_item', 'work_item', '/work-items', row, row.priority === 'urgent' ? 'high' : 'normal', key(row.title) ?? 'Work item')),
    ...approvals, ...mentions.map(row => pending('workspace.notifications', 'mention', 'notification', '/notifications', row, 'info', key(row.title) ?? 'Mention'))];
  return { items: items.sort(byPending).slice(0, limitValue), total: items.length, subscriptions: subscriptions(ctx).filter(row => canFollow(ctx, String(row.resource_type), String(row.resource_id))) };
}

export interface SummaryCard { subject: string; metric_keys: string[]; dimensions?: string[]; filters?: Data; period?: Data; compare_period?: Data }
const fixedCards: SummaryCard[] = [
  { subject: 'platform_post', metric_keys: ['norm.post.engagements', 'norm.post.engagement_rate'] },
  { subject: 'short_link', metric_keys: ['link.clicks_filtered'] },
];
async function analyticsOperations(): Promise<Operation[]> {
  const entry = new URL('../analytics/index.ts', import.meta.url);
  try {
    const { operations } = await import(entry.href) as { operations?: Operation[] };
    return operations ?? [];
  } catch {
    return [];
  }
}
export async function summary(ctx: Context, { query }: Input, cards = fixedCards) {
  const brand = brandScope(ctx, query.brand_id);
  const campaign = query.campaign_id === undefined ? undefined : ctx.get('campaign', str(query.campaign_id, 'campaign_id'));
  if (campaign && brand !== undefined && campaign.brand_id !== brand) invalid('Campaign does not belong to the selected brand');
  const tz = String(workspace(ctx).default_timezone);
  const now = timestamp(ctx.now);
  const from = query.from ?? day(now - 6 * 86_400_000, tz);
  const to = query.to ?? day(nextDay(ctx), tz);
  if (timestamp(instant(from, 'from')) >= timestamp(instant(to, 'to'))) invalid('from must precede to');
  const filter = { ...(brand ? { brand_ids: [brand] } : {}), ...(campaign ? { campaign_ids: [campaign.id] } : {}) };
  const analytics = await analyticsOperations();
  const metricsQuery = analytics.find(op => op.name === 'metrics_query' || op.path === '/metrics/query');
  const metricCards = await Promise.all(cards.map(async card => {
    const unavailable = (availability: string) => ({ subject: card.subject, metrics: null, unavailable: card.metric_keys.map(metric_key => ({ metric_key, value: null, availability, coverage: null, as_of: null, definition_version: null })) });
    if (!metricsQuery || !metricsQuery.roles.includes(ctx.role)) return unavailable('source_unavailable');
    const body = { metrics: card.metric_keys, subject: { type: card.subject, filter: { ...card.filters, ...filter } },
      time: { from, to, tz, ...card.period }, group_by: card.dimensions ?? [], compare: card.compare_period };
    try {
      return { subject: card.subject, metrics: await metricsQuery.run(ctx, { body, params: {}, query: {} }) };
    } catch (error) {
      if (error instanceof Problem && error.status === 422 && cards !== fixedCards) throw error;
      return unavailable('source_unavailable');
    }
  }));
  const targets = ctx.list('publish_target').filter(row => inBrand(row, brand) && (campaign === undefined || row.campaign_id === campaign.id) &&
    typeof row.scheduled_at === 'string' && day(timestamp(row.scheduled_at), tz) >= from.slice(0, 10) && day(timestamp(row.scheduled_at), tz) < to.slice(0, 10) &&
    timestamp(row.scheduled_at) <= now && ['ready', 'closed', 'published'].includes(String(row.plan_status ?? row.status)));
  const evidence = ctx.list('platform_post');
  const published = targets.flatMap(target => {
    const post = evidence.find(row => row.publish_target_id === target.id || row.id === target.platform_post_id);
    return post && Number.isFinite(timestamp(post.published_at)) ? [{ target, post }] : [];
  });
  const execution_efficiency = {
    definition_version: 1, as_of: ctx.now,
    scheduled_count: targets.length, verified_count: published.length,
    on_time_rate: { value: published.length ? published.filter(({ target, post }) => timestamp(post.published_at) <= timestamp(target.scheduled_at)).length / published.length : null,
      coverage: targets.length ? published.length / targets.length : null, availability: published.length ? published.length === targets.length ? 'observed' : 'partial' : 'not_collected' },
  };
  return { from, to, timezone: tz, execution_efficiency, cards: metricCards, as_of: ctx.now };
}
