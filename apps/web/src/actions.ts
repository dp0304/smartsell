import type { Method, RecordData } from '@smartsell/sdk';
import type { Label } from './modules';

export interface Field {
  key: string;
  label?: Label;
  type?: 'textarea' | 'date' | 'datetime-local' | 'email' | 'url' | 'json' | 'file' | 'array' | 'ids' | 'select' | 'ref' | 'timezone';
  options?: string[];
  lookup?: string;
  optional?: boolean;
  initial?: string;
  /** Shown under a collapsed "more settings" section because the default rarely needs changing. */
  advanced?: boolean;
  /** Short help shown under the field. */
  hint?: Label;
  /** Sends a datetime-local value as typed (local wall time) instead of converting it with the browser time zone. */
  keepLocal?: boolean;
  /** Derives the initial value from the record when the field key differs from the stored shape. */
  read?: (record: RecordData) => string;
}
export interface Action {
  path: string;
  label: Label;
  method?: Method;
  fields?: Field[];
  versioned?: boolean;
  confirm?: boolean;
  body?: (values: RecordData) => RecordData;
  /** Opens the created record after a successful save. `record` opens it in the current tab. */
  follow?: 'import' | 'variant' | 'reply' | 'target' | 'record';
}
export const text = (key: string, label: Label, optional = false): Field => ({ key, label, optional });
const pick = (key: string, label: Label, options: string[], initial?: string): Field => ({ ...text(key, label), type: 'select', options, initial });
const ref = (key: string, label: Label, lookup: string, optional = false): Field => ({ ...text(key, label, optional), type: 'ref', lookup });
const date = (key: string, label: Label, optional = false): Field => ({ ...text(key, label, optional), type: 'datetime-local' });
const area = (key: string, label: Label, optional = false): Field => ({ ...text(key, label, optional), type: 'textarea' });
const brand = ref('brand_id', ['品牌', 'Brand'], '/brands');
const campaign = ref('campaign_id', ['活動', 'Campaign', '活动'], '/campaigns', true);
const title = text('title', ['標題', 'Title', '标题']);
const name = text('name', ['名稱', 'Name', '名称']);
const note = area('note', ['備註', 'Note', '备注'], true);
const reason = area('reason', ['原因', 'Reason']);
const tz: Field = { ...text('tz', ['時區', 'Time zone', '时区']), type: 'timezone', advanced: true, initial: Intl.DateTimeFormat().resolvedOptions().timeZone };
const importInputs: Field[] = [{ key: 'csv_text', type: 'file', label: ['CSV 檔案', 'CSV file', 'CSV 文件'], optional: true }, { ...text('file_object_id', ['已上傳檔案 ID', 'Uploaded file ID', '已上传文件 ID'], true), advanced: true, hint: ['已選擇 CSV 檔案時不用填。', 'Leave blank when you choose a CSV file.', '已选择 CSV 文件时不用填。'] }];
const docText = (value: unknown) => (recordRowsOf(asRecordOf(value).content) ?? []).map(paragraph =>
  (recordRowsOf(paragraph.content) ?? []).map(node => typeof node.text === 'string' ? node.text : '').join('')).join('\n');
function asRecordOf(value: unknown): RecordData { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {}; }
function recordRowsOf(value: unknown): RecordData[] | undefined { return Array.isArray(value) ? value.map(asRecordOf) : undefined; }
const locales = ['zh-TW', 'zh-HK', 'zh-CN', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'th-TH', 'vi-VN', 'id-ID', 'ms-MY', 'fil-PH'];
const accountProviders = ['douyin', 'xiaohongshu', 'tiktok', 'meta_instagram', 'meta_facebook', 'youtube'];
function importBody(values: RecordData) {
  if (Boolean(values.csv_text) === Boolean(values.file_object_id)) throw new Error('select_one_import_source');
  return values;
}
const permalink: Field = { ...text('permalink', ['平台作品連結', 'Published post URL', '平台作品链接']), type: 'url' };
const create = (path: string, label: Label, fields: Field[], extra: Partial<Action> = {}): Action => ({ path, label, fields, ...extra });
const update = (path: string, fields: Field[]): Action => create(path, ['編輯', 'Edit', '编辑'], fields, { method: 'PATCH', versioned: true });
const campaignFields = [name, pick('kind', ['活動類型', 'Campaign type', '活动类型'], ['launch', 'seasonal', 'promotion', 'always_on', 'brand', 'other'], 'launch'), date('starts_at', ['開始時間', 'Starts at', '开始时间'], true), date('ends_at', ['結束時間', 'Ends at', '结束时间'], true), { ...tz, key: 'timezone' }, area('objective_summary', ['活動目標', 'Objective', '活动目标'], true)];
const contentFields = [title, campaign, date('production_due_at', ['製作期限', 'Production deadline', '制作期限'], true)];
const bodyDoc = (value: unknown) => ({ type: 'doc', content: String(value ?? '').split('\n').map(line => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) })) });

export const createActions: Record<string, Action> = {
  models: create('/model-providers', ['登記模型供應商', 'Register model provider', '登记模型供应商'], [name,
    pick('kind', ['協定', 'Protocol', '协定'], ['openai_compatible', 'anthropic_compatible']),
    { ...text('endpoint', ['端點', 'Endpoint', '端点']), type: 'url' }, text('secret_id', ['部署憑證參照', 'Deployment credential reference', '部署凭证参照']),
    { ...text('allowed_data_classes', ['可外送資料類別（逗號分隔）', 'Allowed data classes (comma separated)', '可外送数据类别（逗号分隔）']), type: 'ids' }]),
  modelRoutes: create('/model-routes', ['新增用途路由', 'Add model route', '添加用途路由'], [
    pick('purpose', ['用途', 'Purpose'], ['plan', 'draft', 'translate', 'classify', 'analyze', 'embed']),
    ref('provider_id', ['模型供應商', 'Model provider', '模型供应商'], '/model-providers'), text('model', ['模型名稱', 'Model name', '模型名称']),
    pick('enabled', ['啟用路由', 'Route status', '激活路由'], ['disabled', 'enabled'], 'disabled'),
  ], { body: values => ({ ...values, enabled: values.enabled === 'enabled' }) }),
  budgets: create('/collection-budgets', ['設定採集預算', 'Set collection budget', '设置采集预算'], [ref('data_source_id', ['資料源（留空適用整個工作區）', 'Data source (blank for workspace)', '数据源（留空适用整个工作区）'], '/data-sources', true),
    text('cap_units', ['每月用量上限', 'Monthly unit cap'], true), text('cap_minor', ['每月費用上限（最小貨幣單位）', 'Monthly cost cap (minor units)', '每月费用上限（最小货币单位）'], true), text('currency', ['幣別', 'Currency', '币别'], true),
    pick('on_exceed', ['達上限時', 'When the cap is reached', '达上限时'], ['pause', 'reduce_frequency', 'alert_only'], 'pause'),
    text('fallback_interval_seconds', ['降頻間隔（秒）', 'Reduced request interval (seconds)', '降频间隔（秒）'], true)], { method: 'PUT', body: values => Object.fromEntries(Object.entries(values)
      .map(([key, value]) => [key, ['cap_units', 'cap_minor', 'fallback_interval_seconds'].includes(key) ? Number(value) : value])) }),
  backfills: create('/backfills', ['啟動歷史回補', 'Start historical backfill', '启动历史回补'], [ref('data_source_id', ['資料源', 'Data source', '数据源'], '/data-sources'),
    { ...text('resources', ['資料類型（逗號分隔）', 'Resources (comma separated)', '数据类型（逗号分隔）']), type: 'ids' }, date('from', ['開始時間', 'Start time', '开始时间']), date('to', ['結束時間', 'End time', '结束时间'])]),
  accounts: create('/social-accounts', ['登記自有帳號', 'Register owned account', '登记自有账号'], [brand, text('display_name', ['顯示名稱', 'Display name', '显示名称']), pick('provider', ['平台', 'Provider'], accountProviders), { ...text('external_account_id', ['平台帳號 ID', 'Platform account ID', '平台账号 ID']), hint: ['在平台的帳號設定或個人主頁網址中可找到。', 'Find it in the platform account settings or profile URL.', '在平台的账号设置或个人主页网址中可找到。'] }, { ...tz, key: 'default_timezone' }], { confirm: true, body: values => ({ ...values, owned_account_confirmed: true }) }),
  brands: create('/brands', ['新增品牌', 'Create brand', '添加品牌'], [name, { ...text('slug', ['品牌網址代稱', 'Brand slug', '品牌网址代称']), hint: ['英文小寫與連字號，例如 my-brand。', 'Lowercase letters and hyphens, e.g. my-brand.', '英文小写与连字号，例如 my-brand。'] }]),
  work: create('/work-items', ['新增工作項目', 'Create work item', '添加工作项目'], [title, { ...brand, optional: true }, date('due_at', ['期限', 'Due date'], true)]),
  campaigns: create('/campaigns', ['新增活動', 'Create campaign', '添加活动'], [brand, ...campaignFields, { ...text('utm_key', ['活動追蹤代碼', 'Campaign tracking key', '活动追踪代码']), hint: ['用於連結的 utm_campaign，例如 2026-spring。', 'Used as utm_campaign in links, e.g. 2026-spring.', '用于链接的 utm_campaign，例如 2026-spring。'] }]),
  stores: create('/stores', ['新增匯入店鋪', 'Create import store', '添加导入店铺'], [brand, name, pick('provider', ['平台', 'Provider'], ['file_import', 'shopify', 'tiktok_shop', 'amazon_sp', 'shopee'], 'file_import'), { ...text('default_currency', ['幣別', 'Currency', '币别']), initial: 'TWD' }, pick('default_locale', ['店鋪語言', 'Store locale', '店铺语言'], locales, 'zh-TW')], { body: values => ({ ...values, mode: 'import' }) }),
  content: create('/content-items', ['新增內容', 'Create content', '添加内容'], [brand, ...contentFields]),
  ideas: create('/ideas', ['新增選題', 'Create idea', '添加选题'], [brand, title, campaign, { ...text('evidence_url', ['靈感來源連結', 'Source link', '灵感来源链接']), type: 'url', hint: ['例如競品貼文、熱門話題或顧客評論的網址。每個選題至少要有一個來源。', 'For example a competitor post, trending topic, or customer review. Each idea needs at least one source.', '例如竞品帖子、热门话题或顾客评论的网址。每个选题至少要有一个来源。'] }], { body: ({ evidence_url, ...values }) => ({ ...values, origin_refs: [{ type: 'link', url: evidence_url }] }) }),
  knowledge: create('/knowledge', ['提議品牌知識', 'Propose brand knowledge', '提议品牌知识'], [brand, title,
    pick('kind', ['知識類型', 'Knowledge type', '知识类型'], ['positioning', 'tone', 'forbidden_phrase', 'faq', 'example', 'policy', 'product_pointer'], 'tone'), area('body', ['內容', 'Body', '内容'])]),
  templates: create('/templates', ['建立文案範本', 'Create copy template', '创建文案范本'], [brand, name,
    pick('kind', ['範本類型', 'Template type', '范本类型'], ['text_snippet', 'hashtag_set', 'cta', 'caption_template'], 'caption_template'),
    area('body', ['範本文案', 'Template copy', '范本文案']), { key: 'variables', type: 'array', label: ['變數（鍵與來源）', 'Variables (key and source)', '变量（键与来源）'], initial: '[]' }],
    { body: values => ({ ...values, variables: (values.variables as RecordData[]).map(variable => ({ required: true, ...variable })) }) }),
  targets: create('/publish-targets', ['建立排期', 'Create schedule', '创建排期'], [brand, campaign, ref('content_item_id', ['內容項目', 'Content item', '内容项目'], '/content-items'), { ...text('content_variant_id', ['平台版本', 'Platform version']), type: 'ref', hint: ['先選內容項目，再選要發到哪個平台的版本。', 'Pick the content item first, then the platform version.', '先选内容项目，再选要发到哪个平台的版本。'] }, { ...text('variant_revision_id', ['定稿版本', 'Saved version']), type: 'ref', lookup: '/content-variants/:id/revisions', hint: ['預設選最新儲存的版本。排期後內容不會再被改動。', 'The latest saved version is preselected. Scheduled content stays fixed.', '预设选最新保存的版本。排期后内容不会再被改动。'] }, ref('social_account_id', ['社群帳號', 'Social account', '社交媒体账号'], '/social-accounts'), pick('content_format', ['格式', 'Format'], ['image', 'carousel', 'reel', 'video', 'short', 'story', 'text']), { ...text('local_scheduled_at', ['發布時間', 'Publish at', '发布时间']), type: 'datetime-local', keepLocal: true, hint: ['依下方「發布時區」的當地時間發布。遇到日光節約時間跳過的時刻會提示你。', 'Publishes at this local time in the time zone below. You are warned about daylight-saving gaps.', '依下方「发布时区」的当地时间发布。遇到日光节约时间跳过的时刻会提示你。'] }, { ...tz, key: 'schedule_tz', label: ['發布時區', 'Publishing time zone', '发布时区'], advanced: false }, pick('visibility', ['可見性', 'Visibility', '可见性'], ['public', 'private', 'unlisted', 'followers', 'scheduled_private'], 'public')], { body: values => ({ ...values, schedule_kind: 'exact' }), follow: 'target' }),
  reports: create('/reports', ['建立報告', 'Create report', '创建报告'], [title, pick('kind', ['報告類型', 'Report type', '报告类型'], ['social_performance', 'campaign', 'client_monthly', 'custom'], 'social_performance'), { ...brand, optional: true }, { ...campaign, optional: true }, { key: 'from', type: 'date', label: ['起始日期', 'Start date'] }, { key: 'to', type: 'date', label: ['結束日期', 'End date', '结束日期'] }, tz, { key: 'sections', type: 'array', advanced: true, initial: '[{"key":"notes","type":"narrative"}]', label: ['報告區段（JSON 陣列）', 'Report sections (JSON array)', '报告区段（JSON 数组）'] }], { body: ({ title, kind, brand_id, campaign_id, from, to, tz, sections }) => {
    if (String(to) < String(from)) throw new Error('invalid_date_range');
    return { title, kind, scope: { ...(brand_id ? { brand_ids: [brand_id] } : {}), ...(campaign_id ? { campaign_ids: [campaign_id] } : {}) }, period: { from, to, tz }, sections };
  } }),
  tags: create('/inbox/tags', ['新增標籤', 'Create tag', '添加标签'], [name]),
  reviewSources: create('/inbox/review-sources', ['登記公開評價來源', 'Register public review source', '登记公开评价来源'], [text('label', ['來源名稱', 'Source name', '来源名称']), { ...text('source_url', ['平台來源網址', 'Platform source URL', '平台来源网址']), type: 'url' }]),
  links: create('/short-links', ['新增短連結', 'Create short link', '添加短链接'], [brand, campaign, text('slug', ['短連結代稱', 'Short-link slug', '短链接代称']), { ...text('destination_url', ['目的網址', 'Destination URL', '目的网址']), type: 'url' }]),
};

export const rowActions: Record<string, Action[]> = {
  jobs: [create('/agent-jobs/:id/run', ['執行 Agent', 'Run Agent', '运行 Agent'], [], { versioned: true, confirm: true })],
  models: [
    create('/model-providers/:id', ['設定狀態及確認外送', 'Set provider status and confirm egress', '设置状态及确认外送'], [pick('status', ['狀態', 'Status', '状态'], ['active', 'disabled', 'revoke_egress'])],
      { method: 'PATCH', versioned: true, confirm: true, body: ({ status }) => status === 'revoke_egress' ? { confirm_egress: false } :
        { status, ...(status === 'active' && { confirm_egress: true }) } }),
    create('/model-providers/:id/test', ['探測模型工具能力', 'Probe model tool capability', '探测模型工具能力'], [text('model', ['模型名稱', 'Model name', '模型名称'])], { confirm: true }),
    create('/model-providers/:id', ['移除模型供應商', 'Remove model provider', '移除模型供应商'], [], { method: 'DELETE', versioned: true, confirm: true }),
  ],
  modelRoutes: [
    update('/model-routes/:id', [ref('provider_id', ['模型供應商', 'Model provider', '模型供应商'], '/model-providers'), text('model', ['模型名稱', 'Model name', '模型名称'])]),
    create('/model-routes/:id', ['設定用途路由狀態', 'Set model route status', '设置用途路由状态'], [pick('enabled', ['啟用路由', 'Route status', '激活路由'], ['disabled', 'enabled'])],
      { method: 'PATCH', versioned: true, body: values => ({ enabled: values.enabled === 'enabled' }) }),
    create('/model-routes/:id', ['移除模型用途路由', 'Remove model route'], [], { method: 'DELETE', versioned: true, confirm: true }),
  ],
  variants: [create('/content-variants/:id/apply-template', ['用範本替換工作稿文案', 'Replace draft copy with template', '用范本替换工作稿文案'], [
    ref('template_id', ['文案範本', 'Copy template', '文案范本'], '/templates'),
    { key: 'values', type: 'json', label: ['變數來源參照', 'Variable source references', '变量来源参照'], optional: true }], { versioned: true, confirm: true }),
    create('/content-variants/:id', ['編輯工作稿', 'Edit working draft', '编辑工作稿'], [{ ...area('draft_text', ['文案', 'Copy']), read: record => docText(record.draft_doc) }], { method: 'PATCH', versioned: true, body: ({ draft_text, ...values }) => ({ ...values, draft_doc: bodyDoc(draft_text) }) }), create('/content-variants/:id/revisions', ['儲存修訂', 'Save revision', '保存修订'], [note]), create('/content-variants/:id/validate', ['檢查帳號能否發布', 'Check account capability', '检查账号能否发布'], [{ key: 'social_account_ids', type: 'ids', lookup: '/social-accounts', label: ['要發布的社群帳號', 'Social accounts to publish to', '要发布的社交媒体账号'] }]), create('/content-variants/:id/readiness', ['標記為可排期', 'Mark ready', '标记为可排期'], [], { body: () => ({ readiness: 'ready' }) })],
  brands: [update('/brands/:id', [name]), create('/brands/:id/markets', ['新增市場', 'Create market', '添加市场'], [name, text('country_code', ['國家代碼', 'Country code', '国家代码']), text('primary_language', ['市場語言', 'Market locale', '市场语言']), text('currency', ['幣別', 'Currency', '币别']), { ...tz, key: 'timezone' }])],
  work: [update('/work-items/:id', [title, date('due_at', ['期限', 'Due date'], true)]), create('/work-items/:id/complete', ['完成', 'Complete'], [note]), create('/work-items/:id/reopen', ['重新開啟', 'Reopen', '重新打开'], [note])],
  campaigns: [update('/campaigns/:id', campaignFields), create('/campaigns/:id/transition', ['變更狀態', 'Change status', '变更状态'], [pick('to', ['新狀態', 'New status', '新状态'], ['planned', 'active', 'paused', 'wrapping', 'closed', 'cancelled']), reason], { confirm: true }), create('/campaigns/:id/products', ['設定活動商品', 'Set campaign products', '设置活动商品'], [{ key: 'product_ids', label: ['活動商品', 'Campaign products', '活动商品'], type: 'ids', lookup: '/products', hint: ['第一個勾選的商品會設為主推商品。', 'The first selected product becomes the hero product.', '第一个勾选的商品会设为主推商品。'] }], { method: 'PUT', versioned: true, confirm: true, body: ({ product_ids }) => ({ products: (product_ids as string[]).map((product_id, index) => ({ product_id, role: index ? 'supporting' : 'hero' })) }) })],
  stores: [create('/stores/:id/imports', ['匯入商品', 'Import products', '导入商品'], importInputs, { body: values => importBody({ ...values, template_key: 'product_list' }), follow: 'import' })],
  content: [update('/content-items/:id', contentFields), create('/content-items/:id/stage', ['移動製作階段', 'Move production stage', '移动制作阶段'], [pick('to', ['階段', 'Stage', '阶段'], ['accepted', 'drafting', 'design', 'awaiting_assets', 'internal_review', 'ready', 'archived']), note], { versioned: true }), create('/content-items/:id/variants', ['新增內容變體', 'Create variant', '添加内容变体'], [pick('platform', ['社群平台', 'Platform', '社交媒体平台'], ['instagram', 'facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu', 'generic']), pick('format', ['格式', 'Format'], ['feed_image', 'carousel', 'reel', 'story', 'short_video', 'long_video', 'text', 'note', 'live_teaser']), pick('locale', ['內容語言', 'Content locale', '内容语言'], locales, 'zh-TW'), area('draft_text', ['文案', 'Copy'])], { body: ({ draft_text, ...values }) => ({ ...values, draft_doc: bodyDoc(draft_text) }), follow: 'variant' })],
  ideas: [create('/ideas/:id/convert', ['轉為內容項目', 'Convert to content', '转为内容项目'], [title])],
  targets: [create('/publish-targets/:id/precheck', ['執行預檢', 'Run preflight', '运行预检'], [pick('stage', ['檢查階段', 'Check stage', '检查阶段'], ['preflight', 'schedule', 'approval', 'execution'], 'preflight')]), create('/publish-targets/:id/submit', ['提交排期／審批', 'Submit schedule / approval', '提交排期／审批'], [], { versioned: true, confirm: true }), create('/publish-targets/:id/reschedule', ['改期', 'Reschedule'], [date('scheduled_at', ['新時間（瀏覽器時區）', 'New time (browser time zone)', '新时间（浏览器时区）'])], { versioned: true }), create('/publish-targets/:id/approve', ['核准', 'Approve'], [note], { confirm: true, versioned: true }), create('/publish-targets/:id/request-changes', ['要求修改', 'Request changes'], [reason], { confirm: true, versioned: true }), create('/publish-targets/:id/reject', ['退回', 'Reject'], [reason], { confirm: true, versioned: true }), create('/publish-targets/:id/cancel', ['取消發布', 'Cancel publishing', '取消发布'], [reason], { confirm: true, versioned: true })],
  tasks: [create('/execution-tasks/:id/reconcile', ['立即核實', 'Reconcile now', '立即核实'], []), create('/execution-tasks/:id/handover', ['轉人工', 'Hand over to manual', '转人工'], [reason, ref('assignee', ['接手成員', 'Assignee', '接手成员'], '/members', true)], { body: values => ({ ...values, to_executor: 'manual' }), confirm: true }), create('/execution-tasks/:id/manual-complete', ['回填人工發布', 'Record manual publication', '回填人工发布'], [permalink, date('published_at', ['實際發布時間', 'Actual publish time', '实际发布时间']), { key: 'evidence_file_ids', type: 'ids', label: ['證據檔案 ID（逗號分隔）', 'Evidence file IDs (comma separated)', '证据文件 ID（逗号分隔）'], optional: true }], { body: values => ({ evidence_file_ids: [], ...values }), confirm: true }), create('/execution-tasks/:id/manual-abandon', ['確認不發布', 'Abandon publication', '确认不发布'], [reason], { confirm: true }), create('/execution-tasks/:id/retry', ['重試執行', 'Retry execution', '重试运行'], [], { confirm: true })],
  conversations: [create('/conversations/:id/occupancy', ['領取回覆處理權', 'Acquire reply lease', '领取回复处理权'], [], { body: () => ({ purpose: 'reply' }) }), create('/conversations/:id/read', ['標記已讀', 'Mark as read', '标记已读'], []), create('/conversations/:id/reply-drafts', ['建立回覆草稿', 'Draft reply', '创建回复草稿'], [pick('reply_mode', ['回覆方式', 'Reply mode', '回复方式'], ['public_reply', 'private_reply', 'dm']), area('body_text', ['回覆文字', 'Reply text', '回复文字'])], { follow: 'reply' }), create('/conversations/:id/notes', ['新增內部備註', 'Add internal note', '添加内部备注'], [area('body', ['備註內容', 'Note text', '备注内容'])])],
  replies: [create('/reply-drafts/:id/submit-approval', ['提交回覆審批', 'Submit reply for approval', '提交回复审批'], [], { confirm: true }), create('/reply-drafts/:id/send', ['送出回覆', 'Send reply', '送出回复'], [text('fencing_token', ['對話占用權杖', 'Conversation fencing token', '对话占用令牌'])], { confirm: true, body: values => { const token = Number(values.fencing_token); if (!Number.isSafeInteger(token) || token < 1) throw new Error('invalid_token'); return { fencing_token: token }; } })],
  reports: [create('/reports/:id/versions', ['產生報告版本', 'Generate report version', '产生报告版本'], [date('data_cutoff_at', ['資料截止時間', 'Data cutoff', '数据截止时间'], true)])],
  reportVersions: [create('/reports/:id/versions/:n/finalize', ['定稿', 'Finalize'], [], { confirm: true }), create('/reports/:id/versions/:n/export', ['匯出報告', 'Export report', '导出报告'], [pick('format', ['檔案格式', 'File format', '文件格式'], ['pdf', 'csv', 'xlsx'], 'pdf')])],
  reportVersionIds: [create('/report-versions/:id/finalize', ['定稿', 'Finalize'], [], { confirm: true })],
  backfills: [create('/backfills/:id/resume', ['續跑未完成分片', 'Resume unfinished shards', '续跑未完成分片'], [])],
  quality: [create('/data-quality/issues/:id', ['處理品質問題', 'Disposition quality issue', '处理品质问题'], [pick('status', ['狀態', 'Status', '状态'], ['resolved', 'accepted', 'open']), reason], { method: 'PATCH', versioned: true })],
  sources: [create('/data-sources/:id/refresh', ['立即同步', 'Sync now'], [])],
  imports: [create('/imports/:id', ['更新欄位對應', 'Update field mapping', '更新字段对应'], [{ key: 'mapping', type: 'json', label: ['欄位對應（JSON）', 'Field mapping (JSON)', '字段对应（JSON）'] }], { method: 'PATCH', versioned: true }), create('/imports/:id/confirm', ['確認合併', 'Confirm import', '确认合并'], [], { confirm: true }), create('/imports/:id/cancel', ['取消匯入', 'Cancel import', '取消导入'], [], { confirm: true })],
};

export const generalImport = create('/imports', ['建立匯入批次', 'Create import batch', '创建导入批量'], [ref('template_key', ['匯入模板', 'Import template', '导入模板'], '/import-templates'), ...importInputs, ref('data_source_id', ['資料源', 'Data source', '数据源'], '/data-sources', true)], { follow: 'import', body: importBody });

export function permitsAction(key: string, action: Action, record: RecordData, name: string) {
  const verb = action.path.split('/').at(-1)!;
  if (key === 'backfills' && verb === 'resume') return Number((record.progress as RecordData | undefined)?.failed) > 0;
  if (key === 'tasks' && verb === 'retry' && (record.status === 'outcome_unknown' || record.sub_status === 'outcome_unknown' || record.status === 'accepted' || record.sub_status === 'accepted')) return false;
  if (!Array.isArray(record.allowed_actions) || verb === 'precheck') return true;
  if (action.method === 'PATCH') return record.allowed_actions.some(value => value === 'edit' || value === 'update' || value === name);
  return record.allowed_actions.some(value => [verb, verb.replaceAll('-', '_'), name].includes(String(value)));
}
