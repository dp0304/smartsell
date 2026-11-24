// pnpm hub:update (§2.13, E45): back up the data, pull, install, build the Web app into a staging directory, load the new
// code for real (hub.ts --check --load), then swap in the Web app and selector data and restart. Any failure puts the
// source and dependencies back (the old version also runs after the next reboot); a new version that does not come up
// is stopped and rolled back, with the data copy restored if the new code changed the data.
import { pathToFileURL } from 'node:url';
import { updateMain } from '../apps/server/src/hub/update.ts';

export * from '../apps/server/src/hub/update.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await updateMain(process.argv.slice(2));
}
