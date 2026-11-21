import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { configuration } from '../../apps/server/src/config.ts';

const operationsDatabase = process.env.SMARTSELL_AI02_OPERATIONS_DATABASE_URL;
const commandsDatabase = process.env.SMARTSELL_AI02_COMMANDS_DATABASE_URL;
const runWithPostgres = 'Run bash tests/acceptance/with-postgres.sh ai02';
const deadlineMs = 60_000;
const eventStream = 'text/event-stream';
async function fixture(t, database, runtime, start) {
  const tool = runtime === 'commands' ? 'jobs_get' : 'catalog_search';
  const url = new URL(database);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'app_rw');
  assert.equal(url.pathname, `/ai02_${runtime}`);

  const abort = new AbortController();
  const setupToken = randomBytes(32).toString('hex');
  const config = configuration({ DATABASE_URL: database, HOST: '127.0.0.1', ROLE: 'api,mcp', SETUP_TOKEN: setupToken,
    IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
  const app = await start({ ...config, port: 0 });
  t.after(async () => { abort.abort(); await app.close(); });
  const { port } = app.server.address();
  const origin = `http://127.0.0.1:${port}`;

  const send = (path, { method = 'GET', headers, body, signal } = {}) => fetch(origin + path, {
    method, signal: AbortSignal.any([abort.signal, signal ?? AbortSignal.timeout(10_000)]),
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function request(path, { status = 200, ...options } = {}) {
    const response = await send(path, options);
    const raw = await response.text();
    assert.equal(response.status, status, `${options.method ?? 'GET'} ${path}: ${response.status === status ? '' : raw}`);
    return { value: raw ? JSON.parse(raw) : undefined, headers: response.headers };
  }
  await request('/readyz');
  const credentials = { email: 'ai02-owner@example.invalid', password: 'acceptance-only-ai02-2026' };
  const setup = await request('/api/v1/setup', { method: 'POST', status: 201, headers: { 'x-setup-token': setupToken },
    body: { ...credentials, name: 'Owner', workspaceName: 'AI02' } });
  const login = await request('/api/v1/login', { method: 'POST', body: credentials });
  const { user, workspaces: [{ id: workspaceId }] } = setup.value.data;
  assert.equal(login.value.data.user.id, user.id);
  assert.equal(login.value.data.workspaces[0].id, workspaceId);
  const session = ({ headers, value }) => ({ cookie: headers.get('set-cookie').split(';')[0], 'x-csrf-token': value.data.csrf_token });
  const first = session(setup);
  const survivor = session(login);
  assert.notEqual(first.cookie, survivor.cookie);
  const root = `/api/v1/workspaces/${workspaceId}`;
  const issue = async (headers, tools = [tool]) => (await request(`${root}/tokens`, { method: 'POST', headers, status: 201,
    body: { access: 'read', tools } })).value.data;
  const revoke = (headers, id) => request(`${root}/tokens/${id}`, { method: 'DELETE', headers, status: 204 });
  const listTools = async (headers, status = 200) => {
    const { value, headers: responseHeaders } = await request('/mcp', { method: 'POST', status,
      headers: { ...headers, accept: `application/json, ${eventStream}`, 'mcp-protocol-version': '2025-06-18' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
    if (status === 401) assert.match(responseHeaders.get('www-authenticate'), /^Bearer\b/);
    else {
      assert.equal(value.id, 1);
      assert.deepEqual(value.result.tools.map(item => item.name), [tool]);
    }
  };
  async function open(path, headers, status = 200) {
    const response = await send(path, { headers: { ...headers, accept: eventStream }, signal: t.signal });
    assert.equal(response.status, status, `GET ${path}`);
    if (status !== 200) {
      await response.body?.cancel();
      return;
    }
    assert.match(response.headers.get('content-type'), /^text\/event-stream\b/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function frame() {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const value = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return value;
        }
        const { done, value } = await reader.read();
        if (done) {
          assert.equal(buffer, '', `Incomplete SSE frame on ${path}`);
          return null;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    }
    assert.match(await frame(), /^: connected\n/);
    return { path, frame };
  }
  return { request, root, first, survivor, user, issue, revoke, listTools, open };
}

const bearer = pat => ({ authorization: `Bearer ${pat.token}` });

async function waitForFrame(stream, pattern) {
  for (;;) {
    const frame = await stream.frame();
    assert.notEqual(frame, null, `Stream ${stream.path} closed while waiting for ${pattern}`);
    if (pattern.test(frame)) return frame;
  }
}

async function closedWithinDeadline(t, stream, since, label) {
  await waitForClose(stream);
  const elapsed = Math.ceil(performance.now() - since);
  assert.ok(elapsed <= deadlineMs, `${label} took ${elapsed} ms to close`);
  t.diagnostic(`${label} reached EOF in ${elapsed} ms from revocation request start (limit ${deadlineMs} ms)`);
}

async function waitForClose(stream) {
  while (await stream.frame() !== null) { /* Read through frames buffered before revocation. */ }
}

test('[AI02-OPERATIONS] PostgreSQL closes established workspace SSE and MCP on PAT revocation and preserves the other session',
  { skip: !operationsDatabase && runWithPostgres, timeout: 85_000 }, async t => {
    const { startKernel } = await import('../../apps/server/src/integration/kernel-runtime.ts');
    const s = await fixture(t, operationsDatabase, 'operations', startKernel);
    const streamPath = `${s.root}/stream`;
    const revoked = await s.issue(s.first);
    const retained = await s.issue(s.survivor);
    const [workspacePat, mcpPat, workspaceCookie, workspaceSurvivor, mcpSurvivor] = await Promise.all([
      s.open(streamPath, bearer(revoked)), s.open('/mcp', bearer(revoked)), s.open(streamPath, s.first),
      s.open(streamPath, s.survivor), s.open('/mcp', bearer(retained)),
    ]);
    const createBrand = slug => s.request(`${s.root}/brands`, { method: 'POST', headers: s.survivor, body: { slug, name: slug } });
    const changed = /^id: (\d+)\nevent: workspace\.changed\ndata: \{"type":"workspace\.changed"\}$/;
    const { value: { data: brandA } } = await createBrand('before-revocation');
    const [, , baseline] = await Promise.all([
      waitForFrame(workspacePat, changed), waitForFrame(workspaceCookie, changed), waitForFrame(workspaceSurvivor, changed),
      waitForFrame(mcpPat, /^: heartbeat$/), waitForFrame(mcpSurvivor, /^: heartbeat$/),
      s.listTools(bearer(revoked)), s.listTools(bearer(retained)),
    ]);

    const revokeStarted = performance.now();
    await s.revoke(s.first, revoked.id);
    await Promise.all([
      closedWithinDeadline(t, workspacePat, revokeStarted, 'Operations workspace PAT stream'),
      closedWithinDeadline(t, mcpPat, revokeStarted, 'Operations MCP PAT stream'),
      s.open(streamPath, bearer(revoked), 401), s.open('/mcp', bearer(revoked), 401), s.listTools(bearer(revoked), 401),
    ]);

    const logoutStarted = performance.now();
    await s.request('/api/v1/logout', { method: 'POST', headers: s.first, status: 204 });
    await Promise.all([
      closedWithinDeadline(t, workspaceCookie, logoutStarted, 'Operations workspace cookie stream'),
      s.open(streamPath, s.first, 401),
    ]);

    const session = await s.request('/api/v1/session', { headers: s.survivor });
    assert.equal(session.value.data.user.id, s.user.id);
    const { value: { data: brandB } } = await createBrand('after-revocation');
    const next = await waitForFrame(workspaceSurvivor, changed);
    assert.ok(Number(changed.exec(next)[1]) > Number(changed.exec(baseline)[1]));
    await waitForFrame(mcpSurvivor, /^: heartbeat$/);
    await s.listTools(bearer(retained));
    t.diagnostic('Operations revoked PAT workspace GET, MCP GET and tools/list returned 401. Logged-out workspace GET returned 401. The same user’s second session returned 200, its existing workspace stream delivered a newer revision, and its retained PAT delivered an MCP heartbeat and tools/list 200.');

    await t.test('AI03 PostgreSQL Agent search and MCP resources use the selected brand and approved revision', async () => {
      const data = async (path, options) => (await s.request(`${s.root}${path}`, options)).value.data;
      const write = (path, body, version) => data(path, { method: 'POST', body, headers: {
        ...s.survivor, ...(version !== undefined && { 'if-match': String(version) }),
      } });
      const knowledge = [];
      for (const brand of [brandA, brandB]) {
        const entry = await write('/knowledge', { brand_id: brand.id, kind: 'tone', title: 'Shared keyword', body: `approved ${brand.slug}` });
        const revision = entry.knowledge_revision;
        const approved = await write(`/knowledge-revisions/${revision.id}/approve`, {}, revision.version);
        await write(`/knowledge/${entry.id}/revisions`, { body: `draft ${brand.slug}` }, approved.version);
        knowledge.push({ brand, revision });
      }
      const pat = await s.issue(s.survivor, ['knowledge_get_context', 'agent_preview_context']);
      const headers = { ...bearer(pat), accept: `application/json, ${eventStream}` };
      const rpc = async (method, params) => (await s.request('/mcp', { method: 'POST', headers,
        body: { jsonrpc: '2.0', id: 1, method, params } })).value.result;
      const workspace = s.root.split('/').at(-1);
      for (const { brand, revision } of knowledge) {
        const path = `/brands/${brand.id}/agent-context`;
        const cookie = { headers: s.survivor };
        const preview = await data(`${path}?q=approved`, cookie);
        assert.equal(preview.brand_id, brand.id);
        assert.deepEqual(preview.items.map(item => [item.revision_id, item.revision_no, item.body]), [[revision.id, 1, revision.body]]);
        assert.deepEqual((await data(`${path}?q=draft`, cookie)).items, []);
        const other = knowledge.find(row => row.brand.id !== brand.id);
        assert.deepEqual((await data(`${path}?q=${other.brand.slug}`, cookie)).items, []);
        const tool = await rpc('tools/call', { name: 'agent_preview_context', arguments: {
          workspace_id: workspace, params: { brandId: brand.id }, query: { q: 'approved' },
        } });
        assert.deepEqual(tool.structuredContent.data, preview);
        const resource = await rpc('resources/read', { uri: `smartsell://workspaces/${workspace}/brands/${brand.id}/knowledge` });
        assert.deepEqual(JSON.parse(resource.contents[0].text).data.items, preview.items);
      }
    });
  });

test('[AI02-COMMANDS] PostgreSQL closes established MCP on PAT revocation and preserves the other session',
  { skip: !commandsDatabase && runWithPostgres, timeout: 85_000 }, async t => {
    const { start } = await import('../../apps/server/src/bootstrap.ts');
    const s = await fixture(t, commandsDatabase, 'commands', start);
    const revoked = await s.issue(s.first);
    const retained = await s.issue(s.survivor);
    const [mcpPat, mcpSurvivor] = await Promise.all([s.open('/mcp', bearer(revoked)), s.open('/mcp', bearer(retained))]);
    await Promise.all([
      waitForFrame(mcpPat, /^: heartbeat$/), waitForFrame(mcpSurvivor, /^: heartbeat$/),
      s.listTools(bearer(revoked)), s.listTools(bearer(retained)),
    ]);
    const started = performance.now();
    await s.revoke(s.first, revoked.id);
    await Promise.all([
      closedWithinDeadline(t, mcpPat, started, 'Commands MCP PAT stream'),
      s.open('/mcp', bearer(revoked), 401), s.listTools(bearer(revoked), 401),
    ]);
    await s.request('/api/v1/logout', { method: 'POST', headers: s.first, status: 204 });
    await s.request('/api/v1/session', { headers: s.first, status: 401 });
    const session = await s.request('/api/v1/session', { headers: s.survivor });
    assert.equal(session.value.data.user.id, s.user.id);
    await waitForFrame(mcpSurvivor, /^: heartbeat$/);
    await s.listTools(bearer(retained));
    t.diagnostic('Commands revoked PAT MCP GET and tools/list returned 401. Logged-out session returned 401. The same user’s second session returned 200 and its retained PAT delivered an MCP heartbeat and tools/list 200.');
  });
