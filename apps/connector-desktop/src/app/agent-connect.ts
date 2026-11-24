// 「連接 Codex／Claude Code」 in the laptop App (§6.2). The browser enrols an
// agent connection on the hub and hands the one-time code back to this App
// over the loopback page; the App redeems it, stores the token (0600) and
// config.json in <userData>/agent-relay/, and points the client at
// `"<process.execPath>" --mcp-relay` (Windows: `node smartsell-relay.mjs`).
// The owner's approval settings and AGENTS.md are never touched (B04); the
// server name is always `smartsell` (B09); the label carries the host name.
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loopbackGrant } from './loopback-grant.ts';
import { relayDataDir, RELAY_FLAG } from './relay-mode.ts';

export type AgentClient = 'codex' | 'claude_code';
export interface AgentRelayConfig { hub_origin: string; workspace_id: string; connection_id: string | null; client: AgentClient }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_-]{100,512}$/;
const TOKEN = /^ss_command_[A-Za-z0-9_-]{60,500}$/;
export const CALLBACK_PATH = '/smartsell-agent';
export const MARK_BEGIN = '# >>> smartsell (managed by SmartSell Worker)';
export const MARK_END = '# <<< smartsell';

export function relayFiles(userData: string) {
  const dir = relayDataDir(userData);
  return { dir, config: join(dir, 'config.json'), credential: join(dir, 'credential'), script: join(dir, 'smartsell-relay.mjs'), cursor: join(dir, 'alerts-cursor') };
}

function writePrivate(path: string, text: string, platform: NodeJS.Platform) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    if (platform !== 'win32') chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function readRelayConfig(userData: string): AgentRelayConfig | null {
  try {
    const value = JSON.parse(readFileSync(relayFiles(userData).config, 'utf8')) as Partial<AgentRelayConfig>;
    if (typeof value.hub_origin !== 'string' || typeof value.workspace_id !== 'string' || (value.client !== 'codex' && value.client !== 'claude_code')) return null;
    return { hub_origin: value.hub_origin, workspace_id: value.workspace_id, connection_id: typeof value.connection_id === 'string' ? value.connection_id : null, client: value.client };
  } catch { return null; }
}

export function readRelayToken(userData: string): string | null {
  try {
    const token = readFileSync(relayFiles(userData).credential, 'utf8').trim();
    return TOKEN.test(token) ? token : null;
  } catch { return null; }
}

export function writeRelayFiles(userData: string, config: AgentRelayConfig, token: string, platform: NodeJS.Platform) {
  if (!TOKEN.test(token)) throw new Error('中樞回傳的憑證格式不正確。');
  const files = relayFiles(userData);
  writePrivate(files.credential, `${token}\n`, platform);
  writePrivate(files.config, `${JSON.stringify(config, null, 2)}\n`, platform);
  return files;
}

/** Codex's `[mcp_servers.smartsell]` block, between markers so a reconnect replaces it (§6.2 step 4). */
export function codexManagedBlock(command: string, args: readonly string[]) {
  return [MARK_BEGIN, '[mcp_servers.smartsell]', `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify(args)}`,
    'startup_timeout_sec = 20', 'tool_timeout_sec = 120', MARK_END].join('\n');
}

const SMARTSELL_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:smartsell|"smartsell"|'smartsell')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const MCP_SERVERS_TABLE = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/;
const TABLE_HEADER = /^\s*\[/;
/** `smartsell = {…}` (inline table) or `smartsell.command = …` (dotted keys) inside `[mcp_servers]`. */
const SMARTSELL_KEY_IN_SERVERS = /^\s*(?:smartsell|"smartsell"|'smartsell')\s*[.=]/;
/** `mcp_servers.smartsell… = …` at the root of the file (before any table header). */
const SMARTSELL_KEY_AT_ROOT = /^\s*mcp_servers\s*\.\s*(?:smartsell|"smartsell"|'smartsell')\s*[.=]/;

/**
 * Replaces our managed block and every other definition of the `smartsell` server (a `[mcp_servers.smartsell]`
 * table with its sub-tables, an inline `smartsell = {…}` or dotted `smartsell.x = …` keys under `[mcp_servers]`, or
 * root-level `mcp_servers.smartsell.x = …` keys), so the file never defines the server twice (Codex refuses a
 * duplicate key). Every other line of config.toml is kept byte for byte, with the file's own line endings.
 */
export function upsertCodexConfig(existing: string, block: string) {
  const eol = /\r\n/.test(existing) ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const out: string[] = [];
  let skipping: 'managed' | 'table' | null = null;
  let table: 'root' | 'mcp_servers' | 'other' = 'root';
  for (const line of lines) {
    if (skipping === 'managed') { if (line.trim() === MARK_END) skipping = null; continue; }
    if (line.trim() === MARK_BEGIN) { skipping = 'managed'; continue; }
    if (skipping === 'table') {
      if (TABLE_HEADER.test(line) && !SMARTSELL_TABLE.test(line)) skipping = null;
      else continue;
    }
    if (SMARTSELL_TABLE.test(line)) { skipping = 'table'; continue; }
    if (TABLE_HEADER.test(line)) table = MCP_SERVERS_TABLE.test(line) ? 'mcp_servers' : 'other';
    else if ((table === 'mcp_servers' && SMARTSELL_KEY_IN_SERVERS.test(line)) || (table === 'root' && SMARTSELL_KEY_AT_ROOT.test(line))) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  const managed = block.split(/\r?\n/).join(eol);
  return `${out.length ? `${out.join(eol)}${eol}${eol}` : ''}${managed}${eol}`;
}

/** `config.toml.smartsell-backup-20261124T081500Z` (a counter is appended when one already exists for that second). */
export function codexBackupPath(path: string, now: Date, exists: (candidate: string) => boolean = existsSync) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  for (let index = 0; ; index++) {
    const candidate = `${path}.smartsell-backup-${stamp}${index ? `-${index}` : ''}`;
    if (!exists(candidate)) return candidate;
  }
}

/**
 * E12: writes the marked `[mcp_servers.smartsell]` block into ~/.codex/config.toml. An existing file is first copied
 * to a timestamped backup next to it (0600: the file can hold other servers' tokens) and the rewrite keeps its mode.
 * Nothing is written when the file already holds exactly this block.
 */
export function writeCodexConfig(path: string, block: string, platform: NodeJS.Platform, now = new Date()): { changed: boolean; backup: string | null } {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const next = upsertCodexConfig(existing ?? '', block);
  if (existing === next) return { changed: false, backup: null };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let backup: string | null = null;
  let mode = 0o600;
  if (existing !== null) {
    mode = statSync(path).mode & 0o777;
    backup = codexBackupPath(path, now);
    writeFileSync(backup, existing, { mode: 0o600, flag: 'wx' });
    if (platform !== 'win32') chmodSync(backup, 0o600);
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { mode, flag: 'wx' });
    if (platform !== 'win32') chmodSync(temp, mode);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  return { changed: true, backup };
}

export function relayCommand(platform: NodeJS.Platform, execPath: string, userData: string): { command: string; args: string[] } {
  const files = relayFiles(userData);
  if (platform === 'win32') return { command: 'node', args: [files.script, '--config', files.config] };
  return { command: execPath, args: [RELAY_FLAG] };
}

export function claudeCommandLine(command: string, args: readonly string[]) {
  const quote = (value: string) => /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  return `claude mcp add --scope user smartsell -- ${[command, ...args].map(quote).join(' ')}`;
}

export interface ConnectDeps {
  hubOrigin: string;
  client: AgentClient;
  /** `<hostname> · Codex` (B08). */
  hostname: string;
  userData: string;
  execPath: string;
  platform: NodeJS.Platform;
  homeDir: string;
  openExternal(url: string): Promise<void>;
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** Finds an executable on PATH (`codex`, `claude`). */
  which(command: string): Promise<string | null>;
  run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** The relay bundle shipped with the App (Windows Node relay). */
  bundledRelayScript?: string | null;
  grant?: typeof loopbackGrant;
  log?(message: string, detail?: object): void;
}

export interface ConnectResult {
  client: AgentClient; workspace_id: string; connection_id: string | null;
  configured: 'config_file' | 'cli' | 'manual'; manual_command: string | null;
  /** true: the previous connection can no longer be used (see previous_status); false: it may still be live; null: there was none. */
  previous_revoked: boolean | null;
  previous_status: PreviousConnectionStatus | null;
  /** E12: the backup of ~/.codex/config.toml written before the managed block was changed. */
  codex_backup: string | null;
  restart_hint: string;
}

export type PreviousConnectionStatus = 'revoked' | 'already_invalid' | 'not_revoked';

/**
 * E13: the previous connection revokes itself with its own Bearer token (`DELETE /api/v1/agent-connections/self`).
 * 2xx → 'revoked'; 401 → 'already_invalid' (the hub no longer accepts that token: revoked or expired earlier);
 * 404 (a hub without the endpoint), any other status or a network error → 'not_revoked': the owner revokes it on the web.
 */
export async function revokePreviousConnection(hubOrigin: string, token: string, request: typeof fetch, log?: ConnectDeps['log']): Promise<PreviousConnectionStatus> {
  try {
    const response = await request(new URL('/api/v1/agent-connections/self', hubOrigin), {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return 'revoked';
    if (response.status === 401) return 'already_invalid';
    log?.('previous agent connection not revoked', { status: response.status });
    return 'not_revoked';
  } catch (error) {
    log?.('previous agent connection not revoked', { error: String(error) });
    return 'not_revoked';
  }
}

export function hubOriginOf(input: string) {
  const url = URL.parse(input.trim());
  const loopback = url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!url || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('請貼上中樞位址，例如 https://hub.tail1234.ts.net。');
  }
  return url.origin;
}

export async function connectAgentClient(deps: ConnectDeps): Promise<ConnectResult> {
  const hubOrigin = hubOriginOf(deps.hubOrigin);
  const request = deps.fetch ?? fetch;
  const label = `${deps.hostname} · ${deps.client === 'codex' ? 'Codex' : 'Claude Code'}`.slice(0, 120);
  // 1–2. Browser enrolment, handed back over the loopback page.
  const grant = await (deps.grant ?? loopbackGrant)({
    path: CALLBACK_PATH, signal: deps.signal, openExternal: deps.openExternal,
    url: (port, state) => {
      const url = new URL('/agent-connect', hubOrigin);
      url.search = new URLSearchParams({ client: deps.client, port: String(port), state, label }).toString();
      return url.href;
    },
    validate: params => {
      const workspace = params.get('workspace') ?? '', code = params.get('code') ?? '', connection = params.get('connection');
      const allowed = new Set(['workspace', 'code', 'connection']);
      if ([...params.keys()].some(key => !allowed.has(key)) || !UUID.test(workspace) || !CODE.test(code) || (connection !== null && !UUID.test(connection))) return undefined;
      return { workspace: workspace.toLowerCase(), code, ...(connection && { connection: connection.toLowerCase() }) };
    },
  });
  // 3. Redeem the 10-minute code for the token.
  const response = await request(new URL(`/api/v1/workspaces/${grant.workspace}/agent-connections/redeem`, hubOrigin), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: grant.code }),
    redirect: 'error', signal: AbortSignal.any([deps.signal, AbortSignal.timeout(20_000)]),
  });
  const body = await response.json().catch(() => null) as { data?: { token?: unknown } } | null;
  const token = body?.data?.token;
  if (!response.ok || typeof token !== 'string') throw new Error(`中樞沒有接受這次連接（HTTP ${response.status}）。請重新按「連接」。`);

  // The previous connection of this laptop, read before its files are replaced (§6.2 step 5).
  const previous = readRelayConfig(deps.userData);
  const previousToken = readRelayToken(deps.userData);
  const config: AgentRelayConfig = { hub_origin: hubOrigin, workspace_id: grant.workspace, connection_id: grant.connection ?? null, client: deps.client };
  const files = writeRelayFiles(deps.userData, config, token, deps.platform);

  // 4. Client configuration.
  if (deps.platform === 'win32') await placeWindowsRelay(deps, files.script, hubOrigin, request);
  const { command, args } = relayCommand(deps.platform, deps.execPath, deps.userData);
  let configured: ConnectResult['configured'] = 'manual';
  let manual: string | null = null;
  let codexBackup: string | null = null;
  if (deps.client === 'codex') {
    const written = writeCodexConfig(join(deps.homeDir, '.codex', 'config.toml'), codexManagedBlock(command, args), deps.platform);
    codexBackup = written.backup;
    configured = 'config_file';
  } else {
    manual = claudeCommandLine(command, args);
    const claude = await deps.which('claude');
    if (claude) {
      await deps.run(claude, ['mcp', 'remove', '--scope', 'user', 'smartsell']).catch(() => undefined);
      const added = await deps.run(claude, ['mcp', 'add', '--scope', 'user', 'smartsell', '--', command, ...args]);
      if (added.code === 0) { configured = 'cli'; manual = null; }
      else deps.log?.('claude mcp add failed', { code: added.code, stderr: added.stderr.slice(0, 500) });
    }
  }

  // 5. Reconnecting the same laptop: only after the new connection is in place, the old one revokes itself (E13).
  let previousStatus: PreviousConnectionStatus | null = null;
  if (previousToken && previousToken !== token && previous?.hub_origin === hubOrigin) {
    previousStatus = await revokePreviousConnection(hubOrigin, previousToken, request, deps.log);
  }
  return {
    client: deps.client, workspace_id: grant.workspace, connection_id: config.connection_id, configured, manual_command: manual,
    previous_revoked: previousStatus === null ? null : previousStatus !== 'not_revoked', previous_status: previousStatus, codex_backup: codexBackup, restart_hint: `請重新開啟 ${deps.client === 'codex' ? 'Codex' : 'Claude Code'}，讓它載入 smartsell。`,
  };
}

async function placeWindowsRelay(deps: ConnectDeps, target: string, hubOrigin: string, request: typeof fetch) {
  if (deps.bundledRelayScript && existsSync(deps.bundledRelayScript)) { copyFileSync(deps.bundledRelayScript, target); return; }
  const response = await request(new URL('/agent/relay.mjs', hubOrigin), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const text = response.ok ? await response.text() : '';
  if (!text.startsWith('#!') && !text.includes('smartsell')) throw new Error('無法取得 relay 程式（GET /agent/relay.mjs）。請先在中樞執行 pnpm --filter @smartsell/agent-relay build。');
  writeFileSync(target, text);
}
