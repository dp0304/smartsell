// SmartSell hub entry point (§2.5): `node --import tsx apps/server/hub.ts [--check [--load]] [--hub-dir <dir>]`.
// Configuration errors exit with code 0 after writing <hubDir>/status.json, so the OS service does not restart-loop;
// `--check` exits 1 when a check fails so `hub-service install` and `hub:update` can refuse; `--load` also loads every
// module and decodes a copy of the data with this code (AO-1). `--supervise` (the Windows service, AO-2) runs the hub
// as a child process and restarts it when it exits non-zero.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hubMain } from './src/hub/startup.js';
import { hubChildSpawner, processStopSignals, superviseHub } from './src/hub/supervisor.js';

const args = process.argv.slice(2);
if (args.includes('--supervise')) {
  const script = fileURLToPath(import.meta.url);
  process.exitCode = await superviseHub({
    spawnChild: hubChildSpawner(script, args.filter(arg => arg !== '--supervise'), { cwd: join(dirname(script), '..', '..') }),
    onStopSignal: processStopSignals,
  });
} else {
  // Started by the supervisor: its IPC channel must not keep a finished process alive, and losing it means "stop".
  process.channel?.unref();
  try {
    const result = await hubMain(args);
    if (result.outcome === 'check_failed') process.exitCode = 1;
    else if (result.outcome === 'config_error') process.exitCode = 0;
    else if (result.outcome === 'running') {
      const stop = () => void result.stop().catch(() => { process.exitCode = 1; });
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
      if (typeof process.send === 'function') process.once('disconnect', stop);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'SmartSell hub startup failed');
    process.exitCode = 1;
  }
}
