type JsonRecord = Record<string, unknown>;

type Field = {
  type: 'string' | 'integer' | 'object' | 'array';
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: Field;
  properties?: Record<string, Field>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly string[];
};

type ObjectSchema = Field & { type: 'object'; properties: Record<string, Field> };
const text = (maxLength = 300): Field => ({ type: 'string', minLength: 1, maxLength });
const version: Field = { type: 'integer', minimum: 1, maximum: 2_147_483_647 };
const fence: Field = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties: Record<string, Field>, required: readonly string[] = []): ObjectSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const array = (items: Field, maxItems = 50, minItems = 0): Field => ({ type: 'array', items, minItems, maxItems });
const enumText = (...values: string[]): Field => ({ type: 'string', enum: values });

export interface McpDispatchInput {
  /** Validated command DTO, excluding the separately authenticated workspace ID. */
  body: JsonRecord;
  params: Record<string, string>;
  query: Record<string, string>;
  expectedVersion?: number;
}

interface ToolConfig {
  name: string;
  module: string;
  action: string;
  description: string;
  input: Record<string, Field>;
  required?: readonly string[];
  id?: string;
  query?: readonly string[];
  write?: 'update' | 'create';
  /** 'hub': a phase 1 hub tool (integration/mcp-hub-tools.ts); its result is the tool's own JSON object (§7.2). */
  result: 'jobs' | 'job' | 'operation' | 'change' | 'templates' | 'rules' | 'intel' | 'approved_read' | 'operation_call' | 'hub';
  needsOutputPolicy?: boolean;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly module: string;
  readonly action: string;
  readonly description: string;
  readonly inputSchema: JsonRecord;
  readonly outputSchema: JsonRecord;
  readonly annotations: Readonly<{ readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }>;
  readonly sideEffect: false;
  readonly needsOutputPolicy: boolean;
  readonly result: ToolConfig['result'];
  /** Set on tools that run one Operation through the shared executor. */
  readonly operation?: string;
  readonly parse: (args: JsonRecord) => McpDispatchInput | undefined;
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valid(value: unknown, field: Field): boolean {
  switch (field.type) {
    case 'string': return typeof value === 'string' && !!value.trim() && value.length >= (field.minLength ?? 0) &&
      value.length <= (field.maxLength ?? Infinity) && (!field.enum || field.enum.includes(value));
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value) && value >= field.minimum! && value <= field.maximum!;
    case 'array': return Array.isArray(value) && value.length >= field.minItems! && value.length <= field.maxItems! && value.every((item) => valid(item, field.items!));
    case 'object': return isRecord(value) && (field.required ?? []).every((key) => Object.hasOwn(value, key)) &&
      Object.entries(value).every(([key, entry]) => field.properties && Object.hasOwn(field.properties, key)
        ? valid(entry, field.properties[key]!) : field.additionalProperties === true);
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const outputSchema = {
  type: 'object',
  properties: {
    data: { type: 'object' },
    untrusted_content: {
      type: 'array', maxItems: 25,
      items: { type: 'object', properties: {
        source: { type: 'string' }, captured_at: { type: 'string' }, content: {},
      }, required: ['source', 'captured_at', 'content'], additionalProperties: false },
    },
  },
  required: ['data'],
  additionalProperties: false,
};

function define(config: ToolConfig): McpToolDefinition {
  const inputSchema = object({ workspace_id: text(), ...config.input, ...(config.write === 'update' ? { expected_version: version } : {}) },
    ['workspace_id', ...(config.required ?? []), ...(config.write === 'update' ? ['expected_version'] : [])]);
  const read = !config.write;
  return freeze({
    name: config.name, module: config.module, action: config.action,
    description: config.description, inputSchema, outputSchema, result: config.result,
    annotations: { readOnlyHint: read, destructiveHint: false, idempotentHint: read, openWorldHint: false },
    sideEffect: false,
    needsOutputPolicy: config.needsOutputPolicy === true,
    parse(args: JsonRecord) {
      if (!valid(args, inputSchema)) return undefined;
      const { workspace_id: _workspace, ...body } = args;
      const params: Record<string, string> = {};
      const query: Record<string, string> = {};
      if (config.id) params.id = body[config.id] as string;
      for (const key of config.query ?? []) {
        if (Object.hasOwn(body, key)) query[key] = body[key] as string;
      }
      return { body, params, query, ...(typeof body.expected_version === 'number' ? { expectedVersion: body.expected_version } : {}) };
    },
  });
}

function agent(name: string, action: string, description: string, config: Omit<ToolConfig, 'name' | 'module' | 'action' | 'description'>) {
  return define({ name, module: 'agent', action, description, ...config });
}

const jobId = { agent_job_id: text() };
const lease = { ...jobId, fencing_token: fence };
const jobUpdate = { id: 'agent_job_id', write: 'update', result: 'job' } as const;
const target = object({ module: enumText('workspace'), kind: enumText('work_item'), id: text() }, ['module', 'kind', 'id']);
const changeItem = object({
  target, operation: enumText('update'), expected_version: version,
  patch: object({ title: text(200) }, ['title']),
}, ['target', 'operation', 'expected_version', 'patch']);

/** Explicit exposure allowlist. Operation or command registration does not imply MCP exposure. */
export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  agent('agent_jobs_list', 'jobs_list', 'List accessible Agent jobs and their current versions.', {
    input: { status: text(), kind: text(), campaign_id: text() }, query: ['status', 'kind', 'campaign_id'], result: 'jobs',
  }),
  agent('agent_jobs_get', 'jobs_get', 'Get the status and current version of an accessible Agent job.', {
    input: jobId, id: 'agent_job_id', required: ['agent_job_id'], result: 'job',
  }),
  agent('jobs_get', 'operations_get', 'Read the current status of a durable operation.', {
    input: { operation_id: text() }, id: 'operation_id', required: ['operation_id'], result: 'operation',
  }),
  agent('jobs_cancel', 'operations_cancel', 'Request cancellation of a durable operation.', {
    input: { operation_id: text() }, id: 'operation_id', required: ['operation_id'], write: 'update', result: 'operation',
  }),
  agent('agent_jobs_confirm_cancel', 'jobs_confirm_cancel', 'Confirm a cancellation with the original lease.', {
    ...jobUpdate, input: lease, required: ['agent_job_id', 'fencing_token'],
  }),
  agent('agent_jobs_claim', 'jobs_claim', 'Claim a job at its current version. Returns lease metadata.', {
    ...jobUpdate, input: jobId, required: ['agent_job_id'],
  }),
  agent('agent_jobs_heartbeat', 'jobs_heartbeat', 'Renew a job lease using its current version and fencing token.', {
    ...jobUpdate, input: { ...lease, progress_note: text(2000) }, required: ['agent_job_id', 'fencing_token'],
  }),
  agent('agent_jobs_submit_result', 'jobs_submit_result', 'Submit a result for human review using the current lease and version.', {
    ...jobUpdate, input: { ...lease, result_ref: object({ change_set_id: text(), note: text(4000) }) },
    required: ['agent_job_id', 'fencing_token', 'result_ref'],
  }),
  agent('agent_jobs_handoff', 'jobs_handoff', 'Hand an active job back for follow-up or reconciliation.', {
    ...jobUpdate, input: { ...lease, done_summary: text(4000), pending_side_effects: array(text(500)) },
    required: ['agent_job_id', 'fencing_token', 'done_summary'],
  }),
  agent('change_sets_create', 'change_sets_create', 'Propose version-pinned draft updates for human review.', {
    input: { title: text(200), rationale: text(4000), sources: array(target), items: array(changeItem, 25, 1), ...lease },
    required: ['title', 'rationale', 'items'], write: 'create', result: 'change',
  }),
  agent('change_sets_get', 'change_sets_get', 'Get the status and policy-approved preview of an accessible change set.', {
    input: { change_set_id: text() }, id: 'change_set_id', required: ['change_set_id'], result: 'change',
  }),
  agent('workflow_templates_list', 'workflow_templates_list', 'List policy-approved workflow template content.', {
    input: {}, result: 'templates', needsOutputPolicy: true,
  }),
  agent('automation_rules_list', 'automation_rules_list', 'List accessible automation rules without editing them.', {
    input: {}, result: 'rules', needsOutputPolicy: true,
  }),
  define({ name: 'research_search', module: 'intel', action: 'research_search',
    description: 'Search accessible observations, research items, and link-only creative references.',
    input: { keyword: text(), q: text(), watch_target_id: text(200), from: text(35), to: text(35), tag: text(200),
      id: text(200), kind: enumText('observation', 'research_item', 'creative_reference', 'mention') },
    query: ['keyword', 'q', 'watch_target_id', 'from', 'to', 'tag', 'id', 'kind'], result: 'intel', needsOutputPolicy: true,
  }),
  define({ name: 'research_item_evidence', module: 'intel', action: 'research_item_evidence',
    description: 'Resolve the exact evidence cited by an accessible research item.',
    input: { research_item_id: text(200) }, id: 'research_item_id', required: ['research_item_id'], result: 'intel', needsOutputPolicy: true,
  }),
  define({ name: 'research_create_note', module: 'intel', action: 'research_create_note',
    description: 'Draft a research note with cited evidence on an accessible board.',
    input: { board_id: text(200), title: text(250), body: text(4000),
      stance: enumText('evidence', 'counter_example', 'question', 'demand', 'hypothesis'), evidence_refs: array(text(200), 30) },
    id: 'board_id', required: ['board_id', 'body'], write: 'create', result: 'intel', needsOutputPolicy: true,
  }),
  define({ name: 'creative_reference_annotate', module: 'intel', action: 'creative_reference_annotate',
    description: 'Update the draft structure annotations of a link-only creative reference at its current version.',
    input: { creative_reference_id: text(200), structure: object({ hook: text(1000), topic: text(1000),
      format: text(1000), presentation: text(1000), cta: text(1000), interaction_question: text(1000),
      duration_s: { type: 'integer', minimum: 0, maximum: 604800 } }) },
    id: 'creative_reference_id', required: ['creative_reference_id', 'structure'], write: 'update', result: 'intel', needsOutputPolicy: true,
  }),
]);

const tools = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
export function getMcpTool(name: string): McpToolDefinition | undefined { return tools.get(name); }

const jobStatuses = new Set(['open', 'claimed', 'in_progress', 'submitted', 'returned', 'lease_expired', 'accepted', 'done', 'cancelled']);
const operationStatuses = new Set([...jobStatuses, 'queued', 'running', 'succeeded', 'partially_succeeded', 'partially_committed', 'partial', 'failed', 'cancel_requested', 'rate_limited', 'unavailable']);
const changeStatuses = new Set(['pending', 'partial', 'partially_applied', 'stale', 'applied', 'rejected']);
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function projectRow(value: unknown, kind: 'job' | 'change', lease: boolean): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const key = kind === 'job' ? 'agent_job_id' : 'change_set_id';
  const id = value[key] ?? value.id;
  const fields = isRecord(value.data) ? value.data : value;
  const status = fields.status;
  const statuses = kind === 'job' ? jobStatuses : changeStatuses;
  if (typeof id !== 'string' || !idPattern.test(id) || typeof status !== 'string' || !statuses.has(status) || !valid(value.version, version)) return undefined;
  const output: JsonRecord = { [key]: id, status, version: value.version };
  if (lease && valid(fields.fencing_token, fence)) output.fencing_token = fields.fencing_token;
  if (lease && typeof fields.lease_expires_at === 'string' && timePattern.test(fields.lease_expires_at)) output.lease_expires_at = fields.lease_expires_at;
  return output;
}

/** Extract only protocol metadata. Free text, previews, and source data require an explicit egress policy. */
export function projectMcpResult(tool: McpToolDefinition, value: unknown): JsonRecord | undefined {
  switch (tool.result) {
    case 'operation': {
      if (!isRecord(value) || typeof value.operation_id !== 'string' || !idPattern.test(value.operation_id) ||
        typeof value.status !== 'string' || !operationStatuses.has(value.status) || !valid(value.version, version)) return undefined;
      const requested = value.cancel_requested_at;
      const ref = value.result_ref;
      const report = isRecord(ref) && typeof ref.report_id === 'string' && idPattern.test(ref.report_id) &&
        typeof ref.version_id === 'string' && idPattern.test(ref.version_id) && valid(ref.version_no, version)
        ? { report_id: ref.report_id, version_id: ref.version_id, version_no: ref.version_no,
          ...(['pdf', 'csv', 'xlsx'].includes(String(ref.format)) && { format: ref.format }) } : undefined;
      const digest = isRecord(ref) && typeof ref.research_digest_id === 'string' && idPattern.test(ref.research_digest_id)
        ? { research_digest_id: ref.research_digest_id } : undefined;
      return { operation_id: value.operation_id, status: value.status, version: value.version,
        ...((report ?? digest) && { result_ref: report ?? digest }),
        cancel_requested_at: typeof requested === 'string' && timePattern.test(requested) ? requested : null,
        ...(isRecord(value.progress) ? { progress: Object.fromEntries(Object.entries(value.progress)
          .filter(([key, count]) => ['complete', 'completed', 'failed', 'pending', 'total', 'cancelled', 'checkpoint_index'].includes(key) &&
            typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) } : {}) };
    }
    case 'job': return projectRow(isRecord(value) && Object.hasOwn(value, 'job') ? value.job : value,
      'job', tool.name === 'agent_jobs_claim' || tool.name === 'agent_jobs_heartbeat');
    case 'change': return projectRow(isRecord(value) && Object.hasOwn(value, 'change_set') ? value.change_set : value, 'change', false);
    case 'jobs': {
      const items = Array.isArray(value) ? value : isRecord(value) ? value.items : undefined;
      if (!Array.isArray(items)) return undefined;
      const projected = items.slice(0, 100).map((row) => projectRow(row, 'job', false));
      if (projected.some((row) => !row)) return undefined;
      return { items: projected, truncated: items.length > 100 };
    }
    case 'approved_read': return isRecord(value) ? value : undefined;
    case 'operation_call': return isRecord(value) && isRecord(value.body) ? value : undefined;
    case 'hub': return isRecord(value) ? value : undefined;
    case 'templates':
    case 'rules':
    case 'intel': return {};
  }
}
