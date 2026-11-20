import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { createCommerceProviders } from '../../apps/server/src/integration/commerce-providers.ts';
import { createMediaHost } from '../../apps/server/src/integration/media-host.ts';
import { registerOperationRoutes } from '../../apps/server/src/operation-server.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { PostgresStore } from '../../apps/server/src/postgres.ts';

const { Client } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('pg');
const requestUrl = process.env.SMARTSELL_PUBLISHING_INTEGRITY_PG_URL;
const inspectUrl = process.env.SMARTSELL_PUBLISHING_INTEGRITY_PG_INSPECT_URL;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');

test('publishing integrity on a fresh local PostgreSQL workspace', { skip: !requestUrl && !inspectUrl, timeout: 60_000 }, async t => {
  for (const url of [requestUrl, inspectUrl]) {
    assert.ok(url, 'Run tests/acceptance/publishing-integrity.sh to provision both local database roles');
    const address = new URL(url);
    assert.equal(address.hostname, '127.0.0.1');
    assert.equal(address.pathname, '/publishing_integrity');
  }
  const db = new Client({ connectionString: inspectUrl, options: '-c default_transaction_read_only=on' });
  await db.connect();
  t.after(() => db.end());
  assert.equal((await db.query('SELECT count(*)::int AS count FROM ss.users')).rows[0].count, 0);
  const rows = async (sql, values) => (await db.query(sql, values)).rows;

  const directory = await mkdtemp(join(tmpdir(), 'smartsell-publishing-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = configuration({ DATABASE_URL: requestUrl, NODE_ENV: 'test', ROLE: 'api', SETUP_TOKEN: randomUUID() });
  const { operations, missingModules, loadFailures } = await discoverOperations();
  assert.deepEqual([...loadFailures], []);
  assert.deepEqual(missingModules, []);
  const originalEnv = process.env;
  const { media, boundOperations } = (() => {
    try {
      process.env = { MEDIA_DIRECTORY: directory };
      const providers = createCommerceProviders(config);
      return { media: createMediaHost(config), boundOperations: operations.map(op => providers.bindOperation(op)) };
    } finally { process.env = originalEnv; }
  })();
  const store = new PostgresStore(requestUrl);
  const { app } = buildApp({ ...config, store, registry: new Map(),
    operationApi: { config, operations: boundOperations, register: registerOperationRoutes, media } });
  t.after(() => app.close());
  await store.ready('request');
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(method, path, body, headers = {}, status = 200) {
    const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    return { json: JSON.parse(raw), headers: response.headers };
  }
  const setup = await request('POST', '/api/v1/setup', {
    name: 'Publisher', email: 'publishing-integrity@example.invalid', password: 'acceptance-only-password', workspaceName: 'Publishing integrity',
  }, { 'x-setup-token': config.setupToken }, 201);
  const workspace = setup.json.workspaces[0].id;
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const { json: { csrf_token } } = await request('GET', '/api/v1/session/csrf', undefined, { cookie });
  const workspacePath = `/api/v1/workspaces/${workspace}`;
  const call = async (method, path, body, { key, version, status = 200 } = {}) => {
    const { json } = await request(method, workspacePath + path, body, {
      cookie, 'x-csrf-token': csrf_token, ...(key && { 'idempotency-key': key }),
      ...(version !== undefined && { 'if-match': String(version) }),
    }, status);
    return status < 300 ? json.data : json.code ?? json.error?.code;
  };
  const read = path => call('GET', path);
  const post = (path, body, options) => call('POST', path, body, options);
  const brand = await post('/brands', { name: 'Fixture brand', slug: 'publishing-integrity' });
  const account = await post('/social-accounts', {
    brand_id: brand.id, provider: 'meta_facebook', external_account_id: 'fixture-page', display_name: 'Fixture page', owned_account_confirmed: true,
  });
  async function content(title, media) {
    const { variants: [draft] } = await post('/content-items', { title, brand_id: brand.id, variants: [{
      platform: 'facebook', format: media ? 'image' : 'text', locale: 'en', body_markdown: title, ...(media && { media }),
    }] });
    return post(`/content-variants/${draft.id}/revisions`, { base_revision_id: null });
  }
  const targetInput = ({ variant, revision }, hours) => ({
    social_account_id: account.id, content_variant_id: variant.id, variant_revision_id: revision.id,
    scheduled_at: new Date(Date.now() + hours * 3_600_000).toISOString(), schedule_tz: 'UTC',
  });

  await t.test('PL03 replays target creation and preserves per-item batch outcomes over HTTP', async () => {
    const draft = await content('PL03 fixture');
    await post(`/content-variants/${draft.variant.id}/readiness`, {}, { version: draft.variant.version });
    const input = targetInput(draft, 24);
    const options = { key: randomUUID() };
    const first = await post('/publish-targets', input, options);
    const replay = await post('/publish-targets', input, options);
    assert.ok(first.id);
    assert.deepEqual(replay, first);
    assert.deepEqual((await read(`/publish-targets?social_account_id=${account.id}`)).map(row => row.id), [first.id]);
    assert.equal((await read(`/publish-targets/${first.id}`)).variant_revision_id, draft.revision.id);
    assert.deepEqual(await rows(`SELECT id, variant_revision_id FROM planning.publish_target
      WHERE workspace_id=$1 AND social_account_id=$2`, [workspace, account.id]), [{ id: first.id, variant_revision_id: draft.revision.id }]);

    const batchInput = targetInput(draft, 48);
    const plan = await post('/publish-plans', { source: 'batch', commit_mode: 'partial', items: [batchInput,
      { ...batchInput, variant_revision_id: randomUUID() }] });
    const path = `/publish-plans/${plan.id}`;
    const preview = await post(`${path}/preview`, {});
    assert.deepEqual(preview.items.map(row => [row.index, row.action]), [[0, 'add'], [1, 'error']]);
    const committed = await post(`${path}/commit`, { preview_hash: preview.preview_hash }, { status: 202 });
    assert.equal(committed.operation_id, committed.id);
    assert.equal(committed.status, 'partially_committed', JSON.stringify(committed.items));
    assert.equal(committed.total, 2);
    assert.equal(committed.failures, 1);
    const saved = await read(path);
    assert.equal(saved.operation_id, committed.id);
    assert.deepEqual((await read(`/operations/${committed.id}`)).status, 'partially_committed');
    const items = saved.results.sort((a, b) => a.item_no - b.item_no);
    assert.deepEqual(items, committed.items);
    const [success, failure] = items;
    assert.equal(success.item_no, 0);
    assert.equal(success.status, 'approval_required');
    assert.equal(failure.item_no, 1);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.error.code, preview.items[1].error.code);
    assert.ok(failure.error.code && failure.error.message);
    assert.equal(failure.target_id ?? null, null);
    const batchTarget = await read(`/publish-targets/${success.target_id}`);
    assert.equal(batchTarget.plan_id, plan.id);
    assert.equal(batchTarget.variant_revision_id, draft.revision.id);
    assert.deepEqual(await rows('SELECT id FROM planning.publish_target WHERE workspace_id=$1 AND plan_id=$2',
      [workspace, plan.id]), [{ id: success.target_id }]);
  });

  await t.test('AS02 protects referenced asset versions and serves original bytes after rendition failure over HTTP', async () => {
    async function upload(bytes, filename) {
      const ticket = await post('/files/uploads', { purpose: 'asset', mime_type: 'image/png', original_filename: filename,
        size_bytes: bytes.length, sha256: sha256(bytes) });
      return post(`/files/uploads/${ticket.id}/complete`, { base64: bytes.toString('base64') });
    }
    const original = await upload(png, 'original.png');
    const { asset_version: version, ...asset } = await post('/assets', { brand_id: brand.id, title: 'Source image', kind: 'image', file_object_id: original.id });
    const draft = await content('AS02 fixture', [{ asset_version_id: version.id }]);
    const target = await post('/publish-targets', targetInput(draft, 72));
    const assetPath = `/assets/${asset.id}`;
    const versionPath = `/asset-versions/${version.id}`;
    const refs = async () => {
      const usage = await read(`${assetPath}/usage`);
      const revision = await read(`/content-revisions/${draft.revision.id}`);
      const scheduled = await read(`/publish-targets/${target.id}`);
      assert.ok(usage.references.some(row => row.ref_type === 'asset_version' && row.ref_id === version.id && row.revision_id === draft.revision.id));
      assert.ok(usage.publish_targets.some(row => row.id === target.id));
      assert.equal(revision.media[0].asset_version_id, version.id);
      assert.equal(scheduled.variant_revision_id, revision.id);
      return { usage, revision, scheduled };
    };
    const download = async () => {
      const { url } = await read(`${versionPath}/download`);
      const source = new URL(url, base);
      assert.equal(source.origin, base);
      const response = await fetch(source, { headers: { cookie } });
      assert.equal(response.status, 200);
      return sha256(Buffer.from(await response.arrayBuffer()));
    };
    const persisted = () => rows(`SELECT data->>'value' AS value FROM ss.entities
      WHERE workspace_id=$1 AND module='operation_runtime' AND kind='record' AND id=$2`, [workspace, `row/asset_version/${version.id}`]);
    const before = await persisted();
    assert.equal(before.length, 1);
    const metadata = await read(`${assetPath}/versions`);
    assert.deepEqual(metadata, [version]);
    const fileMetadata = await read(`/files/${original.id}`);
    assert.equal(version.file_object_id, original.id);
    assert.equal(version.sha256, sha256(png));
    assert.equal(await download(), version.sha256);
    const references = await refs();

    const overwrite = { file_object_id: randomUUID(), meta: { width: 99 }, change_note: 'Overwrite attempt' };
    for (const method of ['PATCH', 'PUT']) {
      assert.equal(await call(method, versionPath, overwrite, { version: version.version, status: 404 }), 'not_found');
    }
    assert.equal(await call('DELETE', versionPath, undefined, { version: version.version, status: 404 }), 'not_found');
    const rendition = await post(`${versionPath}/renditions`, { kind: 'cover' });
    const result = `/renditions/${rendition.id}/result`;
    const processing = await post(result, { status: 'processing', attempt: rendition.attempts }, { version: rendition.version });
    await post(result, { status: 'failed', attempt: rendition.attempts, error: 'Fixture rendition processing failure' }, { version: processing.version });
    const failed = await read(`/renditions/${rendition.id}`);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Fixture rendition processing failure');
    assert.equal(await download(), version.sha256);

    const archived = await post(`${assetPath}/archive`, {}, { version: asset.version });
    assert.equal(await call('DELETE', assetPath, undefined, { version: archived.version, status: 409 }), 'ASSET_REFERENCED');
    assert.equal(await call('DELETE', `/files/${original.id}`, undefined, { status: 409 }), 'FILE_REFERENCED');
    assert.deepEqual(await read(`${assetPath}/versions`), metadata);
    assert.deepEqual(await read(`/files/${original.id}`), fileMetadata);
    assert.deepEqual(await persisted(), before);
    assert.deepEqual(await refs(), references);
    assert.equal(await download(), version.sha256);
  });
});
