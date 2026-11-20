import { Problem, type Input } from '@smartsell/contracts';
import { headerAcceptsEventStream, mcpEventStream } from '../extensions/mcp-sse.js';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { invalid, requestObject } from '../auth.js';
import { createMcpCommandBridge, createMcpHandler, MCP_TOOLS, type McpPrincipal, type McpToolDefinition } from '../extensions/mcp.js';
import { DomainError } from '../modules/types.js';
import type { Registry } from '../registry.js';
import { missingWorkspace, unauthenticated, type Store, type Unit } from '../store.js';
import { agentJobMcp } from './agent-job-mcp.js';
import type { AgentContext } from '../modules/agent/agent-jobs.js';
import { intelMcpCommands, intelMcpOutput } from './intel-mcp.js';
import { brandOperationAllowed } from './brand-access.js';
import { describeOperationTool, operationResources, parseOperationTool, readOperationResource, resourceTemplates, serveMcpRequest } from './operation-mcp.js';
import { operationRecords } from './operation-records.js';
import { restInput, runScopedOperation } from '../operations.js';
import { isRecord } from '../extensions/mcp-tools.js';
import { agentToolAllowed } from '../extensions/mcp-agent-catalog.js';
import { workspaceServices } from './workspace-services.js';

interface Credential { sessionHash: string; workspaceId: string; id: string }
const hidden = new Set(['automation_rules_list', 'workflow_templates_list', 'change_sets_create', 'change_sets_get']);
const approvedReads = new Set(['search_query', 'knowledge_get_context', 'agent_preview_context', 'catalog_list_facts']);
const denied = () => new DomainError('forbidden', 'Credential unavailable', 403);

export function registerCommandMcp(app: FastifyInstance, store: Store, registry: Registry, secret: string,
  origins: ReadonlySet<string>, sessionHash: (request: FastifyRequest) => string | undefined,
  operationApi?: Parameters<typeof intelMcpCommands>[1]) {
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
  const enrich = workspaceServices(operationApi?.operations ?? []);
  function toolAllowed(unit: Unit, name: string) {
    const op = operations.get(name);
    return op ? op.roles.includes(unit.context.role) && brandOperationAllowed(unit.brandScopes, name, op.method) : !unit.brandScopes?.length;
  }
  async function readOperation(unit: Unit, grants: readonly string[], credential: Credential, name: string, input: Input, requestId: string, source: 'rest' | 'mcp') {
    const op = operations.get(name);
    if (!op || !grants.includes(name) || !toolAllowed(unit, name) || (source === 'rest' && op.module === 'agent')) throw denied();
    const { context } = unit;
    const { records } = await operationRecords(context, true);
    if (name === 'knowledge_get_context') input = { ...input, query: { ...input.query, include_proposed: 'false' } };
    if (name === 'catalog_list_facts') input = { ...input, query: { ...input.query, approved_only: 'true' }, body: { ...input.body, approved_only: true } };
    return runScopedOperation(records, context, { actorId: context.actorId, grantId: credential.id }, context.role,
      requestId, op, input, source, operationApi!.config, enrich, undefined, unit.brandScopes);
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
  async function check(unit: Unit, credential: Credential) {
    const row = await unit.context.get('mcp_runtime', 'credential', credential.id);
    if (!row || row.data.actor_id !== unit.context.actorId || row.data.revoked === true || !(row.data.expires > Date.now())) throw unauthenticated();
    return row.data.tools as string[];
  }
  function withCredential<T>(credential: Credential, run: (unit: Unit, grants: string[]) => Promise<T>) {
    return store.workspace(credential.sessionHash, credential.workspaceId, async unit => run(unit, await check(unit, credential)), credential.id);
  }
  app.post<{ Params: { wid: string } }>('/api/v1/workspaces/:wid/tokens', async (req, reply) => {
    const input = requestObject(req.body);
    const access = input.access ?? 'read';
    if (!['read', 'write'].includes(access) || (input.tools !== undefined && (!Array.isArray(input.tools) ||
      input.tools.some((name: unknown) => !tools.some(tool => tool.name === name))))) throw invalid('Invalid access or tools');
    const hash = sessionHash(req);
    if (!hash) throw denied();
    const workspaceId = req.params.wid;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(workspaceId)) throw denied();
    const id = randomUUID();
    const expires_in = 12 * 3600;
    await store.workspace(hash, workspaceId, async unit => {
      const permitted = tools.filter(tool => (access === 'write' || tool.annotations.readOnlyHint) &&
        (input.tools === undefined || input.tools.includes(tool.name)) && toolAllowed(unit, tool.name) &&
        (operations.get(tool.name) ?? lookup(tool.module, tool.action))?.roles.includes(unit.context.role));
      await unit.command({ module: 'agent', action: 'issue_mcp_token', key: `mcp-issue/${id}`, fingerprint: '' }, async () => {
        await unit.context.insert('mcp_runtime', 'credential', { actor_id: unit.context.actorId, expires: Date.now() + expires_in * 1000,
          tools: permitted.map(tool => tool.name) }, id);
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
      });
    });
    return reply.code(204).send();
  });
  app.route({
    method: ['POST', 'GET', 'DELETE'], url: '/mcp', bodyLimit: 64 * 1024,
    async handler(req, reply) {
      let credential: Credential | undefined;
      const bridge = createMcpCommandBridge({
        workspace(principal, run) {
          if (!credential || credential.workspaceId !== principal.workspaceId || credential.id !== principal.tokenId) throw denied();
          const selected = credential;
          return withCredential(selected, run);
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
        const selected = credential;
        if (!selected || selected.id !== principal.tokenId || selected.workspaceId !== principal.workspaceId) throw denied();
        return withCredential(selected, (unit, grants) => readOperation(unit, grants, selected, tool, input, req.id, 'mcp'));
      }
      const handler = createMcpHandler({ ...bridge, allowedOrigins: [...origins], additionalTools,
        operationTaskKey: key.toString('hex'),
        readOperation: (principal, operationId) => {
          const selected = credential;
          if (!selected || selected.id !== principal.tokenId || selected.workspaceId !== principal.workspaceId) throw denied();
          return withCredential(selected, async (unit, grants) => {
            const command = lookup('agent', 'operations_get');
            if (!command?.roles.includes(unit.context.role) || !grants.includes('jobs_get') || !toolAllowed(unit, 'jobs_get')) throw denied();
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
        authorize: invocation => invocation.tool.result === 'approved_read' || bridge.authorize(invocation),
        dispatch: async invocation => invocation.tool.result === 'approved_read'
          ? (await invokeRead(invocation.principal, invocation.tool.name, invocation.input)).body
          : bridge.dispatch(invocation),
        filterOutput: ({ tool }, raw, metadata) => {
          if (tool.module === 'intel') return intelMcpOutput(tool.action, raw);
          if (tool.result === 'approved_read') {
            const { data, next_cursor } = metadata;
            return isRecord(data) || Array.isArray(data)
              ? { data, next_cursor: typeof next_cursor === 'string' || next_cursor === null ? next_cursor : undefined } : null;
          }
          return { data: metadata };
        },
        async authenticate(token) {
          credential = open(token);
          if (!credential) return;
          const selected = credential;
          try {
            return await withCredential(selected, async (unit, grants) => ({
              tenantId: unit.context.tenantId, workspaceId: selected.workspaceId, actorId: unit.context.actorId,
              tokenId: selected.id, allowedTools: grants.filter(name => toolAllowed(unit, name)),
            } satisfies McpPrincipal));
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
    if (!operations.has(name) || req.method !== 'GET' || !/^Bearer ss_command_/i.test(req.headers.authorization ?? '')) return;
    const credential = bearerCredential(req);
    if (!credential) throw unauthenticated();
    return withCredential(credential, (unit, grants) => {
      if (workspace !== credential.workspaceId) throw missingWorkspace();
      return readOperation(unit, grants, credential, name, restInput(req), req.id, 'rest');
    });
  };
}
