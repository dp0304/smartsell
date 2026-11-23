import { admins, required, text, type Commands, type Context } from '../types.js';
import { agentModule, command, id, integer, invalid } from './agent-validation.js';

export interface AgentToolAudit {
  tool: string;
  inputHash: string;
  outcome: string;
  elapsedMs: number;
  agentJobId?: string;
  credentialId?: string;
  sideEffect?: boolean;
  target?: string;
  requestId?: string;
  operation?: string;
}

/** Server-side only; persist metadata without storing prompts, tool arguments or results. */
export async function recordAgentToolCall(ctx: Context, audit: AgentToolAudit, callId?: string) {
  if (!/^[a-f0-9]{64}$/i.test(audit.inputHash)) invalid('inputHash');
  const job = audit.agentJobId ? await ctx.get(agentModule, 'agent_job', id(audit.agentJobId)) : undefined;
  return ctx.insert(agentModule, 'tool_call', {
    actor_id: ctx.actorId, credential_id: audit.credentialId ? id(audit.credentialId) : null,
    tool: text({ tool: audit.tool }, 'tool', 120), input_hash: audit.inputHash,
    outcome: text({ outcome: audit.outcome }, 'outcome', 64), elapsed_ms: integer(audit.elapsedMs, 'elapsedMs', 0),
    ...(audit.target && { target: text({ target: audit.target }, 'target', 256) }),
    ...(audit.requestId && { request_id: id(audit.requestId) }),
    ...(audit.operation && { operation: audit.operation }),
    agent_job_id: job?.id ?? null, side_effect: audit.sideEffect === true,
  }, callId === undefined ? undefined : id(callId));
}

export const auditCommands: Commands = {
  tool_calls_list: command(admins, async (ctx, input) => {
    const tool = input.tool === undefined ? null : text(input, 'tool', 120);
    const actor = input.actor_id === undefined ? null : id(input.actor_id);
    return { items: (await ctx.list(agentModule, 'tool_call')).filter(row =>
      (!tool || row.data.tool === tool) && (!actor || row.data.actor_id === actor)).slice(0, 100) };
  }),
  tool_calls_reconcile: command(admins, async (ctx, input) => {
    const call = await required(ctx, agentModule, 'tool_call', id(input.tool_call_id));
    if (call.data.side_effect !== true || !['unknown', 'outcome_unknown', 'timeout', 'pending'].includes(call.data.outcome)) invalid('tool_call_id');
    const note = text(input, 'note', 1000);
    const row = await ctx.update(agentModule, 'tool_call', call.id, { outcome: 'reconciled', reconciled_by: ctx.actorId,
      reconciled_at: ctx.now, resolution_note: note }, integer(input.expected_version, 'expected_version'));
    await ctx.emit('agent.tool_call.reconciled', { tool_call_id: call.id, agent_job_id: call.data.agent_job_id });
    return row;
  }),
};
