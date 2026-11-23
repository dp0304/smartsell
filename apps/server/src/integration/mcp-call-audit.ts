import { Problem } from '@smartsell/contracts';
import type { Records } from '@smartsell/db';
import { workerSocialStatusAuditKind } from '../modules/account/worker-social-status.js';
import { isRecord } from '../extensions/mcp-tools.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const asId = (value: unknown) => typeof value === 'string' && uuid.test(value) ? value : undefined;
const failureCodes = new Set([
  'AUTH_REQUIRED', 'UNAUTHENTICATED', 'FORBIDDEN', 'PERMISSION_DENIED', 'HUMAN_REQUIRED', 'TOOL_UNAVAILABLE',
  'INVALID_INPUT', 'INVALID_PARAMS', 'UNKNOWN_OPERATION', 'NOT_FOUND', 'EGRESS_DENIED', 'RESULT_UNAVAILABLE',
  'RESULT_TOO_LARGE', 'CONFLICT', 'VERSION_CONFLICT', 'IDEMPOTENCY_MISMATCH', 'PRECONDITION_REQUIRED',
  'VALIDATION_ERROR', 'INVALID_STATE', 'UNAVAILABLE', 'AUDIT_UNAVAILABLE', 'INTERNAL_ERROR', 'TOOL_FAILED',
  'DEVICE_NOT_FOUND', 'DEVICE_INACTIVE', 'TASK_EXECUTION_UNAVAILABLE', 'OUTCOME_UNKNOWN', 'POLICY_DENIED',
  'APPROVAL_REQUIRED', 'LEASE_HELD', 'LEASE_LOST', 'LICENSE_LIMIT', 'RATE_LIMITED', 'VERSION_REQUIRED',
  'SOCIAL_STATUS_WORKER_UNPAIRED', 'SOCIAL_STATUS_WORKER_INACTIVE', 'SOCIAL_STATUS_WORKER_NOT_FOUND',
  'SOCIAL_STATUS_WORKER_OFFLINE', 'SOCIAL_STATUS_WORKER_UNSUPPORTED', 'SOCIAL_STATUS_WORKER_AMBIGUOUS',
  'SOCIAL_STATUS_IDENTITY_SCOPE', 'SOCIAL_STATUS_IDENTITY_AMBIGUOUS',
  'VALIDATION_FAILED', 'IDEMPOTENCY_CONFLICT', 'EGRESS_BLOCKED', 'UNSUPPORTED_CHANGE_TARGET',
  'UNSUPPORTED_CHANGE_OPERATION', 'DUPLICATE_CHANGE_TARGET',
]);

export function mcpAuditErrorCode(code: unknown) {
  return typeof code === 'string' ? failureCodes.has(code) ? code : 'TOOL_FAILED' : undefined;
}

export interface McpTarget {
  target: string;
  agent_job_id?: string;
  task_id?: string;
  device_id?: string;
}

export function summarizeMcpTarget(operation: { method: string; path: string; name: string } | undefined,
  args: unknown, workspaceId: string, output?: unknown): McpTarget {
  if (!operation) return { target: 'workspace' };
  const target = `${operation.method} ${operation.path}`;
  // Associations are opt-in per operation. The caller only supplies output after an authorized dispatch.
  if (!isRecord(output) || !isRecord(args) || (args.workspace_id !== undefined && args.workspace_id !== workspaceId)) return { target };
  const params = isRecord(args.params) ? args.params : {};
  const body = isRecord(args.body) ? args.body : args;
  if (operation.name === 'zhihu_stats_create' || operation.name === 'zhihu_stats_get' ||
      operation.name === 'worker_social_status_request' || operation.name === 'worker_social_status_get') {
    return { target, task_id: asId(output.id), device_id: asId(output.device_id) };
  }
  if (operation.name.startsWith('agent_jobs_') && operation.name !== 'agent_jobs_list') {
    return { target, agent_job_id: asId(output.id) ?? asId(output.agent_job_id) ?? asId(params.id) ?? asId(body.agent_job_id) };
  }
  if (operation.name === 'jobs_get' || operation.name === 'jobs_cancel') {
    return { target, task_id: asId(output.operation_id) ?? asId(params.id) ?? asId(args.operation_id) };
  }
  return { target };
}

const outcomes = new Set(['pending', 'success', 'denied', 'failed', 'reconciled']);
const businessStatuses = new Set(['unsupported', 'blocked', 'failed', 'outcome_unknown']);

export function mcpAuditBusinessStatus(data: unknown) {
  if (!isRecord(data)) return;
  const status = data.submission_status ?? data.decision_status ?? data.status;
  return typeof status === 'string' && businessStatuses.has(status) ? status : undefined;
}

type StoredCall = { id: string; created_at: string; data: Record<string, unknown> };

export const workerSocialStatusAuditRows = (records: Records) => records.list<StoredCall>(`row/${workerSocialStatusAuditKind}/`);

export function projectMcpCallAudit({ id, created_at, data }: StoredCall) {
  return {
    id, call_id: id, request_id: asId(data.request_id), credential_id: asId(data.credential_id), actor_id: asId(data.actor_id),
    occurred_at: created_at, tool: data.tool, target: data.target, outcome: data.outcome,
    error_code: mcpAuditErrorCode(data.error_code), agent_job_id: asId(data.agent_job_id), task_id: asId(data.task_id),
    device_id: asId(data.device_id), status: data.tool === 'worker_social_status_report' && data.status === 'completed'
      ? 'completed' : mcpAuditBusinessStatus({ status: data.status }),
    ...(data.replayed === true && { replayed: true }),
  };
}

export function mcpCallAuditPage(rows: readonly StoredCall[], query: unknown) {
  const { request_id, credential_id, actor_id, tool, outcome, status, cursor } = isRecord(query) ? query : {};
  if ([request_id, credential_id, actor_id, cursor].some(value => value !== undefined && !asId(value)) ||
    (tool !== undefined && (typeof tool !== 'string' || !/^[a-z][a-z0-9_]{0,119}$/.test(tool))) ||
    (outcome !== undefined && (typeof outcome !== 'string' || !outcomes.has(outcome))) ||
    (status !== undefined && (typeof status !== 'string' || (status !== 'completed' && !businessStatuses.has(status))))) {
    throw new Problem(422, 'INVALID_INPUT', 'Invalid tool call audit filter');
  }
  const filters = Object.entries({ request_id, credential_id, actor_id, tool, outcome, status }).filter(([, value]) => value !== undefined);
  const matching = rows.filter(({ data }) => asId(data.request_id) && filters.every(([key, value]) => data[key] === value))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const after = cursor ? matching.findIndex(row => row.id === cursor) : -1;
  if (cursor && after < 0) throw new Problem(422, 'INVALID_INPUT', 'Invalid tool call audit cursor');
  const page = matching.slice(after + 1, after + 101);
  return { data: page.map(projectMcpCallAudit), next_cursor: matching.length > after + 101 ? page.at(-1)!.id : null };
}

export type McpWriteReceipt = Partial<Record<'source' | 'request_id' | 'actor_id' | 'credential_id' | 'action', unknown>>;
export const operationWriteAuditPrefix = 'audit/';

const commitKey = (request: unknown, actor: unknown, credential: unknown, operation: unknown) =>
  asId(request) && asId(actor) && asId(credential) && typeof operation === 'string'
    ? JSON.stringify([request, actor, credential, operation]) : undefined;

/** A process can stop after the operation commits and before it records the tool response. */
export async function mcpCallAuditWithCommits(rows: readonly StoredCall[], query: unknown,
  readWrites: () => readonly McpWriteReceipt[] | Promise<readonly McpWriteReceipt[]>) {
  const page = mcpCallAuditPage(rows, query);
  const unfinishedRequests = new Set(page.data.filter(row => row.outcome === 'pending').map(row => row.request_id));
  if (!unfinishedRequests.size) return page;

  const keys = new Map<string, string>();
  const attempts = new Map<string, number>();
  for (const { id, data } of rows) {
    if (!unfinishedRequests.has(asId(data.request_id))) continue;
    const key = commitKey(data.request_id, data.actor_id, data.credential_id, data.operation ?? data.tool);
    if (!key) continue;
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    keys.set(id, key);
  }
  const commits = new Map<string, number>();
  for (const write of await readWrites()) {
    if (write.source !== 'mcp') continue;
    const key = commitKey(write.request_id, write.actor_id, write.credential_id, write.action);
    if (key && attempts.get(key) === 1) commits.set(key, (commits.get(key) ?? 0) + 1);
  }
  return { ...page, data: page.data.map(row => {
    const key = keys.get(row.call_id);
    // A batch can contain the same tool more than once. Only attribute an unambiguous receipt.
    return row.outcome === 'pending' && key && commits.get(key) === 1 ? { ...row, business_committed: true } : row;
  }) };
}
