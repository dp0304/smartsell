import type { Tuple } from '@smartsell/ui';

// Settings page copy as [繁中, English, 简中?] tuples.
export const text = {
  subtitle: ['只有你能做的幾件事，以及目前的設定。日常錄入交給 Agent。', 'The few things only you can do, plus how things are set up. Your agent handles day-to-day data entry.', '只有你能做的几件事，以及目前的设置。日常录入交给 Agent。'],
  role: ['你的角色', 'Your role'],
  close: ['關閉', 'Close', '关闭'], cancel: ['取消', 'Cancel'], required: ['必填', 'Required'],
  fillRequired: ['請填寫標示 * 的欄位（不能只有空白）。', 'Fill in the fields marked * (spaces alone do not count).', '请填写标示 * 的字段（不能只有空白）。'],
  unknown: ['未知', 'Unknown'], loadingShort: ['讀取中', 'Loading', '读取中'],

  // Setup summary
  summary: ['設定概況', 'Setup at a glance', '设置概况'],
  publishingOk: ['發布正常進行', 'Publishing is running', '发布正常进行'], publishingPaused: ['發布已暫停（{n} 個範圍）', 'Publishing paused ({n} scopes)', '发布已暂停（{n} 个范围）'],
  brandsCount: ['{b} 個品牌、{m} 個市場', '{b} brands, {m} markets', '{b} 个品牌、{m} 个市场'], noMarkets: ['尚未設定市場', 'No markets yet', '尚未设置市场'], brandsOnly: ['{b} 個品牌', '{b} brands', '{b} 个品牌'],
  accountsCount: ['{n} 個社群帳號', '{n} social accounts', '{n} 个社交媒体账号'], accountsNone: ['尚未登記社群帳號', 'No social accounts yet', '尚未登记社交媒体账号'],
  accountsNoneActive: ['{n} 個帳號，全部停用', '{n} accounts, all disabled', '{n} 个账号，全部禁用'],
  agentConnected: ['Agent 已連接', 'Agent connected', 'Agent 已连接'], agentNone: ['尚未連接 Agent', 'No agent connected', '尚未连接 Agent'],

  // Emergency pause
  pauseTitle: ['緊急暫停發布', 'Emergency publishing pause', '紧急暂停发布'],
  pauseIntro: ['遇到品牌危機、內容出錯或帳號異常時，可立即停下排定的發布。Agent 也能暫停，但只有人能解除。', 'When something goes wrong, stop scheduled publishing at once. Your agent can pause too, but only a person can release a pause.', '遇到品牌危机、内容出错或账号异常时，可立即停下排定的发布。Agent 也能暂停，但只有人能解除。'],
  pauseRunning: ['目前沒有任何暫停，排定的發布會照常送出。', 'Nothing is paused; scheduled posts go out as planned.', '目前没有任何暂停，排定的发布会照常送出。'],
  pauseActive: ['以下範圍的發布已暫停，直到有人解除：', 'Publishing is paused for these scopes until someone releases it:', '以下范围的发布已暂停，直到有人解除：'],
  pauseButton: ['暫停發布…', 'Pause publishing…', '暂停发布…'], pauseMore: ['再暫停其他範圍…', 'Pause another scope…', '再暂停其他范围…'],
  pauseNotAllowed: ['你的角色不能暫停發布。', 'Your role cannot pause publishing.', '你的角色不能暂停发布。'],
  scopeWorkspace: ['全部發布（整個工作區）', 'All publishing (whole workspace)', '全部发布（整个工作区）'], scopeBrand: ['品牌', 'Brand'], scopeAccount: ['社群帳號', 'Social account', '社交媒体账号'],
  scopeCampaign: ['推廣計劃', 'Plan', '推广计划'], scopeOther: ['其他範圍', 'Other scope', '其他范围'],
  pausedBy: ['暫停者', 'Paused by', '暂停者'], pausedAt: ['暫停於', 'Paused', '暂停于'], modeUnschedule: ['同時撤回平台上已排程的貼文', 'Also withdraws posts already scheduled on the platform', '同时撤回平台上已调度的帖子'],
  held: ['擋下 {n} 則發布', 'Holding {n} posts', '挡下 {n} 则发布'], heldMissed: ['其中 {n} 則已錯過原定時間', '{n} already past their planned time', '其中 {n} 则已错过原定时间'],
  heldNone: ['目前沒有被擋下的發布', 'No posts are held right now', '目前没有被挡下的发布'], heldUnknown: ['擋下的發布數量未知', 'Number of held posts unknown', '挡下的发布数量未知'],
  heldAtLeast: ['擋下至少 {n} 則發布', 'Holding at least {n} posts', '挡下至少 {n} 则发布'],
  release: ['解除暫停', 'Release pause', '解除暂停'], releaseConfirm: ['確定解除', 'Release now', '确定解除'], releasing: ['解除中…', 'Releasing…'],
  releaseImpact: ['解除後，被擋下的 {n} 則發布會恢復排程。', 'After release, the {n} held posts are scheduled again.', '解除后，被挡下的 {n} 则发布会恢复调度。'],
  releaseImpactNone: ['解除後，這個範圍的發布會恢復照常送出。', 'After release, publishing in this scope resumes as planned.', '解除后，这个范围的发布会恢复照常送出。'],
  releaseMissed: ['已錯過原定時間的 {n} 則，會依各自的逾時設定處理：略過，或出現在「待你決定」。', 'The {n} posts past their planned time follow their late policy: skipped, or sent to Decisions.', '已错过原定时间的 {n} 则，会依各自的逾时设置处理：略过，或出现在「待你决定」。'],
  releaseNotAllowed: ['只有擁有者、管理員或經理可以解除暫停。', 'Only an owner, admin or manager can release a pause.', '只有拥有者、管理员或经理可以解除暂停。'],
  released: ['已解除暫停', 'Pause released', '已解除暂停'], paused: ['已暫停發布', 'Publishing paused', '已暂停发布'],
  history: ['最近解除的暫停', 'Recently released', '最近解除的暂停'], releasedAt: ['解除於', 'Released', '解除于'],
  reason: ['原因', 'Reason'],

  // Pause dialog
  pauseDialog: ['暫停發布', 'Pause publishing', '暂停发布'], pauseScope: ['要暫停哪些發布', 'What to pause', '要暂停哪些发布'],
  pickBrand: ['選擇品牌', 'Choose a brand', '选择品牌'], pickAccount: ['選擇社群帳號', 'Choose a social account', '选择社交媒体账号'],
  reasonPlaceholder: ['例如：商品標示有誤，先停下所有發布', 'For example: a product label is wrong; stop everything first', '例如：商品标示有误，先停下所有发布'],
  reasonHint: ['原因會顯示給團隊和 Agent，方便之後判斷何時解除。', 'The reason is shown to your team and agent so everyone knows when it is safe to release.', '原因会显示给团队和 Agent，方便之后判断何时解除。'],
  unschedule: ['同時撤回已經排到平台上的貼文（平台支援時）', 'Also withdraw posts already scheduled on the platform (where supported)', '同时撤回已经排到平台上的帖子（平台支持时）'],
  unscheduleHint: ['不勾選時，已經排到平台上的貼文可能仍會照原定時間發出。', 'If unchecked, posts already scheduled on the platform may still go out on time.', '不勾选时，已经排到平台上的帖子可能仍会照原定时间发出。'],
  pauseWarning: ['暫停後，範圍內所有尚未發出的排程都會停下，直到有人解除。', 'Once paused, every scheduled post in this scope stops until someone releases it.', '暂停后，范围内所有尚未发出的调度都会停下，直到有人解除。'],
  pauseSubmit: ['立即暫停', 'Pause now', '立即暂停'], pausing: ['暫停中…', 'Pausing…', '暂停中…'],
  pauseSame: ['這個範圍已經在暫停中。', 'This scope is already paused.', '这个范围已经在暂停中。'],

  // Brands and markets
  brandsHint: ['品牌與市場由 Agent 建立與維護；這裡只顯示目前的設定。', 'Your agent creates and maintains brands and markets; this is a read-only summary.', '品牌与市场由 Agent 创建与维护；这里只显示目前的设置。'],
  brandsMore: ['幫我再新增一個品牌，並設定它要經營的市場（國家、語言、幣別、時區）', 'Add another brand and set up the markets it sells in (country, language, currency, time zone)', '帮我再添加一个品牌，并设置它要经营的市场（国家、语言、币别、时区）'],
  marketsEmpty: ['「{brand}」還沒有市場', '“{brand}” has no markets yet', '「{brand}」还没有市场'],
  marketsPrompt: ['幫我為「{brand}」設定要經營的市場：國家、語言、幣別和時區', 'Set up the markets “{brand}” sells in: country, language, currency and time zone', '帮我为「{brand}」设置要经营的市场：国家、语言、币别和时区'],
  defaultMarket: ['預設市場', 'Default market', '预设市场'], archived: ['已封存', 'Archived'],
  addMoreTitle: ['要新增品牌或市場？', 'Need another brand or market?', '要添加品牌或市场？'],
  addMoreDetail: ['品牌與市場由 Agent 建立，告訴它你要經營哪裡即可。', 'Your agent creates brands and markets; just tell it where you sell.', '品牌与市场由 Agent 创建，告诉它你要经营哪里即可。'],

  // Social accounts
  accountsTitle: ['社群帳號', 'Social accounts', '社交媒体账号'], nextStep: ['下一步', 'Next step'],
  accountsHint: ['社群帳號只能由人登記，Agent 不能代勞。登記後，Agent 才能為它排程發布與匯入成效。', 'Only a person can register a social account. Once it is registered, your agent can schedule posts and import results for it.', '社交媒体账号只能由人登记，Agent 不能代劳。登记后，Agent 才能为它调度发布与导入成效。'],
  register: ['登記自有帳號', 'Register an owned account', '登记自有账号'], registerNotAllowed: ['只有擁有者或管理員可以登記社群帳號。', 'Only an owner or admin can register social accounts.', '只有拥有者或管理员可以登记社交媒体账号。'],
  accountsEmpty: ['還沒有登記社群帳號', 'No social accounts registered yet', '还没有登记社交媒体账号'],
  accountActive: ['啟用中', 'Active', '激活中'], accountDisabled: ['已停用', 'Disabled', '已禁用'], accountPaused: ['發布暫停中', 'Publishing paused', '发布暂停中'],
  authorize: ['平台授權與裝置', 'Platform authorization and devices', '平台授权与设备'],
  authorizeHint: ['要讓 SmartSell 自動發布或採集成效，請到進階工作台完成平台授權。', 'To publish automatically or collect results, authorize the platform in the advanced workbench.', '要让 SmartSell 自动发布或采集成效，请到高级工作台完成平台授权。'],
  registered: ['已登記「{name}」', 'Registered “{name}”', '已登记「{name}」'],
  registeredPrompt: ['幫我匯入「{name}」最近 30 天的成效，並規劃它下週的發布', 'Import the last 30 days of results for “{name}” and plan its posts for next week', '帮我导入「{name}」最近 30 天的成效，并规划它下周的发布'],
  accountId: ['平台帳號 ID', 'Platform account ID', '平台账号 ID'],
  noBrandForAccount: ['先要有品牌，才能登記社群帳號。', 'A brand is needed before you can register a social account.', '先要有品牌，才能登记社交媒体账号。'],

  // Register dialog
  registerDialog: ['登記自有社群帳號', 'Register an owned social account', '登记自有社交媒体账号'], brand: ['品牌', 'Brand'], platform: ['平台', 'Platform'],
  pickPlatform: ['選擇平台', 'Choose a platform', '选择平台'], displayName: ['顯示名稱', 'Display name', '显示名称'],
  displayNameHint: ['在 SmartSell 裡顯示的名稱，例如：悅數美妝 IG', 'The name shown in SmartSell, for example: Yueshu Beauty IG', '在 SmartSell 里显示的名称，例如：悦数美妆 IG'],
  accountIdHint: ['在平台的帳號設定或個人主頁網址中可找到。', 'Find it in the platform account settings or profile URL.', '在平台的账号设置或个人主页网址中可找到。'],
  timezone: ['發布時區', 'Publishing time zone', '发布时区'], timezoneHint: ['排程時間以這個時區為準。', 'Scheduled times use this time zone.', '调度时间以这个时区为准。'],
  owned: ['我確認這個帳號屬於「{workspace}」（我們公司）所有，我有權登記並管理它。', 'I confirm this account is owned by “{workspace}” (our company) and I am authorized to register and manage it.', '我确认这个账号属于「{workspace}」（我们公司）所有，我有权登记并管理它。'],
  ownedHint: ['只能登記你們公司擁有的帳號；他人（例如合作達人）的帳號不在這裡登記。', 'Register only accounts your company owns; other people’s accounts (such as creators you work with) are not registered here.', '只能登记你们公司拥有的账号；他人（例如合作达人）的账号不在这里登记。'],
  registerSubmit: ['登記帳號', 'Register account', '登记账号'], registering: ['登記中…', 'Registering…', '登记中…'],

  // Members
  membersHint: ['新增成員或調整權限，請到進階工作台。', 'Invite members or change roles in the advanced workbench.', '添加成员或调整权限，请到高级工作台。'],
  you: ['（你）', ' (you)'], youShort: ['你', 'You'], member: ['成員', 'Member', '成员'], allScopes: ['可存取全部品牌與資源', 'Access to all brands and resources', '可访问全部品牌与资源'],
  limitedScopes: ['限定範圍：', 'Limited to: ', '限定范围：'], manageMembers: ['管理成員與權限', 'Manage members and access', '管理成员与权限'],
  membersEmpty: ['沒有可顯示的成員', 'No members to show', '没有可显示的成员'], membersUnnamed: ['其他成員目前只顯示帳號代碼。', 'Other members show only an account code for now.', '其他成员目前只显示账号代码。'],

  // Agent
  agentHint: ['Agent 透過 MCP 替你錄入商品、計劃與排期。它可以暫停發布，但審批、登記帳號、解除暫停等決定只能由你做。', 'Your agent enters products, plans and schedules through MCP. It may pause publishing, but approvals, account registration and releasing pauses stay with you.', 'Agent 透过 MCP 替你录入商品、计划与排期。它可以暂停发布，但审批、登记账号、解除暂停等决定只能由你做。'],
  agentCount: ['{n} 個 Agent 連線有效', '{n} active agent connections', '{n} 个 Agent 连接有效'], agentLastUsed: ['最後使用：', 'Last used: ', '最后使用：'], agentNever: ['尚未使用', 'Not used yet'],
  openAgent: ['前往 Agent 頁面', 'Open the Agent page', '前往 Agent 页面'],

  // Language
  languageHint: ['只改變這個瀏覽器的介面語言；貼文與商品內容的語言由各市場設定決定。', 'Changes the interface language in this browser only; post and product languages follow each market.', '只改变这个浏览器的界面语言；帖子与商品内容的语言由各市场设置决定。'],

  // Advanced workbench
  advancedHint: ['Agent 無法使用時的備援：可以在那裡手動輸入資料、查看原始紀錄，以及處理平台授權、裝置與帳號安全。', 'The fallback when your agent is unavailable: enter data by hand, inspect raw records, and handle platform authorization, devices and account security.', 'Agent 无法使用时的备援：可以在那里手动输入数据、查看原始记录，以及处理平台授权、设备与账号安全。'],
  openAdvanced: ['開啟進階工作台', 'Open the advanced workbench', '打开高级工作台'],
} as const satisfies Record<string, Tuple>;
