import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWorkspace } from '../ingest/test-context.js';
import { egressCommands } from '../ops/egress.js';
import { type Commands, type Entity } from '../types.js';
import { createModelClient, type ModelRequest, type ModelTransport } from './model-client.js';
import { modelCommands } from './model-routing.js';

const providerConfig = {
  kind: 'openai_compatible', protocol: 'openai_chat', endpoint_ref: 'local_gateway', credential_ref: 'gateway_credential',
  allowed_data_classes: ['content', 'message'], capabilities: { tools: true, structured_output: true },
};
const analyze: ModelRequest = { purpose: 'analyze', categories: ['content'], messages: [{ role: 'user', content: 'Summarize mock content' }] };
const openAiAnswer = {
  model: 'mock-openai-v2', choices: [{ message: { content: 'Mock summary' } }],
  usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
};

function setup(transport: ModelTransport) {
  const workspace = testWorkspace();
  const client = createModelClient({ transport });
  const commands: Commands = { ...modelCommands, ...egressCommands };
  const run = <T = any>(action: string, input: Record<string, unknown> = {}, options?: Parameters<typeof workspace.run>[3]) =>
    workspace.run<T>(commands, action, input, options);
  const configure = (overrides = {}) => run<Entity>('configure_model_provider', { ...providerConfig, ...overrides });
  const route = (provider: Entity, params: { max_tokens: number; effort?: 'low' | 'medium' | 'high' } = { max_tokens: 20 }) =>
    run('configure_model_route', { purpose: 'analyze', provider_id: provider.id, model: 'mock-model', params });
  const allow = (provider: Entity, effect = 'allow', data_classes = ['content']) => run('set_egress_policy', {
    default_effect: 'deny', rules: [{ destination_kind: 'model_provider', destination_id: provider.id, data_classes, effect }],
  });
  const complete = (input = analyze) => workspace.run({ complete: { roles: ['owner'], run: ctx => client.complete(ctx, input) } }, 'complete');
  return { workspace, run, configure, route, allow, complete };
}

test('there is no default and configuration requires admin, safe references and a version', async () => {
  const h = setup(async () => assert.fail('no transport expected'));
  assert.deepEqual(await h.run('model_availability', { purpose: 'analyze' }, { role: 'viewer' }),
    { purpose: 'analyze', available: false, reason: 'AI_NOT_CONFIGURED' });
  await assert.rejects(h.complete(), { code: 'AI_NOT_CONFIGURED', status: 409 });
  await assert.rejects(h.run('configure_model_provider', providerConfig, { role: 'editor' }), { status: 403 });
  await assert.rejects(h.run('model_usage', {}, { role: 'viewer' }), { status: 403 });
  await assert.rejects(h.configure({ endpoint_ref: 'https://example.invalid/' }), { code: 'invalid_input' });
  await assert.rejects(h.configure({ api_key: 'fake-plaintext-key' }), { code: 'invalid_input' });
  const provider = await h.configure();
  await h.route(provider);
  await assert.rejects(h.route(provider), { code: 'invalid_input' });
  await assert.rejects(h.configure({ id: provider.id, version: provider.version, endpoint_ref: 'different_gateway' }),
    { code: 'model_destination_immutable' });
  assert.deepEqual(await h.run('model_availability', { purpose: 'analyze' }, { workspaceId: 'other-workspace' }),
    { purpose: 'analyze', available: false, reason: 'AI_NOT_CONFIGURED' });
});

test('both model and OP policy guard the selected destination and block masked raw data', async () => {
  const h = setup(async () => assert.fail('blocked data must never reach the transport'));
  const provider = await h.configure();
  const alternate = await h.configure();
  await h.route(provider);
  await assert.rejects(h.complete(), { code: 'EGRESS_BLOCKED' });
  await h.allow(alternate);
  await assert.rejects(h.complete(), { code: 'EGRESS_BLOCKED' });
  await h.run('set_egress_policy', { default_effect: 'allow', rules: [], version: 1 });
  await assert.rejects(h.complete(), { code: 'EGRESS_BLOCKED' });
  await h.run('set_egress_policy', { default_effect: 'deny', version: 2, rules: [{
    destination_kind: 'model_provider', destination_id: provider.id, data_classes: ['content', 'product'], effect: 'allow_masked',
  }] });
  await assert.rejects(h.complete(), { code: 'EGRESS_BLOCKED' });
  await assert.rejects(h.complete({ ...analyze, categories: ['content', 'product'] }), { code: 'EGRESS_DENIED' });
  assert.equal(h.workspace.list('agent', 'ai_usage').length, 0);
});

test('OpenAI chat uses the purpose route and meters actual tokens before stopping at the budget', async () => {
  let calls = 0;
  const h = setup(async request => {
    calls++;
    assert.equal(request.operation, 'chat_completions');
    assert.equal(request.endpointRef, 'local_gateway');
    assert.equal(request.credentialRef, 'gateway_credential');
    assert.equal(request.workspaceId, 'workspace-1');
    assert.deepEqual(request.body, { model: 'mock-model', max_tokens: 20, messages: analyze.messages });
    return openAiAnswer;
  });
  const provider = await h.configure({ monthly_token_budget: 14, pricing: {
    input_minor_per_million: 1_000_000, output_minor_per_million: 2_000_000, cache_read_minor_per_million: 0,
  } });
  await h.route(provider);
  await h.allow(provider);
  assert.deepEqual(await h.run('model_availability', { purpose: 'analyze' }), { purpose: 'analyze', available: true });
  const result = await h.complete();
  assert.deepEqual(result, { content: 'Mock summary', model: 'mock-openai-v2', providerId: provider.id, toolCalls: [],
    usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 3, cost_estimate_minor: 15 } });
  const report = await h.run('model_usage', { provider_id: provider.id, purpose: 'analyze' });
  assert.equal(report.items[0].data.user_id, 'owner-1');
  assert.equal(report.items[0].data.model, 'mock-openai-v2');
  assert.equal(report.items[0].data.agent_job_id, null);
  assert.equal(h.workspace.list('ops', 'usage_event')[0]?.data.meter_key, 'model_tokens');
  assert.equal(h.workspace.list('ops', 'usage_event')[0]?.data.quantity, 14);
  assert.ok(h.workspace.events().some(event => event.event === 'agent.usage.budget_threshold_reached'));
  await assert.rejects(h.complete(), { code: 'MODEL_BUDGET_EXHAUSTED', status: 402 });
  assert.equal(calls, 1);
});

test('model calls stop before transport when Ops reports the license quota is reached', async () => {
  const h = setup(async () => assert.fail('the exhausted quota must stop transport'));
  const provider = await h.configure();
  await h.route(provider);
  await h.allow(provider);
  const client = createModelClient({ transport: async () => assert.fail('the exhausted quota must stop transport') });
  const withLimit: Commands = {
    complete: { roles: ['owner'], run: ctx => client.complete(Object.assign(ctx, {
      async opsUsageLimit(meterKey: string) {
        assert.equal(meterKey, 'model_tokens');
        return 0;
      },
    }), analyze) },
  };
  await assert.rejects(h.workspace.run(withLimit, 'complete'), { code: 'LICENSE_LIMIT', status: 402 });
  assert.equal(h.workspace.list('agent', 'ai_usage').length, 0);
});

test('adapters send tool definitions and results and return normalized tool calls', async () => {
  const tool = { name: 'lookup', inputSchema: { type: 'object' } };
  const args = { id: 'example' };
  const toolCall = { id: 'call-1', name: tool.name, arguments: args };
  for (const anthropic of [false, true]) {
    const h = setup(async request => {
      const body = request.body;
      const messages = body.messages as Record<string, unknown>[];
      assert.equal(request.operation, anthropic ? 'messages' : 'chat_completions');
      if (anthropic) {
        assert.deepEqual(body.output_config, { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } });
        assert.deepEqual(body.system, [{ type: 'text', text: 'Be concise', cache_control: { type: 'ephemeral' } }]);
        assert.deepEqual(messages.at(-1)?.content, [{ type: 'tool_result', tool_use_id: toolCall.id, content: 'Earlier tool response' }]);
        return { model: 'mock-messages', content: [{ type: 'tool_use', id: 'call-1', name: tool.name, input: args }],
          usage: { input_tokens: 5, output_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } };
      }
      assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' }, strict: true } });
      assert.equal(messages.at(-1)?.tool_call_id, toolCall.id);
      return { ...openAiAnswer, choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(args) } }] } }] };
    });
    const provider = await h.configure(anthropic ? { kind: 'anthropic_compatible', protocol: 'anthropic_messages',
      capabilities: { tools: true, structured_output: true, prompt_cache: true, effort: true } } : {});
    await h.route(provider, anthropic ? { max_tokens: 20, effort: 'high' } : undefined);
    await h.allow(provider);
    const result = await h.complete({ ...analyze, tools: [tool], responseSchema: { name: 'result', schema: { type: 'object' } },
      messages: [{ role: 'system', content: 'Be concise' }, ...analyze.messages, { role: 'assistant', content: '', toolCalls: [toolCall] },
        { role: 'tool', content: 'Earlier tool response', toolCallId: toolCall.id }],
    });
    assert.deepEqual(result.toolCalls, [toolCall]);
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.cache_read_tokens, 3);
  }
});

test('transport errors are sanitized and never trigger a different provider', async () => {
  let calls = 0;
  const h = setup(async () => { calls++; throw new Error('sensitive network details'); });
  const provider = await h.configure();
  await h.route(provider);
  await h.allow(provider);
  await assert.rejects(h.complete(), { code: 'MODEL_PROVIDER_ERROR', message: 'The configured model provider did not return a usable response' });
  assert.equal(calls, 1);
  assert.equal(h.workspace.list('agent', 'ai_usage').length, 0);
});
