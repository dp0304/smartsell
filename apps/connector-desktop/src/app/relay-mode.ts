// `--mcp-relay` entry (§6.1, §6.2). Codex / Claude Code start the App
// executable once per session as a stdio MCP server. This mode must not
// bother the owner: hide the Dock icon, open no window or tray, and never
// take the single-instance lock (many relays may run next to the resident
// App). It delegates to @smartsell/agent-relay's relayMain and exits with its
// code. Nothing may be written to stdout except MCP messages.
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { relayMain as defaultRelayMain, type RelayMainOptions } from '@smartsell/agent-relay';

export const RELAY_FLAG = '--mcp-relay';

export interface RelayModeApp {
  dock?: { hide(): unknown };
  getPath(name: 'userData'): string;
  exit(code?: number): void;
}

export interface RelayModeIo { argv: readonly string[]; stdin: Readable; stdout: Writable; stderr: Writable; platform?: NodeJS.Platform }

export function isRelayMode(argv: readonly string[]) { return argv.includes(RELAY_FLAG); }

/** `<userData>/agent-relay`: config.json, credential (0600), ipc.sock and the Windows relay script. */
export function relayDataDir(userData: string) { return join(userData, 'agent-relay'); }

/** Relay arguments after the executable (Electron puts the app path at argv[1] only when unpackaged). */
export function relayArgs(argv: readonly string[]) {
  const index = argv.indexOf(RELAY_FLAG);
  return index === -1 ? [] : argv.slice(index);
}

export async function runRelayMode(app: RelayModeApp, io: RelayModeIo, relayMain: (options: RelayMainOptions) => Promise<number> = defaultRelayMain): Promise<number> {
  try { app.dock?.hide(); } catch { /* no Dock (Windows) */ }
  const code = await relayMain({
    argv: relayArgs(io.argv), stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, platform: io.platform,
    defaultConfigPath: join(relayDataDir(app.getPath('userData')), 'config.json'),
  });
  app.exit(code);
  return code;
}
