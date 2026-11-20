import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('Set MIGRATION_DATABASE_URL for the app_owner login');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('smartsell.migrations', 0))");
  await client.query('CREATE SCHEMA IF NOT EXISTS smartsell');
  await client.query('CREATE TABLE IF NOT EXISTS smartsell.migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = new URL('../sql/', import.meta.url);
  const applied = new Set((await client.query('SELECT name FROM smartsell.migration')).rows.map(row => row.name));
  for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
    if (applied.has(name)) continue;
    await client.query(await readFile(new URL(name, directory), 'utf8'));
    await client.query('INSERT INTO smartsell.migration (name) VALUES ($1)', [name]);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
