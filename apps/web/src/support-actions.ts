import type { Action, Field } from './catalog';
import { rowActions, text, type Action as WorkspaceAction } from './actions';

export const conversationWorkspaceActions: WorkspaceAction[] = [
  ...rowActions.conversations.map(action => {
    if (action.path.endsWith('/notes')) return { ...action, fields: [{ ...text('body', '備註內容', 'Note text'), type: 'textarea' }] } satisfies WorkspaceAction;
    if (action.path.endsWith('/reply-drafts')) return { ...action, fields: [{ ...text('body_text', '回覆內容', 'Reply text'), type: 'textarea' }] } satisfies WorkspaceAction;
    return action;
  }),
  { path: '/conversations/:id', method: 'PATCH', label: ['處理對話', 'Triage conversation'], versioned: true, fields: [
    { ...text('status', '狀態', 'Status'), type: 'select', options: ['open', 'waiting_customer', 'snoozed', 'resolved'] },
    { ...text('priority', '優先順序', 'Priority', true), type: 'select', options: ['low', 'normal', 'high', 'urgent'] },
    { ...text('assignee_user_id', '負責人', 'Assignee', true), type: 'ref', lookup: '/members' },
    { ...text('snooze_until', '暫緩至', 'Snooze until', true), type: 'datetime-local' },
  ] },
];

type Label = readonly [zh: string, en: string];

const field = (name: string, label: Label, options: Omit<Field, 'name' | 'label'> = {}): Field => ({ name, label, ...options });
const ref = (name: string, label: Label, module: string, kind: string, optional = false) =>
  field(name, label, { ref: [module, kind], optional });
const pick = (name: string, label: Label, choices: readonly string[], optional = false) =>
  field(name, label, { type: 'select', choices, optional });
const json = (name: string, label: Label, optional = false) => field(name, label, { type: 'json', optional });
const lines = (name: string, label: Label, optional = false) => field(name, label, { type: 'lines', optional });
const action = (label: Label, fields: Field[], options: Omit<Action, 'label' | 'fields'> = {}): Action => ({ label, fields, ...options });
const onRecord = (target: string, id: Field) => ({ target, targetField: id.name });

const name = field('name', ['名稱', 'Name']);
const title = field('title', ['標題', 'Title']);
const description = field('description', ['說明', 'Description'], { type: 'textarea', optional: true });
const locale = field('locale', ['語言代碼', 'Locale']);
const brand = ref('brand_id', ['品牌', 'Brand'], 'workspace', 'brand');
const campaign = ref('campaign_id', ['活動', 'Campaign'], 'campaign', 'campaign');
const market = ref('market_id', ['市場', 'Market'], 'workspace', 'market', true);
const version = field('expected_version', ['目前版本', 'Current version'], { type: 'number', integer: true, min: 1 });
const reason = field('reason', ['原因', 'Reason'], { type: 'textarea' });
const from = field('from', ['起始時間', 'From'], { type: 'datetime-local', optional: true });
const to = field('to', ['結束時間', 'To'], { type: 'datetime-local', optional: true });
const tags = lines('tags', ['標籤（每行一個）', 'Tags (one per line)'], true);
const provider = field('provider', ['平台代碼', 'Provider key']);
const externalAccount = field('external_account_id', ['平台帳號識別碼', 'External account ID']);
const connection = ref('connection_id', ['連線', 'Connection'], 'account', 'connection');
const socialAccount = ref('social_account_id', ['社群帳號', 'Social account'], 'account', 'social_account');
const asset = ref('asset_id', ['素材', 'Asset'], 'asset', 'asset');
const assetKind = ['image', 'video', 'audio', 'subtitle', 'document', 'design_link'];
const fileObject = field('file_object_id', ['已上傳檔案識別碼', 'Uploaded file ID']);
const creator = ref('creator_id', ['創作者', 'Creator'], 'creator', 'creator');
const collaboration = ref('collaboration_id', ['合作案', 'Collaboration'], 'creator', 'collaboration');
const liveSession = field('live_session_id', ['直播企劃 ID', 'Live plan ID']);
const liveDate = (name: string, zh: string, en: string, optional = false) => field(name, [zh, en], { type: 'datetime-local', optional });
const watch = ref('watch_target_id', ['監測目標', 'Watch target'], 'intel', 'watch_target');
const shortLink = ref('short_link_id', ['短連結', 'Short link'], 'traffic', 'short_link');
const landingPage = ref('page_id', ['到達頁', 'Landing page'], 'traffic', 'landing_page');
const destination = ref('landing_destination_id', ['連結目的地', 'Landing destination'], 'traffic', 'landing_destination', true);
const productVariant = ref('product_variant_id', ['商品規格', 'Product variant'], 'commerce', 'product_variant', true);
const utmFields = [json('utm_params', ['UTM 參數', 'UTM parameters'], true),
  ref('utm_template_id', ['UTM 範本', 'UTM template'], 'traffic', 'utm_template', true),
  json('tokens', ['範本參數', 'Template tokens'], true)];
const customer = ref('customer_id', ['顧客', 'Customer'], 'lifecycle', 'customer');
const channel = pick('channel', ['聯繫管道', 'Contact channel'], ['email', 'sms', 'whatsapp', 'push', 'site_tracking', 'platform_dm']);
const purpose = pick('purpose', ['同意用途', 'Consent purpose'], ['marketing', 'service']);
const consentText = ref('consent_text_version_id', ['同意文字版本（同意時必填）', 'Consent text version (required for opt-in)'], 'lifecycle', 'consent_text_version', true);
const segment = ref('segment_id', ['客群區隔', 'Segment'], 'lifecycle', 'segment');
const segmentDefinition = json('definition', ['客群條件', 'Segment definition'], true);
const adAccount = ref('ad_account_id', ['廣告帳號', 'Ad account'], 'ads', 'ad_account');
const adProposal = ref('id', ['廣告提案', 'Ad proposal'], 'ads', 'ad_proposal');
const agentJob = ref('agent_job_id', ['代理工作', 'Agent job'], 'agent', 'agent_job');
const changeSet = ref('change_set_id', ['變更集', 'Change set'], 'agent', 'change_set');
const rule = ref('rule_id', ['自動化規則', 'Automation rule'], 'agent', 'automation_rule');

export const supportActions: Record<string, Action> = {
  // Account registry and device pairing.
  'account.register_account': action(['登記社群帳號', 'Register social account'], [provider, externalAccount, name, brand,
    field('default_timezone', ['預設時區', 'Default time zone']), { ...connection, optional: true }, field('owned_account_confirmed', ['確認此為自有帳號', 'Confirm this account is owned'], { type: 'checkbox' })], { tab: 'social_account', validate: body => !body.connection_id && body.owned_account_confirmed !== true ? 'owned_account_confirmed' : undefined }),
  'account.platform_catalog': action(['查看支援平台', 'View supported platforms'], []),
  'account.check_capabilities': action(['查看平台功能', 'Check platform capabilities'], [
    pick('target', ['帳號類型', 'Account type'], ['social_account', 'store_connection']), field('id', ['帳號或連線識別碼', 'Account or connection ID'])]),
  'account.create_pairing_code': action(['產生配對碼', 'Create pairing code'], [field('label', ['裝置名稱', 'Device name']),
    pick('host_os', ['作業系統', 'Operating system'], ['macos', 'windows'])], { tab: 'device' }),
  'account.disable_account': action(['停用社群帳號', 'Disable social account'], [socialAccount], { ...onRecord('social_account', socialAccount), confirm: true }),
  'account.enable_account': action(['啟用社群帳號', 'Enable social account'], [socialAccount], onRecord('social_account', socialAccount)),
  'account.get_auto_terms': action(['查看自動模式條款', 'View automatic mode terms'], []),

  // Asset library, rights, and brand knowledge.
  'asset.asset_create': action(['建立素材', 'Create asset'], [brand, title, pick('kind', ['素材類型', 'Asset type'], assetKind), fileObject,
    description, tags, { ...locale, optional: true }], { tab: 'asset' }),
  'asset.asset_search': action(['搜尋素材', 'Search assets'], [field('q', ['關鍵字', 'Keyword'], { optional: true }),
    { ...brand, optional: true }, pick('kind', ['素材類型', 'Asset type'], assetKind, true), field('tag', ['標籤', 'Tag'], { optional: true }),
    field('favorite_only', ['只看收藏', 'Favorites only'], { type: 'checkbox' })]),
  'asset.asset_get': action(['查看素材詳情', 'View asset details'], [asset], onRecord('asset', asset)),
  'asset.asset_usage': action(['查看素材使用情況', 'View asset usage'], [asset], onRecord('asset', asset)),
  'asset.asset_add_version': action(['新增素材版本', 'Add asset version'], [asset, version, fileObject,
    field('change_note', ['版本說明', 'Change note'], { type: 'textarea', optional: true })], onRecord('asset', asset)),
  'asset.asset_folder_create': action(['建立素材資料夾', 'Create asset folder'], [name, { ...brand, optional: true },
    ref('parent_id', ['上層資料夾', 'Parent folder'], 'asset', 'asset_folder', true)], { tab: 'asset' }),
  'asset.rights_create_draft': action(['建立素材授權草稿', 'Create draft rights grant'], [brand, asset,
    pick('grant_type', ['授權類型', 'Grant type'], ['owned', 'license', 'ugc_permission', 'creator_contract', 'stock', 'employee']),
    pick('grantor_kind', ['授權方類型', 'Grantor type'], ['brand', 'creator', 'external_party', 'stock_provider', 'employee']),
    lines('usages', ['使用用途（每行一個）', 'Allowed uses (one per line)']),
    field('valid_from', ['生效時間', 'Valid from'], { type: 'datetime-local' }),
    field('valid_until', ['到期時間', 'Valid until'], { type: 'datetime-local', optional: true }),
    lines('evidence_ids', ['證據識別碼（每行一個）', 'Evidence IDs (one per line)'], true)], { tab: 'rights_grant' }),
  'asset.rights_list': action(['查看授權清單', 'List rights grants'], [{ ...brand, optional: true }, field('status', ['狀態', 'Status'], { optional: true })]),
  'asset.knowledge_propose': action(['提議品牌知識', 'Propose brand knowledge'], [brand, title,
    pick('kind', ['知識類型', 'Knowledge type'], ['positioning', 'tone', 'forbidden_phrase', 'glossary_term', 'faq', 'example', 'policy', 'product_pointer']),
    field('body', ['內容', 'Body'], { type: 'textarea' }), lines('locales', ['語言代碼（每行一個）', 'Locales (one per line)'], true),
    json('structured', ['結構化內容', 'Structured content'], true)], { tab: 'knowledge_entry' }),
  'asset.knowledge_approve': action(['核准知識修訂', 'Approve knowledge revision'], [field('revision_id', ['修訂識別碼', 'Revision ID'])], { tab: 'knowledge_entry' }),
  'asset.knowledge_get_context': action(['查閱品牌知識', 'Get brand knowledge context'], [brand, market, { ...locale, optional: true },
    field('include_proposed', ['包含待審建議', 'Include proposed revisions'], { type: 'checkbox' })], { tab: 'knowledge_entry' }),
  'asset.template_create': action(['建立文案範本', 'Create copy template'], [brand, name,
    pick('kind', ['範本類型', 'Template type'], ['text_snippet', 'hashtag_set', 'cta', 'caption_template']),
    field('body', ['範本文案', 'Template copy'], { type: 'textarea' }),
    { ...json('variables', ['變數（JSON 陣列，含 key 與 source）', 'Variables (JSON array with key and source)'], true), shape: 'array' }], { tab: 'template' }),
  'asset.template_apply': action(['用範本替換工作稿文案', 'Replace draft copy with template'], [
    ref('template_id', ['文案範本', 'Copy template'], 'asset', 'template'),
    ref('variant_id', ['內容變體', 'Content variant'], 'content', 'content_variant'), version,
    { ...json('values', ['變數來源參照', 'Variable source references'], true), shape: 'object' }], { tab: 'template', target: 'content_variant', targetModule: 'content', targetField: 'variant_id', confirm: true }),

  // Creator profiles and collaborations.
  'creator.creators_create': action(['建立創作者檔案', 'Create creator profile'], [field('display_name', ['顯示名稱', 'Display name']),
    lines('languages', ['語言代碼（每行一個）', 'Languages (one per line)'], true), tags], { tab: 'creator' }),
  'creator.creators_search': action(['搜尋創作者', 'Search creators'], [field('q', ['關鍵字', 'Keyword'], { optional: true }),
    field('language', ['語言代碼', 'Language'], { optional: true }), field('tag', ['標籤', 'Tag'], { optional: true }),
    pick('status', ['狀態', 'Status'], ['active', 'do_not_contact', 'archived'], true)]),
  'creator.creators_get': action(['查看創作者檔案', 'View creator profile'], [creator], onRecord('creator', creator)),
  'creator.creators_import_contacts': action(['匯入聯絡資料', 'Import creator contacts'], [creator,
    field('source_ref', ['資料來源', 'Contact source']), field('csv', ['CSV（channel,value）', 'CSV (channel,value)'], { type: 'textarea' })], onRecord('creator', creator)),
  'creator.creators_associate_profiles': action(['關聯重複檔案', 'Associate duplicate profiles'], [creator,
    ref('related_creator_id', ['另一個創作者', 'Other creator'], 'creator', 'creator'), reason,
    lines('evidence_ids', ['證據 ID（每行一個）', 'Evidence IDs (one per line)'])], onRecord('creator', creator)),
  'creator.creators_revoke_association': action(['撤銷檔案關聯', 'Undo profile association'], [
    field('creator_association_id', ['關聯 ID', 'Association ID']), version, reason], { target: 'creator_association', targetField: 'creator_association_id' }),
  'creator.creators_override_evaluation': action(['人工覆寫評分', 'Override evaluation'], [
    field('evaluation_id', ['評估 ID', 'Evaluation ID']), version, reason,
    pick('dimension', ['評估維度', 'Evaluation dimension'], ['brand_fit', 'market_fit', 'content_quality', 'audience_evidence', 'cost_fit'], true),
    json('score', ['分數（0–100 或 null 表示未知）', 'Score (0–100 or null for unknown)'], true),
    lines('evidence_refs', ['評分證據 ID（每行一個）', 'Score evidence IDs (one per line)'], true),
    pick('decision', ['決策', 'Decision'], ['shortlist', 'exclude', 'hold'], true)], { target: 'evaluation', targetField: 'evaluation_id' }),
  'creator.deliverables_create': action(['要求交付', 'Request deliverable'], [collaboration,
    pick('kind', ['交付類型', 'Deliverable type'], ['short_video', 'image_post', 'story', 'live', 'raw_footage', 'other']),
    liveDate('due_at', '交付期限', 'Deliverable deadline'), lines('acceptance_criteria', ['驗收條件（每行一個）', 'Acceptance criteria (one per line)']),
    field('publish_target_id', ['相關發布排期 ID', 'Related publication schedule ID'], { optional: true })], onRecord('collaboration', collaboration)),
  'creator.deliverables_change_deadline': action(['變更交付期限', 'Change deliverable deadline'], [
    field('deliverable_id', ['交付項目 ID', 'Deliverable ID']), version, liveDate('due_at', '新期限', 'New deadline'), reason],
    { target: 'deliverable', targetField: 'deliverable_id' }),
  'creator.creators_link_account': action(['連結創作者帳號', 'Link creator account'], [creator, provider,
    field('handle', ['帳號名稱', 'Handle'], { optional: true }), { ...externalAccount, optional: true },
    field('profile_url', ['個人檔案網址', 'Profile URL'], { type: 'url', optional: true })], onRecord('creator', creator)),
  'creator.collaborations_create': action(['建立合作案', 'Create collaboration'], [creator, campaign,
    pick('type', ['合作類型', 'Collaboration type'], ['gifted', 'fixed_fee', 'commission', 'hybrid']),
    field('next_action', ['下一步', 'Next action'], { optional: true }),
    field('next_action_due_at', ['下一步截止時間', 'Next action due at'], { type: 'datetime-local', optional: true })], { tab: 'collaboration' }),
  'creator.collaborations_list': action(['查看合作案清單', 'List collaborations'], [{ ...creator, optional: true }, { ...campaign, optional: true },
    field('status', ['狀態', 'Status'], { optional: true })]),
  'creator.collaborations_get': action(['查看合作案詳情', 'View collaboration details'], [collaboration], onRecord('collaboration', collaboration)),
  'creator.creators_verify_account': action(['記錄帳號核實', 'Record account verification'], [field('creator_account_id', ['創作者帳號 ID', 'Creator account ID']), version,
    field('source_ref', ['核實依據網址', 'Verification source URL'], { type: 'url' }),
    field('verification_note', ['核實記錄', 'Verification notes'], { type: 'textarea' })], { target: 'creator_account', targetField: 'creator_account_id' }),
  'creator.creators_record_audience': action(['記錄受眾數據', 'Record audience observation'], [creator, version,
    field('market', ['受眾市場', 'Audience market']), field('share_bps', ['佔比（基點，100 = 1%）', 'Share (basis points, 100 = 1%)'], { type: 'number' }),
    pick('source_kind', ['來源', 'Source'], ['self_reported', 'public', 'manual']), liveDate('observed_at', '觀測時間', 'Observed at')], onRecord('creator', creator)),
  'creator.creators_plan_live_session': action(['規劃平台直播', 'Plan external live session'], [collaboration,
    field('platform', ['直播平台', 'Live platform']), liveDate('scheduled_at', '開始時間（瀏覽器時區）', 'Starts at (browser time zone)'),
    field('tz', ['直播時區（IANA）', 'Live time zone (IANA)'], { default: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    json('run_sheet', ['流程表（JSON：title、product_id、notes）', 'Run sheet (JSON: title, product_id, notes)'], true),
    lines('warmup_publish_target_ids', ['預熱排期 ID（每行一個）', 'Warm-up schedule IDs (one per line)'], true)], onRecord('collaboration', collaboration)),
  'creator.creators_update_live_session': action(['記錄直播進度', 'Record external live progress'], [liveSession, version,
    pick('status', ['平台場次狀態', 'External session status'], ['planning', 'scheduled', 'live', 'ended', 'cancelled']),
    field('source_ref', ['平台觀測依據（直播中／已結束時必填）', 'Platform evidence (required when live or ended)'], { optional: true })], onRecord('live_session', liveSession)),
  'creator.creators_plan_clip_reuse': action(['檢查授權並建立片段復用任務', 'Check rights and plan clip reuse'], [liveSession, title, asset,
    field('asset_version_id', ['素材版本 ID', 'Asset version ID']), { ...market, optional: false }, field('platform', ['復用平台', 'Reuse platform']),
    pick('usage', ['用途', 'Usage'], ['organic_social', 'paid_ads']), liveDate('reuse_at', '預計復用時間', 'Planned reuse time'),
    field('attribution', ['署名', 'Attribution'], { optional: true })], onRecord('live_session', liveSession)),
  'creator.outreach_draft': action(['撰寫邀約草稿', 'Draft outreach'], [collaboration,
    pick('channel', ['聯繫管道', 'Contact channel'], ['email', 'platform_dm', 'phone', 'other']),
    field('body', ['邀約內容', 'Outreach message'], { type: 'textarea' }),
    field('language', ['語言代碼', 'Language'], { optional: true })], onRecord('collaboration', collaboration)),

  // Research watchlists and boards.
  'intel.create_watch_target': action(['新增監測目標', 'Create watch target'], [name,
    pick('target_type', ['目標類型', 'Target type'], ['competitor_account', 'keyword', 'hashtag', 'category', 'product_url', 'store', 'creator_account']),
    pick('data_mode', ['資料來源模式', 'Data mode'], ['manual', 'import', 'vendor', 'official_api']), json('query', ['監測條件', 'Watch query']),
    { ...brand, optional: true }, field('platform', ['平台', 'Platform'], { optional: true }),
    ref('data_source_id', ['資料來源', 'Data source'], 'ingest', 'data_source', true), tags], { tab: 'watch_target' }),
  'intel.observation_timeline': action(['查看觀察紀錄時間軸', 'View observation timeline'], [watch, from, to], onRecord('watch_target', watch)),
  'intel.create_research_board': action(['建立研究看板', 'Create research board'], [title,
    pick('kind', ['看板類型', 'Board type'], ['research', 'creative', 'product_opportunity']),
    { ...brand, optional: true }, { ...campaign, optional: true }, description], { tab: 'research_board' }),
  'intel.research_board_detail': action(['查看研究看板詳情', 'View research board details'], [ref('id', ['研究看板', 'Research board'], 'intel', 'research_board')],
    { target: 'research_board', targetField: 'id' }),
  'intel.search_research': action(['搜尋研究資料', 'Search research'], [field('keyword', ['關鍵字', 'Keyword']), { ...watch, optional: true }]),
  'intel.list_creative_references': action(['查看創意參考', 'List creative references'], [{ ...watch, optional: true }, field('tag', ['標籤', 'Tag'], { optional: true })]),

  'intel.create_product_candidate': action(['建立候選商品', 'Create product candidate'], [name,
    field('supply_notes', ['供應備註', 'Supply notes'], { type: 'textarea', optional: true }),
    json('price_range', ['價格範圍', 'Price range'], true)], { tab: 'product_candidate' }),
  'intel.product_candidate_detail': action(['查看候選商品詳情', 'View product candidate'], [
    ref('id', ['候選商品', 'Product candidate'], 'intel', 'product_candidate')], { target: 'product_candidate', targetField: 'id' }),

  // Verified destinations, referral links, and landing pages.
  'traffic.request_destination_domain': action(['登記目的地域名', 'Request destination domain'], [field('hostname', ['主機名稱', 'Hostname'])], { tab: 'short_link' }),
  'traffic.verify_destination_domain': action(['驗證目的地域名', 'Verify destination domain'], [
    ref('destination_domain_id', ['目的地域名', 'Destination domain'], 'traffic', 'destination_domain')]),
  'traffic.register_landing_destination': action(['登記連結目的地', 'Register landing destination'], [field('url', ['目的地網址', 'Destination URL'], { type: 'url' }),
    pick('kind', ['目的地類型', 'Destination type'], ['store_product', 'store_collection', 'external_page']), productVariant, market], { tab: 'short_link' }),
  'traffic.links_create': action(['建立短連結', 'Create short link'], [destination,
    field('destination_url', ['或輸入目的地網址', 'Or enter a destination URL'], { type: 'url', optional: true }), { ...campaign, optional: true },
    productVariant, market, ...utmFields, field('expires_at', ['到期時間', 'Expires at'], { type: 'datetime-local', optional: true }),
    field('fallback_url', ['備用網址', 'Fallback URL'], { type: 'url', optional: true })], { tab: 'short_link' }),
  'traffic.utm_build': action(['產生 UTM 參數', 'Build UTM parameters'], utmFields),
  'traffic.links_get_stats': action(['查看短連結統計', 'View short link statistics'], [{ ...shortLink, optional: true }, { ...campaign, optional: true }, from, to], onRecord('short_link', shortLink)),
  'traffic.links_check': action(['檢查短連結', 'Check short link'], [shortLink], onRecord('short_link', shortLink)),
  'traffic.set_link_status': action(['變更短連結狀態', 'Change short link status'], [shortLink, version,
    pick('status', ['狀態', 'Status'], ['active', 'paused', 'archived'])], { ...onRecord('short_link', shortLink), confirm: true }),
  'traffic.pages_create_draft': action(['建立到達頁草稿', 'Create landing page draft'], [title, description, { ...campaign, optional: true },
    field('service_contact_only', ['僅供服務聯繫', 'Service contact only'], { type: 'checkbox' }),
    json('service_contact', ['服務聯繫選項', 'Service contact option'], true), json('channel_options', ['行銷聯繫選項', 'Marketing channel options'], true)], { tab: 'landing_page' }),

  'traffic.publish_landing_page': action(['發布到達頁', 'Publish landing page'], [landingPage, version,
    ref('version_id', ['草稿版本', 'Draft version'], 'traffic', 'landing_page_version')],
    { ...onRecord('landing_page', landingPage), confirm: true }),

  // Customer, consent, and segment management.
  'lifecycle.create_customer': action(['建立顧客', 'Create customer'], [market, field('primary_locale', ['主要語言代碼', 'Primary locale'], { optional: true }),
    pick('lifecycle_stage', ['顧客階段', 'Lifecycle stage'], ['prospect', 'first_purchase', 'repeat', 'lapsed'], true),
    lines('product_ids', ['商品識別碼（每行一個）', 'Product IDs (one per line)'], true),
    field('last_interaction_at', ['最後互動時間', 'Last interaction'], { type: 'datetime-local', optional: true })], { tab: 'customer' }),
  'lifecycle.create_consent_text': action(['建立同意文字版本', 'Create consent text version'], [channel, purpose, locale,
    field('text', ['同意文字', 'Consent text'], { type: 'textarea' }), field('effective_from', ['生效時間', 'Effective from'], { type: 'datetime-local', optional: true })], { tab: 'consent' }),
  'lifecycle.get_consent_state': action(['查看顧客同意狀態', 'View customer consent state'], [customer, channel, purpose], onRecord('customer', customer)),
  'lifecycle.record_consent': action(['登錄顧客同意', 'Record customer consent'], [customer, channel, purpose,
    pick('action', ['同意狀態', 'Consent action'], ['opt_in', 'opt_out', 'withdrawn', 'imported_state']), consentText,
    field('evidence_ref', ['證據參照', 'Evidence reference']), field('captured_at', ['取得時間', 'Captured at'], { type: 'datetime-local', optional: true })],
    { ...onRecord('customer', customer), confirm: true }),
  'lifecycle.create_segment': action(['建立客群區隔', 'Create segment'], [name, channel, segmentDefinition], { tab: 'segment' }),
  'lifecycle.revise_segment': action(['修訂客群區隔', 'Revise segment'], [segment, version, channel, segmentDefinition], onRecord('segment', segment)),
  'lifecycle.segments_preview': action(['預覽客群區隔', 'Preview segment'], [
    ref('segment_version_id', ['客群版本', 'Segment version'], 'lifecycle', 'segment_version', true), { ...channel, optional: true }, segmentDefinition]),

  // Advertising accounts, creatives, and proposals.
  'ads.register_account': action(['登記廣告帳號', 'Register ad account'], [brand,
    field('provider', ['廣告平台代碼（以 _ads 結尾）', 'Ad provider key (ends in _ads)']), externalAccount,
    field('currency', ['幣別', 'Currency']), field('timezone', ['時區', 'Time zone']),
    field('spend_cap_minor', ['支出上限（最小貨幣單位）', 'Spend cap (minor units)'], { type: 'number' }),
    { ...connection, optional: true }, json('permissions', ['廣告帳號權限', 'Ad account permissions'], true)], { tab: 'ad_account' }),
  'ads.list_accounts': action(['查看廣告帳號', 'List ad accounts'], []),
  'ads.list_entities': action(['查看廣告結構', 'List ad entities'], [adAccount, { ...campaign, optional: true }], onRecord('ad_account', adAccount)),
  'ads.list_adjustments': action(['查看廣告調整建議', 'List ad adjustment suggestions'], [adAccount], onRecord('ad_account', adAccount)),
  'ads.create_creative': action(['建立廣告素材', 'Create ad creative'], [adAccount, campaign,
    pick('origin', ['素材來源', 'Creative origin'], ['new', 'platform_post', 'deliverable', 'asset']),
    field('origin_ref', ['來源識別碼（非新素材時必填）', 'Source ID (required for existing material)'], { optional: true }),
    field('creator_identity_required', ['需要創作者身分授權', 'Requires creator identity rights'], { type: 'checkbox' })], { tab: 'ad_entity' }),
  'ads.list_creatives': action(['查看廣告素材', 'List ad creatives'], [adAccount, { ...campaign, optional: true }]),
  'ads.create_proposal': action(['建立廣告提案', 'Create ad proposal'], [adAccount, campaign, name,
    json('revision', ['提案版本內容', 'Proposal revision'])], { tab: 'ad_account' }),
  'ads.list_proposals': action(['查看廣告提案清單', 'List ad proposals'], [adAccount, { ...campaign, optional: true }]),
  'ads.get_proposal': action(['查看廣告提案詳情', 'View ad proposal details'], [adProposal]),

  // Agent work and review.
  'agent.jobs_create': action(['建立代理工作', 'Create agent job'], [title, field('kind', ['工作類型', 'Job type'], { optional: true }),
    json('input_scope', ['工作範圍', 'Input scope'], true), json('expected_output', ['預期輸出', 'Expected output'], true),
    field('due_at', ['截止時間', 'Due at'], { type: 'datetime-local', optional: true })], { tab: 'agent_job' }),
  'agent.jobs_list': action(['查看代理工作清單', 'List agent jobs'], [field('status', ['狀態', 'Status'], { optional: true }),
    field('kind', ['工作類型', 'Job type'], { optional: true }), { ...campaign, optional: true }]),
  'agent.jobs_get': action(['查看代理工作詳情', 'View agent job details'], [agentJob], onRecord('agent_job', agentJob)),
  'agent.change_sets_create': action(['建立變更集', 'Create change set'], [title,
    field('rationale', ['變更理由', 'Rationale'], { type: 'textarea' }), json('items', ['變更項目', 'Change items']),
    json('sources', ['來源', 'Sources'], true)], { tab: 'change_set' }),
  'agent.change_sets_get': action(['查看變更集', 'View change set'], [changeSet], onRecord('change_set', changeSet)),
  'agent.automation_rules_create': action(['建立自動化規則', 'Create automation rule'], [name,
    json('trigger', ['事件或排程觸發條件', 'Event or schedule trigger']),
    json('condition', ['事件篩選條件', 'Event filter'], true),
    json('action', ['建立工作或提醒', 'Job or reminder action']),
    field('enabled', ['啟用規則', 'Enable rule'], { type: 'checkbox' })], { tab: 'automation_rule' }),
  'agent.automation_rules_list': action(['查看自動化規則', 'List automation rules'], []),
  'agent.automation_rules_runs': action(['查看規則執行紀錄', 'List rule runs'], [rule], onRecord('automation_rule', rule)),
  'agent.automation_rules_test': action(['測試自動化規則', 'Test automation rule'], [rule, json('sample', ['測試樣本', 'Test sample'])], onRecord('automation_rule', rule)),

  // Operations readings and reversible administrative controls.
  'ops.health': action(['查看系統健康狀態', 'View system health'], []),
  'ops.get_usage': action(['查看用量', 'View usage'], [pick('meter_key', ['計量項目', 'Usage meter'],
    ['seats', 'brands', 'social_accounts', 'storage_bytes', 'sync_calls', 'model_tokens', 'mcp_calls', 'vendor_queries'], true)]),
  'ops.get_connector_auto': action(['查看連接器自動模式狀態', 'View connector automation status'], []),
  'ops.get_egress_policy': action(['查看資料對外傳輸政策', 'View data egress policy'], []),
  'ops.get_retention_policies': action(['查看資料保留政策', 'View retention policies'], []),
  'ops.set_safe_mode': action(['設定安全模式', 'Set safe mode'], [field('enabled', ['啟用安全模式', 'Enable safe mode'], { type: 'checkbox' }), reason], { confirm: true }),
};
