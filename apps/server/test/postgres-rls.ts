import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const db = process.env.SMARTSELL_TEST_DATABASE_URL;

export async function verifyRls(tenant: string, workspace: string, actor: string, otherWorkspace: string, otherTenant: string) {
  const require = createRequire(import.meta.resolve('@smartsell/db'));
  const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => {
    connect(): Promise<void>; end(): Promise<void>;
    query(sql: string, args?: string[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  } };
  const connection = new Client({ connectionString: db! });
  await connection.connect();
  try {
    assert.equal((await connection.query('SELECT id FROM smartsell.record')).rowCount, 0);
    await connection.query('BEGIN');
    await connection.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_ids',$2,true),set_config('app.principal',$3,true)", [tenant, `{${workspace}}`, actor]);
    const visible = await connection.query('SELECT DISTINCT workspace_id FROM smartsell.record');
    assert.deepEqual(visible.rows, [{ workspace_id: workspace }]);
    assert.equal((await connection.query("DELETE FROM smartsell.record WHERE id LIKE 'audit/%'")).rowCount, 0);
    await assert.rejects(connection.query("INSERT INTO smartsell.record VALUES ($1,$2,'forbidden','{}')", [otherTenant, otherWorkspace]), { code: '42501' });
    await connection.query('ROLLBACK');
    assert.equal((await connection.query('SELECT id FROM smartsell.record')).rowCount, 0);
  } finally { await connection.end(); }
}
