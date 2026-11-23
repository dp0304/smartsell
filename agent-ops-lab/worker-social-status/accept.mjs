import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { configuration } from '../../apps/server/src/config.ts';
import { start } from '../../apps/server/src/bootstrap.ts';
import { runFixture } from './worker.mjs';
import { openWeb } from './web.mjs';

const options = new Set(process.argv.slice(2));
assert([...options].every(flag => ['--baseline', '--native', '--native-offline'].includes(flag)) && options.size <= 1);
const offline = options.has('--native-offline');
const native = options.has('--native') || offline;
const baseline = options.has('--baseline');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const temp = realpathSync(await mkdtemp(join(tmpdir(), 'worker-social-status-')));
const prompts = ['我的产品是一个独立站 makemylure.com 然后我社媒是 x 上面发布视频，你看看现有的发布', '获取我的社媒状态'];
const names = ['worker_social_status_request', 'worker_social_status_get'];
const evidence = { schema: 1, run: offline ? 'native-offline' : native ? 'native-codex' : baseline ? 'baseline' : 'fixture', started_at: new Date().toISOString(), checks: [], events: [], protocol: [], canary: {} };
const aliases = new Map();
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const identifier = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const enumValue = /^(verified|login_required|identity_mismatch|unverified|unsupported|pending|queued|running|requested|leased|completed|blocked|expired|failed|succeeded|online|account_status|recent_posts|x|twitter|tiktok|instagram|facebook|youtube|zhihu|douyin|kuaishou|weibo|xiaohongshu|bilibili|wechat_channels|linkedin|threads|SOCIAL_STATUS_[A-Z_]+|WORKER_[A-Z_]+|FORBIDDEN|NOT_FOUND|DEVICE_[A-Z_]+|INVALID_DEVICE_PROOF)$/;
function redact(value, key = '') {
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([field]) => !/^(token|fencing_token|lease_token|cookie|authorization|signature|nonce|password|public_key|proof|pairing_code|_meta)$/i.test(field)).map(([field, item]) => [field, redact(item, field)]));
  }
  if (typeof value !== 'string') return value;
  if (identifier.test(value)) {
    if (!aliases.has(value)) aliases.set(value, `id-${aliases.size + 1}`);
    return aliases.get(value);
  }
  if ((key.endsWith('_id') || key === 'id' || key === 'reqId') && /^[\w-]{8,160}$/.test(value)) {
    if (!aliases.has(value)) aliases.set(value, `id-${aliases.size + 1}`);
    return aliases.get(value);
  }
  if (timestamp.test(value) || enumValue.test(value) || names.includes(value) || ['worker_social_status_report', 'success', 'denied', 'claimed', 'xhs', 'reddit', 'TOOL_UNAVAILABLE'].includes(value) || (key === 'id' && /^100[12]$/.test(value)) || /^fixture_(?:angler|video|plain)(?:_\d+)?$/.test(value) || /^https:\/\/x\.com\/fixture_angler\/status\/100[12]$/.test(value)) return value;
  return '[redacted]';
}
const record = (name, data = {}) => {
  evidence.checks.push({ name, ...data });
  console.log(`${name} ${JSON.stringify(data)}`);
};
const bodyOf = async response => {
  const raw = await response.text();
  if (!raw) return null;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const event = raw.split('\n').find(line => line.startsWith('data: '));
    return event ? JSON.parse(event.slice(6)) : null;
  }
  return JSON.parse(raw);
};
const responseData = value => value?.structuredContent ?? value;
const canaryTools = ['local_browser_open', 'local_web_search'];
const counters = { lists: 0, calls: [], requests: [] };
const toolName = name => typeof name === 'string' && /^[\w.-]{1,120}$/.test(name) ? name : '[redacted]';
const protocolMethod = method => ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'].includes(method) ? method : toolName(method);
const canary = createServer(async (req, res) => {
  try {
    const raw = Buffer.concat(await Array.fromAsync(req));
    if (req.method !== 'POST') return res.writeHead(405).end();
    const { id, method, params } = JSON.parse(raw);
    counters.requests.push(protocolMethod(method));
    if (id === undefined) return res.writeHead(202).end();
    let result = {};
    if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-canary', version: '1' } };
    if (method === 'tools/list') {
      counters.lists++;
      result = { tools: canaryTools.map(name => ({ name, description: name === 'local_browser_open' ? 'Open a URL with the local browser and return page observations.' : 'Search the web with the local search provider.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })) };
    }
    if (method === 'tools/call') {
      counters.calls.push(toolName(params.name));
      result = { isError: true, content: [{ type: 'text', text: 'Offline canary. No external requests were sent.' }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  } catch { res.writeHead(400).end(); }
});
const unixListen = server => new Promise((ok, fail) => { server.on('error', fail); server.listen(0, '127.0.0.1', () => ok(server.address().port)); });
const stop = server => new Promise(ok => { if (!server.listening) return ok(); server.close(ok); server.closeAllConnections(); });
let app, relay, modelRelay, owner, workspace, token, conn, base, mcpUrl, productWorker, web;
const tools = new Map();
async function request(path, { method = 'GET', body, headers = owner } = {}) {
  const response = await fetch(`${base}${path}`, { method, redirect: 'error', headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json', 'idempotency-key': randomUUID() }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, headers: response.headers, body: await bodyOf(response) };
}
async function workspaceOp(path, options) {
  return request(`/api/v1/workspaces/${workspace}${path}`, options);
}
async function rpc(method, params = {}, auth = token) {
  const response = await fetch(mcpUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth && { authorization: `Bearer ${auth}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: randomUUID() }) });
  return { status: response.status, body: await bodyOf(response) };
}
const browserBlocked = new Set(['command_execution', 'web_search', 'dynamic_tool_call', 'local_web_search', 'local_browser_open']);
function offlineDetail(message) {
  if (!offline || typeof message !== 'string') return undefined;
  const clean = message.replaceAll(temp, '[temp]').replace(/https?:\/\/[^\s`"')]+/g, '[url]')
    .replace(/ss_command_[\w.-]+|Bearer\s+[\w.-]+/gi, '[credential]');
  return /^[\w\s .:;,()'"`=<>?!/\[\]_-]{1,500}$/.test(clean) ? clean : undefined;
}
function capture(line, promptIndex) {
  try {
    const event = JSON.parse(line);
    const item = event.item;
    const baseEvent = { prompt: promptIndex, type: toolName(event.type) };
    if (!item) {
      evidence.events.push({ ...baseEvent, ...(event.type === 'error' || event.type === 'turn.failed' ? { detail: classify(event.message ?? event.error?.message ?? ''), offline_detail: offlineDetail(event.message ?? event.error?.message) } : {}) });
      return;
    }
    const entry = { ...baseEvent, item: toolName(item.type), id: toolName(item.id), server: item.server && toolName(item.server), tool: item.tool && toolName(item.tool), status: item.status && toolName(item.status) };
    if (item.type === 'mcp_tool_call') Object.assign(entry, { arguments: redact(item.arguments), result: redact(item.result), error: item.error && classify(JSON.stringify(item.error)) });
    if (item.type === 'agent_message') {
      // Keep the authentic reply when it contains no credential-like text or non-fixture destinations.
      const text = item.text ?? '';
      const safe = text.replace(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/gi, id => redact(id));
      entry.text = /ss_command_|Bearer\s|api.?key|eyJ[\w-]{20}|https?:\/\/(?!(?:x\.com\/fixture_angler\/status\/100[12]|makemylure\.com(?:[\s/]|$)))/i.test(safe) ? '[redacted]' : safe;
    }
    if (item.type === 'error') Object.assign(entry, { detail: classify(item.message ?? ''), offline_detail: offlineDetail(item.message) });
    if (browserBlocked.has(item.type)) entry.direct_tool = true;
    evidence.events.push(entry);
  } catch { evidence.events.push({ prompt: promptIndex, type: 'invalid_json_line' }); }
}
function classify(text) {
  const statuses = [...new Set(String(text).match(/\b(?:400|401|403|404|422|429|500|502|503|504)\b/g) ?? [])];
  if (statuses.length) return { http_statuses: statuses.map(Number) };
  for (const kind of ['sandbox_apply', 'posix_spawn', 'error while loading', 'timed out', 'authentication', 'credentials', 'not supported', 'connection refused', 'operation not permitted', 'permission denied', 'mcp startup', 'handshak', 'websocket', 'local_canary', 'smartsell', 'model', 'sandbox']) {
    if (String(text).toLowerCase().includes(kind)) return { kind };
  }
  return { kind: 'unclassified' };
}

async function launch(command, args, { env, cwd, onLine, deadline = 90_000 }) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let partial = '', stderr = '', expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    }, deadline);
    child.stdout.setEncoding('utf8').on('data', data => {
      partial += data;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) if (line) onLine?.(line);
    });
    child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-32768); });
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('close', (exit, signal) => {
      clearTimeout(timer);
      if (partial) onLine?.(partial);
      const diagnostic = stderr.split('\n').map(line => line.replaceAll(temp, '[temp]').replaceAll(homedir(), '[home]'))
        .filter(line => /^(?:error|warning|sandbox-exec|failed|operation not permitted)[\w -]*[:(]/i.test(line))
        .map(line => line.match(/(?:failed|unable|could not|cannot) to [a-z ]{3,70}|(?:open|execve|sandbox_apply|posix_spawn|permission denied|operation not permitted|os error \d+)/gi)?.join(' / ') ?? '[redacted]').slice(0, 5);
      ok({ exit, signal, expired, ...(stderr && { stderr: { ...classify(stderr), ...(exit && diagnostic.length && { diagnostic }) } }) });
    });
  });
}

async function nativeMcpStatus(codex, profile, env, cwd) {
  const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, codex, 'app-server', '--listen', 'stdio://'], {
    env, cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const socket = createInterface({ input: child.stdout });
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.on('error', () => {});
  try {
    return await new Promise((ok, fail) => {
      const timer = setTimeout(() => ok({ timed_out: true }), 15_000);
      child.on('error', error => { clearTimeout(timer); fail(error); });
      child.on('exit', exit => { clearTimeout(timer); ok({ exit }); });
      socket.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'mcpServerStatus/list', params: {} });
        }
        if (message.id !== 2) return;
        clearTimeout(timer);
        const servers = (message.result?.data ?? []).filter(row => ['smartsell', 'local_canary'].includes(row.name)).map(row => ({
          server: row.name, tools: Object.keys(row.tools ?? {}).filter(name => [...canaryTools, ...names].includes(name)),
        }));
        ok({ servers, error_code: message.error?.code });
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'worker-social-status-acceptance', version: '1' } } });
    });
  } finally {
    socket.close();
    child.stdin.end();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      await new Promise(ok => child.once('close', ok));
    }
  }
}

async function runNative() {
  const home = homedir();
  const codex = process.env.SOCIAL_STATUS_CODEX ?? join(home, '.nvm/versions/node/v22.17.0/bin/codex');
  const model = offline ? 'gpt-5' : process.env.SOCIAL_STATUS_MODEL;
  const modelUrl = offline ? null : new URL(process.env.SOCIAL_STATUS_MODEL_ORIGIN ?? 'http://127.0.0.1:3425/backend-api/codex');
  assert(model && /^[\w./-]+$/.test(model), 'Set SOCIAL_STATUS_MODEL to the configured model');
  assert(!modelUrl || (modelUrl.protocol === 'http:' && modelUrl.hostname === '127.0.0.1' && modelUrl.port && !modelUrl.username && !modelUrl.password && !modelUrl.search && !modelUrl.hash), 'Use the approved loopback model proxy');
  const actualHome = resolve(process.env.CODEX_HOME ?? join(home, '.codex'));
  const state = join(temp, 'codex');
  const project = join(temp, 'plain-directory');
  const fakeHome = join(temp, 'user');
  await Promise.all([mkdir(state), mkdir(project), mkdir(fakeHome)]);
  const authFile = join(actualHome, 'auth.json');
  const reuseAuth = !offline && process.env.SOCIAL_STATUS_REUSE_CODEX_AUTH === '1';
  if (reuseAuth) await symlink(authFile, join(state, 'auth.json'));
  const catalog = !offline && process.env.SOCIAL_STATUS_MODEL_CATALOG;
  const canaryPort = await unixListen(canary);
  const upstream = modelUrl?.href.replace(/\/$/, '');
  const modelTraffic = [];
  modelRelay = createServer(async (req, res) => {
    const endpoint = ['/responses', '/models'].find(path => req.url.split('?')[0] === path);
    if (offline) {
      modelTraffic.push({ endpoint: endpoint ?? 'other', method: req.method, status: 401, fixture: true });
      return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"Offline model endpoint deliberately unavailable"}}');
    }
    if (req.method !== (endpoint === '/responses' ? 'POST' : 'GET') || !endpoint) return res.writeHead(404).end();
    try {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'proxy-connection'].includes(key)));
      const response = await fetch(`${upstream}${endpoint}`, { method: req.method, headers, redirect: 'error',
        ...(req.method === 'POST' && { body: Buffer.concat(await Array.fromAsync(req)) }), signal: AbortSignal.timeout(90_000) });
      modelTraffic.push({ endpoint, status: response.status });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch { modelTraffic.push({ endpoint, status: 502 }); if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  const modelPort = await unixListen(modelRelay);
  const q = JSON.stringify;
  await writeFile(join(state, 'config.toml'), `model = ${q(model)}\nmodel_provider = "acceptance_model"\nweb_search = "disabled"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\napproval_policy = "never"\n${catalog ? `model_catalog_json = ${q(catalog)}\n` : ''}\n[model_providers.acceptance_model]\nname = "Acceptance model"\nbase_url = ${q(`http://127.0.0.1:${modelPort}`)}\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n${reuseAuth ? 'requires_openai_auth = true' : offline || process.env.SOCIAL_STATUS_MODEL_API_KEY ? 'env_key = "OPENAI_API_KEY"' : ''}\n`, { mode: 0o600 });
  const profile = join(temp, 'codex.sb');
  const reads = [dirname(dirname(process.execPath)), dirname(dirname(codex)), temp];
  if (catalog) reads.push(catalog);
  if (reuseAuth) reads.push(authFile);
  await writeFile(profile, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read-data (subpath ${q(home)}) (subpath ${q(root)}))\n(deny file-write*)\n(allow file-write* (subpath ${q(temp)}) (literal "/dev/null"))\n(deny file-write* (literal ${q(authFile)}))\n(allow file-read-data ${reads.map(path => `(subpath ${q(path)})`).join(' ')})\n(allow network-outbound ${[mcpUrl, `http://127.0.0.1:${canaryPort}`, `http://127.0.0.1:${modelPort}`].map(url => `(remote ip "localhost:${new URL(url).port}")`).join(' ')})\n`, { mode: 0o600 });
  const env = { HOME: fakeHome, CODEX_HOME: state, SMARTSELL_TOKEN: token, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temp, NO_PROXY: '127.0.0.1,localhost' };
  if (offline) env.OPENAI_API_KEY = 'offline-fixture-placeholder';
  else if (process.env.SOCIAL_STATUS_MODEL_API_KEY) env.OPENAI_API_KEY = process.env.SOCIAL_STATUS_MODEL_API_KEY;
  const cli = (args, extras = {}) => launch('/usr/bin/sandbox-exec', ['-f', profile, codex, ...args], { cwd: project, env, ...extras });
  const install = [];
  for (const [server, url, credentials] of [['smartsell', mcpUrl, ['--bearer-token-env-var', 'SMARTSELL_TOKEN']], ['local_canary', `http://127.0.0.1:${canaryPort}/mcp`, []]]) {
    const result = await cli(['mcp', 'add', server, '--url', url, ...credentials], { deadline: 10_000 });
    install.push({ server, ...result });
  }
  record('native_configured', { executable: basename(codex), node: process.version, empty_project: true, install });
  evidence.model = modelTraffic;
  evidence.canary = { tools: canaryTools, self_test: false, native: [] };
  assert(install.every(row => row.exit === 0), 'Native MCP registration failed');
  for (const name of canaryTools) {
    const selfTest = await fetch(`http://127.0.0.1:${canaryPort}/mcp`, { method: 'POST', body: JSON.stringify({ id: 1, method: 'tools/call', params: { name } }) });
    assert.equal(selfTest.status, 200);
  }
  assert.deepEqual(counters.calls.splice(0), canaryTools);
  evidence.canary.self_test = true;
  if (offline) {
    const status = await nativeMcpStatus(codex, profile, env, project);
    record('native_app_server_discovery', status);
  }
  for (const [index, prompt] of prompts.entries()) {
    const protocolStart = evidence.protocol.length;
    const { lists } = counters;
    const calls = counters.calls.length;
    const canaryRequests = counters.requests.length;
    const result = await cli(['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'read-only', '--', prompt], { deadline: offline ? 15_000 : 90_000, onLine: line => capture(line, index + 1) });
    const canaryRow = { prompt: index + 1, lists: counters.lists - lists, calls: counters.calls.slice(calls), requests: counters.requests.slice(canaryRequests) };
    evidence.canary.native.push(canaryRow);
    const items = evidence.events.filter(row => row.prompt === index + 1);
    const workerCalls = evidence.protocol.slice(protocolStart).filter(row => row.method === 'tools/call');
    record('native_prompt', { prompt: index + 1, ...result, canary: canaryRow, direct: items.filter(item => item.direct_tool).length,
      protocol_start: protocolStart, protocol_end: evidence.protocol.length, tools: workerCalls.map(row => row.tool), completed: items.some(row => row.type === 'turn.completed') });
  }
}

try {
  // No inherited server credentials, state filenames, production hosts, or providers.
  for (const key of Object.keys(process.env)) {
    if (/^(SMARTSELL_|APP_SECRET$|IDENTITY_ENCRYPTION_KEY$|DATABASE_URL$|BACKGROUND_DATABASE_URL$|PORTAL_)/.test(key)) delete process.env[key];
  }
  const setupToken = randomBytes(32).toString('hex');
  const config = configuration({ ROLE: 'all', HOST: '127.0.0.1', SETUP_TOKEN: setupToken, SMARTSELL_DATA_FILE: join(temp, 'state.sqlite'), SMARTSELL_WORKER_DOWNLOAD_DIR: temp });
  app = await start({ ...config, roles: new Set(['api', 'mcp']), port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await request('/healthz')).status, 200);
  const setup = await request('/api/v1/setup', { method: 'POST', headers: { 'x-setup-token': setupToken }, body: { username: 'fixture-owner', name: 'Fixture Owner', workspaceName: 'Social Status Fixture', password: randomBytes(24).toString('base64url') } });
  assert.equal(setup.status, 201, 'owner setup');
  workspace = setup.body.data.workspaces[0].id;
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const csrf = await request('/api/v1/session/csrf', { headers: { cookie } });
  owner = { cookie, 'x-csrf-token': csrf.body.csrf_token };
  const connection = await workspaceOp('/agent-connections', { method: 'POST', body: { client: 'codex', label: 'Native Codex Fixture' } });
  assert.equal(connection.status, 201, 'Agent connection');
  ({ id: conn, token } = connection.body.data);
  relay = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') return res.writeHead(405).end();
    try {
      const raw = Buffer.concat(await Array.fromAsync(req));
      const { method, params } = JSON.parse(raw);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)));
      const row = { route: 'mcp', method: protocolMethod(method), tool: params?.name && toolName(params.name), args: redact(params?.arguments) };
      evidence.protocol.push(row);
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: raw, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      row.http = response.status;
      const text = await response.text();
      const decoded = await bodyOf(new Response(text || null, { headers: response.headers }));
      row.request_id = redact(response.headers.get('x-request-id'), 'reqId');
      if (method === 'tools/call') row.result = redact(responseData(decoded?.result) ?? decoded?.error ?? decoded);
      if (method === 'initialize') {
        const instructions = decoded?.result?.instructions ?? '';
        row.worker_instructions = names.every(name => instructions.includes(name)) && /do not fall back to local chrome/i.test(instructions);
      }
      if (method === 'tools/list') row.named_tools = decoded?.result?.tools?.map(tool => tool.name).filter(name => names.includes(name));
      res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([key]) => !['transfer-encoding', 'connection', 'content-length', 'content-encoding'].includes(key)))).end(text || undefined);
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  mcpUrl = `http://127.0.0.1:${await unixListen(relay)}/mcp`;
  const unauth = await rpc('tools/list', {}, '');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'social-status-contract', version: '1' } });
  const list = await rpc('tools/list');
  for (const tool of list.body?.result?.tools ?? []) tools.set(tool.name, tool);
  record('server_discovery', { unauthenticated_http: unauth.status, initialize_http: init.status, list_http: list.status, named: names.filter(name => tools.has(name)), missing: names.filter(name => !tools.has(name)), workspace: redact(workspace), connection: redact(conn) });
  assert.equal(unauth.status, 401);
  assert.equal(list.status, 200);
  if (!baseline && names.every(name => tools.has(name))) {
    assert(evidence.protocol.some(row => row.method === 'initialize' && row.worker_instructions), 'Missing product Worker-only MCP instructions');
    const webConfirm = async (task, reportRequest) => {
      web ??= await openWeb({ base, cookie, temp, workspace });
      await web.confirm(task, reportRequest);
    };
    productWorker = await runFixture({ base, workspace, workspaceOp, rpc, record, redact, protocol: evidence.protocol, native, webConfirm });
  }
  if (native) await runNative();
  if (offline) {
    const cases = evidence.checks.filter(row => row.name === 'native_prompt');
    assert.equal(cases.length, 2);
    for (const entry of cases) {
      const traffic = evidence.protocol.slice(entry.protocol_start, entry.protocol_end);
      assert(!entry.completed && entry.canary.lists > 0 && !entry.canary.calls.length && !entry.direct);
      assert(traffic.some(row => row.method === 'tools/list' && names.every(name => row.named_tools?.includes(name))));
      assert(traffic.some(row => row.method === 'initialize' && row.worker_instructions));
      assert(evidence.events.some(row => row.prompt === entry.prompt && row.type === 'turn.failed' && row.detail?.http_statuses?.includes(401)));
    }
    assert.equal(evidence.model.filter(row => row.fixture && row.method === 'POST' && row.status === 401).length, prompts.length);
    record('offline_cli_transport_verified', { real_model: false, task_selection_verified: false });
  } else if (native && productWorker?.verify) await productWorker.verify(evidence);
  if (!baseline) assert(names.every(name => tools.has(name)), 'Named MCP tools missing from current checkout');
  assert(!baseline || names.some(name => !tools.has(name)), 'Baseline gap is no longer present');
  evidence.outcome = offline ? 'cli-transport-only' : baseline ? 'gap-reproduced' : 'passed';
} catch (error) {
  evidence.outcome = 'failed';
  const source = String(error?.stack).split('\n').slice(1).map(line => line.match(/([\w-]+\.(?:mjs|ts)):(\d+):(\d+)/)?.slice(1).join(':')).filter(Boolean).slice(0, 4);
  const message = /^(?:[A-Za-z][A-Za-z /-]{0,90})(?:\n|$)/.exec(error?.message)?.[0].trim();
  record('failure', { type: toolName(error?.name), stage: evidence.checks.at(-1)?.name, detail: classify(error?.message), source, message });
  process.exitCode = 1;
} finally {
  await productWorker?.close?.();
  await Promise.allSettled([app?.close(), web?.close(), relay && stop(relay), modelRelay && stop(modelRelay), stop(canary)]);
  await rm(temp, { recursive: true, force: true });
  evidence.finished_at = new Date().toISOString();
  const prefix = evidence.started_at.replace(/[:.]/g, '-');
  const file = join(here, `${prefix}-${evidence.run}.json`);
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(file);
}
