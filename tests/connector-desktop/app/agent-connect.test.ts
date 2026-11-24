// §6.2: 「連接 Codex／Claude Code」 — redeem, 0600 credential + config.json, client configuration pointing at
// `"<execPath>" --mcp-relay` (Windows: node smartsell-relay.mjs); the loopback hand-back checks state.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  claudeCommandLine, codexBackupPath, codexManagedBlock, connectAgentClient, readRelayConfig, relayCommand, relayFiles, upsertCodexConfig, writeCodexConfig,
  type ConnectDeps,
} from '../../../apps/connector-desktop/src/app/agent-connect.ts';
import { AgentShell } from '../../../apps/connector-desktop/src/app/agent-mode.ts';
import { loopbackGrant } from '../../../apps/connector-desktop/src/app/loopback-grant.ts';
import { Notifier } from '../../../apps/connector-desktop/src/app/notify.ts';
import { appSettings } from '../../../apps/connector-desktop/src/service-settings.ts';

const WS = '11111111-2222-3333-4444-555555555555';
const CONN = '99999999-8888-7777-6666-555555555555';
const TOKEN = `ss_command_${'t'.repeat(80)}`;
const CODE = 'e'.repeat(120);

test('codex config: the managed block replaces itself and any other smartsell table, everything else is kept', () => {
  const block = codexManagedBlock('/Applications/SmartSell Worker.app/Contents/MacOS/SmartSell Worker', ['--mcp-relay']);
  assert.match(block, /^# >>> smartsell \(managed by SmartSell Worker\)\n\[mcp_servers\.smartsell\]\ncommand = "\/Applications\/SmartSell Worker.app\/Contents\/MacOS\/SmartSell Worker"\nargs = \["--mcp-relay"\]\nstartup_timeout_sec = 20\ntool_timeout_sec = 120\n# <<< smartsell$/);
  const existing = 'model = "gpt-5"\napproval_policy = "on-request"\n\n[mcp_servers.smartsell]\ncommand = "python3"\nargs = ["old.py"]\n\n[mcp_servers.smartsell.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "other"\n';
  const once = upsertCodexConfig(existing, block);
  assert.ok(once.includes('approval_policy = "on-request"'), 'the owner approval setting is untouched (B04)');
  assert.ok(once.includes('[mcp_servers.other]\ncommand = "other"'));
  assert.ok(!once.includes('old.py') && !once.includes('X = "1"'));
  assert.equal(once.match(/\[mcp_servers\.smartsell\]/g)?.length, 1);
  const twice = upsertCodexConfig(once, codexManagedBlock('/new/path', ['--mcp-relay']));
  assert.equal(twice.match(/\[mcp_servers\.smartsell\]/g)?.length, 1, 'reconnecting rewrites the same block');
  assert.ok(twice.includes('command = "/new/path"'));
  assert.equal(upsertCodexConfig('', block), `${block}\n`);
});

test('codex config: inline and dotted smartsell definitions are replaced too; CRLF files keep CRLF', () => {
  const block = codexManagedBlock('/Apps/SmartSell Worker', ['--mcp-relay']);
  const inline = 'mcp_servers.smartsell.command = "root-dotted"\nmodel = "gpt-5"\n\n[mcp_servers]\nsmartsell = { command = "inline" }\nother = { command = "keep-me" }\n"smartsell".args = ["x"]\n\n[profiles.fast]\nsmartsell = "unrelated key in another table"\n';
  const out = upsertCodexConfig(inline, block);
  assert.ok(!out.includes('root-dotted') && !out.includes('"inline"') && !out.includes('["x"]'), out);
  assert.ok(out.includes('other = { command = "keep-me" }'));
  assert.ok(out.includes('smartsell = "unrelated key in another table"'), 'keys named smartsell in other tables are not ours');
  assert.equal(out.match(/smartsell\]/g)?.length, 1);
  const crlf = 'model = "gpt-5"\r\n[mcp_servers.other]\r\ncommand = "x"\r\n';
  const rewritten = upsertCodexConfig(crlf, block);
  assert.ok(rewritten.startsWith('model = "gpt-5"\r\n[mcp_servers.other]\r\ncommand = "x"\r\n\r\n# >>> smartsell'));
  assert.ok(!/[^\r]\n/.test(rewritten), 'every line ends with CRLF');
});

test('E12: an existing ~/.codex/config.toml is backed up (0600, timestamped) before the block is written; other tables survive', t => {
  const home = mkdtempSync(join(tmpdir(), 'smartsell-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, '.codex', 'config.toml');
  const block = codexManagedBlock('/Apps/SmartSell Worker', ['--mcp-relay']);
  // No file yet: written with 0600, no backup.
  const first = writeCodexConfig(path, block, 'darwin', new Date('2026-11-24T08:15:00.123Z'));
  assert.deepEqual(first, { changed: true, backup: null });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  const original = 'model = "gpt-5"\n[mcp_servers.github]\ncommand = "gh-mcp"\nenv = { GITHUB_TOKEN = "secret-in-owner-file" }\n\n[profiles.deep]\nmodel = "o3"\n';
  writeFileSync(path, original);
  chmodSync(path, 0o640);
  const second = writeCodexConfig(path, block, 'darwin', new Date('2026-11-24T08:15:00.123Z'));
  assert.equal(second.changed, true);
  assert.equal(second.backup, `${path}.smartsell-backup-20261124T081500Z`);
  assert.equal(readFileSync(second.backup!, 'utf8'), original, 'the backup is the file exactly as it was');
  const written = readFileSync(path, 'utf8');
  assert.ok(written.startsWith(original.trimEnd()), 'every other table is kept byte for byte');
  assert.ok(written.includes('[profiles.deep]\nmodel = "o3"') && written.includes('[mcp_servers.github]'));
  assert.equal(written.match(/\[mcp_servers\.smartsell\]/g)?.length, 1);
  if (process.platform !== 'win32') {
    assert.equal(statSync(second.backup!).mode & 0o777, 0o600, 'the backup can hold other servers\' tokens');
    assert.equal(statSync(path).mode & 0o777, 0o640, 'the rewrite keeps the owner\'s file mode');
  }
  // Same block again: nothing written, no second backup.
  assert.deepEqual(writeCodexConfig(path, block, 'darwin', new Date('2026-11-24T08:16:00Z')), { changed: false, backup: null });
  // A new block in the same second gets its own backup name.
  const third = writeCodexConfig(path, codexManagedBlock('/New/Path', ['--mcp-relay']), 'darwin', new Date('2026-11-24T08:15:00.900Z'));
  assert.equal(third.backup, `${path}.smartsell-backup-20261124T081500Z-1`);
  assert.equal(readdirSync(join(home, '.codex')).filter(name => name.includes('smartsell-backup')).length, 2);
  assert.equal(codexBackupPath('/x/config.toml', new Date('2026-01-02T03:04:05Z'), () => false), '/x/config.toml.smartsell-backup-20260102T030405Z');
});

test('client commands: App mode on macOS, Node relay on Windows; Claude command line is quoted', () => {
  assert.deepEqual(relayCommand('darwin', '/Applications/SmartSell Worker.app/Contents/MacOS/SmartSell Worker', '/u'), { command: '/Applications/SmartSell Worker.app/Contents/MacOS/SmartSell Worker', args: ['--mcp-relay'] });
  const win = relayCommand('win32', 'C:\\Program Files\\SmartSell Worker\\SmartSell Worker.exe', 'C:\\Users\\o\\AppData\\Roaming\\SmartSell Worker');
  assert.equal(win.command, 'node');
  assert.deepEqual(win.args.slice(1), ['--config', join('C:\\Users\\o\\AppData\\Roaming\\SmartSell Worker', 'agent-relay', 'config.json')]);
  assert.equal(claudeCommandLine('/Applications/SmartSell Worker.app/Contents/MacOS/SmartSell Worker', ['--mcp-relay']),
    'claude mcp add --scope user smartsell -- "/Applications/SmartSell Worker.app/Contents/MacOS/SmartSell Worker" --mcp-relay');
});

function connectDeps(t: { after(fn: () => unknown): void }, overrides: Partial<ConnectDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'smartsell-connect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests: { url: string; method: string; body: string | null; auth: string | null }[] = [];
  const opened: string[] = [];
  const deps: ConnectDeps = {
    hubOrigin: 'https://hub.tail1234.ts.net', client: 'codex', hostname: 'Laptop', userData: join(root, 'ud'), execPath: '/Apps/SmartSell Worker', platform: 'darwin',
    homeDir: join(root, 'home'), openExternal: async url => { opened.push(url); }, signal: new AbortController().signal,
    which: async () => null, run: async () => ({ code: 0, stdout: '', stderr: '' }),
    grant: async options => {
      const url = new URL(options.url(41234, 'state-x'));
      opened.push(url.href);
      const params = new URLSearchParams({ workspace: WS, code: CODE, connection: CONN });
      const grant = options.validate(params);
      if (!grant) throw new Error('rejected');
      return grant;
    },
    fetch: (async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null, auth: new Headers(init?.headers).get('authorization') });
      if (String(input).endsWith('/redeem')) return new Response(JSON.stringify({ data: { token: TOKEN } }), { status: 201, headers: { 'content-type': 'application/json' } });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    ...overrides,
  };
  return { deps, requests, opened, root };
}

test('connect Codex: opens /agent-connect with client, port, state and label; redeems; writes 0600 files and config.toml', async t => {
  const { deps, requests, opened } = connectDeps(t);
  const result = await connectAgentClient(deps);
  const url = new URL(opened[0]);
  assert.equal(url.origin + url.pathname, 'https://hub.tail1234.ts.net/agent-connect');
  assert.deepEqual(Object.fromEntries(url.searchParams), { client: 'codex', port: '41234', state: 'state-x', label: 'Laptop · Codex' });
  assert.deepEqual(requests[0], { url: `https://hub.tail1234.ts.net/api/v1/workspaces/${WS}/agent-connections/redeem`, method: 'POST', body: JSON.stringify({ code: CODE }), auth: null });
  const files = relayFiles(deps.userData);
  assert.equal(readFileSync(files.credential, 'utf8').trim(), TOKEN);
  assert.equal(statSync(files.credential).mode & 0o777, 0o600);
  assert.equal(statSync(files.config).mode & 0o777, 0o600);
  assert.deepEqual(readRelayConfig(deps.userData), { hub_origin: 'https://hub.tail1234.ts.net', workspace_id: WS, connection_id: CONN, client: 'codex' });
  const toml = readFileSync(join(deps.homeDir, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /command = "\/Apps\/SmartSell Worker"\nargs = \["--mcp-relay"\]/);
  assert.equal(result.configured, 'config_file');
  assert.equal(result.previous_revoked, null);
  const agentsMd = join(deps.homeDir, '.codex', 'AGENTS.md');
  assert.throws(() => statSync(agentsMd), 'AGENTS.md is never written (B04)');
});

test('E13: reconnecting revokes the previous connection with its own token at /agent-connections/self; Claude Code via the CLI', async t => {
  const { deps, requests } = connectDeps(t);
  const first = await connectAgentClient(deps);
  assert.deepEqual([first.previous_revoked, first.previous_status], [null, null]);
  const calls: string[][] = [];
  const order: string[] = [];
  const second = connectDeps(t, {
    client: 'claude_code', userData: deps.userData, homeDir: deps.homeDir,
    which: async command => command === 'claude' ? '/usr/local/bin/claude' : null,
    run: async (file, args) => { calls.push([file, ...args]); order.push(`cli:${args[0]}:${args[1]}`); return { code: 0, stdout: '', stderr: '' }; },
    grant: async options => options.validate(new URLSearchParams({ workspace: WS, code: CODE, connection: '12345678-1234-1234-1234-123456789abc' }))!,
  });
  const newToken = `ss_command_${'n'.repeat(80)}`;
  const fetchSecond = second.deps.fetch!;
  second.deps.fetch = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith('/redeem')) { await fetchSecond(input, init); return new Response(JSON.stringify({ data: { token: newToken } }), { status: 201 }); }
    order.push(`fetch:${init?.method ?? 'GET'}:${readFileSync(relayFiles(deps.userData).credential, 'utf8').trim() === newToken ? 'new-files' : 'old-files'}`);
    return fetchSecond(input, init);
  }) as typeof fetch;
  const result = await connectAgentClient(second.deps);
  assert.equal(result.configured, 'cli');
  assert.deepEqual(calls.at(-1), ['/usr/local/bin/claude', 'mcp', 'add', '--scope', 'user', 'smartsell', '--', '/Apps/SmartSell Worker', '--mcp-relay']);
  const revoke = second.requests.find(item => item.method === 'DELETE');
  assert.equal(revoke?.url, 'https://hub.tail1234.ts.net/api/v1/agent-connections/self');
  assert.equal(revoke?.auth, `Bearer ${TOKEN}`, 'the old connection authenticates with its own token');
  assert.deepEqual([result.previous_revoked, result.previous_status], [true, 'revoked']);
  assert.deepEqual(order.slice(-1), ['fetch:DELETE:new-files'], 'the old connection is revoked only after the new one is written and configured');
  assert.ok(order.indexOf('cli:mcp:add') < order.indexOf('fetch:DELETE:new-files'));
  assert.equal(requests.filter(item => item.method === 'DELETE').length, 0, 'a first connection revokes nothing');
});

test('E13: a hub without the self-revoke endpoint (404) or an unreachable hub leaves previous_revoked false; 401 means already unusable', async t => {
  for (const [answer, expected] of [[404, ['not_revoked', false]], [500, ['not_revoked', false]], ['network', ['not_revoked', false]], [401, ['already_invalid', true]]] as const) {
    const { deps } = connectDeps(t);
    await connectAgentClient(deps);
    const logged: string[] = [];
    const again = connectDeps(t, { userData: deps.userData, homeDir: deps.homeDir, log: message => { logged.push(message); } });
    const base = again.deps.fetch!;
    again.deps.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/redeem')) return new Response(JSON.stringify({ data: { token: `ss_command_${'m'.repeat(80)}` } }), { status: 201 });
      await base(input, init);
      if (answer === 'network') throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: answer, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const result = await connectAgentClient(again.deps);
    assert.deepEqual([result.previous_status, result.previous_revoked], expected, String(answer));
    assert.equal(result.configured, 'config_file', 'the new connection is configured either way');
    assert.equal(readRelayConfig(deps.userData)?.connection_id, CONN);
    if (expected[0] === 'not_revoked') assert.ok(logged.includes('previous agent connection not revoked'));
  }
});

test('the loopback hand-back rejects a wrong state and unknown fields, and accepts the real one once', async () => {
  const controller = new AbortController();
  let target = '';
  const grant = loopbackGrant({ path: '/smartsell-agent', signal: controller.signal, timeoutMs: 5000, url: (port, state) => `http://127.0.0.1:${port}/x?state=${state}`,
    openExternal: async url => { target = url; },
    validate: params => (params.get('workspace') === WS && [...params.keys()].every(key => key === 'workspace') ? { workspace: WS } : undefined) });
  while (!target) await new Promise(resolve => setTimeout(resolve, 5));
  const url = new URL(target);
  const state = url.searchParams.get('state')!;
  const post = (body: string, origin = url.origin) => fetch(`${url.origin}/smartsell-agent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body });
  assert.equal((await fetch(`${url.origin}/smartsell-agent`)).status, 200);
  assert.equal((await post(`workspace=${WS}&state=wrong`)).status, 400);
  assert.equal((await post(`workspace=${WS}&state=${state}&extra=1`)).status, 400);
  assert.equal((await post(`workspace=${WS}&state=${state}`, 'http://evil.example')).status, 403);
  assert.equal((await post(`workspace=${WS}&state=${state}`)).status, 200);
  assert.deepEqual(await grant, { workspace: WS });
});

test('agent mode: without a connection it waits; after connecting it subscribes to alerts and serves the hand-off socket', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sa-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userData = join(root, 'ud');
  mkdirSync(join(userData, 'agent-relay'), { recursive: true });
  const shown: string[] = [];
  const notifier = new Notifier({ supported: () => true, open: () => {}, create: options => ({ show() { shown.push(options.title); }, on() {} }) });
  const settings = appSettings(join(userData, 'settings.json'));
  const fetched: string[] = [];
  const shell = new AgentShell({
    userData, platform: 'darwin', hostname: 'Laptop', execPath: '/Apps/SmartSell Worker', homeDir: join(root, 'home'), socketPath: join(userData, 'agent-relay', 'ipc.sock'),
    notifier, hold: () => {}, settings, openExternal: async () => {}, which: async () => null, run: async () => ({ code: 0, stdout: '', stderr: '' }),
    bundledRelayScript: null, onChange: () => {}, log: () => {},
    fetch: (async (input: string | URL) => { fetched.push(String(input)); return new Response(': connected\nretry: 2000\nid: 5\n\n', { headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch,
    connect: async deps => {
      writeFileSync(relayFiles(deps.userData).credential, `${TOKEN}\n`, { mode: 0o600 });
      writeFileSync(relayFiles(deps.userData).config, JSON.stringify({ hub_origin: deps.hubOrigin, workspace_id: WS, connection_id: CONN, client: deps.client }), { mode: 0o600 });
      return { client: deps.client, workspace_id: WS, connection_id: CONN, configured: 'config_file', manual_command: null, previous_revoked: null, previous_status: null, codex_backup: null, restart_hint: 'x' };
    },
  });
  await shell.start();
  t.after(() => shell.stop());
  assert.equal(shell.snapshot().handoff_listening, true);
  assert.equal(shell.snapshot().alerts_state, 'idle');
  await assert.rejects(shell.connect('codex'), /中樞位址/);
  shell.setHub('https://hub.tail1234.ts.net/app');
  await shell.connect('codex');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fetched[0], 'https://hub.tail1234.ts.net/api/v1/agent/alerts/stream');
  assert.equal(shell.snapshot().connected_client, 'codex');
  assert.equal(settings.load().role, 'agent');
});
