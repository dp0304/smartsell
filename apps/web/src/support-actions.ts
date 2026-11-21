import type { Action, Field } from './catalog';
import { rowActions, text, type Action as WorkspaceAction } from './actions';

export const conversationWorkspaceActions: WorkspaceAction[] = [
  ...rowActions.conversations.map(action => {
    if (action.path.endsWith('/notes')) return { ...action, fields: [{ ...text('body', ['備註內容', 'Note text', '备注内容']), type: 'textarea' }] } satisfies WorkspaceAction;
    if (action.path.endsWith('/reply-drafts')) return { ...action, fields: [{ ...text('body_text', ['回覆內容', 'Reply text', '回复内容']), type: 'textarea' }] } satisfies WorkspaceAction;
    return action;
  }),
  { path: '/conversations/:id', method: 'PATCH', label: ['處理對話', 'Triage conversation', '处理对话'], versioned: true, fields: [
    { ...text('status', ['狀態', 'Status', '状态']), type: 'select', options: ['open', 'waiting_customer', 'snoozed', 'resolved'] },
    { ...text('priority', ['優先順序', 'Priority', '优先级'], true), type: 'select', options: ['low', 'normal', 'high', 'urgent'] },
    { ...text('assignee_user_id', ['負責人', 'Assignee', '负责人'], true), type: 'ref', lookup: '/members' },
    { ...text('snooze_until', ['暫緩至', 'Snooze until', '暂缓至'], true), type: 'datetime-local' },
  ] },
];

type Label = readonly [zh: string, en: string, hans?: string];

const field = (name: string, label: Label, options: Omit<Field, 'name' | 'label'> = {}): Field => ({ name, label, ...options });
const ref = (name: string, label: Label, module: string, kind: string, optional = false) =>
  field(name, label, { ref: [module, kind], optional });
const pick = (name: string, label: Label, choices: readonly string[], optional = false) =>
  field(name, label, { type: 'select', choices, optional });
const json = (name: string, label: Label, optional = false) => field(name, label, { type: 'json', optional });
const lines = (name: string, label: Label, optional = false) => field(name, label, { type: 'lines', optional });
const action = (label: Label, fields: Field[], options: Omit<Action, 'label' | 'fields'> = {}): Action => ({ label, fields, ...options });
const onRecord = (target: string, id: Field) => ({ target, targetField: id.name });

const name = field('name', ['名稱', 'Name', '名称']);
const title = field('title', ['標題', 'Title', '标题']);
const description = field('description', ['說明', 'Description', '说明'], { type: 'textarea', optional: true });
const locale = field('locale', ['語言代碼', 'Locale', '语言代码']);
const brand = ref('brand_id', ['品牌', 'Brand'], 'workspace', 'brand');
const campaign = ref('campaign_id', ['活動', 'Campaign', '活动'], 'campaign', 'campaign');
const market = ref('market_id', ['市場', 'Market', '市场'], 'workspace', 'market', true);
const version = field('expected_version', ['目前版本', 'Current version'], { type: 'number', integer: true, min: 1 });
const reason = field('reason', ['原因', 'Reason'], { type: 'textarea' });
const from = field('from', ['起始時間', 'From', '起始时间'], { type: 'datetime-local', optional: true });
const to = field('to', ['結束時間', 'To', '结束时间'], { type: 'datetime-local', optional: true });
const tags = lines('tags', ['標籤（每行一個）', 'Tags (one per line)', '标签（每行一个）'], true);
const provider = field('provider', ['平台代碼', 'Provider key', '平台代码']);
const externalAccount = field('external_account_id', ['平台帳號識別碼', 'External account ID', '平台账号识别码']);
const connection = ref('connection_id', ['連線', 'Connection', '连接'], 'account', 'connection');
const socialAccount = ref('social_account_id', ['社群帳號', 'Social account', '社交媒体账号'], 'account', 'social_account');
const asset = ref('asset_id', ['素材', 'Asset'], 'asset', 'asset');
const assetKind = ['image', 'video', 'audio', 'subtitle', 'document', 'design_link'];
const fileObject = field('file_object_id', ['已上傳檔案識別碼', 'Uploaded file ID', '已上传文件识别码']);
const creator = ref('creator_id', ['創作者', 'Creator', '创作者'], 'creator', 'creator');
const collaboration = ref('collaboration_id', ['合作案', 'Collaboration'], 'creator', 'collaboration');
const liveSession = field('live_session_id', ['直播企劃 ID', 'Live plan ID', '直播企划 ID']);
const liveDate = (name: string, label: Label, optional = false) => field(name, label, { type: 'datetime-local', optional });
const watch = ref('watch_target_id', ['監測目標', 'Watch target', '监测目标'], 'intel', 'watch_target');
const shortLink = ref('short_link_id', ['短連結', 'Short link', '短链接'], 'traffic', 'short_link');
const landingPage = ref('page_id', ['到達頁', 'Landing page', '到达页'], 'traffic', 'landing_page');
const destination = ref('landing_destination_id', ['連結目的地', 'Landing destination', '链接目的地'], 'traffic', 'landing_destination', true);
const productVariant = ref('product_variant_id', ['商品規格', 'Product variant', '商品规格'], 'commerce', 'product_variant', true);
const utmFields = [json('utm_params', ['UTM 參數', 'UTM parameters', 'UTM 参数'], true),
  ref('utm_template_id', ['UTM 範本', 'UTM template', 'UTM 范本'], 'traffic', 'utm_template', true),
  json('tokens', ['範本參數', 'Template tokens', '范本参数'], true)];
const customer = ref('customer_id', ['顧客', 'Customer', '顾客'], 'lifecycle', 'customer');
const channel = pick('channel', ['聯繫管道', 'Contact channel', '联系管道'], ['email', 'sms', 'whatsapp', 'push', 'site_tracking', 'platform_dm']);
const purpose = pick('purpose', ['同意用途', 'Consent purpose'], ['marketing', 'service']);
const consentText = ref('consent_text_version_id', ['同意文字版本（同意時必填）', 'Consent text version (required for opt-in)', '同意文字版本（同意时必填）'], 'lifecycle', 'consent_text_version', true);
const segment = ref('segment_id', ['客群區隔', 'Segment', '客群区隔'], 'lifecycle', 'segment');
const segmentDefinition = json('definition', ['客群條件', 'Segment definition', '客群条件'], true);
const adAccount = ref('ad_account_id', ['廣告帳號', 'Ad account', '广告账号'], 'ads', 'ad_account');
const adProposal = ref('id', ['廣告提案', 'Ad proposal', '广告提案'], 'ads', 'ad_proposal');
const agentJob = ref('agent_job_id', ['代理工作', 'Agent job'], 'agent', 'agent_job');
const changeSet = ref('change_set_id', ['變更集', 'Change set', '变更集'], 'agent', 'change_set');
const rule = ref('rule_id', ['自動化規則', 'Automation rule', '自动化规则'], 'agent', 'automation_rule');

export const supportActions: Record<string, Action> = {
  // Account registry and device pairing.
  'account.register_account': action(['登記社群帳號', 'Register social account', '登记社交媒体账号'], [provider, externalAccount, name, brand,
    field('default_timezone', ['預設時區', 'Default time zone', '预设时区']), { ...connection, optional: true }, field('owned_account_confirmed', ['確認此為自有帳號', 'Confirm this account is owned', '确认此为自有账号'], { type: 'checkbox' })], { tab: 'social_account', validate: body => !body.connection_id && body.owned_account_confirmed !== true ? 'owned_account_confirmed' : undefined }),
  'account.platform_catalog': action(['查看支援平台', 'View supported platforms', '查看支持平台'], []),
  'account.check_capabilities': action(['查看平台功能', 'Check platform capabilities'], [
    pick('target', ['帳號類型', 'Account type', '账号类型'], ['social_account', 'store_connection']), field('id', ['帳號或連線識別碼', 'Account or connection ID', '账号或连接识别码'])]),
  'account.create_pairing_code': action(['產生配對碼', 'Create pairing code', '产生配对码'], [field('label', ['裝置名稱', 'Device name', '设备名称']),
    pick('host_os', ['作業系統', 'Operating system', '操作系统'], ['macos', 'windows'])], { tab: 'device' }),
  'account.disable_account': action(['停用社群帳號', 'Disable social account', '禁用社交媒体账号'], [socialAccount], { ...onRecord('social_account', socialAccount), confirm: true }),
  'account.enable_account': action(['啟用社群帳號', 'Enable social account', '激活社交媒体账号'], [socialAccount], onRecord('social_account', socialAccount)),
  'account.get_auto_terms': action(['查看自動模式條款', 'View automatic mode terms', '查看自动模式条款'], []),

  // Asset library, rights, and brand knowledge.
  'asset.asset_create': action(['建立素材', 'Create asset', '创建素材'], [brand, title, pick('kind', ['素材類型', 'Asset type', '素材类型'], assetKind), fileObject,
    description, tags, { ...locale, optional: true }], { tab: 'asset' }),
  'asset.asset_search': action(['搜尋素材', 'Search assets', '搜索素材'], [field('q', ['關鍵字', 'Keyword', '关键字'], { optional: true }),
    { ...brand, optional: true }, pick('kind', ['素材類型', 'Asset type', '素材类型'], assetKind, true), field('tag', ['標籤', 'Tag', '标签'], { optional: true }),
    field('favorite_only', ['只看收藏', 'Favorites only'], { type: 'checkbox' })]),
  'asset.asset_get': action(['查看素材詳情', 'View asset details', '查看素材详情'], [asset], onRecord('asset', asset)),
  'asset.asset_usage': action(['查看素材使用情況', 'View asset usage', '查看素材使用情况'], [asset], onRecord('asset', asset)),
  'asset.asset_add_version': action(['新增素材版本', 'Add asset version', '添加素材版本'], [asset, version, fileObject,
    field('change_note', ['版本說明', 'Change note', '版本说明'], { type: 'textarea', optional: true })], onRecord('asset', asset)),
  'asset.asset_folder_create': action(['建立素材資料夾', 'Create asset folder', '创建素材文件夹'], [name, { ...brand, optional: true },
    ref('parent_id', ['上層資料夾', 'Parent folder', '上层文件夹'], 'asset', 'asset_folder', true)], { tab: 'asset' }),
  'asset.rights_create_draft': action(['建立素材授權草稿', 'Create draft rights grant', '创建素材授权草稿'], [brand, asset,
    pick('grant_type', ['授權類型', 'Grant type', '授权类型'], ['owned', 'license', 'ugc_permission', 'creator_contract', 'stock', 'employee']),
    pick('grantor_kind', ['授權方類型', 'Grantor type', '授权方类型'], ['brand', 'creator', 'external_party', 'stock_provider', 'employee']),
    lines('usages', ['使用用途（每行一個）', 'Allowed uses (one per line)', '使用用途（每行一个）']),
    field('valid_from', ['生效時間', 'Valid from', '生效时间'], { type: 'datetime-local' }),
    field('valid_until', ['到期時間', 'Valid until', '到期时间'], { type: 'datetime-local', optional: true }),
    lines('evidence_ids', ['證據識別碼（每行一個）', 'Evidence IDs (one per line)', '证据识别码（每行一个）'], true)], { tab: 'rights_grant' }),
  'asset.rights_list': action(['查看授權清單', 'List rights grants', '查看授权清单'], [{ ...brand, optional: true }, field('status', ['狀態', 'Status', '状态'], { optional: true })]),
  'asset.knowledge_propose': action(['提議品牌知識', 'Propose brand knowledge', '提议品牌知识'], [brand, title,
    pick('kind', ['知識類型', 'Knowledge type', '知识类型'], ['positioning', 'tone', 'forbidden_phrase', 'glossary_term', 'faq', 'example', 'policy', 'product_pointer']),
    field('body', ['內容', 'Body', '内容'], { type: 'textarea' }), lines('locales', ['語言代碼（每行一個）', 'Locales (one per line)', '语言代码（每行一个）'], true),
    json('structured', ['結構化內容', 'Structured content', '结构化内容'], true)], { tab: 'knowledge_entry' }),
  'asset.knowledge_approve': action(['核准知識修訂', 'Approve knowledge revision', '核准知识修订'], [field('revision_id', ['修訂識別碼', 'Revision ID', '修订识别码'])], { tab: 'knowledge_entry' }),
  'asset.knowledge_get_context': action(['查閱品牌知識', 'Get brand knowledge context', '查阅品牌知识'], [brand, market, { ...locale, optional: true },
    field('include_proposed', ['包含待審建議', 'Include proposed revisions', '包含待审建议'], { type: 'checkbox' })], { tab: 'knowledge_entry' }),
  'asset.template_create': action(['建立文案範本', 'Create copy template', '创建文案范本'], [brand, name,
    pick('kind', ['範本類型', 'Template type', '范本类型'], ['text_snippet', 'hashtag_set', 'cta', 'caption_template']),
    field('body', ['範本文案', 'Template copy', '范本文案'], { type: 'textarea' }),
    { ...json('variables', ['變數（JSON 陣列，含 key 與 source）', 'Variables (JSON array with key and source)', '变量（JSON 数组，含 key 与 source）'], true), shape: 'array' }], { tab: 'template' }),
  'asset.template_apply': action(['用範本替換工作稿文案', 'Replace draft copy with template', '用范本替换工作稿文案'], [
    ref('template_id', ['文案範本', 'Copy template', '文案范本'], 'asset', 'template'),
    ref('variant_id', ['內容變體', 'Content variant', '内容变体'], 'content', 'content_variant'), version,
    { ...json('values', ['變數來源參照', 'Variable source references', '变量来源参照'], true), shape: 'object' }], { tab: 'template', target: 'content_variant', targetModule: 'content', targetField: 'variant_id', confirm: true }),

  // Creator profiles and collaborations.
  'creator.creators_create': action(['建立創作者檔案', 'Create creator profile', '创建创作者文件'], [field('display_name', ['顯示名稱', 'Display name', '显示名称']),
    lines('languages', ['語言代碼（每行一個）', 'Languages (one per line)', '语言代码（每行一个）'], true), tags], { tab: 'creator' }),
  'creator.creators_search': action(['搜尋創作者', 'Search creators', '搜索创作者'], [field('q', ['關鍵字', 'Keyword', '关键字'], { optional: true }),
    field('language', ['語言代碼', 'Language', '语言代码'], { optional: true }), field('tag', ['標籤', 'Tag', '标签'], { optional: true }),
    pick('status', ['狀態', 'Status', '状态'], ['active', 'do_not_contact', 'archived'], true)]),
  'creator.creators_get': action(['查看創作者檔案', 'View creator profile', '查看创作者文件'], [creator], onRecord('creator', creator)),
  'creator.creators_import_contacts': action(['匯入聯絡資料', 'Import creator contacts', '导入联系数据'], [creator,
    field('source_ref', ['資料來源', 'Contact source', '数据源']), field('csv', ['CSV（channel,value）', 'CSV (channel,value)'], { type: 'textarea' })], onRecord('creator', creator)),
  'creator.creators_associate_profiles': action(['關聯重複檔案', 'Associate duplicate profiles', '关联重复文件'], [creator,
    ref('related_creator_id', ['另一個創作者', 'Other creator', '另一个创作者'], 'creator', 'creator'), reason,
    lines('evidence_ids', ['證據 ID（每行一個）', 'Evidence IDs (one per line)', '证据 ID（每行一个）'])], onRecord('creator', creator)),
  'creator.creators_revoke_association': action(['撤銷檔案關聯', 'Undo profile association', '撤销文件关联'], [
    field('creator_association_id', ['關聯 ID', 'Association ID', '关联 ID']), version, reason], { target: 'creator_association', targetField: 'creator_association_id' }),
  'creator.creators_override_evaluation': action(['人工覆寫評分', 'Override evaluation', '人工覆写评分'], [
    field('evaluation_id', ['評估 ID', 'Evaluation ID', '评估 ID']), version, reason,
    pick('dimension', ['評估維度', 'Evaluation dimension', '评估维度'], ['brand_fit', 'market_fit', 'content_quality', 'audience_evidence', 'cost_fit'], true),
    json('score', ['分數（0–100 或 null 表示未知）', 'Score (0–100 or null for unknown)', '分数（0–100 或 null 表示未知）'], true),
    lines('evidence_refs', ['評分證據 ID（每行一個）', 'Score evidence IDs (one per line)', '评分证据 ID（每行一个）'], true),
    pick('decision', ['決策', 'Decision', '决策'], ['shortlist', 'exclude', 'hold'], true)], { target: 'evaluation', targetField: 'evaluation_id' }),
  'creator.deliverables_create': action(['要求交付', 'Request deliverable'], [collaboration,
    pick('kind', ['交付類型', 'Deliverable type', '交付类型'], ['short_video', 'image_post', 'story', 'live', 'raw_footage', 'other']),
    liveDate('due_at', ['交付期限', 'Deliverable deadline']), lines('acceptance_criteria', ['驗收條件（每行一個）', 'Acceptance criteria (one per line)', '验收条件（每行一个）']),
    field('publish_target_id', ['相關發布排期 ID', 'Related publication schedule ID', '相关发布排期 ID'], { optional: true })], onRecord('collaboration', collaboration)),
  'creator.deliverables_change_deadline': action(['變更交付期限', 'Change deliverable deadline', '变更交付期限'], [
    field('deliverable_id', ['交付項目 ID', 'Deliverable ID', '交付项目 ID']), version, liveDate('due_at', ['新期限', 'New deadline']), reason],
    { target: 'deliverable', targetField: 'deliverable_id' }),
  'creator.creators_link_account': action(['連結創作者帳號', 'Link creator account', '链接创作者账号'], [creator, provider,
    field('handle', ['帳號名稱', 'Handle', '账号名称'], { optional: true }), { ...externalAccount, optional: true },
    field('profile_url', ['個人檔案網址', 'Profile URL', '个人文件网址'], { type: 'url', optional: true })], onRecord('creator', creator)),
  'creator.collaborations_create': action(['建立合作案', 'Create collaboration', '创建合作案'], [creator, campaign,
    pick('type', ['合作類型', 'Collaboration type', '合作类型'], ['gifted', 'fixed_fee', 'commission', 'hybrid']),
    field('next_action', ['下一步', 'Next action'], { optional: true }),
    field('next_action_due_at', ['下一步截止時間', 'Next action due at', '下一步截止时间'], { type: 'datetime-local', optional: true })], { tab: 'collaboration' }),
  'creator.collaborations_list': action(['查看合作案清單', 'List collaborations', '查看合作案清单'], [{ ...creator, optional: true }, { ...campaign, optional: true },
    field('status', ['狀態', 'Status', '状态'], { optional: true })]),
  'creator.collaborations_get': action(['查看合作案詳情', 'View collaboration details', '查看合作案详情'], [collaboration], onRecord('collaboration', collaboration)),
  'creator.creators_verify_account': action(['記錄帳號核實', 'Record account verification', '记录账号核实'], [field('creator_account_id', ['創作者帳號 ID', 'Creator account ID', '创作者账号 ID']), version,
    field('source_ref', ['核實依據網址', 'Verification source URL', '核实依据网址'], { type: 'url' }),
    field('verification_note', ['核實記錄', 'Verification notes', '核实记录'], { type: 'textarea' })], { target: 'creator_account', targetField: 'creator_account_id' }),
  'creator.creators_record_audience': action(['記錄受眾數據', 'Record audience observation', '记录受众数据'], [creator, version,
    field('market', ['受眾市場', 'Audience market', '受众市场']), field('share_bps', ['佔比（基點，100 = 1%）', 'Share (basis points, 100 = 1%)', '占比（基点，100 = 1%）'], { type: 'number' }),
    pick('source_kind', ['來源', 'Source', '来源'], ['self_reported', 'public', 'manual']), liveDate('observed_at', ['觀測時間', 'Observed at', '观测时间'])], onRecord('creator', creator)),
  'creator.creators_plan_live_session': action(['規劃平台直播', 'Plan external live session', '规划平台直播'], [collaboration,
    field('platform', ['直播平台', 'Live platform']), liveDate('scheduled_at', ['開始時間（瀏覽器時區）', 'Starts at (browser time zone)', '开始时间（浏览器时区）']),
    field('tz', ['直播時區（IANA）', 'Live time zone (IANA)', '直播时区（IANA）'], { default: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    json('run_sheet', ['流程表（JSON：title、product_id、notes）', 'Run sheet (JSON: title, product_id, notes)'], true),
    lines('warmup_publish_target_ids', ['預熱排期 ID（每行一個）', 'Warm-up schedule IDs (one per line)', '预热排期 ID（每行一个）'], true)], onRecord('collaboration', collaboration)),
  'creator.creators_update_live_session': action(['記錄直播進度', 'Record external live progress', '记录直播进度'], [liveSession, version,
    pick('status', ['平台場次狀態', 'External session status', '平台场次状态'], ['planning', 'scheduled', 'live', 'ended', 'cancelled']),
    field('source_ref', ['平台觀測依據（直播中／已結束時必填）', 'Platform evidence (required when live or ended)', '平台观测依据（直播中／已结束时必填）'], { optional: true })], onRecord('live_session', liveSession)),
  'creator.creators_plan_clip_reuse': action(['檢查授權並建立片段復用任務', 'Check rights and plan clip reuse', '检查授权并创建片段复用任务'], [liveSession, title, asset,
    field('asset_version_id', ['素材版本 ID', 'Asset version ID']), { ...market, optional: false }, field('platform', ['復用平台', 'Reuse platform', '复用平台']),
    pick('usage', ['用途', 'Usage'], ['organic_social', 'paid_ads']), liveDate('reuse_at', ['預計復用時間', 'Planned reuse time', '预计复用时间']),
    field('attribution', ['署名', 'Attribution'], { optional: true })], onRecord('live_session', liveSession)),
  'creator.outreach_draft': action(['撰寫邀約草稿', 'Draft outreach', '撰写邀约草稿'], [collaboration,
    pick('channel', ['聯繫管道', 'Contact channel', '联系管道'], ['email', 'platform_dm', 'phone', 'other']),
    field('body', ['邀約內容', 'Outreach message', '邀约内容'], { type: 'textarea' }),
    field('language', ['語言代碼', 'Language', '语言代码'], { optional: true })], onRecord('collaboration', collaboration)),

  // Research watchlists and boards.
  'intel.create_watch_target': action(['新增監測目標', 'Create watch target', '添加监测目标'], [name,
    pick('target_type', ['目標類型', 'Target type', '目标类型'], ['competitor_account', 'keyword', 'hashtag', 'category', 'product_url', 'store', 'creator_account']),
    pick('data_mode', ['資料來源模式', 'Data mode', '数据源模式'], ['manual', 'import', 'vendor', 'official_api']), json('query', ['監測條件', 'Watch query', '监测条件']),
    { ...brand, optional: true }, field('platform', ['平台', 'Platform'], { optional: true }),
    ref('data_source_id', ['資料來源', 'Data source', '数据源'], 'ingest', 'data_source', true), tags], { tab: 'watch_target' }),
  'intel.observation_timeline': action(['查看觀察紀錄時間軸', 'View observation timeline', '查看观察记录时间轴'], [watch, from, to], onRecord('watch_target', watch)),
  'intel.create_research_board': action(['建立研究看板', 'Create research board', '创建研究看板'], [title,
    pick('kind', ['看板類型', 'Board type', '看板类型'], ['research', 'creative', 'product_opportunity']),
    { ...brand, optional: true }, { ...campaign, optional: true }, description], { tab: 'research_board' }),
  'intel.research_board_detail': action(['查看研究看板詳情', 'View research board details', '查看研究看板详情'], [ref('id', ['研究看板', 'Research board'], 'intel', 'research_board')],
    { target: 'research_board', targetField: 'id' }),
  'intel.search_research': action(['搜尋研究資料', 'Search research', '搜索研究数据'], [field('keyword', ['關鍵字', 'Keyword', '关键字']), { ...watch, optional: true }]),
  'intel.list_creative_references': action(['查看創意參考', 'List creative references', '查看创意参考'], [{ ...watch, optional: true }, field('tag', ['標籤', 'Tag', '标签'], { optional: true })]),

  'intel.create_product_candidate': action(['建立候選商品', 'Create product candidate', '创建候选商品'], [name,
    field('supply_notes', ['供應備註', 'Supply notes', '供应备注'], { type: 'textarea', optional: true }),
    json('price_range', ['價格範圍', 'Price range', '价格范围'], true)], { tab: 'product_candidate' }),
  'intel.product_candidate_detail': action(['查看候選商品詳情', 'View product candidate', '查看候选商品详情'], [
    ref('id', ['候選商品', 'Product candidate', '候选商品'], 'intel', 'product_candidate')], { target: 'product_candidate', targetField: 'id' }),

  // Verified destinations, referral links, and landing pages.
  'traffic.request_destination_domain': action(['登記目的地域名', 'Request destination domain', '登记目的地域名'], [field('hostname', ['主機名稱', 'Hostname', '主机名称'])], { tab: 'short_link' }),
  'traffic.verify_destination_domain': action(['驗證目的地域名', 'Verify destination domain', '验证目的地域名'], [
    ref('destination_domain_id', ['目的地域名', 'Destination domain'], 'traffic', 'destination_domain')]),
  'traffic.register_landing_destination': action(['登記連結目的地', 'Register landing destination', '登记链接目的地'], [field('url', ['目的地網址', 'Destination URL', '目的地网址'], { type: 'url' }),
    pick('kind', ['目的地類型', 'Destination type', '目的地类型'], ['store_product', 'store_collection', 'external_page']), productVariant, market], { tab: 'short_link' }),
  'traffic.links_create': action(['建立短連結', 'Create short link', '创建短链接'], [destination,
    field('destination_url', ['或輸入目的地網址', 'Or enter a destination URL', '或输入目的地网址'], { type: 'url', optional: true }), { ...campaign, optional: true },
    productVariant, market, ...utmFields, field('expires_at', ['到期時間', 'Expires at', '到期时间'], { type: 'datetime-local', optional: true }),
    field('fallback_url', ['備用網址', 'Fallback URL', '备用网址'], { type: 'url', optional: true })], { tab: 'short_link' }),
  'traffic.utm_build': action(['產生 UTM 參數', 'Build UTM parameters', '产生 UTM 参数'], utmFields),
  'traffic.links_get_stats': action(['查看短連結統計', 'View short link statistics', '查看短链接统计'], [{ ...shortLink, optional: true }, { ...campaign, optional: true }, from, to], onRecord('short_link', shortLink)),
  'traffic.links_check': action(['檢查短連結', 'Check short link', '检查短链接'], [shortLink], onRecord('short_link', shortLink)),
  'traffic.set_link_status': action(['變更短連結狀態', 'Change short link status', '变更短链接状态'], [shortLink, version,
    pick('status', ['狀態', 'Status', '状态'], ['active', 'paused', 'archived'])], { ...onRecord('short_link', shortLink), confirm: true }),
  'traffic.pages_create_draft': action(['建立到達頁草稿', 'Create landing page draft', '创建到达页草稿'], [title, description, { ...campaign, optional: true },
    field('service_contact_only', ['僅供服務聯繫', 'Service contact only', '仅供服务联系'], { type: 'checkbox' }),
    json('service_contact', ['服務聯繫選項', 'Service contact option', '服务联系选项'], true), json('channel_options', ['行銷聯繫選項', 'Marketing channel options', '行销联系选项'], true)], { tab: 'landing_page' }),

  'traffic.publish_landing_page': action(['發布到達頁', 'Publish landing page', '发布到达页'], [landingPage, version,
    ref('version_id', ['草稿版本', 'Draft version'], 'traffic', 'landing_page_version')],
    { ...onRecord('landing_page', landingPage), confirm: true }),

  // Customer, consent, and segment management.
  'lifecycle.create_customer': action(['建立顧客', 'Create customer', '创建顾客'], [market, field('primary_locale', ['主要語言代碼', 'Primary locale', '主要语言代码'], { optional: true }),
    pick('lifecycle_stage', ['顧客階段', 'Lifecycle stage', '顾客阶段'], ['prospect', 'first_purchase', 'repeat', 'lapsed'], true),
    lines('product_ids', ['商品識別碼（每行一個）', 'Product IDs (one per line)', '商品识别码（每行一个）'], true),
    field('last_interaction_at', ['最後互動時間', 'Last interaction', '最后交互时间'], { type: 'datetime-local', optional: true })], { tab: 'customer' }),
  'lifecycle.create_consent_text': action(['建立同意文字版本', 'Create consent text version', '创建同意文字版本'], [channel, purpose, locale,
    field('text', ['同意文字', 'Consent text'], { type: 'textarea' }), field('effective_from', ['生效時間', 'Effective from', '生效时间'], { type: 'datetime-local', optional: true })], { tab: 'consent' }),
  'lifecycle.get_consent_state': action(['查看顧客同意狀態', 'View customer consent state', '查看顾客同意状态'], [customer, channel, purpose], onRecord('customer', customer)),
  'lifecycle.record_consent': action(['登錄顧客同意', 'Record customer consent', '登录顾客同意'], [customer, channel, purpose,
    pick('action', ['同意狀態', 'Consent action', '同意状态'], ['opt_in', 'opt_out', 'withdrawn', 'imported_state']), consentText,
    field('evidence_ref', ['證據參照', 'Evidence reference', '证据参照']), field('captured_at', ['取得時間', 'Captured at', '取得时间'], { type: 'datetime-local', optional: true })],
    { ...onRecord('customer', customer), confirm: true }),
  'lifecycle.create_segment': action(['建立客群區隔', 'Create segment', '创建客群区隔'], [name, channel, segmentDefinition], { tab: 'segment' }),
  'lifecycle.revise_segment': action(['修訂客群區隔', 'Revise segment', '修订客群区隔'], [segment, version, channel, segmentDefinition], onRecord('segment', segment)),
  'lifecycle.segments_preview': action(['預覽客群區隔', 'Preview segment', '预览客群区隔'], [
    ref('segment_version_id', ['客群版本', 'Segment version'], 'lifecycle', 'segment_version', true), { ...channel, optional: true }, segmentDefinition]),

  // Advertising accounts, creatives, and proposals.
  'ads.register_account': action(['登記廣告帳號', 'Register ad account', '登记广告账号'], [brand,
    field('provider', ['廣告平台代碼（以 _ads 結尾）', 'Ad provider key (ends in _ads)', '广告平台代码（以 _ads 结尾）']), externalAccount,
    field('currency', ['幣別', 'Currency', '币别']), field('timezone', ['時區', 'Time zone', '时区']),
    field('spend_cap_minor', ['支出上限（最小貨幣單位）', 'Spend cap (minor units)', '支出上限（最小货币单位）'], { type: 'number' }),
    { ...connection, optional: true }, json('permissions', ['廣告帳號權限', 'Ad account permissions', '广告账号权限'], true)], { tab: 'ad_account' }),
  'ads.list_accounts': action(['查看廣告帳號', 'List ad accounts', '查看广告账号'], []),
  'ads.list_entities': action(['查看廣告結構', 'List ad entities', '查看广告结构'], [adAccount, { ...campaign, optional: true }], onRecord('ad_account', adAccount)),
  'ads.list_adjustments': action(['查看廣告調整建議', 'List ad adjustment suggestions', '查看广告调整建议'], [adAccount], onRecord('ad_account', adAccount)),
  'ads.create_creative': action(['建立廣告素材', 'Create ad creative', '创建广告素材'], [adAccount, campaign,
    pick('origin', ['素材來源', 'Creative origin', '素材来源'], ['new', 'platform_post', 'deliverable', 'asset']),
    field('origin_ref', ['來源識別碼（非新素材時必填）', 'Source ID (required for existing material)', '来源识别码（非新素材时必填）'], { optional: true }),
    field('creator_identity_required', ['需要創作者身分授權', 'Requires creator identity rights', '需要创作者身分授权'], { type: 'checkbox' })], { tab: 'ad_entity' }),
  'ads.list_creatives': action(['查看廣告素材', 'List ad creatives', '查看广告素材'], [adAccount, { ...campaign, optional: true }]),
  'ads.create_proposal': action(['建立廣告提案', 'Create ad proposal', '创建广告提案'], [adAccount, campaign, name,
    json('revision', ['提案版本內容', 'Proposal revision', '提案版本内容'])], { tab: 'ad_account' }),
  'ads.list_proposals': action(['查看廣告提案清單', 'List ad proposals', '查看广告提案清单'], [adAccount, { ...campaign, optional: true }]),
  'ads.get_proposal': action(['查看廣告提案詳情', 'View ad proposal details', '查看广告提案详情'], [adProposal]),

  // Agent work and review.
  'agent.jobs_create': action(['建立代理工作', 'Create agent job', '创建代理工作'], [title, field('kind', ['工作類型', 'Job type', '工作类型'], { optional: true }),
    json('input_scope', ['工作範圍', 'Input scope', '工作范围'], true), json('expected_output', ['預期輸出', 'Expected output', '预期输出'], true),
    field('due_at', ['截止時間', 'Due at', '截止时间'], { type: 'datetime-local', optional: true })], { tab: 'agent_job' }),
  'agent.jobs_list': action(['查看代理工作清單', 'List agent jobs', '查看代理工作清单'], [field('status', ['狀態', 'Status', '状态'], { optional: true }),
    field('kind', ['工作類型', 'Job type', '工作类型'], { optional: true }), { ...campaign, optional: true }]),
  'agent.jobs_get': action(['查看代理工作詳情', 'View agent job details', '查看代理工作详情'], [agentJob], onRecord('agent_job', agentJob)),
  'agent.change_sets_create': action(['建立變更集', 'Create change set', '创建变更集'], [title,
    field('rationale', ['變更理由', 'Rationale', '变更理由'], { type: 'textarea' }), json('items', ['變更項目', 'Change items', '变更项目']),
    json('sources', ['來源', 'Sources', '来源'], true)], { tab: 'change_set' }),
  'agent.change_sets_get': action(['查看變更集', 'View change set', '查看变更集'], [changeSet], onRecord('change_set', changeSet)),
  'agent.automation_rules_create': action(['建立自動化規則', 'Create automation rule', '创建自动化规则'], [name,
    json('trigger', ['事件或排程觸發條件', 'Event or schedule trigger', '事件或调度触发条件']),
    json('condition', ['事件篩選條件', 'Event filter', '事件筛选条件'], true),
    json('action', ['建立工作或提醒', 'Job or reminder action', '创建工作或提醒']),
    field('enabled', ['啟用規則', 'Enable rule', '激活规则'], { type: 'checkbox' })], { tab: 'automation_rule' }),
  'agent.automation_rules_list': action(['查看自動化規則', 'List automation rules', '查看自动化规则'], []),
  'agent.automation_rules_runs': action(['查看規則執行紀錄', 'List rule runs', '查看规则运行记录'], [rule], onRecord('automation_rule', rule)),
  'agent.automation_rules_test': action(['測試自動化規則', 'Test automation rule', '测试自动化规则'], [rule, json('sample', ['測試樣本', 'Test sample', '测试样本'])], onRecord('automation_rule', rule)),

  // Operations readings and reversible administrative controls.
  'ops.health': action(['查看系統健康狀態', 'View system health', '查看系统健康状态'], []),
  'ops.get_usage': action(['查看用量', 'View usage'], [pick('meter_key', ['計量項目', 'Usage meter', '计量项目'],
    ['seats', 'brands', 'social_accounts', 'storage_bytes', 'sync_calls', 'model_tokens', 'mcp_calls', 'vendor_queries'], true)]),
  'ops.get_connector_auto': action(['查看連接器自動模式狀態', 'View connector automation status', '查看连接器自动模式状态'], []),
  'ops.get_egress_policy': action(['查看資料對外傳輸政策', 'View data egress policy', '查看数据对外传输政策'], []),
  'ops.get_retention_policies': action(['查看資料保留政策', 'View retention policies', '查看数据保留政策'], []),
  'ops.set_safe_mode': action(['設定安全模式', 'Set safe mode', '设置安全模式'], [field('enabled', ['啟用安全模式', 'Enable safe mode', '激活安全模式'], { type: 'checkbox' }), reason], { confirm: true }),
};
