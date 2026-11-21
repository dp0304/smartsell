import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Data, Row } from '@smartsell/contracts';
import { Client } from 'pg';
import { buildApp } from './app.js';
import { configuration } from './config.js';
import { createCommerceProviders } from './integration/commerce-providers.js';
import { createMediaHost } from './integration/media-host.js';
import { registerOperationRoutes } from './operation-server.js';
import { discoverOperations } from './operations.js';
import { PostgresStore } from './postgres.js';

const requestUrl = process.env.SMARTSELL_TEST_PG_URL;
const adminUrl = process.env.SMARTSELL_TEST_PG_ADMIN_URL;

// Requires its own empty database migrated with the typed domain schema.
test('PostgreSQL projects an approved publication and its manual execution', { skip: !requestUrl && !adminUrl }, async t => {
  assert.ok(requestUrl && adminUrl, 'Set both PostgreSQL test URLs');
  const config = configuration({ DATABASE_URL: requestUrl, NODE_ENV: 'test', ROLE: 'api', SETUP_TOKEN: 'domain-flow-setup' });
  const { operations, missingModules, loadFailures } = await discoverOperations();
  assert.deepEqual([...loadFailures], []);
  assert.deepEqual(missingModules, []);

  const mediaDirectory = await mkdtemp(join(tmpdir(), 'smartsell-domain-flow-'));
  t.after(() => rm(mediaDirectory, { recursive: true, force: true }));
  // Use the production host bindings with local-only fixture storage and no provider credentials.
  const { media, boundOperations } = (() => {
    const originalEnv = process.env;
    try {
      process.env = { MEDIA_DIRECTORY: mediaDirectory };
      const providers = createCommerceProviders(config);
      return { media: createMediaHost(config), boundOperations: operations.map(op =>
        op.name === 'account_register_owned_social_account' ? providers.bindOperation(op) : op) };
    } finally {
      process.env = originalEnv;
    }
  })();
  const store = new PostgresStore(requestUrl);
  const { app } = buildApp({ ...config, store, registry: new Map(),
    operationApi: { config, operations: boundOperations, register: registerOperationRoutes, media } });
  t.after(() => app.close());
  await store.ready();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  t.after(() => admin.end());

  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': config.setupToken! }, payload: {
    email: 'publisher@example.test', name: 'Publisher', workspaceName: 'Publication acceptance', password: 'acceptance-example-password',
  } });
  assert.equal(setup.statusCode, 201, setup.body);
  const { user: { id: actor }, workspaces: [{ id: workspace }] } = setup.json();
  const [session] = setup.cookies;
  assert.ok(session);
  const cookies = { [session.name]: session.value };
  const csrf = await app.inject({ url: '/api/v1/session/csrf', cookies });
  assert.equal(csrf.statusCode, 200, csrf.body);
  const csrfToken = csrf.json().csrf_token as string;
  const base = `/api/v1/workspaces/${workspace}`;
  async function get<T = Row>(path: string): Promise<T> {
    const response = await app.inject({ url: `${base}${path}`, cookies });
    assert.equal(response.statusCode, 200, `GET ${path}: ${response.body}`);
    return response.json().data;
  }
  async function post<T = Row>(path: string, payload: Data, version?: number): Promise<T> {
    const response = await app.inject({ method: 'POST', url: `${base}${path}`, cookies, payload,
      headers: { 'x-csrf-token': csrfToken, ...(version === undefined ? {} : { 'if-match': `"${version}"` }) } });
    assert.equal(response.statusCode, 200, `POST ${path}: ${response.body}`);
    return response.json().data;
  }

  const brand = await post('/brands', { name: 'Publication brand', slug: 'publication-brand' });
  const shop = await post('/stores', { brand_id: brand.id, provider: 'shopify', external_store_id: 'publication-shop',
    name: 'Publication store', default_currency: 'USD', default_locale: 'en' });
  const product = await post('/products', { store_id: shop.id, title: 'Publication product' });
  const sku = await post(`/products/${product.id}/variants`, { sku: 'PUBLICATION-01' });
  const campaign = await post('/campaigns', { brand_id: brand.id, name: 'Publication campaign', kind: 'launch', timezone: 'UTC' });
  await t.test('catalog and campaign routes write scoped relations and read typed columns', async () => {
    const { rows } = await admin.query(`SELECT b.slug, s.external_store_id, p.title, v.sku, c.utm_key
      FROM workspace.brand b JOIN commerce.store s ON (s.tenant_id,s.workspace_id,s.brand_id)=(b.tenant_id,b.workspace_id,b.id)
      JOIN commerce.product p ON (p.tenant_id,p.workspace_id,p.store_id)=(s.tenant_id,s.workspace_id,s.id)
      JOIN commerce.product_variant v ON (v.tenant_id,v.workspace_id,v.store_id,v.product_id)=(p.tenant_id,p.workspace_id,p.store_id,p.id)
      JOIN campaign.campaign c ON (c.tenant_id,c.workspace_id,c.brand_id)=(b.tenant_id,b.workspace_id,b.id)
      WHERE b.workspace_id=$1 AND b.id=$2 AND s.id=$3 AND p.id=$4 AND v.id=$5 AND c.id=$6`,
    [workspace, brand.id, shop.id, product.id, sku.id, campaign.id]);
    assert.deepEqual(rows, [{ slug: 'publication-brand', external_store_id: 'publication-shop', title: 'Publication product',
      sku: 'PUBLICATION-01', utm_key: 'publication-campaign' }]);
    await admin.query('UPDATE commerce.product SET title=$2 WHERE id=$1', [product.id, 'Typed product title']);
    assert.equal((await get(`/products/${product.id}`)).title, 'Typed product title');
  });
  const account = await post('/social-accounts', {
    brand_id: brand.id, provider: 'meta_facebook', external_account_id: 'publication-page', display_name: 'Publication page', owned_account_confirmed: true,
  });
  const caption = 'Approved PostgreSQL acceptance caption';
  const { item, variants: [draft] } = await post<{ item: Row; variants: Row[] }>('/content-items', {
    brand_id: brand.id, title: 'Publication acceptance item', variants: [{ platform: 'facebook', format: 'text', locale: 'en', body: caption }],
  });
  assert.ok(draft);
  const variantPath = `/content-variants/${draft.id}`;
  const { variant, revision } = await post<{ variant: Row; revision: Row }>(`${variantPath}/revisions`, { base_revision_id: null });
  assert.equal(variant.current_revision_id, revision.id);
  assert.partialDeepStrictEqual(revision.rendered, { text: caption });
  assert.equal((await post(`${variantPath}/readiness`, {}, variant.version)).readiness, 'ready');

  const target = await post('/publish-targets', {
    social_account_id: account.id, content_variant_id: variant.id, schedule_kind: 'asap',
  });
  assert.equal(target.plan_status, 'draft');
  assert.equal(target.variant_revision_id, revision.id);
  const targetPath = `/publish-targets/${target.id}`;
  const submitted = await post(`${targetPath}/submit`, {}, target.version);
  assert.equal(submitted.plan_status, 'awaiting_approval', JSON.stringify(submitted.precheck));
  assert.ok(submitted.approval_request_id && submitted.frozen_hash);
  const approval = await post(`${targetPath}/approve`, {
    approval_request_id: submitted.approval_request_id, resource_hash: submitted.frozen_hash, comment: 'Accepted for manual publication',
  }, submitted.version);
  assert.equal(approval.plan_status, 'ready');
  const ready = await get<Row & { execution: Row }>(targetPath);
  assert.equal(ready.execution.status, 'queued');
  assert.equal(ready.execution.frozen_hash, submitted.frozen_hash);
  const taskPath = `/execution-tasks/${ready.execution.id}`;
  const manual = await post(`${taskPath}/run-now`, {}, ready.execution.version);
  assert.equal(manual.status, 'manual');
  const started = await post<{ task: Row; attempt: Row }>(`${taskPath}/manual-start`, {}, manual.version);
  assert.equal(started.attempt.status, 'in_progress');
  const bundle = await get(`${taskPath}/manual-bundle`);
  assert.equal(bundle.attempt_id, started.attempt.id);
  assert.deepEqual(bundle.frozen, ready.execution.frozen);

  const proof = Buffer.from('Operator observed the published post.');
  const proofHash = createHash('sha256').update(proof).digest('hex');
  const upload = await post('/files/uploads', {
    purpose: 'evidence', original_filename: 'publication.txt', mime_type: 'text/plain',
    size_bytes: proof.length, sha256: proofHash,
  });
  const file = await post(`/files/uploads/${upload.id}/complete`, { base64: proof.toString('base64') });
  const permalink = 'https://www.facebook.com/publication-page/posts/domain-flow';
  const result = await post<{ task: Row; platform_post: Row }>(`${taskPath}/manual-complete`, {
    permalink, evidence_file_ids: [file.id],
  }, started.task.version);
  assert.equal(result.task.status, 'published');
  assert.equal(result.platform_post.verification, 'manual_confirmed');
  assert.equal((await get(targetPath)).plan_status, 'closed');
  const execution = await get<Row & { attempts: Row[]; evidence: Row[]; platform_post: Row }>(taskPath);
  assert.equal(execution.platform_post.id, result.platform_post.id);
  assert.deepEqual(execution.attempts.map(({ id, status }) => ({ id, status })), [{ id: started.attempt.id, status: 'verified_published' }]);
  const [evidence] = execution.evidence;
  assert.ok(evidence);
  assert.deepEqual(result.platform_post.evidence_ids, [evidence.id]);

  await t.test('content, target, and human approval share the frozen revision', async () => {
    const { rows } = await admin.query(`SELECT v.current_revision_id, v.readiness, r.rendered->>'text' AS caption,
        t.variant_revision_id, t.frozen_hash, a.resource_hash, a.status AS approval_status, d.decision, d.decided_by_user_id
      FROM content.content_item i
      JOIN content.content_variant v ON v.content_item_id=i.id AND v.workspace_id=i.workspace_id
      JOIN content.content_revision r ON r.id=v.current_revision_id AND r.workspace_id=i.workspace_id
      JOIN planning.publish_target t ON t.content_variant_id=v.id AND t.workspace_id=i.workspace_id
      JOIN core.approval_request a ON a.id=t.approval_request_id AND a.resource_id=t.id AND a.workspace_id=i.workspace_id
      JOIN core.approval_decision d ON d.request_id=a.id AND d.workspace_id=i.workspace_id
      WHERE i.workspace_id=$1 AND i.id=$2 AND t.id=$3`, [workspace, item.id, target.id]);
    assert.deepEqual(rows, [{ current_revision_id: revision.id, readiness: 'ready', caption, variant_revision_id: revision.id,
      frozen_hash: submitted.frozen_hash, resource_hash: submitted.frozen_hash, approval_status: 'approved', decision: 'approve', decided_by_user_id: actor }]);
  });

  await t.test('published task links back to the closed target', async () => {
    const { rows } = await admin.query(`SELECT t.execution_task_id, t.plan_status, t.close_reason, x.status, x.frozen_hash, x.frozen, x.platform_post_id
      FROM planning.publish_target t JOIN execution.execution_task x ON x.publish_target_id=t.id AND x.workspace_id=t.workspace_id
      WHERE t.workspace_id=$1 AND t.id=$2`, [workspace, target.id]);
    assert.deepEqual(rows, [{ execution_task_id: result.task.id, plan_status: 'closed', close_reason: 'manual_done',
      status: 'published', frozen_hash: submitted.frozen_hash, frozen: ready.execution.frozen, platform_post_id: result.platform_post.id }]);
  });

  await t.test('database rejects a duplicate decision and changes to frozen records', async () => {
    await assert.rejects(admin.query(`INSERT INTO core.approval_decision
      (id, tenant_id, workspace_id, request_id, step_no, decision, decided_by_user_id, decided_via, decided_at)
      SELECT gen_random_uuid(), tenant_id, workspace_id, request_id, step_no, decision, decided_by_user_id, decided_via, decided_at
      FROM core.approval_decision WHERE request_id=$1`, [submitted.approval_request_id]), { code: '23505' });
    await assert.rejects(admin.query("UPDATE content.content_revision SET content_hash='changed' WHERE id=$1", [revision.id]), { code: '55000' });
    await assert.rejects(admin.query('UPDATE planning.publish_target SET last_precheck_run_id=$2 WHERE id=$1', [target.id, brand.id]), { code: '23503' });
    await assert.rejects(admin.query('UPDATE execution.execution_task SET platform_post_id=$2 WHERE id=$1', [result.task.id, brand.id]), { code: '23503' });
  });

  await t.test('execution attempt records the manual outcome', async () => {
    const { rows } = await admin.query(`SELECT id, task_id, executor, status, request_hash, triggered_by_id
      FROM execution.execution_attempt WHERE workspace_id=$1 AND id=$2`, [workspace, started.attempt.id]);
    assert.deepEqual(rows, [{ id: started.attempt.id, task_id: result.task.id, executor: 'manual', status: 'verified_published',
      request_hash: submitted.frozen_hash, triggered_by_id: actor }]);
  });

  await t.test('manual post is projected with the approved target and evidence', async () => {
    const { rows } = await admin.query(`SELECT social_account_id, publish_target_id, execution_task_id, verification, permalink, evidence_ids
      FROM execution.platform_post WHERE workspace_id=$1 AND id=$2`, [workspace, result.platform_post.id]);
    assert.deepEqual(rows, [{ social_account_id: account.id, publish_target_id: target.id, execution_task_id: result.task.id,
      verification: 'manual_confirmed', permalink, evidence_ids: [evidence.id] }]);
  });

  await t.test('evidence is linked to the original execution attempt', async () => {
    const { rows } = await admin.query(`SELECT e.kind, e.file_object_id, e.linked_resource_type, e.linked_resource_id, f.sha256
      FROM core.evidence e JOIN core.file_object f ON f.id=e.file_object_id AND f.workspace_id=e.workspace_id
      WHERE e.workspace_id=$1 AND e.id=$2`, [workspace, evidence.id]);
    assert.deepEqual(rows, [{ kind: 'file', file_object_id: file.id, linked_resource_type: 'execution_attempt',
      linked_resource_id: started.attempt.id, sha256: proofHash }]);
  });
});
