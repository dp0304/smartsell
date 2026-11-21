import { createMcpHandler, MCP_TOOLS } from './extensions/mcp.js';
import { verifyOperationHandle } from './extensions/mcp-streamable.js';
import { isRecord } from './extensions/mcp-tools.js';
import { agentToolAllowed } from './extensions/mcp-agent-catalog.js';
import { headerAcceptsEventStream, mcpEventStream } from './extensions/mcp-sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema,
  McpError, ReadResourceRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Problem } from '@smartsell/contracts';
import type { Store } from '@smartsell/db';
import type { FastifyInstance } from 'fastify';
import { membership, originGuard, type Auth } from './identity.js';
import { describeOperationTool, operationResources, parseOperationTool, readOperationResource, resourceTemplates, serveMcpRequest } from './integration/operation-mcp.js';
import type { Config } from './config.js';
import { allowed, type Invoke, type Registered } from './operations.js';

const jobsTool = (name: unknown) => name === 'jobs_get' || name === 'jobs_cancel';

export function mcpRoutes(app: FastifyInstance, store: Store, auth: Auth, config: Config, operations: Registered[], invoke: Invoke) {
  const streams = new Set<ReturnType<typeof mcpEventStream>>();
  const active = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.destroy();
    for (const request of active) request.abort();
  });
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
      const session = req.headers['mcp-session-id'];
      if (session !== undefined && (req.headers['mcp-protocol-version'] !== '2025-11-25' ||
          !verifyOperationHandle(config.secret, principal, 'session', session))) return reply.code(404).send();
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
          const handler = createMcpHandler({
            allowedOrigins: [...config.origins], operationTaskKey: config.secret,
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
              return (await invoke(req, current.workspaceId, byName.get(tool.name)!, input, 'mcp')).body.data;
            },
            async readOperation(current, id) {
              return (await invoke(req, current.workspaceId, byName.get('jobs_get')!, { params: { id }, query: {}, body: {} }, 'mcp')).body.data;
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
          return serveMcpRequest(req, reply, handler, active, body);
        }
      }
      const server = new Server({ name: 'smartsell', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
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
        const operation = byName.get(params.name);
        if (!operation || !tools.some(tool => tool.name === operation.name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
        try {
          const { workspaceId, input } = parseOperationTool(operation, params.arguments);
          const outcome = await invoke(req, workspaceId, operation, input, 'mcp');
          const structuredContent = { ...outcome.body, ...(outcome.etag && { etag: outcome.etag }) };
          return { content: [{ type: 'text', text: `${operation.name}: ${Array.isArray(outcome.body.data) ? `${outcome.body.data.length} results` : 'completed'}` }], structuredContent };
        } catch (error) {
          if (!(error instanceof Problem)) req.log.error({ requestId: req.id, tool: operation.name }, 'MCP tool failed');
          const problem = error instanceof Problem ? { code: error.code, detail: error.message, details: error.details } : { code: 'INTERNAL_ERROR', detail: 'Internal server error' };
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
