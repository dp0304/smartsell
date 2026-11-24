// `pnpm hub:init` (§2.5): creates <hubDir>, configures `tailscale serve`, writes hub.env, builds the Web app and prints
// the first-run URL. Re-runnable; existing hub.env values are kept.
import { parseArgs } from 'node:util';
import { hubInit } from './src/hub/init.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter(arg => arg !== '--'),
  options: {
    'hub-dir': { type: 'string' }, yes: { type: 'boolean', short: 'y' }, 'skip-web-build': { type: 'boolean' },
    service: { type: 'boolean' }, 'no-service': { type: 'boolean' }, 'worker-release': { type: 'boolean' }, 'no-worker-release': { type: 'boolean' },
  },
});
const choice = (yes?: boolean, no?: boolean) => yes ? true : no ? false : undefined;
try {
  const result = await hubInit({
    hubDir: values['hub-dir'], yes: values.yes, skipWebBuild: values['skip-web-build'],
    service: choice(values.service, values['no-service']), workerRelease: choice(values['worker-release'], values['no-worker-release']),
  });
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(`pnpm hub:init 失敗：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
