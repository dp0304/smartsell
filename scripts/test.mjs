import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const ignored = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);
const source = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const testName = /(?:^|[./_-])(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && source.test(entry.name) && !/\.d\.[cm]?ts$/.test(path)) files.push(path);
  }
}

function runnerFor(path) {
  const imports = ts.preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles.map(({ fileName }) => fileName);
  if (imports.some(name => name === 'node:test' || name === 'node:test/reporters')) return 'node';
  if (testName.test(path) && imports.some(name => name === '@playwright/test')) return 'playwright';
  if (testName.test(path)) return 'vitest';
}

walk(root);
const args = process.argv.slice(2);
const builtWeb = args.includes('--built-web');
const selected = args.filter(arg => arg !== '--' && arg !== '--built-web');
const groups = { node: [], vitest: [], playwright: [] };
for (const path of files.sort()) {
  if (path === fileURLToPath(import.meta.url)) continue;
  const name = relative(root, path);
  if (selected.length && !selected.some(filter => name.includes(filter))) continue;
  const runner = runnerFor(path);
  if (runner) groups[runner].push(path);
}
if (!Object.values(groups).some(paths => paths.length)) {
  console.error('No test files found');
  process.exit(1);
}

function run(label, args, cwd = root, env = process.env) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}

function cli(packageName, file) {
  return resolve(dirname(require.resolve(`${packageName}/package.json`)), file);
}

if (groups.node.length) run(`Node test (${groups.node.length} files)`, ['--import', 'tsx', '--test', ...groups.node]);

const configs = { vitest: /^vitest\.config\./, playwright: /^playwright\.config\./ };
for (const [runner, pattern] of Object.entries(configs)) {
  const byConfig = Map.groupBy(groups[runner], path => {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const config = files.find(file => dirname(file) === dir && pattern.test(relative(dir, file)));
      if (config) return config;
      if (dir === root) break;
    }
    return undefined;
  });
  for (const [config, tests] of byConfig) {
    const cwd = config ? dirname(config) : root;
    const args = config ? ['--config', config] : [];
    if (runner === 'vitest') {
      run(`Vitest (${tests.length} files)`, [join(root, 'scripts/vitest.mjs'), config ?? '', ...tests], cwd);
    } else {
      const filters = tests.map(path => `${RegExp.escape(relative(cwd, path))}$`);
      const env = builtWeb ? { ...process.env, SMARTSELL_E2E_PREVIEW: '1' } : process.env;
      run(`Playwright (${tests.length} files)`, [cli('@playwright/test', 'cli.js'), 'test', ...args, ...filters], cwd, env);
    }
  }
}
