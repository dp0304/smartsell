import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const ignored = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);
const source = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const testName = /(?:^|[._-])(?:test|spec|scenario)\.(?:[cm]?[jt]s|[jt]sx)$/;
const portable = path => path.replaceAll('\\', '/');
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && source.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(path);
  }
}

function runnerFor(path) {
  const imports = ts.preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles.map(({ fileName }) => fileName);
  if (imports.includes('node:test')) return 'node';
  if (imports.includes('@playwright/test')) return 'playwright';
  return 'vitest';
}

walk(root);
const args = process.argv.slice(2);
const builtWeb = args.includes('--built-web');
const list = args.includes('--list');
const selected = args.filter(arg => !['--', '--built-web', '--list'].includes(arg)).map(portable);
const groups = { node: [], vitest: [], playwright: [] };
for (const path of files.sort()) {
  if (!testName.test(basename(path)) || path === fileURLToPath(import.meta.url)) continue;
  const name = portable(relative(root, path));
  if (selected.length && !selected.some(filter => name.includes(filter))) continue;
  groups[runnerFor(path)].push(path);
}
if (!Object.values(groups).some(paths => paths.length)) {
  console.error('No test files found');
  process.exit(1);
}

if (list) {
  for (const [runner, tests] of Object.entries(groups)) {
    console.log(`${runner} (${tests.length} files)`);
    for (const path of tests) console.log(`  ${portable(relative(root, path))}`);
  }
  process.exit(0);
}

function run(label, args, cwd = root, env = process.env) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
  return result.status === 0;
}

function cli(packageName, file) {
  return resolve(dirname(require.resolve(`${packageName}/package.json`)), file);
}

function runPlaywright(tests, args, cwd) {
  // Playwright applies CLI filters to full paths, even when a config sets testDir.
  const filters = tests.map(path => `^${portable(path).split('/').map(RegExp.escape).join('[/\\\\]')}$`);
  const command = [cli('@playwright/test', 'cli.js'), 'test', ...(process.env.CI ? ['--forbid-only'] : []), ...args, ...filters];
  const env = builtWeb ? { ...process.env, SMARTSELL_E2E_PREVIEW: '1' } : process.env;
  const work = mkdtempSync(join(tmpdir(), 'smartsell-playwright-list-'));
  try {
    const reportFile = join(work, 'collection.json');
    if (!run('Check Playwright collection', [...command, '--list', '--reporter=json'], cwd,
      { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile })) return;
    const { config, suites } = JSON.parse(readFileSync(reportFile, 'utf8'));
    const collected = new Set(suites.map(suite => resolve(config.rootDir, suite.file)));
    const expected = new Set(tests);
    const missing = tests.filter(path => !collected.has(path));
    const unexpected = [...collected].filter(path => !expected.has(path));
    if (missing.length || unexpected.length) {
      for (const path of missing) console.error(`Playwright did not collect ${portable(relative(root, path))}`);
      for (const path of unexpected) console.error(`Playwright unexpectedly collected ${portable(relative(root, path))}`);
      process.exitCode = 1;
      return;
    }
    run(`Playwright (${collected.size} files)`, command, cwd, env);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (groups.node.length) {
  // Several test files start their own servers and wait on readiness deadlines.
  const concurrency = Math.max(1, Math.min(4, availableParallelism() - 1));
  run(`Node test (${groups.node.length} files)`, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, ...groups.node]);
}

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
      runPlaywright(tests, args, cwd);
    }
  }
}
