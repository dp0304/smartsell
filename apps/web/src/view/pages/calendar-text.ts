import { intlLocale, pick, statusInfo, type Lang, type Tone, type Tuple } from '@smartsell/ui';

// Calendar page copy as [繁中, English, 简中?] tuples, plus kind, platform and status labels the shared maps do not cover.
export const t = {
  subtitle: ['接下來要發什麼、哪天有什麼事', 'What goes out next and what happens when', '接下来要发什么、哪天有什么事'],
  timeZone: ['時區', 'Time zone', '时区'], timeZoneHint: ['日曆上的日期與時間都以工作區時區顯示', 'Dates and times on the calendar use the workspace time zone', '日历上的日期与时间都以工作区时区显示'],
  month: ['月', 'Month'], week: ['週', 'Week', '周'], list: ['列表', 'List'], viewMode: ['檢視方式', 'View', '查看方式'], navigation: ['切換期間', 'Change period', '切换期间'],
  prevMonth: ['上個月', 'Previous month', '上个月'], nextMonth: ['下個月', 'Next month', '下个月'], prevWeek: ['上一週', 'Previous week', '上一周'], nextWeek: ['下一週', 'Next week', '下一周'],
  today: ['今天', 'Today'],
  plan: ['推廣計劃', 'Plan', '推广计划'], allPlans: ['全部推廣計劃', 'All plans', '全部推广计划'], openPlan: ['查看計劃', 'Open plan', '查看计划'],
  planMismatch: ['所選的推廣計劃不在目前的品牌底下，已改為顯示全部計劃。', 'The selected plan is not under the current brand, so all plans are shown.', '所选的推广计划不在目前的品牌底下，已改为显示全部计划。'],
  clearPlan: ['清除計劃篩選', 'Clear plan filter', '清除计划筛选'],
  kinds: ['顯示類型（也是圖例）', 'Kinds shown (also the legend)', '显示类型（也是图例）'], showAll: ['全部顯示', 'Show all', '全部显示'], onlyThis: ['只看這類', 'Only this kind', '只看这类'],
  noPermission: ['無權限', 'No access', '无权限'],
  noPermissionNote: ['你的角色看不到：{kinds}。日曆上沒有顯示，不代表那幾天沒有安排；需要時請工作區管理員調整權限。',
    'Your role cannot see: {kinds}. Their absence here does not mean nothing is scheduled; ask a workspace admin if you need access.', '你的角色看不到：{kinds}。日历上没有显示，不代表那几天没有安排；需要时请工作区管理员调整权限。'],
  nextTitle: ['接下來要發', 'Next to publish', '接下来要发'], firstTitle: ['這段期間第一則發布', 'First post in this period', '这段期间第一则发布'],
  nextNone: ['這段期間沒有待發布的排程', 'Nothing left to publish in this period', '这段期间没有待发布的调度'],
  nextPast: ['這段期間已經過去', 'This period is over', '这段期间已经过去'],
  nextPrompt: ['幫我排好接下來兩週的社群發布，排好後送審', 'Schedule social posts for the next two weeks and submit them for approval', '帮我排好接下来两周的社交媒体发布，排好后送审'],
  moreUpcoming: ['之後還有 {n} 則待發布', '{n} more to publish after this', '之后还有 {n} 则待发布'],
  needsTitle: ['需要你處理', 'Needs you', '需要你处理'], needsNone: ['這段期間沒有需要你處理的項目', 'Nothing in this period needs you', '这段期间没有需要你处理的项目'],
  goDecisions: ['前往待你決定', 'Open decisions', '前往待你决定'],
  rangeTitle: ['這段期間', 'In this period', '这段期间'], todayCount: ['今天有 {n} 件事', '{n} on today'], todayNone: ['今天沒有安排', 'Nothing on today', '今天没有安排'],
  scheduledCount: ['發布排期', 'Scheduled', '发布排期'], publishedCount: ['已發布', 'Published', '已发布'], periodsCount: ['檔期與計劃', 'Periods', '档期与计划'],
  allDay: ['全天', 'All day'], starts: ['開始', 'Starts', '开始'], ends: ['結束', 'Ends', '结束'], oneDay: ['單日', 'One day', '单日'],
  dayOf: ['第 {d}/{n} 天', 'Day {d} of {n}'], daysTotal: ['共 {n} 天', '{n} days'], continues: ['延續', 'continues', '延续'],
  running: ['這段期間的檔期與計劃', 'Plans and flights in this period', '这段期间的档期与计划'],
  earlier: ['顯示本月較早的 {n} 天', 'Show {n} earlier days', '显示本月较早的 {n} 天'], hideEarlier: ['收合較早的日子', 'Hide earlier days', '收合较早的日子'],
  nothing: ['沒有安排', 'Nothing scheduled', '没有安排'], items: ['{n} 件事', '{n} items'], more: ['還有 {n} 件', '{n} more', '还有 {n} 件'],
  closeDay: ['收合這一天', 'Close this day', '收合这一天'],
  filteredEmpty: ['目前的篩選隱藏了這段期間的 {n} 件事', 'Your filters hide {n} items in this period', '目前的筛选隐藏了这段期间的 {n} 件事'], clearFilters: ['清除篩選', 'Clear filters', '清除筛选'],
  emptyPromptMonth: ['幫我把 {month} 的社群發布排程和推廣檔期排好', 'Schedule the social posts and campaign windows for {month}', '帮我把 {month} 的社交媒体发布调度和推广档期排好'],
  emptyPromptWeek: ['幫我把 {range} 這週的社群發布排好', 'Schedule the social posts for the week of {range}', '帮我把 {range} 这周的社交媒体发布排好'],
  emptyPromptPast: ['幫我把 {month} 在各平台已發布的貼文登記到 SmartSell', 'Register the posts we published on each platform in {month} in SmartSell', '帮我把 {month} 在各平台已发布的帖子登记到 SmartSell'],
  emptyPromptPlan: ['幫我為「{plan}」排好內容發布時間和里程碑', 'Schedule the posts and milestones for “{plan}”', '帮我为「{plan}」排好内容发布时间和里程碑'],
  emptyDetail: ['發布排程、推廣計劃、投放檔期與促銷都由 Agent 建立，建好後會出現在這裡。', 'Your agent creates schedules, plans, ad flights and promotions; they appear here once created.', '发布调度、推广计划、投放档期与促销都由 Agent 创建，建好后会出现在这里。'],
  time: ['時間', 'Time', '时间'], status: ['狀態', 'Status', '状态'], platform: ['平台', 'Platform'], permalink: ['在平台上查看', 'View on the platform'],
  related: ['相關頁面', 'Related', '相关页面'], source: ['來源', 'Source', '来源'], close: ['關閉', 'Close', '关闭'], details: ['詳細內容', 'Details', '详细内容'],
  askAgent: ['要調整這一項，請你的 Agent：', 'To change this, tell your agent:', '要调整这一项，请你的 Agent：'],
  agentPrompt: ['幫我看一下日曆上「{title}」（{when}），需要的話調整時間或內容', 'Check “{title}” ({when}) on the calendar and adjust its timing or content if needed', '帮我看一下日历上「{title}」（{when}），需要的话调整时间或内容'],
  notOnCalendar: ['在目前的期間或篩選中找不到這一項', 'This item is not in the current period or filters', '在目前的期间或筛选中找不到这一项'],
  needsMarker: ['需要你處理', 'Needs you', '需要你处理'],
  overdue: ['已過預定時間', 'Past its time', '已过预定时间'],
  overdueDetail: ['預定時間已過，但還沒有發出。', 'Its scheduled time has passed and it has not gone out.', '预定时间已过，但还没有发出。'],
} as const satisfies Record<string, Tuple>;

export const kindText: Record<string, Tuple> = {
  publish: ['發布排期', 'Scheduled post', '发布排期'], post: ['已發布', 'Published post', '已发布'], plan: ['推廣計劃期間', 'Plan period', '推广计划期间'], milestone: ['里程碑', 'Milestone'],
  production_due: ['製作期限', 'Production due', '制作期限'], deliverable_due: ['達人交付', 'Creator deliverable', '达人交付'], live: ['直播', 'Live stream'],
  ad_flight: ['投放檔期', 'Ad flight', '投放档期'], promotion: ['促銷', 'Promotion', '促销'],
};
export const kindLabel = (kind: string, lang: Lang) => pick(kindText[kind] ?? kind, lang);

export const needsText: Record<string, Tuple> = {
  approval: ['待審批', 'Needs approval', '待审批'], late_decision: ['待決定', 'Needs a decision', '待决定'], outcome_unknown: ['結果待核實', 'Outcome to verify', '结果待核实'],
};
/** Why an event waits for the person, in words that fit its kind. */
export function needsDetail(kind: string, needs: string): Tuple {
  if (needs === 'late_decision') return ['已超過預定時間還沒發出，需要你決定改期、照發或取消。', 'It missed its scheduled time; decide whether to reschedule, publish anyway or cancel.', '已超过预定时间还没发出，需要你决定改期、照发或取消。'];
  if (needs === 'outcome_unknown') return ['系統無法確認這則是否已經發出，請到平台上核實結果。', 'We could not confirm whether this went out; check the result on the platform.', '系统无法确认这则是否已经发出，请到平台上核实结果。'];
  if (kind === 'ad_flight') return ['投放方案正在等你核准，核准前不會開始投放。', 'This ad proposal waits for your approval; nothing is spent before you approve.', '投放方案正在等你核准，核准前不会开始投放。'];
  if (kind === 'deliverable_due') return ['達人已交付作品，需要你驗收。', 'The creator has delivered; it needs your review.', '达人已交付作品，需要你验收。'];
  return ['Agent 已送審，需要你核准或退回後才會發布。', 'Your agent submitted this; it goes out only after you approve or return it.', 'Agent 已送审，需要你核准或退回后才会发布。'];
}

const platformText: Record<string, Tuple> = {
  instagram: ['Instagram', 'Instagram'], facebook: ['Facebook', 'Facebook'], tiktok: ['TikTok', 'TikTok'], youtube: ['YouTube', 'YouTube'],
  threads: ['Threads', 'Threads'], x: ['X', 'X'], twitter: ['X', 'X'], line: ['LINE', 'LINE'], xiaohongshu: ['小紅書', 'Xiaohongshu', '小红书'],
  meta_ads: ['Meta 廣告', 'Meta Ads', 'Meta 广告'], google_ads: ['Google 廣告', 'Google Ads', 'Google 广告'], tiktok_ads: ['TikTok 廣告', 'TikTok Ads', 'TikTok 广告'],
};
export const platformLabel = (platform: string | null | undefined, lang: Lang) =>
  platform ? pick(platformText[platform] ?? platform, lang) : '';

const resourceText: Record<string, Tuple> = {
  publish_target: ['發布排期', 'Publish schedule', '发布排期'], platform_post: ['平台貼文', 'Platform post', '平台帖子'], campaign: ['推廣計劃', 'Plan', '推广计划'],
  work_item: ['工作項目', 'Work item', '工作项目'], content_item: ['內容', 'Content item', '内容'], deliverable: ['達人交付', 'Creator deliverable', '达人交付'],
  live_session: ['直播場次', 'Live session', '直播场次'], ad_proposal: ['投放方案', 'Ad proposal'], promotion: ['促銷活動', 'Promotion', '促销活动'],
};
export const resourceLabel = (type: string | null | undefined, lang: Lang) => type ? pick(resourceText[type] ?? type, lang) : '';

// Event statuses that the shared status map words for other resources (e.g. "open" means an unclaimed agent job there).
const statusOverride: Record<string, [Tone, string, string, string?]> = {
  executing: ['info', '發布中', 'Publishing', '发布中'], cancel_requested: ['neutral', '取消中', 'Cancelling'], drafting: ['info', '撰寫中', 'Drafting', '撰写中'],
  requested: ['neutral', '已邀請', 'Requested', '已邀请'], briefed: ['info', '已交付簡報', 'Briefed', '已交付演示文稿'], editing: ['info', '剪輯中', 'Editing', '剪辑中'],
  review: ['warning', '審閱中', 'In review', '审阅中'], ready: ['good', '已就緒', 'Ready', '已就绪'], manual: ['warning', '待人工發布', 'Manual', '待人工发布'],
};
const kindStatusOverride: Record<string, Record<string, [Tone, string, string, string?]>> = {
  milestone: { open: ['neutral', '未完成', 'Open'] }, production_due: { open: ['neutral', '未完成', 'Open'] },
  promotion: { expired: ['neutral', '已結束', 'Ended', '已结束'], active: ['good', '進行中', 'Running', '进行中'] },
  post: { live: ['good', '已上線', 'Live', '已上线'], deleted: ['neutral', '已刪除', 'Deleted', '已删除'], removed_by_platform: ['serious', '被平台移除', 'Removed by platform'] },
};
export function eventStatus(kind: string, status: string | null | undefined, lang: Lang): { tone: Tone; label: string } | null {
  if (!status) return null;
  const known = kindStatusOverride[kind]?.[status] ?? statusOverride[status];
  if (known) return { tone: known[0], label: pick([known[1], known[2], known[3]], lang) };
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
