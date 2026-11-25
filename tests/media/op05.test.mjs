import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { start } from '../../apps/server/src/bootstrap.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { startKernel } from '../../apps/server/src/integration/kernel-runtime.ts';

const endpoint = process.env.MEDIA_TEST_S3_ENDPOINT;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');

for (const [surface, launch] of [['Commands', start], ['Operations', startKernel]]) {
  test(`OP05 ${surface} rechecks a real S3 upload linked to a scheduled revision`, { skip: !endpoint }, async t => {
    const s3 = new URL(endpoint);
    assert.equal(s3.hostname, '127.0.0.1');
    const commands = surface === 'Commands';
    const directory = await mkdtemp(join(tmpdir(), 'smartsell-op05-'));
    const setupToken = randomUUID();
    const env = { PATH: process.env.PATH, NODE_ENV: 'test', MEDIA_S3_ENDPOINT: endpoint,
      MEDIA_S3_BUCKET: process.env.MEDIA_TEST_S3_BUCKET, MEDIA_S3_ACCESS_KEY: process.env.MEDIA_TEST_S3_ACCESS_KEY,
      MEDIA_S3_SECRET_KEY: process.env.MEDIA_TEST_S3_SECRET_KEY, SETUP_TOKEN: setupToken,
      SMARTSELL_DATA_FILE: join(directory, commands ? 'commands.sqlite' : 'operations.json') };
    const originalEnv = process.env;
    process.env = env;
    let app;
    t.after(async () => {
      try { await app?.close(); }
      finally { process.env = originalEnv; await rm(directory, { recursive: true, force: true }); }
    });
    const config = configuration(env);
    app = await launch({ ...config, port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    async function request(method, path, body, headers = {}, status = 200) {
      const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${result.code ?? result.error?.code ?? ''} ${result.detail ?? ''}`);
      return { result, headers: response.headers };
    }
    const setup = await request('POST', '/api/v1/setup', {
      name: 'Retention fixture', workspaceName: 'Retention fixture', email: 'op05@example.invalid', password: randomUUID(),
    }, { 'x-setup-token': setupToken }, 201);
    const session = setup.result.data ?? setup.result;
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const csrf = session.csrf_token ?? (await request('GET', '/api/v1/session/csrf', undefined, { cookie })).result.csrf_token;
    const root = `/api/v1/workspaces/${session.workspaces[0].id}`;
    const call = async (method, path, body, status = 200, headers = {}) =>
      (await request(method, root + path, body, { cookie, 'x-csrf-token': csrf, ...headers }, status)).result;
    const op = async (...args) => (await call(...args)).data;
    const command = (action, fields, status = 200) => op('POST', `/commands/ops/${action}`, fields, status, { 'idempotency-key': randomUUID() });
    const data_class = 'asset_file';
    if (commands) {
      const { items } = await call('GET', '/commands');
      for (const action of ['get_retention_policies', 'set_retention_policy']) {
        assert.ok(items.some(item => item.module === 'ops' && item.action === action));
      }
      const catalog = await op('GET', '/catalog');
      for (const path of ['/files/retention/preview', '/files/retention/purge']) {
        assert.ok(catalog.some(operation => operation.path === path));
      }
      await call('PUT', '/admin/retention-policies', { data_class, retain_days: 0 }, 404);
      await command('set_retention_policy', { data_class, retain_days: 0, action: 'delete', workspace_id: 'default' }, 403);
    }
    const setPolicy = (retain_days, legal_hold = false, tenantDefault = false) => commands
      ? command('set_retention_policy', { data_class, retain_days, legal_hold, action: 'delete', ...(tenantDefault && { workspace_id: 'default' }) })
      : op('PUT', '/admin/retention-policies', { data_class, retain_days, legal_hold, ...(tenantDefault && { scope: 'default' }) });
    async function upload(filename) {
      const ticket = await op('POST', '/files/uploads', { original_filename: filename, purpose: 'asset', mime_type: 'image/png',
        size_bytes: png.length, sha256: sha256(png) });
      const put = await op('GET', `/files/uploads/${ticket.id}/direct`);
      assert.equal(new URL(put.url).origin, s3.origin);
      const response = await fetch(put.url, { method: put.method, headers: put.headers, body: png, redirect: 'error', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const file = await op('POST', `/files/uploads/${ticket.id}/complete`, {});
      assert.equal(file.sha256, sha256(png));
      assert.equal(file.size_bytes, 68);
      return file;
    }
    const file = await upload('schedule.png');
    const free = await upload('unreferenced.png');
    const preview = async () => {
      if (!commands) {
        const run = await op('POST', '/admin/purge-runs', { data_class });
        return { ...run.preview, id: run.id };
      }
      const { candidates } = await op('GET', '/files/retention/preview');
      return { candidates: candidates.filter(row => !row.blocked_by.length).map(row => ({ resource_id: row.id, version: row.version })),
        blocked_by: candidates.filter(row => row.blocked_by.length).map(row => ({ resource_id: row.id, reasons: row.blocked_by })) };
    };
    const approve = async run => {
      if (!commands) return op('POST', `/admin/purge-runs/${run.id}/approve`, {});
      const files = run.candidates.map(({ resource_id, version }) => ({ id: resource_id, version }));
      const { deleted, skipped } = await op('POST', '/files/retention/purge', { files });
      return { purged: deleted, skipped };
    };
    await setPolicy(30);
    assert.deepEqual((await preview()).candidates, []);
    await setPolicy(0);
    if (commands) assert.equal((await command('get_retention_policies', { data_class })).items[0].data.retain_days, 0);
    const stale = await preview();
    assert.deepEqual(new Set(stale.candidates.map(row => row.resource_id)), new Set([file.id, free.id]));

    const brand = await op('POST', '/brands', { name: 'Retention brand', slug: 'retention-brand' });
    const { id: asset_id, asset_version } = await op('POST', '/assets', { brand_id: brand.id, title: 'Fixture PNG', kind: 'image', file_object_id: file.id });
    const account = await op('POST', '/social-accounts', { brand_id: brand.id, provider: 'meta_facebook',
      display_name: 'Fixture page', external_account_id: 'fixture-page', owned_account_confirmed: true });
    const { variants: [draft] } = await op('POST', '/content-items', { brand_id: brand.id, title: 'Scheduled fixture', variants: [{
      platform: 'facebook', format: 'image', locale: 'en', body_markdown: 'Fixture caption', media: [{ asset_version_id: asset_version.id }],
    }] });
    const { revision, variant } = await op('POST', `/content-variants/${draft.id}/revisions`, { base_revision_id: null });
    const target = await op('POST', '/publish-targets', { social_account_id: account.id, content_variant_id: variant.id,
      variant_revision_id: revision.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), schedule_tz: 'UTC' });
    assert.equal(target.variant_revision_id, revision.id);
    assert.equal(revision.media[0].asset_version_id, asset_version.id);
    assert.equal(asset_version.file_object_id, file.id);
    assert.ok((await preview()).blocked_by.find(row => row.resource_id === file.id)?.reasons.includes('scheduled_target'));

    const grant = await op('POST', '/rights-grants', { brand_id: brand.id, grant_type: 'owned', usages: ['organic_social'],
      assets: [{ asset_id, asset_version_id: asset_version.id }] });
    await op('POST', `/rights-grants/${grant.id}/activate`, {}, 200, { 'if-match': String(grant.version) });
    const targetPath = `/publish-targets/${target.id}`;
    const submitted = await op('POST', `${targetPath}/submit`, {});
    assert.equal(submitted.plan_status, 'awaiting_approval', JSON.stringify(submitted.precheck));
    const scheduled = await op('POST', `${targetPath}/approve`, {}, 200, { 'if-match': String(submitted.version) });
    assert.equal(scheduled.plan_status, 'ready');

    await setPolicy(30);
    const extended = await approve(stale);
    assert.deepEqual(extended.purged, []);
    assert.deepEqual(new Set(extended.skipped), new Set([file.id, free.id]));
    await setPolicy(0);
    const beforeHold = await preview();
    await setPolicy(0, true, !commands);
    assert.ok((await preview()).blocked_by.find(row => row.resource_id === free.id)?.reasons.includes('legal_hold'));
    const held = await approve(beforeHold);
    assert.deepEqual(held.purged, []);
    assert.deepEqual(held.skipped, [free.id]);
    await setPolicy(0, false, !commands);
    const fresh = await preview();
    assert.ok(fresh.blocked_by.find(row => row.resource_id === file.id)?.reasons.includes('scheduled_target'));
    assert.deepEqual(fresh.candidates.map(row => row.resource_id), [free.id]);
    const filePreview = await op('GET', '/files/retention/preview');
    const pinned = filePreview.candidates.find(row => row.id === file.id);
    assert.ok(pinned?.blocked_by.includes('scheduled_target'));
    assert.deepEqual(await op('POST', '/files/retention/purge', { files: [pinned] }), { deleted: [], skipped: [file.id] });
    const approved = await approve(fresh);
    assert.deepEqual(approved.purged, [free.id]);
    if (!commands) assert.ok(approved.blocked_by.find(row => row.resource_id === file.id)?.reasons.includes('scheduled_target'));
    await call('GET', `/files/${free.id}`, undefined, 404);
    await op('POST', '/files/cleanup', {});
    const { url } = await op('GET', `/files/${file.id}/download`);
    const downloaded = await fetch(base + url, { headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    t.diagnostic(`${surface} verified 30→0 days, ${commands ? 'workspace' : 'inherited'} hold, scheduled_target, unreferenced purge, and unchanged 68-byte PNG`);
  });
}
