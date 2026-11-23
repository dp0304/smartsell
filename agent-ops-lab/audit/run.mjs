import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { focused, rawTool } from './focused.mjs';
import { exercise, fallback } from '../coverage/cases.mjs';
import { callBatches, callSlot, exactWebMatch, nativeRelay } from './audit.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const replica = process.env.SMARTSELL_AUDIT_SOURCE ? pathToFileURL(process.env.SMARTSELL_AUDIT_SOURCE.replace(/\/$/, '') + '/') : new URL('../../.local/mcp-lab-Lh53qf/', import.meta.url);
const load = name => import(new URL(`apps/server/src/${name}.ts`, replica).href);
const requireSDK = createRequire(new URL('apps/server/package.json', replica));
const sdk = name => import(pathToFileURL(requireSDK.resolve(`@modelcontextprotocol/sdk/client/${name}.js`)).href);
const { Client } = await sdk('index');
const { CallToolResultSchema } = await import(pathToFileURL(requireSDK.resolve('@modelcontextprotocol/sdk/types.js')).href);
const { StreamableHTTPClientTransport } = await sdk('streamableHttp');
const { configuration } = await load('config');
const requestedAuditRoute = '/mcp-tool-calls';
const focusOnly = process.argv.includes('--focused');
const selection = process.argv.slice(2).filter(arg => arg !== '--focused');
assert(selection.every(runtime => ['commands', 'operations'].includes(runtime)));
const output = await mkdtemp(join(project, 'audit', 'run-'));
const state = await mkdtemp(join(tmpdir(), 'smartsell-audit-'));
await writeFile(join(state, 'native-mcp.json'), JSON.stringify({ mcpServers: { matrix: { type: 'http', url: '${SMARTSELL_MATRIX_ORIGIN}/mcp', headers: { Authorization: 'Bearer ${SMARTSELL_MATRIX_TOKEN}' } } } }), { mode: 0o600 });
const secrets = new Set();
const protect = value => { assert(typeof value === 'string' && value.length >= 16, 'Missing fixture credential'); secrets.add(value); };
const privateValue = () => { const value = randomBytes(32).toString('hex'); secrets.add(value); return value; };
for (const key of Object.keys(process.env)) {
  if (/^(DATABASE_URL|BACKGROUND_DATABASE_URL|SMARTSELL_|SETUP_TOKEN|APP_SECRET|IDENTITY_ENCRYPTION_KEY|AWS_|S3_|MINIO_|NODE_COMPILE_CACHE|TSX_)/.test(key)) delete process.env[key];
}
process.env.NODE_ENV = 'development';
process.env.SMARTSELL_STORE = 'local';
for (const key of Object.keys(process.env)) if (/^(MEDIA_|PORTAL_|TRAFFIC_|DEV_ORIGINS|PUBLIC_ORIGIN)/.test(key)) delete process.env[key];
process.env.MEDIA_DIRECTORY = join(state, 'media');
const privateEvidenceFields = /^(?:arguments|nativeArguments|result|structuredContent|data|content|detail|assertion)$/;
function scrub(value, evidenceOnly = false) {
  return JSON.stringify(value, (key, v) => {
    if (evidenceOnly && privateEvidenceFields.test(key)) return undefined;
    if (/^(?:token|authorization|cookie|password|signature|fencing_token|csrf_token|next_cursor|nextCursor)$/i.test(key) && v != null) return '[redacted]';
    if (typeof v !== 'string') return v;
    for (const secret of secrets) v = v.replaceAll(secret, '[redacted]');
    return v.replace(/\b(?:ss_command_|sk-ant-)[\w-]+/g, '[redacted]')
      .replace(/("(?:token|signature|fencing_token|next_cursor|nextCursor|csrf_token|private_key|pairing_code)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|\d+)/gi, '$1"[redacted]"');
  });
}
const save = (file, value) => writeFile(join(output, file), JSON.stringify(JSON.parse(scrub(value, true)), null, 2) + '\n', { mode: 0o600 });
const record = (file, value) => appendFile(join(output, file), scrub(value, true) + '\n', { mode: 0o600 });
const timestamp = () => new Date().toISOString();
const statusCode = r => r?.structuredContent?.error?.code ?? (r?.isError ? r?.structuredContent?.data?.code : undefined);
const rows = d => Array.isArray(d) ? d : d?.items ?? (Array.isArray(d?.data) ? d.data : []);
const results = [];
const summarize = (entries, tag) => Object.fromEntries(Object.entries(Object.groupBy(entries, tag)).map(([key, values]) => [key, values.length]));
const ordinaryConfig = await readFile(join(project, '.mcp.json'));
const desktopConfig = await readFile(join(project, 'desktop', '.mcp.json'));
const verifyOrdinaryConfig = async () => {
  const current = await readFile(join(project, '.mcp.json'));
  assert(ordinaryConfig.equals(current), 'Ordinary MCP config changed during the batch');
  const desktop = await readFile(join(project, 'desktop', '.mcp.json'));
  assert(desktopConfig.equals(desktop), 'Desktop MCP config changed during the batch');
  assert(current.equals(desktop), 'Ordinary and desktop MCP configs differ in bytes');
};
await verifyOrdinaryConfig();
console.log(`Evidence directory: ${output}`);

const closeFixture = async env => { if (env) { env.app.server.closeAllConnections(); await env.app.close(); } };

async function launch(runtime, suffix = '') {
  const command = runtime === 'commands';
  const setupToken = privateValue();
  const db = join(state, `${runtime}${suffix}.${command ? 'sqlite' : 'json'}`);
  const config = configuration({ HOST: '127.0.0.1', SETUP_TOKEN: setupToken, APP_SECRET: privateValue(),
    IDENTITY_ENCRYPTION_KEY: privateValue(), SMARTSELL_DATA_FILE: db });
  // File storage validates the local profile. Limit the launched fixture to API/MCP afterwards.
  config.roles = new Set(['api', 'mcp']);
  const start = command ? (await load('bootstrap')).start : (await load('integration/kernel-runtime')).startKernel;
  const app = await start({ ...config, port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let session;
  async function http(path, method = 'GET', body, extra = {}, version) {
    assert(path.startsWith('/') && !path.startsWith('//'));
    const response = await fetch(origin + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(12000), headers: {
        ...session, ...extra, ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(version !== undefined && { 'if-match': `"${version}"` }),
        ...(method !== 'GET' && { 'idempotency-key': randomUUID() }),
      }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${scrub(value)}`);
    return { value, headers: response.headers, status: response.status };
  }
  try {
    await http('/readyz');
    const setup = await http('/api/v1/setup', 'POST', { name: 'Lab Owner', workspaceName: `Matrix ${runtime}`,
      email: `${runtime}@example.invalid`, password: privateValue() }, { 'x-setup-token': setupToken });
    const { csrf_token, user, workspaces: [workspace] } = setup.value.data;
    assert(user?.id, 'Missing fixture actor');
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    secrets.add(cookie); secrets.add(csrf_token);
    session = { cookie, 'x-csrf-token': csrf_token };
    const ws = workspace.id;
    const root = `/api/v1/workspaces/${ws}`;
    const rest = async (method, path, body, version) => (await http(root + path, method, body, {}, version)).value?.data;
    let filterCheck;
    const queryAudit = async path => {
      const found = [];
      const seen = new Set();
      let cursor;
      do {
        const page = await http(root + path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
        assert.equal(page.status, 200);
        assert(Array.isArray(page.value?.data) || Array.isArray(page.value?.data?.items), 'Unrecognized Web audit response');
        found.push(...rows(page.value.data));
        cursor = page.value.next_cursor ?? page.value.data?.next_cursor;
        if (cursor) {
          assert(!seen.has(cursor), 'Repeated audit pagination cursor');
          seen.add(cursor);
          secrets.add(cursor);
        }
      } while (cursor);
      return found;
    };
    const webAudit = async (requestId, expected) => {
      if (!requestId) return exactWebMatch(requestId, [], expected);
      const path = `${requestedAuditRoute}?request_id=${encodeURIComponent(requestId)}`;
      try {
        const found = await queryAudit(path);
        const match = exactWebMatch(requestId, found, { actorId: user.id, ...expected });
        if (match.status !== 'matched') return { httpStatus: 200, path: root + path, ...match };
        if (!filterCheck) {
          const unknownPath = `${requestedAuditRoute}?request_id=${randomUUID()}`;
          const unknown = await queryAudit(unknownPath);
          filterCheck = { path: unknownPath, rows: unknown.length };
          await save(`${runtime}${suffix}-web-filter-verification.json`, filterCheck);
        }
        if (filterCheck.rows !== 0) return { path, status: 'web_filter_mismatch', cohort: found };
        return { httpStatus: 200, path: root + path, ...match };
      } catch (error) { return { path, status: 'web_query_error', detail: error.message }; }
    };
    const credential = async (access = 'write', legacy = !command) => {
      const endpoint = legacy ? '/tokens' : '/agent-connections';
      const grant = await rest('POST', endpoint, legacy ? { access } : { label: 'Matrix Claude', client: 'claude_code', expires_days: 1 });
      secrets.add(grant.token);
      return { id: grant.id, token: grant.token, endpoint };
    };
    const main = await credential();
    const readOnly = await credential('read', true);
    const seed = async (kind, data) => {
      assert(command && ['link_domain'].includes(kind));
      const { localStore } = await load('local');
      const { operationRecords } = await load('integration/operation-records');
      const { makeContext } = await load('context');
      const sessionHash = (await import('node:crypto')).createHash('sha256').update(decodeURIComponent(cookie.split('=')[1])).digest('hex');
      const store = localStore(db);
      try {
        let seeded;
        await store.workspace(sessionHash, ws, unit => unit.command({ module: 'workspace', action: 'matrix_fixture_seed', key: randomUUID(), fingerprint: '' }, async () => {
          const { records, flush } = await operationRecords(unit.context, false);
          seeded = makeContext(records, unit.context, unit.context.role).create(kind, data);
          await flush();
          return seeded;
        }));
        return seeded;
      } finally { await store.close(); }
    };
    const pair = async () => {
      const { generateKeyPairSync } = await import('node:crypto');
      const { createPairingRequest } = await import(new URL('apps/connector/src/device-client.ts', replica).href);
      const { privateKey } = generateKeyPairSync('ed25519');
      const { pairing_code } = await rest('POST', '/devices/pairing-codes', { owned_device_confirmed: true });
      secrets.add(pairing_code);
      const body = createPairingRequest(ws, pairing_code, 'darwin', 'Matrix synthetic Worker', privateKey, { userInitiated: true, ownsDevice: true });
      const result = await http('/api/v1/device/pair', 'POST', body, { 'x-smartsell-workspace': ws });
      return result.value.data.device_id;
    };
    return { runtime, app, db, main, readOnly, origin, ws, rest, seed, pair, webAudit, http, csrf_token, session };
  } catch (error) { app.server.closeAllConnections(); await app.close(); throw error; }
}

async function connect(env, grant) {
  let wire = [];
  const client = new Client({ name: 'smartsell-local-matrix', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${env.origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error' },
    async fetch(url, options) {
      assert.equal(new URL(url).origin, env.origin);
      const response = await fetch(url, options);
      if (options?.method === 'POST' && typeof options.body === 'string') {
        const message = JSON.parse(options.body);
        if (message.method === 'tools/call') {
          wire.push({ requestId: response.headers.get('x-request-id'), rpcId: message.id, httpStatus: response.status });
        }
      }
      return response;
    },
  });
  await client.connect(transport);
  return { client, takeWire() { const observed = wire; wire = []; return observed; } };
}

function auditRecords(env) {
  return (async () => {
    if (env.runtime === 'operations') {
      const snapshot = JSON.parse(await readFile(env.db, 'utf8'));
      return Object.entries(snapshot.workspaces).filter(([key]) => key.endsWith(`/${env.ws}`)).flatMap(([, entries]) =>
        entries.filter(([key]) => key.startsWith('audit/')).map(([, value]) => JSON.parse(value)));
    }
    const db = new DatabaseSync(env.db, { readOnly: true });
    try {
      const payload = JSON.parse(db.prepare('SELECT payload FROM snapshot WHERE id = 1').get().payload);
      return payload.records.flatMap(([, entity]) => {
        if (entity.workspace_id !== env.ws) return [];
        const commandAudit = entity.kind === 'tool_call';
        const operationAudit = entity.module === 'operation_runtime' && (entity.id.startsWith('audit/') || entity.id.startsWith('row/tool_call/'));
        if (!commandAudit && !operationAudit) return [];
        const row = commandAudit ? entity.data : JSON.parse(entity.data.value);
        if (!row) return [];
        return [{ id: row.id ?? entity.id, kind: commandAudit ? 'tool_call' : entity.id.split('/')[0], tool_name: row.tool_name ?? row.tool,
          action: row.action, request_id: row.request_id, credential_id: row.credential_id, source: row.source, outcome: row.outcome,
          error_code: row.error_code, occurred_at: row.occurred_at ?? entity.created_at, resource_id: row.resource_id }];
      });
    } finally { db.close(); }
  })();
}

async function run(env) {
  const { runtime, ws, rest, main, readOnly } = env;
  const regular = await connect(env, main);
  const restricted = await connect(env, readOnly);
  const calls = [];
  const inlineNative = [];
  const tools = new Map();
  const pages = [];
  let cursor;
  const seen = new Set();
  try {
    do {
      const page = await regular.client.listTools(cursor ? { cursor } : {});
      pages.push({ at: timestamp(), received: page.tools.length, hasNext: Boolean(page.nextCursor), result: page });
      for (const tool of page.tools) { assert(!tools.has(tool.name)); tools.set(tool.name, tool); }
      cursor = page.nextCursor;
      if (cursor) { assert(!seen.has(cursor)); seen.add(cursor); secrets.add(cursor); }
    } while (cursor);
    const readOnlyPages = [];
    const readOnlyCursors = new Set();
    let readCursor;
    do {
      const page = await restricted.client.listTools(readCursor ? { cursor: readCursor } : {});
      readOnlyPages.push({ at: timestamp(), received: page.tools.length, hasNext: Boolean(page.nextCursor), names: page.tools.map(tool => tool.name), tools: page.tools });
      readCursor = page.nextCursor;
      if (readCursor) { assert(!readOnlyCursors.has(readCursor)); readOnlyCursors.add(readCursor); secrets.add(readCursor); }
    } while (readCursor);
    assert(readOnlyPages.flatMap(page => page.tools).every(tool => tool.annotations?.readOnlyHint));
    await save(`${runtime}-discovery.json`, { driver: 'MCP TypeScript SDK', workspace: ws, origin: env.origin, pages, readOnlyPages });
    async function call(name, input, check, options = {}) {
      const selected = options.restricted ? restricted : regular;
      const { operation, expectedCode, external, replay } = options;
      const schema = tools.get(name)?.inputSchema;
      const args = { ...input };
      if (schema?.properties?.workspace_id && runtime === 'operations' && args.workspace_id === undefined) args.workspace_id = ws;
      if (!replay && args.idempotency_key === undefined && schema?.properties?.idempotency_key && !tools.get(name)?.annotations?.readOnlyHint) args.idempotency_key = randomUUID();
      const id = randomUUID();
      const started = timestamp();
      let result, conclusion, code, detail;
      const credentialId = (options.restricted ? readOnly : main).id;
      selected.takeWire();
      const user = options.user ?? `在合成工作区执行 ${operation ?? name}，核对${options.assertion ?? '此用例列出的业务结果'}。`;
      try {
        const params = { name, arguments: args };
        if (options.wire) result = await selected.client.request({ method: 'tools/call', params }, CallToolResultSchema, { timeout: 12000 });
        else result = await selected.client.callTool(params, undefined, { timeout: 12000 });
        code = statusCode(result);
        if (expectedCode) { assert.equal(code, expectedCode); conclusion = '预期拒绝'; }
        else if (result.isError) {
          conclusion = external?.includes(code) ? '外部依赖' : '具体失败';
          detail = result.structuredContent?.error?.message ?? result.structuredContent?.data?.detail ?? result.content?.[0]?.text;
        } else {
          assert(check, '尚无业务断言');
          check(result.structuredContent?.data, result);
          conclusion = name === 'smartsell_operations_describe' ? '目录验证' : '成功';
        }
      } catch (error) {
        conclusion = '具体失败';
        detail = error.message;
      }
      const wire = selected.takeWire();
      const requestId = wire.length === 1 ? wire[0].requestId : null;
      const audits = requestId ? (await auditRecords(env)).filter(row => row.request_id === requestId && row.kind !== 'tool_call') : [];
      if (replay && conclusion === '成功' && audits.some(row => (row.action ?? row.tool_name) === (operation ?? name))) {
        conclusion = '具体失败'; detail = 'Replay created another committed-write audit row';
      }
      const webAudit = wire.length === 1 && result
        ? await env.webAudit(requestId, { name, outcome: result.isError ? 'error' : 'success', code, credentialId })
        : { status: wire.length !== 1 ? 'ambiguous_or_missing_wire_call' : 'missing_mcp_result' };
      const nativeArguments = result && conclusion === '成功' ? options.nativeInput?.(result.structuredContent.data) : undefined;
      const entry = { id, replay: Boolean(replay), nativeInline: Boolean(options.nativeInline), restricted: Boolean(options.restricted), nativeArguments, nativeDenied: Boolean(expectedCode && conclusion === '预期拒绝'), driver: options.wire ? 'MCP TypeScript SDK · protocol request' : 'MCP TypeScript SDK · callTool', runtime, user,
        agentReply: conclusion === '成功' ? `已核对 ${operation ?? name} 的合成结果。` : `${operation ?? name}：${conclusion}${code ? `（${code}）` : ''}。`,
        assertion: options.assertion ?? check?.toString(),
        name, operation, arguments: args, started, finished: timestamp(), requestId, wire, webAudit, conclusion, code, detail,
        serverAuditIds: webAudit.auditId ? [webAudit.auditId] : [], result };
      await record(`${runtime}-calls.jsonl`, entry);
      await record(`${runtime}-audit.jsonl`, { caseId: id, requestId, ...webAudit });
      calls.push(entry);
      if (entry.nativeInline) inlineNative.push(await native(env, [entry], tools));
      return ['成功', '目录验证'].includes(conclusion) ? result.structuredContent?.data : undefined;
    }
    const legacyOnly = readOnlyPages.flatMap(page => page.tools).filter(tool => !tools.has(tool.name));
    const context = { ...env, tools, call, rows, assert, legacyOnly };
    await exercise(context);
    await fallback(context, calls);
    const named = [...tools.keys()].map(name => {
      const entries = calls.filter(item => item.name === name && (name === 'smartsell_operation_call' || !item.operation));
      const primary = entries.find(item => item.conclusion === '成功') ?? entries.find(item => item.conclusion === '外部依赖') ?? entries[0];
      return { name, conclusion: primary?.conclusion ?? '未实调', detail: primary?.detail, code: primary?.code,
        cases: entries.map(({ id, driver, conclusion, serverAuditIds }) => ({ id, driver, conclusion, serverAuditIds })) };
    });
    await save(`${runtime}-matrix.json`, named);
    const operationIndex = calls.filter(item => item.name === 'smartsell_operations_describe' && item.arguments.module && item.conclusion === '目录验证')
      .flatMap(item => rows(item.result.structuredContent.data).map(({ name, method, path }) => ({ name, method, path })));
    await save(`${runtime}-operation-call.json`, { enumerated: operationIndex,
      called: calls.filter(item => item.operation).map(({ operation, id, conclusion, code, detail }) => ({ operation, id, conclusion, code, detail })) });
    const deferred = await native(env, calls.filter(call => !call.restricted && !call.nativeInline), tools);
    const cc = { attempted: inlineNative.reduce((n, entry) => n + entry.attempted, deferred.attempted),
      observed: [...inlineNative.flatMap(entry => entry.observed), ...deferred.observed] };
    const legacyEvidence = legacyOnly.map(tool => ({ name: tool.name, cases: calls.filter(call => call.name === tool.name && call.restricted)
      .map(({ id, conclusion, code, driver, serverAuditIds }) => ({ id, conclusion, code, driver, serverAuditIds })) }));
    const readTools = new Map(readOnlyPages.flatMap(page => page.tools.map(tool => [tool.name, tool])));
    const restrictedCalls = calls.filter(call => call.restricted && readTools.has(call.name));
    const nativeUnavailable = calls.filter(call => call.restricted && !readTools.has(call.name)).map(({ id, name, code }) => ({ id, name, code }));
    let legacyRun;
    if (restrictedCalls.length) {
      legacyRun = await native({ ...env, main: readOnly }, restrictedCalls, readTools, '-readonly');
      for (const item of legacyEvidence) item.nativeCalls = legacyRun.observed.filter(call => call.name === item.name);
      if (legacyEvidence.length) await save(`${runtime}-legacy-only.json`, legacyEvidence);
    }
    for (const item of named) item.nativeCalls = cc.observed.filter(call => call.name === item.name);
    await save(`${runtime}-matrix.json`, named);
    const observed = [...cc.observed, ...(legacyRun?.observed ?? [])];
    const countAudit = (entries, total = entries.length) => ({ total, receipts: entries.length,
      matched: entries.filter(call => call.webAudit.status === 'matched').length,
      outcomes: summarize(entries.flatMap(call => call.webAudit.cohort ?? []), row => row.outcome),
      errorCodes: summarize(entries.flatMap(call => call.webAudit.cohort ?? []).filter(row => row.error_code), row => row.error_code),
      statuses: Object.fromEntries([...new Set(entries.map(call => call.webAudit.status))].map(status =>
        [status, entries.filter(call => call.webAudit.status === status).length])) });
    const strict = { sdk: countAudit(calls), native: countAudit(observed, cc.attempted + (legacyRun?.attempted ?? 0)), nativeUnavailable };
    const joinedCalls = [...calls, ...observed];
    for (const [field, label] of [['requestId', 'request'], ['auditId', 'audit row']]) {
      const ids = joinedCalls.map(call => field === 'requestId' ? call.requestId : call.webAudit.auditId).filter(Boolean);
      assert.equal(new Set(ids).size, ids.length, `Product returned a duplicate ${label} ID within a runtime`);
    }
    if (strict.sdk.total !== strict.sdk.matched || strict.native.total !== strict.native.matched) process.exitCode = 1;
    return { runtime, strict, pages: pages.length, total: named.length, uniqueOperationsEnumerated: new Set(operationIndex.map(op => op.name)).size,
      uniqueOperationsCalled: new Set(calls.filter(item => item.operation).map(item => item.operation)).size, native: cc,
      uniqueAdvertisedToolsWithNativeReceipt: named.filter(item => item.nativeCalls.length > 0).length,
      sdkCaseBusiness: summarize(calls, item => item.conclusion),
      nativeReceiptClasses: summarize(observed, item => item.conclusion),
      apiBusinessStatuses: summarize(calls.filter(item => item.webAudit.cohort?.[0]?.status), item => item.webAudit.cohort[0].status),
      counts: Object.fromEntries([...new Set(named.map(item => item.conclusion))].map(key => [key, named.filter(item => item.conclusion === key).length])) };
  } finally {
    await Promise.allSettled([regular.client.close(), restricted.client.close()]);
  }
}

async function revokePat(env) {
  const { rest, main, readOnly, runtime, webAudit, ws } = env;
  const revocations = [];
  for (const [access, grant] of [['read', readOnly], ['write', main]]) {
    try {
      await rest('DELETE', `${grant.endpoint}/${grant.id}`);
      const result = await rawTool(env, grant.token, 'workspace_brand_get', { workspace_id: ws, params: { id: randomUUID() } });
      const evidence = await webAudit(result.requestId, {});
      revocations.push({ access, credentialId: grant.id, status: result.status, requestId: result.requestId, evidence,
        passed: result.status === 401 && evidence.status === 'missing_web_row' });
    } catch (error) { revocations.push({ access, detail: error.message, passed: false }); }
  }
  await save(`${runtime}-revocation.json`, revocations);
  return revocations;
}

const nativeEligible = (call, tools) => call.focused || call.nativeDenied || (['成功', '目录验证'].includes(call.conclusion) &&
    (call.nativeArguments || tools.get(call.name)?.annotations?.readOnlyHint || typeof call.arguments.idempotency_key === 'string'));

async function native(env, calls, tools, suffix = '') {
  const { runtime } = env;
  const safe = calls.filter(call => nativeEligible(call, tools));
  if (!safe.length) return { attempted: 0, observed: [], detail: 'No verified read or protected replay case' };
  const config = join(state, 'native-mcp.json');
  const log = `${runtime}${suffix}-native.jsonl`;
  const seenCalls = [];
  for (const batch of callBatches(safe)) {
    const relay = await nativeRelay({ origin: env.origin, token: env.main.token }, batch);
    const names = [...new Set(batch.map(item => `mcp__matrix__${item.name}`))];
    let childExit;
    const batchReceipts = [];
    const request = batch.length === 1 && batch[0].focused ? `Run only ${batch[0].name} on the isolated local ${runtime} fixture (${batch[0].label}).` : `请在 ${runtime} 合成工作区核对 ${batch.map(item => item.name).join('、')}。对曾提交的本地写入使用原幂等键重放，并按夹具验证指定的拒绝或本地研究草稿。`;
    await record(log, { at: timestamp(), role: 'user', driver: 'native Claude Code + scripted loopback Messages fixture', text: request });
    const model = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || new URL(req.url, 'http://127.0.0.1').pathname !== '/v1/messages') return res.writeHead(404).end();
        const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
        const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        const use = blocks.filter(block => block.type === 'tool_use' && names.includes(block.name));
        if (use.length === 0) assert(names.every(name => body.tools?.some(tool => tool.name === name)), 'Claude Code did not expose all allowlisted tools');
        const toolPhase = use.length === 0;
        const content = toolPhase ? batch.map(item => ({ type: 'tool_use', id: `toolu_${randomUUID().replaceAll('-', '')}`, name: `mcp__matrix__${item.name}`, input: item.nativeArguments ?? item.arguments }))
          : [{ type: 'text', text: `本次 Claude Code 会话请求了 ${use.length} 项工具。逐项返回和判定见会话记录。` }];
        const stop_reason = toolPhase ? 'tool_use' : 'end_turn';
        const message = { type: 'message', id: `msg_${randomUUID().replaceAll('-', '')}`, role: 'assistant', model: body.model,
          content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (!body.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
        const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } },
          ...content.flatMap((block, index) => [
            { type: 'content_block_start', index, content_block: toolPhase ? { ...block, input: {} } : { ...block, text: '' } },
            { type: 'content_block_delta', index, delta: toolPhase ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
            { type: 'content_block_stop', index },
          ]), { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } }));
      }
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    try {
      const child = spawn('claude', ['--bare', '--print', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', config,
        '--tools', '', '--allowedTools', names.join(','), '--model', 'claude-opus-5-5', '--max-turns', String(batch.length + 2),
        '--output-format', 'stream-json', '--verbose', request], { cwd: state, env: {
        PATH: process.env.PATH, HOME: state, TMPDIR: state, ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
        ANTHROPIC_API_KEY: 'local-fixture-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false',
        SMARTSELL_MATRIX_ORIGIN: relay.origin, SMARTSELL_MATRIX_TOKEN: env.main.token,
      }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
      const exit = once(child, 'close');
      const { createInterface } = await import('node:readline');
      const accepted = new Map();
      for await (const line of createInterface({ input: child.stdout })) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const at = timestamp();
        if (event.type === 'system' && event.subtype === 'init') await record(log, { at, role: 'init', sessionId: event.session_id, mcp: event.mcp_servers });
        if (event.type === 'result') await record(log, { at, role: 'result', subtype: event.subtype, isError: event.is_error });
        for (const block of event.message?.content ?? []) {
          if (event.type === 'assistant' && block.type === 'text') await record(log, { at, role: 'assistant', text: block.text });
          if (event.type === 'assistant' && block.type === 'tool_use' && names.includes(block.name)) {
            const name = block.name.replace('mcp__matrix__', '');
            const original = callSlot(batch, name, block.input);
            accepted.set(block.id, original);
            await record(log, { at, role: 'tool_use', name, id: block.id, caseId: original.id, arguments: block.input });
          }
          if (event.type === 'user' && block.type === 'tool_result' && accepted.has(block.tool_use_id)) {
            const original = accepted.get(block.tool_use_id);
            const isError = Boolean(block.is_error);
            const expectedDenial = Boolean(original.code && isError && JSON.stringify(block.content).includes(original.code));
            let data;
            if (original.focused && !isError) { try { data = JSON.parse(block.content).data; } catch {} }
            const receipt = { label: original.label, data, name: original.name, operation: original.operation, sdkReplay: original.replay, id: block.tool_use_id, caseId: original.id, isError,
              conclusion: expectedDenial ? '预期拒绝' : isError ? '具体失败' : original.nativeDenied ? '具体失败' : '收到成功回执' };
            batchReceipts.push({ receipt, original });
            await record(log, { at, role: 'tool_result', ...receipt, content: block.content });
          }
        }
      }
      const [code, signal] = await exit;
      childExit = { code, signal };
      await record(log, { at: timestamp(), role: 'exit', code, signal });
    } finally {
      model.closeAllConnections();
      await new Promise(resolve => model.close(resolve));
      await relay.close();
    }
    await record(`${runtime}${suffix}-native-wire.jsonl`, { calls: relay.calls, failures: relay.failures });
    for (const { receipt, original } of batchReceipts) {
      const wire = relay.calls.filter(entry => entry.caseId === original.id);
      const single = wire.length === 1 && batchReceipts.filter(entry => entry.original.id === original.id).length === 1;
      if (childExit?.code !== 0 || relay.failures.length) process.exitCode = 1;
      const requestId = single ? wire[0].requestId : null;
      const webAudit = single ? await env.webAudit(requestId, { name: original.name, outcome: receipt.isError ? 'error' : 'success',
        code: original.code, credentialId: env.main.id, target: original.target, exactOutcome: original.exactOutcome }) : { status: 'ambiguous_or_missing_wire_call' };
      Object.assign(receipt, { childExit, requestId, wire: single ? wire[0] : null, webAudit, serverAuditIds: webAudit.auditId ? [webAudit.auditId] : [] });
      seenCalls.push(receipt);
      await record(log, { at: timestamp(), role: 'audit', ...receipt });
      await record(`${runtime}${suffix}-native-audit.jsonl`, { id: receipt.id, caseId: original.id, requestId, ...webAudit });
    }
  }
  return { attempted: safe.length, observed: seenCalls };
}

try {
  for (const runtime of selection.length ? selection : ['commands', 'operations']) {
    assert(['commands', 'operations'].includes(runtime));
    let env;
    try {
      env = await launch(runtime);
      const focus = await focused(env, { native, auditRecords, privateValue, protect });
      await save(`${runtime}-focused.json`, focus);
      if (!focus.passed) process.exitCode = 1;
      const revocations = await revokePat(env);
      if (revocations.some(row => !row.passed)) process.exitCode = 1;
      let matrix;
      if (!focusOnly) {
        await closeFixture(env);
        env = await launch(runtime, '-matrix');
        matrix = await run(env);
      }
      results.push({ runtime, focus, matrix, revocations });
      console.log(`${runtime}: focused=${focus.passed}, ${matrix?.total ?? 0} advertised matrix tools`);
    } catch (error) {
      results.push({ runtime, fatal: scrub({ message: error.message, stack: error.stack }) });
      process.exitCode = 1;
    } finally {
      await closeFixture(env);
    }
    await save('summary.json', results);
  }
} finally {
  await rm(state, { recursive: true, force: true });
  await verifyOrdinaryConfig();
  await save('ordinary-config-verification.json', { unchanged: true, desktopUnchanged: true, matchesDesktopByteForByte: true, nativeConfig: 'ephemeral generated harness config' });
}
