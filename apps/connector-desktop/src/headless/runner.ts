// Headless Worker (§8.14): the same Supervisor, JobRunner, MediaCache,
// Profiles and drivers as the App, without Electron. For CI and E2E only.
//
//   node --import tsx apps/connector-desktop/src/headless/runner.ts \
//     --data-dir /tmp/w1 --name Mac-B pair --hub http://127.0.0.1:4401 --workspace <ws> --code <pairing_code>
//   node --import tsx apps/connector-desktop/src/headless/runner.ts --data-dir /tmp/w1 add-channel --provider x
//   node --import tsx apps/connector-desktop/src/headless/runner.ts --data-dir /tmp/w1 run [--dry-run]
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairOverHttp } from '../../../connector/src/device-client.ts';
import { testModeEnabled } from '../chrome.ts';
import { enrollChannel, registerEnrolledChannel } from '../runtime/enroll.ts';
import { RuntimeEventBus } from '../runtime/events.ts';
import { createWorkerRuntime, type WorkerRuntime } from '../runtime/worker.ts';
import { FileVault } from './file-vault.ts';

export const CLIENT_VERSION = '0.2.0';

export interface CliArgs { dataDir: string; name?: string; command: 'pair' | 'add-channel' | 'run'; options: Record<string, string | true> }

export function parseArgs(argv: string[]): CliArgs {
  const options: Record<string, string | true> = {};
  let command: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--') && !['pair', 'add-channel', 'run'].includes(next)) { options[name] = next; index++; }
      else options[name] = true;
    } else if (!command) command = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (command !== 'pair' && command !== 'add-channel' && command !== 'run') throw new Error('Command must be pair, add-channel or run');
  if (typeof options['data-dir'] !== 'string') throw new Error('--data-dir is required');
  return { dataDir: resolve(options['data-dir']), name: typeof options.name === 'string' ? options.name : undefined, command, options };
}

function emit(line: object) { process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`); }

function bundledClip(): string | null {
  const fromEnv = process.env.SMARTSELL_TEST_CLIP;
  if (fromEnv) return fromEnv;
  let here: string;
  try { here = dirname(fileURLToPath(import.meta.url)); } catch { return null; }
  const path = join(here, '..', '..', 'resources', 'test-clip.mp4');
  return existsSync(path) ? path : null;
}

function runtimeFor(vault: FileVault, options: { dryRun?: boolean; events?: RuntimeEventBus }): WorkerRuntime {
  const pairing = vault.load();
  if (!pairing) throw new Error('Not paired: run the pair command first.');
  return createWorkerRuntime({
    dataDir: dirname(vault.path),
    identity: { origin: pairing.origin, workspaceId: pairing.workspace_id, deviceId: pairing.device_id, privateKey: pairing.private_key_pem, machineName: pairing.machine_name },
    clientVersion: CLIENT_VERSION, headless: true, bundledClip: bundledClip(), localDryRun: options.dryRun, events: options.events,
    log: (message, detail) => emit({ level: 'info', message, ...detail }),
  });
}

export async function pair(args: CliArgs) {
  const vault = new FileVault(args.dataDir);
  const hub = args.options.hub, workspace = args.options.workspace, code = args.options.code;
  if (typeof hub !== 'string' || typeof workspace !== 'string' || typeof code !== 'string' || !args.name) throw new Error('pair needs --name, --hub, --workspace and --code');
  const platform = typeof args.options.platform === 'string' ? args.options.platform : process.platform;
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('pair needs --platform darwin|win32 on this OS');
  const { privateKey } = generateKeyPairSync('ed25519');
  const deviceId = await pairOverHttp(hub, workspace, code, platform, args.name, privateKey, { userInitiated: true, ownsDevice: true });
  vault.save({ origin: new URL(hub).origin, workspace_id: workspace, device_id: deviceId, private_key_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    machine_name: args.name, paired_at: new Date().toISOString() });
  emit({ event: 'paired', device_id: deviceId, name: args.name });
  return deviceId;
}

/** add-channel (§8.14, §8.16): open the platform page in a new profile, read the identity read-only, register it. */
export async function addChannel(args: CliArgs) {
  const provider = args.options.provider;
  if (provider !== 'x' && provider !== 'tiktok') throw new Error('add-channel needs --provider x|tiktok');
  const runtime = runtimeFor(new FileVault(args.dataDir), {});
  try {
    const channel = await enrollChannel(runtime, provider, { pollMs: 1000, timeoutMs: 60_000 });
    const registrations = await registerEnrolledChannel(runtime.hub, channel);
    emit({ event: 'channel_registered', provider, profile_key: channel.profileKey, external_id: channel.identity, handle: channel.handle, registrations });
    return { profileKey: channel.profileKey, identity: channel.identity, handle: channel.handle, registrations };
  } finally {
    runtime.profiles.closeAll();
  }
}

export async function run(args: CliArgs) {
  const events = new RuntimeEventBus();
  for (const name of ['jobs_held', 'local_alert', 'hub_unreachable', 'update_available', 'connection'] as const) {
    events.on(name, (event: unknown) => emit({ event: name, detail: event }));
  }
  const runtime = runtimeFor(new FileVault(args.dataDir), { dryRun: args.options['dry-run'] === true, events });
  runtime.start();
  emit({ event: 'started', data_dir: args.dataDir, dry_run: args.options['dry-run'] === true });
  await new Promise<void>(done => {
    const stop = () => { void runtime.stop().finally(done); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  emit({ event: 'stopped' });
}

export async function main(argv = process.argv.slice(2)) {
  if (!testModeEnabled()) throw new Error('The headless runner is for CI and E2E: set SMARTSELL_TEST_MODE=1.');
  // Never let a test runner reach a real platform: fixture origins are mandatory here.
  if (!process.env.SMARTSELL_TEST_PLATFORM_ORIGINS) throw new Error('The headless runner needs SMARTSELL_TEST_PLATFORM_ORIGINS (local fixture pages).');
  const args = parseArgs(argv);
  if (args.command === 'pair') return pair(args);
  if (args.command === 'add-channel') return addChannel(args);
  return run(args);
}

const invokedDirectly = (() => {
  try { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (invokedDirectly) {
  main().catch(error => { emit({ level: 'error', message: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
}
