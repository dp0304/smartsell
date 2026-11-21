import type { Tuple } from '@smartsell/ui';

// Plan pages copy as [繁中, English, 简中?] tuples, read through useText().l.
export const planCopy = {
  listSubtitle: ['哪些推廣計劃在跑、進度如何、錢花了多少', 'Which plans are running, how far along they are and what they have spent', '哪些推广计划在跑、进度如何、钱花了多少'],
  detailSubtitle: ['這個計劃進度如何、還缺什麼、哪些事等你決定', 'How this plan is going, what is missing and what waits for you', '这个计划进度如何、还缺什么、哪些事等你决定'],
  back: ['全部推廣計劃', 'All plans', '全部推广计划'],
  all: ['全部', 'All'], phaseFilter: ['依狀態篩選', 'Filter by status', '依状态筛选'],
  phase: {
    live: ['進行中', 'Running', '进行中'], upcoming: ['即將開始', 'Upcoming', '即将开始'], ended: ['已結束', 'Ended', '已结束'], draft: ['草稿', 'Drafts'],
  } satisfies Record<string, Tuple>,
  gantt: ['時程', 'Timeline', '时程'], undated: ['{n} 個計劃尚未設定期間', '{n} plans have no dates yet', '{n} 个计划尚未设置期间'],
  outside: ['{n} 個計劃不在此時程範圍內', '{n} plans fall outside this timeline', '{n} 个计划不在此时程范围内'],
  olderEnded: ['{n} 個較早結束的計劃未列入（可切到「已結束」查看）', '{n} plans that ended earlier are left out (see Ended)', '{n} 个较早结束的计划未列入（可切到「已结束」查看）'],
  notSetYet: ['尚未設定：{list}', 'Not set yet: {list}', '尚未设置：{list}'], listJoin: ['、', ', '],
  noneInPhase: ['沒有符合此狀態的推廣計劃', 'No plans with this status', '没有符合此状态的推广计划'],
  // Period and progress
  dayOf: ['第 {day} 天／共 {days} 天', 'Day {day} of {days}'], startsIn: ['{n} 天後開始', 'Starts in {n} days', '{n} 天后开始'], startsTomorrow: ['明天開始', 'Starts tomorrow', '明天开始'],
  startsToday: ['今天開始', 'Starts today', '今天开始'], ended: ['已結束', 'Ended', '已结束'], noDates: ['尚未設定期間', 'No dates yet', '尚未设置期间'], openEnded: ['未設定結束日', 'No end date', '未设置结束日'],
  // Summary
  summaryLive: ['進行中', 'Running', '进行中'], summaryUpcoming: ['即將開始', 'Upcoming', '即将开始'], summaryDecisions: ['待你決定', 'Waiting for you', '待你决定'],
  summarySpend: ['進行中計劃已記錄的花費', 'Recorded spend on running plans', '进行中计划已记录的花费'], ofBudget: ['預算 {b}', 'of {b} budget', '预算 {b}'],
  budgetHiddenSome: ['部分計劃的預算你無權查看', 'Some plan budgets are not visible to your role', '部分计划的预算你无权查看'],
  // Content completeness
  completeness: ['內容完成度', 'Content completeness', '内容完成度'], nothingPlanned: ['尚未規劃內容數量，完成度未知', 'No content planned yet; completeness unknown', '尚未规划内容数量，完成度未知'],
  filledOf: ['{a}／規劃 {b} 則', '{a} of {b} planned', '{a}／规划 {b} 则'], gap: ['缺 {n} 則', '{n} missing', '缺 {n} 则'], noGap: ['已全部到位', 'All in place'],
  beyondPlan: ['另有 {n} 則超出規劃數量', '{n} more than planned', '另有 {n} 则超出规划数量'], excessCell: ['超出 {n}', '{n} over'],
  part: { published: ['已發布', 'Published', '已发布'], scheduled: ['已排程', 'Scheduled', '已调度'], in_production: ['製作中', 'In production', '制作中'], failed: ['失敗', 'Failed', '失败'] } satisfies Record<string, Tuple>,
  // Goals
  goals: ['目標', 'Goals', '目标'], noGoals: ['尚未設定目標', 'No goals set', '尚未设置目标'], moreGoals: ['另有 {n} 個目標', '{n} more goals', '另有 {n} 个目标'],
  ofTarget: ['目標 {b}', 'target {b}', '目标 {b}'], reached: ['已達標', 'Reached', '已达标'], due: ['截止 {d}', 'due {d}'],
  goalNotCollected: ['未採集', 'Not collected', '未采集'],
  coverage: {
    unknown: ['尚無可計算的數據', 'Nothing to compute yet', '尚无可计算的数据'], unavailable: ['此指標無法按計劃計算', 'This metric cannot be measured per plan', '此指标无法按计划计算'],
    partial: ['部分採集', 'Partly collected', '部分采集'],
  } satisfies Record<string, Tuple>,
  // Budget
  budget: ['預算', 'Budget', '预算'], budgetHidden: ['你的角色無法查看預算', 'Your role cannot see budgets', '你的角色无法查看预算'], noBudget: ['尚未登記預算', 'No budget recorded', '尚未登记预算'],
  used: ['已用 {p}', '{p} used'], spent: ['已記錄花費', 'Recorded spend', '已记录花费'], committed: ['已承諾未付', 'Committed, unpaid', '已承诺未付'], remaining: ['剩餘', 'Remaining', '剩余'], budgetTotal: ['預算', 'Budget', '预算'],
  overrun: ['超出預算 {a}', 'Over budget by {a}', '超出预算 {a}'], provisional: ['結案對帳前，花費可能尚未全部入帳', 'Spend may be incomplete until the plan is closed out', '结案对帐前，花费可能尚未全部入帐'],
  // Products
  products: ['商品', 'Products'], noProducts: ['尚未加入商品', 'No products added'], moreProducts: ['+{n}', '+{n}'],
  stockUnknown: ['庫存未採集', 'Stock not collected', '库存未采集'],
  role: { hero: ['主推', 'Hero'], supporting: ['搭配', 'Supporting'], bundle: ['組合', 'Bundle', '组合'], gift: ['贈品', 'Gift', '赠品'] } satisfies Record<string, Tuple>,
  risk: {
    out_of_stock: ['已缺貨', 'Went out of stock', '已缺货'], became_unavailable: ['已無法購買', 'Became unavailable', '已无法购买'], became_available: ['恢復可購買', 'Available again', '恢复可购买'],
    stock_low: ['庫存偏低', 'Stock running low', '库存偏低'], price_changed: ['價格有變動', 'Price changed', '价格有变动'], product_removed: ['商品已下架', 'Product removed'],
    localization_stale: ['在地化內容過時', 'Localization out of date', '本地化内容过时'],
  } satisfies Record<string, Tuple>,
  // Publication and decisions
  nextPublication: ['下一則發布', 'Next post', '下一则发布'], noNext: ['沒有待發布的內容', 'Nothing waiting to publish', '没有待发布的内容'],
  needsDecision: ['{n} 項待你決定', '{n} waiting for you', '{n} 项待你决定'], decisions: ['待你決定', 'Waiting for your decision', '待你决定'],
  byAgent: ['由 Agent 建立', 'Created by your agent', '由 Agent 创建'],
  // Detail sections
  summary: ['現況', 'At a glance', '现况'], matrix: ['內容矩陣', 'Content matrix', '内容矩阵'], matrixAccount: ['平台／帳號', 'Platform / account', '平台／账号'],
  anyAccount: ['任一帳號', 'Any account', '任一账号'], planned: ['規劃', 'Planned', '规划'], gapCol: ['缺口', 'Gap'], totalRow: ['合計', 'Total', '合计'],
  stage: { teaser: ['預熱', 'Teaser', '预热'], launch: ['上市', 'Launch'], sustain: ['延續', 'Sustain', '延续'], conversion: ['轉換', 'Conversion', '转换'], recap: ['回顧', 'Recap', '回顾'], custom: ['自訂', 'Custom', '自订'] } satisfies Record<string, Tuple>,
  outsidePlan: ['{n} 則排期不在任何規劃格內', '{n} scheduled posts do not match any planned slot', '{n} 则排期不在任何规划格内'],
  unplannedItems: ['{n} 則內容尚未排期', '{n} content items are not scheduled yet', '{n} 则内容尚未排期'],
  schedule: ['日程', 'Schedule'], openCalendar: ['在日曆中查看', 'Open in calendar', '在日历中查看'], noEvents: ['這個計劃還沒有任何排程', 'Nothing is scheduled for this plan yet', '这个计划还没有任何调度'],
  earlier: ['顯示較早的 {n} 項', 'Show {n} earlier items', '显示较早的 {n} 项'], today: ['今天', 'Today'], hideEarlier: ['隱藏較早的項目', 'Hide earlier items', '隐藏较早的项目'], until: ['至 {d}', 'until {d}'],
  milestones: ['里程碑', 'Milestones'], noMilestones: ['沒有設定里程碑', 'No milestones set', '没有设置里程碑'], overdue: ['已逾期', 'Overdue'], blocked: ['受阻', 'Blocked'],
  milestoneDone: ['已完成', 'Done'], milestoneOpen: ['進行中', 'Open', '进行中'],
  content: ['內容', 'Content', '内容'], noContent: ['還沒有內容', 'No content yet', '还没有内容'], noTargets: ['尚未排期', 'Not scheduled'], productionDue: ['製作期限 {d}', 'Production due {d}', '制作期限 {d}'],
  showAll: ['顯示全部 {n} 項', 'Show all {n}', '显示全部 {n} 项'], showLess: ['收合', 'Show less'],
  productionStage: {
    accepted: ['已確認', 'Accepted', '已确认'], drafting: ['撰寫中', 'Drafting', '撰写中'], design: ['設計中', 'In design', '设计中'], awaiting_assets: ['等待素材', 'Awaiting assets'],
    internal_review: ['內部審閱', 'Internal review', '内部审阅'], ready: ['可發布', 'Ready', '可发布'], archived: ['已封存', 'Archived'],
  } satisfies Record<string, Tuple>,
  ads: ['投放', 'Ads'], adsSpend: ['投放花費', 'Ad spend', '投放花费'], proposals: ['投放方案', 'Ad proposals'], noAds: ['這個計劃沒有投放方案', 'No ad proposals for this plan', '这个计划没有投放方案'],
  adsHidden: ['投放資料只對有投放帳戶權限的成員顯示', 'Ad data is shown only to members with ad-account access', '投放数据只对有投放账户权限的成员显示'],
  spendUnknown: ['花費未採集', 'Spend not collected', '花费未采集'], coverageDays: ['已回報 {p} 的天數', '{p} of days reported', '已回报 {p} 的天数'], delayed: ['數據延遲', 'Data delayed', '数据延迟'],
  daily: ['每日 {a}', '{a} per day'], lifetime: ['總額 {a}', '{a} total', '总额 {a}'], estimates: ['預估', 'Estimates', '预估'], approval: ['審批', 'Approval', '审批'],
  openAds: ['投放頁', 'Ads page', '投放页'],
  nextStep: ['建議下一步', 'Suggested next step', '建议下一步'],
  notFound: ['找不到這個推廣計劃，可能已被刪除或你沒有權限', 'This plan was not found; it may be deleted or not visible to you', '找不到这个推广计划，可能已被删除或你没有权限'],
} as const;

export const targetStatus: Record<string, { tone: 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info'; label: Tuple }> = {
  executing: { tone: 'info', label: ['發布中', 'Publishing', '发布中'] }, cancel_requested: { tone: 'neutral', label: ['取消中', 'Cancelling'] },
  ready: { tone: 'info', label: ['已排程', 'Scheduled', '已调度'] }, manual: { tone: 'warning', label: ['待手動發布', 'Manual posting', '待手动发布'] },
  in_review: { tone: 'warning', label: ['審核中', 'In review', '审核中'] }, proposed: { tone: 'warning', label: ['待審批', 'Proposed', '待审批'] },
  exported: { tone: 'info', label: ['已匯出', 'Exported', '已导出'] }, over_budget: { tone: 'serious', label: ['超出預算', 'Over budget', '超出预算'] },
};
