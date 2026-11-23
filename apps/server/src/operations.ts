import { createHmac, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { idempotencyPattern, pageSize, Problem, type Context, type Data, type Input, type Operation, type Role } from '@smartsell/contracts';
import type { Records, Scope, Store } from '@smartsell/db';
import type { FastifyRequest } from 'fastify';
import { bodyObject, denied, digest, header, invalid, isObject, membership, nowSeconds, type Auth, type Principal } from './identity.js';
import type { Config } from './config.js';
import { makeContext } from './context.js';
import { humanRequired } from './agent-actor.js';
import { brandOperationAllowed, scopedBrandContext } from './integration/brand-access.js';
import type { Membership } from './identity.js';
import { agentSubscriber, bindTeamOperation, guardExternalOperation, semanticSearchOperation, workspaceSchedule, workspaceServices, workspaceTeam } from './integration/workspace-services.js';
import type { CustomerEgress } from './integration/customer-egress.js';
import type { TeamHost } from './modules/team/model.js';
import type { Workspace } from './identity.js';
import { reportExportSubscriber } from './modules/analytics/report-export.js';
import { reportGenerationSubscriber } from './modules/analytics/report-generation.js';
import { reportSchedule, reportSubscriber } from './integration/report-subscriptions.js';
import { manualExternalReceipt } from './integration/manual-external-work.js';

interface PortalHooks {
  team: TeamHost;
  index(identity: Records, scope: Records, workspace: Workspace, name: string, data: unknown): void;
}

export const moduleKeys = [
  'workspace', 'account', 'ingest', 'commerce', 'campaign', 'intel', 'content', 'asset', 'planning',
  'execution', 'inbox', 'creator', 'traffic', 'ads', 'lifecycle', 'analytics', 'agent', 'team', 'ops',
] as const;

export interface Registered extends Operation { module: string; mcp?: boolean }
export interface Subscriber {
  id: string;
  queue?: 'media';
  sensitive?: boolean;
  accepts(type: string): boolean;
  run(ctx: Context, event: Data): unknown | Promise<unknown>;
  onTerminalFailure?(ctx: Context, attempts: number, event: Data): void | Promise<void>;
}
export interface Schedule { id: string; intervalMs?: number; utcDaily?: boolean; run(ctx: Context): unknown | Promise<unknown> }

export async function discoverOperations() {
  const operations: Registered[] = [];
  const missingModules: string[] = [];
  const loadFailures = new Map<string, string>();
  const subscribers: Subscriber[] = [];
  const schedules: Schedule[] = [];
  for (const module of moduleKeys) {
    const entry = new URL(`./modules/${module}/index.ts`, import.meta.url);
    try { await stat(entry); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missingModules.push(module);
      continue;
    }
    let imported;
    try { imported = await import(fileURLToPath(entry)); } catch (error) {
      missingModules.push(module);
      loadFailures.set(module, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!Array.isArray(imported.operations) || !imported.operations.length) {
      missingModules.push(module);
      continue;
    }
    for (const operation of imported.operations as Operation[]) operations.push({ ...operation, module,
      ...(module === 'team' && /^\/templates(?:\/|$)/.test(operation.path) && { path: `/team${operation.path}` }),
      ...(module === 'analytics' && operation.name === 'report_export_download' && { mcp: false }),
      ...(module === 'content' && operation.name === 'content_production_workload' && { mcp: false }),
      ...(module === 'execution' && operation.name === 'publishing_cancel' && { name: 'execution_cancel_task' }),
      ...(module === 'account' && operation.method !== 'GET' && /^\/(?:devices|mobile-devices|mobile-app-bindings|browser-sessions|connector-auto-policy)(?:\/|$)|\/execution-binding(?:\/|$)/.test(operation.path) && { mcp: false }),
    });
    if (module === 'workspace') {
      operations.push(semanticSearchOperation, manualExternalReceipt);
      if (typeof imported.applyWorkspaceEvent === 'function') subscribers.push({
        id: 'workspace', accepts: () => true, run: imported.applyWorkspaceEvent,
      });
      if (typeof imported.scanWorkspaceDue === 'function') schedules.push({ id: 'workspace.due', run: imported.scanWorkspaceDue });
    }
    if (module === 'agent') {
      subscribers.push(agentSubscriber);
      schedules.push(workspaceSchedule);
    }
    if (module === 'content' && typeof imported.applyContentEvent === 'function' && typeof imported.contentAcceptsEvent === 'function') {
      subscribers.push({ id: 'content.upstream', accepts: imported.contentAcceptsEvent, run: imported.applyContentEvent });
      if (typeof imported.scanContentDue === 'function') schedules.push({ id: 'content.due', run: imported.scanContentDue });
    }
    if (module === 'asset' && typeof imported.applyAssetEvent === 'function' && typeof imported.assetAcceptsEvent === 'function') {
      subscribers.push({ id: 'asset.thumbnail', queue: 'media', accepts: imported.assetAcceptsEvent, run: imported.applyAssetEvent });
    }
    if (module === 'planning') {
      if (typeof imported.scanPlanningDue === 'function') schedules.push({ id: 'planning.due', run: imported.scanPlanningDue });
      if (typeof imported.applyPlanningEvent === 'function' && typeof imported.planningAcceptsEvent === 'function') {
        subscribers.push({ id: 'planning.facts', accepts: imported.planningAcceptsEvent, run: imported.applyPlanningEvent });
      }
    }
    if (module === 'execution' && typeof imported.scanExecution === 'function') {
      schedules.push({ id: 'execution.due', run: imported.scanExecution });
    }
    if (Array.isArray(imported.schedules)) schedules.push(...imported.schedules);
    if (Array.isArray(imported.subscribers)) subscribers.push(...imported.subscribers);
    if (module === 'analytics') {
      schedules.push(reportSchedule);
      subscribers.push(reportSubscriber, reportGenerationSubscriber, reportExportSubscriber);
    }
  }
  return { operations, missingModules, loadFailures, subscribers, schedules };
}

const paramPattern = /:([A-Za-z_][A-Za-z0-9_]*)/g;
export const parameterNames = (route: Registered) => [...route.path.matchAll(paramPattern)].map(match => match[1]);

/** Decisions an Agent credential may never make, whatever its role or tool grant (design 4.3). */
export const HUMAN_ONLY: ReadonlySet<string> = new Set([
  'publishing_approve', 'publishing_reject', 'publishing_request_changes', 'publishing_batch_approve', 'change_sets_apply',
  'change_sets_reject', 'agent_jobs_accept', 'agent_jobs_return', 'agent_jobs_finish', 'agent_jobs_reconcile', 'inbox_approve_reply',
  'inbox_reject_auto_reply', 'commerce_fact_approve', 'commerce_fact_reject', 'commerce_localization_approve',
  'commerce_localization_reject', 'knowledge_approve', 'knowledge_reject', 'brief_revision_approve', 'brief_revision_request_changes',
  'campaign_budget_approval_decide', 'ads_decide_proposal', 'ads_decide_adjustment', 'rights_activate', 'rights_revoke',
  'submission_accept', 'submission_accept_batch', 'submission_reject', 'commissions_approve', 'commissions_batch_approve',
  'commissions_batch_record_payment', 'product_candidate_decide', 'account_enable_auto_mode', 'account_update_auto_mode',
  'account_release_account_auto', 'account_release_workspace_auto', 'account_approve_mobile_device',
  'account_register_owned_social_account', 'account_revoke_connection', 'account_revoke_device', 'account_set_device_channel_registration', 'publishing_release_pause',
  'team_member_remove', 'publishing_manual_complete', 'posts_complete_operation', 'publishing_confirm_post_match',
  'publishing_reject_post_match', 'campaign_closeout', 'data_gap_accept', 'collaborations_mark_terms_signed',
  // Releases outside an approval queue: going live in public, mailing customers, re-approving, and security settings.
  'pages_publish', 'pages_configure_experiment', 'bio_add_item', 'bio_edit_item', 'bio_remove_item', 'forms_activate',
  'links_allow_host', 'links_revoke_host', 'links_domain_create', 'links_domain_verify',
  'lifecycle_test_send_campaign', 'lifecycle_schedule_campaign', 'lifecycle_submit_local_esp',
  'commerce_localization_accept', 'commerce_localization_writeback', 'deliverables_review', 'deliverables_verify_publication',
  'account_enable_social_account', 'account_resolve_account_block', 'account_link_accounts', 'account_start_oauth',
  'account_connect_shopify_merchant', 'account_register_platform_app', 'account_update_platform_app', 'commerce_store_connect',
  'worker_catalog_bind',
  // Starting a test sends live page traffic to its arms; a budget cap bounds paid collection.
  'experiment_start', 'collection_budget_set',
  // Undoing a person's pause or archive. A retracted fact cannot be revised and its key cannot be reused, so it is not a stop.
  'data_source_resume', 'workspace_brand_restore', 'commerce_fact_retract',
]);
/** Endpoints that both release and stop: an Agent may send only the stop (design 4.3: Agent 可以「停」…不能「解除」). */
export const AGENT_STOP_ONLY: Readonly<Record<string, (body: Data) => boolean>> = {
  bio_publish: body => body.unpublish === true,
  lifecycle_change_flow_status: body => ['manual', 'paused', 'archived'].includes(String(body.status)),
  // Archived links are immutable, so only the reversible stops.
  links_update: body => ['paused', 'expired'].includes(String(body.status)),
};
/** Fields that carry a person's decision inside an otherwise Agent-callable write. */
export const AGENT_HUMAN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // What collected data may be shown, shared, exported or sent to models is the data licence.
  data_source_create: ['allowed_uses'], data_source_update: ['allowed_uses'],
};

export const humanOnly = (operation: Pick<Registered, 'name' | 'mcp'>) => HUMAN_ONLY.has(operation.name) || operation.mcp === false;
/** Whether this call, with this body, is a decision an Agent credential may not make. */
export const humanDecision = (operation: Pick<Registered, 'name' | 'mcp'>, body: Data) => humanOnly(operation) ||
  (Object.hasOwn(AGENT_STOP_ONLY, operation.name) && !AGENT_STOP_ONLY[operation.name]!(body)) ||
  (Object.hasOwn(AGENT_HUMAN_FIELDS, operation.name) && AGENT_HUMAN_FIELDS[operation.name]!.some(field => body[field] !== undefined));
/** Agent module operations are opt-in; every other operation is Agent-callable unless it is human-only. */
export const agentCallable = (operation: Pick<Registered, 'name' | 'mcp' | 'module'>) =>
  !humanOnly(operation) && !(operation.module === 'agent' && operation.mcp !== true);

export function metadata(operation: Registered) {
  const { module, method, name, path, summary, versionKind, external } = operation;
  return { module, method, name, path, summary, requires_version: Boolean(versionKind), external: Boolean(external),
    mcp: agentCallable(operation), human_only: humanOnly(operation) };
}

export function grantAllows(operation: Registered, grant: { access: 'read' | 'write'; tools?: readonly string[] }, source: 'rest' | 'mcp') {
  return operation.mcp !== false &&
    !(operation.module === 'agent' && (source === 'rest' || operation.mcp !== true)) &&
    (grant.access === 'write' || operation.method === 'GET') &&
    (!grant.tools || grant.tools.includes(operation.name));
}

export function allowed(operation: Registered, principal: Principal, member: { role: Role; scopes?: string[] }, source: 'rest' | 'mcp') {
  return operation.roles.includes(member.role) && brandOperationAllowed(member.scopes, operation.name, operation.method) &&
    (!principal.grant || grantAllows(operation, principal.grant, source));
}

export function expectedVersion(value: unknown) {
  if (value === undefined) return undefined;
  const match = typeof value === 'string' ? /^(?:"(\d+)"|(\d+))$/.exec(value) : null;
  const version = typeof value === 'number' ? value : Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version < 1) throw invalid('Expected a positive integer version');
  return version;
}

const idempotencySyntax = new RegExp(idempotencyPattern);

export function idempotencyKey(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !idempotencySyntax.test(value)) throw invalid('Invalid idempotency key');
  return value;
}

export function stringMap(value: unknown, query = false): Record<string, string> {
  return Object.fromEntries(Object.entries(bodyObject(value)).map(([key, field]) => {
    if (typeof field !== 'string' && !(query && (typeof field === 'number' || typeof field === 'boolean'))) {
      throw invalid(`${key} must be a string`);
    }
    return [key, String(field)];
  }));
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

interface Outcome { body: { data: unknown; next_cursor?: string | null }; etag?: string; status: number; replayed?: true }
interface IdempotencyRecord { fingerprint: string; access?: string; grantId?: string; expires: number; outcome: Outcome }

function paginate(data: unknown[], query: Record<string, string>, cursorScope: string, secret: string): Outcome['body'] {
  const limit = Number(query.limit ?? pageSize.default);
  if (!Number.isInteger(limit) || limit < 1 || limit > pageSize.maximum) throw invalid('limit must be between 1 and 200');
  const sign = (value: string) => createHmac('sha256', secret).update(`${cursorScope}/${value}`).digest('base64url');
  const cursor = query.cursor;
  let offset = 0;
  if (cursor !== undefined) {
    const [position, signature, extra] = cursor.split('.');
    if (!/^\d{1,12}$/.test(position) || signature !== sign(position) || extra !== undefined) throw invalid('Invalid cursor');
    offset = Number(position);
  }
  const next = String(offset + limit);
  return { data: data.slice(offset, offset + limit), next_cursor: data.length > offset + limit ? `${next}.${sign(next)}` : null };
}

export interface OperationPrincipal { actorId: string; grantId?: string; credentialLabel?: string }

const resourcePrefixes: [RegExp, string][] = [
  [/^workspace_brand_/, 'brand'], [/^workspace_market_/, 'market'], [/^commerce_store_import$|^import_/, 'import_batch'],
  [/^commerce_store_/, 'store'], [/^commerce_product_/, 'product'], [/^commerce_variant_/, 'product_variant'],
  [/^commerce_record_listing$/, 'listing_snapshot'], [/^campaign_goal_/, 'campaign_goal'], [/^campaign_plan_slot_/, 'campaign_plan_slot'],
  [/^campaign_/, 'campaign'], [/^content_commit_revision$/, 'content_revision'],
  [/^content_(?:create|autosave|update)_variant$|^content_create_translation$/, 'content_variant'], [/^content_create_(?:item|draft)$/, 'content_item'],
  [/^publishing_(?:create|update|request|cancel|submit).*target|^publishing_request_approval$/, 'publish_target'],
  [/^ads_.*proposal$/, 'ad_proposal'], [/^links_/, 'short_link'], [/^analytics_record_observations$/, 'metric_observation'],
  [/^posts_|^publishing_register_post$/, 'platform_post'], [/^agent_jobs_/, 'agent_job'], [/^change_sets_/, 'change_set'],
  [/^agent_connection_/, 'agent_connection'], [/^worker_social_status_request$/, 'worker_social_status_task'],
];

function resultRow(data: unknown) {
  if (!isObject(data)) return undefined;
  if (typeof data.id === 'string') return data;
  return Object.values(data).find((value): value is Data => isObject(value) && typeof value.id === 'string');
}

/** One feed row per committed write. Readers group bursts and never treat a missing label as a person. */
export function activityEvent(operation: Pick<Registered, 'name'>, principal: OperationPrincipal, source: 'rest' | 'mcp',
  requestId: string, now: string, data: unknown, params: Record<string, string> = {}) {
  const row = resultRow(data);
  const text = (value: unknown) => typeof value === 'string' && value ? value.slice(0, 200) : null;
  const resourceType = resourcePrefixes.find(([pattern]) => pattern.test(operation.name))?.[1] ??
    (typeof row?.kind === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(row.kind) ? row.kind : null);
  const id = randomUUID();
  return {
    id, version: 1, created_at: now, updated_at: now, occurred_at: now, action: operation.name,
    actor_id: principal.actorId, actor_type: principal.grantId ? 'agent' : 'human',
    credential_id: principal.grantId ?? null, credential_label: principal.credentialLabel ?? null,
    source, request_id: requestId, resource_id: text(row?.id) ?? text(params.id), resource_type: resourceType,
    resource_title: text(row?.title) ?? text(row?.name),
    brand_id: text(row?.brand_id) ?? (resourceType === 'brand' ? text(row?.id) : null),
  };
}

export async function runScopedOperation(records: Records, scope: Scope, principal: OperationPrincipal,
  role: Role, requestId: string, operation: Registered, input: Input, source: 'rest' | 'mcp', config: Config,
  enrich = workspaceServices([]), identity?: Records, brandScopes?: readonly string[]) {
  const readOnly = operation.method === 'GET';
  const scopes = brandScopes ?? identity?.get<Membership>(`member/${principal.actorId}/${scope.workspaceId}`)?.scopes;
  if (!brandOperationAllowed(scopes, operation.name, operation.method)) throw denied();
  if (principal.grantId && humanDecision(operation, input.body)) throw humanRequired(operation.name);
  const base = makeContext(records, scope, role, requestId);
  const create = base.create;
  const via = principal.grantId ? 'agent' : 'human';
  base.create = (kind, values) => create(kind, { ...values, created_via: values.created_via ?? via });
  let ctx: Context = enrich(base, identity, principal.grantId);
  if (scopes?.length) ctx = scopedBrandContext(ctx, scopes);
  ctx = operation.scopeContext?.(ctx, input) ?? ctx;
  guardExternalOperation(ctx, operation);
  const { cursor, limit, ...filters } = input.query;
  const access = digest(canonical([role, [...(scopes ?? [])].sort()]));
  const queryScope = digest(canonical([scope.workspaceId, principal.actorId, principal.grantId, access, operation.name, input.params, filters]));
  // Each credential has its own key space: one person's Agents pick keys like "brand-1" independently.
  const key = !readOnly && input.idempotencyKey
    ? `idem/${principal.actorId}/${principal.grantId ? `${principal.grantId}/` : ''}${digest(input.idempotencyKey)}` : undefined;
  const fingerprint = key ? digest(canonical([operation.method, operation.path, input.params, input.query, input.body, input.expectedVersion])) : '';
  const existing = key && records.get<IdempotencyRecord>(key);
  if (existing && existing.expires > nowSeconds()) {
    if (existing.grantId !== principal.grantId || (existing.access === undefined ? scopes?.length : existing.access !== access)) throw denied();
    if (existing.fingerprint !== fingerprint) throw new Problem(422, 'IDEMPOTENCY_MISMATCH', 'Idempotency key was used for a different request');
    return { ...existing.outcome, replayed: true };
  }
  if (!readOnly && !input.idempotencyKey) {
    if (operation.external) throw invalid('An idempotency key is required for external operations');
    if (operation.idempotencyRequired) throw invalid('An idempotency key is required');
  }
  if (operation.versionKind) {
    if (input.expectedVersion === undefined) throw new Problem(428, 'VERSION_REQUIRED', 'If-Match or expected_version is required');
    const resourceId = input.params.id ?? scope.workspaceId;
    const current = ctx.get(operation.versionKind, resourceId);
    if (current.version !== input.expectedVersion) {
      throw new Problem(409, 'VERSION_CONFLICT', 'The resource version changed', {
        current_version: current.version, expected_version: input.expectedVersion, updated_at: current.updated_at,
      });
    }
  }
  const operationInput = { ...input, query: readOnly ? filters : input.query };
  const data = readOnly && source === 'rest' && operation.listForRest
    ? await operation.listForRest(ctx, operationInput)
    : await operation.run(ctx, operationInput);
  const body = readOnly && Array.isArray(data) ? paginate(data, { cursor, limit }, queryScope, config.secret) : { data: data ?? {} };
  const version = isObject(data) && typeof data.version === 'number' ? data.version : undefined;
  const accepted = typeof operation.accepted === 'function' ? operation.accepted(data) : operation.accepted;
  const outcome: Outcome = { body, etag: version === undefined ? undefined : `"${version}"`, status: accepted ? 202 : 200 };
  if (!readOnly) {
    const id = randomUUID();
    records.put(`audit/${id}`, {
      id, action: operation.name, actor_id: principal.actorId, credential_id: principal.grantId,
      source, request_id: requestId, occurred_at: ctx.now, resource_id: input.params.id ?? (isObject(data) ? data.id : undefined),
    });
    const activity = activityEvent(operation, principal, source, requestId, ctx.now, data, input.params);
    records.put(`row/activity_event/${activity.id}`, activity);
    records.put('stream/revision', (records.get<number>('stream/revision') ?? 0) + 1);
    if (key) records.put(key, { fingerprint, access, grantId: principal.grantId, expires: nowSeconds() + 86400, outcome } satisfies IdempotencyRecord);
  }
  return outcome;
}

export function operationRunner(store: Store, auth: Auth, config: Config, operations: readonly Registered[] = [], portal?: PortalHooks, egress?: CustomerEgress) {
  const enrich = workspaceServices(operations, egress, !config.production);
  return async function invoke(req: FastifyRequest, wsId: string, operation: Registered, input: Input, source: 'rest' | 'mcp') {
    const readOnly = operation.method === 'GET';
    return store.transaction({ readOnly, identityWrite: !readOnly }, async tx => {
      const principal = auth.authenticate(tx.identity, req, source === 'mcp' ? 'bearer' : 'both');
      const ws = membership(tx.identity, principal, wsId);
      if (!allowed(operation, principal, ws, source)) throw denied();
      if (!readOnly) auth.csrf(req, principal);
      const records = await tx.workspace({ workspaceId: ws.id, tenantId: ws.tenantId, actorId: principal.user.id });
      const owning = portal ? bindTeamOperation(operation, workspaceTeam(tx.identity, portal.team)) : operation;
      const result = await runScopedOperation(records, { workspaceId: ws.id, tenantId: ws.tenantId, actorId: principal.user.id },
        { actorId: principal.user.id, grantId: principal.grant?.id }, ws.role, req.id, owning, input, source, config, enrich, tx.identity);
      if (portal && !readOnly && operation.module === 'team') portal.index(tx.identity, records, ws, operation.name, result.body.data);
      return result;
    });
  };
}
export type Invoke = ReturnType<typeof operationRunner>;

export function restInput(req: FastifyRequest): Input {
  const { ws: _ws, ...params } = stringMap(req.params);
  return {
    body: bodyObject(req.body), params, query: stringMap(req.query),
    expectedVersion: expectedVersion(header(req, 'if-match')),
    idempotencyKey: idempotencyKey(header(req, 'idempotency-key')),
  };
}
