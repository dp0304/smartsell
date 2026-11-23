import { idempotencyPattern, Problem, type Data, type Input } from '@smartsell/contracts';
import { headerAcceptsEventStream, mcpEventStream } from '../extensions/mcp-sse.js';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { invalid, requestObject } from '../auth.js';
import { mcpAuditBusinessStatus, mcpAuditErrorCode, summarizeMcpTarget } from './mcp-call-audit.js';
import { recordAgentToolCall } from '../modules/agent/agent-audit.js';
import { invalid as invalidOperation } from '../identity.js';
import { createMcpCommandBridge, createMcpHandler, MCP_TOOLS, type McpPrincipal, type McpToolDefinition } from '../extensions/mcp.js';
import { DomainError, type Entity } from '../modules/types.js';
import type { Registry } from '../registry.js';
import { missingWorkspace, unauthenticated, type Store, type Unit } from '../store.js';
import { agentJobMcp } from './agent-job-mcp.js';
import type { AgentContext } from '../modules/agent/agent-jobs.js';
import { intelMcpCommands, intelMcpOutput } from './intel-mcp.js';
import { brandOperationAllowed } from './brand-access.js';
import { describeOperationTool, operationResources, operationToolDescription, parseOperationTool, readOperationResource, resourceTemplates, serveMcpRequest } from './operation-mcp.js';
import { operationRecords } from './operation-records.js';
import { agentCallable, grantAllows, humanOnly, restInput, runScopedOperation, type Registered } from '../operations.js';
import { isRecord } from '../extensions/mcp-tools.js';
import { agentToolAllowed } from '../extensions/mcp-agent-catalog.js';
import { workspaceServices } from './workspace-services.js';
import { makeContext } from '../context.js';
import { expireCredentialLeases } from '../modules/agent/operations.js';
import type { OperationExecutor } from '../operation-server.js';
import { agentInstructions, registerAgentConnections, touchAgentConnection, verifyAgentConnection, workerSocialRequestKey, type SealedCredential } from './agent-connections.js';
import { workerSocialStatusToolNames } from '../modules/account/worker-social-status.js';
import { humanRequired } from '../agent-actor.js';

type Credential = SealedCredential;
type Access = 'read' | 'write';
interface Grant { row: Entity; tools: readonly string[]; access: Access; label?: string; connection: boolean }
/** Filled after the Operation routes register, so MCP tools share their executor. */
export interface OperationHost { mounted?: readonly Registered[]; execute?: OperationExecutor }
interface Options { host?: OperationHost; csrf?(request: FastifyRequest): void; origin?: string }

const hidden = new Set(['automation_rules_list', 'workflow_templates_list', 'change_sets_create', 'change_sets_get']);
const approvedReads = new Set(['search_query', 'knowledge_get_context', 'agent_preview_context', 'catalog_list_facts']);
const describeName = 'smartsell_operations_describe';
const callName = 'smartsell_operation_call';
const desktopOperations = new Set(['zhihu_stats_create', 'zhihu_stats_get', 'desktop_request_capability', 'desktop_get_capability_request', ...workerSocialStatusToolNames]);
/** One MCP tool per Operation for the flows an Agent runs most. Everything else is reachable through smartsell_operation_call. */
const curated = [
  'worker_catalog_list', 'worker_catalog_request_import',
  ...desktopOperations,
  'workspace_get_context', 'workspace_brands_list', 'workspace_brand_get', 'workspace_brand_create', 'workspace_brand_update',
  'workspace_markets_list', 'workspace_market_create', 'workspace_market_update',
  'commerce_store_list', 'commerce_store_create', 'catalog_search', 'catalog_get_product', 'commerce_product_create', 'commerce_product_update',
  'commerce_variant_create', 'commerce_variant_update', 'commerce_record_listing', 'market_snapshot',
  'import_template_list', 'import_create', 'import_get', 'import_preview', 'import_rows', 'import_confirm', 'commerce_store_import',
  'campaign_list', 'campaign_get_context', 'campaign_create_draft', 'campaign_set_products', 'campaign_goal_list', 'campaign_goal_create',
  'campaign_goal_update', 'campaign_plan_slot_list', 'campaign_plan_slot_create', 'campaign_plan_slot_update',
  'content_list', 'content_get', 'content_create_item', 'content_create_draft', 'content_create_variant', 'content_get_variant',
  'content_autosave_variant', 'content_update_variant', 'content_commit_revision', 'content_list_revisions',
  'account_list_social_accounts', 'publishing_list_targets', 'publishing_get_target', 'publishing_create_target', 'publishing_request_approval',
  'ads_list_accounts', 'ads_list_proposals', 'ads_create_proposal', 'ads_revise_proposal', 'ads_submit_proposal', 'ads_import_report',
  'links_list', 'links_create', 'links_batch', 'analytics_record_observations', 'metrics_query', 'posts_list', 'posts_register_manual',
  'agent_jobs_list', 'agent_jobs_get', 'agent_jobs_claim', 'agent_jobs_heartbeat', 'agent_jobs_submit_result', 'agent_jobs_handoff',
  'publishing_list_approvals',
];
const operationOutput = { type: 'object', properties: {
  data: {}, next_cursor: { type: ['string', 'null'] }, etag: { type: 'string' }, error: { type: 'object' },
} };
const denied = () => new DomainError('forbidden', 'Credential unavailable', 403);

function operationTool(op: Registered): McpToolDefinition {
  const { inputSchema, outputSchema } = describeOperationTool(op);
  const required = (inputSchema.required ?? []).filter(name => name !== 'workspace_id');
  const read = op.method === 'GET';
  const hints = [op.versionKind ? 'pass expected_version from the row you read' : '', read ? '' : 'send an idempotency_key'].filter(Boolean);
  return {
    name: op.name, module: op.module, action: op.name, operation: op.name,
    description: `${operationToolDescription(op)} (${op.method} ${op.path}).${hints.length ? ` Writes: ${hints.join('; ')}.` : ''}`,
    inputSchema: { ...inputSchema, required },
    outputSchema: workerSocialStatusToolNames.has(op.name) ? outputSchema ?? operationOutput : operationOutput,
    annotations: { readOnlyHint: read, destructiveHint: op.method === 'DELETE', idempotentHint: read || op.method === 'PUT', openWorldHint: false },
    sideEffect: false, needsOutputPolicy: false, result: 'operation_call',
    parse: args => ({ body: args, params: {}, query: {} }),
  };
}

const genericTools: McpToolDefinition[] = [{
  name: describeName, module: 'mcp', action: describeName, result: 'operation_call', sideEffect: false, needsOutputPolicy: false,
  description: 'List the SmartSell operations this token may call. Without arguments it returns the modules; pass module or a search term q for name, method, path and summary; name one operation (or narrow to 15 or fewer) to get its input_schema.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    workspace_id: { type: 'string' }, module: { type: 'string' }, q: { type: 'string' }, operation: { type: 'string' },
  } },
  outputSchema: operationOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  parse: args => ({ body: args, params: {}, query: {} }),
}, {
  name: callName, module: 'mcp', action: callName, result: 'operation_call', sideEffect: false, needsOutputPolicy: false,
  description: 'Run any SmartSell operation this token may call, by name from smartsell_operations_describe. Returns {data, next_cursor?, etag?}; errors return {code, message, details}.',
  inputSchema: { type: 'object', required: ['operation'], additionalProperties: false, properties: {
    workspace_id: { type: 'string' }, operation: { type: 'string' },
    params: { type: 'object', additionalProperties: { type: 'string' } },
    query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    body: { type: 'object' }, expected_version: { type: 'integer', minimum: 1 },
    idempotency_key: { type: 'string', pattern: idempotencyPattern,
      description: `For worker_social_status_request: ${workerSocialRequestKey}` },
  } },
  outputSchema: operationOutput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  parse: args => ({ body: args, params: {}, query: {} }),
}];

/** Agents read only approved knowledge and facts, whichever tool reaches them. */
function approvedInput(name: string, input: Input): Input {
  if (name === 'knowledge_get_context') return { ...input, query: { ...input.query, include_proposed: 'false' } };
  if (name === 'catalog_list_facts') return { ...input, query: { ...input.query, approved_only: 'true' }, body: { ...input.body, approved_only: true } };
  return input;
}

export function registerCommandMcp(app: FastifyInstance, store: Store, registry: Registry, secret: string,
  origins: ReadonlySet<string>, sessionHash: (request: FastifyRequest) => string | undefined,
  operationApi?: Parameters<typeof intelMcpCommands>[1], { host = {}, csrf, origin }: Options = {}) {
  const streams = new Set<ReturnType<typeof mcpEventStream>>();
  const active = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.destroy();
    for (const request of active) request.abort();
  });
  const key = createHmac('sha256', secret).update('smartsell:command-mcp:v1').digest();
  const intel = intelMcpCommands(MCP_TOOLS, operationApi);
  const lookup = (module: string, action: string) => module === 'intel' ? intel[action] : registry.get(module)?.get(action);
  const operations = new Map(operationApi?.operations.filter(op => op.method === 'GET' && !op.external &&
    approvedReads.has(op.name) && agentToolAllowed(op)).map(op => [op.name, op]));
  const additionalTools = [...operations.values()].map(op => {
    const schema = describeOperationTool(op);
    return {
      name: op.name, module: op.module, action: op.name, description: op.summary,
      inputSchema: schema.inputSchema, outputSchema: schema.outputSchema ?? {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      sideEffect: false, needsOutputPolicy: true, result: 'approved_read',
      parse(args) {
        try { return parseOperationTool(op, args).input; }
        catch (error) { if (!(error instanceof Problem)) throw error; }
      },
    } satisfies McpToolDefinition;
  });
  const tools = [...MCP_TOOLS.filter(tool => !hidden.has(tool.name) && lookup(tool.module, tool.action)), ...additionalTools];
  const legacyNames = new Set(tools.map(tool => tool.name));
  const enrich = workspaceServices(operationApi?.operations ?? []);

  let built: { byName: Map<string, Registered>; tools: McpToolDefinition[] } | undefined;
  function operationCatalog() {
    if (built || !host.mounted || !host.execute) return built;
    const byName = new Map(host.mounted.map(op => [op.name, op]));
    const views = host.mounted.filter(op => op.method === 'GET' && op.path.startsWith('/views/')).map(op => op.name);
    const names = [...new Set([...curated, ...views])].filter(name => byName.has(name) && agentCallable(byName.get(name)!));
    return built = { byName, tools: [...names.map(name => operationTool(byName.get(name)!)), ...genericTools] };
  }
  /** Agent connections use Operations for Agent jobs; legacy tokens keep the Commands job tools they were issued. */
  function catalog(connection: boolean): readonly McpToolDefinition[] {
    const ops = operationCatalog()?.tools;
    if (!ops) return tools;
    return connection
      ? [...tools.filter(tool => tool.module === 'intel' || tool.result === 'approved_read'), ...ops]
      : [...tools, ...ops.filter(tool => !legacyNames.has(tool.name))];
  }
  const definition = (name: string, connection: boolean) => catalog(connection).find(tool => tool.name === name);

  function toolAllowed(unit: Unit, name: string) {
    const op = operations.get(name);
    return op ? op.roles.includes(unit.context.role) && brandOperationAllowed(unit.brandScopes, name, op.method) : !unit.brandScopes?.length;
  }
  function operationAllowed(unit: Unit, op: Registered, access: Access) {
    return op.roles.includes(unit.context.role) && brandOperationAllowed(unit.brandScopes, op.name, op.method) &&
      grantAllows(op, { access }, 'mcp') && agentCallable(op);
  }
  function toolPermitted(unit: Unit, tool: McpToolDefinition, access: Access) {
    if (tool.name === describeName) return true;
    if (tool.name === callName) return access === 'write';
    const op = tool.operation ? operationCatalog()?.byName.get(tool.operation) : undefined;
    if (op) return operationAllowed(unit, op, access);
    if (operations.has(tool.name)) return toolAllowed(unit, tool.name);
    return toolAllowed(unit, tool.name) && !!lookup(tool.module, tool.action)?.roles.includes(unit.context.role);
  }
  async function readOperation(unit: Unit, grants: readonly string[], credential: Credential, name: string, input: Input, requestId: string, source: 'rest' | 'mcp') {
    const op = operations.get(name);
    if (!op || !grants.includes(name) || !toolAllowed(unit, name) || (source === 'rest' && op.module === 'agent')) throw denied();
    const { context } = unit;
    const { records } = await operationRecords(context, true);
    return runScopedOperation(records, context, { actorId: context.actorId, grantId: credential.id }, context.role,
      requestId, op, approvedInput(name, input), source, operationApi!.config, enrich, undefined, unit.brandScopes);
  }
  function describe(unit: Unit, grant: Grant, args: Data) {
    const catalogue = operationCatalog()!;
    const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
    const [module, q, name] = [text(args.module), text(args.q), text(args.operation)];
    const matches = [...catalogue.byName.values()].filter(op => operationAllowed(unit, op, grant.access) &&
      (!desktopOperations.has(op.name) || grant.tools.includes(op.name)) && (!module || op.module === module) && (!name || op.name === name) &&
      (!q || `${op.name} ${op.summary} ${op.path}`.toLowerCase().includes(q)));
    // Without a filter the full list costs an Agent ~25k tokens; return a module index instead.
    if (!module && !q && !name) {
      const counts = new Map<string, string[]>();
      for (const op of matches) counts.set(op.module, [...counts.get(op.module) ?? [], op.name]);
      return [...counts].map(([module, names]) => ({ module, operations: names.length, examples: names.slice(0, 6),
        next: `${describeName}({"module":"${module}"})` }));
    }
    const detailed = Boolean(name) || matches.length <= 15;
    return matches.map(op => {
      const { inputSchema } = describeOperationTool(op);
      const { workspace_id: _workspace, ...properties } = inputSchema.properties as Record<string, unknown>;
      return { name: op.name, method: op.method, path: op.path, summary: op.summary,
        ...(op.versionKind && { requires_version: true }),
        ...(detailed && { module: op.module, input_schema: { ...inputSchema, properties,
          required: (inputSchema.required ?? []).filter(field => field !== 'workspace_id') } }) };
    });
  }
  function seal(credential: Credential) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
    return `ss_command_${Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url')}`;
  }
  function open(token: string): Credential | undefined {
    if (!/^ss_command_[A-Za-z0-9_-]{60,500}$/.test(token)) return;
    try {
      const data = Buffer.from(token.slice('ss_command_'.length), 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
    } catch { return undefined; }
  }
  function bearerCredential(req: FastifyRequest) {
    return open(/^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
  }
  async function check(unit: Unit, credential: Credential): Promise<Grant> {
    const row = await unit.context.get('mcp_runtime', 'credential', credential.id);
    if (!row || row.data.actor_id !== unit.context.actorId || row.data.revoked === true || !(row.data.expires > Date.now())) throw unauthenticated();
    const connection = row.data.kind === 'agent_connection';
    // A connection's tools follow the live catalog; a legacy token keeps the list fixed when it was issued.
    return { row, connection, access: row.data.access === 'read' ? 'read' : 'write',
      tools: connection ? catalog(true).map(tool => tool.name) : row.data.tools as string[],
      ...(typeof row.data.label === 'string' && { label: row.data.label }) };
  }
  function withCredential<T>(credential: Credential, run: (unit: Unit, grant: Grant) => Promise<T>) {
    return store.workspace(credential.sessionHash, credential.workspaceId, async unit => run(unit, await check(unit, credential)), credential.id);
  }
  if (csrf) registerAgentConnections(app, { store, secret, sessionHash, csrf, seal,
    mcpUrl: new URL('/mcp', origin ?? operationApi?.config.origin ?? 'http://127.0.0.1:3401').href });
  app.post<{ Params: { wid: string } }>('/api/v1/workspaces/:wid/tokens', async (req, reply) => {
    const input = requestObject(req.body);
    const access = input.access ?? 'read';
    const universe = catalog(false);
    if (!['read', 'write'].includes(access) || (input.tools !== undefined && (!Array.isArray(input.tools) ||
      input.tools.some((name: unknown) => !universe.some(tool => tool.name === name))))) throw invalid('Invalid access or tools');
    const hash = sessionHash(req);
    if (!hash) throw denied();
    const workspaceId = req.params.wid;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(workspaceId)) throw denied();
    const id = randomUUID();
    const expires_in = 12 * 3600;
    await store.workspace(hash, workspaceId, async unit => {
      const permitted = universe.filter(tool => (access === 'write' || tool.annotations.readOnlyHint) &&
        (input.tools === undefined || input.tools.includes(tool.name)) && toolPermitted(unit, tool, access));
      await unit.command({ module: 'agent', action: 'issue_mcp_token', key: `mcp-issue/${id}`, fingerprint: '' }, async () => {
        await unit.context.insert('mcp_runtime', 'credential', { actor_id: unit.context.actorId, expires: Date.now() + expires_in * 1000,
          access, tools: permitted.map(tool => tool.name) }, id);
      });
    });
    return reply.code(201).send({ data: { id, expires_in, token: seal({ sessionHash: hash, workspaceId, id }) } });
  });
  app.delete<{ Params: { wid: string; id: string } }>('/api/v1/workspaces/:wid/tokens/:id', async (req, reply) => {
    const { wid, id } = req.params;
    if (![wid, id].every(value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))) throw denied();
    await store.workspace(sessionHash(req), wid, async unit => {
      const row = await unit.context.get('mcp_runtime', 'credential', id);
      if (!row || row.data.actor_id !== unit.context.actorId) throw denied();
      await unit.command({ module: 'agent', action: 'revoke_mcp_token', key: `mcp-revoke/${randomUUID()}`, fingerprint: '' }, async () => {
        await unit.context.update('mcp_runtime', 'credential', id, { revoked: true }, row.version);
        const { reapAgentJobLeases } = await import('../modules/agent/agent-jobs.js');
        await reapAgentJobLeases(unit.context, id);
        const { records, flush } = await operationRecords(unit.context, false);
        expireCredentialLeases(makeContext(records, unit.context, unit.context.role, req.id), id);
        await flush();
      });
    });
    return reply.code(204).send();
  });
  app.route({
    method: ['POST', 'GET', 'DELETE'], url: '/mcp', bodyLimit: 1024 * 1024,
    async handler(req, reply) {
      let credential: Credential | undefined;
      let connection = false;
      let replayed: true | undefined;
      let auditOutput: unknown;
      const auditArgs = isRecord(req.body) && isRecord(req.body.params) ? req.body.params.arguments : undefined;
      const selectedFor = (principal: Pick<McpPrincipal, 'tokenId' | 'workspaceId'>) => {
        const selected = credential;
        if (!selected || selected.id !== principal.tokenId || selected.workspaceId !== principal.workspaceId) throw denied();
        return selected;
      };
      const bridge = createMcpCommandBridge({
        workspace(principal, run) {
          return withCredential(selectedFor(principal), run);
        },
        lookup(module, action) {
          const command = lookup(module, action);
          return command && module === 'agent' ? agentJobMcp(action, command) : command;
        },
        permit: (_ctx, req, unit) => req.principal.allowedTools.includes(req.tool.name) && toolAllowed(unit, req.tool.name),
      });
      if (req.method === 'GET' && headerAcceptsEventStream(req.headers.accept)) {
        if (req.headers.origin && !origins.has(req.headers.origin)) return reply.code(403).send();
        const selected = bearerCredential(req);
        if (!selected) return reply.header('www-authenticate', 'Bearer').code(401).send();
        const verify = async () => {
          await store.workspace(selected.sessionHash, selected.workspaceId, unit => check(unit, selected), selected.id);
          return true;
        };
        try { await verify(); } catch (error) {
          if (error instanceof DomainError && error.status < 500) return reply.header('www-authenticate', 'Bearer').code(error.status).send();
          throw error;
        }
        const stream = mcpEventStream(verify);
        streams.add(stream);
        reply.raw.once('close', () => { streams.delete(stream); stream.destroy(); });
        return reply.type('text/event-stream').header('cache-control', 'no-store').header('x-accel-buffering', 'no').send(stream);
      }
      function invokeRead(principal: McpPrincipal, tool: string, input: Input) {
        const selected = selectedFor(principal);
        return withCredential(selected, (unit, grant) => readOperation(unit, grant.tools, selected, tool, input, req.id, 'mcp'));
      }
      function invokeOperation(principal: McpPrincipal, tool: McpToolDefinition, args: Data) {
        const selected = selectedFor(principal);
        const catalogue = operationCatalog();
        if (!catalogue || !host.execute) throw new Problem(503, 'UNAVAILABLE', 'Operations are not available on this server');
        return withCredential(selected, async (unit, grant) => {
          if (!grant.tools.includes(tool.name) || !toolPermitted(unit, tool, grant.access)) {
            throw new Problem(403, 'PERMISSION_DENIED', `${tool.name} is not available to this credential`);
          }
          if (tool.name === describeName) return { status: 200, body: { data: describe(unit, grant, args) } };
          const name = tool.name === callName ? args.operation : tool.operation;
          const op = typeof name === 'string' ? catalogue.byName.get(name) : undefined;
          if (!op) throw new Problem(404, 'UNKNOWN_OPERATION', `Unknown operation ${String(name)}. Call ${describeName} to list operations.`);
          // Refuse by name before parsing; stop-only endpoints are checked against their body in the shared runner.
          if (humanOnly(op)) throw humanRequired(op.name);
          if (!operationAllowed(unit, op, grant.access) || (desktopOperations.has(op.name) && !grant.tools.includes(op.name))) {
            throw new Problem(403, 'PERMISSION_DENIED', `${op.name} is not available to this credential`);
          }
          if (workerSocialStatusToolNames.has(op.name) && args.workspace_id !== undefined && args.workspace_id !== selected.workspaceId) {
            throw new Problem(404, 'NOT_FOUND', 'Workspace not found');
          }
          const { operation: _operation, ...rest } = args;
          const { input } = parseOperationTool(op, { ...(tool.name === callName ? rest : args), workspace_id: selected.workspaceId });
          return host.execute!(unit, op, approvedInput(op.name, input), { requestId: req.id, source: 'mcp', grantId: selected.id, credentialLabel: grant.label });
        });
      }
      const handler = createMcpHandler({ ...bridge, allowedOrigins: [...origins], additionalTools,
        auditEarlyDenials: true,
        async audit(event) {
          const selected = selectedFor(event);
          const tool = definition(event.toolName, connection);
          const name = tool?.name === callName && isRecord(auditArgs) ? auditArgs.operation : tool?.operation ?? tool?.name;
          const op = typeof name === 'string' ? operationCatalog()?.byName.get(name) ?? operations.get(name) : undefined;
          const persist = async (unit: Unit) => {
            const { context } = unit;
            if (context.actorId !== event.actorId || context.tenantId !== event.tenantId) throw denied();
            await unit.command({ module: 'agent', action: `mcp_audit_${event.stage}`,
              key: `mcp-audit-${event.stage}/${event.callId}`, fingerprint: '' }, async () => {
              if (event.stage === 'start') {
                await recordAgentToolCall(context, {
                  tool: event.toolName, credentialId: selected.id, requestId: req.id, outcome: 'pending', elapsedMs: 0,
                  inputHash: createHmac('sha256', key).update(event.inputHash).digest('hex'),
                  sideEffect: event.sideEffect || tool?.annotations.readOnlyHint === false,
                  operation: op?.name,
                  target: op ? summarizeMcpTarget(op, undefined, selected.workspaceId).target : tool?.name ?? 'workspace',
                }, event.callId);
                return;
              }
              const row = await context.get('agent', 'tool_call', event.callId);
              if (!row || row.data.credential_id !== selected.id || row.data.request_id !== req.id) throw denied();
              const { agent_job_id, task_id, device_id } = summarizeMcpTarget(op, auditArgs, selected.workspaceId, auditOutput);
              await context.update('agent', 'tool_call', row.id, { outcome: event.outcome, elapsed_ms: event.elapsedMs,
                ...(event.code && { error_code: mcpAuditErrorCode(event.code) }),
                ...(event.outcome === 'success' && { agent_job_id, task_id, device_id, status: mcpAuditBusinessStatus(auditOutput), replayed }),
              }, row.version);
              if (event.outcome === 'success' && event.toolName === describeName) await verifyAgentConnection(context, selected.id);
            });
          };
          // A recovered local connection may require its credential to resolve the backing session.
          // A live browser session can still finalize an audit if the grant was revoked during dispatch.
          let opened = false;
          try {
            await store.workspace(selected.sessionHash, selected.workspaceId, async unit => {
              opened = true;
              await persist(unit);
            }, selected.id);
          } catch (error) {
            if (opened || !(error instanceof DomainError) || error.status !== 401) throw error;
            await store.workspace(selected.sessionHash, selected.workspaceId, persist);
          }
        },
        tools: () => catalog(connection), instructions: agentInstructions,
        operationTaskKey: key.toString('hex'),
        readOperation: (principal, operationId) => {
          const selected = selectedFor(principal);
          return withCredential(selected, async (unit, grant) => {
            const command = lookup('agent', 'operations_get');
            if (!command?.roles.includes(unit.context.role) || !grant.tools.includes('jobs_get') || !toolAllowed(unit, 'jobs_get')) throw denied();
            const context: AgentContext = { ...unit.context, agentClientId: selected.id };
            return agentJobMcp('operations_get', command).run(context, { operation_id: operationId });
          });
        },
        ...(operations.size > 0 && { resources: {
          templates: principal => resourceTemplates(operationResources(name => principal.allowedTools.includes(name))),
          read: (principal, uri) => readOperationResource(uri, operationResources(name => principal.allowedTools.includes(name)),
            (workspace, tool, input) => {
              if (workspace !== principal.workspaceId) throw new Problem(404, 'NOT_FOUND', 'Workspace not found');
              return invokeRead(principal, tool, input);
            }),
        } }),
        // Operation tools authorize inside their own transaction, against the live credential and role.
        authorize: invocation => invocation.tool.result === 'approved_read' || invocation.tool.result === 'operation_call' || bridge.authorize(invocation),
        dispatch: async invocation => invocation.tool.result === 'approved_read'
          ? (await invokeRead(invocation.principal, invocation.tool.name, invocation.input)).body
          : invocation.tool.result === 'operation_call' ? invokeOperation(invocation.principal, invocation.tool, invocation.input.body)
            : bridge.dispatch(invocation),
        filterOutput: ({ tool }, raw, metadata) => {
          if (tool.module === 'intel') return intelMcpOutput(tool.action, raw);
          if (tool.result === 'approved_read') {
            const { data, next_cursor } = metadata;
            return isRecord(data) || Array.isArray(data)
              ? { data, next_cursor: typeof next_cursor === 'string' || next_cursor === null ? next_cursor : undefined } : null;
          }
          if (tool.result === 'operation_call') {
            const { body, etag, replayed: isReplay } = raw as Awaited<ReturnType<OperationExecutor>>;
            auditOutput = body.data;
            replayed = isReplay;
            return { data: isRecord(body.data) || Array.isArray(body.data) ? body.data : { value: body.data ?? null },
              ...(body.next_cursor !== undefined && { next_cursor: body.next_cursor }), ...(etag && { etag }) };
          }
          auditOutput = metadata;
          return { data: metadata };
        },
        async authenticate(token) {
          credential = open(token);
          if (!credential) return;
          const selected = credential;
          try {
            return await withCredential(selected, async (unit, grant) => {
              connection = grant.connection;
              if (grant.connection) await touchAgentConnection(unit, grant.row);
              return {
                tenantId: unit.context.tenantId, workspaceId: selected.workspaceId, actorId: unit.context.actorId, tokenId: selected.id,
                allowedTools: grant.tools.filter(name => {
                  const tool = definition(name, grant.connection);
                  return !!tool && toolPermitted(unit, tool, grant.access);
                }),
              } satisfies McpPrincipal;
            });
          } catch (error) {
            if (error instanceof DomainError && error.status === 403) return 'forbidden';
            if (error instanceof DomainError && error.status < 500) return;
            throw error;
          }
        },
      });
      return serveMcpRequest(req, reply, handler, active);
    },
  });
  return async (req: FastifyRequest, workspace: string, name: string) => {
    const workerOperation = (name === 'worker_catalog_list' || name === 'worker_catalog_request_import' || workerSocialStatusToolNames.has(name))
      ? operationCatalog()?.byName.get(name) : undefined;
    const workerRequest = workerOperation?.method === req.method ? workerOperation : undefined;
    if ((!workerRequest && (!operations.has(name) || req.method !== 'GET')) || !/^Bearer ss_command_/i.test(req.headers.authorization ?? '')) return;
    const credential = bearerCredential(req);
    if (!credential) throw unauthenticated();
    return withCredential(credential, async (unit, grant) => {
      if (workspace !== credential.workspaceId) throw missingWorkspace();
      if (workerRequest && host.execute) {
        if (!grant.tools.includes(name) || !operationAllowed(unit, workerRequest, grant.access)) throw denied();
        if (workerRequest.method === 'POST' && req.body !== undefined && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw invalidOperation('Expected application/json');
        }
        const input = restInput(req);
        if (workerRequest.method === 'POST' && grant.connection) await touchAgentConnection(unit, grant.row);
        return host.execute(unit, workerRequest, input, { requestId: req.id, source: 'rest', grantId: credential.id, credentialLabel: grant.label });
      }
      return readOperation(unit, grant.tools, credential, name, restInput(req), req.id, 'rest');
    });
  };
}
