import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('root runner collects each framework and fails if Playwright drops a selected file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'smartsell-test-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'web'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
  for (const script of ['test.mjs', 'vitest.mjs']) {
    await copyFile(new URL(script, import.meta.url), join(root, 'scripts', script));
  }
  const config = join(root, 'playwright.config.mjs');
  const fixture = {
    'logic.test.mts': "import { test } from 'node:test'; test('node fixture', () => {});",
    'flow.scenario.ts': "import { test } from 'node:test'; test('node scenario', () => {});",
    'component.spec.mts': "import { test, expect } from 'vitest'; test('vitest fixture', () => expect(1).toBe(1));",
    'web/page.spec.mts': "import { test } from '@playwright/test'; test('playwright fixture', () => {});",
    'web/second.spec.mjs': "import { test } from '@playwright/test'; test('second fixture', () => {});",
    'web/manual.mjs': "import { chromium } from '@playwright/test'; throw new Error('manual script executed');",
    'web/reporter.mjs': "import { tap } from 'node:test/reporters'; throw new Error('support module executed');",
  };
  for (const [path, contents] of Object.entries(fixture)) await writeFile(join(root, path), contents);
  await writeFile(config, "import { defineConfig } from '@playwright/test'; export default defineConfig({ testDir: './web' });");

  function run(...args) {
    const result = spawnSync(process.execPath, ['scripts/test.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  }

  const list = run('--list');
  assert.equal(list.status, 0, list.output);
  assert.deepEqual(list.output.trim().split(/\r?\n/), [
    'node (2 files)', '  flow.scenario.ts', '  logic.test.mts',
    'vitest (1 files)', '  component.spec.mts',
    'playwright (2 files)', '  web/page.spec.mts', '  web/second.spec.mjs',
  ]);
  const success = run();
  assert.equal(success.status, 0, success.output);
  assert.match(success.output, /Node test \(2 files\)/);
  assert.match(success.output, /Vitest \(1 files\)/);
  assert.match(success.output, /Playwright \(2 files\)/);
  assert.match(success.output, /2 passed/);

  await writeFile(config, "export default { testDir: './web', testIgnore: '**/page.spec.mts' };");
  const ignored = run('web/');
  assert.equal(ignored.status, 1, ignored.output);
  assert.match(ignored.output, /Playwright did not collect web\/page\.spec\.mts/);
  assert.doesNotMatch(ignored.output, /Running \d+ tests/);
});
