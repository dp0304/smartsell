import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

// Read-model types shared by the agent-first dashboard (docs/agent-first-design.md §3).
export type Tuple = readonly [zh: string, en: string, hans?: string];
export type Text = Tuple | string;
export type Lang = 'zh' | 'zh-Hans' | 'en';
export type Availability = 'observed' | 'estimated' | 'not_collected' | 'no_permission' | 'source_not_provided' | 'sync_failed' | 'not_applicable';
export interface Metric { value: number | null; availability: Availability | string; previous_value?: number | null; change_ratio?: number | null }
export interface Point { date: string; value: number | null; availability?: Availability | string }
export interface ResourceRef { type: string | null; id: string | null; title?: string | null; version?: number | string | null; hash?: string | null; route?: string | null }
export type Severity = 'blocker' | 'high' | 'normal';
export interface DecisionAction {
  key: string; label: Text; method: string; path: string; version?: number | string | null;
  body?: Record<string, unknown> | null; requires_reason?: boolean; tone?: 'primary' | 'danger' | 'neutral';
  /** Body field that carries the person's reason; null when the endpoint takes none. */
  reason_field?: string | null;
}
export interface DecisionItem {
  id: string; kind: string; severity: Severity; title: string; summary?: string | null; created_at: string; due_at?: string | null;
  brand_id?: string | null; campaign_id?: string | null; requested_by?: { type: 'agent' | 'human' | 'rule'; label?: string | null } | null;
  resource: ResourceRef; preview?: { text?: string | null; fields?: { label: Text; before?: unknown; after?: unknown }[] } | null;
  actions: DecisionAction[];
}
export interface ActivityItem {
  id: string; occurred_at: string; actor: { type: 'agent' | 'human'; user_id?: string | null; credential_id?: string | null; label?: string | null };
  source?: string; action: string; verb?: string; summary: Text; resource?: ResourceRef | null; count?: number;
}
export interface CalendarEvent {
  id: string; kind: string; starts_at: string; ends_at?: string | null; all_day?: boolean; title: string; status?: string | null;
  platform?: string | null; brand_id?: string | null; campaign_id?: string | null; social_account_id?: string | null;
  resource?: ResourceRef | null; needs_human?: 'approval' | 'late_decision' | 'outcome_unknown' | null; permalink?: string | null;
}
export type Unit = 'count' | 'currency' | 'ratio' | 'percent';
export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info';

// Categorical order is fixed and never cycled; status colours are reserved for state.
export const seriesPalette = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;
export const seriesColor = (index: number) => `var(--series-${index + 1}, ${seriesPalette[index] ?? seriesPalette[0]})`;

const LangContext = createContext<Lang>('zh');
export function ViewLang({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}
export const useLang = () => useContext(LangContext);
// Only use this for catalog labels, not record fields or interpolated text.
export function localizedLabel([hant, en, hans]: Tuple, lang: string): string {
  return lang === 'en' ? en : lang === 'zh-Hans' ? hans ?? hant : hant;
}

export function pick(text: Text | null | undefined, lang: Lang): string {
  if (text == null) return '';
  return typeof text === 'string' ? text : localizedLabel(text, lang);
}
export function useT() {
  const lang = useLang();
  return (text: Text | null | undefined) => pick(text, lang);
}
export const intlLocale = (lang: Lang) => lang === 'zh' ? 'zh-Hant' : lang;

type LinkProps = { to: string; className?: string; children: ReactNode; title?: string };
const DefaultLink = ({ to, className, children, title }: LinkProps) => <a href={to} className={className} title={title}>{children}</a>;
const LinkContext = createContext<ComponentType<LinkProps>>(DefaultLink);
/** Lets the app plug its router link in; the package stays router-agnostic. */
export function ViewLinkProvider({ link, children }: { link: ComponentType<LinkProps>; children: ReactNode }) {
  return <LinkContext.Provider value={link}>{children}</LinkContext.Provider>;
}
export function ViewLink(props: LinkProps) {
  const Link = useContext(LinkContext);
  return <Link {...props} />;
}

const ui = {
  notCollected: ['未採集', 'Not collected', '未采集'], noBaseline: ['無前期可比', 'No prior period', '无前期可比'], vsPrevious: ['較前期', 'vs prior period', '较前期'],
  table: ['表格', 'Table'], chart: ['圖表', 'Chart', '图表'], date: ['日期', 'Date'], noData: ['此期間沒有已採集的數據', 'No collected data in this period', '此期间没有已采集的数据'],
  copy: ['複製', 'Copy', '拷贝'], copied: ['已複製', 'Copied', '已拷贝'], copyFailed: ['無法複製，請手動選取', 'Copy failed; select it manually', '无法拷贝，请手动选取'],
  tellAgent: ['請你的 Agent：', 'Tell your agent:', '请你的 Agent：'], openAgent: ['前往 Agent 頁', 'Open the Agent page', '前往 Agent 页'],
  asOf: ['資料時間', 'Data as of', '数据时间'], asOfUnknown: ['資料時間未知', 'Data time unknown', '数据时间未知'], more: ['還有', 'more', '还有'],
  reason: ['理由', 'Reason'], reasonOptional: ['加上理由（選填）', 'Add a reason (optional)', '加上理由（选填）'], reasonRequired: ['此決定需要填寫理由', 'This decision needs a reason', '此决定需要填写理由'],
  confirm: ['確認', 'Confirm', '确认'], cancel: ['取消', 'Cancel'], noActions: ['你目前沒有可用的決定動作', 'No decision actions are available to you', '你目前没有可用的决定动作'],
  due: ['期限', 'Due'], requestedBy: ['提出', 'Requested by'], notSet: ['未設定', 'Not set', '未设置'], before: ['原本', 'Before'], after: ['提議', 'Proposed', '提议'],
  agent: ['Agent', 'Agent'], human: ['人', 'Person'], rule: ['規則', 'Rule', '规则'], showMore: ['展開', 'Show more', '展开'], showLess: ['收合', 'Show less'],
  today: ['今天', 'Today'], needsHuman: ['需要你處理', 'Needs you', '需要你处理'], hiddenSeries: ['其餘系列請看表格', 'More series in the table view', '其余系列请看表格'],
  minorUnits: ['（最小貨幣單位，幣別未提供）', '(minor units, currency missing)', '（最小货币单位，币别未提供）'],
} satisfies Record<string, Tuple>;

export const availabilityText: Record<string, Tuple> = {
  observed: ['已觀測', 'Observed', '已观测'], estimated: ['估算', 'Estimated'], not_collected: ['未採集', 'Not collected', '未采集'],
  no_permission: ['無權限查看', 'No permission', '无权限查看'], source_not_provided: ['來源未提供', 'Source does not provide', '来源未提供'],
  sync_failed: ['同步失敗', 'Sync failed', '同步失败'], not_applicable: ['不適用', 'Not applicable', '不适用'],
};
export const availabilityLabel = (availability: string | null | undefined, lang: Lang) =>
  pick(availabilityText[availability ?? 'not_collected'] ?? ['未知狀態', 'Unknown state', '未知状态'], lang);

export const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function formatNumber(value: number, lang: Lang, compact = false) {
  const short = compact && Math.abs(value) >= 10000;
  return new Intl.NumberFormat(intlLocale(lang), {
    notation: short ? 'compact' : 'standard', maximumFractionDigits: short ? 1 : Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

/** Formats an integer amount in the currency's smallest unit (`*_minor`); null when it cannot be shown honestly. */
// Locale symbols collide across markets ("$" is TWD in zh-Hant and USD in en), so name the currency explicitly.
const currencySymbols: Record<string, string> = { TWD: 'NT$', HKD: 'HK$', USD: 'US$', CNY: 'CN¥', JPY: 'JP¥', SGD: 'S$', MYR: 'RM ', THB: '฿', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$', KRW: '₩', PHP: '₱', VND: '₫', IDR: 'Rp ' };
export function formatMinor(minor: number | null | undefined, currency: string | null | undefined, lang: Lang, compact = false): string | null {
  if (!isNum(minor) || !currency) return null;
  const locale = intlLocale(lang);
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    const major = minor / 10 ** digits;
    const options: Intl.NumberFormatOptions = compact && Math.abs(major) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 }
      : { minimumFractionDigits: Number.isInteger(major) ? 0 : digits, maximumFractionDigits: digits };
    const amount = new Intl.NumberFormat(locale, options).format(Math.abs(major));
    return `${major < 0 ? '-' : ''}${currencySymbols[currency.toUpperCase()] ?? `${currency.toUpperCase()} `}${amount}`;
  } catch {
    return `${new Intl.NumberFormat(locale).format(minor)} ${currency}`;
  }
}

export function formatMeasure(value: number, unit: Unit, currency: string | null | undefined, lang: Lang, compact = false): string {
  if (unit === 'currency') return formatMinor(value, currency, lang, compact) ?? `${formatNumber(value, lang, compact)} ${pick(ui.minorUnits, lang)}`;
  if (unit === 'ratio' || unit === 'percent') {
    return new Intl.NumberFormat(intlLocale(lang), { style: 'percent', maximumFractionDigits: 1 }).format(unit === 'percent' ? value / 100 : value);
  }
  return formatNumber(value, lang, compact);
}

/** Change against the previous period; null when either side is unknown or the base is zero. */
// A change beyond ±1000% almost always means the previous period was barely collected, not that results
// grew a hundredfold; showing it would mislead, so such comparisons are treated as unavailable.
const comparableRatio = 10;
export function metricDelta(metric: Metric | null | undefined): number | null {
  if (!metric) return null;
  const ratio = isNum(metric.change_ratio) ? metric.change_ratio
    : isNum(metric.value) && isNum(metric.previous_value) && metric.previous_value !== 0
      ? (metric.value - metric.previous_value) / Math.abs(metric.previous_value) : null;
  return ratio !== null && Math.abs(ratio) <= comparableRatio ? ratio : null;
}

export function niceTicks(min: number, max: number, count = 4, integer = false): number[] {
  if (!isNum(min) || !isNum(max)) return [];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) return [0, 1];
    min = Math.min(0, min); max = Math.max(0, max);
  }
  const raw = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  if (integer) step = Math.max(1, Math.ceil(step));
  const ticks: number[] = [];
  for (let value = Math.floor(min / step) * step; value <= Math.ceil(max / step) * step + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

/** Splits a series at unknown values so a gap is drawn instead of a fake zero. */
export function lineSegments(values: readonly (number | null | undefined)[]): [index: number, value: number][][] {
  const segments: [number, number][][] = [];
  let open = false;
  values.forEach((value, index) => {
    if (!isNum(value)) { open = false; return; }
    if (!open) segments.push([]);
    segments[segments.length - 1].push([index, value]);
    open = true;
  });
  return segments;
}

const DAY_MS = 86_400_000;
export const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const diffDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Calendar day of an instant in a time zone (YYYY-MM-DD); plain dates pass through. */
export function dayIn(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '';
  if (isDay(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (type: string) => parts.find(part => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function formatDay(day: string, lang: Lang, options: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric' }) {
  if (!isDay(day)) return day;
  return new Intl.DateTimeFormat(intlLocale(lang), { ...options, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}
export function formatTime(value: string, lang: Lang, timeZone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try { return new Intl.DateTimeFormat(intlLocale(lang), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date); }
  catch { return date.toISOString().slice(11, 16); }
}
export function formatDateTime(value: string | null | undefined, lang: Lang, timeZone?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try { return new Intl.DateTimeFormat(intlLocale(lang), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date); }
  catch { return date.toISOString().slice(0, 16).replace('T', ' '); }
}
export function relativeTime(value: string | null | undefined, lang: Lang, now = Date.now()) {
  const at = value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) return '';
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(intlLocale(lang), { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'minute');
}

/** Monday-first month grid covering `YYYY-MM`, trimmed to the weeks that touch the month. */
export function monthGrid(month: string): string[] {
  const first = `${month}-01`;
  const start = addDays(first, -((new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  while (days.length > 28 && days.slice(-7).every(day => !day.startsWith(month))) days.splice(-7);
  return days;
}
export const weekStart = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/** Days an event covers inside [from, to] in the given zone. */
export function eventDays(event: Pick<CalendarEvent, 'starts_at' | 'ends_at'>, timeZone: string | undefined, from: string, to: string): string[] {
  const start = dayIn(event.starts_at, timeZone);
  if (!start) return [];
  const end = (event.ends_at && dayIn(event.ends_at, timeZone)) || start;
  const first = start < from ? from : start;
  const last = end > to ? to : end < start ? start : end;
  if (first > last) return [];
  return Array.from({ length: diffDays(first, last) + 1 }, (_, index) => addDays(first, index));
}

const glyphs: Record<string, ReactNode> = {
  check: <path d="M20 6 9 17l-5-5" />,
  warning: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
  serious: <><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>,
  critical: <><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z" /><path d="m15 9-6 6M9 9l6 6" /></>,
  neutral: <circle cx="12" cy="12" r="4" />,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  bot: <><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  up: <path d="m18 15-6-6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  copy: <><rect x="8" y="8" width="14" height="14" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
};
export function Glyph({ name, size = 14 }: { name: keyof typeof glyphs | string; size?: number }) {
  return <svg className="vs-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyphs[name] ?? glyphs.neutral}</svg>;
}
const toneGlyph: Record<Tone, string> = { good: 'check', warning: 'warning', serious: 'serious', critical: 'critical', neutral: 'neutral', info: 'info' };

export const statusText: Record<string, [Tone, string, string, string?]> = {
  draft: ['neutral', '草稿', 'Draft'], planned: ['neutral', '已規劃', 'Planned', '已规划'], active: ['good', '進行中', 'Active', '进行中'], live: ['good', '進行中', 'Live', '进行中'],
  running: ['info', '執行中', 'Running', '运行中'], scheduled: ['info', '已排程', 'Scheduled', '已调度'], queued: ['info', '排隊中', 'Queued', '排队中'], open: ['info', '待領取', 'Open', '待领取'],
  claimed: ['info', '已領取', 'Claimed', '已领取'], in_progress: ['info', '進行中', 'In progress', '进行中'], in_production: ['info', '製作中', 'In production', '制作中'], wrapping: ['info', '結案中', 'Wrapping up', '结案中'],
  pending: ['warning', '待處理', 'Pending', '待处理'], pending_approval: ['warning', '待審批', 'Pending approval', '待审批'], awaiting_approval: ['warning', '待審批', 'Awaiting approval', '待审批'],
  in_review: ['warning', '審核中', 'In review', '审核中'], submitted: ['warning', '待驗收', 'Submitted', '待验收'], paused: ['warning', '已暫停', 'Paused', '已暂停'], partial: ['warning', '部分完成', 'Partial'],
  stale: ['warning', '已過時', 'Stale', '已过时'], delayed: ['warning', '延遲', 'Delayed', '延迟'], low: ['warning', '庫存偏低', 'Low stock', '库存偏低'],
  approved: ['good', '已核准', 'Approved'], accepted: ['good', '已接受', 'Accepted'], published: ['good', '已發布', 'Published', '已发布'], completed: ['good', '已完成', 'Completed'],
  done: ['good', '已完成', 'Done'], succeeded: ['good', '成功', 'Succeeded'], applied: ['good', '已套用', 'Applied'], verified: ['good', '已核實', 'Verified', '已核实'],
  in_stock: ['good', '有庫存', 'In stock', '有库存'], connected: ['good', '已連線', 'Connected', '已连接'],
  changes_requested: ['serious', '需修改', 'Changes requested'], returned: ['serious', '已退回', 'Returned'], rejected: ['serious', '已拒絕', 'Rejected', '已拒绝'],
  lease_expired: ['serious', '租約逾時', 'Lease expired', '租约逾时'], outcome_unknown: ['serious', '結果待核實', 'Outcome unknown', '结果待核实'], expired: ['serious', '已過期', 'Expired', '已过期'],
  failed: ['critical', '失敗', 'Failed', '失败'], blocked: ['critical', '受阻', 'Blocked'], out_of_stock: ['critical', '缺貨', 'Out of stock', '缺货'], sync_failed: ['critical', '同步失敗', 'Sync failed', '同步失败'],
  revoked: ['neutral', '已撤銷', 'Revoked', '已撤销'], cancelled: ['neutral', '已取消', 'Cancelled'], closed: ['neutral', '已結案', 'Closed', '已结案'], ended: ['neutral', '已結束', 'Ended', '已结束'],
  archived: ['neutral', '已封存', 'Archived'], superseded: ['neutral', '已被取代', 'Superseded'], unknown: ['neutral', '未知', 'Unknown'], not_tracked: ['neutral', '未追蹤', 'Not tracked', '未追踪'],
  approval: ['warning', '待審批', 'Needs approval', '待审批'], late_decision: ['warning', '逾時待決定', 'Late, needs a decision', '逾时待决定'],
  blocker: ['critical', '阻擋', 'Blocker', '阻挡'], high: ['serious', '高優先', 'High', '高优先'], normal: ['neutral', '一般', 'Normal'],
};
export function statusInfo(status: string | null | undefined, lang: Lang): { tone: Tone; label: string } {
  const key = status ?? 'unknown';
  const known = statusText[key];
  if (known) return { tone: known[0], label: pick([known[1], known[2], known[3]], lang) };
  return { tone: 'neutral', label: key.replace(/_/g, ' ') };
}

export function StatusChip({ status, label, tone }: { status: string | null | undefined; label?: Text; tone?: Tone }) {
  const lang = useLang();
  const info = statusInfo(status, lang);
  const shown = tone ?? info.tone;
  return <span className={`vs-chip tone-${shown}`} data-status={status ?? undefined}><Glyph name={toneGlyph[shown]} size={12} />{label ? pick(label, lang) : info.label}</span>;
}

export function AvailabilityTag({ availability }: { availability: string | null | undefined }) {
  const lang = useLang();
  const tone: Tone = availability === 'sync_failed' ? 'serious' : availability === 'estimated' ? 'info' : 'neutral';
  return <span className={`vs-tag tone-${tone}`} data-availability={availability ?? 'not_collected'}>{availabilityLabel(availability, lang)}</span>;
}

export function KpiTile({ label, metric, unit = 'count', currency, sparkline, goodDirection = 'up', href, icon }: {
  label: string; metric: Metric | null | undefined; unit?: Unit; currency?: string | null; sparkline?: readonly Point[];
  goodDirection?: 'up' | 'down' | 'none'; href?: string; icon?: ReactNode;
}) {
  const lang = useLang();
  const value = metric?.value;
  const known = isNum(value);
  const availability = metric?.availability ?? 'not_collected';
  const delta = known ? metricDelta(metric) : null;
  const direction = delta === null || delta === 0 ? null : delta > 0 ? 'up' : 'down';
  const deltaTone = !direction || goodDirection === 'none' ? 'neutral' : direction === goodDirection ? 'good' : 'serious';
  const body = <>
    <span className="vs-kpi-label">{icon && <span className="vs-kpi-icon">{icon}</span>}{label}</span>
    <strong className={known ? 'vs-kpi-value' : 'vs-kpi-value unknown'}>{known ? formatMeasure(value, unit, currency, lang, true) : '—'}</strong>
    <span className="vs-kpi-meta">
      {(!known || availability !== 'observed') && <AvailabilityTag availability={availability} />}
      {known && (delta === null ? <small className="muted">{pick(ui.noBaseline, lang)}</small> :
        <span className={`vs-delta tone-${deltaTone}`}>{direction && <Glyph name={direction} size={12} />}
          {new Intl.NumberFormat(intlLocale(lang), { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(delta)}
          <small>{pick(ui.vsPrevious, lang)}</small></span>)}
    </span>
    {sparkline && sparkline.length > 0 && <Sparkline points={sparkline} label={label} />}
  </>;
  return href ? <ViewLink to={href} className="vs-kpi">{body}</ViewLink> : <article className="vs-kpi">{body}</article>;
}

export function Sparkline({ points, label, width = 132, height = 36 }: { points: readonly (Point | number | null)[]; label: string; width?: number; height?: number }) {
  const lang = useLang();
  const values = points.map(point => point === null || typeof point === 'number' ? point : point.value);
  const known = values.filter(isNum);
  const pad = 6;
  if (!known.length) {
    return <svg className="vs-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${pick(ui.noData, lang)}`}>
      <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} className="vs-spark-empty" />
    </svg>;
  }
  const min = Math.min(...known), max = Math.max(...known);
  const x = (index: number) => pad + (values.length <= 1 ? (width - 2 * pad) / 2 : index * (width - 2 * pad) / (values.length - 1));
  const y = (value: number) => max === min ? height / 2 : height - pad - ((value - min) / (max - min)) * (height - 2 * pad);
  const segments = lineSegments(values);
  const last = segments[segments.length - 1][segments[segments.length - 1].length - 1];
  const summary = `${label}: ${formatNumber(known[0], lang, true)} → ${formatNumber(last[1], lang, true)}`;
  return <svg className="vs-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
    {segments.map(segment => segment.length > 1
      ? <path key={segment[0][0]} d={segment.map(([index, value], i) => `${i ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join('')} className="vs-line" stroke={seriesColor(0)} />
      : <circle key={segment[0][0]} cx={x(segment[0][0])} cy={y(segment[0][1])} r={2.5} fill={seriesColor(0)} />)}
    <circle cx={x(last[0])} cy={y(last[1])} r={4} fill={seriesColor(0)} className="vs-dot" />
  </svg>;
}

function useWidth(visible: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(240);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!visible || !element) return;
    const measure = (size: number) => { if (size >= 1) setWidth(Math.floor(size)); };
    measure(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry) measure(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  return [ref, width] as const;
}

function ChartToggle({ table, setTable }: { table: boolean; setTable: (value: boolean) => void }) {
  const lang = useLang();
  return <button type="button" className="vs-chart-toggle" aria-pressed={table} onClick={() => setTable(!table)}>{pick(table ? ui.chart : ui.table, lang)}</button>;
}

// Place the violet series after blue in line charts without changing calendar kind colors.
const lineColorOrder = [0, 6, 1, 2, 3, 4, 5, 7];
const lineColor = (index: number) => seriesColor(lineColorOrder[index]);
const lineDash = (index: number) => index === 1 ? '4 3' : undefined;

function LineKey({ index }: { index: number }) {
  return <svg width={14} height={8} viewBox="0 0 14 8" aria-hidden="true">
    <line className="vs-line" x1={1} x2={13} y1={4} y2={4} stroke={lineColor(index)} strokeDasharray={lineDash(index)} />
  </svg>;
}

export interface LineSeries { key: string; label: string; points: readonly Point[] }
export function LineChart({ series, title, height = 220, unit = 'count', currency }: {
  series: readonly LineSeries[]; title: string; height?: number; unit?: Unit; currency?: string | null;
}) {
  const lang = useLang();
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const dates = [...new Set(series.flatMap(item => item.points.map(point => point.date)))].sort();
  const aligned = series.map(item => {
    const byDate = new Map(item.points.map(point => [point.date, point]));
    return dates.map(date => byDate.get(date) ?? null);
  });
  const shown = series.slice(0, lineColorOrder.length);
  const known = aligned.slice(0, shown.length).flat().map(point => point?.value).filter(isNum);
  const hasData = known.length > 0;
  const [ref, width] = useWidth(hasData && !table);
  const integer = (unit === 'count' || unit === 'currency') && known.every(Number.isInteger);
  const ticks = hasData ? niceTicks(Math.min(0, ...known), Math.max(0, ...known), 4, integer) : [0, 1];
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const formatAxis = (value: number) => unit === 'currency' && !currency ? formatNumber(value, lang, true) : formatMeasure(value, unit, currency, lang, true);
  const left = clamp(14 + Math.max(...ticks.map(value => formatAxis(value).length)) * 7, 34, 110), right = 16, top = 12, bottom = 26;
  const plotW = Math.max(40, width - left - right), plotH = Math.max(40, height - top - bottom);
  const x = (index: number) => left + (dates.length <= 1 ? plotW / 2 : index * plotW / (dates.length - 1));
  const y = (value: number) => top + plotH - ((value - lo) / (hi - lo || 1)) * plotH;
  const tickCount = Math.min(dates.length, Math.max(2, Math.floor(plotW / 70) + 1));
  const dateTicks = Array.from({ length: tickCount }, (_, index) => Math.round(index * (dates.length - 1) / Math.max(1, tickCount - 1)));
  const nearest = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return clamp(Math.round(((event.clientX - box.left - left) / plotW) * (dates.length - 1)), 0, dates.length - 1);
  };
  const keys = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!dates.length) return;
    const current = hover ?? dates.length - 1;
    const next = event.key === 'ArrowLeft' ? current - 1 : event.key === 'ArrowRight' ? current + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? dates.length - 1 : null;
    if (event.key === 'Escape') setHover(null);
    if (next === null) return;
    event.preventDefault();
    setHover(clamp(next, 0, dates.length - 1));
  };
  const cell = (entry: Point | null) => entry && isNum(entry.value) ? formatMeasure(entry.value, unit, currency, lang) : availabilityLabel(entry?.availability, lang);
  const active = hover !== null && dates[hover] ? hover : null;
  const pointer = (event: PointerEvent<SVGSVGElement>) => setHover(nearest(event));
  return <figure className="vs-chart" aria-label={title}>
    {(series.length >= 2 || dates.length > 0) && <div className="vs-chart-head">
      {series.length >= 2 && <ul className="vs-legend">{shown.map((item, index) => <li key={item.key}><LineKey index={index} />{item.label}</li>)}
        {series.length > shown.length && <li className="muted">{pick(ui.hiddenSeries, lang)}</li>}</ul>}
      {dates.length > 0 && <ChartToggle table={table} setTable={setTable} />}
    </div>}
    {table && dates.length > 0 ? <div className="vs-table-scroll" tabIndex={0} role="region" aria-label={title}><table className="vs-table"><caption className="vs-sr">{title}</caption>
      <thead><tr><th scope="col">{pick(ui.date, lang)}</th>{series.map(item => <th scope="col" key={item.key}>{item.label}</th>)}</tr></thead>
      <tbody>{dates.map((date, row) => <tr key={date}><th scope="row">{date}</th>{aligned.map((column, index) => <td key={series[index].key}>{cell(column[row])}</td>)}</tr>)}</tbody>
    </table></div> : !hasData ? <p className="vs-chart-empty muted">{pick(ui.noData, lang)}</p> : <div className="vs-chart-body" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={title} tabIndex={0}
        onPointerMove={pointer} onPointerDown={pointer} onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(current => current ?? dates.length - 1)} onBlur={() => setHover(null)} onKeyDown={keys}>
        {ticks.map(value => <g key={value}><line className="vs-grid" x1={left} x2={left + plotW} y1={y(value)} y2={y(value)} />
          <text className="vs-axis" x={left - 6} y={y(value)} dy="0.32em" textAnchor="end">{formatAxis(value)}</text></g>)}
        {dateTicks.map(index => <text key={dates[index]} className="vs-axis" x={x(index)} y={top + plotH + 18}
          textAnchor={dates.length === 1 ? 'middle' : index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle'}>{formatDay(dates[index], lang)}</text>)}
        {shown.map((item, index) => lineSegments(aligned[index].map(entry => entry?.value)).map(segment => segment.length > 1
          ? <path key={`${item.key}-${segment[0][0]}`} className="vs-line" stroke={lineColor(index)} strokeDasharray={lineDash(index)} d={segment.map(([at, value], i) => `${i ? 'L' : 'M'}${x(at).toFixed(1)},${y(value).toFixed(1)}`).join('')} />
          : <circle key={`${item.key}-${segment[0][0]}`} className="vs-dot" r={4} cx={x(segment[0][0])} cy={y(segment[0][1])} fill={lineColor(index)} />))}
        {active !== null && <g className="vs-crosshair"><line x1={x(active)} x2={x(active)} y1={top} y2={top + plotH} />
          {shown.map((item, index) => { const entry = aligned[index][active]; return entry && isNum(entry.value) ? <circle key={item.key} className="vs-dot" r={4} cx={x(active)} cy={y(entry.value)} fill={lineColor(index)} /> : null; })}</g>}
      </svg>
      {active !== null && <div className="vs-tooltip vs-line-tooltip" style={{ left: clamp(x(active) + (x(active) < width / 2 ? 10 : -250), 0, Math.max(0, width - 240)), top }} role="status">
        <small>{formatDay(dates[active], lang, { year: 'numeric', month: 'numeric', day: 'numeric' })}</small>
        {shown.map((item, index) => <div key={item.key} className="vs-tooltip-row"><LineKey index={index} />
          <strong>{cell(aligned[index][active])}</strong><span>{item.label}</span></div>)}
      </div>}
    </div>}
  </figure>;
}

export interface Bar { key: string; label: string; value: number | null; availability?: string }
const textWidth = (text: string, size = 12) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? size : size * 0.58), 0);
function fit(text: string, max: number) {
  if (textWidth(text) <= max) return text;
  let out = '';
  for (const char of text) { if (textWidth(`${out}${char}…`) > max) break; out += char; }
  return `${out}…`;
}
/** Horizontal bars with the value at the tip; unknown values draw no bar. */
export function BarChart({ bars, title, unit = 'count', currency }: { bars: readonly Bar[]; title: string; unit?: Unit; currency?: string | null }) {
  const lang = useLang();
  const [table, setTable] = useState(false);
  const [ref, width] = useWidth(!table);
  const known = bars.map(bar => bar.value).filter(isNum);
  const lo = Math.min(0, ...known), hi = Math.max(0, ...known);
  const format = (value: number) => formatMeasure(value, unit, currency, lang, true);
  const labelW = clamp(Math.max(0, ...bars.map(bar => textWidth(bar.label))) + 12, 60, Math.min(200, width * 0.36));
  const valueW = 64, row = 32, thick = 16;
  const plotW = Math.max(40, width - labelW - valueW);
  const x = (value: number) => labelW + ((value - lo) / (hi - lo || 1)) * plotW;
  const height = bars.length * row + 4;
  return <figure className="vs-chart" aria-label={title}>
    <div className="vs-chart-head"><span /><ChartToggle table={table} setTable={setTable} /></div>
    {table ? <div className="vs-table-scroll"><table className="vs-table"><caption className="vs-sr">{title}</caption>
      <tbody>{bars.map(bar => <tr key={bar.key}><th scope="row">{bar.label}</th><td>{isNum(bar.value) ? format(bar.value) : availabilityLabel(bar.availability, lang)}</td></tr>)}</tbody>
    </table></div> : <div className="vs-chart-body" ref={ref}><svg width={width} height={height} role="img" aria-label={title}>
      <line className="vs-grid" x1={x(0)} x2={x(0)} y1={0} y2={height} />
      {bars.map((bar, index) => {
        const mid = index * row + row / 2;
        const value = bar.value;
        const name = `${bar.label}: ${isNum(value) ? format(value) : availabilityLabel(bar.availability, lang)}`;
        return <g key={bar.key} className="vs-bar" tabIndex={0} aria-label={name}><title>{name}</title>
          <rect x={0} y={index * row} width={width} height={row} fill="transparent" />
          <text className="vs-axis vs-bar-label" x={labelW - 8} y={mid} dy="0.32em" textAnchor="end">{fit(bar.label, labelW - 12)}</text>
          {isNum(value) ? <>
            <path d={barPath(Math.min(x(0), x(value)), mid - thick / 2, Math.abs(x(value) - x(0)), thick, value >= 0 ? 'end' : 'start')} fill={seriesColor(0)} />
            <text className="vs-axis vs-bar-value" x={Math.max(x(0), x(value)) + 6} y={mid} dy="0.32em">{format(value)}</text>
          </> : <text className="vs-axis muted" x={x(0) + 6} y={mid} dy="0.32em">{availabilityLabel(bar.availability, lang)}</text>}
        </g>;
      })}
    </svg></div>}
  </figure>;
}
/** A bar rounded only at its data end (4px), square at the baseline. */
export function barPath(x: number, y: number, width: number, height: number, round: 'start' | 'end') {
  const r = Math.min(4, width / 2, height / 2);
  if (width <= 0) return '';
  return round === 'end'
    ? `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`
    : `M${x + width},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + height - r}Q${x},${y + height} ${x + r},${y + height}H${x + width}Z`;
}

export interface TimelineItem { id: string; label: string; start: string; end?: string | null; status?: string | null; href?: string }
export interface TimelineLane { id: string; label: string; href?: string; items: readonly TimelineItem[] }
/** Gantt lanes over an inclusive day range; items without an end render as a milestone mark. */
export function Timeline({ lanes, from, to, today, timeZone }: { lanes: readonly TimelineLane[]; from: string; to: string; today?: string; timeZone?: string }) {
  const lang = useLang();
  const total = Math.max(1, diffDays(from, to) + 1);
  const pct = (day: string) => (diffDays(from, day) / total) * 100;
  const step = total > 120 ? 30 : total > 45 ? 14 : 7;
  const ticks = Array.from({ length: Math.ceil(total / step) }, (_, index) => addDays(from, index * step));
  const marker = today && today >= from && today <= to ? pct(today) + 50 / total : null;
  return <div className="vs-timeline" role="list">
    <div className="vs-timeline-head" aria-hidden="true"><span />
      <div className="vs-timeline-track">{ticks.map(day => <span key={day} style={{ left: `${pct(day)}%` }}>{formatDay(day, lang)}</span>)}
        {marker !== null && <i className="vs-today" style={{ left: `${marker}%` }} />}</div></div>
    {lanes.map(lane => <div key={lane.id} className="vs-timeline-lane" role="listitem">
      <span className="vs-timeline-label">{lane.href ? <ViewLink to={lane.href}>{lane.label}</ViewLink> : lane.label}</span>
      <div className="vs-timeline-track">
        {marker !== null && <i className="vs-today" style={{ left: `${marker}%` }} aria-hidden="true" />}
        {lane.items.map(item => {
          const start = dayIn(item.start, timeZone);
          const end = item.end ? dayIn(item.end, timeZone) : '';
          if (!start || (end || start) < from || start > to) return null;
          const first = start < from ? from : start;
          const last = !end ? first : end > to ? to : end;
          const span = `${formatDay(start, lang)}${end && end !== start ? ` – ${formatDay(end, lang)}` : ''}`;
          const info = statusInfo(item.status, lang);
          const content = <span className="vs-timeline-text">{item.label}</span>;
          const style = { left: `${pct(first)}%`, width: end ? `${((diffDays(first, last) + 1) / total) * 100}%` : undefined };
          const className = `vs-timeline-bar tone-${info.tone}${end ? '' : ' milestone'}`;
          const name = `${item.label} · ${span}${item.status ? ` · ${info.label}` : ''}`;
          return item.href ? <ViewLink key={item.id} to={item.href} className={className} title={name}><span style={style} className="vs-timeline-fill" aria-label={name}>{content}</span></ViewLink>
            : <span key={item.id} className={className} title={name}><span style={style} className="vs-timeline-fill" aria-label={name}>{content}</span></span>;
        })}
      </div>
    </div>)}
  </div>;
}

export const eventKindText: Record<string, Tuple> = {
  publish: ['發布排期', 'Scheduled post', '发布排期'], post: ['已發布', 'Published post', '已发布'], plan: ['推廣期間', 'Plan period', '推广期间'], milestone: ['里程碑', 'Milestone'],
  production_due: ['製作期限', 'Production due', '制作期限'], deliverable_due: ['達人交付', 'Creator deliverable', '达人交付'], live: ['直播', 'Live stream'],
  ad_flight: ['投放檔期', 'Ad flight', '投放档期'], promotion: ['促銷', 'Promotion', '促销'],
};
// Plan periods are context bands, so they stay neutral and the eight series hues go to the point events.
const kindColor: Record<string, string> = {
  publish: seriesColor(0), production_due: seriesColor(1), post: seriesColor(2), milestone: seriesColor(3), deliverable_due: seriesColor(4),
  ad_flight: seriesColor(5), promotion: seriesColor(6), live: seriesColor(7), plan: 'var(--vs-band, rgba(205, 211, 233, .4))',
};
const weekdayText: Tuple[] = [['一', 'Mon'], ['二', 'Tue'], ['三', 'Wed'], ['四', 'Thu'], ['五', 'Fri'], ['六', 'Sat'], ['日', 'Sun']];

function EventChip({ event, timeZone, href, onEvent }: { event: CalendarEvent; timeZone?: string; href?: string; onEvent?: (event: CalendarEvent) => void }) {
  const lang = useLang();
  const time = event.all_day || isDay(event.starts_at) ? '' : formatTime(event.starts_at, lang, timeZone);
  const name = `${pick(eventKindText[event.kind] ?? [event.kind, event.kind], lang)} · ${time ? `${time} ` : ''}${event.title}${event.needs_human ? ` · ${pick(ui.needsHuman, lang)}` : ''}`;
  const body = <><i className="vs-event-key" style={{ background: kindColor[event.kind] ?? 'var(--muted)' }} />{event.needs_human && <Glyph name="warning" size={11} />}
    {time && <time>{time}</time>}<span>{event.title}</span></>;
  const className = `vs-event kind-${event.kind}${event.needs_human ? ' needs-human' : ''}`;
  if (href) return <ViewLink to={href} className={className} title={name}>{body}</ViewLink>;
  if (onEvent) return <button type="button" className={className} title={name} aria-label={name} onClick={() => onEvent(event)}>{body}</button>;
  return <span className={className} title={name} aria-label={name}>{body}</span>;
}

const startOrder = (event: CalendarEvent) => `${event.ends_at && event.ends_at > event.starts_at ? 0 : 1}${event.starts_at}`;
export function MonthCalendar({ month, events, mode = 'month', week, timeZone, today, maxPerDay = 3, eventHref, onEvent, onDay }: {
  month: string; events: readonly CalendarEvent[]; mode?: 'month' | 'week'; week?: string; timeZone?: string; today?: string;
  maxPerDay?: number; eventHref?: (event: CalendarEvent) => string | undefined; onEvent?: (event: CalendarEvent) => void; onDay?: (day: string) => void;
}) {
  const lang = useLang();
  const [expanded, setExpanded] = useState<string | null>(null);
  const days = mode === 'week' ? Array.from({ length: 7 }, (_, index) => addDays(weekStart(week ?? today ?? `${month}-01`), index)) : monthGrid(month);
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of [...events].sort((a, b) => startOrder(a).localeCompare(startOrder(b)))) {
    for (const day of eventDays(event, timeZone, days[0], days[days.length - 1])) byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  const kinds = [...new Set(events.map(event => event.kind))];
  const legend = kinds.length > 0 && <ul className="vs-legend vs-cal-legend">{kinds.map(kind => <li key={kind}><span className="vs-key-box" style={{ background: kindColor[kind] ?? 'var(--muted)' }} />{pick(eventKindText[kind] ?? [kind, kind], lang)}</li>)}</ul>;
  if (mode === 'week') {
    return <div className="vs-cal-week">{legend}{days.map((day, index) => {
      const list = byDay.get(day) ?? [];
      return <section key={day} className={day === today ? 'vs-cal-weekday today' : 'vs-cal-weekday'}>
        <h4>{pick(weekdayText[index], lang)} · {formatDay(day, lang)}{day === today && <small> · {pick(ui.today, lang)}</small>}</h4>
        {list.length ? <ul>{list.map(event => <li key={`${event.id}-${day}`}><EventChip event={event} timeZone={timeZone} href={eventHref?.(event)} onEvent={onEvent} />
          <small className="muted">{pick(eventKindText[event.kind] ?? [event.kind, event.kind], lang)}</small>{event.status && <StatusChip status={event.status} />}</li>)}</ul> : <p className="muted">—</p>}
      </section>;
    })}</div>;
  }
  return <div className="vs-cal">{legend}
    <div className="vs-cal-grid" role="grid" aria-label={month}>
      <div className="vs-cal-row" role="row">{weekdayText.map(day => <span key={day[1]} role="columnheader" className="vs-cal-dow">{pick(day, lang)}</span>)}</div>
      {Array.from({ length: days.length / 7 }, (_, row) => <div className="vs-cal-row" role="row" key={row}>{days.slice(row * 7, row * 7 + 7).map(day => {
        const list = byDay.get(day) ?? [];
        const open = expanded === day;
        const visible = open ? list : list.slice(0, maxPerDay);
        const hidden = list.length - visible.length;
        return <div key={day} role="gridcell" className={`vs-cal-day${day.startsWith(month) ? '' : ' outside'}${day === today ? ' today' : ''}`}>
          <span className="vs-cal-date">{Number(day.slice(8))}</span>
          {visible.map(event => <EventChip key={`${event.id}-${day}`} event={event} timeZone={timeZone} href={eventHref?.(event)} onEvent={onEvent} />)}
          {hidden > 0 && <button type="button" className="vs-cal-more" onClick={() => onDay ? onDay(day) : setExpanded(day)}>+{hidden}<span className="vs-sr"> {pick(ui.more, lang)}</span></button>}
          {open && list.length > maxPerDay && <button type="button" className="vs-cal-more" onClick={() => setExpanded(null)}>{pick(ui.showLess, lang)}</button>}
        </div>;
      })}</div>)}
    </div>
  </div>;
}

export function CopyButton({ text, label, className = 'vs-btn' }: { text: string; label?: Text; className?: string }) {
  const lang = useLang();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setState('done'); }
    catch { setState('failed'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2500);
  }
  return <button type="button" className={className} onClick={() => void copy()} aria-live="polite">
    <Glyph name={state === 'done' ? 'check' : 'copy'} />{state === 'done' ? pick(ui.copied, lang) : state === 'failed' ? pick(ui.copyFailed, lang) : pick(label ?? ui.copy, lang)}
  </button>;
}

export function AgentPrompt({ title, prompt, detail, agentHref }: { title: string; prompt: string; detail?: string; agentHref?: string }) {
  const lang = useLang();
  return <div className="vs-prompt">
    <strong className="vs-prompt-title">{title}</strong>
    {detail && <p className="muted">{detail}</p>}
    <p className="vs-prompt-lead"><Glyph name="bot" />{pick(ui.tellAgent, lang)}</p>
    <blockquote className="vs-prompt-text">{lang === 'en' ? `“${prompt}”` : `「${prompt}」`}</blockquote>
    <div className="vs-actions"><CopyButton text={prompt} />{agentHref && <ViewLink to={agentHref} className="vs-btn ghost">{pick(ui.openAgent, lang)}</ViewLink>}</div>
  </div>;
}

export function Freshness({ asOf, availability, timeZone }: { asOf?: string | null; availability?: string | null; timeZone?: string }) {
  const lang = useLang();
  const valid = asOf && !Number.isNaN(Date.parse(asOf));
  return <span className="vs-fresh"><Glyph name="info" size={12} />
    {valid ? <>{pick(ui.asOf, lang)} <time dateTime={asOf} title={formatDateTime(asOf, lang, timeZone)}>{relativeTime(asOf, lang)}</time></> : pick(ui.asOfUnknown, lang)}
    {availability && availability !== 'observed' && availability !== 'available' && <AvailabilityTag availability={availability} />}
  </span>;
}

export const decisionKindText: Record<string, Tuple> = {
  publish_approval: ['發布審批', 'Publish approval', '发布审批'], change_set: ['變更集', 'Change set', '变更集'], agent_job_review: ['Agent 工作驗收', 'Agent job review', 'Agent 工作验收'],
  reply_draft: ['回覆草稿', 'Reply draft', '回复草稿'], ad_proposal: ['投放方案', 'Ad proposal'], brief_revision: ['簡報修訂', 'Brief revision', '演示文稿修订'],
  budget_approval: ['預算審批', 'Budget approval', '预算审批'], fact_revision: ['商品事實', 'Product fact', '商品事实'], knowledge_revision: ['品牌知識', 'Brand knowledge', '品牌知识'],
  localization: ['本地化', 'Localization'], late_decision: ['逾時發布', 'Late publication', '逾时发布'],
};
const severityTone: Record<string, Tone> = { blocker: 'critical', high: 'serious', normal: 'neutral' };

// Decision previews carry API values; show them the way a person reads them (platform names, local times, money).
const platformNames: Record<string, string> = {
  meta_instagram: 'Instagram', instagram: 'Instagram', meta_facebook: 'Facebook', facebook: 'Facebook', tiktok: 'TikTok',
  youtube: 'YouTube', douyin: '抖音', xiaohongshu: '小紅書', shopify: 'Shopify', tiktok_shop: 'TikTok Shop', amazon_sp: 'Amazon', shopee: 'Shopee',
};
export const platformName = (value: string | null | undefined, lang?: Lang) => {
  const key = value?.toLowerCase() ?? '';
  if (key === 'xiaohongshu' && lang === 'zh-Hans') return '小红书';
  return (Object.hasOwn(platformNames, key) && platformNames[key]) || value || '';
};
const enumText: Record<string, Tuple> = {
  OUTCOME_SALES: ['銷售轉換', 'Sales', '销售转换'], OUTCOME_TRAFFIC: ['導流', 'Traffic', '导流'], OUTCOME_AWARENESS: ['品牌知名度', 'Awareness'],
  OUTCOME_ENGAGEMENT: ['互動', 'Engagement', '交互'], OUTCOME_LEADS: ['名單', 'Leads', '名单'], OUTCOME_APP_PROMOTION: ['App 推廣', 'App promotion', 'App 推广'],
  daily: ['每日', 'Daily'], lifetime: ['總額', 'Lifetime', '总额'], pause: ['暫停', 'Pause', '暂停'], resume: ['恢復', 'Resume', '恢复'], create: ['新建', 'Create'],
  public: ['公開', 'Public', '公开'], private: ['私人', 'Private'], unlisted: ['不公開', 'Unlisted', '不公开'], followers: ['僅追蹤者', 'Followers only', '仅追踪者'],
};
const isoInstant = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;
const localMinute = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/;
export function readableValue(value: unknown, lang: Lang, timeZone?: string, unit?: string, currency?: string | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (unit === 'currency' && typeof value === 'number') return formatMinor(value, currency, lang) ?? String(value);
  if (typeof value === 'number') return formatNumber(value, lang);
  if (typeof value === 'boolean') return lang === 'en' ? (value ? 'Yes' : 'No') : (value ? '是' : '否');
  if (typeof value !== 'string') return JSON.stringify(value);
  if (isoInstant.test(value)) return formatDateTime(value, lang, timeZone);
  const local = localMinute.exec(value);
  if (local) return `${Number(local[2])}/${Number(local[3])} ${local[4]}:${local[5]}`;
  if (Object.hasOwn(platformNames, value.toLowerCase())) return platformName(value, lang);
  if (enumText[value]) return pick(enumText[value], lang);
  return value;
}
function fieldValue(value: unknown, lang: Lang, timeZone?: string, unit?: string, currency?: string | null) {
  const text = readableValue(value, lang, timeZone, unit, currency);
  return text === null ? <span className="muted">{pick(ui.notSet, lang)}</span> : text;
}
/** Server summaries join raw tokens with " · "; translate each token the same way as preview values. */
const readableSummary = (summary: string, lang: Lang, timeZone?: string) =>
  summary.split(' · ').map(token => readableValue(token, lang, timeZone) ?? token).join(' · ');

export function ActorBadge({ type, label }: { type: 'agent' | 'human' | 'rule' | string; label?: string | null }) {
  const lang = useLang();
  const kind = type === 'agent' ? 'agent' : type === 'rule' ? 'rule' : 'human';
  return <span className={`vs-actor ${kind}`}><Glyph name={kind === 'agent' ? 'bot' : kind === 'rule' ? 'info' : 'user'} size={12} />{label || pick(ui[kind], lang)}</span>;
}

/** One decision: what the agent proposed, then one click (a reason only when the action needs it). */
export function DecisionCard({ item, onAction, busyKey, error, compact = false, href, timeZone }: {
  item: DecisionItem; onAction?: (action: DecisionAction, reason?: string) => unknown; busyKey?: string | null; error?: ReactNode;
  compact?: boolean; href?: string; timeZone?: string;
}) {
  const lang = useLang();
  const reasonId = useId();
  const [asking, setAsking] = useState<DecisionAction | null>(null);
  const [optional, setOptional] = useState(false);
  const [reason, setReason] = useState('');
  const [expanded, setExpanded] = useState(!compact);
  const fields = (item.preview?.fields ?? []) as { label: Text; before?: unknown; after?: unknown; unit?: string; currency?: string | null }[];
  const text = item.preview?.text;
  // A brand-new proposal has nothing "before"; show a plain list instead of an empty comparison column.
  const comparing = fields.some(field => field.before !== undefined && field.before !== null);
  const busy = Boolean(busyKey);
  const run = (action: DecisionAction) => {
    if (action.requires_reason && !reason.trim()) { setAsking(action); return; }
    onAction?.(action, reason.trim() || undefined);
  };
  const tone = (action: DecisionAction) => action.tone === 'primary' ? 'vs-btn primary-soft' : action.tone === 'danger' ? 'vs-btn danger' : 'vs-btn';
  return <article className={`vs-decision severity-${item.severity}`} aria-busy={busy || undefined}>
    <header className="vs-decision-head">
      <span className="vs-decision-kind">{pick(decisionKindText[item.kind] ?? [item.kind, item.kind], lang)}</span>
      {item.severity !== 'normal' && <StatusChip status={item.severity} tone={severityTone[item.severity]} />}
      {item.requested_by && <ActorBadge type={item.requested_by.type} label={item.requested_by.label} />}
      <time className="muted" dateTime={item.created_at} title={formatDateTime(item.created_at, lang, timeZone)}>{relativeTime(item.created_at, lang)}</time>
      {item.due_at && <span className="muted">{pick(ui.due, lang)} {formatDateTime(item.due_at, lang, timeZone)}</span>}
    </header>
    <h3>{href ? <ViewLink to={href}>{item.title}</ViewLink> : item.title}</h3>
    {item.summary && <p className="muted">{readableSummary(item.summary, lang, timeZone)}</p>}
    {(text || fields.length > 0) && <div className={expanded ? 'vs-decision-preview' : 'vs-decision-preview clamped'}>
      {text && <p className="vs-preview-text">{text}</p>}
      {comparing && <div className="vs-diff-row vs-diff-head" aria-hidden="true"><span /><span>{pick(ui.before, lang)}</span><span>{pick(ui.after, lang)}</span></div>}
      {fields.length > 0 && <dl className={comparing ? 'vs-diff' : 'vs-diff vs-fields'}>
        {fields.map((field, index) => <div key={index} className={comparing && JSON.stringify(field.before) === JSON.stringify(field.after) ? 'vs-diff-row same' : 'vs-diff-row'}>
        <dt>{pick(field.label, lang)}</dt>
        {comparing && <dd className="before"><small>{pick(ui.before, lang)}</small>{fieldValue(field.before, lang, timeZone, field.unit, field.currency)}</dd>}
        <dd className="after">{comparing && <small>{pick(ui.after, lang)}</small>}{fieldValue(field.after, lang, timeZone, field.unit, field.currency)}</dd>
      </div>)}</dl>}
    </div>}
    {compact && (text || fields.length > 0) && <button type="button" className="vs-link-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{pick(expanded ? ui.showLess : ui.showMore, lang)}</button>}
    {(asking || optional) && <div className="vs-reason">
      <label htmlFor={reasonId}>{pick(asking ? ui.reasonRequired : ui.reason, lang)}</label>
      <textarea id={reasonId} rows={2} maxLength={2000} value={reason} required={Boolean(asking)} autoFocus onChange={event => setReason(event.target.value)} disabled={busy} />
    </div>}
    <footer className="vs-actions">
      {item.actions.length === 0 ? <small className="muted">{pick(ui.noActions, lang)}</small> : asking ? <>
        <button type="button" className={tone(asking)} disabled={busy || !reason.trim()} onClick={() => onAction?.(asking, reason.trim())}>{busyKey === asking.key ? '…' : `${pick(ui.confirm, lang)}：${pick(asking.label, lang)}`}</button>
        <button type="button" className="vs-btn ghost" disabled={busy} onClick={() => { setAsking(null); setReason(''); }}>{pick(ui.cancel, lang)}</button>
      </> : <>
        {item.actions.map(action => <button key={action.key} type="button" className={tone(action)} disabled={busy} onClick={() => run(action)}>{busyKey === action.key ? '…' : pick(action.label, lang)}</button>)}
        {!optional && item.actions.some(action => !action.requires_reason) && <button type="button" className="vs-link-button" onClick={() => setOptional(true)}>{pick(ui.reasonOptional, lang)}</button>}
      </>}
    </footer>
    {error}
  </article>;
}

export function ActivityList({ items, resourceHref, timeZone }: { items: readonly ActivityItem[]; resourceHref?: (item: ActivityItem) => string | undefined; timeZone?: string }) {
  const lang = useLang();
  return <ol className="vs-activity">{items.map(item => {
    const href = resourceHref?.(item);
    const title = item.resource?.title;
    return <li key={item.id}>
      <ActorBadge type={item.actor.type} label={item.actor.label} />
      <span className="vs-activity-text">{pick(item.summary, lang) || item.action}{(item.count ?? 1) > 1 && <span className="vs-count"> ×{item.count}</span>}
        {title && <> · {href ? <ViewLink to={href}>{title}</ViewLink> : title}</>}</span>
      <time className="muted" dateTime={item.occurred_at} title={formatDateTime(item.occurred_at, lang, timeZone)}>{relativeTime(item.occurred_at, lang)}</time>
    </li>;
  })}</ol>;
}
