import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { localDev, localOperations } from '../../tests/web-e2e/local-dev.mjs';
import { callSlot, exactWebMatch, nativeRelay } from './audit.mjs';

const directory = fileURLToPath(new URL('./', import.meta.url));
const output = await mkdtemp(join(directory, 'main-run-'));
const sandbox = await mkdtemp(join(tmpdir(), 'smartsell-main-agent-'));
const save = (name, data) => writeFile(join(output, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const config = join(sandbox, 'mcp.json');
await writeFile(config, JSON.stringify({ mcpServers: { matrix: {
  type: 'http', url: '${SMARTSELL_MAIN_ORIGIN}/mcp', headers: { Authorization: 'Bearer ${SMARTSELL_MAIN_TOKEN}' },
} } }), { mode: 0o600 });
process.env.SMARTSELL_E2E_PREVIEW = '1';
console.log(`Main evidence directory ${output}`);

function modelResponse(response, model, content, stream, toolPhase) {
  const stop_reason = toolPhase ? 'tool_use' : 'end_turn';
  const message = { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', model, content, stop_reason,
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!stream) return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
  const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    ...content.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: toolPhase ? { ...block, input: {} } : { ...block, text: '' } },
      { type: 'content_block_delta', index, delta: toolPhase ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index },
    ]), { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  response.writeHead(200, { 'content-type': 'text/event-stream' })
    .end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

async function terminal(origin, grant, cases) {
  const relay = await nativeRelay({ origin, token: grant.token }, cases);
  const prefix = 'mcp__matrix__';
  const names = [...new Set(cases.map(item => prefix + item.name))];
  const model = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || new URL(request.url, origin).pathname !== '/v1/messages') return response.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString());
      const toolPhase = !body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
      if (toolPhase) assert(names.every(name => body.tools?.some(tool => tool.name === name)), 'Expected tools missing from native discovery');
      const content = toolPhase ? cases.map(item => ({ type: 'tool_use', id: `toolu_${randomUUID()}`, name: prefix + item.name, input: item.arguments }))
        : [{ type: 'text', text: 'Local fixture calls completed.' }];
      modelResponse(response, body.model, content, body.stream, toolPhase);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } }));
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  try {
    const child = spawn('claude', ['--bare', '--print', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', config,
      '--tools', '', '--allowedTools', names.join(','), '--model', 'claude-opus-5-5', '--max-turns', String(cases.length + 2),
      '--output-format', 'stream-json', '--verbose', 'Run the specified SmartSell tools on the isolated local fixture.'], {
      cwd: sandbox, env: { PATH: process.env.PATH, HOME: sandbox, TMPDIR: sandbox,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`, ANTHROPIC_API_KEY: 'local-fixture-only',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false', SMARTSELL_MAIN_ORIGIN: relay.origin,
        SMARTSELL_MAIN_TOKEN: grant.token }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000,
    });
    const exit = once(child, 'close');
    const use = new Map();
    const results = new Map();
    let sessionId;
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init') sessionId = event.session_id;
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use' && names.includes(block.name)) {
          use.set(block.id, callSlot(cases, block.name.slice(prefix.length), block.input).id);
        }
        if (block.type === 'tool_result' && use.has(block.tool_use_id)) {
          const caseId = use.get(block.tool_use_id);
          assert(!results.has(caseId), 'Repeated native tool result');
          results.set(caseId, { toolUseId: block.tool_use_id, isError: block.is_error === true });
        }
      }
    }
    assert.deepEqual(await exit, [0, null]);
    assert.deepEqual(relay.failures, []);
    assert.equal(relay.calls.length, cases.length);
    assert.equal(results.size, cases.length);
    return cases.map(item => {
      const calls = relay.calls.filter(call => call.caseId === item.id);
      assert.equal(calls.length, 1);
      return { transport: 'native terminal Agent', sessionId, ...calls[0], ...results.get(item.id) };
    });
  } finally {
    await Promise.all([relay.close(), new Promise(resolve => { model.close(resolve); model.closeAllConnections(); })]);
  }
}

async function exercise(runtime, dev, browser) {
  const commands = runtime === 'commands';
  const context = await browser.newContext();
  const api = context.request;
  const origin = dev.origin;
  let csrf;
  async function http(method, path, data) {
    const response = await api.fetch(origin + path, { method, data, headers: { Origin: origin,
      ...(csrf && { 'x-csrf-token': csrf }), ...(method !== 'GET' && { 'idempotency-key': randomUUID() }),
      ...(path === '/api/v1/setup' && { 'x-setup-token': dev.setupToken }) } });
    assert(response.ok(), `${method} ${path}: ${response.status()}`);
    return (await response.json()).data;
  }
  try {
    const session = await http('POST', '/api/v1/setup', { name: 'Main audit owner', workspaceName: 'Main audit fixture',
      email: 'main-audit@example.invalid', password: dev.password() });
    csrf = session.csrf_token;
    const actorId = session.user.id;
    const ws = session.workspaces[0].id;
    const rest = (method, path, data) => http(method, `/api/v1/workspaces/${ws}${path}`, data);
    const grant = commands ? await rest('POST', '/agent-connections', { client: 'claude_code', label: 'Main fixture', expires_days: 1 })
      : await rest('POST', '/tokens', { access: 'write' });
    const reader = await rest('POST', '/tokens', { access: 'read' });
    assert.notEqual(grant.id, reader.id);
    const auditPath = '/mcp-tool-calls';
    const canary = `private-audit-fixture-${randomUUID()}`;
    const a = await rest('POST', '/brands', { name: canary, slug: 'main-a' });
    const b = await rest('POST', '/brands', { name: 'Main audit B', slug: 'main-b' });
    const scope = commands ? {} : { workspace_id: ws };
    const request = (label, name, args, target, outcome = 'success', code) => ({
      id: randomUUID(), label, name, arguments: { ...scope, ...args }, target, outcome, code,
    });
    const read = (label, id, outcome, code) => request(label, 'workspace_brand_get', { params: { id } }, 'GET /brands/:id', outcome, code);
    const evidence = [];
    async function match(item, receipt, credentialId) {
      assert.equal(receipt.httpStatus, 200);
      assert.equal(receipt.isError, item.outcome !== 'success');
      const params = new URLSearchParams({ request_id: receipt.requestId, actor_id: actorId, credential_id: credentialId,
        tool: item.name, outcome: item.outcome });
      const cohort = await rest('GET', `${auditPath}?request_id=${receipt.requestId}`);
      const filtered = await rest('GET', `${auditPath}?${params}`);
      assert.deepEqual(filtered, cohort);
      const proof = exactWebMatch(receipt.requestId, cohort, { actorId, credentialId, name: item.name, target: item.target,
        outcome: item.outcome === 'success' ? 'success' : 'error', exactOutcome: item.outcome, code: item.code });
      assert.equal(proof.status, 'matched', `${runtime} ${item.label}: ${JSON.stringify(proof)}`);
      assert(!JSON.stringify(cohort).includes(canary));
      evidence.push({ label: item.label, ...receipt, audit: cohort[0] });
      return cohort[0];
    }
    async function native(cases, credential = grant) {
      const receipts = await terminal(origin, credential, cases);
      return Promise.all(cases.map((item, index) => match(item, receipts[index], credential.id)));
    }
    await native([read('read-a', a.id), read('read-b-same-tool-same-turn', b.id), read('business-failure', randomUUID(), 'failed', 'NOT_FOUND')]);
    await native([read('independent-grant-read', a.id)], reader);
    let write, checkEffect;
    if (commands) {
      write = request('write', 'workspace_brand_create', { idempotency_key: randomUUID(), body: { name: canary, slug: 'main-write' } }, 'POST /brands');
      checkEffect = async () => {
        const brands = (await rest('GET', '/brands')).filter(row => row.slug === 'main-write');
        assert.equal(brands.length, 1);
        assert.equal(brands[0].name, canary);
        assert.equal(brands[0].version, 1);
        return { count: brands.length, id: brands[0].id, version: brands[0].version };
      };
    } else {
      const made = await rest('POST', '/content-items', { brand_id: a.id, title: 'Main audit draft' });
      const item = made.item ?? made;
      const added = await rest('POST', `/content-items/${item.id}/variants`, { platform: 'facebook', market: 'US', format: 'text', body_markdown: 'Initial fixture.' });
      const variant = added.variant ?? added;
      write = request('write', 'content_autosave_variant', { params: { id: variant.id }, body: { body_markdown: canary, expected_version: variant.version },
        expected_version: variant.version, idempotency_key: randomUUID() }, 'PATCH /content-variants/:id');
      checkEffect = async () => {
        const result = await rest('GET', `/content-variants/${variant.id}`);
        const draft = result.variant ?? result;
        assert.equal(draft.version, variant.version + 1);
        assert.equal(draft.draft_doc.body, canary);
        return { count: 1, id: draft.id, version: draft.version };
      };
    }
    const [first] = await native([write]);
    const effect = await checkEffect();
    const [replay] = await native([{ ...write, id: randomUUID(), label: 'idempotent-replay' }]);
    assert.deepEqual(await checkEffect(), effect);
    assert.equal(first.replayed, undefined);
    assert.equal(replay.replayed, true);
    const direct = async (token, item) => {
      const response = await api.post(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: item.name, arguments: item.arguments } } });
      return { response, value: await response.text(), requestId: response.headers()['x-request-id'] };
    };
    const denied = { ...write, label: 'identified-read-grant-write-denial', outcome: 'denied', code: 'TOOL_UNAVAILABLE' };
    const denial = await direct(reader.token, denied);
    const decoded = JSON.parse(denial.value);
    await match(denied, { transport: 'direct MCP JSON-RPC', requestId: denial.requestId, httpStatus: denial.response.status(),
      isError: Boolean(decoded.error || decoded.result?.isError) }, reader.id);
    const store = await rest('POST', '/stores', { brand_id: a.id, provider: 'shopify', mode: 'import', name: 'Main local store',
      external_store_id: 'main-audit-shop', default_currency: 'USD', default_locale: 'en-US' });
    const product = await rest('POST', '/products', { store_id: store.id, title: 'Main local product', status: 'active' });
    const capability = request('unsupported-desktop-receipt', 'desktop_request_capability', {
      body: { capability: 'product_listing', product_id: product.id, store_id: store.id }, idempotency_key: randomUUID(),
    }, 'POST /desktop-capability-requests');
    const [unsupported] = await native([capability]);
    assert.equal(unsupported.status, 'unsupported');
    assert.deepEqual(await rest('GET', `${auditPath}?request_id=${unsupported.request_id}&status=unsupported`), [unsupported]);
    const wrongScope = await api.get(`${origin}/api/v1/workspaces/${randomUUID()}${auditPath}?request_id=${replay.request_id}`);
    assert([403, 404].includes(wrongScope.status()));
    const unauthenticated = await direct(dev.password(), read('unidentified', a.id));
    assert.equal(unauthenticated.response.status(), 401);
    assert.deepEqual(await rest('GET', `${auditPath}?request_id=${unauthenticated.requestId}`), []);
    const all = await rest('GET', auditPath);
    assert.equal(new Set(evidence.map(row => row.requestId)).size, evidence.length);
    assert.equal(new Set(evidence.map(row => row.audit.call_id)).size, evidence.length);
    assert.equal(all.length, evidence.length);
    const serialized = JSON.stringify(all);
    for (const secret of [canary, grant.token, reader.token, csrf, dev.setupToken]) assert(!serialized.includes(secret));
    await save(`${runtime}-terminal.json`, { workspace: ws, actorId, effect, crossWorkspaceStatus: wrongScope.status(),
      unidentified: { status: 401, requestId: unauthenticated.requestId, rows: 0 }, projectedRows: all.length, evidence });

    const page = await context.newPage();
    await page.goto(`${origin}/app/${ws}/agent`);
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: /MCP 工具審計|MCP tool audit/ }) });
    await expect(panel).toBeVisible();
    const browserRows = [];
    for (const { audit } of evidence) {
      await panel.locator('input[name=request_id]').fill(audit.request_id);
      await panel.locator('input[name=actor_id]').fill(actorId);
      await panel.locator('input[name=tool]').fill(audit.tool);
      await panel.locator('select[name=result]').selectOption(audit.status ? `status:${audit.status}` : `outcome:${audit.outcome}`);
      const response = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith(auditPath) && url.searchParams.get('request_id') === audit.request_id;
      });
      await panel.getByRole('button', { name: /^(查詢|Search)$/ }).click();
      assert.equal((await response).status(), 200);
      const row = panel.getByRole('listitem');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(audit.call_id);
      await expect(row).toContainText(audit.request_id);
      await expect(row).toContainText(audit.credential_id);
      await expect(row).not.toContainText(canary);
      if (audit.replayed) await expect(row).toHaveText(/已重播|Replayed/);
      browserRows.push({ requestId: audit.request_id, callId: audit.call_id, rows: 1, rendered: await row.innerText() });
    }
    await save(`${runtime}-web.json`, { route: `/app/${ws}/agent`, browserRows });
  } finally {
    await context.close();
  }
}

let browser;
try {
  const hash = async path => ({ path, sha256: createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex') });
  const chunks = await readdir(new URL('../../apps/web/dist/assets', import.meta.url));
  const assets = await Promise.all(['apps/web/dist/index.html', ...chunks.sort().map(name => `apps/web/dist/assets/${name}`)].map(hash));
  const sources = await Promise.all(['app.ts', 'extensions/mcp-streamable.ts', 'integration/command-mcp.ts', 'integration/mcp-call-audit.ts',
    'mcp.ts', 'operations.ts', 'operation-server.ts', 'server.ts'].map(name => hash(`apps/server/src/${name}`)));
  await save('build.json', { workspace: fileURLToPath(new URL('../../', import.meta.url)), node: process.version,
    server: 'main workspace TypeScript entrypoints launched through tsx', web: 'apps/web/dist (Vite preview)', assets, sources });
  browser = await chromium.launch();
  for (const [runtime, launcher] of [['commands', localDev], ['operations', localOperations]]) {
    await launcher({}, dev => exercise(runtime, dev, browser));
    console.log(`${runtime} terminal and built-Web audit checks passed`);
  }
} finally {
  await browser?.close();
  await rm(sandbox, { recursive: true, force: true });
}
