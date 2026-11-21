import { appendUsageEvent } from '../ops/usage.js';
import { DomainError, required, type Context } from '../types.js';
import { guardModelBudget, guardModelEgress, providerMonthTokens, resolveModelRoute, usageKind, validateModelCategories,
  type ModelDataClass, type ModelProtocol, type ModelProvider, type ModelPurpose } from './model-routing.js';

export type JsonObject = Record<string, unknown>;
export interface ModelTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: readonly ModelToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };
export interface ModelRequest {
  purpose: ModelPurpose;
  /** The trusted caller must classify the entire payload, including prompts, tools, schemas and tool results. */
  categories: readonly ModelDataClass[];
  messages: readonly ModelMessage[];
  tools?: readonly ModelTool[];
  responseSchema?: { name: string; schema: JsonObject };
  agentJobId?: string;
}
export interface ModelResult {
  content: string;
  toolCalls: ModelToolCall[];
  model: string;
  providerId: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_estimate_minor: number | null };
}
export interface ModelTransportRequest {
  tenantId: string;
  workspaceId: string;
  providerId: string;
  /** Both refs are resolved by the trusted transport for this tenant and workspace. */
  endpointRef: string;
  credentialRef: string;
  protocol: ModelProtocol;
  operation: 'chat_completions' | 'messages';
  body: JsonObject;
}
export type ModelTransport = (request: ModelTransportRequest) => Promise<unknown>;
export interface ModelClient {
  complete(ctx: Context, input: ModelRequest): Promise<ModelResult>;
}

function badRequest(message: string): never {
  throw new DomainError('invalid_model_request', message, 400);
}

function providerError(): never {
  throw new DomainError('MODEL_PROVIDER_ERROR', 'The configured model provider did not return a usable response', 502);
}

export function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) providerError();
  return value as JsonObject;
}

function replyArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) providerError();
  return value;
}

function replyString(value: unknown): string {
  if (typeof value !== 'string') providerError();
  return value;
}

function tokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) providerError();
  return value;
}

function requestOptions(input: ModelRequest, provider: ModelProvider) {
  if (!Array.isArray(input.messages) || !input.messages.length) badRequest('Model messages are required');
  let seenConversation = false;
  for (const message of input.messages) {
    if (typeof message.content !== 'string' || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
      badRequest('Invalid model message');
    }
    if (message.role === 'system' && seenConversation) badRequest('System messages must precede conversation messages');
    if (message.role !== 'system') seenConversation = true;
  }
  if (!seenConversation) badRequest('Conversation messages are required');
  if ((input.tools?.length || input.messages.some(message => message.role === 'tool'
    || (message.role === 'assistant' && message.toolCalls?.length))) && !provider.capabilities.tools) {
    badRequest('The configured provider does not support tools');
  }
  if (input.responseSchema && !provider.capabilities.structured_output) {
    badRequest('The configured provider does not support native structured output');
  }
}

export function openAiBody(input: ModelRequest, model: string, maxTokens: number): JsonObject {
  const messages = input.messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return { role: 'assistant', content: message.content || null, tool_calls: message.toolCalls.map(call => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) };
    }
    return { role: message.role, content: message.content };
  });
  return {
    model, max_tokens: maxTokens, messages,
    ...(input.tools?.length ? { tools: input.tools.map(tool => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(input.responseSchema ? { response_format: { type: 'json_schema', json_schema: {
      name: input.responseSchema.name, schema: input.responseSchema.schema, strict: true,
    } } } : {}),
  };
}

export function anthropicBody(input: ModelRequest, model: string, maxTokens: number, provider: Pick<ModelProvider, 'capabilities'>, effort?: string): JsonObject {
  const system = input.messages.filter(message => message.role === 'system').map((message, index, all) => ({
    type: 'text', text: message.content,
    ...(provider.capabilities.prompt_cache && index === all.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
  const messages: { role: string; content: JsonObject[] }[] = [];
  let toolResults: JsonObject[] | undefined;
  for (const message of input.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      if (!toolResults) {
        toolResults = [];
        messages.push({ role: 'user', content: toolResults });
      }
      toolResults.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content });
      continue;
    }
    toolResults = undefined;
    const content: JsonObject[] = message.content ? [{ type: 'text', text: message.content }] : [];
    if (message.role === 'assistant') {
      content.push(...(message.toolCalls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })));
    }
    if (!content.length) badRequest('Empty conversation message');
    messages.push({ role: message.role, content });
  }
  const outputConfig = {
    ...(effort && provider.capabilities.effort ? { effort } : {}),
    ...(input.responseSchema ? { format: { type: 'json_schema', schema: input.responseSchema.schema } } : {}),
  };
  return {
    model, max_tokens: maxTokens, messages,
    ...(system.length ? { system } : {}),
    ...(input.tools?.length ? { tools: input.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
}

interface NormalizedReply {
  content: string;
  toolCalls: ModelToolCall[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  incomplete: boolean;
}

export function reportedModel(reply: JsonObject, requestedModel: string): string {
  const model = replyString(reply.model === undefined ? requestedModel : reply.model);
  if (!model.trim() || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) providerError();
  return model;
}

export function decodeOpenAi(reply: JsonObject, usage: JsonObject): NormalizedReply {
  const choice = record(replyArray(reply.choices)[0]);
  const message = record(choice.message);
  const toolCalls = message.tool_calls === undefined ? [] : replyArray(message.tool_calls).map(value => {
    const call = record(value);
    const fn = record(call.function);
    return { id: replyString(call.id), name: replyString(fn.name), arguments: record(JSON.parse(replyString(fn.arguments))) };
  });
  const cache = usage.prompt_tokens_details == null ? 0 : tokens(record(usage.prompt_tokens_details).cached_tokens ?? 0);
  return { content: message.content === null || (message.content === undefined && toolCalls.length) ? '' : replyString(message.content), toolCalls,
    inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens), cacheReadTokens: cache,
    incomplete: choice.finish_reason === 'length' || choice.finish_reason === 'content_filter' || !!message.refusal };
}

export function decodeAnthropic(reply: JsonObject, usage: JsonObject): NormalizedReply {
  const parts: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const value of replyArray(reply.content)) {
    const block = record(value);
    if (block.type === 'text') parts.push(replyString(block.text));
    if (block.type === 'tool_use') toolCalls.push({ id: replyString(block.id), name: replyString(block.name), arguments: record(block.input) });
  }
  const cache = tokens(usage.cache_read_input_tokens ?? 0);
  const inputTokens = tokens(tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens ?? 0) + cache);
  return { content: parts.join(''), toolCalls, inputTokens, outputTokens: tokens(usage.output_tokens), cacheReadTokens: cache,
    incomplete: reply.stop_reason === 'max_tokens' || reply.stop_reason === 'refusal' || reply.stop_reason === 'model_context_window_exceeded' };
}

function estimateCost(provider: ModelProvider, input: number, output: number, cached: number): number | null {
  if (!provider.pricing) return null;
  const price = provider.pricing;
  const million = 1_000_000n;
  const scaled = BigInt(input - cached) * BigInt(price.input_minor_per_million)
    + BigInt(output) * BigInt(price.output_minor_per_million) + BigInt(cached) * BigInt(price.cache_read_minor_per_million);
  const cost = (scaled + million - 1n) / million;
  return cost <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cost) : null;
}

export function createModelClient({ transport }: { transport: ModelTransport }): ModelClient {
  return {
    async complete(ctx, input) {
      const { route, provider, providerId } = await resolveModelRoute(ctx, input.purpose);
      const categories = validateModelCategories(input.categories);
      // The strict OP guard blocks raw data that would require masking. Callers may pre-redact and classify a new payload.
      await guardModelEgress(ctx, providerId, provider, categories);
      await guardModelBudget(ctx, providerId, provider);
      if (input.agentJobId !== undefined) await required(ctx, 'agent', 'agent_job', input.agentJobId);
      requestOptions(input, provider);
      const isOpenAi = provider.protocol === 'openai_chat';
      const body = isOpenAi ? openAiBody(input, route.model, route.params.max_tokens)
        : anthropicBody(input, route.model, route.params.max_tokens, provider, route.params.effort);
      let reply: NormalizedReply;
      let model: string;
      try {
        const wire = record(await transport({
          tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, providerId, endpointRef: provider.endpoint_ref,
          credentialRef: provider.credential_ref, protocol: provider.protocol, operation: isOpenAi ? 'chat_completions' : 'messages', body,
        }));
        model = reportedModel(wire, route.model);
        const usage = record(wire.usage);
        reply = isOpenAi ? decodeOpenAi(wire, usage) : decodeAnthropic(wire, usage);
        if (reply.cacheReadTokens > reply.inputTokens) providerError();
      } catch {
        // The transport can include private URLs, headers or prompt content in its errors.
        providerError();
      }
      const usage = {
        input_tokens: reply.inputTokens, output_tokens: reply.outputTokens, cache_read_tokens: reply.cacheReadTokens,
        cost_estimate_minor: estimateCost(provider, reply.inputTokens, reply.outputTokens, reply.cacheReadTokens),
      };
      const total = tokens(reply.inputTokens + reply.outputTokens);
      const ledger = await ctx.insert('agent', usageKind, {
        provider_id: providerId, purpose: input.purpose, model, ...usage, agent_job_id: input.agentJobId ?? null,
        user_id: ctx.actorId, occurred_at: ctx.now,
      });
      await appendUsageEvent(ctx, 'model_tokens', total, { resource_type: usageKind, resource_id: ledger.id });
      if (provider.monthly_token_budget !== null) {
        const spent = await providerMonthTokens(ctx, providerId);
        if (spent >= provider.monthly_token_budget && spent - total < provider.monthly_token_budget) {
          await ctx.emit('agent.usage.budget_threshold_reached', { provider_id: providerId,
            monthly_token_budget: provider.monthly_token_budget, tokens: spent });
        }
      }
      return { content: reply.content, toolCalls: reply.toolCalls, model, providerId, usage };
    },
  };
}
