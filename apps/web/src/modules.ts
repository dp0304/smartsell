export type Label = readonly [zh: string, en: string];
export type ReadUnavailable = 'missing' | 'unmounted';
export interface Resource {
  key: string;
  label: Label;
  path: string;
  detail?: string;
  fields?: string[];
  // Kernel availability is separate from the signed-in user's catalog permissions.
  listUnavailable?: ReadUnavailable;
  detailUnavailable?: 'missing';
}
export interface Module { key: string; route: string; label: Label; description: Label; resources: Resource[] }
const resource = (key: string, zh: string, en: string, path: string, detail?: string, fields?: string[]): Resource => ({ key, label: [zh, en], path, detail, fields });
const missing = (entry: Resource): Resource => ({ ...entry, listUnavailable: 'missing' });
const noDetail = (entry: Resource): Resource => ({ ...entry, detailUnavailable: 'missing' });
const tenantAdmin = (key: string, zh: string, en: string, path: string): Resource => ({ ...resource(key, zh, en, `/admin/${path}`), listUnavailable: 'unmounted' });

export const modules: Module[] = [
  { key: 'workspace', route: 'settings/brands', label: ['品牌與工作區', 'Brands & workspace'], description: ['管理品牌與團隊工作項目。', 'Manage brands and team work items.'], resources: [
    resource('brands', '品牌', 'Brands', '/brands', '/brands/:id', ['name', 'slug', 'status']),
    resource('work', '工作項目', 'Work items', '/work-items', '/work-items/:id', ['title', 'status', 'due_at']),
    resource('notifications', '通知', 'Notifications', '/notifications', undefined, ['title', 'status', 'created_at']),
    resource('summary', '營運概覽', 'Operations summary', '/overview/summary'),
    resource('personal', '個人待辦', 'Personal inbox', '/me/inbox'),
    missing(resource('setup', '首次設定', 'Initial setup', '/onboarding', '/onboarding/:flow')),
  ] },
  { key: 'campaign', route: 'campaigns', label: ['行銷活動', 'Campaigns'], description: ['從活動目標與期間開始，串接內容與商品。', 'Set the campaign window and connect content and products.'], resources: [
    resource('campaigns', '活動', 'Campaigns', '/campaigns', '/campaigns/:id', ['name', 'status', 'kind', 'starts_at', 'ends_at']),
    resource('templates', '活動範本', 'Campaign templates', '/campaign-templates', '/campaign-templates/:id'),
  ] },
  { key: 'commerce', route: 'commerce', label: ['商品與市場', 'Commerce'], description: ['建立店鋪、匯入商品，查閱 SKU 與商品事實。', 'Set up stores, import products, and review SKUs and product facts.'], resources: [
    resource('products', '商品', 'Products', '/products', '/products/:id', ['title', 'sku', 'status', 'store_id']),
    resource('stores', '店鋪', 'Stores', '/stores', '/stores/:id', ['name', 'provider', 'status', 'default_currency']),
    resource('changes', '商品變更', 'Product changes', '/change-events'),
    resource('mapping', 'SKU 對照', 'SKU mapping', '/variant-groups'),
    resource('promotions', '促銷', 'Promotions', '/promotions', '/promotions/:id'),
    resource('orders', '訂單', 'Orders', '/orders', '/orders/:id'),
    resource('refunds', '退款', 'Refunds', '/refunds'),
  ] },
  { key: 'content', route: 'content', label: ['內容工作台', 'Content studio'], description: ['整理選題、製作多市場變體，將修訂交給排期。', 'Develop ideas and market variants, then hand revisions to scheduling.'], resources: [
    resource('content', '內容項目', 'Content items', '/content-items', '/content-items/:id', ['title', 'production_stage', 'campaign_id', 'production_due_at']),
    resource('ideas', '選題', 'Ideas', '/ideas', '/ideas/:id'),
    resource('pillars', '欄目', 'Pillars', '/content-pillars', '/content-pillars/:id'),
    resource('feeds', '內容來源', 'Content feeds', '/feeds', '/feeds/:id'),
  ] },
  { key: 'planning', route: 'calendar', label: ['發布日曆', 'Publishing calendar'], description: ['核對排期、預檢與審批狀態。', 'Review schedules, preflight checks, and approvals.'], resources: [
    resource('targets', '發布目標', 'Publish targets', '/publish-targets', '/publish-targets/:id', ['title', 'display_status', 'scheduled_at', 'social_account_id']),
    resource('approvals', '待我審批', 'My approvals', '/approvals', undefined, ['title', 'status', 'target_id', 'created_at']),
    noDetail(resource('policies', '審批政策', 'Approval policies', '/approval-policies')),
    resource('pauses', '發布暫停', 'Publishing pauses', '/pause-switches', '/pause-switches/:id', ['reason', 'mode', 'activated_at', 'released_at']),
    resource('queues', '常青佇列', 'Evergreen queues', '/evergreen-queues', '/evergreen-queues/:id'),
    resource('reconcile', '原生作品對帳', 'Post reconciliation', '/reconciliation/candidates'),
  ] },
  { key: 'execution', route: 'execution', label: ['執行監控', 'Execution monitor'], description: ['先核實未知結果，再依任務指引人工回填。', 'Reconcile unknown outcomes and record manual completion.'], resources: [
    resource('tasks', '執行任務', 'Execution tasks', '/execution-tasks', '/execution-tasks/:id', ['title', 'status', 'sub_status', 'executor']),
    resource('posts', '平台作品', 'Platform posts', '/platform-posts', '/platform-posts/:id', ['title', 'origin', 'verification', 'published_at']),
    resource('exceptions', '執行異常', 'Execution exceptions', '/execution-exceptions'),
  ] },
  { key: 'inbox', route: 'inbox', label: ['統一收件箱', 'Inbox'], description: ['檢視對話、建立回覆草稿並提交審核。', 'Review conversations, draft replies, and submit for approval.'], resources: [
    resource('conversations', '對話', 'Conversations', '/conversations', '/conversations/:id', ['subject', 'status', 'platform', 'updated_at']),
    missing(noDetail(resource('tags', '標籤', 'Tags', '/inbox/tags'))),
    resource('reviews', '公開評價', 'Public reviews', '/reviews', '/reviews/:id', ['rating', 'scale_max', 'status', 'source_url']),
    noDetail(resource('reviewSources', '評價來源', 'Review sources', '/inbox/review-sources', undefined, ['label', 'mode', 'source_url'])),
    resource('coverage', '渠道覆蓋', 'Channel coverage', '/inbox/coverage'),
    resource('cases', '案件', 'Cases', '/cases', '/cases/:id'),
    resource('businessHours', '營業時間', 'Business hours', '/inbox/business-hours', '/inbox/business-hours/:id'),
    resource('sla', '時限政策', 'SLA policies', '/inbox/sla-policies', '/inbox/sla-policies/:id'),
    resource('autoRules', '自動化規則', 'Inbox automation rules', '/inbox/auto-rules', '/inbox/auto-rules/:id'),
    missing(resource('inboxReports', '收件箱報告', 'Inbox reports', '/inbox/reports')),
  ] },
  { key: 'analytics', route: 'reports', label: ['數據與報告', 'Analytics & reports'], description: ['查看作品成效，定義報告並產生版本。', 'Inspect post performance and generate report versions.'], resources: [
    resource('reports', '報告', 'Reports', '/reports', '/reports/:id', ['title', 'kind', 'status', 'updated_at']),
    resource('performance', '作品成效', 'Post performance', '/performance/posts', '/performance/posts/:id/history'),
    resource('metrics', '指標字典', 'Metric definitions', '/metric-definitions', '/metric-definitions/:id', ['key', 'name', 'unit', 'availability']),
    resource('accountPerformance', '帳號成效', 'Account performance', '/performance/accounts'),
    resource('linkPerformance', '短連結成效', 'Link performance', '/performance/links'),
    resource('attribution', '歸因模型', 'Attribution models', '/attribution-models'),
    resource('revenue', '收入', 'Revenue', '/revenue/daily'),
    resource('contribution', '估算貢獻', 'Estimated contribution', '/contribution'),
    resource('cohorts', '客群', 'Cohorts', '/cohorts', '/cohorts/:id'),
    resource('experiments', '實驗', 'Experiments', '/experiments', '/experiments/:id', ['hypothesis', 'status', 'updated_at']),
    resource('audience', '受眾洞察', 'Audience insights', '/audience-insights'),
  ] },
  { key: 'asset', route: 'assets', label: ['素材中心', 'Asset library'], description: ['管理素材、使用授權與品牌知識。', 'Manage assets, rights, and brand knowledge.'], resources: [
    resource('assets', '素材', 'Assets', '/assets', '/assets/:id'),
    resource('rights', '使用授權', 'Rights grants', '/rights-grants', '/rights-grants/:id'),
    resource('knowledge', '品牌知識', 'Knowledge', '/knowledge', '/knowledge/:id'),
    resource('templates', '素材範本', 'Asset templates', '/templates', '/templates/:id'),
    resource('submissions', '投稿箱', 'Submission boxes', '/submission-boxes', '/submission-boxes/:id'),
  ] },
  { key: 'intel', route: 'research', label: ['情報研究', 'Research'], description: ['追蹤競品、整理研究板及候選商品。', 'Track competitors, research boards, and product candidates.'], resources: [
    resource('watch', '監測對象', 'Watch targets', '/watch-targets', '/watch-targets/:id'),
    resource('boards', '研究板', 'Research boards', '/research-boards', '/research-boards/:id'),
    resource('candidates', '候選商品', 'Product candidates', '/product-candidates', '/product-candidates/:id'),
    resource('creatives', '創意參考', 'Creative references', '/creative-references'),
    resource('compare', '競品比較', 'Competitor comparison', '/research/compare'),
    resource('trends', '話題趨勢', 'Topic trends', '/topics', '/topics/:id/trend'),
    resource('alerts', '警示', 'Alerts', '/alerts'),
    resource('mentions', '提及', 'Mentions', '/mentions'),
  ] },
  { key: 'creator', route: 'creators', label: ['達人合作', 'Creator partnerships'], description: ['管理達人名錄、合作案與佣金。', 'Manage creators, collaborations, and commissions.'], resources: [
    resource('creators', '達人', 'Creators', '/creators', '/creators/:id'),
    resource('collabs', '合作案', 'Collaborations', '/collaborations', '/collaborations/:id'),
    resource('commissions', '佣金明細', 'Commissions', '/commission-entries'),
    resource('shipments', '樣品寄送', 'Sample shipments', '/sample-shipments'),
    resource('settlements', '結算批次', 'Settlement batches', '/settlement-batches'),
    resource('live', '直播企劃', 'Live sessions', '/live-sessions', '/live-sessions/:id'),
  ] },
  { key: 'traffic', route: 'traffic', label: ['導流與線索', 'Traffic & leads'], description: ['查閱短連結與銷售線索。', 'Browse short links and sales leads.'], resources: [
    resource('links', '短連結', 'Short links', '/short-links', '/short-links/:id'),
    resource('leads', '線索', 'Leads', '/leads', '/leads/:id'),
    resource('destinations', '承接網址', 'Landing destinations', '/landing-destinations'),
    resource('checks', '網址檢查', 'URL checks', '/page-checks', undefined, ['target_id', 'status', 'checked_at']),
    resource('domains', '網域', 'Domains', '/link-domains'),
    resource('utm', 'UTM 範本', 'UTM templates', '/utm-templates'),
    resource('pages', '導流頁', 'Landing pages', '/landing-pages', '/landing-pages/:id/versions'),
    resource('bio', '主頁連結', 'Link in bio', '/bio-pages', '/bio-pages/:id/items'),
    resource('forms', '表單', 'Forms', '/forms', '/forms/:id/versions'),
  ] },
  { key: 'ads', route: 'ads', label: ['廣告管理', 'Paid advertising'], description: ['查閱廣告帳號、投放實體與調整建議。', 'Inspect ad accounts, placements, and adjustment suggestions.'], resources: [
    noDetail(resource('adaccounts', '廣告帳號', 'Ad accounts', '/ad-accounts')),
    resource('adentities', '廣告實體', 'Ad entities', '/ad-entities'),
    resource('adjustments', '調整建議', 'Adjustments', '/adjustment-suggestions'),
    resource('performance', '廣告成效', 'Ad performance', '/ads/performance'),
    resource('creatives', '廣告創意', 'Ad creatives', '/ad-creatives', '/ad-creatives/:id/variants'),
    resource('proposals', '廣告提案', 'Ad proposals', '/ad-proposals', '/ad-proposals/:id'),
    missing(resource('operations', '廣告操作', 'Ad operations', '/ad-operations', '/ad-operations/:id')),
  ] },
  { key: 'lifecycle', route: 'lifecycle', label: ['生命週期行銷', 'Lifecycle marketing'], description: ['查閱客戶、同意衝突及外部流程。', 'Review customers, consent conflicts, and external flows.'], resources: [
    resource('customers', '客戶', 'Customers', '/customers', '/customers/:id'),
    resource('consent', '同意衝突', 'Consent conflicts', '/consent-conflicts'),
    resource('flows', '行銷流程', 'Marketing flows', '/esp-flows'),
    resource('consentTexts', '同意文字', 'Consent texts', '/consent-texts', '/consent-texts/:id'),
    resource('segments', '客戶分群', 'Customer segments', '/segments', '/segments/:id'),
    resource('espCampaigns', '生命週期活動', 'Lifecycle campaigns', '/esp-campaigns', '/esp-campaigns/:id'),
    resource('health', '寄送健康', 'Deliverability health', '/lifecycle/health'),
  ] },
  { key: 'ingest', route: 'data', label: ['採集與匯入', 'Data & imports'], description: ['管理資料源，預覽匯入批次與品質問題。', 'Manage sources, preview imports, and review quality issues.'], resources: [
    resource('sources', '資料源', 'Data sources', '/data-sources', '/data-sources/:id'),
    resource('imports', '匯入批次', 'Import batches', '/imports', '/imports/:id', ['template_key', 'status', 'updated_at']),
    resource('templates', '匯入模板', 'Import templates', '/import-templates'),
    resource('sync', '同步紀錄', 'Sync runs', '/sync-runs', '/sync-runs/:id'),
    noDetail(resource('quality', '品質問題', 'Quality issues', '/data-quality/issues')),
    resource('backfills', '回補任務', 'Backfill jobs', '/backfills', '/backfills/:id'),
    resource('health', '資料健康', 'Data health', '/data-health'),
    resource('gaps', '資料缺口', 'Data gaps', '/data-gaps'),
    resource('usage', '供應商用量', 'Vendor usage', '/vendor-usage'),
    resource('budgets', '採集預算', 'Collection budgets', '/collection-budgets'),
  ] },
  { key: 'agent', route: 'automation', label: ['AI 與自動化', 'AI & automation'], description: ['檢視 Agent 工作、自動化規則與 MCP 連接。', 'Inspect agent jobs, automation rules, and MCP connections.'], resources: [
    resource('jobs', 'Agent 工作', 'Agent jobs', '/agent-jobs', '/agent-jobs/:id'),
    noDetail(resource('rules', '自動化規則', 'Automation rules', '/automation-rules')),
    missing(resource('mcp', 'MCP 連接', 'MCP connections', '/mcp/connections')),
    missing(resource('changeSets', '變更集', 'Change sets', '/change-sets', '/change-sets/:id')),
    resource('templates', '流程範本', 'Workflow templates', '/workflow-templates', '/workflow-templates/:id'),
    resource('models', '模型供應商', 'Model providers', '/model-providers'),
    resource('modelRoutes', '模型用途路由', 'Model routes', '/model-routes'),
  ] },
  { key: 'account', route: 'settings/accounts', label: ['帳號與裝置', 'Accounts & devices'], description: ['查閱社群帳號、授權連接及本地裝置。', 'Inspect social accounts, integrations, and local devices.'], resources: [
    resource('accounts', '社群帳號', 'Social accounts', '/social-accounts', '/social-accounts/:id', ['display_name', 'platform', 'status', 'handle']),
    resource('connections', '授權連接', 'Connections', '/connections', '/connections/:id/accounts'),
    resource('devices', '本地裝置', 'Devices', '/devices'),
    noDetail(resource('blocks', '帳號阻塞', 'Account blocks', '/account-blocks')),
    resource('platformApps', '平台應用', 'Platform apps', '/platform-apps'),
    resource('mobile', '手機裝置', 'Mobile devices', '/mobile-devices'),
    resource('connectorAutomation', '連接器自動模式', 'Connector automation', '/connector-auto-policy'),
  ] },
  { key: 'team', route: 'settings/members', label: ['成員與交付', 'Team & delivery'], description: ['查閱成員、交接與客戶交付計畫。', 'Browse members, handovers, and client delivery plans.'], resources: [
    resource('members', '成員', 'Members', '/members', undefined, ['name', 'email', 'role', 'status']),
    noDetail(resource('handover', '交接單', 'Handovers', '/handovers')),
    noDetail(resource('delivery', '交付計畫', 'Delivery plans', '/delivery-plans')),
    resource('workload', '工作量', 'Workload', '/workload'),
    resource('templates', '團隊範本', 'Team templates', '/team/templates'),
    resource('branding', '門戶品牌化', 'Portal branding', '/branding'),
    resource('shares', '對外分享', 'External shares', '/shares'),
  ] },
  { key: 'ops', route: 'settings/ops', label: ['系統管理', 'System administration'], description: ['查閱部署健康、佇列與稽核紀錄。', 'Inspect deployment health, queues, and audit events.'], resources: [
    resource('health', '工作區健康', 'Workspace health', '/admin/workspace-health'),
    tenantAdmin('queues', '佇列任務', 'Queue jobs', 'jobs'),
    resource('audit', '稽核事件', 'Audit events', '/admin/audit-events'),
    noDetail(tenantAdmin('webhooks', 'Webhook 訂閱', 'Webhook subscriptions', 'webhook-subscriptions')),
    tenantAdmin('system', '部署健康', 'Deployment health', 'health'),
    tenantAdmin('settings', '部署設定', 'Deployment settings', 'settings'),
    tenantAdmin('tenantMembers', '租戶成員', 'Tenant members', 'members'),
    tenantAdmin('credentials', '憑證', 'Credentials', 'credentials'),
    tenantAdmin('egress', '外送政策', 'Egress policies', 'egress-policies'),
    tenantAdmin('retention', '保留政策', 'Retention policies', 'retention-policies'),
    tenantAdmin('backup', '備份紀錄', 'Backup runs', 'backup-runs'),
    tenantAdmin('releases', '部署版本', 'System releases', 'releases'),
    tenantAdmin('license', '授權', 'License', 'license'),
  ] },
];
