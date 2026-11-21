import { createHash, randomUUID } from 'node:crypto';
import { recordAgentToolCall } from '../modules/agent/agent-audit.js';
import type { AgentContext } from '../modules/agent/agent-jobs.js';
import { DomainError, type Command } from '../modules/types.js';
import type { Unit } from '../store.js';
import type { McpHandlerOptions, McpPrincipal } from './mcp-streamable.js';

export interface McpCommandHost {
  /** Revalidate the token and membership and open a transaction in its workspace. */
  workspace<T>(principal: Pick<McpPrincipal, 'tenantId' | 'workspaceId' | 'actorId' | 'tokenId'>,
    run: (unit: Unit) => Promise<T>): Promise<T>;
  lookup(module: string, action: string): Command | undefined;
  /** Server-owned resource authorization, token write limits and token scope in the same transaction. */
  permit(context: AgentContext, request: Parameters<McpHandlerOptions['authorize']>[0], unit: Unit): boolean | Promise<boolean>;
}

function bind(unit: Unit, principal: Pick<McpPrincipal, 'tenantId' | 'workspaceId' | 'actorId' | 'tokenId'>): AgentContext {
  const ctx = unit.context;
  if (ctx.tenantId !== principal.tenantId || ctx.workspaceId !== principal.workspaceId || ctx.actorId !== principal.actorId) {
    throw new DomainError('forbidden', 'Credential scope does not match the workspace', 403);
  }
  return { ...ctx, agentClientId: principal.tokenId };
}

export function createMcpCommandBridge(host: McpCommandHost): Pick<McpHandlerOptions, 'authorize' | 'dispatch' | 'audit'> {
  return {
    authorize(request) {
      // A call is authorized again in its command transaction. Do not spend a write quota here.
      return host.workspace(request.principal, async unit => {
        const ctx = bind(unit, request.principal);
        const op = host.lookup(request.tool.module, request.tool.action);
        return !!op?.roles.includes(ctx.role) && (request.mode === 'call' || await host.permit(ctx, request, unit));
      });
    },
    dispatch(request) {
      const { principal, tool, input } = request;
      return host.workspace(principal, async unit => {
        const ctx = bind(unit, principal);
        const op = host.lookup(tool.module, tool.action);
        if (!op?.roles.includes(ctx.role) || !await host.permit(ctx, request, unit)) {
          throw new DomainError('forbidden', 'Tool is out of scope', 403);
        }
        const payload = { ...input.query, ...input.body, ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }) };
        const fingerprint = createHash('sha256').update(JSON.stringify([tool.module, tool.action, payload])).digest('hex');
        const key = `mcp:${principal.tokenId}:${randomUUID()}`;
        return unit.command({ module: tool.module, action: tool.action, key, fingerprint }, () => op.run(ctx, payload));
      });
    },
    async audit(event) {
      await host.workspace(event, async unit => {
        const ctx = bind(unit, event);
        const key = `mcp-audit:${event.tokenId}:${event.callId}:${event.stage}`;
        await unit.command({ module: 'agent', action: 'audit_tool_call', key, fingerprint: event.inputHash }, async () => {
          if (event.stage === 'start') return recordAgentToolCall(ctx, {
            tool: event.toolName, inputHash: event.inputHash, outcome: 'pending', elapsedMs: 0,
            agentJobId: event.agentJobId, credentialId: event.tokenId, sideEffect: event.sideEffect,
          }, event.callId);
          const call = await ctx.get('agent', 'tool_call', event.callId);
          if (!call || call.data.credential_id !== event.tokenId || call.data.input_hash !== event.inputHash) {
            throw new DomainError('audit_unavailable', 'Missing matching tool audit entry', 503);
          }
          return ctx.update('agent', 'tool_call', call.id, { outcome: event.outcome === 'success' ? 'succeeded' : event.outcome,
            elapsed_ms: event.elapsedMs, code: event.code ?? null }, call.version);
        });
      });
    },
  };
}
