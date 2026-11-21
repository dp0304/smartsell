import { ADMIN, APPROVE, Problem, READ, WRITE, type Context, type Data, type Input, type Operation, type Role, type Row } from '@smartsell/contracts';
import { activeAccountGrant } from '../../ads/domain.js';
import { getVisibleJob } from '../../agent/jobs.js';
import { brandScope, invalid, timestamp } from '../shared.js';
import { credentialLabels, finder, type Label } from './activity.js';
import { group, snapshot } from './products.js';

// Read-model for the agent-first web view. Contract: docs/agent-first-design.md 3.7.
// Each action mirrors the owning module's decision endpoint (path, If-Match kind, body fields, reason field).
export const decisionKinds = ['publish_approval', 'change_set', 'agent_job_review', 'reply_draft', 'ad_proposal', 'brief_revision',
  'budget_approval', 'fact_revision', 'knowledge_revision', 'localization', 'late_decision'] as const;
export type DecisionKind = typeof decisionKinds[number];
type Severity = 'blocker' | 'high' | 'normal';
type Tone = 'primary' | 'danger' | 'neutral';
export interface DecisionAction {
  key: string; label: Label; method: 'POST'; path: string; version: number | null; body: Data;
  requires_reason: boolean; reason_field: string | null; tone: Tone;
}
interface PreviewField { label: Label; before: unknown; after: unknown; unit?: 'currency'; currency?: unknown }
export interface DecisionItem {
  id: string; kind: DecisionKind; kind_label: Label; severity: Severity; title: string; summary: string | null;
  created_at: string; due_at: string | null; brand_id: string | null; campaign_id: string | null;
  requested_by: { type: 'agent' | 'human' | 'rule'; label: string | null };
  resource: { type: string; id: string; version: number | null; hash: string | null; route: string | null };
  preview: { text: string | null; fields: PreviewField[] } & Data;
  actions: DecisionAction[];
}
export interface DecisionQuery { kind?: string; brand_id?: string; campaign_id?: string }

const LEAD: readonly Role[] = ['owner', 'admin', 'manager'];
const BRIEF_READ: readonly Role[] = ['owner', 'admin', 'manager', 'editor', 'analyst', 'viewer', 'agent'];
const HUMAN_WRITE = WRITE.filter(role => role !== 'agent');
const kindLabels: Record<DecisionKind, Label> = {
  publish_approval: ['發布審批', 'Publish approval'], change_set: ['變更審核', 'Change review'], agent_job_review: ['任務驗收', 'Task review'],
  reply_draft: ['回覆審批', 'Reply approval'], ad_proposal: ['投放方案', 'Ad proposal'], brief_revision: ['簡報審核', 'Brief review'],
  budget_approval: ['預算核准', 'Budget approval'], fact_revision: ['商品事實', 'Product fact'], knowledge_revision: ['品牌知識', 'Brand knowledge'],
  localization: ['商品翻譯', 'Product translation'], late_decision: ['逾時發布', 'Late publication'],
};
const actionLabels: Record<string, [Label, Tone]> = {
  approve: [['核准', 'Approve'], 'primary'], reject: [['拒絕', 'Reject'], 'danger'], request_changes: [['要求修改', 'Request changes'], 'neutral'],
  apply: [['套用變更', 'Apply changes'], 'primary'], accept: [['驗收', 'Accept'], 'primary'], return: [['退回', 'Return'], 'neutral'],
  run_now: [['立即發布', 'Publish now'], 'primary'], reschedule: [['改期', 'Reschedule'], 'neutral'], skip: [['略過', 'Skip'], 'danger'],
};
const severityRank: Record<Severity, number> = { blocker: 0, high: 1, normal: 2 };
const DAY = 86_400_000;

function act(key: string, path: string, version: number | null, body: Data = {}, reason: { field: string | null; required?: boolean } = { field: 'reason' }): DecisionAction {
  const [label, tone] = actionLabels[key]!;
  return { key, label, method: 'POST', path, version, body, requires_reason: reason.required ?? false, reason_field: reason.field, tone };
}
const str = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clip = (value: unknown, max = 4000) => { const text = str(value); return text && text.length > max ? `${text.slice(0, max)}…` : text; };
const enc = encodeURIComponent;
function documentText(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object' || depth > 30) return '';
  const value = node as Data;
  if (value.type === 'text') return typeof value.text === 'string' ? value.text : '';
  if (value.type === 'hardBreak') return '\n';
  if (!Array.isArray(value.content)) return '';
  return value.content.map(child => documentText(child, depth + 1)).join(['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(String(value.type)) ? '\n' : '');
}
function factText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return str(value);
  const fact = value as Data;
  if (fact.type === 'text') return str(fact.text);
  if (fact.type === 'number' && num(fact.number) !== null) return [fact.number, fact.unit].filter(part => part != null).join(' ');
  if (fact.type === 'locale_text' && fact.by_locale && typeof fact.by_locale === 'object') return Object.entries(fact.by_locale as Data).map(([locale, text]) => `${locale}: ${String(text)}`).join('\n');
  return null;
}

interface Scan {
  ctx: Context; find: ReturnType<typeof finder>; human: boolean; readonly labels: ReturnType<typeof credentialLabels>;
  readable(kind: string, row: Row): boolean;
  /** Child rows grouped by a parent id field, built once per request so per-parent lookups never rescan the kind. */
  by(kind: string, field: string): Map<string, Row[]>;
}
/** True when the owning module's read succeeds; its refusals are Problems, anything else is a bug and propagates. */
const opens = (read: () => unknown) => {
  try { read(); return true; } catch (error) { if (error instanceof Problem) return false; throw error; }
};
const isAgentCaller = (ctx: Context) => ctx.role === 'agent' || !!(ctx as Context & { agentCredentialId?: string }).agentCredentialId;
function scan(ctx: Context): Scan {
  const check = (ctx as Context & { canReadWorkspaceResource?(kind: string, row: Row): boolean }).canReadWorkspaceResource;
  const groups = new Map<string, Map<string, Row[]>>();
  let labels: ReturnType<typeof credentialLabels> | undefined;
  // A job is readable only when every scope it references is (the jobs module's own read), and a change set only with its job.
  // Change targets and sources are not re-read per set here: that would rescan change_set_item for every pending set.
  const jobs = new Map<string, boolean>();
  const jobReadable = (id: unknown) => {
    if (typeof id !== 'string') return true;
    if (!jobs.has(id)) jobs.set(id, opens(() => getVisibleJob(ctx, id)));
    return jobs.get(id)!;
  };
  return {
    ctx, find: finder(ctx), human: !isAgentCaller(ctx),
    readable: (kind, row) => (!check || check.call(ctx, kind, row)) && (kind === 'agent_job' ? jobReadable(row.id) : kind === 'change_set' ? jobReadable(row.agent_job_id) : true),
    // Sorting the whole activity log is only worth it once an agent-requested item needs a label.
    get labels() { return labels ??= credentialLabels(ctx); },
    by(kind, field) {
      let map = groups.get(`${kind}.${field}`);
      if (!map) groups.set(`${kind}.${field}`, map = group(ctx.list(kind), row => row[field]));
      return map;
    },
  };
}
const can = (s: Scan, roles: readonly Role[]) => s.human && roles.includes(s.ctx.role);
function requester(s: Scan, row: Row, agent: boolean, credential?: unknown, resource: unknown = row.id): DecisionItem['requested_by'] {
  if (!agent && row.created_via !== 'agent') return { type: 'human', label: null };
  const label = typeof credential === 'string' ? s.labels.byCredential.get(credential) : undefined;
  return { type: 'agent', label: label ?? (typeof resource === 'string' ? s.labels.byResource.get(resource) ?? null : null) };
}
function campaignOf(s: Scan, id: unknown) { return s.find('campaign', id); }
const route = { product: (id: unknown) => typeof id === 'string' ? `/products/${enc(id)}` : null, plan: (id: unknown) => typeof id === 'string' ? `/plans/${enc(id)}` : null };

type Scope = Pick<DecisionItem, 'brand_id' | 'campaign_id'>;
type Detail = Omit<DecisionItem, 'id' | 'kind' | 'kind_label' | keyof Scope>;
/** Membership and scope are decided up front; what a reader sees is built only for listed items, so counts never read preview tables or the activity log. */
interface Pending extends Scope { kind: DecisionKind; id: string; detail(): Detail }
const item = (kind: DecisionKind, id: string, scope: Scope, detail: () => Detail): Pending => ({ kind, id, ...scope, detail });
const describe = ({ kind, id, brand_id, campaign_id, detail }: Pending): DecisionItem => ({ id: `${kind}:${id}`, kind, kind_label: kindLabels[kind], brand_id, campaign_id, ...detail() });
const soon = (s: Scan, at: unknown, hours = 24) => Number.isFinite(timestamp(at)) && timestamp(at) - timestamp(s.ctx.now) <= hours * 3_600_000;

const collectors: Record<DecisionKind, { visible(s: Scan): boolean; collect(s: Scan): Pending[] }> = {
  publish_approval: { visible: () => true, collect: s => s.ctx.list('approval_request').flatMap(request => {
    if (request.resource_type !== 'planning.publish_target' || request.status !== 'pending' || timestamp(request.due_at) <= timestamp(s.ctx.now)) return [];
    const target = s.find('publish_target', request.resource_id);
    if (!target || target.plan_status !== 'awaiting_approval' || target.approval_request_id !== request.id || target.frozen_hash !== request.resource_hash || !s.readable('approval_request', request)) return [];
    return [item('publish_approval', request.id, { brand_id: str(target.brand_id), campaign_id: str(target.campaign_id) }, () => {
      const content = s.find('content_item', target.content_item_id);
      const account = s.find('social_account', target.social_account_id);
      const revision = s.find('content_revision', target.variant_revision_id);
      const context = (request.context ?? {}) as Data;
      const steps = Array.isArray(request.steps) ? request.steps as Data[] : [];
      const approvers = (steps[Number(request.current_step) - 1]?.approvers ?? {}) as { roles?: unknown[]; user_ids?: unknown[] };
      const decided = (s.by('approval_decision', 'request_id').get(request.id) ?? []).some(row => row.step_no === request.current_step && row.decided_by_user_id === s.ctx.actorId);
      const assigned = steps.length > 0 && (!!approvers.roles?.includes(s.ctx.role) || !!approvers.user_ids?.includes(s.ctx.actorId));
      const path = `/publish-targets/${enc(target.id)}`;
      const body = { resource_hash: request.resource_hash, approval_request_id: request.id };
      const platform = str(account?.platform) ?? str(account?.provider);
      const handle = str(account?.handle) ?? str(account?.display_name);
      const when = str(target.local_scheduled_at) ?? str(target.scheduled_at);
      return {
        severity: soon(s, target.scheduled_at) || soon(s, request.due_at) ? 'high' : 'normal',
        title: str(target.title) ?? str(content?.title) ?? ([platform, when].filter(Boolean).join(' · ') || 'Publication'),
        summary: [platform, handle, when].filter(Boolean).join(' · ') || null,
        created_at: request.created_at, due_at: str(request.due_at) ?? str(target.scheduled_at),
        requested_by: requester(s, request, context.submitted_by_type === 'agent_client' || target.origin === 'agent', context.submitted_by, target.id),
        resource: { type: 'publish_target', id: target.id, version: target.version, hash: str(request.resource_hash), route: route.plan(target.campaign_id) },
        preview: { text: clip((revision?.rendered as Data | undefined)?.text ?? revision?.body), scheduled_at: str(target.scheduled_at), schedule_tz: str(target.schedule_tz), platform,
          fields: [{ label: ['發布時間', 'Scheduled at'], before: null, after: when }, { label: ['帳號', 'Account'], before: null, after: handle }, { label: ['平台', 'Platform'], before: null, after: platform }] },
        actions: can(s, APPROVE) && assigned && !decided ? [
          act('approve', `${path}/approve`, target.version, body),
          act('request_changes', `${path}/request-changes`, target.version, body),
          act('reject', `${path}/reject`, target.version, body),
        ] : [],
      };
    })];
  }) },
  change_set: { visible: () => true, collect: s => s.ctx.list('change_set').flatMap(set => {
    if (!['pending', 'partial', 'stale'].includes(String(set.status)) || !s.readable('change_set', set)) return [];
    const items = (s.by('change_set_item', 'change_set_id').get(set.id) ?? []).filter(row => row.status === 'pending');
    if (!items.length) return [];
    const job = s.find('agent_job', set.agent_job_id);
    return [item('change_set', set.id, { brand_id: str(set.brand_id), campaign_id: str(job?.campaign_id) }, () => {
      const fieldNames: Data = { title: ['標題', 'Title'], body_markdown: ['內文', 'Body'] };
      const fields = items.flatMap(change => Object.entries((change.preview ?? {}) as Record<string, { before?: unknown; after?: unknown }>).map(([field, diff]) => {
        const target = s.find(String(change.target_type), change.target_id);
        const name = str(target?.title) ?? str(target?.name) ?? `${String(change.target_type)} ${String(change.target_id)}`;
        const [zh, en] = (fieldNames[field] as Label | undefined) ?? [field, field];
        return { label: [`${name} · ${zh}`, `${name} · ${en}`] as Label, before: diff?.before ?? null, after: diff?.after ?? null };
      }));
      const path = `/change-sets/${enc(set.id)}`;
      return {
        severity: 'normal', title: str(set.title) ?? 'Change set', summary: clip(set.rationale, 500), created_at: set.created_at, due_at: str(job?.due_at),
        requested_by: requester(s, set, set.ai_generated === true || !!set.agent_job_id, job?.lease_credential_id),
        resource: { type: 'change_set', id: set.id, version: set.version, hash: null, route: '/agent' },
        preview: { text: clip(set.rationale), fields },
        actions: can(s, APPROVE) ? [act('apply', `${path}/apply`, set.version, {}, { field: null }), act('reject', `${path}/reject`, set.version, {}, { field: 'reason', required: true })] : [],
      };
    })];
  }) },
  agent_job_review: { visible: () => true, collect: s => s.ctx.list('agent_job').flatMap(job => {
    if (job.status !== 'submitted' || job.cancel_requested_at || !s.readable('agent_job', job)) return [];
    return [item('agent_job_review', job.id, { brand_id: str(job.brand_id), campaign_id: str(job.campaign_id) }, () => {
      const result = (job.result_ref ?? {}) as Data;
      const output = s.find('change_set', result.change_set_id);
      const path = `/agent-jobs/${enc(job.id)}`;
      return {
        severity: Number.isFinite(timestamp(job.due_at)) && timestamp(job.due_at) < timestamp(s.ctx.now) ? 'high' : 'normal',
        title: str(job.title) ?? 'Agent job', summary: clip(job.handoff_summary ?? job.progress_note, 500), created_at: job.updated_at, due_at: str(job.due_at),
        requested_by: requester(s, job, job.assignee_type === 'agent_client', job.lease_credential_id),
        resource: { type: 'agent_job', id: job.id, version: job.version, hash: null, route: '/agent' },
        preview: { text: clip(result.note ?? job.progress_note), fields: [
          { label: ['產出', 'Output'], before: null, after: str(output?.title) ?? str(result.change_set_id) ?? str(result.report_id) ?? str(result.operation_id) },
          { label: ['期限', 'Due'], before: null, after: str(job.due_at) },
        ] },
        actions: can(s, APPROVE) ? [act('accept', `${path}/accept`, job.version, {}, { field: null }), act('return', `${path}/return`, job.version, {}, { field: 'note', required: true })] : [],
      };
    })];
  }) },
  reply_draft: { visible: () => true, collect: s => s.ctx.list('reply_draft').flatMap(draft => {
    if (draft.status !== 'pending_approval' || !s.readable('reply_draft', draft)) return [];
    const conversation = s.find('conversation', draft.conversation_id);
    return [item('reply_draft', draft.id, { brand_id: str(conversation?.brand_id), campaign_id: null }, () => {
      const message = s.find('message', draft.in_reply_to_message_id ?? draft.based_on_message_id);
      const path = `/reply-drafts/${enc(draft.id)}`;
      const rule = !!draft.auto_rule_id;
      return {
        severity: conversation?.priority === 'urgent' ? 'high' : 'normal',
        title: str(conversation?.subject) ?? str(conversation?.title) ?? str(conversation?.participant_name) ?? 'Reply draft',
        summary: clip(message?.body_text ?? message?.text, 300), created_at: draft.created_at, due_at: null,
        requested_by: rule ? { type: 'rule', label: null } : requester(s, draft, false),
        resource: { type: 'reply_draft', id: draft.id, version: draft.version, hash: str(draft.content_hash), route: null },
        preview: { text: clip(draft.body_text), fields: [
          { label: ['回覆對象', 'Replying to'], before: clip(message?.body_text ?? message?.text, 1000), after: null },
          { label: ['方式', 'Mode'], before: null, after: str(draft.reply_mode) },
        ] },
        // Only rule-generated drafts have a reject endpoint; other drafts are edited instead.
        actions: can(s, APPROVE) ? [act('approve', `${path}/approve`, draft.version, {}, { field: null }),
          ...(rule ? [act('reject', `${path}/reject`, draft.version, {}, { field: 'reason', required: true })] : [])] : [],
      };
    })];
  }) },
  ad_proposal: { visible: () => true, collect: s => s.ctx.list('ad_proposal').flatMap(proposal => {
    if (proposal.status !== 'in_review' || !s.readable('ad_proposal', proposal)) return [];
    const account = s.find('ad_account', proposal.ad_account_id);
    const grant = ADMIN.includes(s.ctx.role) ? undefined : activeAccountGrant(account?.permissions, s.ctx.actorId, s.ctx.now);
    const actions = (grant?.actions ?? []) as unknown[];
    if (!ADMIN.includes(s.ctx.role) && !actions.includes('read')) return [];
    return [item('ad_proposal', proposal.id, { brand_id: str(proposal.brand_id), campaign_id: str(proposal.campaign_id) }, () => {
      const revision = s.find('ad_proposal_revision', proposal.current_revision_id);
      const budget = (revision?.budget ?? null) as Data | null;
      const schedule = (revision?.schedule ?? null) as Data | null;
      const path = `/ad-proposals/${enc(proposal.id)}/decide`;
      return {
        severity: soon(s, schedule?.starts_at, 48) ? 'high' : 'normal',
        title: str(proposal.name) ?? str(revision?.objective) ?? 'Ad proposal', summary: str(account?.name), created_at: proposal.updated_at, due_at: str(schedule?.starts_at),
        requested_by: requester(s, proposal, false),
        resource: { type: 'ad_proposal', id: proposal.id, version: proposal.version, hash: str(revision?.content_hash), route: proposal.campaign_id ? route.plan(proposal.campaign_id) : '/ads' },
        preview: { text: str((revision?.audience_spec as Data | undefined)?.description), budget, schedule, estimates: Array.isArray(revision?.estimates) ? revision.estimates : [], fields: [
          { label: ['目標', 'Objective'], before: null, after: str(revision?.objective) },
          { label: ['預算', 'Budget'], before: null, after: num(budget?.amount_minor), unit: 'currency', currency: budget?.currency ?? null },
          { label: ['預算類型', 'Budget type'], before: null, after: str(budget?.type) },
          { label: ['開始', 'Starts'], before: null, after: str(schedule?.starts_at) },
          { label: ['結束', 'Ends'], before: null, after: str(schedule?.ends_at) },
        ] },
        actions: can(s, APPROVE) && (ADMIN.includes(s.ctx.role) || actions.includes('approve')) ? [
          act('approve', path, proposal.version, { decision: 'approved' }), act('reject', path, proposal.version, { decision: 'rejected' }),
        ] : [],
      };
    })];
  }) },
  brief_revision: { visible: s => BRIEF_READ.includes(s.ctx.role), collect: s => s.ctx.list('brief_revision').flatMap(revision => {
    const brief = s.find('brief', revision.brief_id);
    if (revision.status !== 'in_review' || !brief || brief.current_revision_id !== revision.id) return [];
    const campaign = campaignOf(s, brief.campaign_id);
    return [item('brief_revision', revision.id, { brand_id: str(campaign?.brand_id), campaign_id: str(brief.campaign_id) }, () => {
      const approved = s.find('brief_revision', brief.approved_revision_id);
      const path = `/brief-revisions/${enc(revision.id)}`;
      const mutable = !['closed', 'cancelled'].includes(String(campaign?.status));
      return {
        severity: 'normal', title: str(brief.title) ?? 'Brief', summary: str(campaign?.name), created_at: revision.updated_at, due_at: null,
        requested_by: requester(s, revision, revision.created_by_type === 'agent_client'),
        resource: { type: 'brief_revision', id: revision.id, version: revision.version, hash: str(revision.content_hash), route: route.plan(brief.campaign_id) },
        preview: { text: clip(documentText(revision.body_doc)), fields: [
          { label: ['內容', 'Content'], before: approved ? clip(documentText(approved.body_doc), 1000) : null, after: clip(documentText(revision.body_doc), 1000) },
          { label: ['需求數', 'Requirements'], before: approved && Array.isArray(approved.requirements) ? approved.requirements.length : null, after: Array.isArray(revision.requirements) ? revision.requirements.length : null },
        ] },
        actions: can(s, LEAD) && mutable ? [
          act('approve', `${path}/approve`, revision.version), act('request_changes', `${path}/request-changes`, revision.version, {}, { field: 'reason', required: true }),
        ] : [],
      };
    })];
  }) },
  budget_approval: { visible: s => LEAD.includes(s.ctx.role), collect: s => s.ctx.list('approval_request').flatMap(request => {
    if (!['budget_line', 'campaign_budget_reallocation'].includes(String(request.resource_type)) || request.status !== 'pending') return [];
    const context = (request.context ?? {}) as Data;
    const campaign = campaignOf(s, context.campaign_id);
    if (!campaign) return [];
    return [item('budget_approval', request.id, { brand_id: str(campaign.brand_id), campaign_id: campaign.id }, () => {
      const overrun = request.resource_type === 'budget_line';
      const proposal = overrun ? undefined : s.find('campaign_budget_reallocation', request.resource_id);
      const line = (id: unknown) => s.find('budget_line', id);
      const from = line(proposal?.from_line_id), to = line(proposal?.to_line_id);
      const currency = overrun ? context.currency : from?.currency ?? to?.currency ?? null;
      const money = (label: Label, after: unknown, before: unknown = null): PreviewField => ({ label, before: num(before), after: num(after), unit: 'currency', currency });
      const path = `/campaigns/${enc(campaign.id)}/budget-approvals/${enc(request.id)}/decide`;
      return {
        severity: 'high', title: str(campaign.name) ?? 'Budget', summary: overrun ? str(context.category) : clip(proposal?.reason, 300),
        created_at: request.created_at, due_at: null,
        requested_by: overrun ? { type: 'rule', label: null } : requester(s, proposal ?? request, false),
        resource: { type: 'approval_request', id: request.id, version: request.version, hash: str(request.resource_hash), route: route.plan(campaign.id) },
        preview: { text: overrun ? null : clip(proposal?.reason), fields: overrun ? [
          money(['預算', 'Budget'], context.budget_minor), money(['實際花費', 'Actual spend'], context.actual_minor),
          money(['未付承諾', 'Open commitments'], context.open_commitment_minor), money(['超支', 'Overrun'], context.overrun_minor),
        ] : [
          money(['調撥金額', 'Amount'], proposal?.amount_minor),
          money([`轉出：${String(from?.category ?? '')}`, `From: ${String(from?.category ?? '')}`], num(from?.amount_minor) !== null && num(proposal?.amount_minor) !== null ? Number(from!.amount_minor) - Number(proposal!.amount_minor) : null, from?.amount_minor),
          money([`轉入：${String(to?.category ?? '')}`, `To: ${String(to?.category ?? '')}`], num(to?.amount_minor) !== null && num(proposal?.amount_minor) !== null ? Number(to!.amount_minor) + Number(proposal!.amount_minor) : null, to?.amount_minor),
        ] },
        actions: can(s, LEAD) && !['closed', 'cancelled'].includes(String(campaign.status)) ? [
          act('approve', path, request.version, { decision: 'approve' }, { field: 'reason', required: true }),
          act('reject', path, request.version, { decision: 'reject' }, { field: 'reason', required: true }),
        ] : [],
      };
    })];
  }) },
  // Unapproved fact, knowledge and localization text never reaches an Agent, whichever tool it reads through.
  fact_revision: { visible: s => s.human, collect: s => s.ctx.list('product_fact_revision').flatMap(revision => {
    const fact = s.find('product_fact', revision.fact_id);
    if (revision.review_status !== 'draft' || !fact || fact.status !== 'active' || fact.current_revision_id !== revision.id) return [];
    const product = s.find('product', fact.product_id);
    return [item('fact_revision', revision.id, { brand_id: str(fact.brand_id) ?? str(product?.brand_id), campaign_id: null }, () => {
      const approved = s.find('product_fact_revision', fact.approved_revision_id);
      const evidence = (Array.isArray(revision.evidence_urls) ? revision.evidence_urls.length : 0) + (Array.isArray(revision.evidence_ids) ? revision.evidence_ids.length : 0);
      const path = `/fact-revisions/${enc(revision.id)}`;
      const source = (revision.source ?? {}) as Data;
      // Claims without evidence cannot be approved by the owning endpoint, so only rejection is offered.
      const approvable = revision.category !== 'claim' || evidence > 0;
      return {
        severity: 'normal', title: str(product?.title) ?? 'Product', summary: [str(fact.category), str(fact.fact_key)].filter(Boolean).join(' · ') || null,
        created_at: revision.created_at, due_at: null,
        requested_by: requester(s, revision, source.kind === 'agent', undefined, fact.id),
        resource: { type: 'product_fact_revision', id: revision.id, version: null, hash: str(revision.content_hash), route: route.product(fact.product_id) },
        preview: { text: factText(revision.value), fields: [
          { label: [String(fact.fact_key), String(fact.fact_key)], before: approved ? factText(approved.value) : null, after: factText(revision.value) },
          { label: ['證據', 'Evidence'], before: null, after: evidence },
        ] },
        actions: can(s, APPROVE) ? [...(approvable ? [act('approve', `${path}/approve`, null, {}, { field: null })] : []), act('reject', `${path}/reject`, null, {}, { field: null })] : [],
      };
    })];
  }) },
  knowledge_revision: { visible: s => s.human, collect: s => s.ctx.list('knowledge_revision').flatMap(revision => {
    const entry = s.find('knowledge_entry', revision.entry_id);
    if (revision.review_status !== 'draft' || !entry || entry.current_revision_id !== revision.id || entry.status === 'retired') return [];
    return [item('knowledge_revision', revision.id, { brand_id: str(entry.brand_id), campaign_id: null }, () => {
      const active = s.find('knowledge_revision', entry.active_revision_id);
      const path = `/knowledge-revisions/${enc(revision.id)}`;
      return {
        severity: 'normal', title: str(entry.title) ?? 'Knowledge', summary: str(entry.kind), created_at: revision.created_at, due_at: null,
        requested_by: requester(s, revision, revision.created_by_type === 'agent' || (revision.source as Data | undefined)?.kind === 'agent', undefined, entry.id),
        resource: { type: 'knowledge_revision', id: revision.id, version: revision.version, hash: str(revision.content_hash), route: null },
        preview: { text: clip(revision.body), fields: [{ label: ['內容', 'Content'], before: clip(active?.body, 1000), after: clip(revision.body, 1000) }] },
        actions: can(s, APPROVE) ? [act('approve', `${path}/approve`, revision.version, {}, { field: null }), act('reject', `${path}/reject`, revision.version, {}, { field: null })] : [],
      };
    })];
  }) },
  localization: { visible: s => s.human, collect: s => s.ctx.list('product_localization').flatMap(row => {
    if (row.status !== 'in_review' || !s.readable('product_localization', row)) return [];
    const product = s.find('product', row.product_id);
    return [item('localization', row.id, { brand_id: str(product?.brand_id), campaign_id: null }, () => {
      const current = s.find('product_localization_revision', row.current_revision_id);
      const approved = s.find('product_localization_revision', row.approved_revision_id);
      const path = `/localizations/${enc(row.id)}`;
      const field = `${String(row.field_key)} (${String(row.locale)})`;
      return {
        severity: 'normal', title: str(product?.title) ?? 'Product', summary: field, created_at: row.updated_at, due_at: null,
        requested_by: requester(s, current ?? row, current?.origin === 'agent', undefined, row.id),
        resource: { type: 'product_localization', id: row.id, version: row.version, hash: str(current?.content_hash), route: route.product(row.product_id) },
        preview: { text: clip(current?.text), fields: [{ label: [field, field], before: clip(approved?.text, 1000), after: clip(current?.text, 1000) }] },
        actions: can(s, APPROVE) ? [act('approve', `${path}/approve`, row.version, {}, { field: null }), act('reject', `${path}/reject`, row.version, {}, { field: null })] : [],
      };
    })];
  }) },
  late_decision: { visible: () => true, collect: s => s.ctx.list('execution_task').flatMap(task => {
    if (task.sub_status !== 'late_awaiting_decision' || !['blocked', 'scheduled', 'queued'].includes(String(task.status))) return [];
    const target = s.find('publish_target', task.publish_target_id);
    return [item('late_decision', task.id, { brand_id: str(target?.brand_id) ?? str(task.brand_id), campaign_id: str(target?.campaign_id) }, () => {
      const content = s.find('content_item', target?.content_item_id);
      const account = s.find('social_account', target?.social_account_id ?? task.social_account_id);
      const path = `/execution-tasks/${enc(task.id)}/late-decision`;
      const platform = str(account?.platform) ?? str(account?.provider);
      return {
        severity: 'blocker', title: str(target?.title) ?? str(content?.title) ?? 'Publication', summary: [platform, str(account?.handle)].filter(Boolean).join(' · ') || null,
        created_at: str(task.late_evaluated_at) ?? task.updated_at, due_at: str(task.due_at) ?? str(target?.scheduled_at),
        requested_by: { type: 'rule', label: null },
        resource: { type: 'execution_task', id: task.id, version: task.version, hash: null, route: route.plan(target?.campaign_id) },
        preview: { text: null, fields: [
          { label: ['原定時間', 'Scheduled at'], before: null, after: str(target?.scheduled_at) ?? str(task.due_at) },
          { label: ['延遲分鐘', 'Minutes late'], before: null, after: num(task.delay_minutes) },
        ] },
        actions: can(s, HUMAN_WRITE) ? [
          act('run_now', path, task.version, { decision: 'run_now' }), act('reschedule', path, task.version, { decision: 'reschedule' }), act('skip', path, task.version, { decision: 'skip' }),
        ] : [],
      };
    })];
  }) },
};

const byDecision = (a: DecisionItem, b: DecisionItem) => severityRank[a.severity] - severityRank[b.severity]
  || (timestamp(a.due_at) || Infinity) - (timestamp(b.due_at) || Infinity) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

function parse(ctx: Context, query: DecisionQuery) {
  const kinds = query.kind === undefined ? [...decisionKinds] : query.kind.split(',').map(value => value.trim());
  if (kinds.some(kind => !(decisionKinds as readonly string[]).includes(kind))) invalid(`kind must be one of ${decisionKinds.join(', ')}`);
  const campaign = query.campaign_id === undefined ? undefined : ctx.get('campaign', query.campaign_id).id;
  return { kinds: kinds as DecisionKind[], brand: brandScope(ctx, query.brand_id), campaign };
}
function gather(raw: Context, query: DecisionQuery) {
  // Collectors share kinds (approval_request, publish_target, ...), so each kind is read once per request.
  const ctx = snapshot(raw);
  const { kinds, brand, campaign } = parse(ctx, query);
  const s = scan(ctx);
  const visible = kinds.filter(kind => collectors[kind].visible(s));
  const pending = visible.flatMap(kind => collectors[kind].collect(s))
    .filter(row => (brand === undefined || row.brand_id === brand) && (campaign === undefined || row.campaign_id === campaign));
  return { pending, visible, hidden: kinds.filter(kind => !visible.includes(kind)) };
}

export function decisionItems(ctx: Context, query: DecisionQuery = {}): DecisionItem[] {
  return gather(ctx, query).pending.map(describe).sort(byDecision);
}

/** Exactly the items decisionItems lists, for callers that only count them (badges, plan cards). */
export function pendingDecisions(ctx: Context, query: DecisionQuery = {}): Pick<DecisionItem, 'kind' | 'brand_id' | 'campaign_id'>[] {
  return gather(ctx, query).pending;
}

/** Counts are exact for kinds the caller may read; kinds hidden by role are listed rather than reported as zero. */
export function decisionSummary(ctx: Context, query: DecisionQuery = {}) {
  const { pending, visible, hidden } = gather(ctx, query);
  const counts = Object.fromEntries(visible.map(kind => [kind, pending.filter(row => row.kind === kind).length]));
  return { counts, total: pending.length, hidden_kinds: hidden, as_of: ctx.now };
}

export const decisionsViewOperations: Operation[] = [
  { method: 'GET', path: '/views/decisions', name: 'views_decisions_list', roles: READ, summary: 'List decisions waiting for a person, with previews and decision actions', contract: { query: ['kind', 'brand_id', 'campaign_id'] },
    run: (ctx, { query }: Input) => decisionItems(ctx, query) },
  { method: 'GET', path: '/views/decisions/summary', name: 'views_decisions_summary', roles: READ, summary: 'Count decisions waiting for a person by kind', contract: { query: ['kind', 'brand_id', 'campaign_id'] },
    run: (ctx, { query }: Input) => decisionSummary(ctx, query) },
];
