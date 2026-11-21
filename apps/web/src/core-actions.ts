import type { Action, Field } from './catalog';
import { rowActions, text, type Action as WorkspaceAction } from './actions';

const executionPath = '/execution-tasks/:id';
export const executionWorkspaceActions: WorkspaceAction[] = [
  { path: `${executionPath}/manual-start`, label: ['開始人工發布', 'Start manual attempt', '开始人工发布'], confirm: true },
  ...rowActions.tasks.map(action => action.path.endsWith('/manual-abandon') ? {
    ...action, label: ['確認未曾提交', 'Confirm no submission', '确认未曾提交'],
    body: values => ({ ...values, confirmed_not_submitted: true }),
  } satisfies WorkspaceAction : action),
  { path: `${executionPath}/run-now`, label: ['立即執行', 'Run now', '立即运行'], confirm: true },
  { path: `${executionPath}/cancel`, label: ['取消任務', 'Cancel task', '取消任务'], confirm: true },
  { path: `${executionPath}/late-decision`, label: ['處理逾期', 'Resolve late task', '处理逾期'], confirm: true, fields: [
    { key: 'decision', label: ['處理方式', 'Decision', '处理方式'], type: 'select', options: ['skip', 'run_now', 'reschedule'] },
    { ...text('reason', ['原因', 'Reason'], true), type: 'textarea' },
  ] },
];

export const requestPostOperation: WorkspaceAction = {
  path: '/platform-posts/:id/operations', label: ['登記平台操作', 'Request post maintenance', '登记平台操作'], confirm: true,
  fields: [
    { key: 'kind', label: ['操作', 'Operation'], type: 'select', options: ['edit_caption', 'delete', 'hide', 'unschedule'] },
    { ...text('caption', ['預定文案', 'Requested caption', '预定文案'], true), type: 'textarea' },
    text('reason', ['原因', 'Reason']),
  ],
  body: ({ caption, ...values }) => ({ ...values, ...(values.kind === 'edit_caption' && { after_payload: { caption: caption ?? '' } }) }),
};
export function requestOfficialPostOperation(kinds: string[]): WorkspaceAction {
  return { ...requestPostOperation, label: ['透過官方 API 操作', 'Use official API', '透过官方 API 操作'],
    fields: requestPostOperation.fields?.map(field => field.key === 'kind' ? { ...field, options: kinds } : field),
    body: values => ({ ...requestPostOperation.body?.(values), executor: 'api' }),
  };
}
export const completePostOperation: WorkspaceAction = {
  path: '/post-operations/:id/manual-complete', label: ['回填操作結果', 'Record maintenance result', '回填操作结果'], confirm: true,
  fields: [
    { key: 'outcome', label: ['結果', 'Outcome', '结果'], type: 'select', options: ['completed', 'failed'] },
    { ...text('observed_caption', ['平台讀回文案（文案空白時留空）', 'Caption read from platform (leave blank for an empty caption)', '平台读回文案（文案空白时留空）'], true), type: 'textarea' },
    { key: 'evidence_file_ids', type: 'ids', label: ['證據檔案 ID（逗號分隔）', 'Evidence file IDs (comma separated)', '证据文件 ID（逗号分隔）'] },
  ],
  body: values => ({ ...values, observed_caption: values.observed_caption ?? '' }),
};

export const targetWorkspaceActions: WorkspaceAction[] = rowActions.targets.map(action => {
  const decision = /\/(approve|reject|request-changes)$/.test(action.path);
  if (!decision) return action;
  return { ...action, fields: [{ ...text('reason', ['審批理由', 'Decision reason', '审批理由'], action.path.endsWith('/approve')), type: 'textarea' }] };
});

type Label = readonly [string, string, string?];

const field = (name: string, label: Label, options: Omit<Field, 'name' | 'label'> = {}): Field => ({ name, label, ...options });
const select = (name: string, label: Label, choices: readonly string[], options: Pick<Field, 'default' | 'optional'> = {}) =>
  field(name, label, { type: 'select', choices, ...options });
const json = (name: string, label: Label, optional = false) => field(name, label, { type: 'json', shape: 'object', optional });
const array = (name: string, label: Label, optional = false) => field(name, label, { type: 'json', shape: 'array', optional });
const integer = (name: string, label: Label, min = 1, max?: number) => field(name, label, { type: 'number', integer: true, min, max });
const lines = (name: string, label: Label, optional = false) => field(name, label, { type: 'lines', optional });
const instant = (name: string, label: Label, optional = false) => field(name, label, { type: 'datetime-local', optional });
const optional = (value: Field): Field => ({ ...value, optional: true });
const form = (label: Label, fields: Field[] = [], options: Omit<Action, 'label' | 'fields'> = {}): Action => ({ label, fields, ...options });
const row = (label: Label, target: string, id: Field, fields: Field[] = [], confirm = false): Action =>
  form(label, [id, ...fields], { target, targetField: id.name, confirm });

const name = field('name', ['名稱', 'Name', '名称']);
const title = field('title', ['標題', 'Title', '标题']);
const description = field('description', ['描述', 'Description'], { type: 'textarea' });
const reason = field('reason', ['原因', 'Reason'], { type: 'textarea', seed: false });
const note = optional(field('note', ['備註', 'Note', '备注'], { type: 'textarea' }));
const expected = integer('expected_version', ['目前版本', 'Current version']);
const version = { ...expected, name: 'version' };
const limit = optional(integer('limit', ['筆數上限', 'Result limit', '笔数上限']));
const brand = field('brand_id', ['品牌', 'Brand'], { ref: ['workspace', 'brand'] });
const campaign = field('campaign_id', ['活動', 'Campaign', '活动'], { ref: ['campaign', 'campaign'] });
const store = field('store_id', ['店鋪', 'Store', '店铺'], { ref: ['commerce', 'store'] });
const product = field('product_id', ['商品', 'Product'], { ref: ['commerce', 'product'] });
const item = field('content_item_id', ['內容項目', 'Content item', '内容项目'], { ref: ['content', 'content_item'] });
const variant = field('variant_id', ['內容變體', 'Content variant', '内容变体'], { ref: ['content', 'content_variant'] });
const revision = field('revision_id', ['修訂 ID', 'Revision ID', '修订 ID']);
const account = field('social_account_id', ['社群帳號', 'Social account', '社交媒体账号'], { ref: ['account', 'social_account'] });
const owner = optional(field('owner_user_id', ['負責人 ID', 'Owner ID', '负责人 ID']));
const timezone = optional(field('timezone', ['時區（IANA）', 'Time zone (IANA)', '时区（IANA）']));
const from = instant('from', ['起始時間', 'From', '起始时间'], true);
const to = instant('to', ['結束時間', 'To', '结束时间'], true);

const workItem = field('id', ['工作項目 ID', 'Work item ID', '工作项目 ID']);
const campaignKinds = ['launch', 'seasonal', 'promotion', 'always_on', 'brand', 'other'];
const stages = ['accepted', 'drafting', 'design', 'awaiting_assets', 'internal_review', 'ready', 'archived'];
const contentFields = [title, owner, instant('production_due_at', ['製作期限', 'Production deadline', '制作期限'], true), optional(field('blocked_reason', ['阻塞原因', 'Blocker reason']))];
const baseRevision = field('base_revision_id', ['目前修訂 ID（首次使用 null）', 'Current revision ID (null for the first revision)', '目前修订 ID（首次使用 null）'], { shape: 'nullable-id', seed: 'current_revision_id', default: 'null' });
const draft = json('draft_doc', ['工作稿（JSON）', 'Working draft (JSON)'], true);
const accounts = lines('social_account_ids', ['社群帳號 ID（每行一筆）', 'Social account IDs (one per line)', '社交媒体账号 ID（每行一笔）'], true);

const target = field('target_id', ['發布目標', 'Publish target', '发布目标'], { ref: ['planning', 'publish_target'] });
const scheduleAt = instant('scheduled_at', ['發布時間（瀏覽器時區）', 'Publish time (browser time zone)', '发布时间（浏览器时区）']);
const scheduleZone = optional(field('schedule_tz', ['排期時區（IANA）', 'Schedule time zone (IANA)', '排期时区（IANA）']));
const targetOptions = json('options', ['發布選項（JSON）', 'Publish options (JSON)', '发布选项（JSON）'], true);
const route = select('route', ['發布管道', 'Publishing route', '发布管道'], ['manual', 'official']);
const visibility = field('visibility', ['可見性', 'Visibility', '可见性'], { default: 'public' });
const frozenHash = optional(field('frozen_hash', ['已凍結內容的雜湊', 'Frozen content hash', '已冻结内容的哈希']));
const planFilters = [from, to, optional(brand), optional(campaign), optional(account), optional(field('status', ['狀態', 'Status', '状态']))];
const task = field('task_id', ['執行任務', 'Execution task', '运行任务'], { ref: ['execution', 'execution_task'] });
const attempt = field('attempt_id', ['執行嘗試 ID', 'Execution attempt ID', '运行尝试 ID'], { seed: 'active_attempt_id' });
const fencingToken = integer('fencing_token', ['目前的租約權杖', 'Current lease token', '目前的租约令牌']);
const evidence = field('evidence', ['核實證據', 'Verification evidence', '核实证据'], { type: 'textarea', seed: false });
const confirmAbsent = field('confirm_no_pending_submission', ['確定沒有仍可能發布的提交', 'Confirm no pending submission can publish', '确定没有仍可能发布的提交'], { type: 'checkbox', seed: false });
const permalink = optional(field('permalink', ['公開貼文連結（已發布時必填）', 'Post URL (required if published)', '公开帖子链接（已发布时必填）'], { type: 'url' }));
const externalPost = optional(field('external_post_id', ['平台貼文 ID', 'External post ID', '平台帖子 ID']));
const verifiedOutcome: Action['validate'] = body => body.outcome === 'verified_absent'
  ? body.confirm_no_pending_submission === true ? undefined : 'confirm_no_pending_submission'
  : typeof body.permalink === 'string' && /^https?:\/\//i.test(body.permalink) ? undefined : 'permalink';
const reviewTarget = (label: Label, reviewReason: Field) => form(label, [target, expected, frozenHash, reviewReason], {
  target: 'publish_target', targetField: 'target_id', tab: 'approval_request', confirm: true,
});
const plan = field('plan_id', ['發布計畫 ID', 'Publish plan ID', '发布计划 ID']);
const planItems = { ...array('items', ['目標版本（JSON 陣列，每筆含 target_id 與 expected_version）', 'Target versions (JSON array with target_id and expected_version per item)', '目标版本（JSON 数组，每笔含 target_id 与 expected_version）']), seed: 'commit_items' };

const providers = ['file_import', 'shopify', 'tiktok_shop', 'amazon_sp', 'shopee'];
const template = select('template_key', ['匯入模板', 'Import template', '导入模板'], ['product_list', 'inventory_list', 'order_list', 'refund_list'], { default: 'product_list' });
const csv = field('csv', ['CSV 內容', 'CSV content', 'CSV 内容'], { type: 'csv' });
const importOptions = json('options', ['匯入選項（JSON，例如 timezone）', 'Import options (JSON, e.g. timezone)', '导入选项（JSON，例如 timezone）'], true);
const batch = field('batch_id', ['匯入批次 ID', 'Import batch ID', '导入批量 ID']);
const productDetails = [optional(field('handle', ['商品代稱', 'Product handle', '商品代称'])), optional(field('product_type', ['商品類型', 'Product type', '商品类型'])), optional(field('vendor', ['供應商', 'Vendor', '供应商']))];

const conversation = field('conversation_id', ['對話 ID', 'Conversation ID', '对话 ID']);
const message = field('message_id', ['訊息 ID', 'Message ID', '消息 ID']);
const replyDraft = field('reply_draft_id', ['回覆草稿 ID', 'Reply draft ID', '回复草稿 ID']);
const outboundReply = field('outbound_reply_id', ['回覆意圖 ID', 'Outbound reply intent ID', '回复意图 ID']);
const replyBody = field('body_text', ['回覆內容', 'Reply text', '回复内容'], { type: 'textarea' });
const priorities = ['low', 'normal', 'high', 'urgent'];
const inboxStatus = ['open', 'waiting_customer', 'snoozed', 'resolved'];

const source = field('data_source_id', ['資料來源', 'Data source', '数据源'], { ref: ['ingest', 'data_source'] });
const syncRun = field('sync_run_id', ['同步紀錄', 'Sync run', '同步记录'], { ref: ['ingest', 'sync_run'] });
const dataGap = field('data_gap_id', ['資料缺口 ID', 'Data gap ID', '数据缺口 ID']);
const qualityIssue = field('quality_issue_id', ['品質問題', 'Quality issue', '品质问题'], { ref: ['ingest', 'quality_issue'] });
const requiredWindow = [{ ...from, optional: false, seed: 'window_start' }, { ...to, optional: false, seed: 'window_end' }];
const windowProblem: Action['validate'] = body => {
  if (body.from !== undefined && body.to === undefined) return 'to';
  if (body.to !== undefined && (typeof body.from !== 'string' || typeof body.to !== 'string' || body.from >= body.to)) return 'from';
};
const resources = ['account_metrics', 'post_metrics', 'video_metrics', 'note_metrics', 'ad_metrics'];
const resource = select('resource', ['資料類型', 'Resource type', '数据类型'], resources);
const metricKeys = lines('metrics', ['指標鍵（每行一筆）', 'Metric keys (one per line)', '指标键（每行一笔）']);
const metricTime = json('time', ['時間範圍（JSON，含 from、to、tz）', 'Time range (JSON with from, to, tz)', '时间范围（JSON，含 from、to、tz）']);
const cutoff = instant('data_cutoff_at', ['資料截止時間', 'Data cutoff', '数据截止时间'], true);
const report = field('report_id', ['報告', 'Report', '报告'], { ref: ['analytics', 'report'] });
const reportVersion = field('version_id', ['報告版本 ID', 'Report version ID', '报告版本 ID']);
const reportFields = [title, select('kind', ['報告類型', 'Report type', '报告类型'], ['social_performance', 'campaign', 'client_monthly', 'custom', 'ecommerce']),
  json('period', ['報告期間（JSON，含 from、to、tz）', 'Report period (JSON with from, to, tz)', '报告期间（JSON，含 from、to、tz）']),
  json('scope', ['報告範圍（JSON，例如 brand_ids、campaign_ids）', 'Report scope (JSON, e.g. brand_ids, campaign_ids)', '报告范围（JSON，例如 brand_ids、campaign_ids）'], true),
  { ...array('sections', ['報告區段（JSON 陣列，每筆含 key、type、query）', 'Report sections (JSON array with key, type, and query per entry)', '报告区段（JSON 数组，每笔含 key、type、query）']), seed: 'section_inputs' }];
const attributionPeriod = json('period', ['交易期間（JSON，含 from、to、tz）', 'Transaction period (JSON with from, to, tz)', '交易期间（JSON，含 from、to、tz）']);
const attributionModels = { ...lines('model_keys', ['模型（每行一筆）', 'Models (one per line)', '模型（每行一笔）']), default: 'link_session\ndiscount_code\nplatform_reported' };
const storeIds = lines('store_ids', ['店鋪 ID（每行一筆）', 'Store IDs (one per line)', '店铺 ID（每行一笔）'], true);
const teamAssignee = optional(field('assigneeId', ['指派成員 ID', 'Assignee ID', '指派成员 ID']));
const teamTask = field('id', ['團隊任務 ID', 'Team task ID', '团队任务 ID']);
const teamDelivery = field('id', ['交付計畫 ID', 'Delivery ID', '交付计划 ID']);
const deliveryId = { ...teamDelivery, name: 'deliveryId' };

export const coreActions: Record<string, Action> = {
  'workspace.get_workspace': form(['查看工作區設定', 'Get workspace settings', '查看工作区设置']),
  'workspace.update_workspace': form(['編輯工作區設定', 'Edit workspace settings', '编辑工作区设置'], [optional(expected), optional(name), optional(field('default_timezone', ['預設時區（IANA）', 'Default time zone (IANA)', '预设时区（IANA）'])), optional(field('reporting_currency', ['報告幣別', 'Reporting currency', '报告币别']))], { tab: 'settings' }),
  'workspace.create_brand': form(['新增品牌', 'Create brand', '添加品牌'], [name, field('slug', ['品牌代稱', 'Brand slug', '品牌代称'])], { tab: 'brand' }),
  'workspace.list_brands': form(['查詢品牌', 'List brands', '查找品牌'], [select('status', ['狀態', 'Status', '状态'], ['active', 'archived'], { optional: true })]),
  'workspace.update_brand': row(['編輯品牌', 'Edit brand', '编辑品牌'], 'brand', { ...brand, name: 'id' }, [expected, optional(name), optional(field('slug', ['品牌代稱', 'Brand slug', '品牌代称'])), optional(field('default_market_id', ['預設市場 ID', 'Default market ID', '预设市场 ID']))]),
  'workspace.create_market': form(['新增市場', 'Create market', '添加市场'], [brand, name, field('country_code', ['國家代碼', 'Country code', '国家代码']), field('primary_language', ['主要語言', 'Primary language', '主要语言']), field('currency', ['幣別', 'Currency', '币别']), { ...timezone, optional: false }, lines('languages', ['其他語言（每行一筆）', 'Additional languages (one per line)', '其他语言（每行一笔）'], true)], { tab: 'market' }),
  'workspace.list_markets': form(['查詢市場', 'List markets', '查找市场'], [optional(brand)]),
  'workspace.overview_today': form(['查看今日工作', 'View today’s work'], [optional(brand)]),
  'workspace.overview_summary': form(['查看工作區摘要', 'View workspace summary', '查看工作区摘要'], [optional(brand)]),
  'workspace.list_work_items': form(['查詢工作項目', 'List work items', '查找工作项目'], [optional(brand), limit]),
  'workspace.get_work_item': row(['查看工作項目', 'Get work item', '查看工作项目'], 'work_item', workItem),
  'workspace.create_work_item': form(['新增工作項目', 'Create work item', '添加工作项目'], [title, optional(brand), instant('due_at', ['到期時間', 'Due at', '到期时间'], true)], { tab: 'work_item' }),
  'workspace.complete_work_item': row(['完成工作項目', 'Complete work item', '完成工作项目'], 'work_item', workItem, [expected], true),
  'workspace.reopen_work_item': row(['重新開啟工作項目', 'Reopen work item', '重新打开工作项目'], 'work_item', workItem, [expected]),
  'workspace.list_notifications': form(['查看通知', 'List notifications'], [limit]),

  'campaign.create_draft': form(['新增活動草稿', 'Create campaign draft', '添加活动草稿'], [brand, name, select('kind', ['活動類型', 'Campaign type', '活动类型'], campaignKinds, { default: 'launch' }), instant('starts_at', ['開始時間', 'Starts at', '开始时间'], true), instant('ends_at', ['結束時間', 'Ends at', '结束时间'], true), timezone, owner, optional(field('objective_summary', ['活動目標', 'Objective', '活动目标'], { type: 'textarea' })), optional(field('utm_key', ['活動追蹤鍵', 'Campaign tracking key', '活动追踪键']))], { tab: 'campaign' }),
  'campaign.list': form(['查詢活動', 'List campaigns', '查找活动'], [optional(brand), select('status', ['狀態', 'Status', '状态'], ['draft', 'planned', 'active', 'paused', 'wrapping', 'closed', 'cancelled'], { optional: true }), instant('active_on', ['活動時間', 'Active at', '活动时间'], true)]),
  'campaign.get_context': row(['查看活動和關聯資料', 'Get campaign context', '查看活动和关联数据'], 'campaign', campaign),
  'campaign.update': row(['編輯活動', 'Edit campaign', '编辑活动'], 'campaign', campaign, [expected, json('patch', ['變更欄位（JSON）', 'Changed fields (JSON)', '变更字段（JSON）'])]),
  'campaign.transition': row(['變更活動狀態', 'Change campaign status', '变更活动状态'], 'campaign', campaign, [expected, select('to', ['新狀態', 'New status', '新状态'], ['planned', 'active', 'paused', 'wrapping', 'cancelled']), optional(reason)], true),
  'campaign.set_markets': row(['設定活動市場', 'Set campaign markets', '设置活动市场'], 'campaign', campaign, [expected, array('markets', ['市場明細（JSON 陣列）', 'Markets (JSON array)', '市场明细（JSON 数组）'])], true),
  'campaign.set_products': row(['設定活動商品', 'Set campaign products', '设置活动商品'], 'campaign', campaign, [expected, array('products', ['商品明細（JSON 陣列）', 'Products (JSON array)', '商品明细（JSON 数组）'])], true),
  'campaign.list_goals': row(['查看活動目標', 'List campaign goals', '查看活动目标'], 'campaign', campaign),
  'campaign.create_goal': row(['新增活動目標', 'Create campaign goal', '添加活动目标'], 'campaign', campaign, [field('metric_key', ['指標鍵', 'Metric key', '指标键']), select('unit', ['單位', 'Unit', '单位'], ['count', 'currency', 'percent', 'seconds']), optional(field('currency', ['幣別（貨幣指標必填）', 'Currency (required for currency metrics)', '币别（货币指标必填）'])), field('baseline_value', ['基準值', 'Baseline value', '基准值'], { type: 'number' }), field('target_value', ['目標值', 'Target value', '目标值'], { type: 'number' }), instant('due_at', ['到期時間', 'Due at', '到期时间'])]),

  'content.content_create_item': form(['新增內容', 'Create content', '添加内容'], [brand, optional(campaign), ...contentFields], { tab: 'content_item' }),
  'content.content_list': form(['查詢內容', 'List content', '查找内容'], [optional(brand), optional(campaign), select('production_stage', ['製作階段', 'Production stage', '制作阶段'], stages, { optional: true }), owner]),
  'content.content_get': row(['查看內容和變體', 'Get content and variants', '查看内容和变体'], 'content_item', item),
  'content.content_update_item': row(['編輯內容', 'Edit content', '编辑内容'], 'content_item', item, [expected, ...contentFields.map(optional)]),
  'content.content_set_stage': row(['變更製作階段', 'Change production stage', '变更制作阶段'], 'content_item', item, [expected, select('to', ['新階段', 'New stage', '新阶段'], stages), note], true),
  'content.content_create_variant': row(['新增內容變體', 'Create content variant', '添加内容变体'], 'content_item', item, [select('platform', ['社群平台', 'Platform', '社交媒体平台'], ['instagram', 'facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu', 'generic']), select('format', ['內容格式', 'Content format', '内容格式'], ['feed_image', 'carousel', 'reel', 'story', 'short_video', 'long_video', 'text', 'note', 'live_teaser']), field('locale', ['內容語言', 'Content locale', '内容语言']), optional(account), draft]),
  'content.content_duplicate': row(['複用為新草稿', 'Reuse as new draft', '复用为新草稿'], 'content_item', item, [optional(title)]),
  'content.content_get_variant': row(['查看內容變體', 'Get content variant', '查看内容变体'], 'content_variant', variant),
  'content.content_autosave_variant': row(['更新工作稿', 'Save working draft'], 'content_variant', variant, [expected, { ...baseRevision, optional: true, default: undefined }, { ...draft, optional: false }]),
  'content.content_commit_revision': row(['提交內容修訂', 'Commit content revision', '提交内容修订'], 'content_variant', variant, [expected, baseRevision, draft]),
  'content.content_create_translation': row(['新增譯文', 'Create translation', '添加译文'], 'content_variant', { ...variant, name: 'source_variant_id' }, [
    optional(field('source_revision_id', ['來源修訂 ID', 'Source revision ID', '来源修订 ID'])), field('locale', ['語言', 'Locale', '语言']), optional(field('market_id', ['市場 ID', 'Market ID', '市场 ID'])),
    field('body', ['譯文', 'Localized copy', '译文'], { type: 'textarea' }),
  ]),
  'content.content_accept_source_change': row(['確認已審閱來源', 'Accept reviewed source', '确认已审阅来源'], 'translation_link', field('translation_link_id', ['翻譯連結 ID', 'Translation link ID', '翻译链接 ID']), [expected, field('source_revision_id', ['來源修訂 ID', 'Source revision ID', '来源修订 ID']), optional(field('glossary_version', ['術語版本', 'Glossary version', '术语版本']))]),
  'content.content_mark_divergence': row(['保留市場改寫', 'Keep market rewrite', '保留市场改写'], 'translation_link', field('translation_link_id', ['翻譯連結 ID', 'Translation link ID', '翻译链接 ID']), [expected, field('source_revision_id', ['來源修訂 ID', 'Source revision ID', '来源修订 ID']), optional(field('glossary_version', ['術語版本', 'Glossary version', '术语版本'])), { ...note, optional: false }]),
  'content.content_request_rendition': row(['請求尺寸衍生檔', 'Request resized rendition', '请求尺寸衍生档'], 'content_variant', variant, [expected,
    field('media_index', ['素材索引（從 0 開始）', 'Media index (starts at 0)', '素材索引（从 0 开始）'], { type: 'number', min: 0, integer: true, default: '0' }),
    select('kind', ['衍生檔類型', 'Rendition type', '衍生档类型'], ['platform_resize'], { default: 'platform_resize' }),
    json('params', ['尺寸參數（JSON）', 'Size parameters (JSON)', '尺寸参数（JSON）']),
  ]),
  'content.content_list_revisions': row(['列出內容修訂', 'List content revisions', '列出内容修订'], 'content_variant', variant),
  'content.content_get_revision': row(['查看內容修訂', 'Get content revision', '查看内容修订'], 'content_revision', revision),
  'content.content_diff_revisions': row(['比較修訂', 'Compare revisions', '比较修订'], 'content_revision', { ...revision, name: 'revision_a' }, [field('revision_b', ['比較修訂 ID', 'Revision ID to compare', '比较修订 ID'])]),
  'content.content_restore_revision': form(['復原舊修訂為新版本', 'Restore an earlier revision as a new version', '复原旧修订为新版本'], [
    { ...revision, seed: false }, expected, baseRevision,
  ], { target: 'content_variant', confirm: true }),
  'content.content_list_translations': row(['查看翻譯與來源差異', 'List translations and source changes', '查看翻译与来源差异'], 'content_variant', variant),
  'content.content_get_transcript': row(['查看逐字稿', 'Get transcript'], 'transcript', field('transcript_id', ['逐字稿 ID', 'Transcript ID'])),
  'content.content_review_transcript': row(['審閱或更正逐字稿', 'Review or correct transcript', '审阅或更正逐字稿'], 'transcript', field('transcript_id', ['逐字稿 ID', 'Transcript ID']), [
    expected, array('segments', ['逐字稿片段（JSON 陣列，含 start_ms、end_ms、text）', 'Transcript segments (JSON array with start_ms, end_ms, text)', '逐字稿片段（JSON 数组，含 start_ms、end_ms、text）'], true),
  ], true),
  'content.content_list_stale': form(['查看需重新審閱的內容變體', 'List stale content variants', '查看需重新审阅的内容变体'], [optional(campaign), lines('reason', ['原因代碼（每行一筆）', 'Reason codes (one per line)', '原因代码（每行一笔）'], true)]),
  'content.content_validate_variant': row(['驗證內容變體', 'Validate content variant', '验证内容变体'], 'content_variant', variant, [optional(revision), accounts, { ...scheduleAt, optional: true }]),
  'content.content_set_readiness': row(['標記內容為可排期', 'Mark content ready', '标记内容为可排期'], 'content_variant', variant, [expected, accounts, field('confirm_stale', ['已處理過期問題', 'Stale issues resolved', '已处理过期问题'], { type: 'checkbox' }), field('confirm_reuse_review', ['已審閱複用的商品內容', 'Reused product copy reviewed', '已审阅复用的商品内容'], { type: 'checkbox' })], true),
  'content.idea_create': form(['新增選題', 'Create idea', '添加选题'], [brand, title, optional(campaign), array('origin_refs', ['證據來源（JSON 陣列，每筆含 type 與 id 或 url）', 'Evidence (JSON array with type and id or url per entry)', '证据来源（JSON 数组，每笔含 type 与 id 或 url）']), lines('tags', ['標籤（每行一筆）', 'Tags (one per line)', '标签（每行一笔）'], true)], { tab: 'idea' }),
  'content.idea_get': row(['查看選題', 'Get idea', '查看选题'], 'idea', field('idea_id', ['選題 ID', 'Idea ID', '选题 ID'])),
  'content.idea_list': form(['查詢選題', 'List ideas', '查找选题'], [optional(brand), optional(campaign), optional(field('tag', ['標籤', 'Tag', '标签']))]),
  'content.idea_convert': row(['轉為內容項目', 'Convert to content', '转为内容项目'], 'idea', field('idea_id', ['選題 ID', 'Idea ID', '选题 ID']), [optional(title)]),

  'planning.create_plan': form(['新增發布計畫', 'Create publishing plan', '添加发布计划'], [name], { tab: 'publish_target' }),
  'planning.preview_plan': row(['預覽發布計畫', 'Preview publishing plan', '预览发布计划'], 'publish_plan', plan),
  'planning.commit_plan': { ...row(['提交計畫審批', 'Submit plan for approval', '提交计划审批'], 'publish_plan', plan, [expected, planItems], true), validate: body => {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50 || body.items.some(item =>
      !item || typeof item !== 'object' || Object.keys(item).length !== 2 || typeof item.target_id !== 'string' || !item.target_id.trim() || !Number.isSafeInteger(item.expected_version) || item.expected_version < 1)) return 'items';
  } },
  'planning.create_target': form(['建立發布目標', 'Create publish target', '创建发布目标'], [account, { ...variant, name: 'content_variant_id' }, optional(revision), optional(plan), route, visibility, scheduleAt, scheduleZone, targetOptions], { tab: 'publish_target' }),
  'planning.list_targets': form(['查詢發布目標', 'List publish targets', '查找发布目标'], planFilters),
  'planning.get_target': row(['查看發布目標', 'Get publish target', '查看发布目标'], 'publish_target', target),
  'planning.calendar': form(['查詢發布日曆', 'View publishing calendar', '查找发布日历'], [select('view', ['檢視', 'View', '查看'], ['day', 'week', 'month', 'list'], { default: 'week' }), ...planFilters]),
  'planning.precheck': row(['執行發布預檢', 'Run publishing precheck', '运行发布预检'], 'publish_target', target, [select('stage', ['檢查階段', 'Check stage', '检查阶段'], ['schedule', 'approval', 'preflight', 'execution'], { default: 'schedule' })]),
  'planning.submit': row(['提交發布審批', 'Submit for publishing approval', '提交发布审批'], 'publish_target', target, [expected], true),
  'planning.approve': reviewTarget(['核准發布目標', 'Approve publish target', '核准发布目标'], optional(reason)),
  'planning.reject': reviewTarget(['退回發布目標', 'Reject publish target', '退回发布目标'], reason),
  'planning.request_changes': reviewTarget(['要求修改發布目標', 'Request publishing changes', '要求修改发布目标'], reason),
  'planning.list_approvals': form(['查看待審批項目', 'List pending approvals', '查看待审批项目'], [], { tab: 'approval_request' }),
  'planning.reschedule': row(['變更發布時間', 'Reschedule publication', '变更发布时间'], 'publish_target', target, [expected, scheduleAt, scheduleZone], true),
  'planning.change_target': row(['編輯發布目標', 'Edit publish target', '编辑发布目标'], 'publish_target', target, [expected,
    ...[optional({ ...account, name: 'account_id' }), optional({ ...variant, name: 'content_variant_id' }), optional({ ...revision, shape: 'nullable-id' }), optional(route), optional({ ...visibility, default: undefined }), targetOptions].map(field => ({ ...field, seed: false as const })),
  ], true),
  'planning.set_publishing_profile': form(['設定發布帳號能力', 'Set publishing account capabilities', '设置发布账号能力'], [
    { ...account, name: 'account_id' }, optional(expected), optional(field('platform', ['平台代碼', 'Platform key', '平台代码'])), timezone,
    field('active', ['啟用設定檔', 'Enable profile', '激活设置档'], { type: 'checkbox', default: 'true' }),
    field('manual_capability', ['允許人工發布', 'Allow manual publishing', '允许人工发布'], { type: 'checkbox', default: 'true' }),
    field('official_capability', ['啟用官方 API 發布', 'Enable official API publishing', '激活官方 API 发布'], { type: 'checkbox' }),
    optional(field('adapter_key', ['轉接器識別碼', 'Adapter key', '转接器识别码'])), optional(integer('quota_limit', ['發布配額', 'Publishing quota', '发布配额'])),
    lines('formats', ['允許的格式（每行一筆）', 'Allowed formats (one per line)', '允许的格式（每行一笔）'], true),
    lines('markets', ['允許的市場（每行一筆）', 'Allowed markets (one per line)', '允许的市场（每行一笔）'], true),
    lines('visibilities', ['允許的可見性（每行一筆）', 'Allowed visibility settings (one per line)', '允许的可见性（每行一笔）'], true),
    optional(field('account_identity', ['平台帳號識別碼', 'Platform account identity', '平台账号识别码'])),
    instant('connection_expires_at', ['連線到期時間', 'Connection expiration', '连接到期时间'], true),
  ], { confirm: true, target: 'publishing_profile', targetField: 'account_id', validate: body => {
    if (body.official_capability === true && !body.adapter_key) return 'adapter_key';
    if (body.official_capability === true && !body.quota_limit) return 'quota_limit';
  } }),
  'planning.set_approval_policy': form(['設定審批政策', 'Set approval policy', '设置审批政策'], [optional(expected), optional(field('approver_id', ['審批人 ID', 'Approver ID', '审批人 ID'])), optional(integer('reschedule_tolerance_minutes', ['改期容許分鐘數', 'Reschedule tolerance in minutes', '改期容许分钟数'], 0, 60))], { confirm: true }),
  'planning.pause': form(['暫停發布', 'Pause publishing', '暂停发布'], [select('scope', ['暫停範圍', 'Pause scope', '暂停范围'], ['workspace', 'campaign', 'account', 'brand'], { default: 'workspace' }), optional(field('scope_id', ['範圍 ID（工作區留空）', 'Scope ID (blank for workspace)', '范围 ID（工作区留空）'])), reason], {
    confirm: true, validate: body => (body.scope === 'workspace') === Boolean(body.scope_id) ? 'scope_id' : undefined,
  }),
  'planning.release_pause': form(['預檢或解除發布暫停', 'Preview or release publishing pause', '预检或解除发布暂停'], [field('pause_id', ['暫停開關 ID', 'Pause switch ID', '暂停开关 ID']), optional(expected), field('dry_run', ['僅預檢', 'Preview only', '仅预检'], { type: 'checkbox', default: 'true' })], {
    confirm: true, validate: body => !body.dry_run && body.expected_version === undefined ? 'expected_version' : undefined,
  }),
  'planning.cancel': row(['取消發布', 'Cancel publication', '取消发布'], 'publish_target', target, [expected, reason], true),

  'execution.enqueue': form(['將發布目標加入執行佇列', 'Enqueue publish target', '将发布目标加入运行队列'], [target, select('late_policy', ['逾期處理', 'Late policy', '逾期处理'], ['grace_window', 'notify', 'skip'], { optional: true }), optional(integer('grace_seconds', ['寬限秒數', 'Grace period in seconds', '宽限秒数'], 0, 86_400))], { tab: 'execution_task', target: 'publish_target', targetModule: 'planning', targetField: 'target_id', confirm: true }),
  'execution.get_task': row(['查看執行任務與嘗試', 'Get execution task and attempts', '查看运行任务与尝试'], 'execution_task', task),
  'execution.preflight': form(['檢查是否可以執行', 'Run execution preflight', '检查是否可以运行'], [target], { target: 'publish_target', targetModule: 'planning', targetField: 'target_id' }),
  'execution.begin_manual': row(['開始人工發布', 'Begin manual publishing', '开始人工发布'], 'execution_task', task, [], true),
  'execution.list_tasks': form(['列出執行任務', 'List execution tasks', '列出运行任务'], [optional(target), optional(field('status', ['狀態', 'Status', '状态'])), optional({ ...limit, max: 200 }), optional(integer('offset', ['跳過筆數', 'Offset', '跳过笔数'], 0))]),
  'execution.reconcile_manual': { ...row(['核實人工發布結果', 'Verify manual publishing outcome', '核实人工发布结果'], 'execution_task', task, [attempt, fencingToken, select('outcome', ['核實結果', 'Verified outcome', '核实结果'], ['published', 'verified_absent']), evidence, permalink, externalPost, confirmAbsent], true), validate: verifiedOutcome },
  'execution.report_manual_unknown': row(['登記人工發布結果不明', 'Record unknown manual outcome', '登记人工发布结果不明'], 'execution_task', task, [attempt, fencingToken, evidence], true),
  'execution.recover_lease': row(['復原過期執行租約', 'Recover expired execution lease', '复原过期运行租约'], 'execution_task', task, [], true),
  'execution.allow_late': row(['允許逾期執行', 'Allow late execution', '允许逾期运行'], 'execution_task', task, [reason, integer('extension_seconds', ['延長秒數', 'Extension in seconds', '延长秒数'], 1, 3600)], true),
  'execution.start_restore_hold': form(['開始還原檢查暫停', 'Start restore hold', '开始还原检查暂停'], [reason], { confirm: true }),
  'execution.list_recovery': form(['列出還原檢查', 'List restore checks', '列出还原检查'], [select('status', ['檢查狀態', 'Check status', '检查状态'], ['pending', 'resolved', 'all'], { default: 'pending' })]),
  'execution.record_recovery': form(['記錄還原檢查結果', 'Record restore check outcome', '记录还原检查结果'], [field('check_id', ['還原檢查 ID', 'Restore check ID', '还原检查 ID']), select('outcome', ['核實結果', 'Verified outcome', '核实结果'], ['verified_absent', 'already_published']), evidence, optional({ ...permalink, label: ['公開貼文連結（若任務尚未核實發布）', 'Post URL (if the task is not already verified published)', '公开帖子链接（若任务尚未核实发布）'] }), externalPost, confirmAbsent], {
    confirm: true, validate: body => body.outcome === 'verified_absent' ? verifiedOutcome(body) : body.permalink && !/^https?:\/\//i.test(String(body.permalink)) ? 'permalink' : undefined,
  }),
  'execution.release_restore_hold': form(['解除還原檢查暫停', 'Release restore hold', '解除还原检查暂停'], [reason], { confirm: true }),
  'execution.cancel': row(['取消執行任務', 'Cancel execution task', '取消运行任务'], 'execution_task', task, [reason], true),
  'execution.handover_manual': row(['轉交人工發布', 'Hand over to manual publishing', '转交人工发布'], 'execution_task', task, [field('assignee_id', ['接手人 ID', 'Assignee ID']), reason], true),

  'commerce.create_store': form(['新增匯入店鋪', 'Create import store', '添加导入店铺'], [name, select('provider', ['店鋪平台', 'Store provider', '店铺平台'], providers, { default: 'file_import' }), optional(brand), field('default_currency', ['預設幣別', 'Default currency', '预设币别']), field('default_locale', ['預設語言', 'Default locale', '预设语言']), optional(field('external_store_id', ['平台店鋪 ID', 'External store ID', '平台店铺 ID'])), optional(field('region', ['地區', 'Region', '地区']))], { tab: 'store' }),
  'commerce.create_product': form(['新增商品', 'Create product', '添加商品'], [store, title, ...productDetails], { tab: 'product' }),
  'commerce.update_product': row(['編輯商品', 'Edit product', '编辑商品'], 'product', product, [expected, optional(title), ...productDetails, select('status', ['狀態', 'Status', '状态'], ['draft', 'active', 'archived'], { optional: true })]),
  'commerce.catalog_search': form(['搜尋商品目錄', 'Search product catalog', '搜索商品目录'], [optional(field('query', ['名稱、代稱或 SKU', 'Title, handle, or SKU', '名称、代称或 SKU'])), optional(store), optional(brand), limit]),
  'commerce.catalog_get_product': row(['查看商品明細', 'Get product details', '查看商品明细'], 'product', product),
  'commerce.import_template': form(['查看 CSV 模板', 'Get CSV template'], [select('provider', ['店鋪平台', 'Store provider', '店铺平台'], providers, { default: 'file_import' }), template], { tab: 'import_batch' }),
  'commerce.preview_import': form(['預覽 CSV 匯入', 'Preview CSV import', '预览 CSV 导入'], [store, template, csv, importOptions], { tab: 'import_batch' }),
  'commerce.import_error_file': row(['下載匯入錯誤明細', 'Download import errors', '下载导入错误明细'], 'import_batch', batch),
  'commerce.preflight_import': row(['重新檢查匯入預覽', 'Recheck import preview', '重新检查导入预览'], 'import_batch', batch, [{ ...expected, optional: true, seed: false }]),
  'commerce.commit_import': row(['確認並匯入', 'Commit import', '确认并导入'], 'import_batch', batch, [expected], true),
  'commerce.rollback_import': row(['回復已提交的匯入', 'Roll back import', '回复已提交的导入'], 'import_batch', batch, [expected], true),

  'inbox.ingest_message': form(['匯入一則訊息', 'Import a message', '导入一则消息'], [brand, { ...account, name: 'social_account_id' },
    field('provider', ['平台供應者', 'Platform provider', '平台供应者']), select('kind', ['對話類型', 'Conversation type', '对话类型'], ['comment_thread', 'private_thread', 'mention', 'ad_comment', 'review']),
    field('external_message_id', ['平台訊息 ID', 'Platform message ID', '平台消息 ID']), optional(field('external_thread_id', ['平台對話 ID', 'Platform thread ID', '平台对话 ID'])),
    instant('platform_created_at', ['平台發布時間', 'Platform timestamp', '平台发布时间']), replyBody], { tab: 'conversation' }),
  'inbox.list': form(['查詢收件箱', 'List inbox conversations', '查找收件箱'], [select('view', ['收件箱檢視', 'Inbox view', '收件箱查看'], ['all', 'unassigned', 'mine', 'open', 'waiting', 'snoozed', 'resolved'], { default: 'all' }), optional(brand), optional(account), select('priority', ['優先順序', 'Priority', '优先级'], priorities, { optional: true }), limit]),
  'inbox.get_conversation': row(['查看對話完整紀錄', 'Get conversation details', '查看对话完整记录'], 'conversation', conversation),
  'inbox.update_conversation': row(['更新對話', 'Update conversation', '更新对话'], 'conversation', conversation, [expected, select('status', ['狀態', 'Status', '状态'], inboxStatus, { optional: true }), select('priority', ['優先順序', 'Priority', '优先级'], priorities, { optional: true }), optional(field('assignee_user_id', ['指派成員 ID', 'Assignee ID', '指派成员 ID'])), instant('snooze_until', ['暫緩至', 'Snooze until', '暂缓至'], true), array('tag_ids', ['標籤 ID（JSON 陣列）', 'Tag IDs (JSON array)', '标签 ID（JSON 数组）'], true)]),
  'inbox.mark_read': row(['標記已讀至這則訊息', 'Mark read through message', '标记已读至这则消息'], 'conversation', conversation, [message]),
  'inbox.claim': row(['取得對話租約', 'Claim conversation', '取得对话租约'], 'conversation', conversation, [select('purpose', ['用途', 'Purpose'], ['reply', 'review', 'moderate'], { default: 'reply' })]),
  'inbox.release': row(['釋放或轉交對話租約', 'Release or hand over conversation lease', '释放或转交对话租约'], 'conversation', conversation, [fencingToken, optional(field('handover_to_user_id', ['接手人 ID', 'Handover recipient ID']))], true),
  'inbox.add_note': row(['新增內部備註', 'Add internal note', '添加内部备注'], 'conversation', conversation, [field('body', ['備註內容', 'Note text', '备注内容'], { type: 'textarea' }), optional({ ...message, name: 'anchor_message_id' }), lines('mentions', ['提及成員 ID（每行一筆）', 'Mentioned user IDs (one per line)', '提及成员 ID（每行一笔）'], true)]),
  'inbox.draft_reply': row(['建立回覆草稿', 'Draft reply', '创建回复草稿'], 'conversation', conversation, [replyBody, select('reply_mode', ['回覆方式', 'Reply mode', '回复方式'], ['public_reply', 'private_reply', 'dm'], { optional: true }), optional({ ...message, name: 'in_reply_to_message_id' }), lines('fact_refs', ['事實引用（每行一筆）', 'Fact references (one per line)', '事实引用（每行一笔）'], true)]),
  'inbox.update_reply_draft': form(['編輯回覆草稿', 'Edit reply draft', '编辑回复草稿'], [replyDraft, expected, replyBody]),
  'inbox.submit_reply_approval': form(['提交回覆審批', 'Submit reply for approval', '提交回复审批'], [replyDraft, expected], { confirm: true }),
  'inbox.approve_reply': form(['核准回覆', 'Approve reply', '核准回复'], [replyDraft, expected], { confirm: true }),
  'inbox.send_reply': form(['提交回覆', 'Submit reply', '提交回复'], [replyDraft, expected, fencingToken, field('idempotency_key', ['回覆識別鍵（重送請沿用）', 'Unique reply key (reuse on retry)', '回复识别键（重送请沿用）']), select('mode', ['送出方式', 'Delivery mode'], ['manual', 'api'], { default: 'manual' })], { confirm: true }),
  'inbox.get_reply_status': form(['查閱回覆狀態', 'Get reply status', '查阅回复状态'], [outboundReply]),
  'inbox.reconcile_reply': form(['核實回覆結果', 'Reconcile reply', '核实回复结果'], [outboundReply]),
  'inbox.manual_complete_reply': form(['登記人工回覆完成', 'Record manual reply completion', '登记人工回复完成'], [outboundReply, expected, fencingToken, optional(field('platform_url', ['平台連結', 'Platform URL', '平台链接'], { type: 'url' })), lines('evidence_ids', ['證據 ID（未填平台連結時必填，每行一筆）', 'Evidence IDs (one per line, required without a platform URL)', '证据 ID（未填平台链接时必填，每行一笔）'], true)], { confirm: true }),
  'inbox.retry_reply': form(['重試已確認未送達的回覆', 'Retry confirmed non-delivery', '重试已确认未送达的回复'], [outboundReply, expected, fencingToken], { confirm: true }),
  'inbox.cancel_reply': form(['取消回覆意圖', 'Cancel reply intent', '取消回复意图'], [outboundReply, expected], { confirm: true }),

  'ingest.create_source': form(['新增資料來源', 'Create data source', '添加数据源'], [name, select('provider', ['來源平台', 'Provider', '来源平台'], ['file_import', 'meta_instagram', 'meta_facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu']), select('kind', ['來源類型', 'Source type', '来源类型'], ['file_import', 'platform_account']), select('method', ['採集方式', 'Collection method', '采集方式'], ['official_api', 'report_import', 'manual_entry']), optional(account), field('connection_id', ['授權連接（官方 API 必填）', 'Connection (required for official API)', '授权连接（官方 API 必填）'], { optional: true, ref: ['account', 'connection'] }), lines('resources', ['資料類型（每行一筆）', 'Resource types (one per line)', '数据类型（每行一笔）']), { ...timezone, optional: false, default: Intl.DateTimeFormat().resolvedOptions().timeZone }, json('allowed_uses', ['獲准使用範圍（JSON，例如 {"display":true}）', 'Authorized uses (JSON, e.g. {"display":true})', '获准使用范围（JSON，例如 {"display":true}）']), field('authorized', ['確認已獲授權', 'Confirm source authorization', '确认已获授权'], { type: 'checkbox', mustCheck: true })], {
    tab: 'data_source', validate: body => {
      if ((body.provider === 'file_import') !== (body.kind === 'file_import')) return 'kind';
      if ((body.kind === 'platform_account') !== Boolean(body.social_account_id)) return 'social_account_id';
      if ((body.method === 'official_api') !== Boolean(body.connection_id) || body.method === 'official_api' && ['file_import', 'xiaohongshu'].includes(String(body.provider))) return 'method';
    },
  }),
  'ingest.data_health': form(['查詢資料健康狀態', 'Query data health', '查找数据健康状态'], [optional(source), optional(resource)], { tab: 'quality_issue', validate: body => body.resource && !body.data_source_id ? 'data_source_id' : undefined }),
  'ingest.get_source_capability': row(['查看資料來源能力', 'Get source capabilities', '查看数据源能力'], 'data_source', source),
  'ingest.set_source_status': row(['變更資料來源狀態', 'Change source status', '变更数据源状态'], 'data_source', source, [select('status', ['狀態', 'Status', '状态'], ['active', 'paused', 'disabled'])], true),
  'ingest.configure_schedule': row(['設定同步排程', 'Configure sync schedule', '设置同步调度'], 'data_source', source, [resource,
    select('mode', ['同步模式', 'Sync mode'], ['interval', 'manual_only']),
    optional(integer('interval_seconds', ['間隔秒數', 'Interval in seconds', '间隔秒数'], 300, 604_800)),
    optional(integer('overlap_seconds', ['重疊秒數', 'Overlap in seconds', '重叠秒数'], 0, 604_800)),
    optional(integer('settle_seconds', ['等待資料穩定秒數', 'Settle time in seconds', '等待数据稳定秒数'], 0, 604_800)),
  ], true),
  'ingest.sync_refresh': { ...row(['立即同步', 'Sync now'], 'data_source', source, [resource, from, to], true), validate: windowProblem },
  'ingest.reconcile': { ...row(['重新同步指定期間', 'Reconcile a sync window', '重新同步指定期间'], 'data_source', source, [resource, ...requiredWindow], true), validate: windowProblem },
  'ingest.get_coverage': { ...row(['查詢資料涵蓋範圍', 'Check data coverage', '查找数据涵盖范围'], 'data_source', source, [resource, ...requiredWindow]), validate: windowProblem },
  'ingest.scan_coverage': { ...row(['掃描資料缺口', 'Scan for data gaps', '扫描数据缺口'], 'data_source', source, [resource, ...requiredWindow], true), validate: windowProblem },
  'ingest.start_backfill': { ...row(['啟動歷史回補', 'Start historical backfill', '启动历史回补'], 'data_source', source, [lines('resources', ['資料類型（每行一筆）', 'Resource types (one per line)', '数据类型（每行一笔）']), ...requiredWindow], true), validate: windowProblem },
  'ingest.backfill_gap': row(['回補資料缺口', 'Backfill a data gap', '回补数据缺口'], 'data_gap', dataGap, [], true),
  'ingest.accept_gap': row(['接受資料缺口', 'Accept a data gap', '接受数据缺口'], 'data_gap', dataGap, [reason], true),
  'ingest.backfill_status': form(['查看歷史回補狀態', 'Check backfill status', '查看历史回补状态'], [field('operation_id', ['回補作業 ID', 'Backfill operation ID', '回补作业 ID'])]),
  'ingest.run_quality_checks': row(['執行資料品質檢查', 'Run data quality checks', '运行数据品质检查'], 'data_source', source, [resource], true),
  'ingest.resolve_quality_issue': { ...row(['更新品質問題狀態', 'Update quality issue status', '更新品质问题状态'], 'quality_issue', qualityIssue, [
    { ...select('status', ['處理方式', 'Resolution status', '处理方式'], ['acknowledged', 'investigating', 'resolved', 'false_positive']), seed: false }, optional(reason),
  ], true), validate: body => ['resolved', 'false_positive'].includes(String(body.status)) && !body.reason ? 'reason' : undefined },
  'ingest.get_provenance': form(['查看指標來源', 'Get observation provenance', '查看指标来源'], [field('observation_id', ['觀測值 ID', 'Observation ID', '观测值 ID'])]),
  'ingest.retry_run': row(['重試同步', 'Retry sync', '重试同步'], 'sync_run', syncRun, [], true),
  'ingest.cancel_run': row(['取消同步', 'Cancel sync'], 'sync_run', syncRun, [], true),

  'analytics.reconcile_revenue_day': { ...row(['核對或更正單日營收', 'Reconcile a store day', '核对或更正单日营收'], 'store', store, [
    field('day', ['營收日期', 'Revenue date', '营收日期'], { type: 'date' }), { ...timezone, name: 'tz', optional: false },
    field('currency', ['幣別', 'Currency', '币别'], { seed: 'default_currency' }), field('source_report_ref', ['來源報表參考代碼', 'Source report reference', '来源报表参考代码']),
    integer('order_count', ['訂單數', 'Order count', '订单数'], 0), integer('order_total_minor', ['訂單總額（最小貨幣單位）', 'Order total (minor currency units)', '订单总额（最小货币单位）'], 0),
    integer('refunds_succeeded_minor', ['退款總額（最小貨幣單位）', 'Successful refunds (minor currency units)', '退款总额（最小货币单位）'], 0),
  ], true), targetModule: 'commerce' },
  'analytics.revenue_reconciliation_list': { ...row(['查看營收核對紀錄', 'List revenue reconciliation checks', '查看营收核对记录'], 'store', store, [
    { ...from, optional: false, type: 'date' }, { ...to, optional: false, type: 'date' },
  ]), targetModule: 'commerce', validate: windowProblem },
  'analytics.cohorts_list': form(['查詢首購與復購客群', 'Query first-purchase and repeat cohorts', '查找首购与复购客群'], [
    json('period', ['首購期間（JSON，含 from、to、tz）', 'First-purchase period (JSON with from, to, tz)', '首购期间（JSON，含 from、to、tz）']),
    lines('store_ids', ['店鋪 ID（每行一筆）', 'Store IDs (one per line)', '店铺 ID（每行一笔）'], true),
    optional(field('observation_days', ['復購觀察日數', 'Repeat observation days', '复购观察日数'], { type: 'number', default: '90' })),
    optional(field('history_months', ['最低歷史月數', 'Minimum history months', '最低历史月数'], { type: 'number', default: '3' })), cutoff,
  ], { tab: 'report' }),
  'analytics.attribution_query': form(['比較訂單歸因', 'Compare order attribution', '比较订单归因'], [
    attributionPeriod, attributionModels, storeIds, cutoff,
  ], { tab: 'report' }),
  'analytics.attribution_run': form(['重新計算並儲存訂單歸因', 'Recompute and save order attribution', '重新计算并保存订单归因'], [attributionPeriod, attributionModels, storeIds], { tab: 'report', confirm: true }),
  'analytics.attribution_explain': form(['查看訂單歸因', 'Explain order attribution', '查看订单归因'], [field('order_id', ['訂單 ID', 'Order ID', '订单 ID']), cutoff]),
  'analytics.posting_time_suggest': form(['建議發布時段', 'Suggest posting times', '建议发布时段'], [account, field('content_type', ['內容形式', 'Content type', '内容形式']),
    json('period', ['樣本期間（JSON，含 from、to、tz）', 'Sample period (JSON with from, to, tz)', '样本期间（JSON，含 from、to、tz）'])]),
  'analytics.experiments_list': form(['查看實驗與結論', 'View experiments and conclusions', '查看实验与结论']),
  'analytics.reports_create': form(['新增報告', 'Create report', '添加报告'], reportFields, { tab: 'report' }),
  'analytics.reports_update': row(['更新報告設定', 'Update report definition', '更新报告设置'], 'report', report, [expected, ...reportFields.map(optional)]),
  'analytics.reports_get': row(['查看報告與版本', 'Get report and versions', '查看报告与版本'], 'report', report, [optional(integer('version_no', ['版本編號', 'Version number', '版本编号']))]),
  'analytics.reports_generate_version': row(['產生報告版本', 'Generate report version', '产生报告版本'], 'report', report, [cutoff]),
  'analytics.reports_update_narrative': row(['更新報告敘述', 'Update report narrative', '更新报告叙述'], 'report_version', reportVersion, [expected,
    array('narrative', ['敘述（JSON 陣列，每筆含 section_key、blocks）', 'Narrative (JSON array with section_key and blocks per entry)', '叙述（JSON 数组，每笔含 section_key、blocks）']),
  ]),
  'analytics.reports_finalize': row(['定稿報告版本', 'Finalize report version', '定稿报告版本'], 'report_version', reportVersion, [expected], true),
  'analytics.reports_export': row(['匯出報告版本', 'Export report version', '导出报告版本'], 'report_version', reportVersion, [select('format', ['檔案格式', 'File format', '文件格式'], ['csv', 'pdf'])]),
  'analytics.metric_definitions_get': form(['查看指標定義', 'Get metric definitions', '查看指标定义']),
  'analytics.metrics_query': form(['查詢指標', 'Query metrics', '查找指标'], [metricKeys, json('subject', ['分析對象（JSON，含 type 與 filter）', 'Subject (JSON with type and filter)', '分析对象（JSON，含 type 与 filter）']), metricTime, select('granularity', ['時間粒度', 'Granularity', '时间粒度'], ['none', 'day', 'week', 'month'], { optional: true }), lines('group_by', ['分組維度（每行一筆）', 'Group dimensions (one per line)', '分组维度（每行一笔）'], true), cutoff], { tab: 'metric_definition' }),
  'analytics.posts_performance_get': form(['查詢貼文成效', 'Get post performance', '查找帖子成效'], [metricKeys, metricTime, json('filter', ['貼文篩選（JSON）', 'Post filters (JSON)', '帖子筛选（JSON）'], true), cutoff], { tab: 'metric_definition' }),
  'analytics.post_history': form(['查看貼文指標歷史', 'Get post metric history', '查看帖子指标历史'], [field('subject_id', ['平台貼文 ID', 'Platform post ID', '平台帖子 ID']), cutoff]),

  'team.list_board': form(['查看團隊協作看板', 'View team collaboration board', '查看团队协作看板']),
  'team.create_task': form(['新增團隊任務', 'Create team task', '添加团队任务'], [title, teamAssignee, instant('dueAt', ['到期時間', 'Due at', '到期时间'], true)], { tab: 'task' }),
  'team.update_task': row(['更新團隊任務', 'Update team task', '更新团队任务'], 'task', teamTask, [version, teamAssignee, instant('dueAt', ['到期時間', 'Due at', '到期时间'], true), select('status', ['狀態', 'Status', '状态'], ['open', 'in_progress', 'blocked', 'done'], { optional: true })]),
  'team.add_internal_note': row(['新增任務備註', 'Add task note', '添加任务备注'], 'task', { ...teamTask, name: 'taskId' }, [field('text', ['備註內容', 'Note text', '备注内容'], { type: 'textarea' })]),
  'team.complete_handover': row(['完成交接', 'Complete handover'], 'handover', field('id', ['交接單 ID', 'Handover ID', '交接单 ID']), [version, { ...teamAssignee, optional: false }], true),
  'team.create_delivery': form(['新增交付計畫', 'Create delivery', '添加交付计划'], [title, description, array('items', ['交付項目（JSON 陣列，含 title 與 status）', 'Delivery items (JSON array with title and status)', '交付项目（JSON 数组，含 title 与 status）'])], { tab: 'delivery' }),
  'team.publish_delivery': row(['發布交付計畫', 'Publish delivery', '发布交付计划'], 'delivery', teamDelivery, [version], true),
  'team.preview_share': row(['預覽交付分享', 'Preview delivery share', '预览交付分享'], 'delivery', deliveryId),
  'team.create_share': row(['建立交付分享', 'Create delivery share', '创建交付分享'], 'delivery', deliveryId, [field('previewVersion', ['預覽版本', 'Preview version', '预览版本'], { type: 'number' }), lines('permissions', ['權限（每行一筆，必含 view）', 'Permissions (one per line, including view)', '权限（每行一笔，必含 view）']), instant('expiresAt', ['到期時間', 'Expires at', '到期时间'])], true),
  'team.revoke_share': row(['撤銷交付分享', 'Revoke delivery share', '撤销交付分享'], 'share', field('id', ['分享 ID', 'Share ID']), [version], true),
};
