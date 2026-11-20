import { Problem } from '@smartsell/contracts';
import { makeContext } from '../context.js';
import { operations } from '../modules/agent/operations.js';
import type { AgentContext } from '../modules/agent/agent-jobs.js';
import { DomainError, type Command } from '../modules/types.js';
import { operationRecords } from './operation-records.js';
import { workspaceServices } from './workspace-services.js';

const routes: Record<string, string> = {
  operations_get: 'jobs_get', operations_cancel: 'jobs_cancel', jobs_claim: 'agent_jobs_claim',
  jobs_heartbeat: 'agent_jobs_heartbeat', jobs_submit_result: 'agent_jobs_submit_result',
  jobs_handoff: 'agent_jobs_handoff', jobs_confirm_cancel: 'agent_jobs_confirm_cancel',
  jobs_list: 'agent_jobs_list', jobs_get: 'agent_jobs_get',
};
const enrich = workspaceServices([]);

function domainError(error: unknown): never {
  if (error instanceof Problem) throw new DomainError(error.code, error.message, error.status);
  throw error;
}

/** Legacy job tools prefer the Operation jobs the web shows, and fall back to Commands jobs. */
export function agentJobMcp(action: string, command: Command): Command {
  const op = operations.find(op => op.name === routes[action]);
  if (!op) return command;
  return { ...command, async run(context, body) {
    if (action === 'jobs_list') {
      const legacy = await command.run(context, body) as { items?: unknown[] };
      if (!op.roles.includes(context.role)) return legacy;
      const { records } = await operationRecords(context, true);
      const ctx = enrich(makeContext(records, context, context.role), undefined, (context as AgentContext).agentClientId);
      const query = Object.fromEntries(['status', 'kind', 'campaign_id'].flatMap(key => typeof body[key] === 'string' ? [[key, body[key]]] : []));
      try {
        const shared = await op.run(ctx, { params: {}, query, body: {} }) as unknown[];
        return { items: [...shared, ...legacy.items ?? []] };
      } catch (error) { return domainError(error); }
    }
    const id = body.operation_id ?? body.agent_job_id;
    if (typeof id !== 'string') return command.run(context, body);
    const { records, flush } = await operationRecords(context, op.method === 'GET');
    const key = encodeURIComponent(id);
    const sharedJob = ['operations_get', 'operations_cancel'].includes(action) &&
      (records.get(`row/operation/${key}`) || records.get(`row/execution_verification/${key}`));
    if (!sharedJob && !records.get(`row/agent_job/${key}`)) return command.run(context, body);
    if (!op.roles.includes(context.role)) throw new DomainError('forbidden', 'Tool is out of scope', 403);
    const ctx = enrich(makeContext(records, context, context.role), undefined, (context as AgentContext).agentClientId);
    try {
      const data = await op.run(ctx, { params: { id }, query: {}, body, expectedVersion: body.expected_version });
      if (op.method !== 'GET') await flush();
      return data;
    } catch (error) { return domainError(error); }
  } };
}
