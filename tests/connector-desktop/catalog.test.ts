import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogFileLimit, readCatalogFile } from '../../apps/connector-desktop/src/catalog-file.ts';
import { DesktopConnector } from '../../apps/connector-desktop/src/controller.ts';
import { sellerPortal } from '../../apps/connector-desktop/src/policy.ts';
import { serviceOrigin, serviceSettings, workbenchOrigin } from '../../apps/connector-desktop/src/service-settings.ts';
import { textCell, workbookFixture } from '../../apps/server/src/modules/ingest/xlsx-fixture.ts';

async function temp(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-catalog-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('reads supported product exports locally and excludes non-product data', async t => {
  const root = await temp(t);
  const signal = new AbortController().signal;
  const csv = 'product_id,title\nitem,"Product, blue"';
  const xlsx = await workbookFixture(
    `<row r="1">${textCell('A1', 'product_id')}${textCell('B1', 'title')}${textCell('C1', 'internal_memo')}</row>` +
    `<row r="2">${textCell('A2', 'item')}${textCell('B2', 'Product, blue')}${textCell('C2', 'omitted')}</row>`);
  for (const [extension, content] of Object.entries({
    csv: 'product_id,title,internal_memo\r\nitem,"Product, blue",omitted',
    tsv: 'product_id\ttitle\tinternal_memo\nitem\tProduct, blue\tomitted',
    xlsx: Buffer.from(xlsx, 'base64'),
  })) {
    const path = join(root, `products.${extension}`);
    await writeFile(path, content);
    assert.equal((await readCatalogFile(path, signal)).csv, csv);
  }
  const blocked = join(root, 'orders.csv');
  for (const header of ['order_id', 'buyer_email', 'account_password']) {
    await writeFile(blocked, `sku,${header}\nitem,private`);
    await assert.rejects(readCatalogFile(blocked, signal), /不能包含/);
  }
  await writeFile(blocked, Buffer.alloc(catalogFileLimit + 1));
  await assert.rejects(readCatalogFile(blocked, signal), /384 KiB/);
});

test('service settings persist before pairing and cannot replace a paired service', async t => {
  const settingsPath = join(await temp(t), 'service-origin.txt');
  const settings = serviceSettings(settingsPath);
  const options = {
    version: '0.1.0', platform: 'darwin' as const, saveOrigin: settings.save,
    vault: { load: () => undefined, clear: () => {}, save: () => {}, available: () => true },
    openExternal: async () => {}, pickMedia: async () => undefined,
  };
  const client = new DesktopConnector(options);
  assert.equal(settings.load(), undefined);
  client.setOrigin('https://service.example.test/');
  const origin = serviceSettings(settingsPath).load();
  assert.equal(origin, 'https://service.example.test');
  const paired = new DesktopConnector({ ...options, origin, vault: { ...options.vault,
    load: () => ({ origin: origin!, name: 'Worker', workspace: 'workspace', device: 'machine', key: generateKeyPairSync('ed25519').privateKey }),
  } });
  assert.equal(paired.snapshot().serviceMatches, true);
  assert.equal(paired.snapshot().canSetOrigin, false);
  assert.throws(() => paired.setOrigin('https://other.example.test'), /不能更改/);
  assert.equal(settings.load(), origin);
  assert.equal(serviceOrigin('http://127.0.0.1:3030'), 'http://127.0.0.1:3030');
  assert.equal(serviceOrigin('http://localhost:3030'), 'http://localhost:3030');
  for (const url of ['file:///tmp/test', 'http://remote.example.test', 'https://user:pass@service.example.test', 'https://service.example.test/?token=x']) {
    assert.throws(() => serviceOrigin(url), /服务地址/);
  }
});

test('browser launch accepts only configured workbench and matching official seller origins', () => {
  assert.equal(workbenchOrigin('https://workbench.example.test'), 'https://workbench.example.test');
  for (const url of ['http://localhost:3030', 'https://localhost.', 'https://127.0.0.2', 'https://[::ffff:127.0.0.1]', 'file:///tmp/test']) {
    assert.equal(workbenchOrigin(url), undefined);
  }
  const job = { provider: 'shopify', external_store_id: 'fixture.myshopify.com' };
  assert.equal(sellerPortal({ ...job, portal_url: 'https://fixture.myshopify.com/admin' }), 'https://fixture.myshopify.com/admin');
  assert.equal(sellerPortal({ ...job, portal_url: 'https://admin.shopify.com/store/fixture/products' }), 'https://admin.shopify.com/store/fixture');
  for (const portal_url of ['https://admin.shopify.com/store/other', 'https://admin.shopify.com/?redirect=http://localhost',
    'https://admin.shopify.com.attacker.test', 'https://admin.shopify.com@localhost/', 'https://localhost', 'file:///tmp/test']) {
    assert.equal(sellerPortal({ ...job, portal_url }), undefined);
  }
});
