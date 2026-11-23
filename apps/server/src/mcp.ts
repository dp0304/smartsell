import { randomUUID } from 'node:crypto';
import { createMcpHandler, MCP_TOOLS } from './extensions/mcp.js';
import { verifyOperationHandle, type McpPrincipal } from './extensions/mcp-streamable.js';
import { isRecord } from './extensions/mcp-tools.js';
import { agentToolAllowed } from './extensions/mcp-agent-catalog.js';
import { headerAcceptsEventStream, mcpEventStream } from './extensions/mcp-sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, JSONRPCMessageSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema,
  McpError, ReadResourceRequestSchema, isInitializeRequest, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Problem } from '@smartsell/contracts';
import type { Store } from '@smartsell/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { denied, membership, originGuard, type Auth } from './identity.js';
import { mcpAuditBusinessStatus, mcpAuditErrorCode, mcpCallAuditWithCommits, operationWriteAuditPrefix, summarizeMcpTarget, workerSocialStatusAuditRows, type McpWriteReceipt } from './integration/mcp-call-audit.js';
import { agentInstructions } from './integration/agent-connections.js';
import { describeOperationTool, operationResources, parseOperationTool, readOperationResource, resourceTemplates, serveMcpRequest } from './integration/operation-mcp.js';
import type { Config } from './config.js';
import { workerSocialStatusToolNames } from './modules/account/worker-social-status.js';
import { allowed, type Invoke, type Registered } from './operations.js';

const jobsTool = (name: unknown) => name === 'jobs_get' || name === 'jobs_cancel';
// Operation runner tool history uses row/tool_call/ and has a separate record shape.
const callPrefix = 'mcp-tool-call/';
type StoredCall = Parameters<typeof mcpCallAuditWithCommits>[0][number];
type CallOutcome = 'pending' | 'success' | 'denied' | 'failed';
const accessDenied = (code?: string) => code !== undefined &&
  ['AUTH_REQUIRED', 'UNAUTHENTICATED', 'FORBIDDEN', 'PERMISSION_DENIED', 'HUMAN_REQUIRED', 'TOOL_UNAVAILABLE'].includes(code);

export function mcpToolCallRoutes(app: FastifyInstance, store: Store, auth: Auth) {
  app.get<{ Params: { ws: string } }>('/api/v1/workspaces/:ws/mcp-tool-calls', req => store.transaction({ readOnly: true }, async tx => {
    const principal = auth.authenticate(tx.identity, req, 'session');
    const ws = membership(tx.identity, principal, req.params.ws);
    // A brand-scoped administrator may not read a workspace-wide log of other brands' calls.
    if (!['owner', 'admin'].includes(ws.role) || ws.scopes?.length) throw denied();
    const records = await tx.workspace({ workspaceId: ws.id, tenantId: ws.tenantId, actorId: principal.user.id });
    return mcpCallAuditWithCommits([...records.list<StoredCall>(callPrefix), ...workerSocialStatusAuditRows(records)], req.query, () => records.list<McpWriteReceipt>(operationWriteAuditPrefix));
  }));
}

function operationCallAudit(store: Store, req: FastifyRequest, principal: McpPrincipal) {
  return async (id: string, operation: Registered | undefined, args: unknown, outcome: CallOutcome, code?: string,
    result?: Awaited<ReturnType<Invoke>>) => {
    try {
      const output = outcome === 'success' ? result?.body.data : undefined;
      const target = summarizeMcpTarget(operation, args, principal.workspaceId, output);
      const data = {
        request_id: req.id, credential_id: principal.tokenId, actor_id: principal.actorId,
        tool: operation?.name ?? 'unknown_tool', ...target, outcome, error_code: mcpAuditErrorCode(code),
        status: mcpAuditBusinessStatus(output),
        ...(outcome === 'success' && result?.replayed && { replayed: true }),
      };
      await store.transaction({}, async tx => {
        const records = await tx.workspace(principal);
        const key = `${callPrefix}${id}`;
        const created_at = records.get<StoredCall>(key)?.created_at ?? new Date().toISOString();
        records.put(key, { id, created_at, data } satisfies StoredCall);
      });
      return true;
    } catch {
      req.log.error({ requestId: req.id, callId: id }, 'MCP call audit write failed');
      return false;
    }
  };
}

export function mcpRoutes(app: FastifyInstance, store: Store, auth: Auth, config: Config, operations: Registered[], invoke: Invoke) {
  const streams = new Set<ReturnType<typeof mcpEventStream>>();
  const active = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.destroy();
    for (const request of active) request.abort();
  });
  const knownByName = new Map(operations.map(operation => [operation.name, operation]));
  operations = operations.filter(operation => agentToolAllowed(operation));
  const byName = new Map(operations.map(operation => [operation.name, operation]));
  app.route({
    method: ['POST', 'GET', 'DELETE'], url: '/mcp',
    async handler(req, reply) {
      originGuard(req, config);
      const authenticate = () => store.transaction({ readOnly: true }, ({ identity }) => {
        const principal = auth.authenticate(identity, req, 'bearer');
        const ws = membership(identity, principal, principal.grant!.workspaceId);
        return { tenantId: ws.tenantId, workspaceId: ws.id, actorId: principal.user.id, tokenId: principal.grant!.id,
          allowedTools: operations.filter(operation => allowed(operation, principal, ws, 'mcp')).map(operation => operation.name) };
      });
      let principal;
      try { principal = await authenticate(); } catch (error) {
        if (error instanceof Problem && error.status === 401) {
          reply.header('www-authenticate', `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp", scope="smartsell:read"`);
        }
        throw error;
      }
      const audit = operationCallAudit(store, req, principal);
      const calls = req.method === 'POST' ? (Array.isArray(req.body) ? req.body.slice(0, 100) : [req.body])
        .filter((value): value is Record<string, unknown> => isRecord(value) && value.method === 'tools/call' && Object.hasOwn(value, 'id')) : [];
      const auditOperation = (name: unknown) => typeof name === 'string' ? knownByName.get(name) : undefined;
      const rejectCall = (call: Record<string, unknown>, code: string) => {
        const params = isRecord(call.params) ? call.params : undefined;
        return audit(randomUUID(), auditOperation(params?.name), params?.arguments, 'denied', code);
      };
      const session = req.headers['mcp-session-id'];
      if (session !== undefined && (req.headers['mcp-protocol-version'] !== '2025-11-25' ||
          !verifyOperationHandle(config.secret, principal, 'session', session))) {
        for (const call of calls) await rejectCall(call, 'TOOL_UNAVAILABLE');
        return reply.code(404).send();
      }
      if (req.method === 'GET' && headerAcceptsEventStream(req.headers.accept)) {
        const stream = mcpEventStream(async () => { await authenticate(); return true; });
        streams.add(stream);
        reply.raw.once('close', () => { streams.delete(stream); stream.destroy(); });
        return reply.type('text/event-stream').header('cache-control', 'no-store').header('x-accel-buffering', 'no').send(stream);
      }
      if (req.method !== 'POST') return reply.header('allow', 'GET, POST').code(405).send();
      const tools: Tool[] = principal.allowedTools.map(name => describeOperationTool(byName.get(name)!));
      const resources = operationResources(name => principal.allowedTools.includes(name));
      const message = req.body;
      if (isRecord(message)) {
        const params = isRecord(message.params) ? message.params : {};
        const args = isRecord(params.arguments) ? params.arguments : {};
        const jobs = jobsTool(params.name);
        const isJobCall = message.method === 'tools/call' && jobs;
        const progress = isRecord(params._meta) && params._meta.progressToken;
        const useJobAdapter = isJobCall && (Object.hasOwn(args, 'operation_id') || Object.hasOwn(params, 'task') ||
          (params.name === 'jobs_get' && (typeof progress === 'string' || typeof progress === 'number') &&
            [undefined, '2025-11-25', '2025-06-18'].includes(req.headers['mcp-protocol-version'] as string | undefined)));
        const taskInit = message.method === 'initialize' && isRecord(params.capabilities) && isRecord(params.capabilities.tasks);
        if (taskInit || useJobAdapter || (session && (isJobCall || message.method === 'tools/list')) ||
            Object.hasOwn(params, 'task') || (typeof message.method === 'string' && message.method.startsWith('tasks/'))) {
          let callResult: Awaited<ReturnType<Invoke>> | undefined;
          let callObserved = false;
          const handler = createMcpHandler({
            allowedOrigins: [...config.origins], operationTaskKey: config.secret,
            instructions: agentInstructions,
            auditEarlyDenials: true,
            async audit(event) {
              callObserved = true;
              const outcome = event.stage === 'start' ? 'pending' : accessDenied(event.code) ? 'denied' : event.outcome;
              const code = event.stage === 'finish' ? event.code : undefined;
              if (!await audit(event.callId, auditOperation(event.toolName) ?? auditOperation(params.name), args, outcome, code, callResult)) {
                throw new Error('Call audit unavailable');
              }
            },
            async authenticate() { try { return await authenticate(); } catch (error) {
              if (error instanceof Problem && error.status < 500) return;
              throw error;
            } },
            authorize: invocation => invocation.principal.allowedTools.includes(invocation.tool.name),
            listTools: (current, tasks) => tools.filter(tool => current.allowedTools.includes(tool.name)).map(tool => {
              if (!tasks) return tool;
              const job = MCP_TOOLS.find(item => item.name === tool.name && jobsTool(item.name));
              if (!job) return tool;
              const { name, description, inputSchema, outputSchema, annotations } = job;
              return { name, description, inputSchema, outputSchema, annotations,
                ...(name === 'jobs_get' && { execution: { taskSupport: 'optional' } }) };
            }),
            async dispatch({ principal: current, tool, input }) {
              callResult = await invoke(req, current.workspaceId, byName.get(tool.name)!, input, 'mcp');
              return callResult.body.data;
            },
            async readOperation(current, id) {
              callResult = await invoke(req, current.workspaceId, byName.get('jobs_get')!, { params: { id }, query: {}, body: {} }, 'mcp');
              return callResult.body.data;
            },
            resources: {
              templates: () => resourceTemplates(resources),
              read: (_current, uri) => readOperationResource(uri, resources, (workspace, tool, input) =>
                invoke(req, workspace, byName.get(tool)!, input, 'mcp')),
            },
          });
          const pathArgs = isRecord(args.params) ? args.params : {};
          const body = isJobCall && !Object.hasOwn(args, 'operation_id') && typeof pathArgs.id === 'string'
            ? { ...message, params: { ...params, arguments: { workspace_id: args.workspace_id, operation_id: pathArgs.id,
              ...(args.expected_version !== undefined && { expected_version: args.expected_version }) } } } : message;
          return serveMcpRequest(req, reply, async request => {
            const response = await handler(request);
            if (!callObserved && calls[0] && response.status >= 400 && response.status < 500) {
              await rejectCall(calls[0], response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'INVALID_INPUT');
            }
            return response;
          }, active, body);
        }
      }
      // The SDK rejects malformed envelopes and tool parameters before calling the registered handler.
      // Observe those denials without replacing its protocol validation or changing the returned errors.
      const invalidBatch = Array.isArray(message) && (message.length > 100 ||
        (message.length > 1 && message.some(isInitializeRequest)) ||
        message.some(value => !JSONRPCMessageSchema.safeParse(value).success));
      for (const call of calls) {
        const params = isRecord(call.params) ? call.params : undefined;
        if (invalidBatch || !JSONRPCMessageSchema.safeParse(call).success || !CallToolRequestSchema.safeParse(call).success ||
            (Array.isArray(message) && isRecord(params?.task))) await rejectCall(call, 'INVALID_INPUT');
      }
      const server = new Server({ name: 'smartsell', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} }, instructions: agentInstructions });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
      server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: resourceTemplates(resources) }));
      server.setRequestHandler(ReadResourceRequestSchema, async ({ params: { uri } }) => {
        const result = await readOperationResource(uri, resources, (workspace, tool, input) =>
          invoke(req, workspace, byName.get(tool)!, input, 'mcp'));
        if (!result) throw new McpError(ErrorCode.InvalidParams, 'Resource not found');
        return result;
      });
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const callId = randomUUID();
        const operation = byName.get(params.name);
        const args = params.arguments;
        if (!operation || !principal.allowedTools.includes(operation.name)) {
          await audit(callId, auditOperation(params.name), args, 'denied', 'TOOL_UNAVAILABLE');
          throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
        }
        const auditUnavailable = () => new Problem(503, 'AUDIT_UNAVAILABLE', 'Tool call audit unavailable');
        let crossWorkspace = false;
        let started = false;
        try {
          const { workspaceId, input } = parseOperationTool(operation, args);
          crossWorkspace = workspaceId !== principal.workspaceId;
          if (!crossWorkspace) {
            started = await audit(callId, operation, args, 'pending');
            if (!started) throw auditUnavailable();
          }
          const outcome = await invoke(req, workspaceId, operation, input, 'mcp');
          if (!await audit(callId, operation, args, 'success', undefined, outcome)) throw auditUnavailable();
          const structuredContent = { ...outcome.body, ...(outcome.etag && { etag: outcome.etag }) };
          const text = workerSocialStatusToolNames.has(operation.name) ? JSON.stringify(structuredContent)
            : `${operation.name}: ${Array.isArray(outcome.body.data) ? `${outcome.body.data.length} results` : 'completed'}`;
          return { content: [{ type: 'text', text }], structuredContent };
        } catch (error) {
          if (!(error instanceof Problem)) req.log.error({ requestId: req.id, tool: operation.name }, 'MCP tool failed');
          const problem = error instanceof Problem ? { code: error.code, detail: error.message, details: error.details } : { code: 'INTERNAL_ERROR', detail: 'Internal server error' };
          const denied = crossWorkspace || accessDenied(problem.code) || (!started && problem.code === 'INVALID_INPUT');
          if (problem.code !== 'AUDIT_UNAVAILABLE') await audit(callId, operation, args, denied ? 'denied' : 'failed', problem.code);
          return { content: [{ type: 'text', text: `${problem.code}: ${problem.detail}` }], structuredContent: { data: problem }, isError: true };
        }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      reply.hijack();
      reply.raw.setHeader('cache-control', 'no-store');
      reply.raw.setHeader('x-request-id', req.id);
      reply.raw.once('close', () => void server.close().catch(() => {
        req.log.error({ requestId: req.id }, 'MCP server close failed');
      }));
      try {
        await transport.handleRequest(req.raw, reply.raw, req.body ?? null);
      } catch {
        req.log.error({ requestId: req.id }, 'MCP transport failed');
        reply.raw.destroy();
      }
    },
  });
}
