import { READ, type Context, type Input, type Operation, type Row } from '@smartsell/contracts';
import { operations as adsOperations } from '../../ads/workspace-operations.js';
import { INTERNAL_READ } from '../../campaign/shared.js';
import { brandScope } from '../shared.js';
import { adsReadScope, campaignScope, previousPeriod, text, viewPeriod, type ViewPeriod } from './calendar.js';
import { compared, dailyPoints, sumCells, unknownOf, type Availability, type Cell, type Metric, type Point } from './social.js';

// Read-model for the agent-first web view. Contract: docs/agent-first-design.md 3.6.

const METRICS = ['spend', 'impressions', 'clicks', 'conversions'] as const;
type AdMetric = typeof METRICS[number];
interface Reported extends Cell { entity: Row; day: string; metric: AdMetric; currency: string | null; at: number }
export interface Pacing {
  campaign_id: string | null; currency: string; budget_minor: number | null; budget_availability: 'available' | 'no_permission';
  actual_spend_minor: number | null; coverage_ratio: number | null; delayed: boolean | null;
}
const isKnown = (availability: string) => availability === 'observed' || availability === 'estimated';
const byId = (rows: Row[]) => new Map(rows.map(row => [row.id, row]));

export interface AdsOptions { period: ViewPeriod; brand_id?: string; campaign_id?: string; input?: Input }
/** Ad accounts, spend pacing, delivery metrics and proposals visible to the caller. Exported for the home view. */
export function adsSummary(ctx: Context, options: AdsOptions) {
  const { period } = options;
  const compare = previousPeriod(period);
  const input = options.input ?? { body: {}, params: {}, query: {} };
  const scoped = adsReadScope(ctx, input);
  const brandOk = (value: unknown) => options.brand_id === undefined || value === options.brand_id;
  const campaign = options.campaign_id === undefined ? undefined : ctx.get('campaign', options.campaign_id);
  const accountOk = (row: Row) => brandOk(row.brand_id) && (campaign === undefined || row.brand_id === campaign.brand_id);
  const all = ctx.list('ad_account');
  const readable = new Set(scoped.list('ad_account').map(row => row.id));
  const unreadable = new Set(all.filter(row => !readable.has(row.id)).map(row => row.id));
  const accounts = all.filter(row => readable.has(row.id) && accountOk(row));
  const hidden = all.filter(accountOk).length - accounts.length;
  const accountById = byId(accounts);
  const entities = scoped.list('ad_entity').filter(row => accountById.has(String(row.ad_account_id)));
  const entityById = byId(entities);
  const inScope = (entity: Row) => campaign === undefined || entity.campaign_id === campaign.id;
  const currencyOf = (entity: Row) => text(accountById.get(String(entity.ad_account_id))?.currency);

  // Latest report per entity, provider-native day, metric and currency, as the ads module reads it.
  const now = Date.parse(ctx.now);
  const latest = new Map<string, Reported>();
  const lastImport = new Map<string, number>();
  for (const row of ctx.list('metric_observation')) {
    const entity = entityById.get(String(row.subject_id));
    const metric = String(row.metric_key).replace(/^ads\./, '') as AdMetric;
    const at = Date.parse(String(row.observed_at));
    if (!entity || !['ad', 'ads.ad_entity'].includes(String(row.subject_type)) || row.rolled_back === true || !(at <= now)) continue;
    lastImport.set(String(entity.ad_account_id), Math.max(lastImport.get(String(entity.ad_account_id)) ?? 0, at));
    const day = text(row.native_date) ?? text(row.date)?.slice(0, 10);
    if (!METRICS.includes(metric) || !day || day < compare.from || day > period.to) continue;
    const currency = metric === 'spend' ? text(row.currency) ?? currencyOf(entity) : null;
    const known = isKnown(String(row.availability)) && typeof row.value === 'number' && Number.isFinite(row.value);
    const key = JSON.stringify([entity.id, day, metric, currency]);
    const prior = latest.get(key);
    if (!prior || prior.at <= at) latest.set(key, { entity, day, metric, currency, at, value: known ? row.value as number : null,
      availability: known ? row.availability as Availability : isKnown(String(row.availability)) ? 'not_collected' : (text(row.availability) ?? 'source_not_provided') as Availability });
  }
  const reported = [...latest.values()];
  const reportedKeys = new Set(reported.filter(row => row.value !== null).map(row => JSON.stringify([row.entity.id, row.day, row.metric, row.currency])));
  // A reported ancestor total already includes its descendants for that day, so descendants are not added again.
  const counted = reported.filter(row => {
    if (!inScope(row.entity)) return false;
    if (row.value === null) return true;
    const visited = new Set<unknown>([row.entity.id]);
    for (let parent = row.entity.parent_entity_id; parent && !visited.has(parent); parent = entityById.get(String(parent))?.parent_entity_id) {
      if (reportedKeys.has(JSON.stringify([parent, row.day, row.metric, row.currency]))) return false;
      visited.add(parent);
    }
    return true;
  });
  const restricted = accounts.length === 0 && hidden > 0;
  const denied = (): Cell => ({ value: null, availability: 'no_permission' });
  const currencies = [...new Set(accounts.map(row => text(row.currency)).filter((code): code is string => !!code))].sort();

  // Spend in different currencies is never added together; the per-currency totals stay available.
  const cell = (rows: Reported[]): Cell & { by_currency?: { currency: string; value: number }[] } => {
    const usable = rows.filter(row => row.value !== null);
    const codes = [...new Set(usable.map(row => row.currency).filter((code): code is string => !!code))].sort();
    if (codes.length > 1) return { value: null, availability: 'not_applicable', by_currency: codes.map(currency => ({ currency,
      value: usable.filter(row => row.currency === currency).reduce((sum, row) => sum + row.value!, 0) })) };
    return usable.length ? sumCells(usable) : { value: null, availability: unknownOf(rows) };
  };
  const select = (metric: AdMetric, range: ViewPeriod) => counted.filter(row => row.metric === metric && row.day >= range.from && row.day <= range.to);
  // Like social views, per reporting unit (ad account and currency): the previous side counts only the unit-days reported now,
  // and a unit-day reported now but not on its matching previous day leaves the change unknown. So a report import that
  // started mid-period, an account that just began reporting, or spend that moved to another currency never reads as growth.
  const previous = (name: AdMetric): Cell => {
    const unit = (row: Reported) => `${String(row.entity.ad_account_id)}\u0000${row.currency ?? ''}`;
    const known = (rows: Reported[]) => new Set(rows.filter(row => row.value !== null).map(row => `${unit(row)}\u0000${row.day}`));
    const now = known(select(name, period));
    const rows = select(name, compare);
    const then = known(rows);
    const matching = new Map(compare.days.map((day, index) => [day, period.days[index]!] as const));
    const nowKeys = [...now].map(key => key.split('\u0000'));
    const back = new Map(period.days.map((day, index) => [day, compare.days[index]!] as const));
    if (nowKeys.some(([account, currency, day]) => !then.has(`${account}\u0000${currency}\u0000${back.get(day!)}`))) return { value: null, availability: 'not_collected' };
    return cell(rows.filter(row => now.has(`${unit(row)}\u0000${matching.get(row.day)}`)));
  };
  const metric = (name: AdMetric): Metric & { currency?: string | null } => {
    const now: ReturnType<typeof cell> = restricted ? denied() : cell(select(name, period));
    const result = compared(now, restricted ? denied() : previous(name));
    if (name !== 'spend') return result;
    const code = now.by_currency ? null : select(name, period).find(row => row.value !== null)?.currency ?? (currencies.length === 1 ? currencies[0]! : null);
    return { ...result, currency: code };
  };
  const spendByDay = (day: string, currency?: string) => counted.filter(row => row.metric === 'spend' && row.day === day && (currency === undefined || row.currency === currency));
  const point = (rows: Reported[]) => restricted ? denied() : rows.length ? cell(rows) : undefined;
  const spendSeries: Point[] = dailyPoints(period.days, day => { const value = point(spendByDay(day)); return value && { value: value.value, availability: value.availability }; });

  const observedSpend = counted.filter(row => row.metric === 'spend' && row.availability === 'observed' && row.value !== null && row.day >= period.from && row.day <= period.to);
  const covered = new Set(reported.filter(row => row.metric === 'spend' && row.availability === 'observed' && row.value !== null).map(row => JSON.stringify([row.entity.id, row.day, row.currency])));
  const children = new Map<unknown, Row[]>();
  for (const entity of entities) if (entity.parent_entity_id) children.set(entity.parent_entity_id, [...(children.get(entity.parent_entity_id) ?? []), entity]);
  const complete = (entity: Row, day: string, currency: string): boolean => covered.has(JSON.stringify([entity.id, day, currency]))
    || (children.get(entity.id)?.length ?? 0) > 0 && children.get(entity.id)!.every(child => complete(child, day, currency));
  // Budgets follow campaign_budget_summary's roles. A campaign with ads or budget lines on an unreadable account is not paced at all:
  // its visible spend set against the whole budget would overstate what is left, and its account-tied lines are hidden as in the ads module.
  const budgetVisible = INTERNAL_READ.some(role => role === ctx.role);
  const budgets = budgetVisible ? ctx.list('budget_line').filter(row => (row.category ?? row.kind) === 'ads' && typeof row.amount_minor === 'number' && row.status !== 'archived') : [];
  const outOfReach = new Set([...ctx.list('ad_entity'), ...budgets].filter(row => unreadable.has(String(row.ad_account_id))).map(row => row.campaign_id));
  // Coverage follows the ads module: a day is complete when every root unit, or all of its descendants, reported observed spend.
  const pacingFor = (campaignId: string | null, units: Row[], lines: Row[], currency: string): Pacing => {
    const own = units.filter(entity => currencyOf(entity) === currency);
    const ids = new Set(own.map(entity => entity.id));
    const roots = own.filter(entity => !ids.has(String(entity.parent_entity_id)));
    const spent = observedSpend.filter(row => ids.has(row.entity.id) && row.currency === currency);
    const budget = lines.filter(row => row.currency === currency);
    const days = roots.length ? period.days.filter(day => roots.every(root => complete(root, day, currency))).length : null;
    return { campaign_id: campaignId, currency, budget_minor: budget.length ? budget.reduce((sum, row) => sum + Number(row.amount_minor), 0) : null,
      budget_availability: budgetVisible ? 'available' : 'no_permission',
      actual_spend_minor: spent.length ? spent.reduce((sum, row) => sum + row.value!, 0) : null,
      coverage_ratio: days === null ? null : days / period.days.length, delayed: days === null ? null : days < period.days.length };
  };
  const listed = ctx.list('campaign').filter(row => brandOk(row.brand_id) && (campaign === undefined || row.id === campaign.id));
  const campaigns = listed.filter(row => !outOfReach.has(row.id));
  const pacing = restricted ? [] : [
    ...campaigns.flatMap(row => {
      const units = entities.filter(entity => entity.campaign_id === row.id);
      const lines = budgets.filter(line => line.campaign_id === row.id);
      const codes = [...new Set([...lines.map(line => text(line.currency)), ...units.map(currencyOf)].filter((code): code is string => !!code))].sort();
      return codes.map(currency => pacingFor(row.id, units, lines, currency));
    }),
    ...(campaign ? [] : (() => {
      const units = entities.filter(entity => !entity.campaign_id);
      return [...new Set(units.map(currencyOf).filter((code): code is string => !!code))].sort().map(currency => pacingFor(null, units, [], currency));
    })()),
  ];

  const capabilities = new Map(((adsOperations.find(op => op.name === 'ads_list_accounts')?.run(scoped, input) ?? []) as Row[]).map(row => [row.id, row]));
  const revisions = byId(ctx.list('ad_proposal_revision'));
  const approvals = byId(ctx.list('ad_approval_request'));
  const proposals = scoped.list('ad_proposal').filter(row => accountById.has(String(row.ad_account_id)) && brandOk(row.brand_id) && (campaign === undefined || row.campaign_id === campaign.id))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.id.localeCompare(b.id)).map(row => {
      const revision = revisions.get(String(row.current_revision_id));
      const schedule = revision?.schedule as { starts_at?: unknown; ends_at?: unknown; tz?: unknown } | undefined;
      const budget = revision?.budget as { type?: unknown; amount_minor?: unknown; currency?: unknown } | undefined;
      return {
        id: row.id, name: text(row.name), status: text(row.status), campaign_id: text(row.campaign_id), ad_account_id: text(row.ad_account_id),
        schedule: schedule ? { starts_at: text(schedule.starts_at), ends_at: text(schedule.ends_at), tz: text(schedule.tz) } : null,
        budget: budget ? { type: text(budget.type), amount_minor: typeof budget.amount_minor === 'number' ? budget.amount_minor : null, currency: text(budget.currency) } : null,
        estimates: (Array.isArray(revision?.estimates) ? revision.estimates as Row[] : []).map(item => ({ metric: text(item.metric), value: typeof item.value === 'number' ? item.value : null, source: text(item.source) })),
        approval_status: text(approvals.get(String(row.approval_request_id))?.status),
      };
    });
  const warnings = [...(hidden > 0 || campaigns.length < listed.length ? ['AD_ACCOUNTS_HIDDEN'] : []), ...(currencies.length > 1 ? ['MIXED_CURRENCIES'] : [])];
  return {
    period: { from: period.from, to: period.to }, compare_period: { from: compare.from, to: compare.to }, reporting_basis: 'provider_native_daily',
    accounts: accounts.map(row => ({ id: row.id, provider: text(row.provider), name: text(row.name) ?? text(row.display_name) ?? text(row.external_account_id),
      currency: text(row.currency), timezone: text(row.timezone), read_capability: text(capabilities.get(row.id)?.read_capability) ?? 'unavailable',
      last_import_at: lastImport.has(row.id) ? new Date(lastImport.get(row.id)!).toISOString() : null })),
    // Set by role alone, so an empty pacing list never reads as "no budgets" to someone who may not see them, and never reveals that some exist.
    pacing, budget_availability: budgetVisible ? 'available' as const : 'no_permission' as const,
    metrics: Object.fromEntries(METRICS.map(name => [name, metric(name)])) as Record<AdMetric, Metric>,
    series: { spend: spendSeries, currency: currencies.length === 1 ? currencies[0]! : null,
      ...(currencies.length > 1 && !restricted ? { by_currency: currencies.map(currency => ({ currency, points: dailyPoints(period.days, day => point(spendByDay(day, currency))) })) } : {}) },
    proposals, adjustments_proposed: scoped.list('adjustment_suggestion').filter(row => row.status === 'proposed' && accountById.has(String(row.ad_account_id))
      && (campaign === undefined || entityById.get(String(row.target_entity_id))?.campaign_id === campaign.id)).length,
    warnings, as_of: ctx.now,
  };
}

export function adsView(ctx: Context, input: Input) {
  const { query } = input;
  const brand = brandScope(ctx, query.brand_id);
  return adsSummary(ctx, { period: viewPeriod(ctx, query, 30), brand_id: brand, campaign_id: campaignScope(ctx, brand, query.campaign_id)?.id, input });
}

export const adsViewOperations: Operation[] = [
  { method: 'GET', path: '/views/ads', name: 'views_ads', roles: READ, summary: 'Read ad accounts, budget pacing, delivery metrics, daily spend and proposals',
    contract: { query: ['from', 'to', 'tz', 'brand_id', 'campaign_id'] }, run: adsView },
];
