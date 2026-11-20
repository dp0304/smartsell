import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('Set MIGRATION_DATABASE_URL');
const directories = ['../migrations/', '../domain/'].map(path => new URL(path, import.meta.url));
const files = (await Promise.all(directories.map(async directory =>
  (await readdir(directory)).filter(name => /\.sql$/i.test(name)).map(name => ({ directory, name })),
))).flat();
if (!files.length) throw new Error('No core migrations found');
const ordered = files.map(({ directory, name }) => {
  const match = /^(\d+)_[a-z_]+\.sql$/.exec(name);
  if (!match) throw new Error(`Invalid migration filename: ${name}`);
  return { directory, name, sequence: BigInt(match[1]) };
}).sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
const migrations = await Promise.all(ordered.map(async ({ directory, name, sequence }, index) => {
  if (index > 0 && sequence === ordered[index - 1].sequence) {
    throw new Error(`Duplicate migration sequence: ${ordered[index - 1].name}, ${name}`);
  }
  const sql = await readFile(new URL(name, directory), 'utf8');
  return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}));

const client = new pg.Client({ connectionString: url });
await client.connect();
const appliedNow: string[] = [];
try {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ss.core.migrations', 0))");
  await client.query(`DO $$ BEGIN
    IF current_setting('server_version_num')::integer < 170000 THEN RAISE EXCEPTION 'PostgreSQL 17+ required'; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'smartsell_request'
      AND NOT (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
      RAISE EXCEPTION 'Provision a NOLOGIN, unprivileged smartsell_request role before migrating';
    END IF;
    IF pg_has_role('smartsell_request', current_user, 'MEMBER') THEN
      RAISE EXCEPTION 'The request role cannot inherit the migration owner';
    END IF;
  END $$`);
  await client.query('CREATE SCHEMA IF NOT EXISTS ss_migrations');
  await client.query('REVOKE ALL ON SCHEMA ss_migrations FROM PUBLIC');
  await client.query('CREATE TABLE IF NOT EXISTS ss_migrations.applied (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM ss_migrations.applied');
  const applied = new Map(rows.map(row => [row.name, row.checksum]));
  const available = new Map(migrations.map(({ name, checksum }) => [name, checksum]));
  for (const [name, checksum] of applied) {
    const current = available.get(name);
    if (current === undefined) throw new Error(`Applied migration is missing: ${name}`);
    if (current !== checksum) throw new Error(`Migration changed after application: ${name}`);
  }
  const pending = migrations.slice(applied.size);
  for (const { name } of pending) {
    if (applied.has(name)) throw new Error(`Migration history is out of order before: ${name}`);
  }
  for (const { name, sql, checksum } of pending) {
    await client.query(sql);
    await client.query('INSERT INTO ss_migrations.applied (name, checksum) VALUES ($1,$2)', [name, checksum]);
    appliedNow.push(name);
  }
  const committed = await client.query('COMMIT');
  if (committed.command !== 'COMMIT') throw new Error('Core migration transaction did not commit');
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure if the connection has already dropped.
  }
  throw error;
} finally {
  await client.end();
}
for (const name of appliedNow) console.log(`Applied ${name}`);
