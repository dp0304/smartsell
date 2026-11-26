import { intlLocale, statusInfo, type Lang, type Tone, type Tuple } from '@smartsell/ui';

// Calendar page copy as [繁中, English] tuples, plus kind, platform and status labels the shared maps do not cover.
export const t = {
  subtitle: ['接下來要發什麼、哪天有什麼事', 'What goes out next and what happens when'],
  timeZone: ['時區', 'Time zone'], timeZoneHint: ['日曆上的日期與時間都以工作區時區顯示', 'Dates and times on the calendar use the workspace time zone'],
  month: ['月', 'Month'], week: ['週', 'Week'], list: ['列表', 'List'], viewMode: ['檢視方式', 'View'], navigation: ['切換期間', 'Change period'],
  prevMonth: ['上個月', 'Previous month'], nextMonth: ['下個月', 'Next month'], prevWeek: ['上一週', 'Previous week'], nextWeek: ['下一週', 'Next week'],
  today: ['今天', 'Today'],
  plan: ['推廣計劃', 'Plan'], allPlans: ['全部推廣計劃', 'All plans'], openPlan: ['查看計劃', 'Open plan'],
  planMismatch: ['所選的推廣計劃不在目前的品牌底下，已改為顯示全部計劃。', 'The selected plan is not under the current brand, so all plans are shown.'],
  clearPlan: ['清除計劃篩選', 'Clear plan filter'],
  kinds: ['顯示類型（也是圖例）', 'Kinds shown (also the legend)'], showAll: ['全部顯示', 'Show all'], onlyThis: ['只看這類', 'Only this kind'],
  noPermission: ['無權限', 'No access'],
  noPermissionNote: ['你的角色看不到：{kinds}。日曆上沒有顯示，不代表那幾天沒有安排；需要時請工作區管理員調整權限。',
    'Your role cannot see: {kinds}. Their absence here does not mean nothing is scheduled; ask a workspace admin if you need access.'],
  nextTitle: ['接下來要發', 'Next to publish'], firstTitle: ['這段期間第一則發布', 'First post in this period'],
  nextNone: ['這段期間沒有待發布的排程', 'Nothing left to publish in this period'],
  nextPast: ['這段期間已經過去', 'This period is over'],
  nextPrompt: ['幫我排好接下來兩週的社群發布，排好後送審', 'Schedule social posts for the next two weeks and submit them for approval'],
  moreUpcoming: ['之後還有 {n} 則待發布', '{n} more to publish after this'],
  needsTitle: ['要你處理的貼文', 'Posts that need you'], needsNone: ['這段期間沒有要你處理的貼文', 'No post in this period needs you'],
  goDecisions: ['前往待你決定', 'Open decisions'],
  rangeTitle: ['這段期間', 'In this period'], todayCount: ['今天有 {n} 件事', '{n} on today'], todayNone: ['今天沒有安排', 'Nothing on today'],
  scheduledCount: ['發布排期', 'Scheduled'], publishedCount: ['已發布', 'Published'], periodsCount: ['檔期與計劃', 'Periods'],
  allDay: ['全天', 'All day'], starts: ['開始', 'Starts'], ends: ['結束', 'Ends'], oneDay: ['單日', 'One day'],
  dayOf: ['第 {d}/{n} 天', 'Day {d} of {n}'], daysTotal: ['共 {n} 天', '{n} days'], continues: ['延續', 'continues'],
  running: ['這段期間的檔期與計劃', 'Plans and flights in this period'],
  earlier: ['顯示本月較早的 {n} 天', 'Show {n} earlier days'], hideEarlier: ['收合較早的日子', 'Hide earlier days'],
  nothing: ['沒有安排', 'Nothing scheduled'], items: ['{n} 件事', '{n} items'], more: ['還有 {n} 件', '{n} more'],
  closeDay: ['收合這一天', 'Close this day'],
  filteredEmpty: ['目前的篩選隱藏了這段期間的 {n} 件事', 'Your filters hide {n} items in this period'], clearFilters: ['清除篩選', 'Clear filters'],
  emptyPromptMonth: ['幫我把 {month} 的社群發布排程和推廣檔期排好', 'Schedule the social posts and campaign windows for {month}'],
  emptyPromptWeek: ['幫我把 {range} 這週的社群發布排好', 'Schedule the social posts for the week of {range}'],
  emptyPromptPast: ['幫我把 {month} 在各平台已發布的貼文登記到 SmartSell', 'Register the posts we published on each platform in {month} in SmartSell'],
  emptyPromptPlan: ['幫我為「{plan}」排好內容發布時間和里程碑', 'Schedule the posts and milestones for “{plan}”'],
  emptyDetail: ['發布排程、推廣計劃、投放檔期與促銷都由 Agent 建立，建好後會出現在這裡。', 'Your agent creates schedules, plans, ad flights and promotions; they appear here once created.'],
  time: ['時間', 'Time'], status: ['狀態', 'Status'], platform: ['平台', 'Platform'], permalink: ['在平台上查看', 'View on the platform'],
  related: ['相關頁面', 'Related'], source: ['來源', 'Source'], close: ['關閉', 'Close'], details: ['詳細內容', 'Details'],
  askAgent: ['要調整這一項，請你的 Agent：', 'To change this, tell your agent:'],
  agentPrompt: ['幫我看一下日曆上「{title}」（{when}），需要的話調整時間或內容', 'Check “{title}” ({when}) on the calendar and adjust its timing or content if needed'],
  notOnCalendar: ['在目前的期間或篩選中找不到這一項', 'This item is not in the current period or filters'],
  needsMarker: ['需要你處理', 'Needs you'],
  overdue: ['已過預定時間', 'Past its time'],
  overdueDetail: ['預定時間已過，但還沒有發出。', 'Its scheduled time has passed and it has not gone out.'],
} as const satisfies Record<string, Tuple>;

export const kindText: Record<string, Tuple> = {
  publish: ['發布排期', 'Scheduled post'], post: ['已發布', 'Published post'], plan: ['推廣計劃期間', 'Plan period'], milestone: ['里程碑', 'Milestone'],
  production_due: ['製作期限', 'Production due'], deliverable_due: ['達人交付', 'Creator deliverable'], live: ['直播', 'Live stream'],
  ad_flight: ['投放檔期', 'Ad flight'], promotion: ['促銷', 'Promotion'],
};
export const kindLabel = (kind: string, lang: Lang) => (kindText[kind] ?? [kind, kind])[lang === 'en' ? 1 : 0];

export const needsText: Record<string, Tuple> = {
  approval: ['待你核准', 'Needs your approval'], late_decision: ['待決定', 'Needs a decision'], outcome_unknown: ['結果待核實', 'Outcome to verify'],
  needs_owner: ['要你處理', 'Needs you'], missed: ['沒有發出', 'Missed'],
};
/** Why an event waits for the person, in words that fit its kind. */
export function needsDetail(kind: string, needs: string): Tuple {
  if (needs === 'late_decision') return ['已超過預定時間還沒發出，需要你決定改期、照發或取消。', 'It missed its scheduled time; decide whether to reschedule, publish anyway or cancel.'];
  if (needs === 'outcome_unknown') return ['系統無法確認這則是否已經發出，請到平台上核實結果。', 'We could not confirm whether this went out; check the result on the platform.'];
  if (needs === 'needs_owner') return ['機器停下來等你處理，請看下方的說明。', 'The machine stopped and waits for you; see below.'];
  if (needs === 'missed') return ['這則沒有發出，可以改到別的時間。', 'This did not go out; you can reschedule it.'];
  if (kind === 'ad_flight') return ['投放方案正在等你核准，核准前不會開始投放。', 'This ad proposal waits for your approval; nothing is spent before you approve.'];
  if (kind === 'deliverable_due') return ['達人已交付作品，需要你驗收。', 'The creator has delivered; it needs your review.'];
  return ['Agent 已送審，需要你核准或退回後才會發布。', 'Your agent submitted this; it goes out only after you approve or return it.'];
}

const platformText: Record<string, Tuple> = {
  instagram: ['Instagram', 'Instagram'], facebook: ['Facebook', 'Facebook'], tiktok: ['TikTok', 'TikTok'], youtube: ['YouTube', 'YouTube'],
  threads: ['Threads', 'Threads'], x: ['X', 'X'], twitter: ['X', 'X'], line: ['LINE', 'LINE'], xiaohongshu: ['小紅書', 'Xiaohongshu'],
  meta_ads: ['Meta 廣告', 'Meta Ads'], google_ads: ['Google 廣告', 'Google Ads'], tiktok_ads: ['TikTok 廣告', 'TikTok Ads'],
};
export const platformLabel = (platform: string | null | undefined, lang: Lang) =>
  platform ? (platformText[platform] ?? [platform, platform])[lang === 'en' ? 1 : 0] : '';

const resourceText: Record<string, Tuple> = {
  publish_target: ['發布排期', 'Publish schedule'], platform_post: ['平台貼文', 'Platform post'], campaign: ['推廣計劃', 'Plan'],
  work_item: ['工作項目', 'Work item'], content_item: ['內容', 'Content item'], deliverable: ['達人交付', 'Creator deliverable'],
  live_session: ['直播場次', 'Live session'], ad_proposal: ['投放方案', 'Ad proposal'], promotion: ['促銷活動', 'Promotion'],
};
export const resourceLabel = (type: string | null | undefined, lang: Lang) => type ? (resourceText[type] ?? [type, type])[lang === 'en' ? 1 : 0] : '';

// Event statuses that the shared status map words for other resources (e.g. "open" means an unclaimed agent job there).
const statusOverride: Record<string, [Tone, string, string]> = {
  executing: ['info', '發布中', 'Publishing'], cancel_requested: ['neutral', '取消中', 'Cancelling'], drafting: ['info', '撰寫中', 'Drafting'],
  requested: ['neutral', '已邀請', 'Requested'], briefed: ['info', '已交付簡報', 'Briefed'], editing: ['info', '剪輯中', 'Editing'],
  review: ['warning', '審閱中', 'In review'], ready: ['good', '已就緒', 'Ready'], manual: ['warning', '待人工發布', 'Manual'],
};
const kindStatusOverride: Record<string, Record<string, [Tone, string, string]>> = {
  milestone: { open: ['neutral', '未完成', 'Open'] }, production_due: { open: ['neutral', '未完成', 'Open'] },
  promotion: { expired: ['neutral', '已結束', 'Ended'], active: ['good', '進行中', 'Running'] },
  // Phase 1 posts carry derivePostStatus values (§3.4).
  publish: { awaiting_approval: ['warning', '待你核准', 'Awaiting approval'], needs_owner: ['critical', '要你處理', 'Needs you'], missed: ['critical', '沒有發出', 'Missed'],
    unknown: ['critical', '結果不明', 'Result unknown'], cancelling: ['neutral', '取消中', 'Cancelling'], confirming: ['info', '確認結果中', 'Confirming'],
    publishing: ['info', '發布中', 'Publishing'], ready: ['info', '已準備好', 'Ready'], blocked: ['warning', '被擋下', 'Blocked'],
    // E37: the owner rejected it (the same word as the post page).
    rejected: ['neutral', '已駁回', 'Rejected'] },
  post: { live: ['good', '已上線', 'Live'], deleted: ['neutral', '已刪除', 'Deleted'], removed_by_platform: ['serious', '被平台移除', 'Removed by platform'] },
};
export function eventStatus(kind: string, status: string | null | undefined, lang: Lang): { tone: Tone; label: string } | null {
  if (!status) return null;
  const known = kindStatusOverride[kind]?.[status] ?? statusOverride[status];
  if (known) return { tone: known[0], label: known[lang === 'en' ? 2 : 1] };
  return statusInfo(status, lang);
}

export const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);

const formatter = (lang: Lang, options: Intl.DateTimeFormatOptions, timeZone?: string) => {
  try { return new Intl.DateTimeFormat(intlLocale(lang), { ...options, timeZone }); }
  catch { return new Intl.DateTimeFormat(intlLocale(lang), { ...options, timeZone: 'UTC' }); }
};
/** A local day (YYYY-MM-DD) with weekday, e.g. 11月21日 週六. */
export const dayLabel = (day: string, lang: Lang, withYear = false) =>
  formatter(lang, { ...(withYear ? { year: 'numeric' } : {}), month: lang === 'en' ? 'short' : 'long', day: 'numeric', weekday: 'short' }, 'UTC').format(new Date(`${day}T00:00:00Z`));
export const shortDay = (day: string, lang: Lang) => formatter(lang, { month: 'numeric', day: 'numeric' }, 'UTC').format(new Date(`${day}T00:00:00Z`));
export const monthLabel = (month: string, lang: Lang) => formatter(lang, { year: 'numeric', month: 'long' }, 'UTC').format(new Date(`${month}-01T00:00:00Z`));
export const weekdayShort = (day: string, lang: Lang) => formatter(lang, { weekday: 'short' }, 'UTC').format(new Date(`${day}T00:00:00Z`));
/** Wall-clock time of an instant in the workspace zone. */
export const clock = (iso: string, lang: Lang, timeZone?: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : formatter(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, timeZone).format(date);
};
