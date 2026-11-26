// Phase 1 end-to-end stack (phase1-design §10.2, `startStack(opts)`):
//   1. a temporary hubDir and the hub as a child process: SMARTSELL_MODE=hub (production semantics) with NODE_ENV=test,
//      SMARTSELL_HUB_TEST_HTTP=1, PUBLIC_ORIGIN=http://127.0.0.1:<p>, a test APP_SECRET / SETUP_TOKEN and the SMARTSELL_TEST_*
//      timing knobs;
//   2. the fixture platforms (startPlatformFixtures) and a fake ntfy server;
//   3. the owner through the setup API, workspace time zone Asia/Shanghai, ntfy push, two pairing codes;
//   4. two headless runners, "Mac-B" and "Win-C", each with its own data dir and headless Chrome, each behind a TCP
//      proxy so `partition(name, on)` cuts only that machine off;
//   5. add-channel: Mac-B adds X (fixture_x), Win-C adds TikTok (fixture_tt);
//   6. owner REST: direct approval, browser_auto with risk_ack, TikTok defaults, lateness_limit_min=3;
//   7. an agent connection (hub_v1), the MCP client over StdioClientTransport spawning the real relay bundle, and the
//      owner-alert stream subscribed with the same token;
//   8. the ffmpeg test video.
// Nothing here talks to a real platform or push service: every origin is loopback.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { RISK_TERMS_VERSION } from '../../packages/contracts/src/index.ts';
import { startPlatformFixtures, type FixtureOptions, type PlatformFixtures } from '../fixtures/platforms/server.ts';
import { subscribeAlerts, alertText, type AlertRecorder, type StreamedAlert } from './alerts.ts';
import { readHubRecords, type HubRecords } from './hub-records.ts';
import { startFakeNtfy, type FakeNtfy } from './ntfy.ts';
import { startTcpProxy, type TcpProxy } from './proxy.ts';
import { e2eClip, repoRoot, type TestMedia } from './video.ts';
import { guardSocketTypeOfService } from '../../apps/connector/src/socket-guard.ts';
import { launchOwnerChrome, type OwnerChrome } from '../connector-desktop/own-chrome-browser.ts';

// The test process also fetches from a hub that gets killed (alert stream, REST): same Node/undici guard as the Worker.
guardSocketTypeOfService();

export type MachineName = 'Mac-B' | 'Win-C';
export type Provider = 'x' | 'tiktok';
export type Data = Record<string, unknown>;

export const WORKSPACE_TZ = 'Asia/Shanghai';
export const HANDLES: Record<Provider, string> = { x: 'fixture_x', tiktok: 'fixture_tt' };
export const MACHINE_OF: Record<Provider, MachineName> = { x: 'Mac-B', tiktok: 'Win-C' };
export const TIKTOK_DEFAULTS = { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false };

/** §10.2 "時間的處理": the shortened schedules every stack runs with. */
export const TIMING = { prepareLeadSec: 30, readbackScheduleSec: [5, 10, 20], offlineStalenessSec: 120, unreportedGraceSec: 30, latenessMin: 3 } as const;

const chromeCandidates = [process.env.SMARTSELL_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
export const chromePath = chromeCandidates.find((path): path is string => !!path && existsSync(path));
const ffprobeDirs = ['/opt/homebrew/bin', '/usr/local/bin'].filter(dir => existsSync(join(dir, 'ffprobe')));
/** Why the stack cannot start on this machine, or undefined. Test files skip with this reason (reported as skipped). */
export const stackUnavailable = !chromePath ? 'Google Chrome is not installed (set SMARTSELL_CHROME_PATH)' : undefined;

export async function until<T>(check: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs: number, label: string, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  let lastValue: unknown;
  while (Date.now() < deadline) {
    try { const value = await check(); lastValue = value; if (value) return value as T; } catch (error) { last = error; }
    await sleep(everyMs);
  }
  assert.fail(`timed out after ${timeoutMs} ms waiting for ${label}${last ? `: ${String(last)}` : ''}${lastValue !== undefined ? ` (last value ${JSON.stringify(lastValue)?.slice(0, 600)})` : ''}`);
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function sleepUntil(at: number) { const delay = at - Date.now(); if (delay > 0) await sleep(delay); }

/** 'YYYY-MM-DD HH:mm' wall-clock time in `zone` (what post_schedule.when takes). */
export function localWhen(ms: number, zone = WORKSPACE_TZ) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
/** The first whole minute at least `leadMs` from now: `when` has minute precision, so T is a minute boundary. */
export function slotAfter(leadMs: number) { return Math.ceil((Date.now() + leadMs) / 60_000) * 60_000; }

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
  });
}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: Data, message: string) { super(message); }
  get code() { return String(((this.body.error ?? {}) as Data).code ?? this.body.code ?? ''); }
}
export { HttpError };

export interface McpCall { tool: string; args: Data; isError: boolean; code: string | null; bytes: number; at: string }
export interface McpResult<T = Data> { ok: boolean; data: T; error: { code: string; message: string; details?: Data } | null; bytes: number; raw: unknown }

export interface Machine {
  name: MachineName; dataDir: string; proxy: TcpProxy; deviceId: string;
  /** Successful heartbeats seen in the runner's own event log (`connection` events with state online). */
  heartbeats: number[];
  /** Failed heartbeats (`connection` events with state reconnecting). */
  failures: number[];
  process: ChildProcess | null;
}
export interface Channel { id: string; provider: Provider; handle: string; machine: MachineName; label: string }

export interface StackOptions {
  name: string;
  latenessMin?: number;
  fixtures?: FixtureOptions;
  hubEnv?: Record<string, string>;
  runnerEnv?: Record<string, string>;
  /** Skip the 30 MB clip (E2E-11 brings its own file). */
  clip?: boolean;
  /**
   * Own-Chrome mode (core-automation-proposal §3.2): each machine posts in a stand-in for the owner's own Chrome
   * (Playwright Chromium with the real SmartSell extension) instead of a per-channel Chrome profile.
   */
  ownChrome?: boolean;
}

export interface Stack {
  readonly name: string;
  readonly dir: string;
  /** Hub, runner, relay and stack logs; kept after close. */
  readonly logDir: string;
  readonly origin: string;
  readonly workspaceId: string;
  readonly fixtures: PlatformFixtures;
  readonly ntfy: FakeNtfy;
  readonly alerts: AlertRecorder;
  readonly machines: Record<MachineName, Machine>;
  readonly channels: Record<Provider, Channel>;
  readonly video: TestMedia | null;
  readonly mediaDir: string;
  readonly agentToken: string;
  readonly mcpCalls: McpCall[];
  log(line: string): void;
  /** Owner (session cookie + CSRF) REST call under /api/v1/workspaces/:ws. Throws HttpError unless 2xx. */
  rest<T = Data>(method: string, path: string, body?: Data, headers?: Record<string, string>): Promise<T>;
  /** Same, but returns the status and parsed body without throwing. */
  restRaw(method: string, path: string, body?: Data, headers?: Record<string, string>): Promise<{ status: number; body: Data }>;
  view<T = Data>(path: string): Promise<T>;
  mcp<T = Data>(tool: string, args: Data, options?: { timeoutMs?: number; onprogress?: (progress: { progress: number; total?: number }) => void }): Promise<McpResult<T>>;
  /** Reconnect the MCP client (a fresh relay process). */
  reconnectMcp(): Promise<void>;
  killRelay(): void;
  partition(name: MachineName, on: boolean): void;
  hubRunning(): boolean;
  killHub(signal?: NodeJS.Signals): Promise<void>;
  startHub(): Promise<void>;
  stopRunner(name: MachineName): Promise<void>;
  startRunner(name: MachineName): Promise<void>;
  /** Resolves after the next successful heartbeat of `name` that started after this call. */
  nextHeartbeat(name: MachineName, timeoutMs?: number): Promise<number>;
  /** The hub's records; only while the hub is stopped (see hub-records.ts). */
  records(): HubRecords;
  /** Alert on the agent stream for this post (or channel) whose text names the machine and the @handle. */
  ownerAlert(kind: string, provider: Provider, match?: (alert: StreamedAlert) => boolean, timeoutMs?: number): Promise<StreamedAlert>;
  close(): Promise<void>;
}

const ownerPassword = () => `e2e-${randomBytes(12).toString('hex')}`;

export async function startStack(options: StackOptions): Promise<Stack> {
  if (!chromePath) throw new Error(stackUnavailable);
  const startedAt = Date.now();
  const dir = mkdtempSync(join(tmpdir(), `ss-e2e-${options.name}-`));
  const hubDir = join(dir, 'hub');
  const home = join(dir, 'home');
  const mediaDir = join(dir, 'media');
  const agentDir = join(dir, 'agent');
  // Logs outlive the stack (the temp dir is removed on close) and stay out of test-results/, which Playwright empties.
  const logDir = join(tmpdir(), 'smartsell-e2e-phase1-logs', `${options.name}-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}`);
  for (const path of [hubDir, home, mediaDir, agentDir, logDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const logFile = createWriteStream(join(logDir, 'stack.log'));
  const log = (line: string) => { logFile.write(`${new Date().toISOString()} ${line}\n`); };
  const files: WriteStream[] = [logFile];
  const fileLog = (name: string) => { const stream = createWriteStream(join(logDir, name), { flags: 'a' }); files.push(stream); return stream; };

  // Minimal Web build and a fake Tailscale CLI: the hub's startup checks need both, the test never runs the real CLI.
  const dist = join(dir, 'web-dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SmartSell</title><div id="root"></div>');
  const fakeTailscale = join(dir, 'fake-tailscale');
  writeFileSync(fakeTailscale, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const appSecret = randomBytes(32).toString('hex');
  const setupToken = randomBytes(32).toString('hex');
  const basePath = [...ffprobeDirs, process.env.PATH ?? ''].join(':');
  const baseEnv = { PATH: basePath, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: 'C.UTF-8' };
  const hubEnv: NodeJS.ProcessEnv = {
    ...baseEnv, NODE_ENV: 'test', SMARTSELL_HUB_TEST_HTTP: '1', SMARTSELL_HUB_DIR: hubDir, PUBLIC_ORIGIN: origin, PORT: String(port),
    APP_SECRET: appSecret, SETUP_TOKEN: setupToken, SMARTSELL_WEB_DIST: dist, SMARTSELL_TAILSCALE_CLI: fakeTailscale,
    SMARTSELL_TEST_PREPARE_LEAD_SEC: String(TIMING.prepareLeadSec), SMARTSELL_TEST_READBACK_SCHEDULE_SEC: TIMING.readbackScheduleSec.join(','),
    SMARTSELL_TEST_OFFLINE_STALENESS_SEC: String(TIMING.offlineStalenessSec), SMARTSELL_TEST_UNREPORTED_GRACE_SEC: String(TIMING.unreportedGraceSec),
    ...options.hubEnv,
  };

  let hub: ChildProcess | null = null;
  const hubLog = fileLog('hub.log');
  async function startHub() {
    assert.equal(hub, null, 'hub already running');
    const child = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'apps/server/hub.ts'), '--hub-dir', hubDir],
      { cwd: repoRoot, env: hubEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    hub = child;
    let output = '';
    child.stdout!.on('data', chunk => { hubLog.write(chunk); output = (output + chunk).slice(-8000); });
    child.stderr!.on('data', chunk => { hubLog.write(chunk); output = (output + chunk).slice(-8000); });
    child.once('exit', code => { log(`hub exited ${code}`); if (hub === child) hub = null; });
    log('hub starting');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`hub exited during startup:\n${output}`);
      if (await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false)) { log('hub ready'); return; }
      await sleep(250);
    }
    throw new Error(`hub did not become ready:\n${output}`);
  }
  async function killHub(signal: NodeJS.Signals = 'SIGKILL') {
    const child = hub;
    if (!child) return;
    log(`hub ${signal}`);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill(signal);
    await Promise.race([exited, sleep(30_000).then(() => { child.kill('SIGKILL'); return exited; })]);
    hub = null;
  }

  const fixtures = await startPlatformFixtures({ uploadMs: 800, xProcessingMs: 800, ...options.fixtures });
  const ntfy = await startFakeNtfy();
  await startHub();

  // ---------- owner ----------
  const setup = await fetch(`${origin}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-setup-token': setupToken },
    body: JSON.stringify({ username: 'owner', password: ownerPassword(), workspaceName: `E2E ${options.name}` }) });
  assert.equal(setup.status, 201, await setup.clone().text());
  const session = ((await setup.json()) as { data: { csrf_token?: string; workspaces: { id: string }[] } }).data;
  const cookie = String(setup.headers.get('set-cookie')).split(';')[0];
  const csrf = session.csrf_token ?? ((await (await fetch(`${origin}/api/v1/session/csrf`, { headers: { cookie, origin } })).json()) as { csrf_token: string }).csrf_token;
  const workspaceId = session.workspaces[0].id;
  const owner = { cookie, 'x-csrf-token': csrf, origin };

  async function restRaw(method: string, path: string, body?: Data, headers: Record<string, string> = {}) {
    const response = await fetch(`${origin}/api/v1/workspaces/${workspaceId}${path}`, {
      method, headers: { ...owner, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: Data = {};
    try { parsed = text ? JSON.parse(text) as Data : {}; } catch { parsed = { text }; }
    return { status: response.status, body: parsed };
  }
  async function rest<T = Data>(method: string, path: string, body?: Data, headers: Record<string, string> = {}): Promise<T> {
    const { status, body: parsed } = await restRaw(method, path, body, headers);
    if (status < 200 || status >= 300) throw new HttpError(status, parsed, `${method} ${path} → ${status}: ${JSON.stringify(parsed).slice(0, 800)}`);
    return (parsed.data ?? parsed) as T;
  }
  const view = <T = Data>(path: string) => rest<T>('GET', path);

  const workspace = await rest<Data>('GET', '');
  const version: Record<string, string> = typeof workspace.version === 'number' && workspace.version > 0 ? { 'if-match': `"${workspace.version}"` } : {};
  await rest('PATCH', '', { default_timezone: WORKSPACE_TZ }, version);
  await rest('PUT', '/hub/alerts/channels', { channels: [{ kind: 'ntfy', url: ntfy.topicUrl }] });

  // ---------- machines ----------
  const runnerEnv: NodeJS.ProcessEnv = {
    ...baseEnv, SMARTSELL_TEST_MODE: '1', SMARTSELL_CHROME_PATH: chromePath, SMARTSELL_TEST_PLATFORM_ORIGINS: JSON.stringify(fixtures.origins),
    SMARTSELL_TEST_PREPARE_LEAD_SEC: String(TIMING.prepareLeadSec), SMARTSELL_TEST_READBACK_SCHEDULE_SEC: TIMING.readbackScheduleSec.join(','),
    SMARTSELL_TEST_OFFLINE_STALENESS_SEC: String(TIMING.offlineStalenessSec),
    ...(options.ownChrome && { SMARTSELL_BROWSER: 'own_chrome' }),
    ...options.runnerEnv,
  };
  const ownerChromes: OwnerChrome[] = [];
  const runnerScript = join(repoRoot, 'apps/connector-desktop/src/headless/runner.ts');
  async function runCli(args: string[], label: string): Promise<Data[]> {
    const out = fileLog(`${label}.log`);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerScript, ...args], { cwd: repoRoot, env: runnerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: Data[] = [];
    let buffer = '';
    child.stdout!.on('data', chunk => {
      out.write(chunk);
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { lines.push(JSON.parse(line)); } catch { /* not JSON */ } }
    });
    child.stderr!.on('data', chunk => out.write(chunk));
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    if (code !== 0) throw new Error(`runner ${args.join(' ')} exited ${code}: ${JSON.stringify(lines.slice(-5))}`);
    return lines;
  }

  const machines = {} as Record<MachineName, Machine>;
  for (const name of ['Mac-B', 'Win-C'] as const) {
    const proxy = await startTcpProxy({ host: '127.0.0.1', port: () => port });
    const dataDir = join(dir, name.toLowerCase());
    const code = await rest<Data>('POST', '/devices/pairing-codes', { owned_device_confirmed: true, allow_channel_registration: true });
    const lines = await runCli(['--data-dir', dataDir, '--name', name, 'pair', '--hub', proxy.origin, '--workspace', workspaceId, '--code', String(code.pairing_code),
      '--platform', name === 'Mac-B' ? 'darwin' : 'win32'], `${name}-pair`);
    const paired = lines.find(line => line.event === 'paired');
    assert.ok(paired, `${name} paired`);
    machines[name] = { name, dataDir, proxy, deviceId: String(paired.device_id), heartbeats: [], failures: [], process: null };
    if (options.ownChrome) ownerChromes.push(await launchOwnerChrome(dataDir));
  }
  const channels = {} as Record<Provider, Channel>;
  for (const provider of ['x', 'tiktok'] as const) {
    const machine = machines[MACHINE_OF[provider]];
    const lines = await runCli(['--data-dir', machine.dataDir, 'add-channel', '--provider', provider], `${machine.name}-add-${provider}`);
    const registered = lines.find(line => line.event === 'channel_registered');
    const registration = (registered?.registrations as Data[] | undefined)?.[0];
    assert.ok(registration?.resource_id, `${provider} channel registered: ${JSON.stringify(lines.slice(-3))}`);
    assert.equal(registration.device_id, machine.deviceId);
    channels[provider] = { id: String(registration.resource_id), provider, handle: HANDLES[provider], machine: machine.name,
      label: `${provider === 'x' ? 'X' : 'TikTok'} @${HANDLES[provider]}` };
  }

  // ---------- owner channel settings (person-only REST) ----------
  for (const channel of Object.values(channels)) {
    const detail = await view<{ settings: { version: number } }>(`/views/channels/${channel.id}`);
    await rest('PATCH', `/hub/channels/${channel.id}/settings`, {
      approval_mode: 'direct', execution_mode: 'browser_auto', lateness_limit_min: options.latenessMin ?? TIMING.latenessMin,
      ...(channel.provider === 'tiktok' && { platform_defaults: { tiktok: TIKTOK_DEFAULTS } }),
    }, { 'if-match': `"${detail.settings.version}"` });
    const ack = await rest<Data>('POST', `/hub/channels/${channel.id}/risk-ack`, { terms_version: RISK_TERMS_VERSION, typed_handle: `@${channel.handle}` });
    assert.equal(ack.effective_mode, 'auto', `${channel.label} runs in auto mode`);
  }

  // ---------- agent connection, alerts, MCP ----------
  const connection = await rest<Data>('POST', '/agent-connections', { client: 'codex', label: `E2E ${options.name}`, expires_days: 30 });
  const agentToken = String(connection.token);
  const tokenFile = join(agentDir, 'token');
  writeFileSync(tokenFile, agentToken, { mode: 0o600 });
  const alerts = subscribeAlerts(origin, agentToken, line => log(line));
  await until(() => alerts.connected, 20_000, 'alert stream connected');

  const relayBundle = join(repoRoot, 'packages/agent-relay/dist/smartsell-relay.mjs');
  assert.ok(existsSync(relayBundle), 'relay bundle is built (pnpm --filter @smartsell/agent-relay build)');
  const relayLog = fileLog('relay.log');
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  async function connectMcp() {
    transport = new StdioClientTransport({ command: process.execPath, args: [relayBundle, '--hub', origin, '--token-file', tokenFile],
      env: { ...baseEnv }, cwd: mediaDir, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => relayLog.write(chunk));
    client = new Client({ name: 'smartsell-e2e', version: '1.0.0' });
    await client.connect(transport);
  }
  await connectMcp();
  const tools = await client!.listTools();
  assert.equal(tools.tools.length, 11, `tools/list shows the 11 hub tools: ${tools.tools.map(tool => tool.name).join(', ')}`);

  const mcpCalls: McpCall[] = [];
  async function mcp<T = Data>(tool: string, args: Data, opts: { timeoutMs?: number; onprogress?: (progress: { progress: number; total?: number }) => void } = {}): Promise<McpResult<T>> {
    const raw = await client!.callTool({ name: tool, arguments: args }, undefined,
      { timeout: opts.timeoutMs ?? 180_000, ...(opts.onprogress && { onprogress: opts.onprogress, resetTimeoutOnProgress: true }) });
    const bytes = Buffer.byteLength(JSON.stringify(raw));
    const content = (raw.content as { type: string; text?: string }[] | undefined) ?? [];
    let parsed: Data = {};
    try { parsed = content[0]?.text ? JSON.parse(content[0].text) as Data : {}; } catch { parsed = { text: content[0]?.text }; }
    const isError = raw.isError === true;
    const error = isError ? (parsed.error as McpResult['error']) ?? { code: 'UNKNOWN', message: content[0]?.text ?? '' } : null;
    const data = (isError ? parsed : (raw.structuredContent as Data | undefined) ?? parsed) as T;
    mcpCalls.push({ tool, args, isError, code: error?.code ?? null, bytes, at: new Date().toISOString() });
    log(`mcp ${tool} ${JSON.stringify(args).slice(0, 300)} → ${isError ? `error ${error?.code}` : 'ok'} (${bytes} bytes)`);
    return { ok: !isError, data, error, bytes, raw };
  }

  // ---------- runners ----------
  function attachRunner(machine: Machine, child: ChildProcess) {
    const out = fileLog(`${machine.name}-run.log`);
    let buffer = '';
    child.stdout!.on('data', chunk => {
      out.write(chunk);
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const event = JSON.parse(line) as Data;
          const detail = event.detail as Data | undefined;
          if (event.event === 'connection' && detail?.state === 'online') machine.heartbeats.push(Date.now());
          if (event.event === 'connection' && detail?.state === 'reconnecting') machine.failures.push(Date.now());
        } catch { /* not JSON */ }
      }
    });
    child.stderr!.on('data', chunk => out.write(chunk));
    child.once('exit', code => { log(`${machine.name} runner exited ${code}`); if (machine.process === child) machine.process = null; });
  }
  async function startRunner(name: MachineName) {
    const machine = machines[name];
    assert.equal(machine.process, null, `${name} already running`);
    const since = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', runnerScript, '--data-dir', machine.dataDir, 'run'], { cwd: repoRoot, env: runnerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    machine.process = child;
    attachRunner(machine, child);
    log(`${name} runner started`);
    if (!machine.proxy.partitioned && hub) await until(() => machine.heartbeats.some(at => at >= since), 60_000, `${name} first heartbeat`, 200);
  }
  async function stopRunner(name: MachineName) {
    const machine = machines[name];
    const child = machine.process;
    if (!child) return;
    log(`${name} runner stopping`);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(30_000).then(() => { child.kill('SIGKILL'); return exited; })]);
    machine.process = null;
  }
  async function nextHeartbeat(name: MachineName, timeoutMs = 45_000) {
    const since = Date.now();
    return until(() => machines[name].heartbeats.find(at => at > since), timeoutMs, `${name} heartbeat`, 200);
  }
  await startRunner('Mac-B');
  await startRunner('Win-C');

  const video = options.clip === false ? null : await e2eClip(mediaDir);
  log(`stack ready in ${Date.now() - startedAt} ms: ${origin} workspace ${workspaceId}`);

  let closed = false;
  return {
    name: options.name, dir, logDir, origin, workspaceId, fixtures, ntfy, alerts, machines, channels, video, mediaDir, agentToken, mcpCalls,
    log, rest, restRaw, view, mcp,
    async reconnectMcp() { await client?.close().catch(() => {}); await connectMcp(); },
    killRelay() { const pid = transport?.pid; if (pid) process.kill(pid, 'SIGKILL'); },
    partition(name, on) { log(`partition ${name} ${on}`); machines[name].proxy.partition(on); },
    hubRunning: () => hub !== null,
    killHub, startHub, stopRunner, startRunner, nextHeartbeat,
    records() {
      assert.equal(hub, null, 'stop the hub before reading its records');
      return readHubRecords(join(hubDir, 'smartsell.sqlite'));
    },
    async ownerAlert(kind, provider, match = () => true, timeoutMs = 60_000) {
      const channel = channels[provider];
      return alerts.waitFor(alert => alert.kind === kind && alert.channel?.id === channel.id && match(alert)
        && alertText(alert).includes(channel.machine) && alertText(alert).includes(`@${channel.handle}`), timeoutMs,
      `${kind} naming ${channel.machine} and @${channel.handle}`);
    },
    async close() {
      if (closed) return;
      closed = true;
      alerts.close();
      await client?.close().catch(() => {});
      await Promise.all((['Mac-B', 'Win-C'] as const).map(name => stopRunner(name).catch(() => {})));
      await killHub('SIGTERM').catch(() => {});
      for (const chrome of ownerChromes) await chrome.close();
      await fixtures.close().catch(() => {});
      await ntfy.close().catch(() => {});
      for (const machine of Object.values(machines)) await machine.proxy.close().catch(() => {});
      log(`mcp calls: ${JSON.stringify(mcpCalls.map(call => [call.tool, call.code]))}`);
      for (const file of files) file.end();
      if (process.env.SMARTSELL_E2E_KEEP !== '1') rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** A per-run marker so captions (and so fixture posts) are unique across cases and reruns. */
export const marker = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
