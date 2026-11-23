import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { priority, expand } from './cases.mjs';
import { matrix } from './matrix.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, process.env.SMARTSELL_SOURCE ?? '../../.local/mcp-lab-Lh53qf');
const require = createRequire(resolve(src, 'apps/server/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const now = () => new Date().toISOString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const dir = resolve(here, 'runs', `${now().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
const runtime = resolve(dir, 'runtime');
const dbPath = resolve(runtime, 'workspace.sqlite');
await mkdir(runtime, { recursive: true, mode: 0o700 });
console.log(dir);
const secrets = new Set();
const secretField = /(?:password|secret|token|cookie|authorization|pairing_code|private_key|lease_credential_id|upload_url|download_url)/i;
function redact(value) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.replaceAll(secret, '[REDACTED]');
    value = value.replace(/([?&](?:token|signature|code)=)[^\s"&]+/gi, '$1[REDACTED]');
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(redact(JSON.parse(value))); } catch { /* plain text */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretField.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}
const json = (name, data) => writeFile(resolve(dir, name), JSON.stringify(redact(data), null, 2) + '\n', { mode: 0o600 });
const log = (name, data) => appendFile(resolve(dir, name), JSON.stringify(redact(data)) + '\n', { mode: 0o600 });
async function listener(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
async function port() {
  const server = await listener();
  const address = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return address;
}
const apiPort = Number(process.env.LAB_API_PORT ?? await port());
let webPort = Number(process.env.LAB_WEB_PORT ?? await port());
if (apiPort === webPort && !process.env.LAB_WEB_PORT) webPort = await port();
assert.notEqual(apiPort, webPort);
const origin = `http://127.0.0.1:${webPort}`;
let server, db, client, connection, root, cookie, csrf, requestId;
const catalog = new Map(), calls = [], auditRows = new Map(), gaps = {};

async function http(method, path, body, version, extra = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15_000), headers: {
    Origin: origin, ...(cookie && { Cookie: cookie }), ...(csrf && { 'X-CSRF-Token': csrf }),
    ...(body !== undefined && { 'Content-Type': 'application/json' }), 'Idempotency-Key': randomUUID(),
    ...(version !== undefined && { 'If-Match': String(version) }), ...extra,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const value of response.headers.getSetCookie()) {
    const entry = value.split(';', 1)[0];
    if (/session/i.test(entry.split('=', 1)[0])) { cookie = entry; secrets.add(entry); secrets.add(entry.slice(entry.indexOf('=') + 1)); }
  }
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(redact(result))}`);
  return result?.data ?? result;
}
const rest = (method, path, body, version) => http(method, `${root}${path}`, body, version);
async function mediaReadback(id, expected) {
  const sentAt = now();
  const { url: signed } = await rest('GET', `/files/${id}/download?inline=true`);
  const url = new URL(signed, origin);
  assert.equal(url.origin, origin);
  const response = await fetch(url, { headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, expected);
  await log('readbacks.jsonl', { name: 'owner_download_bytes', path: url.pathname, sentAt, receivedAt: now(), verified: true,
    data: { id, sha256: sha(bytes), size_bytes: bytes.length, mime_type: response.headers.get('content-type') } });
}
function recordList() {
  const { records } = JSON.parse(db.prepare('SELECT payload FROM snapshot WHERE id=1').get().payload);
  return records.map(([key, row]) => row.module === 'operation_runtime' && row.kind === 'record' && typeof row.data?.value === 'string'
    ? [row.id, JSON.parse(row.data.value)] : [key, row]);
}
const audited = entries => entries.filter(([key, row]) =>
  (key.startsWith('audit/') || key.startsWith('row/activity_event/')) && row.credential_id === connection.id && row.source === 'mcp');
const domainRows = entries => new Map(entries.filter(([key]) => /^row\/(?!activity_event\/|agent_tool_call\/)/.test(key)));
const asResult = result => result.structuredContent ?? result.content;

function readCount(operation, data) {
  if (Array.isArray(data)) return { path: 'data.length', count: data.length };
  const listKey = { mentions_query: 'items', publishing_get_calendar: 'targets', research_board_get: 'items' }[operation];
  if (listKey && Array.isArray(data?.[listKey])) return { path: `data.${listKey}.length`, count: data[listKey].length };
  if (operation === 'observations_compare' && Number.isInteger(data?.sample?.[0]?.sample_size)) {
    return { path: 'data.sample[0].sample_size', count: data.sample[0].sample_size };
  }
}

async function discover(args) {
  const sentAt = now();
  const response = await client.callTool({ name: 'smartsell_operations_describe', arguments: args });
  await log('discovery.jsonl', { sentAt, receivedAt: now(), args, requestId, response });
  assert.equal(response.isError ?? false, false);
  return asResult(response).data;
}

async function call(operation, args = {}, check, options = {}) {
  if (!catalog.has(operation) && !options.expectedCode) return undefined;
  const entry = { seq: calls.length + 1, operation, path: catalog.get(operation)?.path, phase: options.phase ?? 'priority',
    sentAt: now(), tool: 'smartsell_operation_call', args: { operation, idempotency_key: randomUUID(), ...args }, assertion: options.assertion };
  const before = recordList();
  requestId = undefined;
  let data;
  try {
    const response = await client.callTool({ name: entry.tool, arguments: entry.args }, undefined, { timeout: 15_000 });
    entry.receivedAt = now();
    entry.response = response;
    entry.requestId = requestId;
    entry.isError = response.isError === true;
    const result = asResult(response);
    data = result.data ?? result;
    entry.code = result.error?.code;
    entry.status = entry.isError ? 'business_error' : 'response_only';
    if (!entry.isError && catalog.get(operation)?.method === 'GET') entry.resultCount = readCount(operation, data);
    if (options.expectedCode) {
      assert.equal(entry.code, options.expectedCode);
      entry.status = 'boundary_confirmed';
    } else if (!entry.isError && check) {
      const verifiedStatus = await check(data, response);
      entry.status = options.status ?? verifiedStatus ?? 'business_verified';
    }
  } catch (error) {
    entry.status = entry.response ? 'assertion_failed' : 'transport_or_sdk_error';
    entry.error = error.message;
  }
  entry.receivedAt ??= now();
  const after = recordList();
  const existing = new Set(audited(before).map(([key]) => key));
  const audits = audited(after).filter(([key, row]) => !existing.has(key) && row.action === operation);
  for (const [key, row] of audits) auditRows.set(key, row);
  entry.audit = { status: audits.length ? 'persisted' : 'none_in_local_snapshot_delta', ids: audits.map(([, row]) => row.id),
    requestIds: [...new Set(audits.map(([, row]) => row.request_id))] };
  if (catalog.get(operation)?.method !== 'GET' && !entry.isError) {
    const prior = domainRows(before), current = domainRows(after);
    entry.persistedChanges = [...current].filter(([key, row]) => JSON.stringify(prior.get(key)) !== JSON.stringify(row))
      .map(([key, row]) => {
        const changedFields = Object.keys(row).filter(field => JSON.stringify(row[field]) !== JSON.stringify(prior.get(key)?.[field]));
        const readbackFields = /^(?:id|version|status|name|title|kind|sku|format|mime_type|sha256|size_bytes|currency|price_minor|plan_status|scheduled_at|schedule_tz|merged_rows|failed_rows|[a-z_]+_id)$/;
        return { key, id: row.id ?? key.split('/').at(-1), version: row.version, status: row.status, changedFields,
          readback: Object.fromEntries(changedFields.filter(field => readbackFields.test(field)).map(field => [field, row[field]])) };
      });
    entry.persistedChanges.push(...[...prior].filter(([key]) => !current.has(key)).map(([key, row]) => ({ key, id: row.id, removed: true })));
    if (entry.status === 'business_verified' && (!entry.persistedChanges.length || !audits.length)) entry.status = 'response_only';
    if (options.replay && (audits.length || entry.persistedChanges.length)) entry.status = 'assertion_failed';
  }
  if (entry.requestId) {
    const query = new URLSearchParams({ request_id: entry.requestId, credential_id: connection.id });
    try {
      const rows = await rest('GET', `/mcp-tool-calls?${query}`);
      assert.equal(rows.length, 1, `Expected one indexed audit row for ${entry.requestId}`);
      const [row] = rows;
      assert.equal(row.request_id, entry.requestId);
      assert.equal(row.credential_id, connection.id);
      assert.equal(row.tool, entry.tool);
      assert.ok(row.outcome && row.outcome !== 'pending');
      assert.equal(row.outcome === 'success', !entry.isError);
      if (entry.isError) assert.equal(row.error_code, entry.code);
      if (options.replay) assert.equal(row.replayed, true);
      assert.ok(entry.audit.requestIds.every(id => id === row.request_id));
      entry.requestAudit = { status: 'matched', row };
    } catch (error) {
      entry.requestAudit = { status: 'lookup_failed', error: error.message };
    }
  } else {
    entry.requestAudit = { status: 'missing_request_id' };
  }
  calls.push(entry);
  await log('calls.jsonl', entry);
  if (['business_error', 'assertion_failed', 'transport_or_sdk_error'].includes(entry.status)) {
    console.log(`${entry.seq} ${operation} ${entry.status} ${entry.code ?? entry.error ?? ''}`);
    return undefined;
  }
  return data;
}
async function readback(name, path, check) {
  const sentAt = now();
  let data;
  try {
    data = await rest('GET', path);
    await check(data);
    await log('readbacks.jsonl', { name, path, sentAt, receivedAt: now(), verified: true, data });
    return data;
  } catch (error) {
    await log('readbacks.jsonl', { name, path, sentAt, receivedAt: now(), verified: false, error: error.message, data });
    throw error;
  }
}
async function section(name, run) {
  console.log(name);
  try { await run(); }
  catch (error) { gaps[name] = error.message; console.log(`${name}: ${error.message}`); }
}

try {
  const fd = openSync(resolve(runtime, 'server.log'), 'wx', 0o600);
  try {
    server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/dev.ts', '--host', '127.0.0.1', '--port', String(webPort), '--no-watch'], {
      cwd: src, stdio: ['ignore', fd, fd], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: runtime,
        TZ: 'Asia/Shanghai', NODE_ENV: 'development', ROLE: 'all', HOST: '127.0.0.1', PORT: String(apiPort),
        SMARTSELL_DATA_FILE: dbPath, MEDIA_DIRECTORY: resolve(runtime, 'media'), SMARTSELL_VITE_CACHE_DIR: resolve(runtime, 'vite') },
    });
  } finally { closeSync(fd); }
  for (let i = 0; ; i++) {
    assert.ok(i < 100 && server.exitCode === null, 'Server startup failed; inspect runtime/server.log');
    if (await fetch(origin, { signal: AbortSignal.timeout(1_000) }).then(r => r.ok).catch(() => false)) break;
    await delay(250);
  }
  const password = `Gateway!${randomBytes(24).toString('hex')}`;
  secrets.add(password);
  const setup = await http('POST', '/setup', { name: 'Gateway lab owner', email: `gateway-${randomUUID()}@example.test`, password, workspaceName: 'Gateway isolation lab' });
  const ws = setup.workspaces[0].id;
  root = `/workspaces/${ws}`;
  csrf = (await http('GET', '/session/csrf')).csrf_token;
  secrets.add(csrf);
  connection = await rest('POST', '/agent-connections', { label: 'Generic gateway SDK verification', client: 'claude_code', expires_days: 1 });
  secrets.add(connection.token);
  db = new DatabaseSync(dbPath, { readOnly: true });
  client = new Client({ name: 'smartsell-gateway-lab', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` }, redirect: 'error' },
    async fetch(url, options) {
      assert.equal(new URL(url).origin, origin);
      const response = await fetch(url, options);
      requestId = response.headers.get('x-request-id') ?? requestId;
      return response;
    },
  }));
  await json('scope.json', { driver: 'MCP TypeScript SDK / Streamable HTTP', origin, workspace: ws, credentialId: connection.id, src, startedAt: now() });
  const index = await discover({});
  for (const module of index) {
    const entries = await discover({ module: module.module });
    assert.equal(entries.length, module.operations, module.module);
    for (const entry of entries) {
      assert.ok(!catalog.has(entry.name), entry.name);
      catalog.set(entry.name, { ...entry, module: module.module });
    }
  }
  await json('catalog.json', [...catalog.values()]);
  console.log(`${catalog.size} operations, ${index.length} modules`);
  const env = { call, rest, readback, mediaReadback, section, catalog, json, sha, now, listener, src, origin, ws, dir, recordList, domainRows, calls, sensitive: value => secrets.add(value) };
  await priority(env);
  if (!process.argv.includes('--priority-only')) await expand(env);
  await call('posts_list', {}, data => assert.deepEqual(data, []), { status: 'valid_empty', assertion: 'No external publication or manual post registration in this workspace.' });
  assert.deepEqual(await readback('no_external_posts', '/platform-posts', data => assert.deepEqual(data, [])), []);
  const indexed = calls.find(entry => entry.requestAudit.status === 'matched');
  if (indexed) await readback('known_mcp_request_id_returns_one', `/mcp-tool-calls?request_id=${indexed.requestId}`,
    data => assert.deepEqual(data, [indexed.requestAudit.row]));
  const missingId = randomUUID();
  const unknown = await readback('unknown_mcp_request_id_returns_zero', `/mcp-tool-calls?request_id=${missingId}`,
    data => assert.deepEqual(data, []));
  assert.deepEqual(unknown, []);
  assert.ok(calls.every(entry => entry.requestAudit.status === 'matched'), 'Some calls could not be found by request_id');
} catch (error) {
  gaps.runner = error.message;
  console.error(redact(error.stack ?? error.message));
  process.exitCode = 1;
} finally {
  if (connection) {
    try { await rest('DELETE', `/agent-connections/${connection.id}`); }
    catch (error) { gaps.revocation = error.message; process.exitCode = 1; }
  }
  if (client) await client.close().catch(() => {});
  db?.close();
  if (server?.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await stopped;
  }
  await json('audit.json', [...auditRows].map(([key, row]) => ({ key, row })));
  await matrix({ catalog, calls, gaps, json, dir, redact });
}
