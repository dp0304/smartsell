export type Label = readonly [zh: string, en: string, hans?: string];
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
const resource = (key: string, label: Label, path: string, detail?: string, fields?: string[]): Resource => ({ key, label, path, detail, fields });
const missing = (entry: Resource): Resource => ({ ...entry, listUnavailable: 'missing' });
const noDetail = (entry: Resource): Resource => ({ ...entry, detailUnavailable: 'missing' });
const tenantAdmin = (key: string, label: Label, path: string): Resource => ({ ...resource(key, label, `/admin/${path}`), listUnavailable: 'unmounted' });

export const modules: Module[] = [
  { key: 'workspace', route: 'settings/brands', label: ['品牌與工作區', 'Brands & workspace', '品牌与工作区'], description: ['管理品牌與團隊工作項目。', 'Manage brands and team work items.', '管理品牌与团队工作项目。'], resources: [
    resource('brands', ['品牌', 'Brands'], '/brands', '/brands/:id', ['name', 'slug', 'status']),
    resource('work', ['工作項目', 'Work items', '工作项目'], '/work-items', '/work-items/:id', ['title', 'status', 'due_at']),
    resource('notifications', ['通知', 'Notifications'], '/notifications', undefined, ['title', 'status', 'created_at']),
    resource('summary', ['營運概覽', 'Operations summary', '运营概览'], '/overview/summary'),
    resource('personal', ['個人待辦', 'Personal inbox', '个人待办'], '/me/inbox'),
    missing(resource('setup', ['首次設定', 'Initial setup', '首次设置'], '/onboarding', '/onboarding/:flow')),
  ] },
  { key: 'campaign', route: 'campaigns', label: ['行銷活動', 'Campaigns', '行销活动'], description: ['從活動目標與期間開始，串接內容與商品。', 'Set the campaign window and connect content and products.', '从活动目标与期间开始，对接内容与商品。'], resources: [
    resource('campaigns', ['活動', 'Campaigns', '活动'], '/campaigns', '/campaigns/:id', ['name', 'status', 'kind', 'starts_at', 'ends_at']),
    resource('templates', ['活動範本', 'Campaign templates', '活动范本'], '/campaign-templates', '/campaign-templates/:id'),
  ] },
  { key: 'commerce', route: 'commerce', label: ['商品與市場', 'Commerce', '商品与市场'], description: ['建立店鋪、匯入商品，查閱 SKU 與商品事實。', 'Set up stores, import products, and review SKUs and product facts.', '创建店铺、导入商品，查阅 SKU 与商品事实。'], resources: [
    resource('products', ['商品', 'Products'], '/products', '/products/:id', ['title', 'sku', 'status', 'store_id']),
    resource('stores', ['店鋪', 'Stores', '店铺'], '/stores', '/stores/:id', ['name', 'provider', 'status', 'default_currency']),
    resource('changes', ['商品變更', 'Product changes', '商品变更'], '/change-events'),
    resource('mapping', ['SKU 對照', 'SKU mapping', 'SKU 对照'], '/variant-groups'),
    resource('promotions', ['促銷', 'Promotions', '促销'], '/promotions', '/promotions/:id'),
    resource('orders', ['訂單', 'Orders', '订单'], '/orders', '/orders/:id'),
    resource('refunds', ['退款', 'Refunds'], '/refunds'),
  ] },
  { key: 'content', route: 'content', label: ['內容工作台', 'Content studio', '内容工作台'], description: ['整理選題、製作多市場變體，將修訂交給排期。', 'Develop ideas and market variants, then hand revisions to scheduling.', '整理选题、制作多市场变体，将修订交给排期。'], resources: [
    resource('content', ['內容項目', 'Content items', '内容项目'], '/content-items', '/content-items/:id', ['title', 'production_stage', 'campaign_id', 'production_due_at']),
    resource('ideas', ['選題', 'Ideas', '选题'], '/ideas', '/ideas/:id'),
    resource('pillars', ['欄目', 'Pillars', '栏目'], '/content-pillars', '/content-pillars/:id'),
    resource('feeds', ['內容來源', 'Content feeds', '内容来源'], '/feeds', '/feeds/:id'),
  ] },
  { key: 'planning', route: 'calendar', label: ['發布日曆', 'Publishing calendar', '发布日历'], description: ['核對排期、預檢與審批狀態。', 'Review schedules, preflight checks, and approvals.', '核对排期、预检与审批状态。'], resources: [
    resource('targets', ['發布目標', 'Publish targets', '发布目标'], '/publish-targets', '/publish-targets/:id', ['title', 'display_status', 'scheduled_at', 'social_account_id']),
    resource('approvals', ['待我審批', 'My approvals', '待我审批'], '/approvals', undefined, ['title', 'status', 'target_id', 'created_at']),
    noDetail(resource('policies', ['審批政策', 'Approval policies', '审批政策'], '/approval-policies')),
    resource('pauses', ['發布暫停', 'Publishing pauses', '发布暂停'], '/pause-switches', '/pause-switches/:id', ['reason', 'mode', 'activated_at', 'released_at']),
    resource('queues', ['常青佇列', 'Evergreen queues', '常青队列'], '/evergreen-queues', '/evergreen-queues/:id'),
    resource('reconcile', ['原生作品對帳', 'Post reconciliation', '原生作品对帐'], '/reconciliation/candidates'),
  ] },
  { key: 'execution', route: 'execution', label: ['執行監控', 'Execution monitor', '运行监控'], description: ['先核實未知結果，再依任務指引人工回填。', 'Reconcile unknown outcomes and record manual completion.', '先核实未知结果，再依任务指引人工回填。'], resources: [
    resource('tasks', ['執行任務', 'Execution tasks', '运行任务'], '/execution-tasks', '/execution-tasks/:id', ['title', 'status', 'sub_status', 'executor']),
    resource('posts', ['平台作品', 'Platform posts'], '/platform-posts', '/platform-posts/:id', ['title', 'origin', 'verification', 'published_at']),
    resource('exceptions', ['執行異常', 'Execution exceptions', '运行异常'], '/execution-exceptions'),
  ] },
  { key: 'inbox', route: 'inbox', label: ['統一收件箱', 'Inbox', '统一收件箱'], description: ['檢視對話、建立回覆草稿並提交審核。', 'Review conversations, draft replies, and submit for approval.', '查看对话、创建回复草稿并提交审核。'], resources: [
    resource('conversations', ['對話', 'Conversations', '对话'], '/conversations', '/conversations/:id', ['subject', 'status', 'platform', 'updated_at']),
    missing(noDetail(resource('tags', ['標籤', 'Tags', '标签'], '/inbox/tags'))),
    resource('reviews', ['公開評價', 'Public reviews', '公开评价'], '/reviews', '/reviews/:id', ['rating', 'scale_max', 'status', 'source_url']),
    noDetail(resource('reviewSources', ['評價來源', 'Review sources', '评价来源'], '/inbox/review-sources', undefined, ['label', 'mode', 'source_url'])),
    resource('coverage', ['渠道覆蓋', 'Channel coverage', '渠道覆盖'], '/inbox/coverage'),
    resource('cases', ['案件', 'Cases'], '/cases', '/cases/:id'),
    resource('businessHours', ['營業時間', 'Business hours', '营业时间'], '/inbox/business-hours', '/inbox/business-hours/:id'),
    resource('sla', ['時限政策', 'SLA policies', '时限政策'], '/inbox/sla-policies', '/inbox/sla-policies/:id'),
    resource('autoRules', ['自動化規則', 'Inbox automation rules', '自动化规则'], '/inbox/auto-rules', '/inbox/auto-rules/:id'),
    missing(resource('inboxReports', ['收件箱報告', 'Inbox reports', '收件箱报告'], '/inbox/reports')),
  ] },
  { key: 'analytics', route: 'reports', label: ['數據與報告', 'Analytics & reports', '数据与报告'], description: ['查看作品成效，定義報告並產生版本。', 'Inspect post performance and generate report versions.', '查看作品成效，定义报告并产生版本。'], resources: [
    resource('reports', ['報告', 'Reports', '报告'], '/reports', '/reports/:id', ['title', 'kind', 'status', 'updated_at']),
    resource('performance', ['作品成效', 'Post performance'], '/performance/posts', '/performance/posts/:id/history'),
    resource('metrics', ['指標字典', 'Metric definitions', '指标字典'], '/metric-definitions', '/metric-definitions/:id', ['key', 'name', 'unit', 'availability']),
    resource('accountPerformance', ['帳號成效', 'Account performance', '账号成效'], '/performance/accounts'),
    resource('linkPerformance', ['短連結成效', 'Link performance', '短链接成效'], '/performance/links'),
    resource('attribution', ['歸因模型', 'Attribution models', '归因模型'], '/attribution-models'),
    resource('revenue', ['收入', 'Revenue'], '/revenue/daily'),
    resource('contribution', ['估算貢獻', 'Estimated contribution', '估算贡献'], '/contribution'),
    resource('cohorts', ['客群', 'Cohorts'], '/cohorts', '/cohorts/:id'),
    resource('experiments', ['實驗', 'Experiments', '实验'], '/experiments', '/experiments/:id', ['hypothesis', 'status', 'updated_at']),
    resource('audience', ['受眾洞察', 'Audience insights', '受众洞察'], '/audience-insights'),
  ] },
  { key: 'asset', route: 'assets', label: ['素材中心', 'Asset library'], description: ['管理素材、使用授權與品牌知識。', 'Manage assets, rights, and brand knowledge.', '管理素材、使用授权与品牌知识。'], resources: [
    resource('assets', ['素材', 'Assets'], '/assets', '/assets/:id'),
    resource('rights', ['使用授權', 'Rights grants', '使用授权'], '/rights-grants', '/rights-grants/:id'),
    resource('knowledge', ['品牌知識', 'Knowledge', '品牌知识'], '/knowledge', '/knowledge/:id'),
    resource('templates', ['素材範本', 'Asset templates', '素材范本'], '/templates', '/templates/:id'),
    resource('submissions', ['投稿箱', 'Submission boxes'], '/submission-boxes', '/submission-boxes/:id'),
  ] },
  { key: 'intel', route: 'research', label: ['情報研究', 'Research', '情报研究'], description: ['追蹤競品、整理研究板及候選商品。', 'Track competitors, research boards, and product candidates.', '追踪竞品、整理研究板及候选商品。'], resources: [
    resource('watch', ['監測對象', 'Watch targets', '监测对象'], '/watch-targets', '/watch-targets/:id'),
    resource('boards', ['研究板', 'Research boards'], '/research-boards', '/research-boards/:id'),
    resource('candidates', ['候選商品', 'Product candidates', '候选商品'], '/product-candidates', '/product-candidates/:id'),
    resource('creatives', ['創意參考', 'Creative references', '创意参考'], '/creative-references'),
    resource('compare', ['競品比較', 'Competitor comparison', '竞品比较'], '/research/compare'),
    resource('trends', ['話題趨勢', 'Topic trends', '话题趋势'], '/topics', '/topics/:id/trend'),
    resource('alerts', ['警示', 'Alerts'], '/alerts'),
    resource('mentions', ['提及', 'Mentions'], '/mentions'),
  ] },
  { key: 'creator', route: 'creators', label: ['達人合作', 'Creator partnerships', '达人合作'], description: ['管理達人名錄、合作案與佣金。', 'Manage creators, collaborations, and commissions.', '管理达人名录、合作案与佣金。'], resources: [
    resource('creators', ['達人', 'Creators', '达人'], '/creators', '/creators/:id'),
    resource('collabs', ['合作案', 'Collaborations'], '/collaborations', '/collaborations/:id'),
    resource('commissions', ['佣金明細', 'Commissions', '佣金明细'], '/commission-entries'),
    resource('shipments', ['樣品寄送', 'Sample shipments', '样品寄送'], '/sample-shipments'),
    resource('settlements', ['結算批次', 'Settlement batches', '结算批量'], '/settlement-batches'),
    resource('live', ['直播企劃', 'Live sessions', '直播企划'], '/live-sessions', '/live-sessions/:id'),
  ] },
  { key: 'traffic', route: 'traffic', label: ['導流與線索', 'Traffic & leads', '导流与线索'], description: ['查閱短連結與銷售線索。', 'Browse short links and sales leads.', '查阅短链接与销售线索。'], resources: [
    resource('links', ['短連結', 'Short links', '短链接'], '/short-links', '/short-links/:id'),
    resource('leads', ['線索', 'Leads', '线索'], '/leads', '/leads/:id'),
    resource('destinations', ['承接網址', 'Landing destinations', '承接网址'], '/landing-destinations'),
    resource('checks', ['網址檢查', 'URL checks', '网址检查'], '/page-checks', undefined, ['target_id', 'status', 'checked_at']),
    resource('domains', ['網域', 'Domains', '网域'], '/link-domains'),
    resource('utm', ['UTM 範本', 'UTM templates', 'UTM 范本'], '/utm-templates'),
    resource('pages', ['導流頁', 'Landing pages', '导流页'], '/landing-pages', '/landing-pages/:id/versions'),
    resource('bio', ['主頁連結', 'Link in bio', '主页链接'], '/bio-pages', '/bio-pages/:id/items'),
    resource('forms', ['表單', 'Forms', '表单'], '/forms', '/forms/:id/versions'),
  ] },
  { key: 'ads', route: 'ads', label: ['廣告管理', 'Paid advertising', '广告管理'], description: ['查閱廣告帳號、投放實體與調整建議。', 'Inspect ad accounts, placements, and adjustment suggestions.', '查阅广告账号、投放实体与调整建议。'], resources: [
    noDetail(resource('adaccounts', ['廣告帳號', 'Ad accounts', '广告账号'], '/ad-accounts')),
    resource('adentities', ['廣告實體', 'Ad entities', '广告实体'], '/ad-entities'),
    resource('adjustments', ['調整建議', 'Adjustments', '调整建议'], '/adjustment-suggestions'),
    resource('performance', ['廣告成效', 'Ad performance', '广告成效'], '/ads/performance'),
    resource('creatives', ['廣告創意', 'Ad creatives', '广告创意'], '/ad-creatives', '/ad-creatives/:id/variants'),
    resource('proposals', ['廣告提案', 'Ad proposals', '广告提案'], '/ad-proposals', '/ad-proposals/:id'),
    missing(resource('operations', ['廣告操作', 'Ad operations', '广告操作'], '/ad-operations', '/ad-operations/:id')),
  ] },
  { key: 'lifecycle', route: 'lifecycle', label: ['生命週期行銷', 'Lifecycle marketing', '生命周期行销'], description: ['查閱客戶、同意衝突及外部流程。', 'Review customers, consent conflicts, and external flows.', '查阅客户、同意冲突及外部流程。'], resources: [
    resource('customers', ['客戶', 'Customers', '客户'], '/customers', '/customers/:id'),
    resource('consent', ['同意衝突', 'Consent conflicts', '同意冲突'], '/consent-conflicts'),
    resource('flows', ['行銷流程', 'Marketing flows', '行销流程'], '/esp-flows'),
    resource('consentTexts', ['同意文字', 'Consent texts'], '/consent-texts', '/consent-texts/:id'),
    resource('segments', ['客戶分群', 'Customer segments', '客户分群'], '/segments', '/segments/:id'),
    resource('espCampaigns', ['生命週期活動', 'Lifecycle campaigns', '生命周期活动'], '/esp-campaigns', '/esp-campaigns/:id'),
    resource('health', ['寄送健康', 'Deliverability health'], '/lifecycle/health'),
  ] },
  { key: 'ingest', route: 'data', label: ['採集與匯入', 'Data & imports', '采集与导入'], description: ['管理資料源，預覽匯入批次與品質問題。', 'Manage sources, preview imports, and review quality issues.', '管理数据源，预览导入批量与品质问题。'], resources: [
    resource('sources', ['資料源', 'Data sources', '数据源'], '/data-sources', '/data-sources/:id'),
    resource('imports', ['匯入批次', 'Import batches', '导入批量'], '/imports', '/imports/:id', ['template_key', 'status', 'updated_at']),
    resource('templates', ['匯入模板', 'Import templates', '导入模板'], '/import-templates'),
    resource('sync', ['同步紀錄', 'Sync runs', '同步记录'], '/sync-runs', '/sync-runs/:id'),
    noDetail(resource('quality', ['品質問題', 'Quality issues', '品质问题'], '/data-quality/issues')),
    resource('backfills', ['回補任務', 'Backfill jobs', '回补任务'], '/backfills', '/backfills/:id'),
    resource('health', ['資料健康', 'Data health', '数据健康'], '/data-health'),
    resource('gaps', ['資料缺口', 'Data gaps', '数据缺口'], '/data-gaps'),
    resource('usage', ['供應商用量', 'Vendor usage', '供应商用量'], '/vendor-usage'),
    resource('budgets', ['採集預算', 'Collection budgets', '采集预算'], '/collection-budgets'),
  ] },
  { key: 'agent', route: 'automation', label: ['AI 與自動化', 'AI & automation', 'AI 与自动化'], description: ['檢視 Agent 工作、自動化規則與 MCP 連接。', 'Inspect agent jobs, automation rules, and MCP connections.', '查看 Agent 工作、自动化规则与 MCP 连接。'], resources: [
    resource('jobs', ['Agent 工作', 'Agent jobs'], '/agent-jobs', '/agent-jobs/:id'),
    noDetail(resource('rules', ['自動化規則', 'Automation rules', '自动化规则'], '/automation-rules')),
    missing(resource('mcp', ['MCP 連接', 'MCP connections', 'MCP 连接'], '/mcp/connections')),
    missing(resource('changeSets', ['變更集', 'Change sets', '变更集'], '/change-sets', '/change-sets/:id')),
    resource('templates', ['流程範本', 'Workflow templates', '流程范本'], '/workflow-templates', '/workflow-templates/:id'),
    resource('models', ['模型供應商', 'Model providers', '模型供应商'], '/model-providers'),
    resource('modelRoutes', ['模型用途路由', 'Model routes'], '/model-routes'),
  ] },
  { key: 'account', route: 'settings/accounts', label: ['帳號與裝置', 'Accounts & devices', '账号与设备'], description: ['查閱社群帳號、授權連接及本地裝置。', 'Inspect social accounts, integrations, and local devices.', '查阅社交媒体账号、授权连接及本地设备。'], resources: [
    resource('accounts', ['社群帳號', 'Social accounts', '社交媒体账号'], '/social-accounts', '/social-accounts/:id', ['display_name', 'provider', 'status', 'handle']),
    resource('connections', ['授權連接', 'Connections', '授权连接'], '/connections', '/connections/:id/accounts'),
    resource('devices', ['本地裝置', 'Devices', '本地设备'], '/devices'),
    noDetail(resource('blocks', ['帳號阻塞', 'Account blocks', '账号阻塞'], '/account-blocks')),
    resource('platformApps', ['平台應用', 'Platform apps', '平台应用'], '/platform-apps'),
    resource('mobile', ['手機裝置', 'Mobile devices', '手机设备'], '/mobile-devices'),
    resource('connectorAutomation', ['連接器自動模式', 'Connector automation', '连接器自动模式'], '/connector-auto-policy'),
  ] },
  { key: 'team', route: 'settings/members', label: ['成員與交付', 'Team & delivery', '成员与交付'], description: ['查閱成員、交接與客戶交付計畫。', 'Browse members, handovers, and client delivery plans.', '查阅成员、交接与客户交付计划。'], resources: [
    resource('members', ['成員', 'Members', '成员'], '/members', undefined, ['name', 'email', 'role', 'status']),
    noDetail(resource('handover', ['交接單', 'Handovers', '交接单'], '/handovers')),
    noDetail(resource('delivery', ['交付計畫', 'Delivery plans', '交付计划'], '/delivery-plans')),
    resource('workload', ['工作量', 'Workload'], '/workload'),
    resource('templates', ['團隊範本', 'Team templates', '团队范本'], '/team/templates'),
    resource('branding', ['門戶品牌化', 'Portal branding', '门户品牌化'], '/branding'),
    resource('shares', ['對外分享', 'External shares', '对外分享'], '/shares'),
  ] },
  { key: 'ops', route: 'settings/ops', label: ['系統管理', 'System administration', '系统管理'], description: ['查閱部署健康、佇列與稽核紀錄。', 'Inspect deployment health, queues, and audit events.', '查阅部署健康、队列与审核记录。'], resources: [
    resource('health', ['工作區健康', 'Workspace health', '工作区健康'], '/admin/workspace-health'),
    tenantAdmin('queues', ['佇列任務', 'Queue jobs', '队列任务'], 'jobs'),
    resource('audit', ['稽核事件', 'Audit events', '审核事件'], '/admin/audit-events'),
    noDetail(tenantAdmin('webhooks', ['Webhook 訂閱', 'Webhook subscriptions', 'Webhook 订阅'], 'webhook-subscriptions')),
    tenantAdmin('system', ['部署健康', 'Deployment health'], 'health'),
    tenantAdmin('settings', ['部署設定', 'Deployment settings', '部署设置'], 'settings'),
    tenantAdmin('tenantMembers', ['租戶成員', 'Tenant members', '租户成员'], 'members'),
    tenantAdmin('credentials', ['憑證', 'Credentials', '凭证'], 'credentials'),
    tenantAdmin('egress', ['外送政策', 'Egress policies'], 'egress-policies'),
    tenantAdmin('retention', ['保留政策', 'Retention policies'], 'retention-policies'),
    tenantAdmin('backup', ['備份紀錄', 'Backup runs', '备份记录'], 'backup-runs'),
    tenantAdmin('releases', ['部署版本', 'System releases'], 'releases'),
    tenantAdmin('license', ['授權', 'License', '授权'], 'license'),
  ] },
];
