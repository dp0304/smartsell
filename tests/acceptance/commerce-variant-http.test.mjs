import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileStore, postgresStore } from '../../packages/db/src/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { researchDigestKind, researchDigestSubscriber } from '../../apps/server/src/modules/intel/digest-operations.ts';
import { runBackground } from '../../apps/server/src/runtime.ts';
import { createServer } from '../../apps/server/src/server.ts';

async function fixture(t, email, database, { apiOnly = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-pc02-'));
  for (const [key, value] of Object.entries({ MEDIA_DIRECTORY: join(directory, 'media'), MEDIA_S3_ENDPOINT: '' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const store = database ? await postgresStore(database) : await fileStore(join(directory, 'state.json'));
  const setupToken = 'pc02-acceptance-setup';
  const config = configuration({ SETUP_TOKEN: setupToken });
  const app = createServer({ config: apiOnly ? { ...config, roles: new Set(['api']) } : config, store, ...await discoverOperations() });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const password = 'acceptance-only-password';
  async function request(method, path, body, headers = {}, status = 200) {
    const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    return { json: JSON.parse(raw), headers: response.headers };
  }
  const session = result => ({ cookie: result.headers.get('set-cookie').split(';')[0], 'x-csrf-token': result.json.data.csrf_token });
  const setup = await request('POST', '/api/v1/setup', { name: 'Owner', email, password, workspaceName: 'PC02' }, { 'x-setup-token': setupToken }, 201);
  const { workspaces: [workspace], user } = setup.json.data;
  const otherId = randomUUID();
  const viewerId = randomUUID();
  const viewerEmail = 'pc02-viewer@example.invalid';
  // Provision a second workspace for the same owner, and a read-only user for role checks.
  const scope = await store.transaction({ identityWrite: true }, async tx => {
    const ws = tx.identity.get(`workspace/${workspace.id}`);
    tx.identity.put(`workspace/${otherId}`, { ...ws, id: otherId, name: 'PC02 isolated' });
    tx.identity.put(`member/${user.id}/${otherId}`, { userId: user.id, workspaceId: otherId, role: 'owner' });
    tx.identity.put(`user/${viewerId}`, { ...tx.identity.get(`user/${user.id}`), id: viewerId, email: viewerEmail, name: 'Viewer' });
    tx.identity.put(`email/${viewerEmail}`, viewerId);
    tx.identity.put(`member/${viewerId}/${workspace.id}`, { userId: viewerId, workspaceId: workspace.id, role: 'viewer' });
    return { tenantId: ws.tenantId, workspaceId: workspace.id, actorId: user.id };
  });
  const op = async (method, path, body, { key, version, workspaceId = workspace.id, status = 200, auth = session(setup) } = {}) => {
    const { json } = await request(method, `/api/v1/workspaces/${workspaceId}${path}`, body, {
      ...auth, ...(key && { 'idempotency-key': key }), ...(version !== undefined && { 'if-match': String(version) }),
    }, status);
    return status < 400 ? json.data : json.code;
  };
  const read = path => op('GET', path);
  const post = (path, body, key) => op('POST', path, body, { key });
  const seed = fn => store.transaction({}, async tx => fn(makeContext(await tx.workspace(scope), scope, 'owner')));
  return { app, config, store, scope, workspace, request, session, password, viewerEmail, otherId, op, read, post, seed };
}

test('PC02 preserves original catalog and content history after a manual cross-store split', async t => {
  const { store, scope, request, session, password, viewerEmail, otherId, op, read, post, seed } = await fixture(t, 'pc02@example.invalid', process.env.SMARTSELL_DATA_OPERATIONS_PG_URL);
  const brand = await post('/brands', { name: 'PC02 Brand', slug: 'pc02-brand' });
  const market = await post(`/brands/${brand.id}/markets`, { name: 'US', country_code: 'US', primary_language: 'en-US', currency: 'USD', timezone: 'UTC' });
  const storeInput = name => ({ brand_id: brand.id, provider: 'shopify', name, default_currency: 'USD', default_locale: 'en-US' });
  const north = await post('/stores', storeInput('PC02 North'), 'store-north');
  assert.deepEqual(await post('/stores', storeInput('PC02 North'), 'store-north'), north);
  const south = await post('/stores', storeInput('PC02 South'));
  assert.notEqual(north.id, south.id);
  for (const [shop, title, color, size] of [[north, 'North cap', 'Blue', 'S'], [south, 'South cap', 'Red', 'L']]) {
    await op('PUT', `/stores/${shop.id}/markets`, { market_id: market.id, channel: 'online_store', price_source: 'store_base_price' });
    const path = `/stores/${shop.id}/imports`;
    const input = { csv: `external_product_id,external_variant_id,handle,title,sku,option1,option2,price,currency\nP-1,V-1,cap,${title},PC02-SHARED,${color},${size},10.00,USD` };
    const batch = await post(path, input, `batch-${shop.id}`);
    assert.deepEqual(await post(path, input, `batch-${shop.id}`), batch);
    const confirmPath = `/imports/${batch.id}/confirm`;
    const result = await post(confirmPath, {}, `confirm-${shop.id}`);
    assert.deepEqual(await post(confirmPath, {}, `confirm-${shop.id}`), result);
  }
  const searchPath = '/products?query=PC02-SHARED';
  const matches = await read(searchPath);
  assert.equal(matches.length, 2);
  const products = await Promise.all([north, south].map(shop => read(`/products/${matches.find(row => row.store_id === shop.id).id}`)));
  const [a, b] = products;
  assert.notEqual(a.id, b.id);
  assert.ok(products.every(row => row.variants.length === 1));
  const [av, bv] = products.map(row => row.variants[0]);
  assert.notEqual(av.id, bv.id);
  for (const [product, variant, shop, color, size] of [[a, av, north, 'Blue', 'S'], [b, bv, south, 'Red', 'L']]) {
    assert.equal(product.external_product_id, 'P-1');
    assert.equal(variant.external_variant_id, 'V-1');
    assert.equal(variant.sku, 'PC02-SHARED');
    assert.equal(variant.product_id, product.id);
    assert.equal(variant.store_id, shop.id);
    assert.equal(variant.source.kind, 'file_import');
    assert.equal(variant.source.store_id, shop.id);
    assert.deepEqual(Object.values(variant.options), [color, size]);
  }
  assert.deepEqual(await read('/variant-groups'), []);
  assert.deepEqual(await read('/variant-groups/suggestions'), []);
  for (const variant of [av, bv]) {
    const updated = await op('PATCH', `/variants/${variant.id}`, { barcode: '012345678905' }, { version: variant.version });
    Object.assign(variant, updated);
  }
  const [suggestion] = await read('/variant-groups/suggestions');
  assert.deepEqual(new Set(suggestion.variant_ids), new Set([av.id, bv.id]));
  assert.equal(suggestion.reason, 'same_barcode');
  assert.deepEqual(await read('/variant-groups'), []);
  const group = await post('/variant-groups', { name: 'Reviewed caps', brand_id: brand.id }, 'group');
  assert.deepEqual(await post('/variant-groups', { name: 'Reviewed caps', brand_id: brand.id }, 'group'), group);
  const memberPath = `/variant-groups/${group.id}/members`;
  const left = await post(memberPath, { variant_id: av.id, evidence: 'Reviewed North cap' }, 'link-north');
  const body = { variant_id: bv.id, evidence: 'Reviewed South cap' };
  const right = await post(memberPath, body, 'link-south');
  assert.deepEqual(await post(memberPath, body, 'link-south'), right);
  assert.equal(await op('POST', memberPath, { variant_id: av.id }, { key: 'link-south', status: 422 }), 'IDEMPOTENCY_MISMATCH');
  assert.equal(await op('POST', memberPath, body, { status: 409 }), 'variant_already_linked');
  assert.deepEqual(new Set((await read(memberPath)).map(row => row.id)), new Set([left.id, right.id]));
  assert.ok([left, right].every(row => row.linked_via === 'manual' && row.linked_by === scope.actorId && row.unlinked_at === null));

  const campaign = await post('/campaigns', { name: 'PC02 launch', brand_id: brand.id, kind: 'launch', timezone: 'UTC',
    products: [{ product_id: b.id, variant_ids: [bv.id], role: 'hero' }] });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
  const ticket = await post('/files/uploads', { purpose: 'asset', mime_type: 'image/png', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const file = await post(`/files/uploads/${ticket.id}/complete`, { base64: bytes.toString('base64') });
  const asset = await post('/assets', { brand_id: brand.id, title: 'South cap photo', kind: 'image', file_object_id: file.id,
    links: [{ link_type: 'product_variant', link_id: bv.id }] });
  const [listing] = b.listings;
  assert.equal(listing.price_amount_minor, 1000);
  const productRef = { variant_id: bv.id, listing_snapshot_id: listing.id, market_id: market.id, currency: 'USD', field: 'price', inserted_text: '$10.00' };
  const created = await post('/content-items', { title: 'PC02 post draft', brand_id: brand.id, campaign_id: campaign.id, variants: [
    { platform: 'facebook', format: 'image', locale: 'en-US', market_id: market.id, body_markdown: 'Original South cap copy $10.00',
      media: [{ asset_version_id: asset.asset_version.id }], product_refs: [productRef] },
  ] });
  const [contentVariant] = created.variants;
  const { revision } = await post(`/content-variants/${contentVariant.id}/revisions`, { base_revision_id: null });
  const usagePath = `/products/${b.id}/usage`;
  const usage = await read(usagePath);
  assert.ok(usage.references.some(row => row.ref_type === 'product_variant' && row.ref_id === bv.id && row.revision_id === revision.id));
  assert.deepEqual(usage.campaigns.map(row => row.id), [campaign.id]);
  assert.deepEqual(usage.campaign_links.map(row => [row.campaign_id, row.variant_ids]), [[campaign.id, [bv.id]]]);
  assert.deepEqual(usage.asset_links.map(row => [row.asset_id, row.link_id]), [[asset.id, bv.id]]);
  assert.deepEqual(await read(`/products/${a.id}/usage`), { references: [], publish_target_ids: [], campaigns: [], campaign_links: [], asset_links: [] });

  const viewer = session(await request('POST', '/api/v1/login', { email: viewerEmail, password }));
  const unlinkPath = `${memberPath}/${right.id}`;
  const split = { reason: 'Different color and size on review' };
  assert.equal((await op('GET', memberPath, undefined, { auth: viewer })).length, 2);
  await op('DELETE', unlinkPath, split, { auth: viewer, status: 403 });
  const unlinked = await op('DELETE', unlinkPath, split, { key: 'split-south' });
  assert.deepEqual(await op('DELETE', unlinkPath, split, { key: 'split-south' }), unlinked);
  assert.deepEqual(await op('DELETE', unlinkPath, { reason: 'Later repeat' }), unlinked);
  assert.equal(unlinked.id, right.id);
  assert.equal(unlinked.store_id, south.id);
  assert.equal(unlinked.variant_id, bv.id);
  assert.equal(unlinked.group_id, group.id);
  assert.equal(unlinked.evidence, body.evidence);
  assert.equal(unlinked.linked_by, scope.actorId);
  assert.equal(unlinked.unlinked_by, scope.actorId);
  assert.equal(unlinked.unlink_reason, split.reason);
  assert.ok(Number.isFinite(Date.parse(unlinked.unlinked_at)));
  const [savedGroup] = await read('/variant-groups');
  assert.equal(savedGroup.id, group.id);
  const members = await read(memberPath);
  assert.deepEqual(members.filter(row => row.unlinked_at === null), [left]);
  assert.deepEqual(members.filter(row => row.unlinked_at !== null), [unlinked]);
  assert.deepEqual(savedGroup.members, members.map(row => ({ ...row, product_id: row.variant_id === av.id ? a.id : b.id, sku: 'PC02-SHARED' })));
  const later = await post(`/content-variants/${revision.variant_id}/revisions`, { base_revision_id: revision.id, body_markdown: 'Follow-up copy', product_refs: [] });
  assert.notEqual(later.revision.id, revision.id);
  const historical = await read(`/content-revisions/${revision.id}`);
  assert.deepEqual(historical, revision);
  assert.equal(historical.body, 'Original South cap copy $10.00');
  assert.deepEqual(historical.product_refs, [productRef]);
  assert.equal(historical.media[0].asset_version_id, asset.asset_version.id);
  assert.deepEqual(await read(usagePath), usage);
  assert.deepEqual((await read(`/campaigns/${campaign.id}`)).products.map(row => [row.product_id, row.variant_ids]), [[b.id, [bv.id]]]);
  for (const product of [a, b]) {
    assert.deepEqual(await read(`/products/${product.id}`), product.id === b.id ? { ...product, usage } : product);
  }

  const reviewGroup = await post('/variant-groups', { name: 'Reviewed batch', brand_id: brand.id });
  const reviewPath = `/variant-groups/${reviewGroup.id}/members`;
  const additional = await post(`/products/${b.id}/variants`, { sku: 'REVIEW-BATCH' });
  const review = { linked_via: 'suggestion_accepted', members: [{ variant_id: bv.id, evidence: 'Reviewed after split' }, { variant_id: av.id }] };
  assert.equal(await op('POST', `${reviewPath}/batch`, review, { status: 409 }), 'variant_already_linked');
  assert.deepEqual(await read(reviewPath), []);
  review.members[1].variant_id = additional.id;
  const accepted = await post(`${reviewPath}/batch`, review, 'batch-review');
  assert.deepEqual(await post(`${reviewPath}/batch`, review, 'batch-review'), accepted);
  assert.deepEqual(new Set((await read(reviewPath)).map(row => row.variant_id)), new Set([bv.id, additional.id]));
  assert.ok(accepted.every(row => row.linked_via === 'suggestion_accepted' && row.linked_by === scope.actorId));
  assert.deepEqual(await read(memberPath), members);

  const otherBrand = await post('/brands', { name: 'Other Brand', slug: 'other-brand' });
  const otherMarket = await post(`/brands/${otherBrand.id}/markets`, { name: 'US', country_code: 'US', primary_language: 'en-US', currency: 'USD', timezone: 'UTC' });
  const wrongMarket = { market_id: otherMarket.id, channel: 'online_store', price_source: 'manual' };
  await op('PUT', `/stores/${south.id}/markets`, wrongMarket, { status: 422 });
  await op('POST', `/variants/${bv.id}/listings`, { ...wrongMarket, price_minor: 999 }, { status: 422 });
  const copy = (brandId, ref) => ({ title: 'Price check', brand_id: brandId, variants: [{
    platform: 'facebook', format: 'text', locale: 'en-US', body_markdown: 'Check price', product_refs: [ref],
  }] });
  assert.match(await op('POST', '/content-items/draft', copy(otherBrand.id, productRef), { status: 422 }), /invalid_product_reference/i);
  const freshProduct = await post('/products', { store_id: south.id, title: 'Unpriced cap', status: 'active' });
  const freshVariant = await post(`/products/${freshProduct.id}/variants`, { sku: 'UNPRICED' });
  const listingsPath = `/variants/${freshVariant.id}/listings`;
  const listingInput = { market_id: market.id, channel: 'online_store' };
  const missing = await post(listingsPath, { ...listingInput, availability: 'source_not_provided' });
  assert.equal(missing.availability, 'source_not_provided');
  assert.equal(missing.price_amount_minor, null);
  assert.equal(missing.publishable_price, false);
  const rate = await seed(ctx => ctx.create('fx_rate', { quote_currency: 'USD' }));
  const estimate = await post(listingsPath, { ...listingInput, price_source: 'fx_estimate', fx_rate_id: rate.id, price_minor: 900 });
  assert.equal(estimate.is_estimate, true);
  assert.equal(estimate.publishable_price, false);
  assert.match(await op('POST', '/content-items/draft', copy(brand.id, { ...productRef, variant_id: freshVariant.id, listing_snapshot_id: estimate.id }), { status: 422 }), /invalid_product_reference/i);

  const isolated = { workspaceId: otherId };
  for (const path of [searchPath, '/variant-groups']) assert.deepEqual(await op('GET', path, undefined, isolated), []);
  for (const path of [memberPath, usagePath, `/content-revisions/${revision.id}`, `/stores/${south.id}`]) {
    await op('GET', path, undefined, { ...isolated, status: 404 });
  }
  const foreignGroup = await op('POST', '/variant-groups', { name: 'Foreign group', brand_id: (await op('POST', '/brands', { name: 'Isolated', slug: 'isolated' }, isolated)).id }, { ...isolated, key: 'group' });
  await op('POST', `/variant-groups/${foreignGroup.id}/members`, body, { ...isolated, status: 404 });
  await op('DELETE', unlinkPath, split, { ...isolated, key: 'split-south', status: 404 });
  assert.deepEqual(await read(memberPath), members);
  // The durable operation audit is separate from the visible membership history.
  await store.transaction({ readOnly: true }, async tx => {
    const audit = (await tx.workspace(scope)).list('audit/').filter(row => row.action.startsWith('commerce_variant_group_'));
    for (const [action, count] of [['create', 1], ['link', 2], ['unlink', 2]]) {
      const entries = audit.filter(row => row.action === `commerce_variant_group_${action}` && row.resource_id === group.id);
      assert.equal(entries.length, count);
      assert.ok(entries.every(row => row.actor_id === scope.actorId && row.source === 'rest'));
    }
    assert.equal(audit.filter(row => row.action === 'commerce_variant_group_link_batch' && row.resource_id === reviewGroup.id).length, 1);
  });
});


test('DS01 HTTP blocks digest export through nested evidence and rechecks current source policy', async t => {
  const { app, config, store, scope, op, post, read, seed } = await fixture(t, 'digest@example.invalid',
    process.env.SMARTSELL_DATA_INTEL_PG_URL, { apiOnly: true });
  const data_source_id = (await post('/data-sources', { kind: 'vendor', provider: 'vendor:fixture', name: 'Fixture vendor',
    contract_ref: 'fixture-only', resources: ['post_metrics'], allowed_uses: { display: true, team_share: true, export: false, cache_days: 30 } })).id;
  const target = await post('/watch-targets', { name: 'Bottle', target_type: 'keyword', query: { keywords: ['bottle'] },
    data_mode: 'vendor', data_source_id });
  // The observation sink normally receives this record from a contracted vendor.
  const observation = await seed(ctx => ctx.create('observation', { watch_target_id: target.id, subject_type: 'post',
    observed_at: ctx.now, url: 'https://example.invalid/vendor-post', metrics: { likes: { availability: 'observed', value: 42 } },
    source: { data_source_id, method: 'vendor' } }));
  const sourceBoard = await post('/research-boards', { title: 'Source' });
  const sourceItem = await post(`/research-boards/${sourceBoard.id}/items`, { item_type: 'observation', ref_id: observation.id });
  const board = await post('/research-boards', { title: 'Digest' });
  const note = await post(`/research-boards/${board.id}/notes`, { body: 'Verify vendor numbers', evidence_refs: [sourceItem.id] });
  assert.equal((await read(`/research-items/${note.id}/evidence`)).evidence.find(row => row.kind === 'observation').id, observation.id);
  const period = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() };
  const submit = async (status = 202, key = randomUUID()) => {
    const { version } = await read(`/research-boards/${board.id}`);
    return op('POST', '/research-digests', { board_id: board.id, period }, { version, key, status });
  };
  const readState = () => store.transaction({ readOnly: true }, async tx => {
    const ctx = makeContext(await tx.workspace(scope), scope, 'owner');
    return {
      digests: ctx.list('research_digest').map(row => row.id),
      operations: ctx.list('operation').filter(row => row.kind === researchDigestKind).map(row => row.id).sort(),
    };
  });
  const finishOperation = async id => {
    const stop = runBackground(store, { ...config, roles: new Set(['worker']) }, [researchDigestSubscriber], [], app.log);
    try {
      for (let i = 0; i < 80; i++) {
        const result = await read(`/operations/${id}`);
        if (result.status !== 'queued' && result.status !== 'running') return result;
        await delay(150);
      }
      assert.fail(`Operation did not finish: ${id}`);
    } finally {
      await stop();
    }
  };

  assert.equal(await submit(403), 'EGRESS_BLOCKED');
  assert.deepEqual(await readState(), { digests: [], operations: [] });
  const sourcePath = `/data-sources/${data_source_id}`;
  const source = await read(sourcePath);
  const enableExport = { allowed_uses: { export: true } };
  assert.equal(await op('PATCH', sourcePath, enableExport, { status: 428 }), 'VERSION_REQUIRED');
  const enabled = await op('PATCH', sourcePath, enableExport, { version: source.version });
  const key = randomUUID();
  const accepted = await submit(202, key);
  const { operation_id: id } = accepted;
  assert.deepEqual(Object.keys(accepted), ['operation_id']);
  assert.deepEqual(await submit(202, key), accepted);
  assert.deepEqual(await readState(), { digests: [], operations: [id] });
  const result = await finishOperation(id);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const digestId = result.result_ref.research_digest_id;
  const digestPath = `/research-digests/${digestId}`;
  assert.equal((await read(digestPath)).id, digestId);
  assert.deepEqual(await readState(), { digests: [digestId], operations: [id] });

  // Hold this operation until the source policy changes, as in the research lifecycle fixture.
  const { operation_id: policyBlocked } = await submit();
  assert.equal((await read(`/operations/${policyBlocked}`)).status, 'queued');
  await op('PATCH', sourcePath, { allowed_uses: { export: false } }, { version: enabled.version });
  assert.equal(await submit(403), 'EGRESS_BLOCKED');
  assert.equal(await op('GET', digestPath, undefined, { status: 403 }), 'EGRESS_BLOCKED');
  const expected = { digests: [digestId], operations: [id, policyBlocked].sort() };
  assert.deepEqual(await readState(), expected);
  const failed = await finishOperation(policyBlocked);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'EGRESS_BLOCKED');
  assert.equal(failed.result_ref, undefined);
  assert.deepEqual(await readState(), expected);
});
