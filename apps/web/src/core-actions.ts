import type { Action, Field } from './catalog';
import { rowActions, text, type Action as WorkspaceAction } from './actions';

const executionPath = '/execution-tasks/:id';
export const executionWorkspaceActions: WorkspaceAction[] = [
  { path: `${executionPath}/manual-start`, label: ['開始人工發布', 'Start manual attempt'], confirm: true },
  ...rowActions.tasks.map(action => action.path.endsWith('/manual-abandon') ? {
    ...action, label: ['確認未曾提交', 'Confirm no submission'],
    body: values => ({ ...values, confirmed_not_submitted: true }),
  } satisfies WorkspaceAction : action),
  { path: `${executionPath}/run-now`, label: ['立即執行', 'Run now'], confirm: true },
  { path: `${executionPath}/cancel`, label: ['取消任務', 'Cancel task'], confirm: true },
  { path: `${executionPath}/late-decision`, label: ['處理逾期', 'Resolve late task'], confirm: true, fields: [
    { key: 'decision', label: ['處理方式', 'Decision'], type: 'select', options: ['skip', 'run_now', 'reschedule'] },
    { ...text('reason', '原因', 'Reason', true), type: 'textarea' },
  ] },
];

export const requestPostOperation: WorkspaceAction = {
  path: '/platform-posts/:id/operations', label: ['登記平台操作', 'Request post maintenance'], confirm: true,
  fields: [
    { key: 'kind', label: ['操作', 'Operation'], type: 'select', options: ['edit_caption', 'delete', 'hide', 'unschedule'] },
    { ...text('caption', '預定文案', 'Requested caption', true), type: 'textarea' },
    text('reason', '原因', 'Reason'),
  ],
  body: ({ caption, ...values }) => ({ ...values, ...(values.kind === 'edit_caption' && { after_payload: { caption: caption ?? '' } }) }),
};
export function requestOfficialPostOperation(kinds: string[]): WorkspaceAction {
  return { ...requestPostOperation, label: ['透過官方 API 操作', 'Use official API'],
    fields: requestPostOperation.fields?.map(field => field.key === 'kind' ? { ...field, options: kinds } : field),
    body: values => ({ ...requestPostOperation.body?.(values), executor: 'api' }),
  };
}
export const completePostOperation: WorkspaceAction = {
  path: '/post-operations/:id/manual-complete', label: ['回填操作結果', 'Record maintenance result'], confirm: true,
  fields: [
    { key: 'outcome', label: ['結果', 'Outcome'], type: 'select', options: ['completed', 'failed'] },
    { ...text('observed_caption', '平台讀回文案（文案空白時留空）', 'Caption read from platform (leave blank for an empty caption)', true), type: 'textarea' },
    { key: 'evidence_file_ids', type: 'ids', label: ['證據檔案 ID（逗號分隔）', 'Evidence file IDs (comma separated)'] },
  ],
  body: values => ({ ...values, observed_caption: values.observed_caption ?? '' }),
};

export const targetWorkspaceActions: WorkspaceAction[] = rowActions.targets.map(action => {
  const decision = /\/(approve|reject|request-changes)$/.test(action.path);
  if (!decision) return action;
  return { ...action, fields: [{ ...text('reason', '審批理由', 'Decision reason', action.path.endsWith('/approve')), type: 'textarea' }] };
});

type Label = readonly [string, string];

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

const name = field('name', ['名稱', 'Name']);
const title = field('title', ['標題', 'Title']);
const description = field('description', ['描述', 'Description'], { type: 'textarea' });
const reason = field('reason', ['原因', 'Reason'], { type: 'textarea', seed: false });
const note = optional(field('note', ['備註', 'Note'], { type: 'textarea' }));
const expected = integer('expected_version', ['目前版本', 'Current version']);
const version = { ...expected, name: 'version' };
const limit = optional(integer('limit', ['筆數上限', 'Result limit']));
const brand = field('brand_id', ['品牌', 'Brand'], { ref: ['workspace', 'brand'] });
const campaign = field('campaign_id', ['活動', 'Campaign'], { ref: ['campaign', 'campaign'] });
const store = field('store_id', ['店鋪', 'Store'], { ref: ['commerce', 'store'] });
const product = field('product_id', ['商品', 'Product'], { ref: ['commerce', 'product'] });
const item = field('content_item_id', ['內容項目', 'Content item'], { ref: ['content', 'content_item'] });
const variant = field('variant_id', ['內容變體', 'Content variant'], { ref: ['content', 'content_variant'] });
const revision = field('revision_id', ['修訂 ID', 'Revision ID']);
const account = field('social_account_id', ['社群帳號', 'Social account'], { ref: ['account', 'social_account'] });
const owner = optional(field('owner_user_id', ['負責人 ID', 'Owner ID']));
const timezone = optional(field('timezone', ['時區（IANA）', 'Time zone (IANA)']));
const from = instant('from', ['起始時間', 'From'], true);
const to = instant('to', ['結束時間', 'To'], true);

const workItem = field('id', ['工作項目 ID', 'Work item ID']);
const campaignKinds = ['launch', 'seasonal', 'promotion', 'always_on', 'brand', 'other'];
const stages = ['accepted', 'drafting', 'design', 'awaiting_assets', 'internal_review', 'ready', 'archived'];
const contentFields = [title, owner, instant('production_due_at', ['製作期限', 'Production deadline'], true), optional(field('blocked_reason', ['阻塞原因', 'Blocker reason']))];
const baseRevision = field('base_revision_id', ['目前修訂 ID（首次使用 null）', 'Current revision ID (null for the first revision)'], { shape: 'nullable-id', seed: 'current_revision_id', default: 'null' });
const draft = json('draft_doc', ['工作稿（JSON）', 'Working draft (JSON)'], true);
const accounts = lines('social_account_ids', ['社群帳號 ID（每行一筆）', 'Social account IDs (one per line)'], true);

const target = field('target_id', ['發布目標', 'Publish target'], { ref: ['planning', 'publish_target'] });
const scheduleAt = instant('scheduled_at', ['發布時間（瀏覽器時區）', 'Publish time (browser time zone)']);
const scheduleZone = optional(field('schedule_tz', ['排期時區（IANA）', 'Schedule time zone (IANA)']));
const targetOptions = json('options', ['發布選項（JSON）', 'Publish options (JSON)'], true);
const route = select('route', ['發布管道', 'Publishing route'], ['manual', 'official']);
const visibility = field('visibility', ['可見性', 'Visibility'], { default: 'public' });
const frozenHash = optional(field('frozen_hash', ['已凍結內容的雜湊', 'Frozen content hash']));
const planFilters = [from, to, optional(brand), optional(campaign), optional(account), optional(field('status', ['狀態', 'Status']))];
const task = field('task_id', ['執行任務', 'Execution task'], { ref: ['execution', 'execution_task'] });
const attempt = field('attempt_id', ['執行嘗試 ID', 'Execution attempt ID'], { seed: 'active_attempt_id' });
const fencingToken = integer('fencing_token', ['目前的租約權杖', 'Current lease token']);
const evidence = field('evidence', ['核實證據', 'Verification evidence'], { type: 'textarea', seed: false });
const confirmAbsent = field('confirm_no_pending_submission', ['確定沒有仍可能發布的提交', 'Confirm no pending submission can publish'], { type: 'checkbox', seed: false });
const permalink = optional(field('permalink', ['公開貼文連結（已發布時必填）', 'Post URL (required if published)'], { type: 'url' }));
const externalPost = optional(field('external_post_id', ['平台貼文 ID', 'External post ID']));
const verifiedOutcome: Action['validate'] = body => body.outcome === 'verified_absent'
  ? body.confirm_no_pending_submission === true ? undefined : 'confirm_no_pending_submission'
  : typeof body.permalink === 'string' && /^https?:\/\//i.test(body.permalink) ? undefined : 'permalink';
const reviewTarget = (label: Label, reviewReason: Field) => form(label, [target, expected, frozenHash, reviewReason], {
  target: 'publish_target', targetField: 'target_id', tab: 'approval_request', confirm: true,
});
const plan = field('plan_id', ['發布計畫 ID', 'Publish plan ID']);
const planItems = { ...array('items', ['目標版本（JSON 陣列，每筆含 target_id 與 expected_version）', 'Target versions (JSON array with target_id and expected_version per item)']), seed: 'commit_items' };

const providers = ['file_import', 'shopify', 'tiktok_shop', 'amazon_sp', 'shopee'];
const template = select('template_key', ['匯入模板', 'Import template'], ['product_list', 'inventory_list', 'order_list', 'refund_list'], { default: 'product_list' });
const csv = field('csv', ['CSV 內容', 'CSV content'], { type: 'csv' });
const importOptions = json('options', ['匯入選項（JSON，例如 timezone）', 'Import options (JSON, e.g. timezone)'], true);
const batch = field('batch_id', ['匯入批次 ID', 'Import batch ID']);
const productDetails = [optional(field('handle', ['商品代稱', 'Product handle'])), optional(field('product_type', ['商品類型', 'Product type'])), optional(field('vendor', ['供應商', 'Vendor']))];

const conversation = field('conversation_id', ['對話 ID', 'Conversation ID']);
const message = field('message_id', ['訊息 ID', 'Message ID']);
const replyDraft = field('reply_draft_id', ['回覆草稿 ID', 'Reply draft ID']);
const outboundReply = field('outbound_reply_id', ['回覆意圖 ID', 'Outbound reply intent ID']);
const replyBody = field('body_text', ['回覆內容', 'Reply text'], { type: 'textarea' });
const priorities = ['low', 'normal', 'high', 'urgent'];
const inboxStatus = ['open', 'waiting_customer', 'snoozed', 'resolved'];

const source = field('data_source_id', ['資料來源', 'Data source'], { ref: ['ingest', 'data_source'] });
const syncRun = field('sync_run_id', ['同步紀錄', 'Sync run'], { ref: ['ingest', 'sync_run'] });
const dataGap = field('data_gap_id', ['資料缺口 ID', 'Data gap ID']);
const qualityIssue = field('quality_issue_id', ['品質問題', 'Quality issue'], { ref: ['ingest', 'quality_issue'] });
const requiredWindow = [{ ...from, optional: false, seed: 'window_start' }, { ...to, optional: false, seed: 'window_end' }];
const windowProblem: Action['validate'] = body => {
  if (body.from !== undefined && body.to === undefined) return 'to';
  if (body.to !== undefined && (typeof body.from !== 'string' || typeof body.to !== 'string' || body.from >= body.to)) return 'from';
};
const resources = ['account_metrics', 'post_metrics', 'video_metrics', 'note_metrics', 'ad_metrics'];
const resource = select('resource', ['資料類型', 'Resource type'], resources);
const metricKeys = lines('metrics', ['指標鍵（每行一筆）', 'Metric keys (one per line)']);
const metricTime = json('time', ['時間範圍（JSON，含 from、to、tz）', 'Time range (JSON with from, to, tz)']);
const cutoff = instant('data_cutoff_at', ['資料截止時間', 'Data cutoff'], true);
const report = field('report_id', ['報告', 'Report'], { ref: ['analytics', 'report'] });
const reportVersion = field('version_id', ['報告版本 ID', 'Report version ID']);
const reportFields = [title, select('kind', ['報告類型', 'Report type'], ['social_performance', 'campaign', 'client_monthly', 'custom', 'ecommerce']),
  json('period', ['報告期間（JSON，含 from、to、tz）', 'Report period (JSON with from, to, tz)']),
  json('scope', ['報告範圍（JSON，例如 brand_ids、campaign_ids）', 'Report scope (JSON, e.g. brand_ids, campaign_ids)'], true),
  { ...array('sections', ['報告區段（JSON 陣列，每筆含 key、type、query）', 'Report sections (JSON array with key, type, and query per entry)']), seed: 'section_inputs' }];
const attributionPeriod = json('period', ['交易期間（JSON，含 from、to、tz）', 'Transaction period (JSON with from, to, tz)']);
const attributionModels = { ...lines('model_keys', ['模型（每行一筆）', 'Models (one per line)']), default: 'link_session\ndiscount_code\nplatform_reported' };
const storeIds = lines('store_ids', ['店鋪 ID（每行一筆）', 'Store IDs (one per line)'], true);
const teamAssignee = optional(field('assigneeId', ['指派成員 ID', 'Assignee ID']));
const teamTask = field('id', ['團隊任務 ID', 'Team task ID']);
const teamDelivery = field('id', ['交付計畫 ID', 'Delivery ID']);
const deliveryId = { ...teamDelivery, name: 'deliveryId' };

export const coreActions: Record<string, Action> = {
  'workspace.get_workspace': form(['查看工作區設定', 'Get workspace settings']),
  'workspace.update_workspace': form(['編輯工作區設定', 'Edit workspace settings'], [optional(expected), optional(name), optional(field('default_timezone', ['預設時區（IANA）', 'Default time zone (IANA)'])), optional(field('reporting_currency', ['報告幣別', 'Reporting currency']))], { tab: 'settings' }),
  'workspace.create_brand': form(['新增品牌', 'Create brand'], [name, field('slug', ['品牌代稱', 'Brand slug'])], { tab: 'brand' }),
  'workspace.list_brands': form(['查詢品牌', 'List brands'], [select('status', ['狀態', 'Status'], ['active', 'archived'], { optional: true })]),
  'workspace.update_brand': row(['編輯品牌', 'Edit brand'], 'brand', { ...brand, name: 'id' }, [expected, optional(name), optional(field('slug', ['品牌代稱', 'Brand slug'])), optional(field('default_market_id', ['預設市場 ID', 'Default market ID']))]),
  'workspace.create_market': form(['新增市場', 'Create market'], [brand, name, field('country_code', ['國家代碼', 'Country code']), field('primary_language', ['主要語言', 'Primary language']), field('currency', ['幣別', 'Currency']), { ...timezone, optional: false }, lines('languages', ['其他語言（每行一筆）', 'Additional languages (one per line)'], true)], { tab: 'market' }),
  'workspace.list_markets': form(['查詢市場', 'List markets'], [optional(brand)]),
  'workspace.overview_today': form(['查看今日工作', 'View today’s work'], [optional(brand)]),
  'workspace.overview_summary': form(['查看工作區摘要', 'View workspace summary'], [optional(brand)]),
  'workspace.list_work_items': form(['查詢工作項目', 'List work items'], [optional(brand), limit]),
  'workspace.get_work_item': row(['查看工作項目', 'Get work item'], 'work_item', workItem),
  'workspace.create_work_item': form(['新增工作項目', 'Create work item'], [title, optional(brand), instant('due_at', ['到期時間', 'Due at'], true)], { tab: 'work_item' }),
  'workspace.complete_work_item': row(['完成工作項目', 'Complete work item'], 'work_item', workItem, [expected], true),
  'workspace.reopen_work_item': row(['重新開啟工作項目', 'Reopen work item'], 'work_item', workItem, [expected]),
  'workspace.list_notifications': form(['查看通知', 'List notifications'], [limit]),

  'campaign.create_draft': form(['新增活動草稿', 'Create campaign draft'], [brand, name, select('kind', ['活動類型', 'Campaign type'], campaignKinds, { default: 'launch' }), instant('starts_at', ['開始時間', 'Starts at'], true), instant('ends_at', ['結束時間', 'Ends at'], true), timezone, owner, optional(field('objective_summary', ['活動目標', 'Objective'], { type: 'textarea' })), optional(field('utm_key', ['活動追蹤鍵', 'Campaign tracking key']))], { tab: 'campaign' }),
  'campaign.list': form(['查詢活動', 'List campaigns'], [optional(brand), select('status', ['狀態', 'Status'], ['draft', 'planned', 'active', 'paused', 'wrapping', 'closed', 'cancelled'], { optional: true }), instant('active_on', ['活動時間', 'Active at'], true)]),
  'campaign.get_context': row(['查看活動和關聯資料', 'Get campaign context'], 'campaign', campaign),
  'campaign.update': row(['編輯活動', 'Edit campaign'], 'campaign', campaign, [expected, json('patch', ['變更欄位（JSON）', 'Changed fields (JSON)'])]),
  'campaign.transition': row(['變更活動狀態', 'Change campaign status'], 'campaign', campaign, [expected, select('to', ['新狀態', 'New status'], ['planned', 'active', 'paused', 'wrapping', 'cancelled']), optional(reason)], true),
  'campaign.set_markets': row(['設定活動市場', 'Set campaign markets'], 'campaign', campaign, [expected, array('markets', ['市場明細（JSON 陣列）', 'Markets (JSON array)'])], true),
  'campaign.set_products': row(['設定活動商品', 'Set campaign products'], 'campaign', campaign, [expected, array('products', ['商品明細（JSON 陣列）', 'Products (JSON array)'])], true),
  'campaign.list_goals': row(['查看活動目標', 'List campaign goals'], 'campaign', campaign),
  'campaign.create_goal': row(['新增活動目標', 'Create campaign goal'], 'campaign', campaign, [field('metric_key', ['指標鍵', 'Metric key']), select('unit', ['單位', 'Unit'], ['count', 'currency', 'percent', 'seconds']), optional(field('currency', ['幣別（貨幣指標必填）', 'Currency (required for currency metrics)'])), field('baseline_value', ['基準值', 'Baseline value'], { type: 'number' }), field('target_value', ['目標值', 'Target value'], { type: 'number' }), instant('due_at', ['到期時間', 'Due at'])]),

  'content.content_create_item': form(['新增內容', 'Create content'], [brand, optional(campaign), ...contentFields], { tab: 'content_item' }),
  'content.content_list': form(['查詢內容', 'List content'], [optional(brand), optional(campaign), select('production_stage', ['製作階段', 'Production stage'], stages, { optional: true }), owner]),
  'content.content_get': row(['查看內容和變體', 'Get content and variants'], 'content_item', item),
  'content.content_update_item': row(['編輯內容', 'Edit content'], 'content_item', item, [expected, ...contentFields.map(optional)]),
  'content.content_set_stage': row(['變更製作階段', 'Change production stage'], 'content_item', item, [expected, select('to', ['新階段', 'New stage'], stages), note], true),
  'content.content_create_variant': row(['新增內容變體', 'Create content variant'], 'content_item', item, [select('platform', ['社群平台', 'Platform'], ['instagram', 'facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu', 'generic']), select('format', ['內容格式', 'Content format'], ['feed_image', 'carousel', 'reel', 'story', 'short_video', 'long_video', 'text', 'note', 'live_teaser']), field('locale', ['內容語言', 'Content locale']), optional(account), draft]),
  'content.content_duplicate': row(['複用為新草稿', 'Reuse as new draft'], 'content_item', item, [optional(title)]),
  'content.content_get_variant': row(['查看內容變體', 'Get content variant'], 'content_variant', variant),
  'content.content_autosave_variant': row(['更新工作稿', 'Save working draft'], 'content_variant', variant, [expected, { ...baseRevision, optional: true, default: undefined }, { ...draft, optional: false }]),
  'content.content_commit_revision': row(['提交內容修訂', 'Commit content revision'], 'content_variant', variant, [expected, baseRevision, draft]),
  'content.content_create_translation': row(['新增譯文', 'Create translation'], 'content_variant', { ...variant, name: 'source_variant_id' }, [
    optional(field('source_revision_id', ['來源修訂 ID', 'Source revision ID'])), field('locale', ['語言', 'Locale']), optional(field('market_id', ['市場 ID', 'Market ID'])),
    field('body', ['譯文', 'Localized copy'], { type: 'textarea' }),
  ]),
  'content.content_accept_source_change': row(['確認已審閱來源', 'Accept reviewed source'], 'translation_link', field('translation_link_id', ['翻譯連結 ID', 'Translation link ID']), [expected, field('source_revision_id', ['來源修訂 ID', 'Source revision ID']), optional(field('glossary_version', ['術語版本', 'Glossary version']))]),
  'content.content_mark_divergence': row(['保留市場改寫', 'Keep market rewrite'], 'translation_link', field('translation_link_id', ['翻譯連結 ID', 'Translation link ID']), [expected, field('source_revision_id', ['來源修訂 ID', 'Source revision ID']), optional(field('glossary_version', ['術語版本', 'Glossary version'])), { ...note, optional: false }]),
  'content.content_request_rendition': row(['請求尺寸衍生檔', 'Request resized rendition'], 'content_variant', variant, [expected,
    field('media_index', ['素材索引（從 0 開始）', 'Media index (starts at 0)'], { type: 'number', min: 0, integer: true, default: '0' }),
    select('kind', ['衍生檔類型', 'Rendition type'], ['platform_resize'], { default: 'platform_resize' }),
    json('params', ['尺寸參數（JSON）', 'Size parameters (JSON)']),
  ]),
  'content.content_list_revisions': row(['列出內容修訂', 'List content revisions'], 'content_variant', variant),
  'content.content_get_revision': row(['查看內容修訂', 'Get content revision'], 'content_revision', revision),
  'content.content_diff_revisions': row(['比較修訂', 'Compare revisions'], 'content_revision', { ...revision, name: 'revision_a' }, [field('revision_b', ['比較修訂 ID', 'Revision ID to compare'])]),
  'content.content_restore_revision': form(['復原舊修訂為新版本', 'Restore an earlier revision as a new version'], [
    { ...revision, seed: false }, expected, baseRevision,
  ], { target: 'content_variant', confirm: true }),
  'content.content_list_translations': row(['查看翻譯與來源差異', 'List translations and source changes'], 'content_variant', variant),
  'content.content_get_transcript': row(['查看逐字稿', 'Get transcript'], 'transcript', field('transcript_id', ['逐字稿 ID', 'Transcript ID'])),
  'content.content_review_transcript': row(['審閱或更正逐字稿', 'Review or correct transcript'], 'transcript', field('transcript_id', ['逐字稿 ID', 'Transcript ID']), [
    expected, array('segments', ['逐字稿片段（JSON 陣列，含 start_ms、end_ms、text）', 'Transcript segments (JSON array with start_ms, end_ms, text)'], true),
  ], true),
  'content.content_list_stale': form(['查看需重新審閱的內容變體', 'List stale content variants'], [optional(campaign), lines('reason', ['原因代碼（每行一筆）', 'Reason codes (one per line)'], true)]),
  'content.content_validate_variant': row(['驗證內容變體', 'Validate content variant'], 'content_variant', variant, [optional(revision), accounts, { ...scheduleAt, optional: true }]),
  'content.content_set_readiness': row(['標記內容為可排期', 'Mark content ready'], 'content_variant', variant, [expected, accounts, field('confirm_stale', ['已處理過期問題', 'Stale issues resolved'], { type: 'checkbox' }), field('confirm_reuse_review', ['已審閱複用的商品內容', 'Reused product copy reviewed'], { type: 'checkbox' })], true),
  'content.idea_create': form(['新增選題', 'Create idea'], [brand, title, optional(campaign), array('origin_refs', ['證據來源（JSON 陣列，每筆含 type 與 id 或 url）', 'Evidence (JSON array with type and id or url per entry)']), lines('tags', ['標籤（每行一筆）', 'Tags (one per line)'], true)], { tab: 'idea' }),
  'content.idea_get': row(['查看選題', 'Get idea'], 'idea', field('idea_id', ['選題 ID', 'Idea ID'])),
  'content.idea_list': form(['查詢選題', 'List ideas'], [optional(brand), optional(campaign), optional(field('tag', ['標籤', 'Tag']))]),
  'content.idea_convert': row(['轉為內容項目', 'Convert to content'], 'idea', field('idea_id', ['選題 ID', 'Idea ID']), [optional(title)]),

  'planning.create_plan': form(['新增發布計畫', 'Create publishing plan'], [name], { tab: 'publish_target' }),
  'planning.preview_plan': row(['預覽發布計畫', 'Preview publishing plan'], 'publish_plan', plan),
  'planning.commit_plan': { ...row(['提交計畫審批', 'Submit plan for approval'], 'publish_plan', plan, [expected, planItems], true), validate: body => {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50 || body.items.some(item =>
      !item || typeof item !== 'object' || Object.keys(item).length !== 2 || typeof item.target_id !== 'string' || !item.target_id.trim() || !Number.isSafeInteger(item.expected_version) || item.expected_version < 1)) return 'items';
  } },
  'planning.create_target': form(['建立發布目標', 'Create publish target'], [account, { ...variant, name: 'content_variant_id' }, optional(revision), optional(plan), route, visibility, scheduleAt, scheduleZone, targetOptions], { tab: 'publish_target' }),
  'planning.list_targets': form(['查詢發布目標', 'List publish targets'], planFilters),
  'planning.get_target': row(['查看發布目標', 'Get publish target'], 'publish_target', target),
  'planning.calendar': form(['查詢發布日曆', 'View publishing calendar'], [select('view', ['檢視', 'View'], ['day', 'week', 'month', 'list'], { default: 'week' }), ...planFilters]),
  'planning.precheck': row(['執行發布預檢', 'Run publishing precheck'], 'publish_target', target, [select('stage', ['檢查階段', 'Check stage'], ['schedule', 'approval', 'preflight', 'execution'], { default: 'schedule' })]),
  'planning.submit': row(['提交發布審批', 'Submit for publishing approval'], 'publish_target', target, [expected], true),
  'planning.approve': reviewTarget(['核准發布目標', 'Approve publish target'], optional(reason)),
  'planning.reject': reviewTarget(['退回發布目標', 'Reject publish target'], reason),
  'planning.request_changes': reviewTarget(['要求修改發布目標', 'Request publishing changes'], reason),
  'planning.list_approvals': form(['查看待審批項目', 'List pending approvals'], [], { tab: 'approval_request' }),
  'planning.reschedule': row(['變更發布時間', 'Reschedule publication'], 'publish_target', target, [expected, scheduleAt, scheduleZone], true),
  'planning.change_target': row(['編輯發布目標', 'Edit publish target'], 'publish_target', target, [expected,
    ...[optional({ ...account, name: 'account_id' }), optional({ ...variant, name: 'content_variant_id' }), optional({ ...revision, shape: 'nullable-id' }), optional(route), optional({ ...visibility, default: undefined }), targetOptions].map(field => ({ ...field, seed: false as const })),
  ], true),
  'planning.set_publishing_profile': form(['設定發布帳號能力', 'Set publishing account capabilities'], [
    { ...account, name: 'account_id' }, optional(expected), optional(field('platform', ['平台代碼', 'Platform key'])), timezone,
    field('active', ['啟用設定檔', 'Enable profile'], { type: 'checkbox', default: 'true' }),
    field('manual_capability', ['允許人工發布', 'Allow manual publishing'], { type: 'checkbox', default: 'true' }),
    field('official_capability', ['啟用官方 API 發布', 'Enable official API publishing'], { type: 'checkbox' }),
    optional(field('adapter_key', ['轉接器識別碼', 'Adapter key'])), optional(integer('quota_limit', ['發布配額', 'Publishing quota'])),
    lines('formats', ['允許的格式（每行一筆）', 'Allowed formats (one per line)'], true),
    lines('markets', ['允許的市場（每行一筆）', 'Allowed markets (one per line)'], true),
    lines('visibilities', ['允許的可見性（每行一筆）', 'Allowed visibility settings (one per line)'], true),
    optional(field('account_identity', ['平台帳號識別碼', 'Platform account identity'])),
    instant('connection_expires_at', ['連線到期時間', 'Connection expiration'], true),
  ], { confirm: true, target: 'publishing_profile', targetField: 'account_id', validate: body => {
    if (body.official_capability === true && !body.adapter_key) return 'adapter_key';
    if (body.official_capability === true && !body.quota_limit) return 'quota_limit';
  } }),
  'planning.set_approval_policy': form(['設定審批政策', 'Set approval policy'], [optional(expected), optional(field('approver_id', ['審批人 ID', 'Approver ID'])), optional(integer('reschedule_tolerance_minutes', ['改期容許分鐘數', 'Reschedule tolerance in minutes'], 0, 60))], { confirm: true }),
  'planning.pause': form(['暫停發布', 'Pause publishing'], [select('scope', ['暫停範圍', 'Pause scope'], ['workspace', 'campaign', 'account', 'brand'], { default: 'workspace' }), optional(field('scope_id', ['範圍 ID（工作區留空）', 'Scope ID (blank for workspace)'])), reason], {
    confirm: true, validate: body => (body.scope === 'workspace') === Boolean(body.scope_id) ? 'scope_id' : undefined,
  }),
  'planning.release_pause': form(['預檢或解除發布暫停', 'Preview or release publishing pause'], [field('pause_id', ['暫停開關 ID', 'Pause switch ID']), optional(expected), field('dry_run', ['僅預檢', 'Preview only'], { type: 'checkbox', default: 'true' })], {
    confirm: true, validate: body => !body.dry_run && body.expected_version === undefined ? 'expected_version' : undefined,
  }),
  'planning.cancel': row(['取消發布', 'Cancel publication'], 'publish_target', target, [expected, reason], true),

  'execution.enqueue': form(['將發布目標加入執行佇列', 'Enqueue publish target'], [target, select('late_policy', ['逾期處理', 'Late policy'], ['grace_window', 'notify', 'skip'], { optional: true }), optional(integer('grace_seconds', ['寬限秒數', 'Grace period in seconds'], 0, 86_400))], { tab: 'execution_task', target: 'publish_target', targetModule: 'planning', targetField: 'target_id', confirm: true }),
  'execution.get_task': row(['查看執行任務與嘗試', 'Get execution task and attempts'], 'execution_task', task),
  'execution.preflight': form(['檢查是否可以執行', 'Run execution preflight'], [target], { target: 'publish_target', targetModule: 'planning', targetField: 'target_id' }),
  'execution.begin_manual': row(['開始人工發布', 'Begin manual publishing'], 'execution_task', task, [], true),
  'execution.list_tasks': form(['列出執行任務', 'List execution tasks'], [optional(target), optional(field('status', ['狀態', 'Status'])), optional({ ...limit, max: 200 }), optional(integer('offset', ['跳過筆數', 'Offset'], 0))]),
  'execution.reconcile_manual': { ...row(['核實人工發布結果', 'Verify manual publishing outcome'], 'execution_task', task, [attempt, fencingToken, select('outcome', ['核實結果', 'Verified outcome'], ['published', 'verified_absent']), evidence, permalink, externalPost, confirmAbsent], true), validate: verifiedOutcome },
  'execution.report_manual_unknown': row(['登記人工發布結果不明', 'Record unknown manual outcome'], 'execution_task', task, [attempt, fencingToken, evidence], true),
  'execution.recover_lease': row(['復原過期執行租約', 'Recover expired execution lease'], 'execution_task', task, [], true),
  'execution.allow_late': row(['允許逾期執行', 'Allow late execution'], 'execution_task', task, [reason, integer('extension_seconds', ['延長秒數', 'Extension in seconds'], 1, 3600)], true),
  'execution.start_restore_hold': form(['開始還原檢查暫停', 'Start restore hold'], [reason], { confirm: true }),
  'execution.list_recovery': form(['列出還原檢查', 'List restore checks'], [select('status', ['檢查狀態', 'Check status'], ['pending', 'resolved', 'all'], { default: 'pending' })]),
  'execution.record_recovery': form(['記錄還原檢查結果', 'Record restore check outcome'], [field('check_id', ['還原檢查 ID', 'Restore check ID']), select('outcome', ['核實結果', 'Verified outcome'], ['verified_absent', 'already_published']), evidence, optional({ ...permalink, label: ['公開貼文連結（若任務尚未核實發布）', 'Post URL (if the task is not already verified published)'] }), externalPost, confirmAbsent], {
    confirm: true, validate: body => body.outcome === 'verified_absent' ? verifiedOutcome(body) : body.permalink && !/^https?:\/\//i.test(String(body.permalink)) ? 'permalink' : undefined,
  }),
  'execution.release_restore_hold': form(['解除還原檢查暫停', 'Release restore hold'], [reason], { confirm: true }),
  'execution.cancel': row(['取消執行任務', 'Cancel execution task'], 'execution_task', task, [reason], true),
  'execution.handover_manual': row(['轉交人工發布', 'Hand over to manual publishing'], 'execution_task', task, [field('assignee_id', ['接手人 ID', 'Assignee ID']), reason], true),

  'commerce.create_store': form(['新增匯入店鋪', 'Create import store'], [name, select('provider', ['店鋪平台', 'Store provider'], providers, { default: 'file_import' }), optional(brand), field('default_currency', ['預設幣別', 'Default currency']), field('default_locale', ['預設語言', 'Default locale']), optional(field('external_store_id', ['平台店鋪 ID', 'External store ID'])), optional(field('region', ['地區', 'Region']))], { tab: 'store' }),
  'commerce.create_product': form(['新增商品', 'Create product'], [store, title, ...productDetails], { tab: 'product' }),
  'commerce.update_product': row(['編輯商品', 'Edit product'], 'product', product, [expected, optional(title), ...productDetails, select('status', ['狀態', 'Status'], ['draft', 'active', 'archived'], { optional: true })]),
  'commerce.catalog_search': form(['搜尋商品目錄', 'Search product catalog'], [optional(field('query', ['名稱、代稱或 SKU', 'Title, handle, or SKU'])), optional(store), optional(brand), limit]),
  'commerce.catalog_get_product': row(['查看商品明細', 'Get product details'], 'product', product),
  'commerce.import_template': form(['查看 CSV 模板', 'Get CSV template'], [select('provider', ['店鋪平台', 'Store provider'], providers, { default: 'file_import' }), template], { tab: 'import_batch' }),
  'commerce.preview_import': form(['預覽 CSV 匯入', 'Preview CSV import'], [store, template, csv, importOptions], { tab: 'import_batch' }),
  'commerce.import_error_file': row(['下載匯入錯誤明細', 'Download import errors'], 'import_batch', batch),
  'commerce.preflight_import': row(['重新檢查匯入預覽', 'Recheck import preview'], 'import_batch', batch, [{ ...expected, optional: true, seed: false }]),
  'commerce.commit_import': row(['確認並匯入', 'Commit import'], 'import_batch', batch, [expected], true),
  'commerce.rollback_import': row(['回復已提交的匯入', 'Roll back import'], 'import_batch', batch, [expected], true),

  'inbox.ingest_message': form(['匯入一則訊息', 'Import a message'], [brand, { ...account, name: 'social_account_id' },
    field('provider', ['平台供應者', 'Platform provider']), select('kind', ['對話類型', 'Conversation type'], ['comment_thread', 'private_thread', 'mention', 'ad_comment', 'review']),
    field('external_message_id', ['平台訊息 ID', 'Platform message ID']), optional(field('external_thread_id', ['平台對話 ID', 'Platform thread ID'])),
    instant('platform_created_at', ['平台發布時間', 'Platform timestamp']), replyBody], { tab: 'conversation' }),
  'inbox.list': form(['查詢收件箱', 'List inbox conversations'], [select('view', ['收件箱檢視', 'Inbox view'], ['all', 'unassigned', 'mine', 'open', 'waiting', 'snoozed', 'resolved'], { default: 'all' }), optional(brand), optional(account), select('priority', ['優先順序', 'Priority'], priorities, { optional: true }), limit]),
  'inbox.get_conversation': row(['查看對話完整紀錄', 'Get conversation details'], 'conversation', conversation),
  'inbox.update_conversation': row(['更新對話', 'Update conversation'], 'conversation', conversation, [expected, select('status', ['狀態', 'Status'], inboxStatus, { optional: true }), select('priority', ['優先順序', 'Priority'], priorities, { optional: true }), optional(field('assignee_user_id', ['指派成員 ID', 'Assignee ID'])), instant('snooze_until', ['暫緩至', 'Snooze until'], true), array('tag_ids', ['標籤 ID（JSON 陣列）', 'Tag IDs (JSON array)'], true)]),
  'inbox.mark_read': row(['標記已讀至這則訊息', 'Mark read through message'], 'conversation', conversation, [message]),
  'inbox.claim': row(['取得對話租約', 'Claim conversation'], 'conversation', conversation, [select('purpose', ['用途', 'Purpose'], ['reply', 'review', 'moderate'], { default: 'reply' })]),
  'inbox.release': row(['釋放或轉交對話租約', 'Release or hand over conversation lease'], 'conversation', conversation, [fencingToken, optional(field('handover_to_user_id', ['接手人 ID', 'Handover recipient ID']))], true),
  'inbox.add_note': row(['新增內部備註', 'Add internal note'], 'conversation', conversation, [field('body', ['備註內容', 'Note text'], { type: 'textarea' }), optional({ ...message, name: 'anchor_message_id' }), lines('mentions', ['提及成員 ID（每行一筆）', 'Mentioned user IDs (one per line)'], true)]),
  'inbox.draft_reply': row(['建立回覆草稿', 'Draft reply'], 'conversation', conversation, [replyBody, select('reply_mode', ['回覆方式', 'Reply mode'], ['public_reply', 'private_reply', 'dm'], { optional: true }), optional({ ...message, name: 'in_reply_to_message_id' }), lines('fact_refs', ['事實引用（每行一筆）', 'Fact references (one per line)'], true)]),
  'inbox.update_reply_draft': form(['編輯回覆草稿', 'Edit reply draft'], [replyDraft, expected, replyBody]),
  'inbox.submit_reply_approval': form(['提交回覆審批', 'Submit reply for approval'], [replyDraft, expected], { confirm: true }),
  'inbox.approve_reply': form(['核准回覆', 'Approve reply'], [replyDraft, expected], { confirm: true }),
  'inbox.send_reply': form(['提交回覆', 'Submit reply'], [replyDraft, expected, fencingToken, field('idempotency_key', ['回覆識別鍵（重送請沿用）', 'Unique reply key (reuse on retry)']), select('mode', ['送出方式', 'Delivery mode'], ['manual', 'api'], { default: 'manual' })], { confirm: true }),
  'inbox.get_reply_status': form(['查閱回覆狀態', 'Get reply status'], [outboundReply]),
  'inbox.reconcile_reply': form(['核實回覆結果', 'Reconcile reply'], [outboundReply]),
  'inbox.manual_complete_reply': form(['登記人工回覆完成', 'Record manual reply completion'], [outboundReply, expected, fencingToken, optional(field('platform_url', ['平台連結', 'Platform URL'], { type: 'url' })), lines('evidence_ids', ['證據 ID（未填平台連結時必填，每行一筆）', 'Evidence IDs (one per line, required without a platform URL)'], true)], { confirm: true }),
  'inbox.retry_reply': form(['重試已確認未送達的回覆', 'Retry confirmed non-delivery'], [outboundReply, expected, fencingToken], { confirm: true }),
  'inbox.cancel_reply': form(['取消回覆意圖', 'Cancel reply intent'], [outboundReply, expected], { confirm: true }),

  'ingest.create_source': form(['新增資料來源', 'Create data source'], [name, select('provider', ['來源平台', 'Provider'], ['file_import', 'meta_instagram', 'meta_facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu']), select('kind', ['來源類型', 'Source type'], ['file_import', 'platform_account']), select('method', ['採集方式', 'Collection method'], ['official_api', 'report_import', 'manual_entry']), optional(account), field('connection_id', ['授權連接（官方 API 必填）', 'Connection (required for official API)'], { optional: true, ref: ['account', 'connection'] }), lines('resources', ['資料類型（每行一筆）', 'Resource types (one per line)']), { ...timezone, optional: false, default: Intl.DateTimeFormat().resolvedOptions().timeZone }, json('allowed_uses', ['獲准使用範圍（JSON，例如 {"display":true}）', 'Authorized uses (JSON, e.g. {"display":true})']), field('authorized', ['確認已獲授權', 'Confirm source authorization'], { type: 'checkbox', mustCheck: true })], {
    tab: 'data_source', validate: body => {
      if ((body.provider === 'file_import') !== (body.kind === 'file_import')) return 'kind';
      if ((body.kind === 'platform_account') !== Boolean(body.social_account_id)) return 'social_account_id';
      if ((body.method === 'official_api') !== Boolean(body.connection_id) || body.method === 'official_api' && ['file_import', 'xiaohongshu'].includes(String(body.provider))) return 'method';
    },
  }),
  'ingest.data_health': form(['查詢資料健康狀態', 'Query data health'], [optional(source), optional(resource)], { tab: 'quality_issue', validate: body => body.resource && !body.data_source_id ? 'data_source_id' : undefined }),
  'ingest.get_source_capability': row(['查看資料來源能力', 'Get source capabilities'], 'data_source', source),
  'ingest.set_source_status': row(['變更資料來源狀態', 'Change source status'], 'data_source', source, [select('status', ['狀態', 'Status'], ['active', 'paused', 'disabled'])], true),
  'ingest.configure_schedule': row(['設定同步排程', 'Configure sync schedule'], 'data_source', source, [resource,
    select('mode', ['同步模式', 'Sync mode'], ['interval', 'manual_only']),
    optional(integer('interval_seconds', ['間隔秒數', 'Interval in seconds'], 300, 604_800)),
    optional(integer('overlap_seconds', ['重疊秒數', 'Overlap in seconds'], 0, 604_800)),
    optional(integer('settle_seconds', ['等待資料穩定秒數', 'Settle time in seconds'], 0, 604_800)),
  ], true),
  'ingest.sync_refresh': { ...row(['立即同步', 'Sync now'], 'data_source', source, [resource, from, to], true), validate: windowProblem },
  'ingest.reconcile': { ...row(['重新同步指定期間', 'Reconcile a sync window'], 'data_source', source, [resource, ...requiredWindow], true), validate: windowProblem },
  'ingest.get_coverage': { ...row(['查詢資料涵蓋範圍', 'Check data coverage'], 'data_source', source, [resource, ...requiredWindow]), validate: windowProblem },
  'ingest.scan_coverage': { ...row(['掃描資料缺口', 'Scan for data gaps'], 'data_source', source, [resource, ...requiredWindow], true), validate: windowProblem },
  'ingest.start_backfill': { ...row(['啟動歷史回補', 'Start historical backfill'], 'data_source', source, [lines('resources', ['資料類型（每行一筆）', 'Resource types (one per line)']), ...requiredWindow], true), validate: windowProblem },
  'ingest.backfill_gap': row(['回補資料缺口', 'Backfill a data gap'], 'data_gap', dataGap, [], true),
  'ingest.accept_gap': row(['接受資料缺口', 'Accept a data gap'], 'data_gap', dataGap, [reason], true),
  'ingest.backfill_status': form(['查看歷史回補狀態', 'Check backfill status'], [field('operation_id', ['回補作業 ID', 'Backfill operation ID'])]),
  'ingest.run_quality_checks': row(['執行資料品質檢查', 'Run data quality checks'], 'data_source', source, [resource], true),
  'ingest.resolve_quality_issue': { ...row(['更新品質問題狀態', 'Update quality issue status'], 'quality_issue', qualityIssue, [
    { ...select('status', ['處理方式', 'Resolution status'], ['acknowledged', 'investigating', 'resolved', 'false_positive']), seed: false }, optional(reason),
  ], true), validate: body => ['resolved', 'false_positive'].includes(String(body.status)) && !body.reason ? 'reason' : undefined },
  'ingest.get_provenance': form(['查看指標來源', 'Get observation provenance'], [field('observation_id', ['觀測值 ID', 'Observation ID'])]),
  'ingest.retry_run': row(['重試同步', 'Retry sync'], 'sync_run', syncRun, [], true),
  'ingest.cancel_run': row(['取消同步', 'Cancel sync'], 'sync_run', syncRun, [], true),

  'analytics.reconcile_revenue_day': { ...row(['核對或更正單日營收', 'Reconcile a store day'], 'store', store, [
    field('day', ['營收日期', 'Revenue date'], { type: 'date' }), { ...timezone, name: 'tz', optional: false },
    field('currency', ['幣別', 'Currency'], { seed: 'default_currency' }), field('source_report_ref', ['來源報表參考代碼', 'Source report reference']),
    integer('order_count', ['訂單數', 'Order count'], 0), integer('order_total_minor', ['訂單總額（最小貨幣單位）', 'Order total (minor currency units)'], 0),
    integer('refunds_succeeded_minor', ['退款總額（最小貨幣單位）', 'Successful refunds (minor currency units)'], 0),
  ], true), targetModule: 'commerce' },
  'analytics.revenue_reconciliation_list': { ...row(['查看營收核對紀錄', 'List revenue reconciliation checks'], 'store', store, [
    { ...from, optional: false, type: 'date' }, { ...to, optional: false, type: 'date' },
  ]), targetModule: 'commerce', validate: windowProblem },
  'analytics.cohorts_list': form(['查詢首購與復購客群', 'Query first-purchase and repeat cohorts'], [
    json('period', ['首購期間（JSON，含 from、to、tz）', 'First-purchase period (JSON with from, to, tz)']),
    lines('store_ids', ['店鋪 ID（每行一筆）', 'Store IDs (one per line)'], true),
    optional(field('observation_days', ['復購觀察日數', 'Repeat observation days'], { type: 'number', default: '90' })),
    optional(field('history_months', ['最低歷史月數', 'Minimum history months'], { type: 'number', default: '3' })), cutoff,
  ], { tab: 'report' }),
  'analytics.attribution_query': form(['比較訂單歸因', 'Compare order attribution'], [
    attributionPeriod, attributionModels, storeIds, cutoff,
  ], { tab: 'report' }),
  'analytics.attribution_run': form(['重新計算並儲存訂單歸因', 'Recompute and save order attribution'], [attributionPeriod, attributionModels, storeIds], { tab: 'report', confirm: true }),
  'analytics.attribution_explain': form(['查看訂單歸因', 'Explain order attribution'], [field('order_id', ['訂單 ID', 'Order ID']), cutoff]),
  'analytics.posting_time_suggest': form(['建議發布時段', 'Suggest posting times'], [account, field('content_type', ['內容形式', 'Content type']),
    json('period', ['樣本期間（JSON，含 from、to、tz）', 'Sample period (JSON with from, to, tz)'])]),
  'analytics.experiments_list': form(['查看實驗與結論', 'View experiments and conclusions']),
  'analytics.reports_create': form(['新增報告', 'Create report'], reportFields, { tab: 'report' }),
  'analytics.reports_update': row(['更新報告設定', 'Update report definition'], 'report', report, [expected, ...reportFields.map(optional)]),
  'analytics.reports_get': row(['查看報告與版本', 'Get report and versions'], 'report', report, [optional(integer('version_no', ['版本編號', 'Version number']))]),
  'analytics.reports_generate_version': row(['產生報告版本', 'Generate report version'], 'report', report, [cutoff]),
  'analytics.reports_update_narrative': row(['更新報告敘述', 'Update report narrative'], 'report_version', reportVersion, [expected,
    array('narrative', ['敘述（JSON 陣列，每筆含 section_key、blocks）', 'Narrative (JSON array with section_key and blocks per entry)']),
  ]),
  'analytics.reports_finalize': row(['定稿報告版本', 'Finalize report version'], 'report_version', reportVersion, [expected], true),
  'analytics.reports_export': row(['匯出報告版本', 'Export report version'], 'report_version', reportVersion, [select('format', ['檔案格式', 'File format'], ['csv', 'pdf'])]),
  'analytics.metric_definitions_get': form(['查看指標定義', 'Get metric definitions']),
  'analytics.metrics_query': form(['查詢指標', 'Query metrics'], [metricKeys, json('subject', ['分析對象（JSON，含 type 與 filter）', 'Subject (JSON with type and filter)']), metricTime, select('granularity', ['時間粒度', 'Granularity'], ['none', 'day', 'week', 'month'], { optional: true }), lines('group_by', ['分組維度（每行一筆）', 'Group dimensions (one per line)'], true), cutoff], { tab: 'metric_definition' }),
  'analytics.posts_performance_get': form(['查詢貼文成效', 'Get post performance'], [metricKeys, metricTime, json('filter', ['貼文篩選（JSON）', 'Post filters (JSON)'], true), cutoff], { tab: 'metric_definition' }),
  'analytics.post_history': form(['查看貼文指標歷史', 'Get post metric history'], [field('subject_id', ['平台貼文 ID', 'Platform post ID']), cutoff]),

  'team.list_board': form(['查看團隊協作看板', 'View team collaboration board']),
  'team.create_task': form(['新增團隊任務', 'Create team task'], [title, teamAssignee, instant('dueAt', ['到期時間', 'Due at'], true)], { tab: 'task' }),
  'team.update_task': row(['更新團隊任務', 'Update team task'], 'task', teamTask, [version, teamAssignee, instant('dueAt', ['到期時間', 'Due at'], true), select('status', ['狀態', 'Status'], ['open', 'in_progress', 'blocked', 'done'], { optional: true })]),
  'team.add_internal_note': row(['新增任務備註', 'Add task note'], 'task', { ...teamTask, name: 'taskId' }, [field('text', ['備註內容', 'Note text'], { type: 'textarea' })]),
  'team.complete_handover': row(['完成交接', 'Complete handover'], 'handover', field('id', ['交接單 ID', 'Handover ID']), [version, { ...teamAssignee, optional: false }], true),
  'team.create_delivery': form(['新增交付計畫', 'Create delivery'], [title, description, array('items', ['交付項目（JSON 陣列，含 title 與 status）', 'Delivery items (JSON array with title and status)'])], { tab: 'delivery' }),
  'team.publish_delivery': row(['發布交付計畫', 'Publish delivery'], 'delivery', teamDelivery, [version], true),
  'team.preview_share': row(['預覽交付分享', 'Preview delivery share'], 'delivery', deliveryId),
  'team.create_share': row(['建立交付分享', 'Create delivery share'], 'delivery', deliveryId, [field('previewVersion', ['預覽版本', 'Preview version'], { type: 'number' }), lines('permissions', ['權限（每行一筆，必含 view）', 'Permissions (one per line, including view)']), instant('expiresAt', ['到期時間', 'Expires at'])], true),
  'team.revoke_share': row(['撤銷交付分享', 'Revoke delivery share'], 'share', field('id', ['分享 ID', 'Share ID']), [version], true),
};
