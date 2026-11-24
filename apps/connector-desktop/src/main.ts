// Electron entry (§8.1): every mode is decided in app/shell.ts — the
// --mcp-relay stdio relay, the --smoke self check, and the resident Worker or
// laptop Agent App. esbuild defines RELEASE (scripts/build.mjs); installer
// builds set RELEASE.packaged = true, which refuses every SMARTSELL_TEST_* switch.
import * as electron from 'electron';
import { bootstrap, PRODUCT_NAME, type ReleaseConfig } from './app/shell.ts';

declare const RELEASE: ReleaseConfig | undefined;

const release: ReleaseConfig = typeof RELEASE === 'undefined' ? {} : RELEASE;

bootstrap(electron, { release, argv: process.argv, appDir: __dirname }).catch(error => {
  try { electron.dialog.showErrorBox(PRODUCT_NAME, '無法啟動 SmartSell Worker。請重新安裝，或把「進階 → 日誌」交給維護者。'); } catch { /* relay mode has no UI */ }
  process.stderr.write(`SmartSell Worker failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  electron.app.exit(1);
});
