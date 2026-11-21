import type { Tuple } from '@smartsell/ui';

// Plan pages copy as [繁中, English] tuples, read through useText().l.
export const planCopy = {
  listSubtitle: ['哪些推廣計劃在跑、進度如何、錢花了多少', 'Which plans are running, how far along they are and what they have spent'],
  detailSubtitle: ['這個計劃進度如何、還缺什麼、哪些事等你決定', 'How this plan is going, what is missing and what waits for you'],
  back: ['全部推廣計劃', 'All plans'],
  all: ['全部', 'All'], phaseFilter: ['依狀態篩選', 'Filter by status'],
  phase: {
    live: ['進行中', 'Running'], upcoming: ['即將開始', 'Upcoming'], ended: ['已結束', 'Ended'], draft: ['草稿', 'Drafts'],
  } satisfies Record<string, Tuple>,
  gantt: ['時程', 'Timeline'], undated: ['{n} 個計劃尚未設定期間', '{n} plans have no dates yet'],
  outside: ['{n} 個計劃不在此時程範圍內', '{n} plans fall outside this timeline'],
  olderEnded: ['{n} 個較早結束的計劃未列入（可切到「已結束」查看）', '{n} plans that ended earlier are left out (see Ended)'],
  notSetYet: ['尚未設定：{list}', 'Not set yet: {list}'], listJoin: ['、', ', '],
  noneInPhase: ['沒有符合此狀態的推廣計劃', 'No plans with this status'],
  // Period and progress
  dayOf: ['第 {day} 天／共 {days} 天', 'Day {day} of {days}'], startsIn: ['{n} 天後開始', 'Starts in {n} days'], startsTomorrow: ['明天開始', 'Starts tomorrow'],
  startsToday: ['今天開始', 'Starts today'], ended: ['已結束', 'Ended'], noDates: ['尚未設定期間', 'No dates yet'], openEnded: ['未設定結束日', 'No end date'],
  // Summary
  summaryLive: ['進行中', 'Running'], summaryUpcoming: ['即將開始', 'Upcoming'], summaryDecisions: ['待你決定', 'Waiting for you'],
  summarySpend: ['進行中計劃已記錄的花費', 'Recorded spend on running plans'], ofBudget: ['預算 {b}', 'of {b} budget'],
  budgetHiddenSome: ['部分計劃的預算你無權查看', 'Some plan budgets are not visible to your role'],
  // Content completeness
  completeness: ['內容完成度', 'Content completeness'], nothingPlanned: ['尚未規劃內容數量，完成度未知', 'No content planned yet; completeness unknown'],
  filledOf: ['{a}／規劃 {b} 則', '{a} of {b} planned'], gap: ['缺 {n} 則', '{n} missing'], noGap: ['已全部到位', 'All in place'],
  beyondPlan: ['另有 {n} 則超出規劃數量', '{n} more than planned'], excessCell: ['超出 {n}', '{n} over'],
  part: { published: ['已發布', 'Published'], scheduled: ['已排程', 'Scheduled'], in_production: ['製作中', 'In production'], failed: ['失敗', 'Failed'] } satisfies Record<string, Tuple>,
  // Goals
  goals: ['目標', 'Goals'], noGoals: ['尚未設定目標', 'No goals set'], moreGoals: ['另有 {n} 個目標', '{n} more goals'],
  ofTarget: ['目標 {b}', 'target {b}'], reached: ['已達標', 'Reached'], due: ['截止 {d}', 'due {d}'],
  goalNotCollected: ['未採集', 'Not collected'],
  coverage: {
    unknown: ['尚無可計算的數據', 'Nothing to compute yet'], unavailable: ['此指標無法按計劃計算', 'This metric cannot be measured per plan'],
    partial: ['部分採集', 'Partly collected'],
  } satisfies Record<string, Tuple>,
  // Budget
  budget: ['預算', 'Budget'], budgetHidden: ['你的角色無法查看預算', 'Your role cannot see budgets'], noBudget: ['尚未登記預算', 'No budget recorded'],
  used: ['已用 {p}', '{p} used'], spent: ['已記錄花費', 'Recorded spend'], committed: ['已承諾未付', 'Committed, unpaid'], remaining: ['剩餘', 'Remaining'], budgetTotal: ['預算', 'Budget'],
  overrun: ['超出預算 {a}', 'Over budget by {a}'], provisional: ['結案對帳前，花費可能尚未全部入帳', 'Spend may be incomplete until the plan is closed out'],
  // Products
  products: ['商品', 'Products'], noProducts: ['尚未加入商品', 'No products added'], moreProducts: ['+{n}', '+{n}'],
  stockUnknown: ['庫存未採集', 'Stock not collected'],
  role: { hero: ['主推', 'Hero'], supporting: ['搭配', 'Supporting'], bundle: ['組合', 'Bundle'], gift: ['贈品', 'Gift'] } satisfies Record<string, Tuple>,
  risk: {
    out_of_stock: ['已缺貨', 'Went out of stock'], became_unavailable: ['已無法購買', 'Became unavailable'], became_available: ['恢復可購買', 'Available again'],
    stock_low: ['庫存偏低', 'Stock running low'], price_changed: ['價格有變動', 'Price changed'], product_removed: ['商品已下架', 'Product removed'],
    localization_stale: ['在地化內容過時', 'Localization out of date'],
  } satisfies Record<string, Tuple>,
  // Publication and decisions
  nextPublication: ['下一則發布', 'Next post'], noNext: ['沒有待發布的內容', 'Nothing waiting to publish'],
  needsDecision: ['{n} 項待你決定', '{n} waiting for you'], decisions: ['待你決定', 'Waiting for your decision'],
  byAgent: ['由 Agent 建立', 'Created by your agent'],
  // Detail sections
  summary: ['現況', 'At a glance'], matrix: ['內容矩陣', 'Content matrix'], matrixAccount: ['平台／帳號', 'Platform / account'],
  anyAccount: ['任一帳號', 'Any account'], planned: ['規劃', 'Planned'], gapCol: ['缺口', 'Gap'], totalRow: ['合計', 'Total'],
  stage: { teaser: ['預熱', 'Teaser'], launch: ['上市', 'Launch'], sustain: ['延續', 'Sustain'], conversion: ['轉換', 'Conversion'], recap: ['回顧', 'Recap'], custom: ['自訂', 'Custom'] } satisfies Record<string, Tuple>,
  outsidePlan: ['{n} 則排期不在任何規劃格內', '{n} scheduled posts do not match any planned slot'],
  unplannedItems: ['{n} 則內容尚未排期', '{n} content items are not scheduled yet'],
  schedule: ['日程', 'Schedule'], openCalendar: ['在日曆中查看', 'Open in calendar'], noEvents: ['這個計劃還沒有任何排程', 'Nothing is scheduled for this plan yet'],
  earlier: ['顯示較早的 {n} 項', 'Show {n} earlier items'], today: ['今天', 'Today'], hideEarlier: ['隱藏較早的項目', 'Hide earlier items'], until: ['至 {d}', 'until {d}'],
  milestones: ['里程碑', 'Milestones'], noMilestones: ['沒有設定里程碑', 'No milestones set'], overdue: ['已逾期', 'Overdue'], blocked: ['受阻', 'Blocked'],
  milestoneDone: ['已完成', 'Done'], milestoneOpen: ['進行中', 'Open'],
  content: ['內容', 'Content'], noContent: ['還沒有內容', 'No content yet'], noTargets: ['尚未排期', 'Not scheduled'], productionDue: ['製作期限 {d}', 'Production due {d}'],
  showAll: ['顯示全部 {n} 項', 'Show all {n}'], showLess: ['收合', 'Show less'],
  productionStage: {
    accepted: ['已確認', 'Accepted'], drafting: ['撰寫中', 'Drafting'], design: ['設計中', 'In design'], awaiting_assets: ['等待素材', 'Awaiting assets'],
    internal_review: ['內部審閱', 'Internal review'], ready: ['可發布', 'Ready'], archived: ['已封存', 'Archived'],
  } satisfies Record<string, Tuple>,
  ads: ['投放', 'Ads'], adsSpend: ['投放花費', 'Ad spend'], proposals: ['投放方案', 'Ad proposals'], noAds: ['這個計劃沒有投放方案', 'No ad proposals for this plan'],
  adsHidden: ['投放資料只對有投放帳戶權限的成員顯示', 'Ad data is shown only to members with ad-account access'],
  spendUnknown: ['花費未採集', 'Spend not collected'], coverageDays: ['已回報 {p} 的天數', '{p} of days reported'], delayed: ['數據延遲', 'Data delayed'],
  daily: ['每日 {a}', '{a} per day'], lifetime: ['總額 {a}', '{a} total'], estimates: ['預估', 'Estimates'], approval: ['審批', 'Approval'],
  openAds: ['投放頁', 'Ads page'],
  nextStep: ['建議下一步', 'Suggested next step'],
  notFound: ['找不到這個推廣計劃，可能已被刪除或你沒有權限', 'This plan was not found; it may be deleted or not visible to you'],
} as const;

export const targetStatus: Record<string, { tone: 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info'; label: Tuple }> = {
  executing: { tone: 'info', label: ['發布中', 'Publishing'] }, cancel_requested: { tone: 'neutral', label: ['取消中', 'Cancelling'] },
  ready: { tone: 'info', label: ['已排程', 'Scheduled'] }, manual: { tone: 'warning', label: ['待手動發布', 'Manual posting'] },
  in_review: { tone: 'warning', label: ['審核中', 'In review'] }, proposed: { tone: 'warning', label: ['待審批', 'Proposed'] },
  exported: { tone: 'info', label: ['已匯出', 'Exported'] }, over_budget: { tone: 'serious', label: ['超出預算', 'Over budget'] },
};
