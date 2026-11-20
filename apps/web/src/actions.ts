import type { Method, RecordData } from '@smartsell/sdk';
import type { Label } from './modules';

export interface Field {
  key: string;
  label?: Label;
  type?: 'textarea' | 'date' | 'datetime-local' | 'email' | 'url' | 'json' | 'file' | 'array' | 'ids' | 'select' | 'ref';
  options?: string[];
  lookup?: string;
  optional?: boolean;
  initial?: string;
}
export interface Action {
  path: string;
  label: Label;
  method?: Method;
  fields?: Field[];
  versioned?: boolean;
  confirm?: boolean;
  body?: (values: RecordData) => RecordData;
  follow?: 'import' | 'variant' | 'reply' | 'target';
}
export const text = (key: string, zh: string, en: string, optional = false): Field => ({ key, label: [zh, en], optional });
const pick = (key: string, zh: string, en: string, options: string[], initial?: string): Field => ({ ...text(key, zh, en), type: 'select', options, initial });
const ref = (key: string, zh: string, en: string, lookup: string, optional = false): Field => ({ ...text(key, zh, en, optional), type: 'ref', lookup });
const date = (key: string, zh: string, en: string, optional = false): Field => ({ ...text(key, zh, en, optional), type: 'datetime-local' });
const area = (key: string, zh: string, en: string, optional = false): Field => ({ ...text(key, zh, en, optional), type: 'textarea' });
const brand = ref('brand_id', '品牌', 'Brand', '/brands');
const campaign = ref('campaign_id', '活動', 'Campaign', '/campaigns', true);
const title = text('title', '標題', 'Title');
const name = text('name', '名稱', 'Name');
const note = area('note', '備註', 'Note', true);
const reason = area('reason', '原因', 'Reason');
const tz = { ...text('tz', '時區（IANA）', 'Time zone (IANA)'), initial: Intl.DateTimeFormat().resolvedOptions().timeZone };
const importInputs: Field[] = [{ key: 'csv_text', type: 'file', label: ['CSV 檔案', 'CSV file'], optional: true }, text('file_object_id', '已上傳檔案 ID', 'Uploaded file ID', true)];
const accountProviders = ['douyin', 'xiaohongshu', 'tiktok', 'meta_instagram', 'meta_facebook', 'youtube'];
function importBody(values: RecordData) {
  if (Boolean(values.csv_text) === Boolean(values.file_object_id)) throw new Error('select_one_import_source');
  return values;
}
const permalink: Field = { ...text('permalink', '平台作品連結', 'Published post URL'), type: 'url' };
const create = (path: string, zh: string, en: string, fields: Field[], extra: Partial<Action> = {}): Action => ({ path, label: [zh, en], fields, ...extra });
const update = (path: string, fields: Field[]): Action => create(path, '編輯', 'Edit', fields, { method: 'PATCH', versioned: true });
const campaignFields = [name, pick('kind', '活動類型', 'Campaign type', ['launch', 'seasonal', 'promotion', 'always_on', 'brand', 'other'], 'launch'), date('starts_at', '開始時間', 'Starts at', true), date('ends_at', '結束時間', 'Ends at', true), { ...tz, key: 'timezone' }, area('objective_summary', '活動目標', 'Objective', true)];
const contentFields = [title, campaign, date('production_due_at', '製作期限', 'Production deadline', true)];
const bodyDoc = (value: unknown) => ({ type: 'doc', content: String(value ?? '').split('\n').map(line => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) })) });

export const createActions: Record<string, Action> = {
  models: create('/model-providers', '登記模型供應商', 'Register model provider', [name,
    pick('kind', '協定', 'Protocol', ['openai_compatible', 'anthropic_compatible']),
    { ...text('endpoint', '端點', 'Endpoint'), type: 'url' }, text('secret_id', '部署憑證參照', 'Deployment credential reference'),
    { ...text('allowed_data_classes', '可外送資料類別（逗號分隔）', 'Allowed data classes (comma separated)'), type: 'ids' }]),
  modelRoutes: create('/model-routes', '新增用途路由', 'Add model route', [
    pick('purpose', '用途', 'Purpose', ['plan', 'draft', 'translate', 'classify', 'analyze', 'embed']),
    ref('provider_id', '模型供應商', 'Model provider', '/model-providers'), text('model', '模型名稱', 'Model name'),
    pick('enabled', '啟用路由', 'Route status', ['disabled', 'enabled'], 'disabled'),
  ], { body: values => ({ ...values, enabled: values.enabled === 'enabled' }) }),
  budgets: create('/collection-budgets', '設定採集預算', 'Set collection budget', [ref('data_source_id', '資料源（留空適用整個工作區）', 'Data source (blank for workspace)', '/data-sources', true),
    text('cap_units', '每月用量上限', 'Monthly unit cap', true), text('cap_minor', '每月費用上限（最小貨幣單位）', 'Monthly cost cap (minor units)', true), text('currency', '幣別', 'Currency', true),
    pick('on_exceed', '達上限時', 'When the cap is reached', ['pause', 'reduce_frequency', 'alert_only'], 'pause'),
    text('fallback_interval_seconds', '降頻間隔（秒）', 'Reduced request interval (seconds)', true)], { method: 'PUT', body: values => Object.fromEntries(Object.entries(values)
      .map(([key, value]) => [key, ['cap_units', 'cap_minor', 'fallback_interval_seconds'].includes(key) ? Number(value) : value])) }),
  backfills: create('/backfills', '啟動歷史回補', 'Start historical backfill', [ref('data_source_id', '資料源', 'Data source', '/data-sources'),
    { ...text('resources', '資料類型（逗號分隔）', 'Resources (comma separated)'), type: 'ids' }, date('from', '開始時間', 'Start time'), date('to', '結束時間', 'End time')]),
  accounts: create('/social-accounts', '登記自有帳號', 'Register owned account', [brand, text('display_name', '顯示名稱', 'Display name'), pick('provider', '平台', 'Provider', accountProviders), text('external_account_id', '平台帳號 ID', 'Platform account ID'), { ...tz, key: 'default_timezone' }], { confirm: true, body: values => ({ ...values, owned_account_confirmed: true }) }),
  brands: create('/brands', '新增品牌', 'Create brand', [name, text('slug', '品牌代稱（slug）', 'Brand slug')]),
  work: create('/work-items', '新增工作項目', 'Create work item', [title, { ...brand, optional: true }, date('due_at', '期限', 'Due date', true)]),
  campaigns: create('/campaigns', '新增活動', 'Create campaign', [brand, ...campaignFields, text('utm_key', '活動追蹤識別', 'Campaign tracking key')]),
  stores: create('/stores', '新增匯入店鋪', 'Create import store', [brand, name, pick('provider', '平台', 'Provider', ['file_import', 'shopify', 'tiktok_shop', 'amazon_sp', 'shopee'], 'file_import'), { ...text('default_currency', '幣別', 'Currency'), initial: 'TWD' }, { ...text('default_locale', '店鋪語言', 'Store locale'), initial: 'zh-TW' }], { body: values => ({ ...values, mode: 'import' }) }),
  content: create('/content-items', '新增內容', 'Create content', [brand, ...contentFields]),
  ideas: create('/ideas', '新增選題', 'Create idea', [brand, title, campaign]),
  knowledge: create('/knowledge', '提議品牌知識', 'Propose brand knowledge', [brand, title,
    pick('kind', '知識類型', 'Knowledge type', ['positioning', 'tone', 'forbidden_phrase', 'faq', 'example', 'policy', 'product_pointer'], 'tone'), area('body', '內容', 'Body')]),
  templates: create('/templates', '建立文案範本', 'Create copy template', [brand, name,
    pick('kind', '範本類型', 'Template type', ['text_snippet', 'hashtag_set', 'cta', 'caption_template'], 'caption_template'),
    area('body', '範本文案', 'Template copy'), { key: 'variables', type: 'array', label: ['變數（鍵與來源）', 'Variables (key and source)'], initial: '[]' }],
    { body: values => ({ ...values, variables: (values.variables as RecordData[]).map(variable => ({ required: true, ...variable })) }) }),
  targets: create('/publish-targets', '建立排期', 'Create schedule', [brand, campaign, ref('content_item_id', '內容項目', 'Content item', '/content-items'), text('content_variant_id', '內容變體 ID', 'Content variant ID'), text('variant_revision_id', '凍結修訂 ID', 'Saved revision ID'), ref('social_account_id', '社群帳號', 'Social account', '/social-accounts'), pick('content_format', '格式', 'Format', ['image', 'carousel', 'reel', 'video', 'short', 'story', 'text']), date('scheduled_at', '發布時間（瀏覽器時區）', 'Publish at (browser time zone)'), { ...tz, key: 'schedule_tz' }, pick('visibility', '可見性', 'Visibility', ['public', 'private', 'unlisted', 'followers', 'scheduled_private'], 'public')], { body: values => ({ ...values, schedule_kind: 'exact' }), follow: 'target' }),
  reports: create('/reports', '建立報告', 'Create report', [title, pick('kind', '報告類型', 'Report type', ['social_performance', 'campaign', 'client_monthly', 'custom'], 'social_performance'), { ...brand, optional: true }, { ...campaign, optional: true }, { key: 'from', type: 'date', label: ['起始日期', 'Start date'] }, { key: 'to', type: 'date', label: ['結束日期', 'End date'] }, tz, { key: 'sections', type: 'array', initial: '[{"key":"notes","type":"narrative"}]', label: ['報告區段（JSON 陣列）', 'Report sections (JSON array)'] }], { body: ({ title, kind, brand_id, campaign_id, from, to, tz, sections }) => {
    if (String(to) < String(from)) throw new Error('invalid_date_range');
    return { title, kind, scope: { ...(brand_id ? { brand_ids: [brand_id] } : {}), ...(campaign_id ? { campaign_ids: [campaign_id] } : {}) }, period: { from, to, tz }, sections };
  } }),
  tags: create('/inbox/tags', '新增標籤', 'Create tag', [name]),
  reviewSources: create('/inbox/review-sources', '登記公開評價來源', 'Register public review source', [text('label', '來源名稱', 'Source name'), { ...text('source_url', '平台來源網址', 'Platform source URL'), type: 'url' }]),
  links: create('/short-links', '新增短連結', 'Create short link', [brand, campaign, text('slug', '短連結代稱', 'Short-link slug'), { ...text('destination_url', '目的網址', 'Destination URL'), type: 'url' }]),
};

export const rowActions: Record<string, Action[]> = {
  jobs: [create('/agent-jobs/:id/run', '執行 Agent', 'Run Agent', [], { versioned: true, confirm: true })],
  models: [
    create('/model-providers/:id', '設定狀態及確認外送', 'Set provider status and confirm egress', [pick('status', '狀態', 'Status', ['active', 'disabled', 'revoke_egress'])],
      { method: 'PATCH', versioned: true, confirm: true, body: ({ status }) => status === 'revoke_egress' ? { confirm_egress: false } :
        { status, ...(status === 'active' && { confirm_egress: true }) } }),
    create('/model-providers/:id/test', '探測模型工具能力', 'Probe model tool capability', [text('model', '模型名稱', 'Model name')], { confirm: true }),
    create('/model-providers/:id', '移除模型供應商', 'Remove model provider', [], { method: 'DELETE', versioned: true, confirm: true }),
  ],
  modelRoutes: [
    update('/model-routes/:id', [ref('provider_id', '模型供應商', 'Model provider', '/model-providers'), text('model', '模型名稱', 'Model name')]),
    create('/model-routes/:id', '設定用途路由狀態', 'Set model route status', [pick('enabled', '啟用路由', 'Route status', ['disabled', 'enabled'])],
      { method: 'PATCH', versioned: true, body: values => ({ enabled: values.enabled === 'enabled' }) }),
    create('/model-routes/:id', '移除模型用途路由', 'Remove model route', [], { method: 'DELETE', versioned: true, confirm: true }),
  ],
  variants: [create('/content-variants/:id/apply-template', '用範本替換工作稿文案', 'Replace draft copy with template', [
    ref('template_id', '文案範本', 'Copy template', '/templates'),
    { key: 'values', type: 'json', label: ['變數來源參照', 'Variable source references'], optional: true }], { versioned: true, confirm: true }),
    create('/content-variants/:id', '編輯工作稿', 'Edit working draft', [{ key: 'draft_doc', label: ['工作稿（ProseMirror JSON）', 'Working draft (ProseMirror JSON)'], type: 'json' }], { method: 'PATCH', versioned: true }), create('/content-variants/:id/revisions', '儲存修訂', 'Save revision', [note]), create('/content-variants/:id/validate', '驗證帳號能力', 'Validate account capability', [{ key: 'social_account_ids', type: 'ids', label: ['社群帳號 ID（逗號分隔）', 'Social account IDs (comma separated)'] }]), create('/content-variants/:id/readiness', '標記為可排期', 'Mark ready', [], { body: () => ({ readiness: 'ready' }) })],
  brands: [update('/brands/:id', [name]), create('/brands/:id/markets', '新增市場', 'Create market', [name, text('country_code', '國家代碼', 'Country code'), text('primary_language', '市場語言', 'Market locale'), text('currency', '幣別', 'Currency'), { ...tz, key: 'timezone' }])],
  work: [update('/work-items/:id', [title, date('due_at', '期限', 'Due date', true)]), create('/work-items/:id/complete', '完成', 'Complete', [note]), create('/work-items/:id/reopen', '重新開啟', 'Reopen', [note])],
  campaigns: [update('/campaigns/:id', campaignFields), create('/campaigns/:id/transition', '變更狀態', 'Change status', [pick('to', '新狀態', 'New status', ['planned', 'active', 'paused', 'wrapping', 'closed', 'cancelled']), reason], { confirm: true }), create('/campaigns/:id/products', '設定活動商品', 'Set campaign products', [{ key: 'items', label: ['活動商品（JSON 陣列）', 'Campaign products (JSON array)'], type: 'array', initial: '[]' }], { method: 'PUT', confirm: true })],
  stores: [create('/stores/:id/imports', '匯入商品', 'Import products', importInputs, { body: values => importBody({ ...values, template_key: 'product_list' }), follow: 'import' })],
  content: [update('/content-items/:id', contentFields), create('/content-items/:id/stage', '移動製作階段', 'Move production stage', [pick('to', '階段', 'Stage', ['accepted', 'drafting', 'design', 'awaiting_assets', 'internal_review', 'ready', 'archived']), note], { versioned: true }), create('/content-items/:id/variants', '新增內容變體', 'Create variant', [pick('platform', '社群平台', 'Platform', ['facebook', 'instagram', 'tiktok', 'youtube', 'x', 'threads', 'pinterest', 'linkedin']), pick('format', '格式', 'Format', ['image', 'carousel', 'reel', 'video', 'short', 'story', 'text']), text('locale', '內容語言', 'Content locale'), area('draft_text', '文案', 'Copy')], { body: ({ draft_text, ...values }) => ({ ...values, draft_doc: bodyDoc(draft_text) }), follow: 'variant' })],
  ideas: [create('/ideas/:id/convert', '轉為內容項目', 'Convert to content', [title])],
  targets: [create('/publish-targets/:id/precheck', '執行預檢', 'Run preflight', [pick('stage', '檢查階段', 'Check stage', ['preflight', 'schedule', 'approval', 'execution'], 'preflight')]), create('/publish-targets/:id/submit', '提交排期／審批', 'Submit schedule / approval', [], { versioned: true, confirm: true }), create('/publish-targets/:id/reschedule', '改期', 'Reschedule', [date('scheduled_at', '新時間（瀏覽器時區）', 'New time (browser time zone)')], { versioned: true }), create('/publish-targets/:id/approve', '核准', 'Approve', [note], { confirm: true, versioned: true }), create('/publish-targets/:id/request-changes', '要求修改', 'Request changes', [reason], { confirm: true, versioned: true }), create('/publish-targets/:id/reject', '退回', 'Reject', [reason], { confirm: true, versioned: true }), create('/publish-targets/:id/cancel', '取消發布', 'Cancel publishing', [reason], { confirm: true, versioned: true })],
  tasks: [create('/execution-tasks/:id/reconcile', '立即核實', 'Reconcile now', []), create('/execution-tasks/:id/handover', '轉人工', 'Hand over to manual', [reason, text('assignee', '接手人 ID', 'Assignee ID', true)], { body: values => ({ ...values, to_executor: 'manual' }), confirm: true }), create('/execution-tasks/:id/manual-complete', '回填人工發布', 'Record manual publication', [permalink, date('published_at', '實際發布時間', 'Actual publish time'), { key: 'evidence_file_ids', type: 'ids', label: ['證據檔案 ID（逗號分隔）', 'Evidence file IDs (comma separated)'], optional: true }], { body: values => ({ evidence_file_ids: [], ...values }), confirm: true }), create('/execution-tasks/:id/manual-abandon', '確認不發布', 'Abandon publication', [reason], { confirm: true }), create('/execution-tasks/:id/retry', '重試執行', 'Retry execution', [], { confirm: true })],
  conversations: [create('/conversations/:id/occupancy', '領取回覆處理權', 'Acquire reply lease', [], { body: () => ({ purpose: 'reply' }) }), create('/conversations/:id/read', '標記已讀', 'Mark as read', []), create('/conversations/:id/reply-drafts', '建立回覆草稿', 'Draft reply', [pick('reply_mode', '回覆方式', 'Reply mode', ['public_reply', 'private_reply', 'dm']), area('body_text', '回覆文字', 'Reply text')], { follow: 'reply' }), create('/conversations/:id/notes', '新增內部備註', 'Add internal note', [area('body', '備註內容', 'Note text')])],
  replies: [create('/reply-drafts/:id/submit-approval', '提交回覆審批', 'Submit reply for approval', [], { confirm: true }), create('/reply-drafts/:id/send', '送出回覆', 'Send reply', [text('fencing_token', '對話占用權杖', 'Conversation fencing token')], { confirm: true, body: values => { const token = Number(values.fencing_token); if (!Number.isSafeInteger(token) || token < 1) throw new Error('invalid_token'); return { fencing_token: token }; } })],
  reports: [create('/reports/:id/versions', '產生報告版本', 'Generate report version', [date('data_cutoff_at', '資料截止時間', 'Data cutoff', true)])],
  reportVersions: [create('/reports/:id/versions/:n/finalize', '定稿', 'Finalize', [], { confirm: true }), create('/reports/:id/versions/:n/export', '匯出報告', 'Export report', [pick('format', '檔案格式', 'File format', ['pdf', 'csv', 'xlsx'], 'pdf')])],
  reportVersionIds: [create('/report-versions/:id/finalize', '定稿', 'Finalize', [], { confirm: true })],
  backfills: [create('/backfills/:id/resume', '續跑未完成分片', 'Resume unfinished shards', [])],
  quality: [create('/data-quality/issues/:id', '處理品質問題', 'Disposition quality issue', [pick('status', '狀態', 'Status', ['resolved', 'accepted', 'open']), reason], { method: 'PATCH', versioned: true })],
  sources: [create('/data-sources/:id/refresh', '立即同步', 'Sync now', [])],
  imports: [create('/imports/:id', '更新欄位對應', 'Update field mapping', [{ key: 'mapping', type: 'json', label: ['欄位對應（JSON）', 'Field mapping (JSON)'] }], { method: 'PATCH', versioned: true }), create('/imports/:id/confirm', '確認合併', 'Confirm import', [], { confirm: true }), create('/imports/:id/cancel', '取消匯入', 'Cancel import', [], { confirm: true })],
};

export const generalImport = create('/imports', '建立匯入批次', 'Create import batch', [ref('template_key', '匯入模板', 'Import template', '/import-templates'), ...importInputs, ref('data_source_id', '資料源', 'Data source', '/data-sources', true)], { follow: 'import', body: importBody });

export function permitsAction(key: string, action: Action, record: RecordData, name: string) {
  const verb = action.path.split('/').at(-1)!;
  if (key === 'backfills' && verb === 'resume') return Number((record.progress as RecordData | undefined)?.failed) > 0;
  if (key === 'tasks' && verb === 'retry' && (record.status === 'outcome_unknown' || record.sub_status === 'outcome_unknown' || record.status === 'accepted' || record.sub_status === 'accepted')) return false;
  if (!Array.isArray(record.allowed_actions) || verb === 'precheck') return true;
  if (action.method === 'PATCH') return record.allowed_actions.some(value => value === 'edit' || value === 'update' || value === name);
  return record.allowed_actions.some(value => [verb, verb.replaceAll('-', '_'), name].includes(String(value)));
}
