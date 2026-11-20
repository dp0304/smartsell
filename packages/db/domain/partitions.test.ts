import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';

const ownerUrl = process.env.SMARTSELL_TEST_PG_ADMIN_URL;
const requestUrl = process.env.SMARTSELL_TEST_PG_URL;

test('domain partition rollover on PostgreSQL 17', { skip: !ownerUrl && !requestUrl }, async t => {
  assert.ok(ownerUrl && requestUrl);
  const owner = new Client({ connectionString: ownerUrl });
  const request = new Client({ connectionString: requestUrl });
  await owner.connect();
  t.after(() => owner.end());
  await request.connect();
  t.after(() => request.end());

  const { rows: [role] } = await owner.query(`SELECT current_setting('server_version_num')::int / 10000 AS major,
    rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  assert.deepEqual(role, { major: 17, rolsuper: false, rolbypassrls: false });
  await assert.rejects(request.query('SELECT core.ensure_domain_partitions()'), { code: '42501' });

  // Keep the disposable database usable by other tests. The owner connection
  // holds the DDL and fixture rows in one transaction, rolled back on exit.
  await owner.query("BEGIN; SET LOCAL TIME ZONE 'America/Los_Angeles'; SET LOCAL DateStyle TO 'SQL, DMY'");
  try {
    const tenantA = randomUUID(), tenantB = randomUUID(), workspaceA = randomUUID();
    await owner.query('INSERT INTO ss.tenants (id) VALUES ($1), ($2)', [tenantA, tenantB]);
    await owner.query("INSERT INTO ss.workspaces (id,tenant_id,name) VALUES ($1,$2,'Partition fixture')", [workspaceA, tenantA]);

    type AuditRow = { id: string; tenant_id: string; reason: string; diff: { fixture: boolean } };
    const insertAudit = (tenant: string, timestamp: string, reason: string) => owner.query<AuditRow>(`
      INSERT INTO core.audit_event (id,tenant_id,occurred_at,actor_type,via,action,resource_type,outcome,reason,diff)
      VALUES (gen_random_uuid(),$1,$2::timestamptz,'system','system','rollover','fixture','success',$3,'{"fixture":true}')
      RETURNING id, tenant_id, reason, diff`, [tenant, timestamp, reason]);
    const insertObservation = (timestamp: string) => owner.query(`
      INSERT INTO intel.observation (id,tenant_id,workspace_id,watch_target_id,subject_type,observed_at,metrics,source,created_by_type)
      VALUES (gen_random_uuid(),$1,$2,gen_random_uuid(),'post',$3::timestamptz,'{}','{}','system') RETURNING id`,
    [tenantA, workspaceA, timestamp]);
    const auditFixtures = [
      { tenant: tenantA, timestamp: '2092-02-01 00:00:00+00', reason: 'first included instant', child: 'audit_event_p209202' },
      { tenant: tenantB, timestamp: '2092-02-29 23:59:59.999999+00', reason: 'last instant in month', child: 'audit_event_p209202' },
      { tenant: tenantB, timestamp: '2092-03-01 00:00:00+00', reason: 'first instant in next month', child: 'audit_event_p209203' },
      { tenant: tenantA, timestamp: '2092-01-31 23:59:59.999999+00', reason: 'before the window', child: 'audit_event_default' },
      { tenant: tenantB, timestamp: '2092-07-01 00:00:00+00', reason: 'exclusive window end', child: 'audit_event_default' },
    ];
    const auditRows: (AuditRow & { child: string })[] = [];
    for (const fixture of auditFixtures) {
      const { rows: [row] } = await insertAudit(fixture.tenant, fixture.timestamp, fixture.reason);
      assert.ok(row);
      auditRows.push({ ...row, child: fixture.child });
    }
    const { rows: [quarterStart] } = await insertObservation('2092-01-01 00:00:00+00');
    const { rows: [nextQuarter] } = await insertObservation('2092-04-01 00:00:00+00');
    const { rows: [quarterDefault] } = await insertObservation('2091-09-30 23:59:59.999999+00');

    const auditPlacement = () => owner.query(`SELECT a.id, a.tenant_id, a.reason, a.diff, c.relname AS child
      FROM core.audit_event a JOIN pg_class c ON c.oid = a.tableoid WHERE a.id = ANY($1::uuid[]) ORDER BY a.reason`,
    [auditRows.map(row => row.id)]);
    const sorted = [...auditRows].sort((a, b) => a.reason.localeCompare(b.reason));
    assert.deepEqual((await auditPlacement()).rows, sorted.map(row => ({ ...row, child: 'audit_event_default' })));

    const rollover = "SELECT core.ensure_domain_partitions(DATE '2092-03-15')";
    await owner.query('CREATE TABLE ops.usage_event_p209203 (fixture int)');
    await owner.query('SAVEPOINT relation_collision');
    await assert.rejects(owner.query(rollover), { code: '42P07', message: /partition name collision for ops\.usage_event_p209203/ });
    await owner.query('ROLLBACK TO SAVEPOINT relation_collision');
    assert.equal((await owner.query("SELECT to_regclass('core.audit_event_p209202') AS child")).rows[0].child, null);
    assert.deepEqual((await auditPlacement()).rows, sorted.map(row => ({ ...row, child: 'audit_event_default' })));
    await owner.query('DROP TABLE ops.usage_event_p209203');

    // A matching name and parent are insufficient if the range is incorrect.
    await owner.query(`CREATE TABLE ops.usage_event_p209203 PARTITION OF ops.usage_event
      FOR VALUES FROM ('2096-01-01 00:00:00+00') TO ('2096-02-01 00:00:00+00')`);
    await owner.query('SAVEPOINT bounds_collision');
    await assert.rejects(owner.query(rollover), { code: '42P07', message: /partition name collision for ops\.usage_event_p209203/ });
    await owner.query('ROLLBACK TO SAVEPOINT bounds_collision');
    await owner.query('DROP TABLE ops.usage_event_p209203');

    await owner.query('SAVEPOINT default_collision');
    await owner.query('ALTER TABLE ops.usage_event_default RENAME TO usage_event_other_default');
    await owner.query('CREATE TABLE ops.usage_event_default (fixture int)');
    await assert.rejects(owner.query(rollover), { code: '42P07', message: /unexpected DEFAULT for ops\.usage_event_default/ });
    await owner.query('ROLLBACK TO SAVEPOINT default_collision');

    // Even permissive owner defaults must not grant direct child access.
    await owner.query('ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC, smartsell_request');
    await owner.query(rollover);
    await owner.query(rollover);
    assert.deepEqual((await auditPlacement()).rows, sorted);
    const { rows: observationRows } = await owner.query(`SELECT o.id, c.relname AS child
      FROM intel.observation o JOIN pg_class c ON c.oid = o.tableoid WHERE o.id = ANY($1::uuid[])`,
    [[quarterStart.id, nextQuarter.id, quarterDefault.id]]);
    assert.deepEqual(new Map(observationRows.map(row => [row.id, row.child])), new Map([
      [quarterStart.id, 'observation_p209201'], [nextQuarter.id, 'observation_p209204'], [quarterDefault.id, 'observation_default'],
    ]));

    const { rows: leaves } = await owner.query(`SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity,
      has_table_privilege('smartsell_request', c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS request_access,
      EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = c.oid) AS direct_policy,
      NOT EXISTS (SELECT FROM pg_index pi WHERE pi.indrelid = i.inhparent AND NOT EXISTS (
        SELECT FROM pg_inherits ii JOIN pg_index ci ON ci.indexrelid = ii.inhrelid
        WHERE ii.inhparent = pi.indexrelid AND ci.indrelid = c.oid AND ci.indisvalid
      )) AS valid_indexes
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE c.relispartition AND c.relkind = 'r'`);
    assert.equal(leaves.filter(row => /_p209[12]/.test(row.relname)).length, 40);
    for (const leaf of leaves) {
      assert.ok(leaf.relrowsecurity && leaf.relforcerowsecurity && !leaf.request_access && !leaf.direct_policy && leaf.valid_indexes, leaf.relname);
    }
    const { rows: [settings] } = await owner.query("SELECT current_setting('TimeZone') AS zone, current_setting('DateStyle') AS style");
    assert.deepEqual(settings, { zone: 'America/Los_Angeles', style: 'SQL, DMY' });
  } finally {
    await owner.query('ROLLBACK');
  }
});
