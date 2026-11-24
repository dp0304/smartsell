// pnpm hub:service install|uninstall|status (§2.8). Run with `node --import tsx` (the root script does this).
// The logic lives in apps/server/src/hub/service.ts so it is typechecked and shared with hub:doctor.
import { pathToFileURL } from 'node:url';
import { serviceMain } from '../apps/server/src/hub/service.ts';

export * from '../apps/server/src/hub/service.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await serviceMain(process.argv.slice(2));
}
