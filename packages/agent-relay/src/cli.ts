import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createHandoffClient, handoffSocketPath } from './handoff.ts';
import { RelayError, validateHubOrigin } from './hub-connection.ts';
import { runRelay, type RunRelayOptions } from './relay.ts';
import { guardSocketTypeOfService } from './socket-guard.ts';
import { RELAY_VERSION } from './version.ts';

export interface RelaySettings { hubOrigin: string; token: string; dataDir: string; configPath?: string; tokenFile: string }

const USAGE = `SmartSell relay ${RELAY_VERSION}
Usage: smartsell-relay [--mcp-relay] [--config <config.json>] [--hub <https origin>] [--token-file <path>]
  --config      config.json written by the SmartSell app ({"hub_origin", "workspace_id", "connection_id", "client"});
                the token is read from "credential" next to it unless --token-file is given.
  --hub         SmartSell hub origin, for example https://hub.tail1234.ts.net (overrides hub_origin).
  --token-file  File holding the agent connection token (mode 0600).
`;

export function parseRelayArgs(argv: readonly string[]) {
  const options: { config?: string; hub?: string; tokenFile?: string; help?: boolean; version?: boolean } = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new RelayError(`${arg} needs a value.\n${USAGE}`);
      return next;
    };
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    switch (flag) {
      case '--mcp-relay': break;
      case '--config': options.config = inline ?? value(); break;
      case '--hub': options.hub = inline ?? value(); break;
      case '--token-file': options.tokenFile = inline ?? value(); break;
      case '--help': case '-h': options.help = true; break;
      case '--version': options.version = true; break;
      default: throw new RelayError(`Unknown option ${arg}.\n${USAGE}`);
    }
  }
  return options;
}

/** Read a small relay file without following links; `secret` files must be owner-only on POSIX (0600). */
async function readRelayFile(path: string, limit: number, secret: boolean, platform: NodeJS.Platform) {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile()) throw new RelayError(`The relay file ${path} is missing or not a regular file.`, `找不到 relay 的設定或憑證檔（${path}）。請在 SmartSell App 重新連接 Codex／Claude Code。`);
  if (secret && platform !== 'win32' && ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
    throw new RelayError(`${path} must belong to you and be readable only by you (chmod 600).`, `${path} 的權限必須只有自己可讀（chmod 600）。`);
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit) throw new RelayError(`${path} is too large.`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

/** Resolve hub origin, token and data directory from the command line (§6.2 relay command line). */
export async function loadRelaySettings(argv: readonly string[], { defaultConfigPath, platform = process.platform }: { defaultConfigPath?: string; platform?: NodeJS.Platform } = {}): Promise<RelaySettings> {
  const args = parseRelayArgs(argv);
  const configPath = args.config ? resolve(args.config) : !args.hub && defaultConfigPath ? resolve(defaultConfigPath) : undefined;
  let hub = args.hub;
  if (configPath) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readRelayFile(configPath, 64 * 1024, false, platform)); }
    catch (error) { if (error instanceof RelayError) throw error; throw new RelayError(`${configPath} is not valid JSON.`, `relay 設定檔 ${configPath} 格式錯誤。請在 SmartSell App 重新連接。`); }
    const origin = (parsed as { hub_origin?: unknown } | null)?.hub_origin;
    if (!hub && typeof origin !== 'string') throw new RelayError(`${configPath} has no hub_origin.`, `relay 設定檔缺少中樞位址。請在 SmartSell App 重新連接。`);
    hub ??= origin as string;
  }
  if (!hub) throw new RelayError(`Pass --config, or --hub with --token-file.\n${USAGE}`);
  // Refuse to start for anything but https or loopback http (§6.2).
  const hubOrigin = validateHubOrigin(hub);
  const tokenFile = args.tokenFile ? resolve(args.tokenFile) : configPath ? resolve(dirname(configPath), 'credential') : undefined;
  if (!tokenFile) throw new RelayError(`--hub needs --token-file.\n${USAGE}`);
  const token = (await readRelayFile(tokenFile, 1024, true, platform)).trim();
  if (!/^ss_command_[A-Za-z0-9_-]{60,500}$/.test(token)) throw new RelayError(`${tokenFile} does not hold a SmartSell agent token.`, `憑證檔格式錯誤。請在 SmartSell 重新建立連線。`);
  return { hubOrigin, token, tokenFile, configPath, dataDir: dirname(configPath ?? tokenFile) };
}

export interface RelayMainOptions {
  argv: readonly string[]; stdin: Readable; stdout: Writable; stderr: Writable;
  /** App mode: `<userData>/agent-relay/config.json` (§6.2). */
  defaultConfigPath?: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  relay?: Partial<RunRelayOptions>;
}

/** CLI entry shared by `node smartsell-relay.mjs` and the App's `--mcp-relay` mode. Resolves to the exit code. */
export async function relayMain(options: RelayMainOptions): Promise<number> {
  // Before any hub request: a hub that resets a connection must fail that request, not crash the relay (socket-guard.ts).
  guardSocketTypeOfService();
  try {
    const args = parseRelayArgs(options.argv);
    if (args.help) { options.stderr.write(USAGE); return 0; }
    if (args.version) { options.stdout.write(`${RELAY_VERSION}\n`); return 0; }
    const settings = await loadRelaySettings(options.argv, { defaultConfigPath: options.defaultConfigPath, platform: options.platform });
    const handoff = createHandoffClient(handoffSocketPath(settings.dataDir, options.platform));
    await runRelay({ hubOrigin: settings.hubOrigin, token: settings.token, stdin: options.stdin, stdout: options.stdout, stderr: options.stderr,
      fetch: options.fetch, handoff, dataDir: settings.dataDir, platform: options.platform, ...options.relay });
    return 0;
  } catch (error) {
    const relay = error instanceof RelayError ? error : undefined;
    options.stderr.write(`SmartSell relay: ${(error as Error).message}\n${relay?.ownerMessage ? `${relay.ownerMessage}\n` : ''}`);
    return 2;
  }
}
