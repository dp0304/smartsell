// pnpm hub:export-legacy --from .local/smartsell.sqlite --out ~/SmartSell-export-YYYYMMDD (§2.11).
// Opens the old SQLite read-only and writes export.json without sessions, credentials, hashes or ciphertext.
import { pathToFileURL } from 'node:url';
import { exportLegacyMain } from '../apps/server/src/hub/export-legacy.ts';

export * from '../apps/server/src/hub/export-legacy.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = exportLegacyMain(process.argv.slice(2));
}
