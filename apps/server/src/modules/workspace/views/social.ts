import { READ, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { addDays, localDay } from '../../analytics/shared.js';
import { brandScope, invalid } from '../shared.js';
import type { WorkspaceReadContext } from '../search.js';
import { platformName, previousPeriod, text, viewPeriod, type ViewPeriod } from './calendar.js';

// Read-model for the agent-first web view. Contract: docs/agent-first-design.md 3.5.

export type Availability = 'observed' | 'estimated' | 'not_collected' | 'no_permission' | 'source_not_provided' | 'sync_failed' | 'not_applicable';
export interface Cell { value: number | null; availability: Availability }
export interface Metric extends Cell { previous_value?: number | null; change_ratio?: number | null; coverage?: { observed: number; expected: number } }
export interface Point extends Cell { date: string }
interface Sample extends Cell { at: number }

const AVAILABILITY = new Set<string>(['observed', 'estimated', 'not_collected', 'no_permission', 'source_not_provided', 'sync_failed', 'not_applicable']);
const isKnown = (availability: string) => availability === 'observed' || availability === 'estimated';
const unknown = (availability: Availability = 'not_collected'): Cell => ({ value: null, availability });
/** Shared availability of unknown inputs, else not_collected (mirrors the analytics engine). */
export function unknownOf(cells: readonly Cell[]): Availability {
  const first = cells[0]?.availability;
  return first && !isKnown(first) && cells.every(cell => cell.availability === first) ? first : 'not_collected';
}
/** Adds known values only; a result with no known input stays unknown instead of becoming 0. */
export function sumCells(cells: readonly (Cell | undefined)[]): Cell {
  const present = cells.filter((cell): cell is Cell => cell !== undefined);
  const usable = present.filter(cell => cell.value !== null);
  if (!usable.length) return unknown(unknownOf(present));
  return { value: usable.reduce((sum, cell) => sum + cell.value!, 0), availability: usable.some(cell => cell.availability === 'estimated') ? 'estimated' : 'observed' };
}
export function compared(current: Cell, previous: Cell): Metric {
  const change_ratio = current.value !== null && previous.value !== null && previous.value !== 0 ? (current.value - previous.value) / Math.abs(previous.value) : null;
  return { ...current, previous_value: previous.value, change_ratio };
}
const known = (cell: Cell | undefined) => cell?.value != null;
/**
 * Change between two equally long runs of days. The previous side counts only the days also known now, and a day known now
 * but not then leaves the change unknown: comparing sums over different coverage would turn a late import into growth.
 */
export function comparedDays(current: readonly (Cell | undefined)[], previous: readonly (Cell | undefined)[]): Metric {
  const now = sumCells(current);
  const comparable = now.value !== null && current.every((cell, index) => !known(cell) || known(previous[index]));
  return compared(now, comparable ? sumCells(previous.filter((_, index) => known(current[index]))) : unknown());
}
/** Change of a sum over subjects, only when every subject counted now has its own comparable previous value; a subject that just started reporting is not growth. */
export function comparedSum(metrics: readonly Metric[]): Metric {
  const counted = metrics.filter(known);
  const before = counted.every(metric => metric.previous_value != null) ? sumCells(counted.map(metric => ({ value: metric.previous_value!, availability: 'observed' }))) : unknown();
  return compared(sumCells(metrics), before);
}
/** One point for every day of the period; a day without data is null + not_collected, never 0. */
export const dailyPoints = (days: readonly string[], cell: (day: string) => Cell | undefined): Point[] =>
  days.map(date => { const { value, availability } = cell(date) ?? unknown(); return { date, value, availability }; });
const plain = (cell: Cell | undefined): Cell | undefined => cell && { value: cell.value, availability: cell.availability };

const metrics = ['views', 'engagements', 'reach', 'followers'] as const;
type SeriesMetric = typeof metrics[number];
type Canonical = SeriesMetric | 'likes' | 'comments' | 'shares' | 'saves';
// Generic import keys and normalized registry keys, in preference order when one subject reports several for a day.
const ALIASES: Record<Canonical, readonly string[]> = {
  views: ['views', 'norm.post.views', 'norm.account.views', 'video_views', 'yt.video.views'],
  engagements: ['engagements', 'norm.post.engagements', 'norm.account.engagements'],
  reach: ['reach', 'norm.post.reach', 'norm.account.reach', 'ig.media.reach'],
  followers: ['followers', 'norm.account.followers'],
  likes: ['likes', 'norm.post.likes'], comments: ['comments', 'norm.post.comments'], shares: ['shares', 'norm.post.shares'], saves: ['saves', 'norm.post.saves'],
};
const COMPONENTS = ['likes', 'comments', 'shares', 'saves'] as const;
const CANONICAL = new Map(Object.entries(ALIASES).flatMap(([canonical, keys]) => keys.map(key => [key, canonical as Canonical])));
const DAY_MS = 86_400_000;

function observationDay(row: Row, kind: string, tz: string): string | undefined {
  for (const field of [row.date, row.native_date]) if (typeof field === 'string' && /^\d{4}-\d\d-\d\d/.test(field)) return field.slice(0, 10);
  const raw = typeof row.period_start === 'string' ? row.period_start : undefined;
  const start = raw === undefined ? NaN : Date.parse(raw), end = typeof row.period_end === 'string' ? Date.parse(row.period_end) : NaN;
  if (!Number.isFinite(start) || kind === 'hour' || Number.isFinite(end) && end - start > DAY_MS + 3_600_000) return undefined;
  // A date-only report day is stored as UTC midnight; reading it in a zone west of UTC would shift it a day.
  if (/^\d{4}-\d\d-\d\d(?:T00:00(?::00(?:\.000)?)?Z)?$/.test(raw!) && (!Number.isFinite(end) || end - start === DAY_MS)) return raw!.slice(0, 10);
  return localDay(start, tz);
}
function sampleOf(row: Row, at: number): Sample {
  const availability = AVAILABILITY.has(String(row.availability)) ? row.availability as Availability : 'source_not_provided';
  const value = isKnown(availability) && typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null;
  return { value, availability: value === null && isKnown(availability) ? 'not_collected' : availability, at };
}
function difference(before: Sample, after: Sample): Sample {
  if (before.value === null || after.value === null) return { value: null, availability: after.value === null ? after.availability : before.availability, at: after.at };
  if (after.value < before.value) return { value: null, availability: 'sync_failed', at: after.at };
  return { value: after.value - before.value, availability: before.availability === 'estimated' || after.availability === 'estimated' ? 'estimated' : 'observed', at: after.at };
}
const latest = (samples: Iterable<Sample>) => [...samples].sort((a, b) => b.at - a.at)[0];
function withComponents(explicit: Sample | undefined, parts: (Sample | undefined)[]): Sample | undefined {
  if (explicit && explicit.value !== null) return explicit;
  const present = parts.filter((part): part is Sample => part !== undefined);
  const at = Math.max(...present.map(part => part.at));
  if (present.some(part => part.value !== null)) return { ...sumCells(present), at };
  return explicit ?? (present.length ? { ...unknown(unknownOf(present)), at } : undefined);
}

interface KeySeries { daily: Map<string, Sample>; snapshots: Map<string, Sample> }
/** Metric observations of the selected subjects, normalized to one sample per subject, metric and local day. */
function observationStore(ctx: Context, subjects: Map<string, string | undefined>, tz: string) {
  const sources = new Map(ctx.list('data_source').map(row => [row.id, row]));
  const now = Date.parse(ctx.now);
  const raw = new Map<string, Map<string, KeySeries>>();
  const lastSeen = new Map<string, number>();
  let restricted = false;
  for (const row of ctx.list('metric_observation')) {
    const subject = `${row.subject_type}:${row.subject_id}`;
    const canonical = CANONICAL.get(String(row.metric_key));
    const at = Date.parse(String(row.observed_at));
    if (!canonical || !subjects.has(subject) || row.rolled_back === true || !(at <= now)) continue;
    const sourceId = row.data_source_id ?? (row.source as Data | undefined)?.data_source_id;
    if (typeof sourceId === 'string') {
      const source = sources.get(sourceId);
      if (!source || source.status === 'disabled' || (source.allowed_uses as Data | undefined)?.display !== true) { restricted = true; continue; }
    }
    const kind = String(row.period_kind ?? (row.date ? 'day' : row.period_start ? 'range' : 'lifetime'));
    const day = kind === 'lifetime' ? localDay(at, tz) : observationDay(row, kind, tz);
    if (!day) continue;
    lastSeen.set(subject, Math.max(lastSeen.get(subject) ?? 0, at));
    const keys = raw.get(subject) ?? new Map<string, KeySeries>();
    raw.set(subject, keys);
    const entry = keys.get(String(row.metric_key)) ?? { daily: new Map(), snapshots: new Map() };
    keys.set(String(row.metric_key), entry);
    const bucket = kind === 'lifetime' ? entry.snapshots : entry.daily;
    const prior = bucket.get(day);
    if (!prior || prior.at <= at) bucket.set(day, sampleOf(row, at));
  }
  const derived = new Map<string, Map<string, Sample>>();
  // Cumulative snapshots become daily increments only between consecutive days (or from zero on the publication day).
  function dailyFor(subject: string, key: string, canonical: Canonical) {
    const id = `${subject}\u0000${key}`;
    const cached = derived.get(id);
    if (cached) return cached;
    const entry = raw.get(subject)?.get(key);
    const out = new Map(entry?.daily);
    if (entry && canonical === 'followers') {
      for (const [day, snapshot] of entry.snapshots) if ((out.get(day)?.at ?? -Infinity) <= snapshot.at) out.set(day, snapshot);
    } else if (entry && canonical !== 'reach') {
      for (const [day, snapshot] of entry.snapshots) {
        if (out.has(day)) continue;
        const before = entry.snapshots.get(addDays(day, -1));
        if (before) out.set(day, difference(before, snapshot));
        else if (day === subjects.get(subject)) out.set(day, snapshot);
      }
    }
    derived.set(id, out);
    return out;
  }
  const preferred = (canonical: Canonical, read: (key: string) => Sample | undefined) => {
    let fallback: Sample | undefined;
    for (const key of ALIASES[canonical]) {
      const sample = read(key);
      if (sample?.value != null) return sample;
      fallback ??= sample;
    }
    return fallback;
  };
  const daily = (subject: string, canonical: Canonical, day: string) => preferred(canonical, key => dailyFor(subject, key, canonical).get(day));
  function keyTotal(subject: string, key: string) {
    const entry = raw.get(subject)?.get(key);
    if (!entry) return undefined;
    const snapshots = [...entry.snapshots.values()];
    if (snapshots.length) return latest(snapshots.filter(sample => sample.value !== null)) ?? latest(snapshots);
    const days = [...entry.daily.values()];
    return days.length ? { ...sumCells(days), at: Math.max(...days.map(sample => sample.at)) } : undefined;
  }
  const total = (subject: string, canonical: Canonical) => preferred(canonical, key => keyTotal(subject, key));
  return {
    restricted, lastSeen,
    day(subject: string, metric: SeriesMetric, day: string): Sample | undefined {
      return metric === 'engagements' ? withComponents(daily(subject, 'engagements', day), COMPONENTS.map(part => daily(subject, part, day))) : daily(subject, metric, day);
    },
    /** Lifetime-to-date value: the latest cumulative snapshot, else the sum of reported days. */
    total(subject: string, metric: 'views' | 'engagements'): Sample | undefined {
      return metric === 'engagements' ? withComponents(total(subject, 'engagements'), COMPONENTS.map(part => total(subject, part))) : total(subject, metric);
    },
  };
}

export interface SocialOptions { period: ViewPeriod; brand_id?: string; platforms?: readonly string[]; metric?: SeriesMetric; limit?: number }
/**
 * Per-account social performance for a period and the period before it. Series and top posts are built on demand, so the
 * home view reads several series from one pass over the observations.
 */
export function socialModel(ctx: WorkspaceReadContext, options: Pick<SocialOptions, 'period' | 'brand_id' | 'platforms'>) {
  const { period } = options;
  const compare = previousPeriod(period);
  const inPeriod = (value: unknown, range: ViewPeriod) => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return at >= range.start && at < range.end; };
  const accounts = ctx.list('social_account').filter(row => (options.brand_id === undefined || row.brand_id === options.brand_id)
    && !['archived', 'disabled'].includes(String(row.status)) && (ctx.canReadWorkspaceResource?.('social_account', row) ?? ctx.role !== 'agent')
    && (!options.platforms?.length || options.platforms.includes(String(platformName(row.platform ?? row.provider)))))
    .sort((a, b) => String(a.display_name ?? a.handle ?? a.id).localeCompare(String(b.display_name ?? b.handle ?? b.id)) || a.id.localeCompare(b.id));
  const accountIds = new Set(accounts.map(row => row.id));
  const posts = ctx.list('platform_post').filter(row => accountIds.has(String(row.social_account_id ?? row.account_id)));
  const postsByAccount = new Map(accounts.map(row => [row.id, [] as Row[]]));
  for (const post of posts) postsByAccount.get(String(post.social_account_id ?? post.account_id))!.push(post);
  const subjects = new Map<string, string | undefined>([
    ...accounts.map(row => [`social_account:${row.id}`, undefined] as const),
    ...posts.map(row => [`platform_post:${row.id}`, typeof row.published_at === 'string' ? localDay(Date.parse(row.published_at), period.tz) : undefined] as const),
  ]);
  const store = observationStore(ctx, subjects, period.tz);
  const warnings = new Set<string>();
  if (store.restricted) warnings.add('SOURCE_USE_RESTRICTED');
  const window = [...compare.days, ...period.days];

  // Account-level reports win; post-level reports are summed only for accounts that never report the metric themselves.
  const fromPosts = new Map<string, boolean>();
  const usesPosts = (account: Row, name: SeriesMetric) => {
    const id = `${account.id}:${name}`;
    if (!fromPosts.has(id)) fromPosts.set(id, (name === 'views' || name === 'engagements') && !window.some(day => store.day(`social_account:${account.id}`, name, day)?.value != null));
    return fromPosts.get(id)!;
  };
  const memo = new Map<string, Cell | undefined>();
  const accountDay = (account: Row, name: SeriesMetric, day: string): Cell | undefined => {
    const id = `${account.id}\u0000${name}\u0000${day}`;
    if (memo.has(id)) return memo.get(id);
    let cell: Cell | undefined;
    if (!usesPosts(account, name)) cell = plain(store.day(`social_account:${account.id}`, name, day));
    else {
      const samples = postsByAccount.get(account.id)!.map(post => store.day(`platform_post:${post.id}`, name, day)).filter(sample => sample !== undefined);
      cell = samples.length ? sumCells(samples) : undefined;
    }
    memo.set(id, cell);
    return cell;
  };
  const additive = (account: Row, name: 'views' | 'engagements'): Metric => {
    const now = period.days.map(day => accountDay(account, name, day));
    const observed = now.filter(known).length;
    if (observed && observed < period.days.length) warnings.add('PARTIAL_COVERAGE');
    return { ...comparedDays(now, compare.days.map(day => accountDay(account, name, day))), coverage: { observed, expected: period.days.length } };
  };
  // Reach is not additive across days or accounts, so a multi-day sum would overstate it.
  const reach = (account: Row, days: readonly string[]): Cell => {
    const cells = days.flatMap(day => accountDay(account, 'reach', day) ?? []);
    const usable = cells.filter(cell => cell.value !== null);
    return usable.length === 1 ? usable[0]! : usable.length > 1 ? unknown('not_applicable') : unknown(unknownOf(cells));
  };
  const followers = (account: Row, days: readonly string[]): Cell => {
    const cells = days.flatMap(day => accountDay(account, 'followers', day) ?? []);
    return [...days].reverse().map(day => accountDay(account, 'followers', day)).find(cell => cell?.value != null) ?? unknown(unknownOf(cells));
  };
  const rate = (account: Row, days: readonly string[]): Cell => {
    let numerator = 0, denominator = 0, matched = 0, estimated = false;
    for (const day of days) {
      const engagements = accountDay(account, 'engagements', day), views = accountDay(account, 'views', day);
      if (engagements?.value == null || views?.value == null) continue;
      matched++;
      numerator += engagements.value;
      denominator += views.value;
      estimated ||= engagements.availability === 'estimated' || views.availability === 'estimated';
    }
    if (!matched) return unknown();
    return denominator > 0 ? { value: numerator / denominator, availability: estimated ? 'estimated' : 'observed' } : unknown('not_applicable');
  };

  const cards = accounts.map(account => {
    const own = postsByAccount.get(account.id)!;
    const views = additive(account, 'views'), engagements = additive(account, 'engagements');
    const fans = { now: followers(account, period.days), before: followers(account, compare.days) };
    if (usesPosts(account, 'views') && views.value !== null || usesPosts(account, 'engagements') && engagements.value !== null) warnings.add('ACCOUNT_METRICS_FROM_POSTS');
    const seen = [`social_account:${account.id}`, ...own.map(post => `platform_post:${post.id}`)].reduce((max, key) => Math.max(max, store.lastSeen.get(key) ?? 0), 0);
    return {
      social_account_id: account.id, platform: platformName(account.platform ?? account.provider), display_name: text(account.display_name) ?? text(account.name),
      handle: text(account.handle) ?? text(account.username), brand_id: text(account.brand_id),
      followers: { ...compared(fans.now, fans.before), delta: fans.now.value !== null && fans.before.value !== null ? fans.now.value - fans.before.value : null },
      metrics: {
        views, engagements,
        reach: compared(reach(account, period.days), reach(account, compare.days)),
        engagement_rate: compared(rate(account, period.days), rate(account, compare.days)),
      },
      posts_published: own.filter(post => inPeriod(post.published_at, period)).length,
      last_observed_at: seen > 0 ? new Date(seen).toISOString() : null,
    };
  });
  const total = (name: 'views' | 'engagements'): Metric => {
    const observed = cards.filter(card => card.metrics[name].value !== null);
    if (observed.length && observed.length < cards.length) warnings.add('PARTIAL_COVERAGE');
    if (new Set(observed.map(card => card.platform)).size > 1) warnings.add('NON_ADDITIVE_ACROSS_PLATFORMS');
    return { ...comparedSum(cards.map(card => card.metrics[name])), coverage: { observed: observed.length, expected: cards.length } };
  };
  const byAccount = (metric: SeriesMetric) => accounts.map((account, index) => ({ social_account_id: account.id, label: cards[index]!.display_name ?? cards[index]!.handle ?? account.id,
    points: dailyPoints(period.days, day => accountDay(account, metric, day)) }));
  // Follower counts are levels: a day an account did not report keeps its last known count (estimated), and a day before an
  // account's first count leaves the total unknown, so the line never dips just because one account skipped a day.
  const levels = () => {
    const counted = accounts.filter(account => period.days.some(day => known(accountDay(account, 'followers', day))));
    const last = new Map<string, Cell>();
    for (const day of compare.days) for (const account of counted) { const cell = accountDay(account, 'followers', day); if (known(cell)) last.set(account.id, cell!); }
    return dailyPoints(period.days, day => {
      const raw = accounts.map(account => accountDay(account, 'followers', day));
      const cells = counted.map(account => {
        const cell = accountDay(account, 'followers', day);
        if (known(cell)) { last.set(account.id, cell!); return cell; }
        const prior = last.get(account.id);
        return prior && { value: prior.value, availability: 'estimated' as const };
      });
      if (cells.length && cells.every(cell => cell !== undefined)) return sumCells(cells);
      // With nothing to carry, keep the reason the accounts gave for the day (no_permission, sync_failed, ...).
      return cells.some(cell => cell !== undefined) ? unknown() : sumCells(raw);
    });
  };
  const series = (metric: SeriesMetric) => metric === 'followers' ? levels() : dailyPoints(period.days, day => {
    const cells = accounts.map(account => accountDay(account, metric, day));
    return metric === 'reach' && cells.filter(known).length > 1 ? unknown('not_applicable') : sumCells(cells);
  });

  const topPosts = (ranking: 'views' | 'engagements') => {
    const targets = new Map(ctx.list('publish_target').map(row => [row.id, row]));
    const items = new Map(ctx.list('content_item').map(row => [row.id, row]));
    const accountById = new Map(accounts.map(row => [row.id, row]));
    const published = posts.filter(post => inPeriod(post.published_at, period)).map(post => {
      const target = targets.get(String(post.publish_target_id));
      const account = accountById.get(String(post.social_account_id ?? post.account_id));
      const cell = (name: 'views' | 'engagements'): Metric => {
        const sample = store.total(`platform_post:${post.id}`, name);
        return plain(sample) ?? unknown();
      };
      return {
        platform_post_id: post.id, social_account_id: text(post.social_account_id ?? post.account_id), platform: platformName(post.platform ?? post.provider ?? account?.provider),
        permalink: text(post.permalink), published_at: text(post.published_at),
        title: text(post.title) ?? text(target?.title) ?? text(items.get(String(post.content_item_id ?? target?.content_item_id))?.title) ?? text(post.caption)?.slice(0, 120) ?? null,
        campaign_id: text(post.campaign_id) ?? text(target?.campaign_id), metrics: { views: cell('views'), engagements: cell('engagements') },
      };
    });
    const ranked = published.filter(post => post.metrics[ranking].value !== null)
      .sort((a, b) => b.metrics[ranking].value! - a.metrics[ranking].value! || String(b.published_at).localeCompare(String(a.published_at)) || a.platform_post_id.localeCompare(b.platform_post_id));
    return { ranked, unranked: published.length - ranked.length };
  };
  return { period, compare, cards, warnings, total, series, byAccount, topPosts };
}

/** The social view: one series, totals and top posts. Contract: docs/agent-first-design.md 3.5. */
export function socialSummary(ctx: WorkspaceReadContext, options: SocialOptions) {
  const metric = options.metric ?? 'views';
  const model = socialModel(ctx, options);
  const { period, compare } = model;
  const totals = { views: model.total('views'), engagements: model.total('engagements') };
  const top = model.topPosts(metric === 'engagements' ? 'engagements' : 'views');
  return {
    period: { from: period.from, to: period.to, tz: period.tz }, compare_period: { from: compare.from, to: compare.to },
    accounts: model.cards, totals,
    series: { metric, total: model.series(metric), by_account: model.byAccount(metric) },
    top_posts: top.ranked.slice(0, options.limit ?? 10), unranked_count: top.unranked,
    warnings: [...model.warnings].sort(), as_of: ctx.now,
  };
}

export function socialView(ctx: WorkspaceReadContext, { query }: Input) {
  const metric = query.metric ?? 'views';
  if (!(metrics as readonly string[]).includes(metric)) invalid(`metric must be one of ${metrics.join(', ')}`);
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid('limit must be between 1 and 50');
  const platforms = query.platform?.split(',').map(value => platformName(value.trim())).filter((value): value is string => !!value);
  return socialSummary(ctx, { period: viewPeriod(ctx, query, 30), brand_id: brandScope(ctx, query.brand_id), platforms, metric: metric as SeriesMetric, limit });
}

export const socialViewOperations: Operation[] = [
  { method: 'GET', path: '/views/social', name: 'views_social', roles: READ, summary: 'Read per-account social performance, daily series and top posts with coverage',
    contract: { query: ['from', 'to', 'tz', 'brand_id', 'platform', 'metric', 'limit'] }, ownsLimit: true, run: socialView },
];
