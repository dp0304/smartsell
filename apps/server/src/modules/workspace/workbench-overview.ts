import type { Context, Entity, Fields } from '../types.js';
import { isConnectorAutoStopped } from '../ops/index.js';
import { action, active, brandFilter, browse, identifier, inBrand, instant, iso, list, listLimit, localDay, openTask, problems, safeTitle, workspaceZone } from './workbench-core.js';
import { deviceOnline, onboardingStatus } from './workbench-onboarding.js';

const severity = ['blocker', 'high', 'normal', 'info'] as const;
interface Pending {
  provider: string; kind: string; severity: typeof severity[number]; title: string;
  resource: { module: string; kind: string; id: string };
  due_at?: string; owner?: { type: 'user'; id: string }; impact?: { targets?: number; accounts?: number }; source_updated_at: string;
  action: { label: string; route: string }; sources?: string[];
}
function pendingApproval(ctx: Context, row: Entity) {
  const data = row.data;
  if (!['owner', 'admin', 'reviewer'].includes(ctx.role) || !['open', 'pending', 'requested', 'awaiting_approval'].includes(data.status) ||
      [data.requested_by, data.owner_id, data.revision_author_id].includes(ctx.actorId)) return false;
  const assigned = [data.approver_id, data.assignee_id, data.reviewer_id,
    ...(Array.isArray(data.approver_ids) ? data.approver_ids : []), ...(Array.isArray(data.reviewer_ids) ? data.reviewer_ids : [])].filter(Boolean);
  const roles = Array.isArray(data.required_roles) ? data.required_roles : [];
  return assigned.includes(ctx.actorId) || roles.includes(ctx.role) || (!assigned.length && !roles.length);
}
const mk = (ctx: Context, provider: string, kind: string, s: Pending['severity'], row: Entity, section: string, title?: string, due?: string): Pending => {
  const owner = row.data.assignee_id ?? row.data.assignee_user_id ?? row.data.owner_id;
  const due_at = due ?? row.data.due_at;
  return { provider, kind, severity: s, title: title ?? safeTitle(row, kind.replaceAll('_', ' ')),
    resource: { module: row.module, kind: row.kind, id: row.id },
    ...(Number.isFinite(instant(due_at)) ? { due_at } : {}), ...(typeof owner === 'string' ? { owner: { type: 'user', id: owner } } : {}),
    source_updated_at: row.updated_at, action: { label: 'Open', route: `/w/${encodeURIComponent(ctx.workspaceId)}/${section}` } };
};
const targetParent = (row: Entity, targets: Entity[]) => targets.find(target => target.id === (row.data.target_id ?? row.data.publish_target_id ?? row.data.resource_id));
const scoped = (row: Entity, brand: string | undefined, parent?: Entity) => brand === undefined || (row.data.brand_id ?? parent?.data.brand_id ?? row.data.input_scope?.brand_id) === brand;

export async function approvalRows(ctx: Context, brand?: string) {
  if (!['owner', 'admin', 'reviewer', 'editor'].includes(ctx.role)) return [];
  const [planning, core, targets] = await Promise.all([ctx.list('planning', 'approval'), ctx.list('core', 'approval_request'), ctx.list('planning', 'publish_target')]);
  return [...new Map([...planning, ...core].filter(row => pendingApproval(ctx, row) && scoped(row, brand, targetParent(row, targets))).map(row => [row.id, row])).values()];
}
async function accountItems(ctx: Context, brand?: string) {
  const provider = 'account.health';
  const [accounts, bindings, blocks, connections, devices, phones, apps, links, policies] = await Promise.all(
    ['social_account', 'account_execution_binding', 'account_block', 'connection', 'device', 'mobile_device', 'mobile_app_binding', 'social_account_connection', 'connector_auto_policy'].map(kind => ctx.list('account', kind)));
  const account = (id: string) => accounts!.find(row => row.id === id && active(row));
  const visibleAccount = (row: Entity) => scoped(row, brand, account(row.data.social_account_id));
  const items: Pending[] = [];
  for (const row of connections!) {
    if (!active(row) || !['expired', 'reauth_required'].includes(row.data.status) && !(instant(row.data.expires_at) <= instant(ctx.now))) continue;
    if (!scoped(row, brand) && !links!.some(link => link.data.connection_id === row.id && account(link.data.social_account_id)?.data.brand_id === brand)) continue;
    items.push(mk(ctx, provider, 'auth_expired', 'high', row, 'settings/accounts', 'Connection authorization expired'));
  }
  for (const row of devices!) {
    if (!active(row) || deviceOnline(ctx, row.data) || (row.data.status !== 'offline' && !row.data.online_at)) continue;
    if (brand !== undefined && !bindings!.some(binding => binding.data.device_id === row.id && visibleAccount(binding))) continue;
    items.push(mk(ctx, provider, 'device_offline', 'high', row, 'settings/accounts', 'Connector offline'));
  }
  for (const row of phones!.filter(row => row.data.status === 'offline')) {
    if (brand !== undefined && !apps!.some(app => app.data.mobile_device_id === row.id && visibleAccount(app))) continue;
    items.push(mk(ctx, provider, 'mobile_device_offline', 'high', row, 'settings/accounts', 'Mobile device offline'));
  }
  for (const row of apps!.filter(row => active(row) && visibleAccount(row) && ['identity_mismatch', 'mismatch'].includes(row.data.identity_status ?? row.data.verification_status ?? row.data.status))) {
    items.push(mk(ctx, provider, 'identity_mismatch', 'blocker', row, 'settings/accounts', 'Mobile app account identity mismatch'));
  }
  for (const row of bindings!.filter(row => active(row) && visibleAccount(row))) {
    if (row.data.auto_halted === true) items.push(mk(ctx, provider, 'account_emergency_stop', 'blocker', row, 'settings/accounts', 'Account automatic mode is stopped'));
    if (row.data.auto_stop_reason === 'terms_outdated') items.push(mk(ctx, provider, 'terms_outdated', 'high', row, 'settings/accounts', 'Review the updated automatic mode terms and re-enable automatic mode'));
    else if (row.data.auto_stop_reason || blocks!.some(block => block.data.binding_id === row.id && block.data.status === 'open' && ['auto_failure_streak', 'captcha', 'platform_restriction', 'identity_mismatch'].includes(block.data.kind))) {
      items.push(mk(ctx, provider, 'auto_stopped', 'high', row, 'settings/accounts', 'Automatic mode stopped. An administrator must re-enable it.'));
    }
  }
  const sources = new Set<string>();
  for (const policy of policies!.filter(row => row.data.halted === true || row.data.halted_by_workspace === true)) {
    const ops = Array.isArray(policy.data.ops_halt_rule_ids) && policy.data.ops_halt_rule_ids.length > 0;
    if (ops) sources.add('ops');
    if (policy.data.halted_by_workspace || !ops) sources.add('workspace');
  }
  return { items, sources: [...sources] };
}
function haltItem(ctx: Context, sources: string[], updated: string): Pending {
  const provider = sources.includes('workspace') ? 'account.health' : 'ops.connector_auto';
  return { provider, kind: 'connector_auto_emergency_stop', severity: 'blocker', title: 'Connector automatic mode emergency stop is active',
    resource: { module: 'workspace', kind: 'workspace', id: ctx.workspaceId }, source_updated_at: updated, sources,
    action: { label: 'Open', route: `/w/${encodeURIComponent(ctx.workspaceId)}/settings/accounts` } };
}
async function opsSources(ctx: Context) {
  const direct = (await ctx.list('ops', 'connector_auto')).filter(row => ['workspace', 'global', ctx.workspaceId].includes(row.id) && row.data.stopped === true && row.data.enabled !== false);
  const rules = (await ctx.list('ops', 'job_pause_rule')).filter(row => row.data.scope === 'connector_auto' && row.data.active === true && ['all', ctx.workspaceId].includes(row.data.scope_value) && (!row.data.expires_at || instant(row.data.expires_at) > instant(ctx.now)));
  const tenantOnly = await isConnectorAutoStopped({ ...ctx, get: (module, kind, id) => module === 'account' && kind === 'connector_auto_policy' ? Promise.resolve(undefined) : ctx.get(module, kind, id) });
  return direct.length || rules.length || tenantOnly ? ['ops'] : [];
}

async function available<T>(provider: string, read: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Provider timed out')), 800); })]);
    return { provider, status: 'available' as const, value };
  } catch { return { provider, status: 'unavailable' as const }; }
  finally { clearTimeout(timer); }
}
function order(now: number, a: Pending, b: Pending) {
  const due = (date: string | undefined) => Number.isFinite(instant(date)) ? Math.abs(instant(date) - now) : Infinity;
  const impact = (p: Pending) => (p.impact?.accounts ?? 0) + (p.impact?.targets ?? 0);
  return severity.indexOf(a.severity) - severity.indexOf(b.severity) || due(a.due_at) - due(b.due_at) || impact(b) - impact(a) ||
    b.source_updated_at.localeCompare(a.source_updated_at) || a.kind.localeCompare(b.kind) || a.resource.id.localeCompare(b.resource.id);
}
export async function today(ctx: Context, input: Fields) {
  const brand = await brandFilter(ctx, input.brand_id);
  const limit = listLimit(input.limit);
  const tz = await workspaceZone(ctx);
  const day = localDay(ctx.now, tz);
  const now = instant(ctx.now);
  const results = await Promise.all([
    available('planning.approvals', async () => (await approvalRows(ctx, brand)).map(row => mk(ctx, 'planning.approvals', 'approval_pending', 'high', row, 'calendar'))),
    available('planning.missed', async () => (await ctx.list('planning', 'publish_target')).filter(row => inBrand(row, brand) && (['missed', 'missed_window'].includes(row.data.status) ||
      (row.data.status === 'scheduled' && instant(row.data.window_end ?? row.data.window_ends_at) < now)))
      .map(row => mk(ctx, 'planning.missed', 'missed_schedule', 'high', row, 'calendar', undefined, row.data.scheduled_at))),
    available('execution.attention', async () => {
      const [tasks, targets] = await Promise.all([ctx.list('execution', 'execution_task'), ctx.list('planning', 'publish_target')]);
      return tasks.filter(row => scoped(row, brand, targetParent(row, targets)) && ['failed', 'outcome_unknown', 'manual_required', 'manual', 'blocked', 'missed', 'expired', 'cancel_pending'].includes(row.data.status))
        .map(row => mk(ctx, 'execution.attention', row.data.status === 'outcome_unknown' ? 'outcome_unknown' : `execution_${row.data.status}`, ['outcome_unknown', 'blocked'].includes(row.data.status) ? 'blocker' : 'high', row, 'execution'));
    }),
    available('ingest.health', async () => {
      const [runs, gaps, sources] = await Promise.all([ctx.list('ingest', 'sync_run'), ctx.list('ingest', 'data_gap'), ctx.list('ingest', 'data_source')]);
      const scopedSource = (row: Entity) => scoped(row, brand, sources.find(source => source.id === (row.data.data_source_id ?? row.data.source_id)));
      const latest = new Map<string, Entity>();
      for (const run of runs) {
        const group = run.data.data_source_id ?? run.data.source_id ?? run.id;
        const prior = latest.get(group);
        if (!prior || (run.data.finished_at ?? run.created_at) > (prior.data.finished_at ?? prior.created_at)) latest.set(group, run);
      }
      return [...[...latest.values()].filter(row => scopedSource(row) && ['failed', 'partial_failed'].includes(row.data.status)).map(row => mk(ctx, 'ingest.health', 'sync_failed', 'high', row, 'data', 'Data sync failed')),
        ...gaps.filter(row => scopedSource(row) && !['resolved', 'closed'].includes(row.data.status)).map(row => mk(ctx, 'ingest.health', 'data_gap', 'normal', row, 'data', 'Data gap requires attention'))];
    }),
    available('inbox.queue', async () => (await ctx.list('inbox', 'conversation')).filter(row => inBrand(row, brand) && !row.data.merged_into_id && row.data.status === 'open' && (!row.data.assignee_user_id || row.data.assignee_user_id === ctx.actorId))
      .map(row => mk(ctx, 'inbox.queue', row.data.assignee_user_id ? 'reply_due' : 'unassigned', 'normal', row, 'inbox'))),
    available('workspace.work_items', async () => {
      const tasks = (await list(ctx, 'work_item')).filter(row => inBrand(row, brand) && openTask(row) && row.data.assignee_id === ctx.actorId && row.data.source_type !== 'event' && row.data.resource_type !== 'agent_job');
      return tasks.filter(row => (Number.isFinite(instant(row.data.due_at)) && localDay(row.data.due_at, tz) <= day) || row.data.blocked_reason === 'missing_assets')
        .map(row => mk(ctx, 'workspace.work_items', row.data.blocked_reason === 'missing_assets' ? 'missing_assets' : instant(row.data.due_at) < now ? 'work_overdue' : 'work_due',
          instant(row.data.due_at) < now || ['urgent', 'high'].includes(row.data.priority) ? 'high' : 'normal', row, 'me'));
    }),
    available('agent.jobs', async () => (await ctx.list('agent', 'agent_job')).filter(row => scoped(row, brand) && (row.data.assignee_id === ctx.actorId || (!row.data.assignee_id && row.data.created_by === ctx.actorId)) &&
      (row.data.status === 'lease_expired' || (['claimed', 'in_progress'].includes(row.data.status) && instant(row.data.lease_expires_at) <= now) ||
      (!['completed', 'done', 'succeeded', 'cancelled', 'failed'].includes(row.data.status) && Number.isFinite(instant(row.data.due_at)) && localDay(row.data.due_at, tz) <= day)))
      .map(row => mk(ctx, 'agent.jobs', 'agent_job_attention', 'high', row, 'automation'))),
  ]);
  const [account, ops, onboarding] = await Promise.all([available('account.health', () => accountItems(ctx, brand)), available('ops.connector_auto', () => opsSources(ctx)), available('workspace.onboarding', () => onboardingStatus(ctx, {}))]);
  const accountRows = account.value?.items ?? [];
  const haltSources = [...new Set([...(account.value?.sources ?? []), ...(ops.value ?? [])])];
  const halt = haltSources.length ? haltItem(ctx, haltSources, ctx.now) : undefined;
  const all = [...results.flatMap(result => result.value ?? []), ...accountRows, ...(halt ? [halt] : [])];
  const deduped = [...new Map(all.sort((a, b) => order(now, a, b)).map(item => [`${item.kind}:${item.resource.module}:${item.resource.kind}:${item.resource.id}`, item])).values()];
  const status = (result: { provider: string; status: string }, count: number) => ({ key: result.provider, status: result.status, as_of: ctx.now, total: result.status === 'available' ? count : null });
  return { as_of: ctx.now, timezone: tz, day, total: deduped.length, items: deduped.slice(0, limit),
    providers: [...results.map(result => status(result, result.value?.length ?? 0)), status(account, accountRows.length + Number(!!halt && haltSources.includes('workspace'))), status(ops, Number(!!halt && haltSources.includes('ops')))],
    onboarding: { status: onboarding.status, skipped: onboarding.value?.items.filter(item => item.status === 'skipped').map(({ step_key, impact }) => ({ step_key, impact })) ?? [] } };
}

async function summary(ctx: Context, input: Fields) {
  const brand = await brandFilter(ctx, input.brand_id);
  const campaign = input.campaign_id === undefined ? undefined : await ctx.get('campaign', 'campaign', identifier(input.campaign_id));
  if (input.campaign_id !== undefined && (!campaign || !inBrand(campaign, brand))) problems.missing('Campaign not found');
  const tz = await workspaceZone(ctx);
  const day = localDay(ctx.now, tz);
  const from = input.from ?? new Date(instant(day) - 7 * 86_400_000).toISOString().slice(0, 10);
  const to = input.to ?? new Date(instant(day) + 86_400_000).toISOString().slice(0, 10);
  const fromIso = iso(from, 'from');
  const toIso = iso(to, 'to');
  if (toIso <= fromIso || instant(toIso) - instant(fromIso) > 3 * 366 * 86_400_000) problems.invalid('Invalid summary period');
  const filter = { ...(brand ? { brand_ids: [brand] } : {}), ...(campaign ? { campaign_ids: [campaign.id] } : {}) };
  const cards = await Promise.all([
    ['engagement', 'platform_post', ['likes', 'comments', 'shares', 'saves']],
    ['traffic', 'short_link', ['link.clicks_filtered']],
  ].map(async ([key, type, metrics]) => {
    const provider = await available(String(key), async () => {
      const { metricCommands } = await import('../analytics/metrics.js');
      return metricCommands.metrics_query!.run(ctx, { metrics, subject: { type, filter }, time: { from, to, tz } });
    });
    return { key, availability: provider.status, data: provider.value ?? null };
  }));
  const efficiency = await available('execution_efficiency', async () => {
    const [posts, targets] = await Promise.all([ctx.list('execution', 'platform_post'), ctx.list('planning', 'publish_target')]);
    const inside = (value: unknown) => typeof value === 'string' && (/^\d{4}-\d\d-\d\d$/.test(String(from)) ? localDay(value, tz) >= from : value >= fromIso) &&
      (/^\d{4}-\d\d-\d\d$/.test(String(to)) ? localDay(value, tz) < to : value < toIso);
    const matching = posts.filter(row => Number.isFinite(instant(row.data.published_at)) && inside(row.data.published_at) &&
      scoped(row, brand, targetParent(row, targets)) && (!campaign || (row.data.campaign_id ?? targetParent(row, targets)?.data.campaign_id) === campaign.id));
    const known = matching.flatMap(row => {
      const scheduled = targetParent(row, targets)?.data.scheduled_at;
      return Number.isFinite(instant(scheduled)) ? [instant(row.data.published_at) <= instant(scheduled)] : [];
    });
    return { output_count: matching.length, on_time_rate: known.length ? known.filter(Boolean).length / known.length : null,
      availability: known.length ? 'observed' : 'not_collected', coverage: { observed: known.length, total: matching.length }, definition_version: 1, as_of: ctx.now };
  });
  return { period: { from, to, timezone: tz }, as_of: ctx.now, cards: [{ key: 'execution_efficiency', availability: efficiency.status, data: efficiency.value ?? null }, ...cards] };
}
export const overviewQueries = { overview_today: action(browse, today), overview_summary: action(browse, summary) };
