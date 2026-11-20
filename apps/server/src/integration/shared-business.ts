import { Problem, type Input } from '@smartsell/contracts';
import { bodyObject, header, invalid, isObject } from '../identity.js';
import { getReport } from '../modules/analytics/reports.js';
import { expectedVersion, idempotencyKey, stringMap, type Registered } from '../operations.js';
import type { FastifyRequest } from 'fastify';

const campaign = 'brand_id name kind starts_at ends_at timezone owner_user_id audience_note objective_summary';
const content = 'title pillar_id owner_user_id production_due_at blocked_reason';
const product = 'title status handle description product_type vendor selling_points size_guide primary_asset_id';
const schedule = 'scheduled_at local_scheduled_at schedule_tz tz schedule_kind dst_choice';
const report = 'title kind period scope sections status schedule template_id';

// Each entry delegates to a mounted Operation. The fields are that Operation's DTO, never a record patch.
const shared: Record<string, readonly [Registered['method'], string, string?]> = {
  'campaign.campaign_list': ['GET', '/campaigns', 'brand_id status active_on offset limit cursor'],
  'campaign.campaign_get_context': ['GET', '/campaigns/:id'],
  'campaign.campaign_create_draft': ['POST', '/campaigns', `${campaign} utm_key markets products goals plan_slots`],
  'campaign.campaign_update': ['PATCH', '/campaigns/:id', campaign],
  'content.content_list': ['GET', '/content-items', 'brand_id campaign_id pillar_id production_stage owner_user_id platform locale readiness limit cursor'],
  'content.content_get': ['GET', '/content-items/:id'],
  'content.content_create_item': ['POST', '/content-items', `${content} brand_id campaign_id idea_id variants tasks`],
  'content.content_item_update': ['PATCH', '/content-items/:id', content],
  'planning.publishing_list_targets': ['GET', '/publish-targets', 'brand_id campaign_id campaign_ids social_account_id owner_id from to status limit cursor'],
  'planning.publishing_get_target': ['GET', '/publish-targets/:id'],
  'planning.publishing_create_target': ['POST', '/publish-targets', `${schedule} social_account_id content_variant_id variant_revision_id revision_id campaign_id visibility operation options late_policy grace_minutes connector_mode_pref promotion_ids owner_user_id`],
  'planning.publishing_reschedule': ['POST', '/publish-targets/:id/reschedule', schedule],
  'commerce.catalog_search': ['GET', '/products', 'brand_id store_id status sku query market_id available_only limit cursor'],
  'commerce.catalog_get_product': ['GET', '/products/:id'],
  'commerce.commerce_product_create': ['POST', '/products', `${product} store_id`],
  'commerce.commerce_product_update': ['PATCH', '/products/:id', product],
  'inbox.inbox_list_cases': ['GET', '/cases', 'status limit cursor'],
  'inbox.inbox_get_case': ['GET', '/cases/:id'],
  'inbox.inbox_create_case': ['POST', '/cases', 'conversation_ids kind title'],
  'inbox.inbox_update_case': ['PATCH', '/cases/:id', 'status external_ref'],
  'inbox.inbox_handoff_case': ['POST', '/cases/:id/handoff', 'target handoff_dedupe_key'],
  'execution.publishing_list_execution': ['GET', '/execution-tasks', 'status sub_status executor connector_channel connector_mode social_account_id publish_target_id limit cursor'],
  'execution.publishing_get_execution': ['GET', '/execution-tasks/:id'],
  'execution.publishing_reconcile': ['POST', '/execution-tasks/:id/reconcile', 'outcome confirmed_no_pending_submission visibility_window_elapsed evidence_file_ids outcome_unknown reason'],
  'analytics.reports_list': ['GET', '/reports', 'limit cursor'],
  'analytics.report_definition_get': ['GET', '/reports/:id'],
  'analytics.reports_create': ['POST', '/reports', report],
  'analytics.reports_update': ['PATCH', '/reports/:id', report],
};

export function sharedBusinessOperation(op: Registered): Registered {
  const key = `${op.module}.${op.name}`;
  const entry = shared[key];
  if (!entry || op.method !== entry[0] || op.path !== entry[1]) return op;
  if (key === 'analytics.reports_update') return { ...op, scopeContext(ctx, input) {
    const scoped = op.scopeContext?.(ctx, input) ?? ctx;
    // Authorize financial reports before version checks and idempotency replay.
    getReport(scoped, input.params.id);
    return scoped;
  } };
  if (key === 'content.content_create_item') return { ...op, scopeContext(ctx, input) {
    const scoped = op.scopeContext?.(ctx, input) ?? ctx;
    const { brand_id, campaign_id } = input.body;
    if (typeof brand_id === 'string') scoped.get('brand', brand_id.trim());
    if (typeof campaign_id === 'string' && campaign_id.trim() && scoped.get('campaign', campaign_id.trim()).brand_id !==
        (typeof brand_id === 'string' ? brand_id.trim() : brand_id)) throw invalid('Campaign must belong to the selected brand');
    return scoped;
  } };
  return op;
}

export function sharedBusinessCommand(op: Registered) {
  const entry = shared[`${op.module}.${op.name}`];
  if (!entry || op.external || op.method !== entry[0] || op.path !== entry[1]) return;
  const fields = entry[2]?.split(' ') ?? [];
  const hasId = op.path.includes('/:id');
  const readOnly = op.method === 'GET';
  const requiresVersion = Boolean(op.versionKind) || op.name === 'publishing_reconcile';
  return {
    module: op.module,
    action: `operation_${op.name}`,
    roles: op.roles,
    fields,
    requires_version: requiresVersion,
    input(request: FastifyRequest): Input {
      if (Object.keys(bodyObject(request.query)).length) throw invalid('Send command fields in the JSON body');
      const envelope = bodyObject(request.body);
      if (Object.keys(envelope).some(key => key !== 'fields' && !(hasId && key === 'id'))) throw invalid('Unexpected command input');
      const id = envelope.id;
      if (hasId && (typeof id !== 'string' || !/^[a-z0-9-]{1,200}$/i.test(id))) throw invalid('A resource ID is required');
      const data = bodyObject(envelope.fields);
      if (Object.keys(data).some(key => !fields.includes(key))) throw invalid('Unsupported fields for this operation');
      if (op.name === 'publishing_reconcile') {
        const absence = data.outcome === 'verified_absent';
        const confirmationFields = ['confirmed_no_pending_submission', 'visibility_window_elapsed', 'evidence_file_ids'];
        if ((data.outcome !== undefined && !absence) ||
            (!absence && confirmationFields.some(field => Object.hasOwn(data, field))) ||
            (absence && (Object.hasOwn(data, 'outcome_unknown') || Object.hasOwn(data, 'reason'))) ||
            (Object.hasOwn(data, 'outcome_unknown') && data.outcome_unknown !== true)) throw invalid('Unsupported verification input');
      }
      if (op.name === 'inbox_update_case' && data.status !== 'accepted_by_external' && Object.hasOwn(data, 'external_ref')) {
        throw invalid('external_ref is only used for external acknowledgment');
      }
      if (op.method === 'PATCH' && !Object.keys(data).length) throw invalid('Provide a field to update');
      const key = idempotencyKey(header(request, 'idempotency-key'));
      if (!readOnly && !key) throw invalid('An idempotency key is required');
      const version = readOnly ? undefined : expectedVersion(header(request, 'if-match'));
      if (op.name === 'publishing_reconcile' && version === undefined) throw new Problem(428, 'VERSION_REQUIRED', 'If-Match is required');
      return { params: typeof id === 'string' ? { id } : {}, body: readOnly ? {} : data,
        query: readOnly ? stringMap(data, true) : {}, expectedVersion: version, idempotencyKey: key };
    },
  };
}

// These domain responses keep child collections beside the versioned subject.
export function sharedBusinessVersion(op: Registered, data: unknown) {
  if (!isObject(data)) return;
  const subject = op.name === 'inbox_get_case' ? data.case
    : ['content_get', 'content_create_item'].includes(op.name) ? data.item
    : op.name === 'publishing_reconcile' ? data.task : undefined;
  if (isObject(subject) && typeof subject.version === 'number') return `"${subject.version}"`;
}
