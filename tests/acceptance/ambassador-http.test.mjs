import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration } from '../../apps/server/src/config.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { postgresStore } from '../../packages/db/src/index.ts';
import { createServer } from '../../apps/server/src/server.ts';

const { Client } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('pg');
const requestUrl = process.env.SMARTSELL_AMBASSADOR_PG_URL;
const inspectUrl = process.env.SMARTSELL_AMBASSADOR_PG_INSPECT_URL;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  assert.ok(requestUrl && inspectUrl, 'Run tests/acceptance/ambassador-postgres.sh to provision both local database roles');
  for (const url of [requestUrl, inspectUrl]) {
    const address = new URL(url);
    assert.equal(address.hostname, '127.0.0.1');
    assert.equal(address.pathname, '/ambassador_acceptance');
  }
  const db = new Client({ connectionString: inspectUrl, options: '-c default_transaction_read_only=on' });
  await db.connect();
  t.after(() => db.end());
  assert.equal((await db.query('SELECT count(*)::int AS count FROM smartsell.identity')).rows[0].count, 0, 'Use a fresh acceptance database');

  const directory = await mkdtemp(join(tmpdir(), 'smartsell-ambassador-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = configuration({ DATABASE_URL: requestUrl, NODE_ENV: 'test', ROLE: 'api', SETUP_TOKEN: randomUUID() });
  const discovered = await discoverOperations();
  assert.deepEqual([...discovered.loadFailures], []);
  assert.deepEqual(discovered.missingModules, []);
  const store = await postgresStore(requestUrl);
  const originalEnv = process.env;
  const app = (() => {
    try {
      process.env = { MEDIA_DIRECTORY: directory };
      return createServer({ config, store, ...discovered });
    } finally { process.env = originalEnv; }
  })();
  t.after(() => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(method, path, body, headers = {}, status = 200) {
    const response = await fetch(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    return { json: JSON.parse(raw), headers: response.headers };
  }
  const setup = await request('POST', '/api/v1/setup', {
    name: 'Ambassador manager', email: 'ambassador@example.invalid', password: 'fixture-only-password', workspaceName: 'Ambassador acceptance',
  }, { 'x-setup-token': config.setupToken }, 201);
  const workspace = setup.json.data.workspaces[0].id;
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const { data: { csrf_token } } = setup.json;
  const call = async (method, path, body, { version, status = 200 } = {}) => {
    const { json } = await request(method, `/api/v1/workspaces/${workspace}${path}`, body, {
      cookie, 'x-csrf-token': csrf_token, ...(version !== undefined && { 'if-match': String(version) }),
    }, status);
    return status === 200 ? json.data : json.error.code;
  };
  const post = (path, body, options) => call('POST', path, body, options);
  const read = path => call('GET', path);
  const brand = await post('/brands', { name: 'Fixture brand', slug: 'ambassador-fixture' });
  async function material(title, valid_until) {
    const upload = await post('/files/uploads', { purpose: 'asset', mime_type: 'image/png', original_filename: `${title}.png`,
      size_bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
    const file = await post(`/files/uploads/${upload.id}/complete`, { base64: png.toString('base64') });
    const asset = await post('/assets', { brand_id: brand.id, title, kind: 'image', file_object_id: file.id });
    const ref = { resource_type: 'asset', resource_id: asset.id, revision_id: asset.asset_version.id };
    const grant = await post('/rights-grants', { brand_id: brand.id, grant_type: 'owned', usages: ['organic_social'], valid_until,
      assets: [{ asset_id: ref.resource_id, asset_version_id: ref.revision_id }] });
    const active = await post(`/rights-grants/${grant.id}/activate`, {}, { version: grant.version });
    assert.equal(active.status, 'active');
    return { ref, grantId: active.id, copy: { ...ref, title, text: title } };
  }
  const records = async kind => (await db.query(`SELECT value->>'id' AS id, value AS data
    FROM smartsell.record WHERE workspace_id = $1 AND id LIKE $2 ORDER BY id`, [workspace, `row/${kind}/%`])).rows;
  return { post, read, material, records };
}

test('TE07 ambassador kits and share records over HTTP and PostgreSQL', { skip: !requestUrl && !inspectUrl, timeout: 60_000 }, async t => {
  const now = Date.now();
  const iso = seconds => new Date(now + seconds * 1_000).toISOString();
  t.mock.timers.enable({ apis: ['Date'], now });
  const { post, read, material, records } = await fixture(t);
  const shorter = await material('Short-term image', iso(5));
  const longer = await material('Long-term image', iso(20));
  const list = () => read('/ambassador-kits');

  await t.test('TE07 an individual rights expiry removes only that asset from a current kit', async () => {
    const expires_at = iso(30);
    const label = 'Two pinned assets';
    const kit = await post('/ambassador-kits', { label, expires_at, materials: [shorter.ref, longer.ref] });
    const kitPath = `/ambassador-kits/${kit.id}`;
    const metadata = { id: kit.id, label, expires_at };
    assert.deepEqual(await list(), [{ ...metadata, material_count: 2, enrolled: false }]);
    assert.deepEqual(await post(`${kitPath}/enroll`, {}), { enrolled: true });
    assert.deepEqual(await post(`${kitPath}/claim`, {}), { materials: [shorter.copy, longer.copy] });

    t.mock.timers.tick(5_000);
    assert.equal((await read(`/rights-grants/${shorter.grantId}`)).status, 'active', 'No rights expiry sweep has run');
    assert.deepEqual(await list(), [{ ...metadata, material_count: 1, enrolled: true }]);
    assert.deepEqual(await post(`${kitPath}/claim`, {}), { materials: [longer.copy] });
    const url = 'https://posts.example.invalid/pinned';
    assert.equal(await post(`${kitPath}/shares`, { ...shorter.ref, url }, { status: 404 }), 'not_found');
    assert.equal(await post(`${kitPath}/shares`, { url }, { status: 422 }), 'invalid_input');
    assert.deepEqual(await records('ambassador_share'), []);
    const share = await post(`${kitPath}/shares`, { ...longer.ref, url });
    const [saved] = await records('ambassador_share');
    assert.equal(saved.id, share.id);
    assert.equal(saved.data.revision_id, longer.ref.revision_id);
    assert.equal(saved.data.status, 'reported');

    t.mock.timers.tick(15_000);
    assert.deepEqual(await list(), []);
    for (const action of ['claim', 'enroll']) {
      assert.equal(await post(`${kitPath}/${action}`, {}, { status: 404 }), 'not_found');
    }
    assert.equal(await post(`${kitPath}/shares`, { ...longer.ref, url }, { status: 404 }), 'not_found');
    assert.deepEqual(await post(`${kitPath}/leave`, {}), { enrolled: false });
    const [savedKit] = await records('ambassador_kit');
    assert.deepEqual(savedKit.data.materials, [shorter.ref, longer.ref]);
    assert.equal(savedKit.data.expires_at, expires_at);
    assert.deepEqual(await records('ambassador_share'), [saved]);
  });

  await t.test('TE07 legacy claiming records enrollment activity and only explicit share reporting creates a share', async () => {
    const { ref, copy: { title, text } } = await material('Legacy image', iso(40));
    const label = 'Legacy kit';
    const expires_at = iso(35);
    assert.equal(await post('/ambassador-kits', { ...ref, label, expires_at: iso(41) }, { status: 422 }), 'invalid_input');
    const kit = await post('/ambassador-kits', { ...ref, label, expires_at });
    const kitPath = `/ambassador-kits/${kit.id}`;
    const url = 'https://posts.example.invalid/legacy';
    const sharesForKit = async () => {
      const enrollment = (await records('ambassador_enrollment')).find(({ data }) => data.kit_id === kit.id);
      return (await records('ambassador_share')).filter(({ data }) => data.enrollment_id === enrollment?.id);
    };
    assert.deepEqual(await list(), [{ ...kit, enrolled: false }]);
    assert.equal(await post(`${kitPath}/claim`, {}, { status: 403 }), 'forbidden');
    assert.deepEqual(await post(`${kitPath}/enroll`, {}), { enrolled: true });
    assert.equal(await post(`${kitPath}/shares`, { url }, { status: 403 }), 'forbidden');
    assert.deepEqual(await post(`${kitPath}/claim`, {}), { title, text });
    assert.equal((await records('ambassador_enrollment')).find(({ data }) => data.kit_id === kit.id).data.last_claimed_at, iso(20));
    assert.deepEqual(await sharesForKit(), []);
    const share = await post(`${kitPath}/shares`, { url });
    assert.equal(share.status, 'reported');
    assert.deepEqual((await sharesForKit()).map(({ id, data }) => ({ id, url: data.url, status: data.status })), [{ ...share, url }]);
    assert.equal(await post(`${kitPath}/shares`, { url }, { status: 409 }), 'conflict');

    assert.deepEqual(await post(`${kitPath}/leave`, {}), { enrolled: false });
    assert.deepEqual(await post(`${kitPath}/enroll`, {}), { enrolled: true });
    assert.equal(await post(`${kitPath}/shares`, { url: `${url}-second` }, { status: 403 }), 'forbidden');
    t.mock.timers.tick(15_000);
    assert.equal(await post(`${kitPath}/claim`, {}, { status: 404 }), 'not_found');
    assert.deepEqual(await post(`${kitPath}/leave`, {}), { enrolled: false });
    assert.equal((await sharesForKit()).length, 1);
  });
});
