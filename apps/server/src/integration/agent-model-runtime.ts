import { Problem } from '@smartsell/contracts';
import { anthropicBody, decodeAnthropic, decodeOpenAi, openAiBody, record, reportedModel, type ModelTransport } from '../modules/agent/model-client.js';
import type { AgentModelServices, ModelDestination, ModelRequest, ModelContext } from '../modules/agent/models.js';
import { assertEmergencyNotStopped } from '../modules/ops/index.js';

interface Binding {
  tenantId: string;
  workspaceId: string;
  secretId: string;
  endpoint: string;
  protocol: ModelDestination['protocol'];
  secretEnv: string;
}

export function agentModelRuntime(env: NodeJS.ProcessEnv = process.env, transport?: ModelTransport) {
  const raw: unknown = JSON.parse(env.SMARTSELL_AGENT_MODELS ?? '[]');
  if (!Array.isArray(raw)) throw new Error('Invalid SMARTSELL_AGENT_MODELS');
  const bindings = new Map<string, Binding>();
  for (const binding of raw as Binding[]) {
    if (!binding || ![binding.tenantId, binding.workspaceId, binding.secretId].every(id => typeof id === 'string' && /^[\w-]{1,128}$/.test(id)) ||
      !['openai_chat', 'anthropic_messages'].includes(binding.protocol) || typeof binding.endpoint !== 'string' ||
      typeof binding.secretEnv !== 'string' || !/^SMARTSELL_AGENT_SECRET_[A-Z0-9_]+$/.test(binding.secretEnv) || (!transport && !env[binding.secretEnv])) {
      throw new Error('Invalid Agent model binding');
    }
    const url = new URL(binding.endpoint);
    const loopback = env.NODE_ENV !== 'production' && env.SMARTSELL_AGENT_MODEL_LOOPBACK === '1' &&
      url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) throw new Error('Invalid Agent model endpoint');
    const key = `${binding.tenantId}/${binding.workspaceId}/${binding.secretId}`;
    if (bindings.has(key)) throw new Error('Duplicate Agent model binding');
    bindings.set(key, { ...binding, endpoint: url.href });
  }

  const find = (ctx: Pick<ModelContext, 'tenantId' | 'workspaceId'>, id: string) => bindings.get(`${ctx.tenantId}/${ctx.workspaceId}/${id}`);
  const accepts: NonNullable<AgentModelServices['accepts']> = (ctx, dest, purpose) => {
    const binding = find(ctx, dest.secretId);
    return purpose !== 'embed' && !!binding && binding.endpoint === dest.endpoint && binding.protocol === dest.protocol;
  };
  const send: ModelTransport = transport ?? (async request => {
    const binding = find(request, request.credentialRef);
    if (!binding || binding.endpoint !== request.endpointRef || binding.protocol !== request.protocol) throw new Error('Unknown model destination');
    const url = new URL(binding.endpoint);
    const openAi = request.operation === 'chat_completions';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${openAi ? 'chat/completions' : 'messages'}`;
    const credential = env[binding.secretEnv]!;
    const headers: Record<string, string> = openAi ? { authorization: `Bearer ${credential}` } : { 'x-api-key': credential, 'anthropic-version': '2023-06-01' };
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(request.body), redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Model request failed');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 512 * 1024) throw new Error('Model response exceeds limit');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  });
  function wireBody(dest: ModelDestination, request: ModelRequest) {
    const input = {
      purpose: 'plan' as const, categories: [],
      messages: request.conversation?.messages ?? [{ role: 'user' as const, content: JSON.stringify(request.fields) }],
      tools: request.conversation?.tools,
    };
    return dest.protocol === 'openai_chat' ? openAiBody(input, request.model, request.maxOutputTokens) :
      anthropicBody(input, request.model, request.maxOutputTokens,
        { capabilities: { tools: true, prompt_cache: false, structured_output: false, effort: false } });
  }
  async function invoke(ctx: ModelContext, dest: ModelDestination, request: ModelRequest) {
    if (!accepts(ctx, dest, request.purpose)) throw new Problem(403, 'EGRESS_DENIED', 'Model destination is not configured');
    assertEmergencyNotStopped(ctx);
    const openAi = dest.protocol === 'openai_chat';
    const body = wireBody(dest, request);
    const reply = record(await send({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, providerId: dest.id,
      endpointRef: dest.endpoint, credentialRef: dest.secretId, protocol: dest.protocol, operation: openAi ? 'chat_completions' : 'messages', body }));
    const usage = record(reply.usage);
    const result = openAi ? decodeOpenAi(reply, usage) : decodeAnthropic(reply, usage);
    return { output: result.content, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens, toolCalls: result.toolCalls, incomplete: result.incomplete,
      model: reportedModel(reply, request.model) };
  }
  return {
    bind(ctx: ModelContext, fallback?: AgentModelServices): AgentModelServices | undefined {
      if (![...bindings.values()].some(row => row.workspaceId === ctx.workspaceId && row.tenantId === ctx.tenantId)) return fallback;
      return {
        ownsSecret: (context, id) => !!find(context, id) || fallback?.ownsSecret(context, id) === true,
        accepts: (context, dest, purpose) => accepts(context, dest, purpose) || (purpose === 'embed' && fallback?.ownsSecret(context, dest.secretId) === true),
        invoke: (context, dest, request) => request.purpose === 'embed' && fallback ? fallback.invoke(context, dest, request) : invoke(context, dest, request),
        countInputTokens: (context, dest, request) => request.purpose === 'embed' && fallback ? fallback.countInputTokens(context, dest, request) :
          Buffer.byteLength(JSON.stringify(wireBody(dest, request))),
      };
    },
  };
}
