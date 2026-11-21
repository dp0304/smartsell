import { diffDays, formatDay, formatMeasure, intlLocale, isNum, metricDelta, type Lang, type Metric, type Point, type Tuple } from '@smartsell/ui';

// Response of GET /views/social (apps/server/src/modules/workspace/views/social.ts). The server sends more
// than the design contract (coverage, warnings, handle); every field is optional at the edges.
export interface Coverage { observed: number; expected: number }
export interface CoveredMetric extends Metric { coverage?: Coverage }
export interface SocialAccount {
  social_account_id: string; platform: string | null; display_name: string | null; handle?: string | null; brand_id?: string | null;
  followers?: Metric & { delta?: number | null };
  metrics?: { views?: CoveredMetric; engagements?: CoveredMetric; reach?: Metric; engagement_rate?: Metric };
  posts_published?: number; last_observed_at?: string | null;
}
export interface TopPost {
  platform_post_id: string; social_account_id: string | null; platform: string | null; permalink: string | null; published_at: string | null;
  title: string | null; campaign_id: string | null; metrics?: { views?: Metric; engagements?: Metric };
}
export interface SocialData {
  period?: { from: string; to: string; tz: string }; compare_period?: { from: string; to: string };
  accounts?: SocialAccount[]; totals?: { views?: CoveredMetric; engagements?: CoveredMetric };
  series?: { metric: string; total: Point[]; by_account: { social_account_id: string; label: string; points: Point[] }[] };
  top_posts?: TopPost[]; unranked_count?: number; warnings?: string[]; as_of?: string;
}
export type SeriesMetric = 'views' | 'engagements';
export const seriesMetrics: readonly SeriesMetric[] = ['views', 'engagements'];
export const readSeriesMetric = (value: string | null): SeriesMetric => value === 'engagements' ? 'engagements' : 'views';

/** Total that also says how many accounts it covers; unknown stays null, never 0. */
export interface Combined extends Metric { delta: number | null; counted: number; total: number }

const known = (availability: string | undefined) => availability === 'observed' || availability === 'estimated';
/** Shared availability of unknown inputs, else not_collected (mirrors the server read model). */
export function sharedUnknown(availabilities: readonly (string | undefined)[]): string {
  const first = availabilities[0];
  return first && !known(first) && availabilities.every(value => value === first) ? first : 'not_collected';
}
const ratioOf = (now: number | null, before: number | null) => isNum(now) && isNum(before) && before !== 0 ? (now - before) / Math.abs(before) : null;

/**
 * Followers summed over the accounts that reported a count. The net change only uses accounts with both a
 * current and a prior count, so an account that started reporting this period does not look like growth.
 */
export function followersTotal(accounts: readonly SocialAccount[]): Combined {
  const reported = accounts.filter(account => isNum(account.followers?.value));
  if (!reported.length) {
    return { value: null, availability: sharedUnknown(accounts.map(account => account.followers?.availability)), previous_value: null, change_ratio: null, delta: null, counted: 0, total: accounts.length };
  }
  const value = reported.reduce((sum, account) => sum + account.followers!.value!, 0);
  const paired = reported.filter(account => isNum(account.followers!.previous_value) || isNum(account.followers!.delta));
  const delta = paired.length ? paired.reduce((sum, account) => sum + (isNum(account.followers!.delta) ? account.followers!.delta : account.followers!.value! - account.followers!.previous_value!), 0) : null;
  const before = paired.length ? paired.reduce((sum, account) => sum + (isNum(account.followers!.previous_value) ? account.followers!.previous_value : account.followers!.value! - account.followers!.delta!), 0) : null;
  return {
    value, availability: reported.some(account => account.followers!.availability === 'estimated') ? 'estimated' : 'observed',
    previous_value: paired.length === reported.length ? before : null, change_ratio: delta !== null && isNum(before) && before !== 0 ? delta / Math.abs(before) : null,
    delta, counted: reported.length, total: accounts.length,
  };
}

/**
 * Engagement rate across accounts: each account's own rate (engagements ÷ views over the days both were
 * reported) weighted by its views. With one reporting account this is exactly that account's rate. The change
 * compares only accounts known in both periods: an account missing from one side would shift the mix, not the rate.
 */
export function engagementRate(accounts: readonly SocialAccount[]): Combined {
  type Pick = (metric: Metric) => number | null | undefined;
  const usable = (pick: Pick) => (account: SocialAccount) => isNum(account.metrics?.engagement_rate ? pick(account.metrics.engagement_rate) : null) && isNum(account.metrics?.views ? pick(account.metrics.views) : null);
  const side = (rows: readonly SocialAccount[], pick: Pick) => {
    const weight = rows.reduce((sum, account) => sum + pick(account.metrics!.views!)!, 0);
    if (!rows.length) return { value: null, counted: 0, estimated: false };
    if (weight <= 0) return { value: rows.length === 1 ? pick(rows[0].metrics!.engagement_rate!)! : null, counted: rows.length, estimated: false };
    return {
      value: rows.reduce((sum, account) => sum + pick(account.metrics!.engagement_rate!)! * pick(account.metrics!.views!)!, 0) / weight, counted: rows.length,
      estimated: rows.some(account => account.metrics!.engagement_rate!.availability === 'estimated' || account.metrics!.views!.availability === 'estimated'),
    };
  };
  const value: Pick = metric => metric.value, previous: Pick = metric => metric.previous_value;
  const current = accounts.filter(usable(value)), paired = current.filter(usable(previous));
  const now = side(current, value), before = side(paired, previous);
  const availability = now.value !== null ? now.estimated ? 'estimated' : 'observed'
    : now.counted ? 'not_applicable' : sharedUnknown(accounts.map(account => account.metrics?.engagement_rate?.availability));
  return { value: now.value, availability, previous_value: paired.length === current.length ? before.value : null,
    change_ratio: ratioOf(side(paired, value).value, before.value), delta: null, counted: now.counted, total: accounts.length };
}

const accountHasData = (account: SocialAccount) => [account.followers, account.metrics?.views, account.metrics?.engagements, account.metrics?.reach]
  .some(metric => isNum(metric?.value));
/** Accounts that reported nothing at all in the period (no followers, views, engagements or reach). */
export const silentAccounts = (accounts: readonly SocialAccount[]) => accounts.filter(account => !accountHasData(account));
/** True when anything at all was collected for the period; otherwise the page leads with the import prompt. */
export function hasAnyData(view: SocialData) {
  return (view.accounts ?? []).some(accountHasData) || (view.series?.total ?? []).some(point => isNum(point.value))
    || (view.top_posts?.length ?? 0) > 0 || isNum(view.totals?.views?.value) || isNum(view.totals?.engagements?.value);
}

/** Days with a known value out of all days in the series. */
export function seriesCoverage(points: readonly Point[]) {
  return { known: points.filter(point => isNum(point.value)).length, total: points.length };
}

/** Busiest accounts first; accounts without a view count keep the server's name order at the end. */
export function sortAccounts(accounts: readonly SocialAccount[]): SocialAccount[] {
  const views = (account: SocialAccount) => account.metrics?.views?.value;
  return accounts.map((account, index) => ({ account, index })).sort((a, b) => {
    const x = views(a.account), y = views(b.account);
    if (isNum(x) && isNum(y)) return y - x || a.index - b.index;
    if (isNum(x) !== isNum(y)) return isNum(x) ? -1 : 1;
    return a.index - b.index;
  }).map(entry => entry.account);
}

export const platformText: Record<string, Tuple> = {
  instagram: ['Instagram', 'Instagram'], tiktok: ['TikTok', 'TikTok'], facebook: ['Facebook', 'Facebook'], youtube: ['YouTube', 'YouTube'],
  threads: ['Threads', 'Threads'], x: ['X', 'X'], twitter: ['X', 'X'], xiaohongshu: ['小紅書', 'Xiaohongshu'], line: ['LINE', 'LINE'],
  pinterest: ['Pinterest', 'Pinterest'], linkedin: ['LinkedIn', 'LinkedIn'], shopee: ['蝦皮', 'Shopee'],
  meta_ads: ['Meta 廣告', 'Meta Ads'], tiktok_ads: ['TikTok 廣告', 'TikTok Ads'], google_ads: ['Google 廣告', 'Google Ads'],
};
export function platformLabel(platform: string | null | undefined, lang: Lang) {
  if (!platform) return lang === 'en' ? 'Unknown platform' : '未知平台';
  const entry = platformText[platform];
  return entry ? entry[lang === 'en' ? 1 : 0] : platform.replace(/_/g, ' ');
}

/** Account names for legends and lists; a name shared by two accounts gets its platform appended. */
export function accountNames(accounts: readonly SocialAccount[], lang: Lang): Map<string, string> {
  const base = (account: SocialAccount) => account.display_name || (account.handle ? `@${account.handle}` : platformLabel(account.platform, lang));
  const counts = new Map<string, number>();
  for (const account of accounts) counts.set(base(account), (counts.get(base(account)) ?? 0) + 1);
  return new Map(accounts.map(account => {
    const name = base(account);
    return [account.social_account_id, (counts.get(name) ?? 0) > 1 ? `${name} · ${platformLabel(account.platform, lang)}` : name];
  }));
}

/** Coverage warnings from the read model, in plain words. Unknown codes are passed through as-is. */
export const warningText: Record<string, Tuple> = {
  PARTIAL_COVERAGE: ['部分帳號或日期沒有採集到數據；合計只包含已採集的部分，實際數字可能更高。', 'Some accounts or days have no collected data; totals only include what was collected, so real numbers may be higher.'],
  NON_ADDITIVE_ACROSS_PLATFORMS: ['各平台對「瀏覽」「互動」的計算方式不同，跨平台合計只能當作參考。', 'Platforms count views and engagements differently, so cross-platform totals are only indicative.'],
  ACCOUNT_METRICS_FROM_POSTS: ['部分帳號沒有帳號層級的數據，改用其貼文數據加總。', 'Some accounts have no account-level data; their figures are summed from their posts.'],
  SOURCE_USE_RESTRICTED: ['部分數據來源未授權在看板上顯示，已排除。', 'Some data sources are not allowed to be shown on the dashboard and were left out.'],
};

const metricName: Record<SeriesMetric | 'followers', Tuple> = { views: ['瀏覽', 'views'], engagements: ['互動', 'engagements'], followers: ['粉絲', 'followers'] };
const pick = (text: Tuple, lang: Lang) => text[lang === 'en' ? 1 : 0];
const percent = (ratio: number, lang: Lang) => new Intl.NumberFormat(intlLocale(lang), { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(ratio);
const signed = (value: number, lang: Lang) => new Intl.NumberFormat(intlLocale(lang), { signDisplay: 'exceptZero', notation: Math.abs(value) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);

export function periodText(period: { from: string; to: string } | undefined, lang: Lang) {
  if (!period) return '';
  const days = diffDays(period.from, period.to) + 1;
  const range = `${formatDay(period.from, lang)}–${formatDay(period.to, lang)}`;
  return lang === 'en' ? `${range} (${days} days)` : `${range}（${days} 天）`;
}

/** One sentence answering “how is my social doing?”, saying “not collected” for what is unknown. */
export function socialHeadline(view: SocialData, lang: Lang, names?: Map<string, string>): string {
  const en = lang === 'en';
  const views = view.totals?.views, engagements = view.totals?.engagements;
  const fans = followersTotal(view.accounts ?? []);
  if (!hasAnyData(view)) return en ? `${periodText(view.period, lang)}: no social data has been collected yet.` : `${periodText(view.period, lang)}：還沒有採集到任何社媒數據。`;
  const part = (name: SeriesMetric, metric: Metric | undefined) => {
    if (!metric || !isNum(metric.value)) return en ? `${pick(metricName[name], lang)} not collected` : `${pick(metricName[name], lang)}未採集`;
    const delta = metricDelta(metric);
    const value = formatMeasure(metric.value, 'count', null, lang, true);
    const change = delta === null ? '' : en ? ` (${percent(delta, lang)} vs prior period)` : `（較前期 ${percent(delta, lang)}）`;
    return en ? `${value} ${pick(metricName[name], lang)}${change}` : `${pick(metricName[name], lang)} ${value}${change}`;
  };
  const parts = [part('views', views), part('engagements', engagements)];
  if (fans.delta === 0) parts.push(en ? 'followers unchanged' : '粉絲持平');
  else if (isNum(fans.delta)) parts.push(en ? `${signed(fans.delta, lang)} net followers` : `粉絲淨${fans.delta < 0 ? '減' : '增'} ${signed(Math.abs(fans.delta), lang).replace(/^\+/, '')}`);
  else if (isNum(fans.value)) parts.push(en ? `${formatMeasure(fans.value, 'count', null, lang, true)} followers` : `粉絲 ${formatMeasure(fans.value, 'count', null, lang, true)}`);
  let sentence = en ? `${periodText(view.period, lang)}: ${parts.join(', ')}.` : `${periodText(view.period, lang)}：${parts.join('，')}。`;
  const top = view.top_posts?.[0];
  const ranking = view.series?.metric === 'engagements' ? 'engagements' : 'views';
  const topValue = top?.metrics?.[ranking]?.value;
  if (top && isNum(topValue)) {
    const title = top.title?.trim() || (top.social_account_id && names?.get(top.social_account_id)) || platformLabel(top.platform, lang);
    const short = [...title].length > 24 ? `${[...title].slice(0, 24).join('')}…` : title;
    const amount = formatMeasure(topValue, 'count', null, lang, true);
    sentence += en ? ` Top post: “${short}” (${amount} ${pick(metricName[ranking], lang)}).` : `表現最好的是「${short}」（${pick(metricName[ranking], lang)} ${amount}）。`;
  }
  return sentence;
}
