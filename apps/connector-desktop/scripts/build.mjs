// Bundles the App for Electron. `--packaged` is used by installer builds
// (package.mjs --unsigned, pnpm worker:release): it defines RELEASE.packaged =
// true, which makes chrome.ts#isPackagedBuild() refuse every SMARTSELL_TEST_*
// switch and the headless file vault (S6 ledger item 10).
// SMARTSELL_RELEASE_PUBLIC_KEY (set by pnpm worker:release) becomes
// RELEASE.releasePublicKey: the App then refuses an update without a valid
// Ed25519 release signature (security review S1).
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import catalog from '../skills/catalog.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { releaseConfig } from './config.mjs';

const appDir = new URL('../', import.meta.url);
const packaged = process.argv.includes('--packaged');
const release = { ...releaseConfig(process.platform), packaged };
if (packaged && release.update) throw new Error('Unset SMARTSELL_UPDATE_FEED: unsigned installer builds have no update feed (§8.18)');
const options = { absWorkingDir: fileURLToPath(appDir), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'electron-updater'], logLevel: 'warning' };
const ids = catalog.map(({ id }) => id);
if (ids.some(id => !/^smartsell-[a-z0-9-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid built-in skill catalog');
const entries = await Promise.all(ids.map(async id => {
  const content = await readFile(new URL(`skills/${id}/SKILL.md`, appDir), 'utf8');
  if (!content.startsWith(`---\nname: ${id}\n`)) throw new Error(`Invalid skill frontmatter: ${id}`);
  return { id, content };
}));
await rm(new URL('dist/', appDir), { recursive: true, force: true });
await build({ ...options, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', define: { RELEASE: JSON.stringify(release) } });
await build({ ...options, format: 'esm', stdin: {
  contents: `import { run } from './scripts/export-skills.mjs';\nawait run(${JSON.stringify(entries)});`,
  resolveDir: fileURLToPath(appDir),
}, outfile: 'dist/smartsell-install-skills.mjs' });
await build({ ...options, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
// The Node relay for Windows laptops (§6.1 item 2), shipped next to the App so Agent mode needs no download.
await build({ ...options, format: 'esm', target: 'node20', legalComments: 'none', entryPoints: ['../../packages/agent-relay/src/main.ts'],
  outfile: 'dist/agent-relay/smartsell-relay.mjs' });
await mkdir(new URL('dist/', appDir), { recursive: true });
await cp(new URL('ui/', appDir), new URL('dist/ui/', appDir), { recursive: true });
if (packaged && !release.releasePublicKey) {
  console.warn('Warning: no SMARTSELL_RELEASE_PUBLIC_KEY; this build cannot verify update signatures (use pnpm worker:release for installers)');
}
console.log(`Built dist/ (RELEASE.packaged=${packaged}, release key ${release.releasePublicKey ? 'embedded' : 'none'})`);
