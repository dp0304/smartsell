import { startKernel } from './integration/kernel-runtime.js';

try {
  const app = await startKernel();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close().catch(error => { console.error(error); process.exitCode = 1; }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
