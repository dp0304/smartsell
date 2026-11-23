import { ADMIN, Problem, READ, type Operation } from '@smartsell/contracts';
import { changeOperations } from './changes.js';
import { desktopCapabilityNames, desktopCapabilityOperations } from './desktop-capability.js';
import { jobOperations, type AgentRequestContext } from './jobs.js';
import { modelOperations } from './models.js';
import { approvedBrandContext, runnerOperation } from './runner.js';
import { ruleOperations } from './rules.js';

export { createAgentJob, expireActorLeases, expireCredentialLeases, reapJobLeases, type AgentRequestContext } from './jobs.js';
export { createAgentChangeTargets, createChangeSet, type ChangeContext, type ChangeTarget, type ChangeTargets } from './changes.js';
export { availableModelPurposes, requestModel, type AgentModelServices, type ModelContext, type ModelDestination, type ModelRequest, type ModelResponse } from './models.js';
export { processAgentEvent, processAgentSchedule, publishedWorkflow } from './rules.js';

const mcpTools = new Set([
  ...desktopCapabilityNames,
  'agent_jobs_list', 'agent_jobs_get', 'agent_jobs_claim', 'agent_jobs_heartbeat', 'agent_jobs_submit_result',
  'agent_jobs_handoff', 'agent_jobs_confirm_cancel', 'change_sets_create', 'change_sets_get', 'jobs_get', 'jobs_cancel', 'workflow_templates_list', 'workflow_templates_get', 'agent_preview_context',
]);
export const agentMcpNames: ReadonlySet<string> = mcpTools;

const toolCalls: Operation = {
  method: 'GET', path: '/tool-calls', name: 'agent_tool_calls_list', roles: ADMIN,
  summary: 'Inspect redacted workspace tool metadata',
  run(ctx, { query }) {
    return ctx.list('tool_call').filter((row) => (!query.tool_name || row.tool_name === query.tool_name) &&
      (!query.outcome || row.outcome === query.outcome) && (!query.agent_job_id || row.agent_job_id === query.agent_job_id)).map((row) => ({
      id: row.id, tool_name: row.tool_name, outcome: row.outcome, agent_job_id: row.agent_job_id, occurred_at: row.occurred_at,
      side_effect: row.side_effect === true, latency_ms: row.latency_ms, error_code: row.error_code,
    }));
  },
};

const contextPreview: Operation = {
  method: 'GET', path: '/brands/:brandId/agent-context', name: 'agent_preview_context', roles: READ,
  summary: 'Preview and search the approved knowledge supplied to Agent for a brand',
  run(ctx, { params, query }) {
    const preview = approvedBrandContext(ctx, params.brandId!);
    const needle = query.q?.trim().toLowerCase().slice(0, 200);
    return { ...preview, items: needle ? preview.items.filter(row =>
      `${String(row.title ?? '')} ${String(row.body ?? '')}`.toLowerCase().includes(needle)) : preview.items };
  },
};

export const operations: Operation[] = [...jobOperations, ...changeOperations, ...ruleOperations, ...modelOperations, runnerOperation, toolCalls, contextPreview,
  ...desktopCapabilityOperations]
  .map((op) => ({
    ...op,
    mcp: mcpTools.has(op.name),
    run(ctx, input) {
      if (!mcpTools.has(op.name) && (ctx as AgentRequestContext).agentCredentialId) {
        throw new Problem(403, 'HUMAN_REQUIRED', 'This operation requires an interactive workspace member');
      }
      return op.run(ctx, input);
    },
  }));
