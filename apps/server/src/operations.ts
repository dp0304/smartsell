import { createHmac, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { idempotencyPattern, pageSize, Problem, type Context, type Data, type Input, type Operation, type Role } from '@smartsell/contracts';
import type { Records, Scope, Store } from '@smartsell/db';
import type { FastifyRequest } from 'fastify';
import { bodyObject, denied, digest, header, invalid, isObject, membership, nowSeconds, type Auth, type Principal } from './identity.js';
import type { Config } from './config.js';
import { makeContext } from './context.js';
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

export function metadata({ module, method, name, path, summary, versionKind, external }: Registered) {
  return { module, method, name, path, summary, requires_version: Boolean(versionKind), external: Boolean(external) };
}

export function allowed(operation: Registered, principal: Principal, member: { role: Role; scopes?: string[] }, source: 'rest' | 'mcp') {
  return operation.roles.includes(member.role) && brandOperationAllowed(member.scopes, operation.name, operation.method) && (!principal.grant || (
    operation.mcp !== false &&
    !(operation.module === 'agent' && (source === 'rest' || operation.mcp !== true)) &&
    (principal.grant.access === 'write' || operation.method === 'GET') &&
    (!principal.grant.tools || principal.grant.tools.includes(operation.name))
  ));
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

interface Outcome { body: { data: unknown; next_cursor?: string | null }; etag?: string; status: number }
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

export async function runScopedOperation(records: Records, scope: Scope, principal: { actorId: string; grantId?: string },
  role: Role, requestId: string, operation: Registered, input: Input, source: 'rest' | 'mcp', config: Config,
  enrich = workspaceServices([]), identity?: Records, brandScopes?: readonly string[]) {
  const readOnly = operation.method === 'GET';
  const scopes = brandScopes ?? identity?.get<Membership>(`member/${principal.actorId}/${scope.workspaceId}`)?.scopes;
  if (!brandOperationAllowed(scopes, operation.name, operation.method)) throw denied();
  let ctx: Context = enrich(makeContext(records, scope, role, requestId), identity, principal.grantId);
  if (scopes?.length) ctx = scopedBrandContext(ctx, scopes);
  ctx = operation.scopeContext?.(ctx, input) ?? ctx;
  guardExternalOperation(ctx, operation);
  const { cursor, limit, ...filters } = input.query;
  const access = digest(canonical([role, [...(scopes ?? [])].sort()]));
  const queryScope = digest(canonical([scope.workspaceId, principal.actorId, principal.grantId, access, operation.name, input.params, filters]));
  const key = !readOnly && input.idempotencyKey ? `idem/${principal.actorId}/${digest(input.idempotencyKey)}` : undefined;
  const fingerprint = key ? digest(canonical([operation.method, operation.path, input.params, input.query, input.body, input.expectedVersion])) : '';
  const existing = key && records.get<IdempotencyRecord>(key);
  if (existing && existing.expires > nowSeconds()) {
    if (existing.grantId !== principal.grantId || (existing.access === undefined ? scopes?.length : existing.access !== access)) throw denied();
    if (existing.fingerprint !== fingerprint) throw new Problem(422, 'IDEMPOTENCY_MISMATCH', 'Idempotency key was used for a different request');
    return existing.outcome;
  }
  if (operation.external && !readOnly && !input.idempotencyKey) throw invalid('An idempotency key is required for external operations');
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
