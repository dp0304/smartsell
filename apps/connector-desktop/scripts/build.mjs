import { cp, mkdir, readFile } from 'node:fs/promises';
import catalog from '../skills/catalog.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { releaseConfig } from './config.mjs';

const appDir = new URL('../', import.meta.url);
const release = releaseConfig(process.platform);
const options = { absWorkingDir: fileURLToPath(appDir), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'electron-updater'] };
const ids = catalog.map(({ id }) => id);
if (ids.some(id => !/^smartsell-[a-z0-9-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid built-in skill catalog');
const entries = await Promise.all(ids.map(async id => {
  const content = await readFile(new URL(`skills/${id}/SKILL.md`, appDir), 'utf8');
  if (!content.startsWith(`---\nname: ${id}\n`)) throw new Error(`Invalid skill frontmatter: ${id}`);
  return { id, content };
}));
await build({ ...options, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', define: { RELEASE: JSON.stringify(release) } });
await build({ ...options, format: 'esm', stdin: {
  contents: `import { run } from './scripts/export-skills.mjs';\nawait run(${JSON.stringify(entries)});`,
  resolveDir: fileURLToPath(appDir),
}, outfile: 'dist/smartsell-install-skills.mjs' });
await build({ ...options, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
await mkdir(new URL('dist/', appDir), { recursive: true });
await cp(new URL('ui/', appDir), new URL('dist/ui/', appDir), { recursive: true });
