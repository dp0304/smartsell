import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client } from 'pg';

const ownerUrl = process.env.SMARTSELL_TEST_PG_ADMIN_URL;
const requestUrl = process.env.SMARTSELL_TEST_PG_URL;

test('domain DDL matches the plan and enforces scoped writes in PostgreSQL 17', { skip: !ownerUrl && !requestUrl }, async t => {
  assert.ok(ownerUrl && requestUrl);
  const owner = new Client({ connectionString: ownerUrl });
  const request = new Client({ connectionString: requestUrl });
  await owner.connect();
  await request.connect();
  t.after(async () => { await request.end(); await owner.end(); });

  const version = await owner.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.trunc(version.rows[0].version / 10_000), 17);
  const plan = await readFile(new URL('../../../plan.md', import.meta.url), 'utf8');
  const sections = plan.slice(plan.indexOf('\n## 4. '), plan.indexOf('\n## 6. '));
  const definitions = [...sections.matchAll(/^create table (\w+\.\w+)\s*\((?:[^\n]*)\n([\s\S]*?)^\)/gm)];
  const expected = definitions.map(match => match[1]!).sort();
  const schemas = [...new Set(expected.map(name => name.split('.')[0]))];
  assert.equal(new Set(expected).size, 188);
  const catalog = await owner.query(`SELECT n.nspname || '.' || c.relname AS name, c.relkind, c.relrowsecurity,
    c.relforcerowsecurity, c.relispartition, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1) AND c.relkind IN ('p','r')`, [schemas]);
  assert.deepEqual(catalog.rows.filter(row => !row.relispartition).map(row => row.name).sort(), expected);
  assert.ok(catalog.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
  const attributes = await owner.query(`SELECT a.attrelid, a.attname, a.attnotnull, format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_attribute a WHERE a.attrelid=ANY($1::oid[]) AND a.attnum>0 AND NOT a.attisdropped`,
  [catalog.rows.filter(row => !row.relispartition).map(row => row.oid)]);
  const macros = {
    std: { id: 'uuid', tenant_id: 'uuid', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' },
    ws: { workspace_id: 'uuid' }, actor: { created_by_type: 'text', created_by_id: 'uuid' }, ver: { version: 'integer' },
  };
  const oidByTable = new Map(catalog.rows.map(row => [row.name, row.oid]));
  const columnByKey = new Map(attributes.rows.map(row => [`${row.attrelid}:${row.attname}`, row]));
  for (const [, table, body] of definitions) {
    for (const [macro, columns] of Object.entries(macros)) {
      if (!body!.split('\n').some(line => line.split('--')[0]!.includes(`@${macro}`))) continue;
      for (const [column, type] of Object.entries(columns)) {
        const actual = columnByKey.get(`${oidByTable.get(table)}:${column}`);
        assert.equal(actual?.type, type, `${table}.${column} from @${macro}`);
        assert.equal(actual?.attnotnull, column !== 'created_by_id', `${table}.${column} nullability`);
      }
    }
  }
  const foreignKeys = await owner.query(`SELECT c.conrelid AS child_oid, pn.nspname || '.' || p.relname AS parent,
    a.attname AS column FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    JOIN pg_class p ON p.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
    WHERE c.contype='f' AND c.convalidated AND c.conrelid=ANY($1::oid[])`,
  [catalog.rows.filter(row => !row.relispartition).map(row => row.oid)]);
  const tableByOid = new Map(catalog.rows.map(row => [row.oid, row.name]));
  const references = new Set(foreignKeys.rows.map(row => `${tableByOid.get(row.child_oid)}.${row.column}->${row.parent}`));
  for (const [, table, body] of definitions) {
    const columns = body!.replace(/--[^\n]*/g, '');
    for (const [, column, parent] of columns.matchAll(/^\s*(\w+)\s+uuid(?: not null)? references (\w+\.\w+)/gm)) {
      assert.ok(references.has(`${table}.${column}->${parent}`), `${table}.${column} references ${parent}`);
    }
  }
  const parents = catalog.rows.filter(row => row.relkind === 'p');
  assert.equal(parents.length, 8);
  for (const parent of parents) {
    const partitions = await owner.query(`SELECT relid::regclass::text AS name, pg_get_expr(c.relpartbound,c.oid) AS bounds,
      has_table_privilege('smartsell_request', c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS direct_access
      FROM pg_partition_tree($1::regclass) p JOIN pg_class c ON c.oid=p.relid WHERE p.isleaf`, [parent.name]);
    assert.equal(partitions.rows.length, 6, parent.name);
    assert.equal(partitions.rows.filter(row => row.bounds === 'DEFAULT').length, 1, parent.name);
    assert.ok(partitions.rows.every(row => !row.direct_access), parent.name);
  }
  const { rows: [indexes] } = await owner.query(`SELECT count(*)::int count, bool_and(i.indisvalid) valid,
    count(*) FILTER (WHERE i.indpred IS NOT NULL)::int partial FROM pg_index i WHERE i.indrelid=ANY($1::oid[])`,
    [catalog.rows.filter(row => !row.relispartition).map(row => row.oid)]);
  assert.ok(indexes.count >= 333 && indexes.partial >= 26 && indexes.valid, JSON.stringify(indexes));
  assert.equal((await owner.query("SELECT to_regclass('smartsell.record') IS NOT NULL AS present")).rows[0].present, true);

  const tenantA = randomUUID(), tenantB = randomUUID();
  const workspaceA = randomUUID(), workspaceB = randomUUID(), siblingA = randomUUID();
  const actorA = randomUUID(), actorB = randomUUID();
  const tokenA = randomUUID(), tokenB = randomUUID();
  await owner.query('INSERT INTO ss.tenants (id) VALUES ($1),($2)', [tenantA, tenantB]);
  await owner.query("INSERT INTO ss.workspaces (id,tenant_id,name) VALUES ($1,$2,'A'),($3,$4,'B'),($5,$2,'A sibling')", [workspaceA, tenantA, workspaceB, tenantB, siblingA]);
  await owner.query("INSERT INTO ss.users VALUES ($1,$2,'A','!'),($3,$4,'B','!')", [actorA, `${actorA}@test.example`, actorB, `${actorB}@test.example`]);
  await owner.query("INSERT INTO ss.memberships VALUES ($1,$2,'owner'),($3,$4,'owner')", [workspaceA, actorA, workspaceB, actorB]);
  await owner.query("INSERT INTO ss.sessions VALUES ($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')", [tokenA, actorA, tokenB, actorB]);
  const brandA = randomUUID(), brandB = randomUUID(), brandSibling = randomUUID();
  const insertBrand = `INSERT INTO workspace.brand (id,tenant_id,workspace_id,slug,name,status,created_by_type)
    VALUES ($1,$2,$3,$4,'Test brand','active','user')`;
  await owner.query(insertBrand, [brandB, tenantB, workspaceB, 'shared-slug']);
  await owner.query(insertBrand, [brandSibling, tenantA, siblingA, 'shared-slug']);
  const siblingFile = randomUUID(), sharedFile = randomUUID();
  await owner.query(`INSERT INTO core.file_object (id,tenant_id,workspace_id,storage_key,bucket,mime_type,size_bytes,sha256,scan_status,purpose,created_by_type)
    VALUES ($1,$2,$3,$1::uuid::text,'fixture','image/png',1,'digest','clean','evidence','system'),
           ($4,$2,NULL,$4::uuid::text,'fixture','image/png',1,'digest','clean','evidence','system')`, [siblingFile, tenantA, siblingA, sharedFile]);
  const scoped = async (tenant: string, workspaces: string[], actor: string, token: string, run: () => Promise<void>) => {
    await request.query('BEGIN');
    try {
      await request.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_ids',$2,true), set_config('app.principal',$3,true), set_config('smartsell.session_hash',$4,true)",
        [tenant, `{${workspaces.join(',')}}`, actor, token]);
      await run();
      await request.query('COMMIT');
    } catch (error) {
      await request.query('ROLLBACK');
      throw error;
    }
  };
  const rejected = async (sql: string, args: unknown[], code: string) => {
    await request.query('SAVEPOINT expected_failure');
    await assert.rejects(request.query(sql, args), { code });
    await request.query('ROLLBACK TO SAVEPOINT expected_failure');
    await request.query('RELEASE SAVEPOINT expected_failure');
  };
  await scoped(tenantA, [workspaceA, siblingA, workspaceB], actorA, tokenA, async () => {
    await request.query(insertBrand, [brandA, tenantA, workspaceA, 'shared-slug']);
    assert.deepEqual((await request.query('SELECT id FROM workspace.brand')).rows, [{ id: brandA }]);
    await rejected(insertBrand, [randomUUID(), tenantB, workspaceB, 'foreign'], '42501');
    await rejected(insertBrand, [randomUUID(), tenantA, siblingA, 'foreign'], '42501');
    await rejected(insertBrand, [randomUUID(), tenantA, workspaceA, 'shared-slug'], '23505');
    const market = `INSERT INTO workspace.market (id,tenant_id,workspace_id,brand_id,name,country_code,
      primary_language,languages,currency,timezone,status,created_by_type)
      VALUES ($1,$2,$3,$4,'US','US','en',ARRAY['en'],'USD','UTC','active','user')`;
    await rejected(market, [randomUUID(), tenantA, workspaceA, brandB], '23503');
    await rejected(market, [randomUUID(), tenantA, workspaceA, brandSibling], '23503');
    await request.query(market, [randomUUID(), tenantA, workspaceA, brandA]);
    const evidence = `INSERT INTO core.evidence (id,tenant_id,workspace_id,file_object_id,kind,captured_at,
      linked_resource_type,linked_resource_id,created_by_type) VALUES ($1,$2,$3,$4,'file',now(),'brand',$5,'user')`;
    await rejected(evidence, [randomUUID(), tenantA, workspaceA, siblingFile, brandA], '23503');
    await request.query(evidence, [randomUUID(), tenantA, workspaceA, sharedFile, brandA]);
  });
  await scoped(tenantB, [workspaceB], actorB, tokenB, async () => {
    assert.deepEqual((await request.query('SELECT id FROM workspace.brand')).rows, [{ id: brandB }]);
  });
  await scoped(tenantA, [workspaceA], actorA, tokenB, async () => {
    assert.deepEqual((await request.query('SELECT id FROM workspace.brand')).rows, []);
  });
  assert.deepEqual((await request.query('SELECT id FROM workspace.brand')).rows, []);
});
