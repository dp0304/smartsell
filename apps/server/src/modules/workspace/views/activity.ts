import { Problem, READ, type Context, type Input, type Operation, type Row } from '@smartsell/contracts';
import { changeOperations } from '../../agent/changes.js';
import { getVisibleJob } from '../../agent/jobs.js';
import { INTERNAL_READ } from '../../campaign/shared.js';
import { brandScope, instant, invalid, limit, timestamp } from '../shared.js';
import { canReadTask } from '../tasks.js';
import { adsReadScope } from './calendar.js';

// Read-model for the agent-first web view. Contract: docs/agent-first-design.md 3.8 and 4.4.
export type Label = [string, string, string?];
type Verb = 'created' | 'updated' | 'submitted' | 'approved' | 'deleted' | 'other';
export interface ActivityItem {
  id: string; occurred_at: string;
  actor: { type: 'agent' | 'human'; user_id: string | null; credential_id: string | null; label: string | null };
  source: 'mcp' | 'rest'; action: string; verb: Verb; summary: Label;
  resource: { type: string | null; id: string | null; title: string | null }; count: number;
}
export interface ActivityQuery { actor?: string; since?: string; brand_id?: string; limit?: string }

const KIND = 'activity_event';
const GROUP_WINDOW_MS = 10 * 60_000;
const ACTIVE_WINDOW_MS = 30 * 86_400_000;

const described: Record<string, [Verb, string, string, string?]> = {
  workspace_brand_create: ['created', '建立了品牌', 'Created a brand', '创建了品牌'],
  workspace_brand_update: ['updated', '更新了品牌', 'Updated a brand'],
  workspace_market_create: ['created', '新增了市場', 'Added a market', '添加了市场'],
  workspace_market_update: ['updated', '更新了市場', 'Updated a market', '更新了市场'],
  tasks_create: ['created', '建立了工作項目', 'Created a work item', '创建了工作项目'],
  tasks_update: ['updated', '更新了工作項目', 'Updated a work item', '更新了工作项目'],
  tasks_complete: ['updated', '完成了工作項目', 'Completed a work item', '完成了工作项目'],
  commerce_store_create: ['created', '建立了店鋪', 'Created a store', '创建了店铺'],
  commerce_store_update: ['updated', '更新了店鋪', 'Updated a store', '更新了店铺'],
  commerce_store_import: ['created', '匯入了店鋪商品', 'Imported store products', '导入了店铺商品'],
  commerce_product_create: ['created', '建立了商品', 'Created a product', '创建了商品'],
  commerce_product_update: ['updated', '更新了商品', 'Updated a product'],
  commerce_variant_create: ['created', '建立了商品變體', 'Created a product variant', '创建了商品变体'],
  commerce_variant_update: ['updated', '更新了商品變體', 'Updated a product variant', '更新了商品变体'],
  commerce_record_listing: ['updated', '登記了市場價格與庫存', 'Recorded a market listing', '登记了市场价格与库存'],
  catalog_propose_fact: ['created', '提出了商品事實', 'Proposed a product fact', '提出了商品事实'],
  commerce_fact_revise: ['updated', '修訂了商品事實', 'Revised a product fact', '修订了商品事实'],
  catalog_update_localization: ['updated', '撰寫了商品翻譯', 'Drafted a product translation', '撰写了商品翻译'],
  commerce_localization_submit: ['submitted', '送審了商品翻譯', 'Submitted a translation for review', '送审了商品翻译'],
  commerce_promotion_create: ['created', '建立了促銷', 'Created a promotion', '创建了促销'],
  import_create: ['created', '建立了匯入', 'Started an import', '创建了导入'],
  import_confirm: ['submitted', '確認了匯入', 'Confirmed an import', '确认了导入'],
  campaign_create_draft: ['created', '建立了推廣計劃', 'Created a campaign', '创建了推广计划'],
  campaign_update: ['updated', '更新了推廣計劃', 'Updated a campaign', '更新了推广计划'],
  campaign_transition: ['updated', '變更了推廣計劃狀態', 'Changed a campaign status', '变更了推广计划状态'],
  campaign_set_markets: ['updated', '設定了計劃市場', 'Set campaign markets', '设置了计划市场'],
  campaign_set_products: ['updated', '設定了計劃商品', 'Set campaign products', '设置了计划商品'],
  campaign_goal_create: ['created', '新增了計劃目標', 'Added a campaign goal', '添加了计划目标'],
  campaign_goal_update: ['updated', '更新了計劃目標', 'Updated a campaign goal', '更新了计划目标'],
  campaign_plan_slot_create: ['created', '新增了內容規劃', 'Added a content plan slot', '添加了内容规划'],
  campaign_plan_slot_update: ['updated', '更新了內容規劃', 'Updated a content plan slot', '更新了内容规划'],
  campaign_brief_create: ['created', '建立了簡報', 'Created a brief', '创建了演示文稿'],
  brief_update_draft: ['updated', '修訂了簡報', 'Revised a brief', '修订了演示文稿'],
  brief_revision_submit: ['submitted', '送審了簡報', 'Submitted a brief for review', '送审了演示文稿'],
  campaign_budget_line_create: ['created', '新增了預算項目', 'Added a budget line', '添加了预算项目'],
  campaign_milestone_create: ['created', '新增了里程碑', 'Added a milestone', '添加了里程碑'],
  campaign_link_create: ['created', '建立了追蹤連結', 'Created a tracking link', '创建了追踪链接'],
  content_create_item: ['created', '建立了內容', 'Created content', '创建了内容'],
  content_create_draft: ['created', '撰寫了內容草稿', 'Drafted content', '撰写了内容草稿'],
  content_item_update: ['updated', '更新了內容', 'Updated content', '更新了内容'],
  content_create_variant: ['created', '建立了平台版本', 'Created a platform variant', '创建了平台版本'],
  content_update_variant: ['updated', '修改了平台版本', 'Edited a platform variant'],
  content_autosave_variant: ['updated', '修改了平台版本', 'Edited a platform variant'],
  content_commit_revision: ['updated', '保存了內容修訂', 'Saved a content revision', '保存了内容修订'],
  content_create_translation: ['created', '建立了翻譯版本', 'Created a translation', '创建了翻译版本'],
  content_set_stage: ['updated', '變更了製作階段', 'Changed the production stage', '变更了制作阶段'],
  publishing_create_target: ['created', '建立了發布排期', 'Created a publish schedule', '创建了发布排期'],
  account_register_owned_social_account: ['created', '登記了自有社群帳號', 'Registered an owned social account', '登记了自有社交媒体账号'],
  ads_register_account: ['created', '登記了投放帳戶', 'Registered an ad account', '登记了投放账户'],
  ads_import_report: ['created', '匯入了投放成效', 'Imported ad performance', '导入了投放成效'],
  file_begin_upload: ['created', '開始上傳檔案', 'Started a file upload', '开始上传文件'],
  file_complete_upload: ['created', '上傳了檔案', 'Uploaded a file', '上传了文件'],
  workspace_update: ['updated', '更新了工作區設定', 'Updated workspace settings', '更新了工作区设置'],
  publishing_create_pause: ['created', '暫停了發布', 'Paused publishing', '暂停了发布'],
  publishing_release_pause: ['updated', '解除了發布暫停', 'Released a publishing pause', '解除了发布暂停'],
  publishing_update_target: ['updated', '更新了發布排期', 'Updated a publish schedule', '更新了发布排期'],
  publishing_reschedule: ['updated', '調整了發布時間', 'Rescheduled a publication', '调整了发布时间'],
  publishing_cancel: ['deleted', '取消了發布排期', 'Cancelled a publish schedule', '取消了发布排期'],
  publishing_request_approval: ['submitted', '送審了發布排期', 'Submitted a publication for approval', '送审了发布排期'],
  publishing_create_plan: ['created', '建立了發布計劃', 'Created a publishing plan', '创建了发布计划'],
  publishing_schedule: ['created', '排入了發布計劃', 'Scheduled a publishing plan', '排入了发布计划'],
  publishing_pause: ['other', '暫停了發布', 'Paused publishing', '暂停了发布'],
  publishing_approve: ['approved', '核准了發布', 'Approved a publication', '核准了发布'],
  publishing_reject: ['other', '拒絕了發布', 'Rejected a publication', '拒绝了发布'],
  publishing_request_changes: ['other', '要求修改發布內容', 'Requested changes to a publication', '要求修改发布内容'],
  publishing_late_decision: ['approved', '處理了逾時發布', 'Decided on a late publication', '处理了逾时发布'],
  posts_register_manual: ['created', '登記了貼文', 'Registered a post', '登记了帖子'],
  analytics_record_observations: ['created', '登記了成效數據', 'Recorded performance data', '登记了成效数据'],
  ads_create_proposal: ['created', '建立了投放方案', 'Created an ad proposal', '创建了投放方案'],
  ads_revise_proposal: ['updated', '修訂了投放方案', 'Revised an ad proposal', '修订了投放方案'],
  ads_submit_proposal: ['submitted', '送審了投放方案', 'Submitted an ad proposal', '送审了投放方案'],
  ads_decide_proposal: ['approved', '決定了投放方案', 'Decided on an ad proposal', '决定了投放方案'],
  ads_create_creative: ['created', '建立了廣告素材', 'Created an ad creative', '创建了广告素材'],
  links_create: ['created', '建立了短連結', 'Created a short link', '创建了短链接'],
  knowledge_propose: ['created', '提出了品牌知識', 'Proposed brand knowledge', '提出了品牌知识'],
  knowledge_revise: ['updated', '修訂了品牌知識', 'Revised brand knowledge', '修订了品牌知识'],
  knowledge_approve: ['approved', '核准了品牌知識', 'Approved brand knowledge', '核准了品牌知识'],
  agent_jobs_create: ['created', '交辦了任務', 'Assigned a task', '交办了任务'],
  agent_jobs_claim: ['other', '接手了任務', 'Picked up a task', '接手了任务'],
  agent_jobs_heartbeat: ['updated', '回報了任務進度', 'Reported task progress', '回报了任务进度'],
  agent_jobs_submit_result: ['submitted', '提交了任務成果', 'Submitted task results', '提交了任务成果'],
  agent_jobs_handoff: ['other', '交還了任務', 'Handed off a task', '交还了任务'],
  agent_jobs_accept: ['approved', '驗收了任務', 'Accepted a task', '验收了任务'],
  agent_jobs_return: ['other', '退回了任務', 'Returned a task', '退回了任务'],
  change_sets_create: ['submitted', '提出了變更', 'Proposed changes', '提出了变更'],
  change_sets_apply: ['approved', '套用了變更', 'Applied changes', '套用了变更'],
  change_sets_reject: ['other', '拒絕了變更', 'Rejected changes', '拒绝了变更'],
};

function inferVerb(action: string): Verb {
  if (/_(approve|accept|decide|confirm)(_|$)/.test(action)) return 'approved';
  if (/_(submit|request_approval)(_|$)/.test(action)) return 'submitted';
  if (/_(create|propose|draft|register|add|import|duplicate|instantiate|derive|record)(_|$)/.test(action)) return 'created';
  if (/_(update|revise|reschedule|set|edit|autosave|commit|restore|transition|link)(_|$)/.test(action)) return 'updated';
  if (/_(delete|remove|archive|cancel|retract|revoke|unlink)(_|$)/.test(action)) return 'deleted';
  return 'other';
}
export function describeAction(action: string, count = 1): { verb: Verb; summary: Label } {
  const known = described[action];
  const [zh, en, hans] = known ? [known[1], known[2], known[3]] : [`執行了 ${action}`, `Ran ${action}`, `运行了 ${action}`];
  const suffix = count > 1 ? ` ×${count}` : '';
  const summary: Label = [`${zh}${suffix}`, `${en}${suffix}`];
  if (hans !== undefined) summary.push(`${hans}${suffix}`);
  return { verb: known?.[0] ?? inferVerb(action), summary };
}

const titles: Record<string, (row: Row, find: (kind: string, id: unknown) => Row | undefined) => unknown> = {
  publish_target: (row, find) => row.title ?? find('content_item', row.content_item_id)?.title,
  content_item: row => row.title,
  content_variant: (row, find) => find('content_item', row.content_item_id)?.title,
  campaign: row => row.name,
  product: row => row.title,
  brand: row => row.name,
  store: row => row.name,
  market: row => row.name,
  brief: row => row.title,
  change_set: row => row.title,
  agent_job: row => row.title,
  work_item: row => row.title,
  ad_proposal: row => row.name,
  knowledge_entry: row => row.title,
  social_account: row => row.display_name ?? row.handle,
};

/** Memoized id lookups for the kinds a view touches; rows the caller may not read resolve to undefined. */
export function finder(ctx: Context) {
  const indexes = new Map<string, Map<string, Row>>();
  const canRead = (ctx as Context & { canReadWorkspaceResource?(kind: string, row: Row): boolean }).canReadWorkspaceResource;
  return (kind: string, id: unknown): Row | undefined => {
    if (typeof id !== 'string') return undefined;
    let index = indexes.get(kind);
    if (!index) indexes.set(kind, index = new Map(ctx.list(kind).map(row => [row.id, row])));
    const row = index.get(id);
    return row && (!canRead || canRead.call(ctx, kind, row)) ? row : undefined;
  };
}

const readChangeSet = changeOperations.find(op => op.name === 'change_sets_get')!;
/** True when the owning module's own read succeeds; its refusals are Problems, anything else is a bug and propagates. */
const opens = (read: () => unknown) => {
  try { read(); return true; } catch (error) { if (error instanceof Problem) return false; throw error; }
};

/** Module read rules the host check does not cover, so the feed never names or links a resource its module would refuse the caller. */
function readable(ctx: Context) {
  let proposals: Set<string> | undefined;
  const checked = new Map<string, boolean>();
  return (kind: string, row: Row): boolean => {
    // As in the ads module (proposals on accounts without a read grant), campaign module (briefs are internal) and tasks module (agents see their own).
    if (kind === 'ad_proposal') return (proposals ??= new Set(adsReadScope(ctx, { body: {}, params: {}, query: {} }).list(kind).map(item => item.id))).has(row.id);
    if (kind === 'brief') return INTERNAL_READ.some(role => role === ctx.role);
    if (kind === 'work_item') return canReadTask(ctx, row);
    // Jobs also require every brand, campaign and resource they reference to be readable, and change sets require their job, targets and sources,
    // so both go through the module's own read rather than a copy of its rules.
    if (kind !== 'agent_job' && kind !== 'change_set') return true;
    const key = `${kind}:${row.id}`;
    if (!checked.has(key)) checked.set(key, opens(() => kind === 'agent_job' ? getVisibleJob(ctx, row.id) : readChangeSet.run(ctx, { body: {}, params: { id: row.id }, query: {} })));
    return checked.get(key)!;
  };
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
const actorType = (row: Row): 'agent' | 'human' => row.actor_type === 'agent' || (row.actor_type == null && row.credential_id != null) ? 'agent' : 'human';
const newestFirst = (a: Row, b: Row) => String(b.occurred_at).localeCompare(String(a.occurred_at)) || b.id.localeCompare(a.id);

export function activityItems(ctx: Context, query: ActivityQuery): ActivityItem[] {
  if (query.actor !== undefined && query.actor !== 'agent' && query.actor !== 'human') invalid('actor must be agent or human');
  const since = query.since === undefined ? undefined : instant(query.since, 'since');
  const brand = brandScope(ctx, query.brand_id);
  const size = query.limit === undefined ? 200 : limit(query.limit);
  const events = ctx.list(KIND).filter(row => typeof row.action === 'string' && Number.isFinite(timestamp(row.occurred_at)) &&
    (query.actor === undefined || actorType(row) === query.actor) && (since === undefined || timestamp(row.occurred_at) >= timestamp(since)) &&
    (brand === undefined || row.brand_id === brand)).sort(newestFirst);
  const groups: { key: string; events: Row[] }[] = [];
  for (const event of events) {
    const key = JSON.stringify([event.credential_id ?? `user:${String(event.actor_id)}`, event.action]);
    const group = groups.at(-1);
    if (group?.key === key && timestamp(group.events[0]!.occurred_at) - timestamp(event.occurred_at) <= GROUP_WINDOW_MS) group.events.push(event);
    else if (groups.length < size) groups.push({ key, events: [event] });
    else break;
  }
  const find = finder(ctx), allowed = readable(ctx);
  return groups.map(({ events: [first, ...rest] }) => {
    const all = [first!, ...rest];
    const sameResource = all.every(row => row.resource_id === first!.resource_id && row.resource_type === first!.resource_type);
    const type = all.every(row => row.resource_type === first!.resource_type) ? text(first!.resource_type) : null;
    const titled = !!type && Object.hasOwn(titles, type);
    const found = titled && sameResource ? find(type!, first!.resource_id) : undefined;
    const row = found && allowed(type!, found) ? found : undefined;
    // A titled resource is linked only when the caller can open it; the summary still says what happened.
    const id = sameResource && (!titled || row) ? text(first!.resource_id) : null;
    const { verb, summary } = describeAction(String(first!.action), all.length);
    return {
      id: first!.id, occurred_at: String(first!.occurred_at),
      actor: { type: actorType(first!), user_id: text(first!.actor_id), credential_id: text(first!.credential_id), label: text(first!.credential_label) },
      source: first!.source === 'mcp' ? 'mcp' : 'rest', action: String(first!.action), verb, summary,
      resource: { type, id, title: row ? text(titles[type!]!(row, find)) : null }, count: all.length,
    };
  });
}

/** Agent connections are invisible to Operations, so presence is inferred from recent attributed writes. */
export function agentPresence(ctx: Context): { connections: number | null; last_seen_at: string | null } {
  // Connections issued from the web are mirrored as agent_connection rows; prefer them over inferring from activity.
  const issued = ctx.list('agent_connection').filter(row => row.revoked !== true && !(timestamp(row.expires_at) <= timestamp(ctx.now)));
  if (issued.length) {
    const used = [...issued.map(row => row.last_used_at), ...ctx.list(KIND).filter(row => actorType(row) === 'agent').map(row => row.occurred_at)]
      .filter((value): value is string => typeof value === 'string' && Number.isFinite(timestamp(value))).sort().at(-1) ?? null;
    return { connections: issued.length, last_seen_at: used };
  }
  const events = ctx.list(KIND);
  if (!events.length) return { connections: null, last_seen_at: null };
  const agents = events.filter(row => actorType(row) === 'agent' && Number.isFinite(timestamp(row.occurred_at)));
  const recent = agents.filter(row => timestamp(row.occurred_at) >= timestamp(ctx.now) - ACTIVE_WINDOW_MS);
  const last = agents.map(row => String(row.occurred_at)).sort().at(-1) ?? null;
  return { connections: new Set(recent.map(row => row.credential_id ?? row.actor_id)).size, last_seen_at: last };
}

/** Most recent label per credential, and per resource an agent last wrote, for naming agent requesters elsewhere. */
export function credentialLabels(ctx: Context): { byCredential: Map<string, string>; byResource: Map<string, string> } {
  const byCredential = new Map<string, string>(), byResource = new Map<string, string>();
  for (const row of [...ctx.list(KIND)].sort(newestFirst)) {
    if (typeof row.credential_label !== 'string') continue;
    if (typeof row.credential_id === 'string' && !byCredential.has(row.credential_id)) byCredential.set(row.credential_id, row.credential_label);
    if (actorType(row) === 'agent' && typeof row.resource_id === 'string' && !byResource.has(row.resource_id)) byResource.set(row.resource_id, row.credential_label);
  }
  return { byCredential, byResource };
}

export const activityViewOperations: Operation[] = [
  { method: 'GET', path: '/views/activity', name: 'views_activity', roles: READ, summary: 'List grouped human and Agent activity, newest first', contract: { query: ['actor', 'since', 'brand_id', 'limit'] },
    run: (ctx, { query }: Input) => activityItems(ctx, query) },
];
