import { ADMIN, Problem, READ, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { assertUsageAllowed, recordUsage } from '../ops/metering.js';
import { assertEmergencyNotStopped, evaluateEgress, confirmModelEgress, removeModelEgress, setEgressPolicy } from '../ops/controls.js';
import { array, checkVersion, conflict, integer, object, text } from './input.js';
import { createChangeSet } from './changes.js';
import type { ModelMessage, ModelTool, ModelToolCall } from './model-client.js';
import { getVisibleResource, resourceRef } from './jobs.js';

const purposes = ['draft', 'translate', 'classify', 'analyze', 'plan', 'embed'];
const protocols = ['openai_chat', 'anthropic_messages'] as const;
const allowedClasses = ['public', 'brand_context', 'product_facts', 'content_draft', 'report', 'internal', 'pii', 'raw_payload'];

export interface ModelField { dataClass: string; text: string; required?: boolean }
export interface ModelRequest {
  model: string;
  purpose: string;
  maxOutputTokens: number;
  fields: readonly ModelField[];
  conversation?: ModelConversation;
}
export interface ModelConversation {
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  agentJobId?: string;
}
export interface ModelResponse {
  toolCalls?: ModelToolCall[];
  output: string | number[];
  model?: string;
  incomplete?: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costEstimateMinor?: number;
  requestId?: string;
}
export interface ModelDestination {
  id: string;
  endpoint: string;
  protocol: 'openai_chat' | 'anthropic_messages';
  secretId: string;
}
export interface AgentModelServices {
  /** Verify workspace ownership and purpose of the existing secret without resolving it. */
  ownsSecret(ctx: Context, secretId: string): boolean;
  /** Authenticate via the matched SDK, enforce destination/redirect/IP policy at the connection, and meter actual token counts. */
  invoke(ctx: Context, destination: ModelDestination, request: ModelRequest): Promise<ModelResponse>;
  /** Count the exact outbound request with a local or approved counter before dispatch. */
  countInputTokens(ctx: Context, destination: ModelDestination, request: ModelRequest): number;
  /** Check whether this exact destination is bound for the purpose. */
  accepts?(ctx: Context, destination: ModelDestination, purpose: string): boolean;
  /** Recheck export permissions and project current, typed business data. The caller cannot assign data classes. */
  assistFields?(ctx: Context, page: string, refs: readonly { kind: string; id: string }[], intent: string): readonly ModelField[];
}
export interface ModelContext extends Context { agentModelServices?: AgentModelServices }

function choice<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  const result = text(value, field);
  if (!choices.some(value => value === result)) throw new Problem(400, 'INVALID_INPUT', `Unsupported ${field}`);
  return result as T;
}

function providerView(ctx: Context, row: Row) {
  const { secret_id, ...visible } = row;
  return { ...visible, has_credential: typeof secret_id === 'string',
    egress: evaluateEgress(ctx, { kind: 'model_provider', id: row.id }, row.allowed_data_classes as string[]) };
}

function destination(row: Row): ModelDestination {
  return { id: row.id, endpoint: String(row.endpoint), protocol: row.protocol as ModelDestination['protocol'], secretId: String(row.secret_id) };
}

function runtime(ctx: Context): AgentModelServices {
  const services = (ctx as ModelContext).agentModelServices;
  if (!services) throw new Problem(503, 'AI_ADAPTER_UNAVAILABLE', 'No model runtime is connected');
  return services;
}

function routeFor(ctx: Context, purpose: string): { route: Row; provider: Row } | undefined {
  const route = ctx.list('model_route').find((entry) => entry.enabled === true && entry.purpose === purpose);
  const provider = route && ctx.list('model_provider').find((row) => row.id === route.provider_id && row.status === 'active');
  return route && provider ? { route, provider } : undefined;
}

function rejectsTools(provider: Row, model: unknown) {
  return provider.probed_model === model && (provider.capabilities as Data | undefined)?.tool_calling === false;
}

export function assertModelRoute(ctx: Context, purpose: string) {
  const resolved = routeFor(ctx, purpose);
  if (!resolved) throw new Problem(409, 'AI_NOT_CONFIGURED', 'No model is configured for this purpose');
  return resolved;
}

export function availableModelPurposes(ctx: Context) {
  const service = (ctx as ModelContext).agentModelServices;
  if (!service) return [];
  return purposes.filter((purpose) => {
    const resolved = routeFor(ctx, purpose);
    return resolved && (purpose !== 'plan' || !rejectsTools(resolved.provider, resolved.route.model)) && service.ownsSecret(ctx, String(resolved.provider.secret_id)) &&
      (service.accepts?.(ctx, destination(resolved.provider), purpose) ?? true) &&
      (resolved.provider.allowed_data_classes as string[]).some(dataClass => (purpose !== 'plan' || dataClass === 'internal') &&
        evaluateEgress(ctx, { kind: 'model_provider', id: resolved.provider.id }, [dataClass]) === 'allow');
  });
}

/** Trusted service boundary. Call in the host's serialized workspace transaction. Fields are classified server-side. */
export async function requestModel(ctx: Context, purpose: string, fields: readonly ModelField[], conversation?: ModelConversation): Promise<ModelResponse> {
  const { route, provider } = assertModelRoute(ctx, purpose);
  return auditRequest(ctx, provider, String(route.model), purpose, conversation?.agentJobId, audit => {
    if (conversation?.tools.length && rejectsTools(provider, route.model)) {
      throw new Problem(409, 'MODEL_TOOLS_UNAVAILABLE', 'The selected model did not pass the tool capability probe');
    }
    if (!fields.length || fields.length > 50) throw new Problem(400, 'INVALID_INPUT', 'A bounded model context is required');
    let allowedCount = 0;
    const filtered = fields.map((field) => {
      const dataClass = choice(field.dataClass, 'data_class', allowedClasses);
      const value = text(field.text, 'model field', 100_000);
      if (dataClass === 'raw_payload' || !(provider.allowed_data_classes as string[]).includes(dataClass) ||
          evaluateEgress(ctx, { kind: 'model_provider', id: provider.id }, [dataClass]) !== 'allow') {
        // Conversation classes cover the entire wire payload, so field masking alone is insufficient.
        if (conversation || field.required !== false) throw new Problem(403, 'EGRESS_DENIED', `Required data class ${dataClass} may not leave the workspace`);
        return { dataClass, text: '[masked]' };
      }
      allowedCount++;
      return { dataClass, text: value };
    });
    if (!allowedCount) throw new Problem(403, 'EGRESS_DENIED', 'No model input is approved for this destination');
    const maxOutputTokens = integer(route.max_output_tokens, 'max_output_tokens', 1, 16_384);
    return invokeModel(ctx, provider, { model: String(route.model), purpose, maxOutputTokens, fields: filtered, conversation }, route.max_cost_minor, audit);
  });
}

async function auditRequest(ctx: Context, provider: Row, model: string, purpose: string, jobId: string | undefined,
  run: (audit: Row) => Promise<ModelResponse>) {
  const audit = ctx.create('model_request', { provider_id: provider.id, protocol: provider.protocol, model, purpose,
    actor_id: ctx.actorId, agent_job_id: jobId ?? null, occurred_at: ctx.now, dispatched: false, outcome: 'pending' });
  try {
    return await run(audit);
  } catch (error) {
    ctx.update('model_request', audit.id, { outcome: 'failed', error_code: error instanceof Problem ? error.code : 'AI_PROVIDER_ERROR' });
    throw error;
  }
}

async function invokeModel(ctx: Context, provider: Row, request: ModelRequest, maxCostMinor: unknown, audit: Row): Promise<ModelResponse> {
  const service = runtime(ctx);
  const endpoint = destination(provider);
  const { maxOutputTokens, purpose } = request;
  if (!service.ownsSecret(ctx, endpoint.secretId)) throw new Problem(409, 'AI_CREDENTIAL_UNAVAILABLE', 'The model credential is unavailable');
  if (service.accepts?.(ctx, endpoint, purpose) === false) throw new Problem(403, 'EGRESS_DENIED', 'The model destination is not bound to this workspace');
  const inputBudget = integer(service.countInputTokens(ctx, endpoint, request), 'input tokens', 0, 1_000_000);
  assertUsageAllowed(ctx, 'model_tokens', inputBudget + maxOutputTokens);
  if (typeof provider.monthly_token_budget === 'number') {
    const spent = ctx.list('ai_usage').filter(row => row.provider_id === provider.id &&
      String(row.occurred_at).slice(0, 7) === ctx.now.slice(0, 7))
      .reduce((total, row) => total + Number(row.input_tokens) + Number(row.output_tokens), 0);
    if (spent + inputBudget + maxOutputTokens > provider.monthly_token_budget) {
      throw new Problem(402, 'MODEL_BUDGET_EXHAUSTED', 'The model provider token budget cannot cover this call');
    }
  }
  if (typeof provider.monthly_budget_minor === 'number') {
    const budget = provider.monthly_budget_minor;
    const ceiling = integer(maxCostMinor, 'max_cost_minor', 1);
    const month = ctx.now.slice(0, 7);
    const accumulated = ctx.list('ai_usage').filter((row) => row.provider_id === provider.id && String(row.occurred_at).slice(0, 7) === month);
    if (accumulated.some((row) => typeof row.cost_estimate_minor !== 'number') ||
      accumulated.reduce((sum, row) => sum + Number(row.cost_estimate_minor), 0) + ceiling > budget) {
      throw new Problem(402, 'LICENSE_LIMIT', 'The model provider budget cannot cover this call');
    }
  }
  let response: ModelResponse;
  assertEmergencyNotStopped(ctx);
  ctx.update('model_request', audit.id, { dispatched: true });
  try {
    response = await service.invoke(ctx, endpoint, request);
  } catch {
    throw new Problem(502, 'AI_PROVIDER_ERROR', 'The configured model did not complete the request');
  }
  const inputTokens = integer(response.inputTokens, 'input tokens', 0);
  const outputTokens = integer(response.outputTokens, 'output tokens', 0);
  const cache = integer(response.cacheReadTokens ?? 0, 'cache tokens', 0, inputTokens);
  const cost = response.costEstimateMinor === undefined ? null : integer(response.costEstimateMinor, 'model cost', 0);
  const validOutput = !response.incomplete && (purpose === 'embed' ?
    Array.isArray(response.output) && response.output.length > 0 && response.output.length <= 8192 && response.output.every(Number.isFinite) :
    typeof response.output === 'string' && (!!response.output.trim() || !!response.toolCalls?.length) && response.output.length <= 200_000);
  const usage = ctx.create('ai_usage', {
    provider_id: provider.id, model: response.model ?? request.model, purpose: audit.purpose, actor_id: ctx.actorId, input_tokens: inputTokens,
    output_tokens: outputTokens, cache_read_tokens: cache, cost_estimate_minor: cost, occurred_at: ctx.now,
    outcome: validOutput ? 'success' : 'invalid_output', agent_job_id: audit.agent_job_id, model_request_id: audit.id,
  });
  ctx.update('model_request', audit.id, { outcome: usage.outcome, ai_usage_id: usage.id });
  if (inputTokens + outputTokens > 0) recordUsage(ctx, 'model_tokens', inputTokens + outputTokens, `ai_usage:${usage.id}`);
  return { output: validOutput ? response.output : '', toolCalls: validOutput ? response.toolCalls : undefined, inputTokens, outputTokens, cacheReadTokens: cache, ...(cost === null ? {} : { costEstimateMinor: cost }) };
}

export const modelOperations: Operation[] = [
  { method: 'GET', path: '/ai/status', name: 'ai_get_status', roles: READ, summary: 'Show available AI purposes', run(ctx) {
    const enabledPurposes = availableModelPurposes(ctx);
    return { enabled: enabledPurposes.length > 0, purposes: enabledPurposes };
  } },
  { method: 'GET', path: '/model-providers', name: 'model_providers_list', roles: ADMIN, summary: 'List customer-configured model providers', run: (ctx) => ctx.list('model_provider').map(row => providerView(ctx, row)) },
  { method: 'POST', path: '/model-providers', name: 'model_providers_create', roles: ADMIN, summary: 'Register a customer-provided model endpoint', run(ctx, { body }) {
    const kind = choice(body.kind, 'kind', ['openai_compatible', 'anthropic_compatible', 'internal_gateway', 'anthropic']);
    const protocol = kind === 'openai_compatible' ? 'openai_chat' : kind === 'internal_gateway' ? choice(body.protocol, 'protocol', protocols) : 'anthropic_messages';
    // The runtime appends /messages to this base, so the direct Anthropic base includes the API version segment.
    const url = URL.parse(kind === 'anthropic' ? 'https://api.anthropic.com/v1' : text(body.endpoint, 'endpoint', 2048));
    if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Problem(400, 'INVALID_INPUT', 'An HTTPS base URL without credentials, query, or fragment is required');
    const secret = text(body.secret_id, 'secret_id');
    if (!runtime(ctx).ownsSecret(ctx, secret)) throw new Problem(404, 'AI_CREDENTIAL_UNAVAILABLE', 'Model credential not found');
    if (url.protocol === 'http:' && !runtime(ctx).accepts?.(ctx, { id: '', endpoint: url.href, protocol, secretId: secret }, 'plan')) {
      throw new Problem(400, 'INVALID_INPUT', 'Loopback requires an explicitly configured development endpoint');
    }
    const classes = [...new Set(array(body.allowed_data_classes, 'allowed_data_classes', 16).map((entry) => choice(entry, 'data_class', allowedClasses)))];
    if (!classes.length || classes.includes('raw_payload')) throw new Problem(400, 'INVALID_INPUT', 'Select supported data classes other than raw payloads');
    const row = ctx.create('model_provider', {
      name: text(body.name, 'name'), kind, protocol, endpoint: url.href, secret_id: secret, allowed_data_classes: classes, status: 'disabled', capabilities: {},
      monthly_token_budget: body.monthly_token_budget == null ? null : integer(body.monthly_token_budget, 'monthly_token_budget'),
      monthly_budget_minor: body.monthly_budget_minor === undefined ? null : integer(body.monthly_budget_minor, 'monthly_budget_minor'),
    });
    if (body.confirm_egress === true) confirmModelEgress(ctx, row.id, classes);
    ctx.emit('agent.model_provider.created', { id: row.id, protocol });
    return providerView(ctx, row);
  } },
  { method: 'PATCH', path: '/model-providers/:id', name: 'model_providers_update', roles: ADMIN, summary: 'Enable or disable a model provider and manage its egress consent', versionKind: 'model_provider', run(ctx, input) {
    const row = ctx.get('model_provider', input.params.id!);
    checkVersion(row, input.expectedVersion);
    const status = choice(input.body.status ?? row.status, 'status', ['active', 'disabled']);
    const classes = row.allowed_data_classes as string[];
    const consent = input.body.confirm_egress;
    if (consent !== undefined && typeof consent !== 'boolean') throw new Problem(400, 'INVALID_INPUT', 'confirm_egress must be a boolean');
    if (consent === true) confirmModelEgress(ctx, row.id, classes);
    if (consent === false) {
      const policy = ctx.list('egress_policy')[0];
      const rules = ((policy?.rules ?? []) as Data[]).filter(rule => rule.destination_kind !== 'model_provider' || rule.destination_id !== row.id);
      setEgressPolicy(ctx, 'workspace', [...rules, ...classes.map(data_class => ({
        destination_kind: 'model_provider', destination_id: row.id, data_class, effect: 'deny',
      }))], policy?.default_effect);
    }
    if (consent !== false && status === 'active' && evaluateEgress(ctx, { kind: 'model_provider', id: row.id }, classes) === 'deny') {
      throw new Problem(403, 'EGRESS_DENIED', 'Model egress policy must be confirmed before activation');
    }
    const patch: Data = { status };
    if (input.body.monthly_budget_minor !== undefined) patch.monthly_budget_minor = input.body.monthly_budget_minor === null ? null : integer(input.body.monthly_budget_minor, 'monthly_budget_minor');
    if (input.body.monthly_token_budget !== undefined) patch.monthly_token_budget = input.body.monthly_token_budget === null ? null : integer(input.body.monthly_token_budget, 'monthly_token_budget');
    return providerView(ctx, ctx.update('model_provider', row.id, patch));
  } },
  { method: 'DELETE', path: '/model-providers/:id', name: 'model_providers_remove', roles: ADMIN, versionKind: 'model_provider', summary: 'Remove a model provider after removing its purpose routes', run(ctx, { params }) {
    const provider = ctx.get('model_provider', params.id!);
    if (ctx.list('model_route').some(route => route.provider_id === provider.id)) {
      throw new Problem(409, 'MODEL_PROVIDER_IN_USE', 'Remove this provider’s model routes first');
    }
    removeModelEgress(ctx, provider.id);
    ctx.remove('model_provider', provider.id);
    ctx.emit('agent.model_provider.removed', { id: provider.id });
    return { removed: true };
  } },
  { method: 'POST', path: '/model-providers/:id/test', name: 'model_providers_test', roles: ADMIN, external: true, summary: 'Probe the configured endpoint without business data', async run(ctx, { params, body }) {
    const row = ctx.get('model_provider', params.id!);
    if (evaluateEgress(ctx, { kind: 'model_provider', id: row.id }, row.allowed_data_classes as string[]) !== 'allow') {
      throw new Problem(403, 'EGRESS_DENIED', 'Confirm model egress before probing');
    }
    const route = ctx.list('model_route').find(route => route.provider_id === row.id && route.purpose === 'plan');
    const model = text(body.model ?? route?.model, 'model');
    const tool: ModelTool = { name: 'capability_check', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
    const response = await auditRequest(ctx, row, model, 'capability_probe', undefined, audit => invokeModel(ctx, row, {
      model, purpose: 'plan', maxOutputTokens: 128, fields: [], conversation: {
        messages: [{ role: 'user', content: 'Call the capability_check tool with an empty object.' }], tools: [tool],
      },
    }, route?.max_cost_minor, audit));
    const calls = response.toolCalls ?? [];
    const [call] = calls;
    const capabilities = { tool_calling: calls.length === 1 && call?.name === tool.name &&
      /^[\w-]{1,128}$/.test(call.id) && Object.keys(call.arguments).length === 0, embeddings: false, streaming: false };
    ctx.update('model_provider', row.id, { capabilities, probed_model: model, probed_at: ctx.now });
    return capabilities;
  } },
  { method: 'GET', path: '/model-routes', name: 'model_routes_list', roles: ADMIN, summary: 'List explicitly configured purpose routes', run: (ctx) => ctx.list('model_route') },
  { method: 'POST', path: '/model-routes', name: 'model_routes_create', roles: ADMIN, summary: 'Configure a purpose route without fallback', run(ctx, { body }) {
    const purpose = choice(body.purpose, 'purpose', purposes);
    if (ctx.list('model_route').some((row) => row.purpose === purpose)) throw new Problem(409, 'MODEL_ROUTE_EXISTS', 'This purpose already has a route');
    return ctx.create('model_route', routeValues(ctx, purpose, body));
  } },
  { method: 'PATCH', path: '/model-routes/:id', name: 'model_routes_update', roles: ADMIN, summary: 'Update a purpose route', versionKind: 'model_route', run(ctx, input) {
    const row = ctx.get('model_route', input.params.id!);
    checkVersion(row, input.expectedVersion);
    return ctx.update('model_route', row.id, routeValues(ctx, String(row.purpose), { ...row, ...input.body }));
  } },
  { method: 'DELETE', path: '/model-routes/:id', name: 'model_routes_remove', roles: ADMIN, versionKind: 'model_route', summary: 'Remove a model purpose route', run(ctx, { params }) {
    const id = params.id!;
    ctx.remove('model_route', id);
    ctx.emit('agent.model_route.removed', { id });
    return { removed: true };
  } },
  { method: 'GET', path: '/model-requests', name: 'model_requests_list', roles: ADMIN, summary: 'List redacted model request outcomes', run: (ctx, { query }) => ctx.list('model_request').filter(row =>
    (!query.provider_id || row.provider_id === query.provider_id) && (!query.agent_job_id || row.agent_job_id === query.agent_job_id)) },
  { method: 'GET', path: '/ai-usage', name: 'ai_usage_list', roles: ADMIN, summary: 'List observed model usage', run: (ctx, { query }) => ctx.list('ai_usage').filter((row) => !query.provider_id || row.provider_id === query.provider_id) },
  { method: 'POST', path: '/assist', name: 'agent_assist', roles: ['owner', 'admin', 'manager', 'editor'], external: true, summary: 'Request a page suggestion using the approved purpose route', async run(ctx, { body }) {
    if (!routeFor(ctx, 'draft')) throw new Problem(409, 'AI_NOT_CONFIGURED', 'No model is configured for page suggestions');
    const service = runtime(ctx);
    const page = text(body.page, 'page');
    const intent = text(body.intent, 'intent', 8000);
    const refs = array(body.resource_refs ?? [], 'resource_refs', 20).map((value) => {
      const ref = object(value, 'resource_ref');
      return { kind: text(ref.kind, 'kind'), id: text(ref.id, 'id') };
    });
    const sources = refs.map(ref => resourceRef(ctx, ref, ['work_item', 'content_item']));
    const fields = service.assistFields?.(ctx, page, refs, intent) ?? [
      { dataClass: 'internal', text: JSON.stringify({ page, intent, instruction: 'Suggest a replacement title as plain text. No action will be executed.' }) },
      ...sources.map(ref => ({ dataClass: ref.kind === 'content_item' ? 'content_draft' : 'internal',
        text: JSON.stringify({ title: getVisibleResource(ctx, String(ref.kind), String(ref.id)).title }) })),
    ];
    const response = await requestModel(ctx, 'draft', fields);
    if (typeof response.output !== 'string' || !response.output) return { status: 'unavailable', code: 'AI_INVALID_OUTPUT' };
    return ctx.create('assist_suggestion', { page, resource_refs: sources, output: response.output, status: 'shown', created_by: ctx.actorId });
  } },
  { method: 'POST', path: '/assist/:id/review', name: 'agent_assist_review', roles: ['owner', 'admin', 'manager', 'editor'], versionKind: 'assist_suggestion', summary: 'Reject a suggestion or submit selected edits for review', run(ctx, input) {
    const row = ctx.get('assist_suggestion', input.params.id!);
    if (row.created_by !== ctx.actorId) throw new Problem(404, 'NOT_FOUND', 'Suggestion not found');
    checkVersion(row, input.expectedVersion);
    if (row.status !== 'shown') conflict('The suggestion has already been reviewed');
    const decision = choice(input.body.decision, 'decision', ['reject', 'propose']);
    if (decision === 'reject') return ctx.update('assist_suggestion', row.id, { status: 'rejected' });
    const sources = array(row.resource_refs ?? [], 'resource_refs', 20).map((value) => resourceRef(ctx, value));
    const items = array(input.body.items, 'items', 25);
    for (const value of items) {
      const item = object(value, 'item');
      if (!sources.some((ref) => ref.kind === item.target_type && ref.id === item.target_id && ref.version === item.expected_version)) throw new Problem(403, 'FORBIDDEN', 'The change target is outside the suggestion context');
    }
    const set = createChangeSet(ctx, { title: input.body.title, sources, items });
    return { ...ctx.update('assist_suggestion', row.id, { status: 'proposed', change_set_id: set.id }), change_set: set };
  } },
];

function routeValues(ctx: Context, purpose: string, values: Data): Data {
  const provider = ctx.get('model_provider', text(values.provider_id, 'provider_id'));
  if (purpose === 'embed' && provider.protocol !== 'openai_chat') throw new Problem(400, 'INVALID_INPUT', 'Embedding requires an embedding-capable OpenAI-compatible gateway');
  if (values.enabled !== undefined && typeof values.enabled !== 'boolean') throw new Problem(400, 'INVALID_INPUT', 'enabled must be a boolean');
  return { purpose, provider_id: provider.id, model: text(values.model, 'model'), enabled: values.enabled === true,
    max_output_tokens: integer(values.max_output_tokens ?? 4096, 'max_output_tokens', 1, 16_384),
    max_cost_minor: values.max_cost_minor == null ? null : integer(values.max_cost_minor, 'max_cost_minor') };
}
