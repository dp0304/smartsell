import { start } from './bootstrap.js';

try {
  const app = await start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close().catch(() => { process.exitCode = 1; }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Server startup failed');
  process.exitCode = 1;
}
