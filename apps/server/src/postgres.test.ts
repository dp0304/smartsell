import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { buildApp } from './app';
import { makeContext } from './context';
import { operationRecords } from './integration/operation-records';
import { operations as campaignOperations } from './modules/campaign/index.js';
import { operations as commerceOperations } from './modules/commerce/index.js';
import type { Data, Row } from '@smartsell/contracts';
import { PostgresStore } from './postgres';
import type { Unit } from './store';

// Run against a freshly migrated, disposable database. The admin connection seeds a second tenant
// and inspects forced-RLS tables. The store and direct isolation checks use the request login.
const requestUrl = process.env.SMARTSELL_TEST_PG_URL;
const adminUrl = process.env.SMARTSELL_TEST_PG_ADMIN_URL;

test('PostgreSQL request role, setup, and workspace transactions', { skip: !requestUrl && !adminUrl }, async t => {
  assert.ok(requestUrl && adminUrl, 'Set both PostgreSQL test URLs');
  const admin = new Client({ connectionString: adminUrl });
  const request = new Client({ connectionString: requestUrl });
  const store = new PostgresStore(requestUrl);
  const privilegedStore = new PostgresStore(adminUrl);
  const origin = 'https://smartsell.test';
  const { app } = buildApp({ store, registry: new Map(), origins: new Set([origin]), secureCookie: true, setupToken: 'test-setup' });
  t.after(async () => { await app.close(); await privilegedStore.close(); await request.end(); await admin.end(); });
  await admin.connect();
  await request.connect();
  await store.ready();
  await assert.rejects(privilegedStore.ready(), /non-owner/);

  const input = { email: 'first@example.test', name: 'First', workspaceName: 'First workspace', password: 'a-long-test-password' };
  const setup = (token?: string) => app.inject({ method: 'POST', url: '/api/v1/setup',
    headers: token ? { origin, 'x-setup-token': token } : { origin }, payload: input });
  assert.equal((await setup()).statusCode, 403);
  assert.equal((await setup('wrong')).statusCode, 403);
  const outcomes = await Promise.all([setup('test-setup'), setup('test-setup')]);
  assert.deepEqual(outcomes.map(r => r.statusCode).sort(), [201, 409]);
  const winner = outcomes.find(r => r.statusCode === 201)!;
  assert.match(String(winner.headers['set-cookie']), /HttpOnly/i);
  assert.match(String(winner.headers['set-cookie']), /Secure/i);
  const { user: { id: actor }, workspaces: [{ id: workspace }] } = winner.json();
  const { rows: [first] } = await admin.query('SELECT tenant_id FROM ss.workspaces WHERE id=$1', [workspace]);
  const { rows: [second] } = await admin.query(`WITH tenant AS (INSERT INTO ss.tenants DEFAULT VALUES RETURNING id)
    INSERT INTO ss.workspaces (tenant_id,name) SELECT id,'Second workspace' FROM tenant RETURNING id,tenant_id`);
  const { rows: [other] } = await admin.query("INSERT INTO ss.users (email,name,password_hash) VALUES ('second@example.test','Second','!') RETURNING id");
  await admin.query("INSERT INTO ss.memberships VALUES ($1,$2,'owner'),($3,$2,'viewer')", [second.id, other.id, workspace]);
  const token = randomUUID();
  const otherToken = randomUUID();
  await store.issueSession(actor, token);
  await store.issueSession(other.id, otherToken);
  await assert.rejects(store.workspace(undefined, workspace, async () => null), { code: 'unauthenticated' });
  await assert.rejects(store.workspace(token, second.id, async () => null), { code: 'not_found' });
  assert.equal((await store.session(token))?.workspaces[0]?.id, workspace);
  const run = (key: string, body: (unit: Unit) => Promise<unknown>, fingerprint = key) => store.workspace(token, workspace,
    unit => unit.command({ module: 'test', action: 'execute', key, fingerprint }, () => body(unit)));

  let executions = 0;
  const create = async ({ context }: Unit) => {
    executions++;
    const record = await context.insert('test', 'record', { count: 1, stable: true }, 'main');
    await context.emit('test.created', { id: record.id });
    return record;
  };
  const duplicate = await Promise.all([run('create', create), run('create', create)]);
  assert.deepEqual(duplicate[0], duplicate[1]);
  assert.equal(executions, 1);
  await assert.rejects(run('create', create, 'different'), { code: 'idempotency_conflict' });
  await assert.rejects(store.workspace(token, workspace, unit => unit.context.insert('test', 'record', {}, 'untracked')), /active command/);
  const versions = await Promise.allSettled([2, 3].map(count => run(`update-${count}`, async ({ context }) => {
    const updated = await context.update('test', 'record', 'main', { count }, 1);
    await context.emit('test.updated', { count });
    return updated;
  })));
  const successful = versions.filter(result => result.status === 'fulfilled');
  assert.equal(successful.length, 1);
  assert.deepEqual(versions.find(result => result.status === 'rejected')?.reason?.code, 'version_conflict');
  const record = await store.workspace(token, workspace, unit => unit.context.get('test', 'record', 'main'));
  assert.equal(record?.version, 2);
  assert.equal(record.data.stable, true);

  await store.workspace(token, workspace, async unit => {
    await assert.rejects(unit.command({ module: 'test', action: 'rollback', key: 'recover', fingerprint: 'recover' }, async () => {
      await unit.context.insert('test', 'record', {}, 'rolled-back');
      await unit.context.emit('test.rolled-back', {});
      throw new Error('rollback marker');
    }), /rollback marker/);
    assert.equal(await unit.context.get('test', 'record', 'rolled-back'), undefined);
  });
  assert.equal(await run('recover', async () => 'retry committed'), 'retry committed');
  const { rows: [counts] } = await admin.query(`SELECT
    (SELECT count(*)::int FROM ss.entities) AS entities,
    (SELECT count(*)::int FROM ss.idempotency) AS keys,
    (SELECT count(*)::int FROM ss.audit) AS audits,
    (SELECT count(*)::int FROM ss.events e JOIN ss.audit a ON a.id=e.audit_id AND a.workspace_id=e.workspace_id WHERE e.ordinal=1) AS events,
    (SELECT count(*)::int FROM ss.outbox o JOIN ss.events e ON e.id=o.event_id AND e.workspace_id=o.workspace_id WHERE o.delivered_at IS NULL) AS outbox`);
  assert.deepEqual(counts, { entities: 1, keys: 3, audits: 3, events: 2, outbox: 2 });

  assert.equal(await store.workspace(otherToken, workspace, unit => unit.command({ module: 'test', action: 'execute', key: 'create', fingerprint: 'create' }, async () => 'other actor')), 'other actor');
  await store.workspace(otherToken, second.id, unit => unit.command({ module: 'test', action: 'execute', key: 'create', fingerprint: 'create' }, () => unit.context.insert('test', 'record', {}, 'second')));
  await request.query('BEGIN');
  try {
    await request.query(`SELECT set_config('smartsell.actor_id',$1,true), set_config('smartsell.tenant_id',$2,true),
      set_config('smartsell.workspace_id',$3,true)`, [actor, first.tenant_id, workspace]);
    assert.equal((await request.query('SELECT id FROM ss.entities')).rowCount, 0);
    await request.query("SELECT set_config('smartsell.session_hash',$1,true)", [token]);
    assert.deepEqual((await request.query('SELECT id FROM ss.entities')).rows, [{ id: 'main' }]);
    assert.deepEqual((await request.query('SELECT DISTINCT actor_id FROM ss.idempotency')).rows, [{ actor_id: actor }]);
    await request.query("SELECT set_config('smartsell.tenant_id',$1,true), set_config('smartsell.workspace_id',$2,true)", [second.tenant_id, second.id]);
    assert.equal((await request.query('SELECT id FROM ss.entities')).rowCount, 0);
    await assert.rejects(request.query(`INSERT INTO ss.entities (tenant_id,workspace_id,module,kind,id,data,created_at,updated_at)
      VALUES ($1,$2,'test','record','cross-tenant','{}',now(),now())`, [second.tenant_id, second.id]), { code: '42501' });
  } finally {
    await request.query('ROLLBACK');
  }
  assert.equal((await request.query('SELECT id FROM ss.entities')).rowCount, 0);
  await assert.rejects(request.query('SELECT * FROM ss.users'), { code: '42501' });
  await assert.rejects(request.query('DELETE FROM ss.audit'), { code: '42501' });

  const link = 'a'.repeat(32);
  await run('public-link', unit => unit.context.insert('team', 'share', {}, link));
  assert.equal(await store.publicWork('team.share', 'b'.repeat(32), async () => true), undefined);
  assert.equal(await store.publicWork('team.share', link, async unit => (await unit.context.get('team', 'share', link))?.id), link);

  if ((await admin.query("SELECT to_regclass('workspace.brand') IS NOT NULL AS installed")).rows[0].installed) {
    await t.test('projects commands and operations to the typed domain in the same transaction', async () => {
      const historicalBrand = randomUUID();
      await admin.query(`INSERT INTO ss.entities (tenant_id,workspace_id,module,kind,id,data,created_at,updated_at)
        VALUES ($1,$2,'workspace','brand',$3,$4,now(),now())`, [first.tenant_id, workspace, historicalBrand,
        { name: 'Existing brand', slug: 'existing-brand', status: 'active', legacy_only: true }]);
      const brand = await store.workspace(token, workspace, unit => unit.context.get('workspace', 'brand', historicalBrand));
      assert.equal(brand?.data.legacy_only, true);
      const market = await run('typed-market', ({ context }) => context.insert('workspace', 'market', {
        brand_id: historicalBrand, name: 'Taiwan', country_code: 'TW', primary_language: 'zh-TW', languages: ['zh-TW'], currency: 'TWD',
        timezone: 'Asia/Taipei', status: 'active',
      })) as { id: string };
      await run('typed-brand-update', ({ context }) => context.update('workspace', 'brand', historicalBrand, {
        name: 'Renamed brand', default_market_id: market.id,
      }, 1));
      const { rows: [brandRow] } = await admin.query('SELECT name,version,default_market_id FROM workspace.brand WHERE id=$1', [historicalBrand]);
      assert.deepEqual(brandRow, { name: 'Renamed brand', version: 2, default_market_id: market.id });
      await admin.query('UPDATE workspace.brand SET name=$2 WHERE id=$1', [historicalBrand, 'Typed brand']);
      const hydrated = await store.workspace(token, workspace, unit => unit.context.get('workspace', 'brand', historicalBrand));
      assert.equal(hydrated?.data.name, 'Typed brand');
      assert.equal(hydrated?.data.legacy_only, true);
      await run('typed-brand-slug', ({ context }) => context.update('workspace', 'brand', historicalBrand, { slug: 'renamed-brand' }, 2));
      assert.deepEqual((await admin.query('SELECT name,slug,version FROM workspace.brand WHERE id=$1', [historicalBrand])).rows,
        [{ name: 'Typed brand', slug: 'renamed-brand', version: 3 }]);

      const business = [...commerceOperations, ...campaignOperations];
      const operation = (name: string, body: Data, id?: string) => run(name, async ({ context }) => {
        const handler = business.find(item => item.name === name);
        assert.ok(handler, name);
        const { records, flush } = await operationRecords(context, false);
        const result = await handler.run(makeContext(records, context, 'owner'), { body, params: id ? { id } : {}, query: {} });
        await flush();
        return result;
      }) as Promise<Row>;
      // The Operations registry uses its own record envelope for workspace configuration.
      const operationBrand = await run('operation-brand', async ({ context }) => {
        const { records, flush } = await operationRecords(context, false);
        const brand = makeContext(records, context, 'owner').create('brand', { name: 'Catalog brand', slug: 'catalog-brand', status: 'active' });
        await flush();
        return brand;
      }) as Row;
      const catalogStore = await operation('commerce_store_create', { brand_id: operationBrand.id, provider: 'shopify', external_store_id: 'shop-01',
        name: 'Catalog store', default_currency: 'USD', default_locale: 'en' });
      const product = await operation('commerce_product_create', { store_id: catalogStore.id, title: 'Catalog product' });
      const sku = await operation('commerce_variant_create', { sku: 'CAT-01' }, product.id);
      const campaign = await operation('campaign_create_draft', { brand_id: operationBrand.id, name: 'Catalog campaign', kind: 'launch', timezone: 'UTC' });
      const { rows: [catalog] } = await admin.query(`SELECT p.title, v.sku, s.external_store_id, c.utm_key FROM commerce.product p
        JOIN commerce.product_variant v ON v.product_id=p.id JOIN commerce.store s ON s.id=v.store_id AND s.id=p.store_id
        JOIN campaign.campaign c ON c.brand_id=p.brand_id WHERE p.id=$1 AND v.id=$2 AND c.id=$3`, [product.id, sku.id, campaign.id]);
      assert.deepEqual(catalog, { title: 'Catalog product', sku: 'CAT-01', external_store_id: 'shop-01', utm_key: 'catalog-campaign' });
      await admin.query('UPDATE commerce.product SET title=$2 WHERE id=$1', [product.id, 'Read from typed catalog']);
      assert.equal((await operation('catalog_get_product', {}, product.id)).title, 'Read from typed catalog');

      const publish = await run('typed-operations', async ({ context }) => {
        const { records, flush } = await operationRecords(context, false);
        const operation = makeContext(records, context, 'owner');
        const account = operation.create('social_account', { brand_id: historicalBrand, provider: 'youtube', external_account_id: 'channel', status: 'active' });
        const item = operation.create('content_item', { brand_id: historicalBrand, title: 'Typed item', production_stage: 'drafting' });
        const variant = operation.create('content_variant', { content_item_id: item.id, platform: 'youtube', format: 'short_video', locale: 'en', draft_doc: {}, readiness: 'ready' });
        const revision = operation.create('content_revision', { variant_id: variant.id, revision_no: 1, body_doc: {}, rendered: { text: 'Hello' }, origin: 'human', content_hash: 'content-hash' });
        operation.update('content_variant', variant.id, { current_revision_id: revision.id });
        const target = operation.create('publish_target', { brand_id: historicalBrand, social_account_id: account.id, content_item_id: item.id,
          content_variant_id: variant.id, variant_revision_id: revision.id, content_format: 'short', schedule_kind: 'asap', plan_status: 'ready' });
        const approval = operation.create('approval_request', { resource_type: 'planning.publish_target', resource_id: target.id, resource_hash: 'frozen-hash', status: 'approved' });
        const decision = operation.create('approval_decision', { request_id: approval.id, step_no: 1, decision: 'approve', decided_by_user_id: actor,
          decided_via: 'web', decided_at: context.now });
        const task = operation.create('execution_task', { publish_target_id: target.id, social_account_id: account.id, operation: 'publish', content_format: 'short',
          frozen: {}, frozen_hash: 'frozen-hash', route: [{ executor: 'manual' }], status: 'queued', late_policy: 'notify' });
        const evidence = operation.create('evidence', { kind: 'manual_note', note: 'Verified', captured_at: context.now, linked_resource_type: 'execution_task', linked_resource_id: task.id });
        operation.update('publish_target', target.id, { approval_request_id: approval.id, execution_task_id: task.id });
        await flush();
        return { variant: variant.id, revision: revision.id, target: target.id, approval: approval.id, decision: decision.id, task: task.id, evidence: evidence.id };
      }) as Record<string, string>;
      const { rows: [chain] } = await admin.query(`SELECT v.current_revision_id AS revision, t.id AS target, a.id AS approval,
        d.id AS decision, x.id AS task, e.id AS evidence, x.status FROM content.content_variant v
        JOIN content.content_revision r ON r.id=v.current_revision_id JOIN planning.publish_target t ON t.variant_revision_id=r.id
        JOIN core.approval_request a ON a.id=t.approval_request_id JOIN core.approval_decision d ON d.request_id=a.id
        JOIN execution.execution_task x ON x.id=t.execution_task_id JOIN core.evidence e ON e.linked_resource_id=x.id WHERE v.id=$1`, [publish.variant]);
      const { variant: _, ...projectedIds } = publish;
      assert.deepEqual(chain, { ...projectedIds, status: 'queued' });
      const audit = await admin.query(`SELECT d.actor_id, d.outcome, d.tableoid::regclass::text AS partition
        FROM core.audit_event d JOIN ss.audit s ON s.id=d.id AND s.created_at=d.occurred_at
        WHERE d.workspace_id=$1 AND s.actor_id=$2 AND s.module='test' AND d.action='execute'`, [workspace, actor]);
      assert.ok(audit.rowCount && audit.rowCount >= 8);
      assert.ok(audit.rows.every(row => row.actor_id === actor && row.outcome === 'success' && /^core\.audit_event_p\d{6}$/.test(row.partition)));
      const backgroundUrl = process.env.SMARTSELL_TEST_PG_BACKGROUND_URL;
      assert.ok(backgroundUrl, 'Set the isolated PostgreSQL background test URL');
      const background = new PostgresStore(backgroundUrl);
      t.after(() => background.close());
      await store.ready('request');
      await background.ready('background');
      await assert.rejects(background.ready('request'), /isolated PostgreSQL request/);
      await assert.rejects(store.operationWork(second.id, async () => null), { code: '42501' });
      await assert.rejects(store.operationWorkspaces(), { code: '42501' });
      await background.operationWork(workspace, async unit => {
        const { records } = await operationRecords(unit.context, true);
        assert.equal(makeContext(records, unit.context, 'owner').get('publish_target', publish.target!).plan_status, 'ready');
      });
      await background.operationWork(second.id, async unit => {
        const { records } = await operationRecords(unit.context, true);
        assert.ok(!makeContext(records, unit.context, 'owner').list('publish_target').some(row => row.id === publish.target));
      });

      const rolledBack = randomUUID();
      await assert.rejects(store.workspace(token, workspace, async unit => {
        await unit.command({ module: 'test', action: 'typed-rollback', key: 'typed-rollback', fingerprint: '' }, () => unit.context.insert('workspace', 'brand', {
          name: 'Rolled back', slug: 'typed-rollback', status: 'active',
        }, rolledBack));
        throw new Error('outer rollback');
      }), /outer rollback/);
      assert.equal((await admin.query('SELECT 1 FROM workspace.brand WHERE id=$1', [rolledBack])).rowCount, 0);
      assert.equal((await admin.query("SELECT 1 FROM core.audit_event WHERE workspace_id=$1 AND action='typed-rollback'", [workspace])).rowCount, 0);
      assert.equal(await store.workspace(token, workspace, unit => unit.context.get('workspace', 'brand', rolledBack)), undefined);
      assert.equal((await request.query('SELECT 1 FROM workspace.brand')).rowCount, 0);
    });
  }

  await run('remove-member', async unit => { await unit.changeMembership!({ memberId: other.id, action: 'remove' }); });
  const remaining = await store.session(otherToken);
  assert.equal(remaining?.user.id, other.id);
  assert.ok(remaining?.workspaces.every(ws => ws.id !== workspace));
  await assert.rejects(store.workspace(otherToken, workspace, async () => assert.fail('removed member admitted')), { status: 404 });
  await store.revokeSession(token);
  assert.equal(await store.session(token), undefined);
});
