import type { Tuple } from '@smartsell/ui';

// Settings page copy as [繁中, English] tuples.
export const text = {
  subtitle: ['只有你能做的幾件事，以及目前的設定。日常錄入交給 Agent。', 'The few things only you can do, plus how things are set up. Your agent handles day-to-day data entry.'],
  role: ['你的角色', 'Your role'],
  close: ['關閉', 'Close'], cancel: ['取消', 'Cancel'], required: ['必填', 'Required'],
  fillRequired: ['請填寫標示 * 的欄位（不能只有空白）。', 'Fill in the fields marked * (spaces alone do not count).'],
  unknown: ['未知', 'Unknown'], loadingShort: ['讀取中', 'Loading'],

  // Setup summary
  summary: ['設定概況', 'Setup at a glance'],
  publishingOk: ['發布正常進行', 'Publishing is running'], publishingPaused: ['發布已暫停（{n} 個範圍）', 'Publishing paused ({n} scopes)'],
  brandsCount: ['{b} 個品牌、{m} 個市場', '{b} brands, {m} markets'], noMarkets: ['尚未設定市場', 'No markets yet'], brandsOnly: ['{b} 個品牌', '{b} brands'],
  accountsCount: ['{n} 個社群帳號', '{n} social accounts'], accountsNone: ['尚未登記社群帳號', 'No social accounts yet'],
  accountsNoneActive: ['{n} 個帳號，全部停用', '{n} accounts, all disabled'],
  agentConnected: ['Agent 已連接', 'Agent connected'], agentNone: ['尚未連接 Agent', 'No agent connected'],

  // Emergency pause
  pauseTitle: ['緊急暫停發布', 'Emergency publishing pause'],
  pauseIntro: ['遇到品牌危機、內容出錯或帳號異常時，可立即停下排定的發布。Agent 也能暫停，但只有人能解除。', 'When something goes wrong, stop scheduled publishing at once. Your agent can pause too, but only a person can release a pause.'],
  pauseRunning: ['目前沒有任何暫停，排定的發布會照常送出。', 'Nothing is paused; scheduled posts go out as planned.'],
  pauseActive: ['以下範圍的發布已暫停，直到有人解除：', 'Publishing is paused for these scopes until someone releases it:'],
  pauseButton: ['暫停發布…', 'Pause publishing…'], pauseMore: ['再暫停其他範圍…', 'Pause another scope…'],
  pauseNotAllowed: ['你的角色不能暫停發布。', 'Your role cannot pause publishing.'],
  scopeWorkspace: ['全部發布（整個工作區）', 'All publishing (whole workspace)'], scopeBrand: ['品牌', 'Brand'], scopeAccount: ['社群帳號', 'Social account'],
  scopeCampaign: ['推廣計劃', 'Plan'], scopeOther: ['其他範圍', 'Other scope'],
  pausedBy: ['暫停者', 'Paused by'], pausedAt: ['暫停於', 'Paused'], modeUnschedule: ['同時撤回平台上已排程的貼文', 'Also withdraws posts already scheduled on the platform'],
  held: ['擋下 {n} 則發布', 'Holding {n} posts'], heldMissed: ['其中 {n} 則已錯過原定時間', '{n} already past their planned time'],
  heldNone: ['目前沒有被擋下的發布', 'No posts are held right now'], heldUnknown: ['擋下的發布數量未知', 'Number of held posts unknown'],
  heldAtLeast: ['擋下至少 {n} 則發布', 'Holding at least {n} posts'],
  release: ['解除暫停', 'Release pause'], releaseConfirm: ['確定解除', 'Release now'], releasing: ['解除中…', 'Releasing…'],
  releaseImpact: ['解除後，被擋下的 {n} 則發布會恢復排程。', 'After release, the {n} held posts are scheduled again.'],
  releaseImpactNone: ['解除後，這個範圍的發布會恢復照常送出。', 'After release, publishing in this scope resumes as planned.'],
  releaseMissed: ['已錯過原定時間的 {n} 則，會依各自的逾時設定處理：略過，或出現在「待你決定」。', 'The {n} posts past their planned time follow their late policy: skipped, or sent to Decisions.'],
  releaseNotAllowed: ['只有擁有者、管理員或經理可以解除暫停。', 'Only an owner, admin or manager can release a pause.'],
  released: ['已解除暫停', 'Pause released'], paused: ['已暫停發布', 'Publishing paused'],
  history: ['最近解除的暫停', 'Recently released'], releasedAt: ['解除於', 'Released'],
  reason: ['原因', 'Reason'],

  // Pause dialog
  pauseDialog: ['暫停發布', 'Pause publishing'], pauseScope: ['要暫停哪些發布', 'What to pause'],
  pickBrand: ['選擇品牌', 'Choose a brand'], pickAccount: ['選擇社群帳號', 'Choose a social account'],
  reasonPlaceholder: ['例如：商品標示有誤，先停下所有發布', 'For example: a product label is wrong; stop everything first'],
  reasonHint: ['原因會顯示給團隊和 Agent，方便之後判斷何時解除。', 'The reason is shown to your team and agent so everyone knows when it is safe to release.'],
  unschedule: ['同時撤回已經排到平台上的貼文（平台支援時）', 'Also withdraw posts already scheduled on the platform (where supported)'],
  unscheduleHint: ['不勾選時，已經排到平台上的貼文可能仍會照原定時間發出。', 'If unchecked, posts already scheduled on the platform may still go out on time.'],
  pauseWarning: ['暫停後，範圍內所有尚未發出的排程都會停下，直到有人解除。', 'Once paused, every scheduled post in this scope stops until someone releases it.'],
  pauseSubmit: ['立即暫停', 'Pause now'], pausing: ['暫停中…', 'Pausing…'],
  pauseSame: ['這個範圍已經在暫停中。', 'This scope is already paused.'],

  // Brands and markets
  brandsHint: ['品牌與市場由 Agent 建立與維護；這裡只顯示目前的設定。', 'Your agent creates and maintains brands and markets; this is a read-only summary.'],
  brandsMore: ['幫我再新增一個品牌，並設定它要經營的市場（國家、語言、幣別、時區）', 'Add another brand and set up the markets it sells in (country, language, currency, time zone)'],
  marketsEmpty: ['「{brand}」還沒有市場', '“{brand}” has no markets yet'],
  marketsPrompt: ['幫我為「{brand}」設定要經營的市場：國家、語言、幣別和時區', 'Set up the markets “{brand}” sells in: country, language, currency and time zone'],
  defaultMarket: ['預設市場', 'Default market'], archived: ['已封存', 'Archived'],
  addMoreTitle: ['要新增品牌或市場？', 'Need another brand or market?'],
  addMoreDetail: ['品牌與市場由 Agent 建立，告訴它你要經營哪裡即可。', 'Your agent creates brands and markets; just tell it where you sell.'],

  // Social accounts
  accountsTitle: ['社群帳號', 'Social accounts'], nextStep: ['下一步', 'Next step'],
  accountsHint: ['社群帳號只能由人登記，Agent 不能代勞。登記後，Agent 才能為它排程發布與匯入成效。', 'Only a person can register a social account. Once it is registered, your agent can schedule posts and import results for it.'],
  register: ['登記自有帳號', 'Register an owned account'], registerNotAllowed: ['只有擁有者或管理員可以登記社群帳號。', 'Only an owner or admin can register social accounts.'],
  accountsEmpty: ['還沒有登記社群帳號', 'No social accounts registered yet'],
  accountActive: ['啟用中', 'Active'], accountDisabled: ['已停用', 'Disabled'], accountPaused: ['發布暫停中', 'Publishing paused'],
  authorize: ['平台授權與裝置', 'Platform authorization and devices'],
  authorizeHint: ['要讓 SmartSell 自動發布或採集成效，請到進階工作台完成平台授權。', 'To publish automatically or collect results, authorize the platform in the advanced workbench.'],
  registered: ['已登記「{name}」', 'Registered “{name}”'],
  registeredPrompt: ['幫我匯入「{name}」最近 30 天的成效，並規劃它下週的發布', 'Import the last 30 days of results for “{name}” and plan its posts for next week'],
  accountId: ['平台帳號 ID', 'Platform account ID'],
  noBrandForAccount: ['先要有品牌，才能登記社群帳號。', 'A brand is needed before you can register a social account.'],

  // Register dialog
  registerDialog: ['登記自有社群帳號', 'Register an owned social account'], brand: ['品牌', 'Brand'], platform: ['平台', 'Platform'],
  pickPlatform: ['選擇平台', 'Choose a platform'], displayName: ['顯示名稱', 'Display name'],
  displayNameHint: ['在 SmartSell 裡顯示的名稱，例如：悅數美妝 IG', 'The name shown in SmartSell, for example: Yueshu Beauty IG'],
  accountIdHint: ['在平台的帳號設定或個人主頁網址中可找到。', 'Find it in the platform account settings or profile URL.'],
  timezone: ['發布時區', 'Publishing time zone'], timezoneHint: ['排程時間以這個時區為準。', 'Scheduled times use this time zone.'],
  owned: ['我確認這個帳號屬於「{workspace}」（我們公司）所有，我有權登記並管理它。', 'I confirm this account is owned by “{workspace}” (our company) and I am authorized to register and manage it.'],
  ownedHint: ['只能登記你們公司擁有的帳號；他人（例如合作達人）的帳號不在這裡登記。', 'Register only accounts your company owns; other people’s accounts (such as creators you work with) are not registered here.'],
  registerSubmit: ['登記帳號', 'Register account'], registering: ['登記中…', 'Registering…'],

  // Members
  membersHint: ['新增成員或調整權限，請到進階工作台。', 'Invite members or change roles in the advanced workbench.'],
  you: ['（你）', ' (you)'], youShort: ['你', 'You'], member: ['成員', 'Member'], allScopes: ['可存取全部品牌與資源', 'Access to all brands and resources'],
  limitedScopes: ['限定範圍：', 'Limited to: '], manageMembers: ['管理成員與權限', 'Manage members and access'],
  membersEmpty: ['沒有可顯示的成員', 'No members to show'], membersUnnamed: ['其他成員目前只顯示帳號代碼。', 'Other members show only an account code for now.'],

  // Agent
  agentHint: ['Agent 透過 MCP 替你錄入商品、計劃與排期。它可以暫停發布，但審批、登記帳號、解除暫停等決定只能由你做。', 'Your agent enters products, plans and schedules through MCP. It may pause publishing, but approvals, account registration and releasing pauses stay with you.'],
  agentCount: ['{n} 個 Agent 連線有效', '{n} active agent connections'], agentLastUsed: ['最後使用：', 'Last used: '], agentNever: ['尚未使用', 'Not used yet'],
  openAgent: ['前往 Agent 頁面', 'Open the Agent page'],

  // Language
  languageHint: ['只改變這個瀏覽器的介面語言；貼文與商品內容的語言由各市場設定決定。', 'Changes the interface language in this browser only; post and product languages follow each market.'],

  // Advanced workbench
  advancedHint: ['Agent 無法使用時的備援：可以在那裡手動輸入資料、查看原始紀錄，以及處理平台授權、裝置與帳號安全。', 'The fallback when your agent is unavailable: enter data by hand, inspect raw records, and handle platform authorization, devices and account security.'],
  openAdvanced: ['開啟進階工作台', 'Open the advanced workbench'],
} as const satisfies Record<string, Tuple>;
