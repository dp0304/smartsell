// pnpm hub:doctor (§2.13): one actionable line per problem; exits 1 when any check is an error.
import { pathToFileURL } from 'node:url';
import { doctorMain } from '../apps/server/src/hub/doctor.ts';

export * from '../apps/server/src/hub/doctor.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await doctorMain(process.argv.slice(2));
}
