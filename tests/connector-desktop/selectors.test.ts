import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { channels } from '../../apps/connector-desktop/src/channels.ts';
import { compareVersions, defaultSelectors, findStep, SelectorStore, validateSelectorTable } from '../../apps/connector-desktop/src/drivers/selectors.ts';
import { FakeCdpPage } from './fakes/fake-cdp-page.ts';

const bytesOf = (value: unknown) => Buffer.from(JSON.stringify(value));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('the bundled selector table is valid and keeps the TikTok User ID rule of channels.ts', () => {
  const table = defaultSelectors();
  assert.match(table.version, /^\d{4}\.\d{1,2}\.\d+$/);
  assert.equal(table.tiktok.patterns.user_id, channels.tiktok.rule.fields[0].pattern);
  assert.ok(table.x.steps['x.post_button'].primary[0].css?.includes('tweetButton'));
});

test('validation rejects non-strings, long or broken regexes, unknown keys and missing steps', () => {
  const base = defaultSelectors();
  const variants: [string, (table: any) => void][] = [
    ['non-string', table => { table.x.steps['x.ready'].primary[0].css = 42; }],
    ['regex too long', table => { table.x.steps['x.ready'].fallback[0].name = 'a'.repeat(201); }],
    ['broken regex', table => { table.x.patterns.risk_text = '(unclosed'; }],
    ['unknown key', table => { table.x.steps['x.ready'].primary[0].script = 'alert(1)'; }],
    ['missing step', table => { delete table.tiktok.steps['tt.post_button']; }],
    ['missing pattern', table => { delete table.tiktok.patterns.user_id; }],
    ['bad version', table => { table.version = 'latest'; }],
    ['code smuggling', table => { table.x.code = 'function(){}'; }],
  ];
  for (const [label, mutate] of variants) {
    const copy = structuredClone(base);
    mutate(copy);
    assert.throws(() => validateSelectorTable(copy), Error, label);
  }
});

test('the store applies a newer verified table, persists it, and keeps the old one when a download is invalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-selectors-'));
  try {
    const store = new SelectorStore(dir);
    const newer = { ...defaultSelectors(), version: '2026.12.1' };
    newer.x.steps['x.post_button'].fallback[0].name = '^(Post|Publish|發佈)$';
    const good = bytesOf(newer);
    assert.equal(store.needsUpdate({ version: '2026.12.1', sha256: sha(good) }), true);
    assert.deepEqual(store.apply(good, { version: '2026.12.1', sha256: sha(good) }), { ok: true });
    assert.equal(store.version, '2026.12.1');
    assert.equal(new SelectorStore(dir).version, '2026.12.1', 'persisted for the next start');

    const tampered = bytesOf({ ...newer, version: '2026.12.2' });
    const wrongSha = store.apply(tampered, { version: '2026.12.2', sha256: '0'.repeat(64) });
    assert.equal(wrongSha.ok, false);
    assert.equal(store.health, 'unknown');
    assert.equal(store.version, '2026.12.1');

    const invalid = bytesOf({ ...newer, version: '2026.12.3', x: { steps: {}, patterns: {} } });
    assert.equal(store.apply(invalid, { version: '2026.12.3', sha256: sha(invalid) }).ok, false);
    assert.equal(store.version, '2026.12.1');
    assert.equal(compareVersions('2026.11.10', '2026.11.9'), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lookup prefers the primary selector and reports a fallback match', async () => {
  const table = defaultSelectors();
  const page = new FakeCdpPage();
  page.add({ role: 'button', name: 'Post', css: [] });
  const fallback = await findStep(page, table, 'x', 'x.post_button');
  assert.equal(fallback[0].matched, 'fallback');
  page.add({ css: [table.x.steps['x.post_button'].primary[0].css!] });
  const primary = await findStep(page, table, 'x', 'x.post_button');
  assert.equal(primary[0].matched, 'primary');
  page.add({ css: [table.x.steps['x.identity'].primary[0].css!], attrs: { href: '/Fixture_X' } });
  assert.equal((await findStep(page, table, 'x', 'x.identity'))[0].value, 'Fixture_X');
});
