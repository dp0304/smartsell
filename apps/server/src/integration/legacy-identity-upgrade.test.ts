import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';

const root = new URL('../../../../', import.meta.url);
const ownerUrl = process.env.SMARTSELL_LEGACY_PG_MIGRATION_URL;
const adminUrl = process.env.SMARTSELL_LEGACY_PG_ADMIN_URL;
const requestUrl = process.env.SMARTSELL_LEGACY_PG_REQUEST_URL;
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const run = promisify(execFile);

async function installLegacySchema(client: Client) {
  const directories = ['packages/db/migrations/', 'packages/db/domain/'].map(path => new URL(path, root));
  const files = (await Promise.all(directories.map(async directory => (await readdir(directory))
    .filter(name => /^\d+_[a-z_]+\.sql$/.test(name) && Number(name.split('_', 1)[0]) <= 111)
    .map(name => ({ name, url: new URL(name, directory) }))))).flat().sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(files.at(-1)?.name, '111_agent_connections.sql');
  const { rows: [empty] } = await client.query("SELECT to_regnamespace('ss') IS NULL AND to_regnamespace('ss_migrations') IS NULL AS ready");
  assert.equal(empty.ready, true, 'The legacy fixture requires a fresh disposable database');
  await client.query(`BEGIN; CREATE SCHEMA ss_migrations; REVOKE ALL ON SCHEMA ss_migrations FROM PUBLIC;
    CREATE TABLE ss_migrations.applied (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  try {
    for (const { name, url } of files) {
      const sql = await readFile(url, 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO ss_migrations.applied(name,checksum) VALUES ($1,$2)', [name, digest(sql)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function serve(database: string, mediaDirectory: string) {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert(address && typeof address !== 'string');
  const port = String(address.port);
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/command-main.ts'], {
    cwd: root, stdio: 'ignore', env: { PATH: process.env.PATH, NODE_ENV: 'development', ROLE: 'api', PORT: port,
      DATABASE_URL: database, APP_SECRET: randomBytes(32).toString('hex'), SETUP_TOKEN: 'legacy-upgrade-fixture-token', MEDIA_DIRECTORY: mediaDirectory },
  });
  const exited = once(child, 'close');
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt++) {
      if (await fetch(`${origin}/readyz`).then(response => response.ok, () => false)) return { origin, stop };
      await delay(80);
    }
    assert.fail('The upgraded Commands/Operations server failed to become ready');
  } catch (error) { await stop(); throw error; }
}

test('pre-112 PostgreSQL account, sessions, and business data survive 112/113 and a migration replay',
  { skip: !ownerUrl && !adminUrl && !requestUrl, timeout: 60_000 }, async t => {
    assert(ownerUrl && adminUrl && requestUrl, 'Supply all three disposable PostgreSQL fixture URLs');
    for (const url of [ownerUrl, adminUrl, requestUrl]) assert.equal(new URL(url).hostname, '127.0.0.1');
    const migration = new Client({ connectionString: ownerUrl });
    const admin = new Client({ connectionString: adminUrl });
    await migration.connect();
    t.after(() => migration.end());
    const { rows: [server] } = await migration.query("SELECT current_setting('server_version_num')::int / 10000 AS major");
    assert.equal(server.major, 17);
    await installLegacySchema(migration);
    await admin.connect();
    t.after(() => admin.end());
    const ledger = async () => (await migration.query('SELECT name, checksum, applied_at FROM ss_migrations.applied ORDER BY name')).rows;
    const before = await ledger();
    assert.equal(before.at(-1)?.name, '111_agent_connections.sql');
    const shape = async () => (await migration.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='ss' AND table_name='users' ORDER BY ordinal_position`)).rows.map(row => row.column_name);
    assert.deepEqual(await shape(), ['id', 'email', 'name', 'password_hash']);

    const email = 'legacy-owner@example.test';
    const name = 'Legacy owner';
    const password = 'legacy-upgrade-fixture-password';
    const workspaceName = 'Legacy workspace';
    const salt = randomBytes(16).toString('hex');
    const passwordHash = `${salt}:${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 65 * 1024 * 1024 }).toString('hex')}`;
    const { rows: [{ id: actor }] } = await migration.query('SELECT ss.bootstrap($1,$2,$3,$4) AS id', [email, name, passwordHash, workspaceName]);
    const { rows: [scope] } = await admin.query('SELECT id, tenant_id FROM ss.workspaces WHERE name=$1', [workspaceName]);
    const session = randomBytes(32).toString('base64url');
    await migration.query('SELECT ss.issue_session($1,$2,$3)', [digest(session), actor, null]);
    const expectedUser = { id: actor, email, name };
    assert.deepEqual((await migration.query('SELECT * FROM ss.session_user($1)', [digest(session)])).rows, [expectedUser]);
    const legacyBrand = { name: 'Legacy Commands brand', slug: 'legacy-commands', status: 'active' };
    const operationBrand = { name: 'Legacy Operations brand', slug: 'legacy-operations', status: 'active' };
    const [commandId, operationId] = [randomUUID(), randomUUID()];
    await admin.query(`INSERT INTO ss.entities (tenant_id,workspace_id,module,kind,id,data,version,created_at,updated_at)
      VALUES ($1,$2,'workspace','brand',$3,$4,4,now(),now())`, [scope.tenant_id, scope.id, commandId, legacyBrand]);
    const { rows: [timestamps] } = await admin.query(`INSERT INTO workspace.brand
      (tenant_id,workspace_id,id,name,slug,status,version,created_by_type,created_by_id)
      VALUES ($1,$2,$3,$4,$5,$6,7,'user',$7) RETURNING created_at, updated_at`,
      [scope.tenant_id, scope.id, operationId, operationBrand.name, operationBrand.slug, operationBrand.status, actor]);
    // The old Operations host wrote both a snapshot entry and its typed projection.
    await admin.query(`INSERT INTO ss.entities (tenant_id,workspace_id,module,kind,id,data,version,created_at,updated_at)
      VALUES ($1,$2,'operation_runtime','record',$3,$4,7,$5,$6)`, [scope.tenant_id, scope.id, `row/brand/${operationId}`,
      { value: JSON.stringify({ id: operationId, version: 7, ...operationBrand, ...timestamps }) }, timestamps.created_at, timestamps.updated_at]);

    const migrate = () => run(process.execPath, ['--import', 'tsx', 'packages/db/src/migrate-core.ts'],
      { cwd: root, env: { PATH: process.env.PATH, MIGRATION_DATABASE_URL: ownerUrl } });
    await migrate();
    const upgraded = await ledger();
    assert.deepEqual(upgraded.slice(0, before.length), before);
    assert.deepEqual(upgraded.slice(before.length, before.length + 2).map(row => row.name), ['112_bootstrap_username.sql', '113_session_user_profile.sql']);
    assert.deepEqual(await shape(), ['id', 'email', 'name', 'password_hash', 'username']);
    assert.equal((await admin.query('SELECT password_hash=$2 AND username IS NULL AS unchanged FROM ss.users WHERE id=$1',
      [actor, passwordHash])).rows[0]?.unchanged, true);

    const directory = await mkdtemp(join(tmpdir(), 'smartsell-legacy-upgrade-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { origin, stop } = await serve(requestUrl, directory);
    t.after(stop);
    const request = async (path: string, status: number, input?: object, headers: Record<string, string> = {}) => {
      const response = await fetch(`${origin}${path}`, { method: input ? 'POST' : 'GET',
        headers: { ...(input && { 'content-type': 'application/json' }), ...headers }, body: input && JSON.stringify(input) });
      assert.equal(response.status, status, path);
      return { body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const expectedWorkspaces = [{ id: scope.id, name: workspaceName, role: 'owner' }];
    const assertSession = (body: any) => {
      assert.deepEqual(body.user, expectedUser);
      assert.deepEqual(body.data.user, expectedUser);
      assert.deepEqual(body.data.workspaces, expectedWorkspaces);
    };
    const oldCookie = `smartsell_session=${session}`;
    assertSession((await request('/api/v1/session', 200, undefined, { cookie: oldCookie })).body);
    await request('/api/v1/session', 401, { email, password: 'incorrect-fixture-password' });
    const login = await request('/api/v1/session', 200, { email, password });
    assertSession(login.body);
    assert(login.cookie && login.cookie !== oldCookie);
    assertSession((await request('/api/v1/login', 200, { username: email.toUpperCase(), password })).body);
    const status = await request('/api/v1/setup/status', 200);
    assert.partialDeepStrictEqual(status.body.data, { initialized: true, token_required: true, registration_enabled: false });
    await request('/api/v1/setup', 409, { username: 'replacement', password }, { 'x-setup-token': 'legacy-upgrade-fixture-token' });

    const assertData = async (cookie: string) => {
      const base = `/api/v1/workspaces/${scope.id}`;
      const { body: commands } = await request(`${base}/records/workspace/brand`, 200, undefined, { cookie });
      assert.deepEqual(commands.items.map((row: { id: string; version: number; data: object }) =>
        ({ id: row.id, version: row.version, data: row.data })), [{ id: commandId, version: 4, data: legacyBrand }]);
      const { body: operations } = await request(`${base}/brands/${operationId}`, 200, undefined, { cookie });
      assert.partialDeepStrictEqual(operations.data, { id: operationId, version: 7, ...operationBrand });
      await request(`/api/v1/workspaces/${randomUUID()}/records/workspace/brand`, 404, undefined, { cookie });
    };
    await assertData(login.cookie);
    assert.equal((await migrate()).stdout.trim(), '');
    assert.deepEqual(await ledger(), upgraded);
    assertSession((await request('/api/v1/session', 200, undefined, { cookie: oldCookie })).body);
    await assertData(login.cookie);
  });
