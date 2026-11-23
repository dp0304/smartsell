import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileStore } from '@smartsell/db';
import { buildApp } from '../../app.js';
import { configuration } from '../../config.js';
import { createServer } from '../../server.js';
import { importOperations } from '../ingest/import-operations.js';
import { textCell, workbookFixture } from '../ingest/xlsx-fixture.js';
import { operations as workspaceOperations } from '../workspace/operations.js';
import { MemoryStore } from '../../memory.js';
import { register, type Registry } from '../../registry.js';
import { commands } from './commands.js';
import { operations as commerceOperations } from './index.js';

test('HTTP CSV preview and commit replay preserve sanitized state', async t => {
  const token = Buffer.alloc(32, 42).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const registry: Registry = new Map();
  register(registry, 'commerce', commands);
  const store = new MemoryStore();
  assert.equal(await store.setup({ email: 'owner@example.invalid', name: 'Owner', workspaceName: 'Import test', passwordHash: 'unused' }, tokenHash), true);
  const session = await store.session(tokenHash);
  assert.ok(session);
  const wid = session.workspaces[0].id;
  const { app } = buildApp({ store, registry, secureCookie: false, origins: new Set() });
  t.after(() => app.close());
  const request = (action: string, payload: object, key?: string) => app.inject({
    method: 'POST', url: `/api/v1/workspaces/${wid}/commands/commerce/${action}`, payload,
    headers: { cookie: `smartsell_session=${token}`, ...(key ? { 'idempotency-key': key } : {}) },
  });
  const created = await request('create_store', {
    name: 'Amazon US', provider: 'amazon_sp', default_currency: 'USD', default_locale: 'en-US',
  }, 'create');
  assert.equal(created.statusCode, 200, created.body);
  const store_id = created.json().data.id;
  const payload = {
    store_id, template_key: 'order_list',
    csv: 'external_order_id,placed_at,currency,total_minor,financial_status,buyer_email,postal_code\r\n'
      + '123-7654321-1234567,2026-10-08T15:00:00Z,USD,2595,paid,private@example.invalid,12345',
  };
  assert.equal((await request('preview_import', payload)).statusCode, 422);
  const preview = await request('preview_import', payload, 'preview');
  assert.equal(preview.statusCode, 200, preview.body);
  assert.doesNotMatch(preview.body, /private@example\.invalid|postal_code/);
  assert.deepEqual((await request('preview_import', payload, 'preview')).json(), preview.json());
  const different = await request('preview_import', { ...payload, csv: payload.csv.replace('2595', '3595') }, 'preview');
  assert.equal(different.statusCode, 409);
  assert.equal(different.json().error.code, 'idempotency_conflict');
  const badPreview = await request('preview_import', { ...payload, csv: payload.csv.replace('2595', 'invalid') }, 'bad-preview');
  assert.equal(badPreview.statusCode, 200, badPreview.body);
  const errors = await request('import_error_file', { batch_id: badPreview.json().data.batch_id }, 'errors');
  assert.equal(errors.statusCode, 200, errors.body);
  assert.match(errors.json().data.csv, /^line,code,severity,message\r\n"2","invalid_input","error","Invalid total_minor"/);
  assert.doesNotMatch(errors.json().data.csv, /private@example\.invalid|postal_code|12345/);

  const xlsx_base64 = await workbookFixture(`<row r="1">${['external_order_id', 'placed_at', 'currency', 'total_minor', 'financial_status', 'buyer_email', 'postal_code'].map((name, index) => textCell(`${'ABCDEFG'[index]}1`, name)).join('')}</row>`
    + `<row r="2">${textCell('A2', '123-7654321-1234567')}${textCell('B2', '2026-10-08T15:00:00Z')}${textCell('C2', 'USD')}<c r="D2"><v>2595</v></c>${textCell('E2', 'paid')}${textCell('F2', 'private@example.invalid')}</row>`);
  const workbookPreview = await request('preview_import', { store_id, template_key: 'order_list', xlsx_base64 }, 'xlsx-preview');
  assert.equal(workbookPreview.statusCode, 200, workbookPreview.body);
  assert.deepEqual(workbookPreview.json(), preview.json());
  assert.equal((await request('preview_import', { ...payload, xlsx_base64 }, 'mixed-input')).statusCode, 422);

  const { batch_id, version } = preview.json().data;
  const commitInput = { batch_id, expected_version: version };
  const commit = await request('commit_import', commitInput, 'commit');
  assert.equal(commit.statusCode, 200, commit.body);
  assert.deepEqual((await request('commit_import', commitInput, 'commit')).json(), commit.json());
  await store.workspace(tokenHash, wid, async ({ context }) => {
    const orders = await context.list('commerce', 'order');
    assert.equal(orders.length, 1);
    assert.equal(orders[0].version, 1);
    assert.equal(orders[0].data.total_minor, 2595);
    assert.doesNotMatch(JSON.stringify(orders[0].data), /private@example\.invalid|postal_code|buyer_email/);
  });
});

test('REST XLSX import shares mapping, preview, checkpoint, and rerun behavior with CSV', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xlsx-import-'));
  const setupToken = randomBytes(32).toString('hex');
  const config = configuration({ PORT: '3401', SETUP_TOKEN: setupToken });
  const store = await fileStore(join(directory, 'store.json'));
  const app = createServer({ config, store, operations: [
    ...commerceOperations.filter(op => ['commerce_store_create', 'commerce_store_import'].includes(op.name)).map(op => ({ ...op, module: 'commerce' })),
    ...importOperations.map(op => ({ ...op, module: 'ingest' })),
    ...workspaceOperations.filter(op => op.name === 'workspace_brand_create').map(op => ({ ...op, module: 'workspace' })),
  ] });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': setupToken }, payload: {
    email: 'owner@example.test', password: 'fixture-password-123', workspace_name: 'Import test',
  } });
  assert.equal(setup.statusCode, 201, setup.body);
  const owner = setup.json().data;
  const root = `/api/v1/workspaces/${owner.workspaces[0].id}`;
  const headers = { cookie: String(setup.headers['set-cookie']).split(';')[0], origin: config.origin, 'x-csrf-token': owner.csrf_token };
  const request = (method: 'POST' | 'PATCH' | 'GET', path: string, payload?: object, extra?: Record<string, string>) => app.inject({ method, url: root + path, headers: { ...headers, ...extra }, payload });
  const brand = await request('POST', '/brands', { name: 'Brand', slug: 'brand' });
  assert.equal(brand.statusCode, 200, brand.body);
  const created = await request('POST', '/stores', { provider: 'shopify', brand_id: brand.json().data.id, name: 'Store', default_currency: 'USD', default_locale: 'en-US' });
  assert.equal(created.statusCode, 200, created.body);
  const storeId = created.json().data.id;
  const xlsx_base64 = await workbookFixture(`<row r="1">${textCell('A1', 'SKU code')}${textCell('B1', 'title')}${textCell('C1', 'buyer_email')}</row>`
    + `<row r="4">${textCell('A4', '00001')}${textCell('B4', 'Tea')}${textCell('C4', 'private@example.invalid')}</row>`
    + `<row r="8">${textCell('B8', 'Missing SKU')}</row>`);
  const body = { template_key: 'product_list', xlsx_base64 };
  const path = `/stores/${storeId}/imports`;
  const malformed = await request('POST', path, { ...body, xlsx_base64: 'aGVsbG8=' });
  assert.equal(malformed.statusCode, 422, malformed.body);
  assert.equal(malformed.json().code, 'INVALID_XLSX');
  const initial = await request('POST', path, body, { 'idempotency-key': 'new-workbook' });
  assert.equal(initial.statusCode, 200, initial.body);
  const preview = initial.json().data;
  assert.equal(preview.stats.invalid, 2);
  assert.doesNotMatch(initial.body, /buyer_email|private@example/);
  assert.deepEqual((await request('POST', path, body, { 'idempotency-key': 'new-workbook' })).json(), initial.json());
  const mapping = { 'SKU code': 'sku', title: 'title' };
  const patched = await request('PATCH', `/imports/${preview.id}`, { mapping }, { 'if-match': initial.headers.etag! });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.deepEqual(patched.json().data.stats, { rows: 2, valid: 1, invalid: 1, dup_in_file: 0, new: 1, changed: 0, unchanged: 0 });
  const rows = await request('GET', `/imports/${preview.id}/rows`);
  assert.equal(rows.statusCode, 200, rows.body);
  assert.deepEqual(rows.json().data.map((row: { row_no: number }) => row.row_no), [4, 8]);
  assert.equal(rows.json().data[0].normalized.sku, '00001');
  assert.doesNotMatch(rows.body, /buyer_email|private@example/);
  const errors = await request('GET', `/imports/${preview.id}/error-file`);
  assert.equal(errors.statusCode, 200, errors.body);
  assert.match(errors.json().data.csv, /"8"/);
  const confirmPath = `/imports/${preview.id}/confirm`;
  const firstChunk = await request('POST', confirmPath, { limit: 1 }, { 'idempotency-key': 'first-chunk' });
  assert.equal(firstChunk.statusCode, 200, firstChunk.body);
  assert.equal(firstChunk.json().data.checkpoint_row, 4);
  assert.deepEqual((await request('POST', confirmPath, { limit: 1 }, { 'idempotency-key': 'first-chunk' })).json(), firstChunk.json());
  assert.equal((await request('POST', confirmPath, {})).json().data.status, 'partially_merged');
  const rerun = await request('POST', path, { ...body, mapping, supersedes_batch_id: preview.id });
  assert.equal(rerun.statusCode, 200, rerun.body);
  assert.equal(rerun.json().data.stats.unchanged, 1);
  const csvRerun = await request('POST', '/imports', { template_key: body.template_key, store_id: storeId, mapping,
    csv_text: 'SKU code,title,buyer_email\n\n\n00001,Tea,private@example.invalid\n\n\n\n,Missing SKU,', supersedes_batch_id: preview.id });
  assert.equal(csvRerun.statusCode, 200, csvRerun.body);
  assert.equal(csvRerun.json().data.file_sha256, rerun.json().data.file_sha256);
});
