import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaFiles } from '../../extensions/media-files.js';
import { localStorage } from '../../../../../packages/media-store/src/index.js';
import test from 'node:test';
import { testWorkspace } from '../ingest/test-context.ts';
import { readers, type Commands, type Fields } from '../types.ts';
import { Problem, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { commands as contentCommands, operations as contentOperations } from '../content/index.js';
import { buildApp } from '../../app.ts';
import { configuration } from '../../config.ts';
import { createMediaHost } from '../../integration/media-host.ts';
import { commands as planningCommands } from '../planning/index.ts';
import { operations as adsOperations } from '../ads/index.ts';
import { MemoryStore } from '../../memory.ts';
import { register, type Registry } from '../../registry.ts';
import { applyAssetEvent, checkUsage, commands, operations as assetOperations, type UsageInput } from './index.ts';

const start = '2026-11-19T12:00:00.000Z';
const expiry = '2026-11-21T12:00:00.000Z';
const api: Commands = {
  ...commands,
  seed: { roles: readers, run: (ctx, { module, kind, data, id }) => ctx.insert(module, kind, data, id) },
  check: { roles: readers, run: (ctx, input) => checkUsage(ctx, input as UsageInput) },
};

async function fixture() {
  const ws = testWorkspace();
  const run = (action: string, input: Fields = {}, opts?: Parameters<typeof ws.run>[3]) => ws.run(api, action, input, opts);
  await run('seed', { module: 'workspace', kind: 'brand', id: 'brand-1', data: {} });
  await run('seed', { module: 'workspace', kind: 'brand', id: 'brand-2', data: {} });
  const file = async (id: string, hex: string) => run('seed', { module: 'core', kind: 'file_object', id,
    data: { purpose: 'asset', scan_status: 'clean', sha256: hex.repeat(64), mime_type: 'image/jpeg', meta: { width: 1920 } },
  });
  await file('original', 'a');
  await file('new-file', 'b');
  const { asset, version } = await run('asset_create', { brand_id: 'brand-1', kind: 'image', title: 'Product hero', file_object_id: 'original' });
  const check = (patch: Fields = {}, opts?: Parameters<typeof ws.run>[3]) => run('check', {
    asset_version_id: version.id, platform: 'instagram', market: 'US', purpose: 'organic_social', at: start, ...patch,
  }, opts);
  const draft = (patch: Fields = {}) => run('rights_create_draft', {
    brand_id: 'brand-1', grant_type: 'owned', grantor_kind: 'brand', asset_version_id: version.id,
    terms: { usages: ['organic_social'], platforms: ['instagram'], regions: ['US'], valid_from: start, valid_until: expiry }, ...patch,
  });
  return { ws, run, asset, version, check, draft };
}

test('exact-version rights enforce scope, human confirmation and the exclusive expiry boundary', async () => {
  const { run, asset, version, check, draft } = await fixture();
  assert.deepEqual(await check(), { allowed: false, reason: 'no_grant' });
  const grant = await draft();
  const activate = { rights_grant_id: grant.id, revision_id: grant.data.current_revision_id };
  assert.equal((await check()).allowed, false);
  await assert.rejects(run('rights_activate', activate, { role: 'editor' }), { code: 'forbidden' });
  await run('rights_activate', activate, { role: 'reviewer' });
  assert.deepEqual(await check({ purpose: 'organic' }), { allowed: true, grant_id: grant.id, grant_version: 1, valid_until: expiry, warnings: ['expiring_within_days'] });
  assert.equal((await check({ purpose: 'paid_ads' })).reason, 'usage_not_covered');
  assert.equal((await check({ market: 'CA' })).reason, 'region_not_covered');
  assert.equal((await check({ platform: 'youtube' })).reason, 'platform_not_covered');
  assert.equal((await check({ modification: true })).reason, 'modification_not_allowed');
  assert.equal((await check({ at: expiry })).reason, 'expired');
  const second = (await run('asset_add_version', { asset_id: asset.id, file_object_id: 'new-file' })).version;
  assert.equal((await check({ asset_version_id: second.id })).reason, 'no_grant');
  assert.equal((await check({ asset_version_id: version.id }, { workspaceId: 'workspace-2' })).allowed, false);
});

test('rights reject unavailable bound files and a mismatched current-version pointer', async () => {
  const { run, asset, version, draft, check } = await fixture();
  const grant = await draft();
  await run('rights_activate', { rights_grant_id: grant.id, revision_id: grant.data.current_revision_id });
  assert.equal((await check({ platform: 'meta_instagram' })).allowed, true);
  const other = await run('seed', { module: 'asset', kind: 'asset', data: { current_version_id: version.id } });
  assert.deepEqual(await run('asset_check_usage', { asset_ids: [other.id], usage: 'organic', platform: 'instagram', region: 'US' }),
    [{ asset_id: other.id, allowed: false, reason: 'asset_version_not_found' }]);
  await run('seed', { module: 'asset', kind: 'asset_version', id: 'missing-file-version', data: { asset_id: asset.id, file_object_id: 'missing-file' } });
  assert.deepEqual(await check({ asset_version_id: 'missing-file-version' }), { allowed: false, reason: 'file_unavailable' });
});

test('an unapproved revision cannot change usable rights and expiry records the frozen grant use once', async () => {
  const { ws, run, draft, check } = await fixture();
  const grant = await draft();
  await run('rights_activate', { rights_grant_id: grant.id, revision_id: grant.data.current_revision_id });
  await run('rights_add_revision', { rights_grant_id: grant.id, terms: { usages: ['paid_ads'], valid_from: start } });
  assert.equal((await check()).grant_version, 1);
  assert.equal((await check({ purpose: 'paid_ads' })).allowed, false);
  await run('seed', { module: 'planning', kind: 'publish_target_ref', data: { ref_type: 'rights_grant', ref_id: grant.id, publish_target_id: 'used-target' } });
  await run('seed', { module: 'execution', kind: 'platform_post', id: 'used-post', data: { publish_target_id: 'used-target', post_status: 'live' } });
  await run('seed', { module: 'execution', kind: 'platform_post', id: 'other-post', data: { publish_target_id: 'other-target', post_status: 'live' } });
  assert.deepEqual(await run('rights_expiry_scan', {}, { now: expiry }), { expired: [grant.id], expiring: [] });
  assert.deepEqual(await run('rights_expiry_scan', {}, { now: expiry }), { expired: [], expiring: [] });
  assert.deepEqual(ws.list('asset', 'rights_impact').map(row => row.data.platform_post_id), ['used-post']);
  assert.equal(ws.events().filter(row => row.event === 'asset.rights_grant.expired').length, 1);
});

test('renaming keeps reverse references and rendition retries never rewrite the original version', async () => {
  const { ws, run, asset, version } = await fixture();
  await run('seed', { module: 'content', kind: 'content_reference', data: { ref_type: 'asset_version', ref_id: version.id } });
  const folder = await run('asset_folder_create', { brand_id: 'brand-1', name: 'Launch' });
  await run('asset_update', { asset_id: asset.id, title: 'New name', folder_id: folder.id });
  assert.equal((await run('asset_usage', { asset_id: asset.id })).content.length, 1);
  const renditionInput = { asset_version_id: version.id, kind: 'crop', params: { width: 720, height: 1080 } };
  const rendition = await run('asset_request_rendition', renditionInput);
  assert.equal((await run('asset_request_rendition', { ...renditionInput, params: { height: 1080, width: 720 } })).id, rendition.id);
  const rend = (status: string, attempt: number, more: Fields = {}) => run('asset_update_rendition_status', { rendition_id: rendition.id, status, attempt, ...more });
  await rend('processing', 1);
  await rend('failed', 1, { error: 'encoder failed' });
  await run('asset_retry_rendition', { rendition_id: rendition.id });
  await assert.rejects(rend('processing', 1), { code: 'invalid_state' });
  await rend('processing', 2);
  await rend('ready', 2, { file_object_id: 'new-file' });
  await assert.rejects(rend('ready', 2, { file_object_id: 'original' }), { code: 'invalid_state' });
  assert.deepEqual(ws.list('asset', 'asset_version'), [version]);
});

test('[AS05-EXPIRED-ORGANIC] an expired asset grant blocks submitting a new schedule', async () => {
  const { ws, run, asset, version, draft } = await fixture();
  const seed = (module: string, kind: string, id: string, data: Fields) => run('seed', { module, kind, id, data });
  const grant = await draft();
  await run('rights_activate', { rights_grant_id: grant.id, revision_id: grant.data.current_revision_id });
  await seed('content', 'content_variant', 'variant', { current_revision_id: 'revision', brand_id: asset.data.brand_id });
  await seed('content', 'content_revision', 'revision', { variant_id: 'variant', platform: 'instagram', format: 'text', body: 'Launch', market: 'US', asset_version_ids: [version.id] });
  await seed('account', 'social_account', 'account', { provider: 'meta_instagram', status: 'active', default_timezone: 'UTC' });
  const plan = (action: string, input: Fields) => ws.run(planningCommands, action, input, { now: expiry });
  const target = await plan('create_target', { account_id: 'account', content_variant_id: 'variant', route: 'manual', visibility: 'public', scheduled_at: expiry });
  await assert.rejects(plan('submit', { target_id: target.id, expected_version: target.version }), {
    code: 'precheck_blocked', message: /asset_rights_denied:.*expired/,
  });
  assert.equal(ws.list('planning', 'publish_target')[0].data.status, 'draft');
  assert.deepEqual(ws.list('planning', 'approval'), []);
});

test('takedown revocation tracks an actual frozen use and blocks at the revocation instant', async () => {
  const { ws, run, draft, check, version } = await fixture();
  const grant = await draft();
  await run('rights_activate', { rights_grant_id: grant.id, revision_id: grant.data.current_revision_id });
  await run('seed', { module: 'planning', kind: 'publish_target', id: 'frozen-target', data: {
    frozen: { asset_versions: [{ id: version.id, grant_id: grant.id, grant_version: 1 }] },
  } });
  await run('seed', { module: 'execution', kind: 'execution_task', id: 'task', data: { publish_target_id: 'frozen-target' } });
  await run('seed', { module: 'execution', kind: 'platform_post', id: 'live', data: { execution_task_id: 'task' } });
  await run('seed', { module: 'execution', kind: 'platform_post', id: 'removed', data: { target_id: 'frozen-target', status: 'deleted' } });
  const revokedAt = '2026-11-20T12:00:00.000Z';
  await run('rights_revoke', { rights_grant_id: grant.id, revocation_effect: 'takedown_required' }, { now: revokedAt });
  assert.equal((await check({ at: revokedAt })).reason, 'revoked');
  assert.equal((await check()).allowed, true);
  assert.deepEqual(ws.list('asset', 'rights_impact').map(row => [row.data.platform_post_id, row.data.required_action]), [['live', 'takedown_required']]);
  assert.deepEqual(ws.list('workspace', 'work_item').map(row => row.data.subject_ref), [{ kind: 'platform_post', id: 'live' }]);
});

test('intake keeps declarations in draft and external observation preserves the older file', async () => {
  const { ws, run } = await fixture();
  await run('seed', { module: 'core', kind: 'file_object', id: 'incoming', data: {
    purpose: 'import', scan_status: 'clean', sha256: 'c'.repeat(64), mime_type: 'image/jpeg', size_bytes: 128,
  } });
  const box = await run('submission_box_create', { brand_id: 'brand-1', name: 'Brief', expires_at: expiry, requires_rights_form: true });
  const submission = await run('submission_receive', { box_id: box.id, kind: 'image', title: 'Creator still', submitter: 'Creator', file_object_id: 'incoming',
    declared_rights: { usages: ['organic_social'], valid_from: start, valid_until: expiry },
  });
  assert.equal(ws.list('asset', 'asset').length, 1);
  await assert.rejects(run('submission_accept_batch', { box_id: box.id, submissions: [{ submission_id: submission.id }, { submission_id: submission.id }] }), { code: 'invalid_input' });
  await run('submission_accept_batch', { box_id: box.id, submissions: [{ submission_id: submission.id, expected_version: submission.version }] });
  assert.equal(ws.list('asset', 'asset').length, 2);
  assert.equal(ws.list('asset', 'rights_grant')[0].data.status, 'draft');
  const imported = await run('asset_import_external', { brand_id: 'brand-1', kind: 'image', title: 'Design', provider: 'canva',
    external_file_id: 'design-1', external_version: 'v1', file_object_id: 'original', edit_url: 'https://www.canva.com/design/example/edit',
  });
  const frozen = { asset_versions: [{ id: imported.version.id, sha256: imported.version.data.sha256 }] };
  const target = await run('seed', { module: 'planning', kind: 'publish_target', id: 'approved-target', data: { status: 'scheduled', frozen } });
  await run('seed', { module: 'planning', kind: 'publish_target_ref', data: { publish_target_id: target.id, ref_type: 'asset_version', ref_id: imported.version.id } });
  await run('asset_observe_external_version', { source_id: imported.source.id, external_version: 'v2' });
  assert.deepEqual(ws.list('planning', 'publish_target'), [target]);
  assert.equal(ws.list('asset', 'asset').find(row => row.id === imported.asset.id)?.data.current_version_id, imported.version.id);
  const next = await run('asset_import_external_version', { source_id: imported.source.id, external_version: 'v2', file_object_id: 'new-file' });
  assert.equal(next.version.data.version_no, 2);
  assert.deepEqual(ws.list('asset', 'asset_version').find(row => row.id === imported.version.id), imported.version);
  assert.deepEqual(ws.list('planning', 'publish_target'), [target]);
});

test('[AS03-CONTEXT] authenticated context isolates brands and separates active revision numbers from proposals', async t => {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const store = new MemoryStore();
  await store.setup({ email: 'asset@example.invalid', name: 'Owner', workspaceName: 'Assets', passwordHash: 'unused' }, tokenHash);
  const wid = (await store.session(tokenHash))!.workspaces[0].id;
  const registry: Registry = new Map();
  register(registry, 'asset', api);
  const { app } = buildApp({ store, registry, secureCookie: false, origins: new Set() });
  t.after(() => app.close());
  const request = (action: string, payload: Fields, authenticated = true) => app.inject({
    method: 'POST', url: `/api/v1/workspaces/${wid}/commands/asset/${action}`, payload,
    headers: { ...(authenticated ? { cookie: `smartsell_session=${token}` } : {}), 'idempotency-key': randomUUID() },
  });
  const run = async (action: string, payload: Fields) => {
    const response = await request(action, payload);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  for (const brand_id of ['brand-1', 'brand-2']) {
    await run('seed', { module: 'workspace', kind: 'brand', id: brand_id, data: {} });
    await run('seed', { module: 'workspace', kind: 'market', id: `${brand_id}-market`, data: { brand_id } });
  }
  assert.equal((await request('knowledge_get_context', { brand_id: 'brand-1' }, false)).statusCode, 401);
  assert.equal((await request('knowledge_get_context', { brand_id: 'brand-1', market_id: 'brand-2-market' })).statusCode, 422);
  const propose = (brand_id: string, body: string, entry_id?: string) => run('knowledge_propose', { brand_id, kind: 'tone', title: 'Voice', body, entry_id });
  const first = await propose('brand-1', 'Use plain language.');
  await run('knowledge_approve', { revision_id: first.revision.id });
  const other = await propose('brand-2', 'Internal rule for another brand.');
  await run('knowledge_approve', { revision_id: other.revision.id });
  const revision = await propose('brand-1', 'A suggested revision.', first.entry.id);
  const published = await run('knowledge_get_context', { brand_id: 'brand-1' });
  assert.deepEqual(published.proposed, []);
  const context = await run('knowledge_get_context', { brand_id: 'brand-1', include_proposed: true });
  assert.deepEqual(context.active.map((item: Fields) => [item.revision_no, item.body]), [[1, 'Use plain language.']]);
  assert.deepEqual(context.proposed.map((item: Fields) => [item.revision_no, item.status]), [[2, 'proposed']]);
  assert.deepEqual((await run('knowledge_get_context', { brand_id: 'brand-2' })).active.map((item: Fields) => item.body), ['Internal rule for another brand.']);
  await run('knowledge_approve', { revision_id: revision.revision.id });
  assert.equal((await run('knowledge_get_context', { brand_id: 'brand-1' })).active[0].revision_no, 2);
});

test('knowledge suggestions stay separate and renders mark dynamic values for revalidation', async () => {
  const { run } = await fixture();
  const proposal = await run('knowledge_propose', { brand_id: 'brand-1', kind: 'tone', title: 'Voice', body: 'Use plain language.' });
  const context = await run('knowledge_get_context', { brand_id: 'brand-1', include_proposed: true });
  assert.deepEqual(context.active, []);
  assert.deepEqual(context.proposed.map((row: Fields) => [row.entry_id, row.revision_no]), [[proposal.entry.id, 1]]);
  const template = await run('template_create', { brand_id: 'brand-1', kind: 'cta', name: 'Sale', body: 'Buy for {{listing.price}}', variables: [{ key: 'listing.price', source: 'listing' }] });
  await run('seed', { module: 'workspace', kind: 'market', id: 'market-us', data: { brand_id: 'brand-1' } });
  await run('seed', { module: 'commerce', kind: 'product', id: 'product', data: { brand_id: 'brand-1' } });
  await run('seed', { module: 'commerce', kind: 'product_variant', id: 'sku', data: { product_id: 'product' } });
  await run('seed', { module: 'commerce', kind: 'listing_snapshot', id: 'observed', data: {
    variant_id: 'sku', market_id: 'market-us', price_amount_minor: 2000, is_current: true, is_estimate: false, availability: 'observed',
  } });
  const input = { brand_id: 'brand-1', market_id: 'market-us', template_id: template.id };
  const result = await run('template_render', { ...input, values: { 'listing.price': { listing_snapshot_id: 'observed' } } });
  const forged = await run('template_render', { ...input, values: { 'listing.price': '$20' } });
  assert.deepEqual(forged.missing, ['listing.price']);
  assert.equal(forged.body, 'Buy for {{listing.price}}');
  assert.deepEqual(result.revalidate, [{ key: 'listing.price', source: 'listing' }]);
  assert.equal(result.body, 'Buy for 2000');
  assert.equal((await run('template_list', { brand_id: 'brand-1' }))[0].data.body, 'Buy for {{listing.price}}');

});

test('[AS04-COMMIT-DRIFT] rejects stale price and promotion on content commit', async () => {
  const { ws, run } = await fixture();
  const content = (action: string, input: Fields, now = start) => ws.run(contentCommands, action, input, { now });
  await run('seed', { module: 'workspace', kind: 'market', id: 'market-us', data: { brand_id: 'brand-1' } });
  await run('seed', { module: 'commerce', kind: 'product', id: 'product', data: { brand_id: 'brand-1' } });
  await run('seed', { module: 'commerce', kind: 'product_variant', id: 'sku', data: { product_id: 'product' } });
  await run('seed', { module: 'commerce', kind: 'listing_snapshot', id: 'observed', data: {
    variant_id: 'sku', market_id: 'market-us', price_amount_minor: 2000, is_current: true, is_estimate: false, availability: 'observed',
  } });
  const offer = await run('template_create', { brand_id: 'brand-1', kind: 'caption_template', name: 'Offer',
    body: 'Buy for {{price}} with {{discount}}', variables: [{ key: 'price', source: 'listing' }, { key: 'discount', source: 'promotion' }] });
  const seed = (kind: string, id: string, data: Fields) => run('seed', { module: 'commerce', kind, id, data });
  await seed('store', 'shop', { brand_id: 'brand-1' });
  await seed('promotion', 'offer', { store_id: 'shop', verified_at: start, valid_from: start, valid_until: expiry, market_ids: ['market-us'], state: 'active' });
  await seed('promotion_code', 'code', { promotion_id: 'offer', code: 'SAVE10' });
  const { item } = await content('content_create_item', { brand_id: 'brand-1', title: 'Sale' });
  const { variant } = await content('content_create_variant', { content_item_id: item.id, platform: 'generic', format: 'text', market_id: 'market-us' });
  const apply = (expected_version: number, listing_snapshot_id: string) => run('template_apply', {
    template_id: offer.id, variant_id: variant.id, expected_version,
    values: { price: { listing_snapshot_id }, discount: { promotion_id: 'offer', promotion_code_id: 'code' } },
  }, { now: start });
  const draft = await apply(variant.version, 'observed');
  assert.equal(draft.data.draft_doc.body, 'Buy for 2000 with SAVE10');
  const commit = (expected_version: number, now = start, extra: Fields = {}) => content('content_commit_revision', {
    variant_id: variant.id, expected_version, base_revision_id: null, ...extra,
  }, now);
  const supersede: Commands = { supersede: { roles: readers, async run(ctx) {
    const previous = await ctx.get('commerce', 'listing_snapshot', 'observed');
    assert.ok(previous);
    await ctx.update('commerce', 'listing_snapshot', previous.id, { is_current: false }, previous.version);
    return ctx.insert('commerce', 'listing_snapshot', { ...previous.data, price_amount_minor: 2500 }, 'new-price');
  } } };
  await ws.run(supersede, 'supersede', {});
  await assert.rejects(commit(draft.version, start, { draft_doc: { template_application: null } }), { code: 'TEMPLATE_VALUES_CHANGED' });
  const refreshed = await apply(draft.version, 'new-price');
  await assert.rejects(commit(refreshed.version, expiry), { code: 'TEMPLATE_VALUES_CHANGED' });
  assert.equal(ws.list('content', 'content_revision').length, 0);
  const { revision } = await commit(refreshed.version);
  assert.equal(revision.data.body, 'Buy for 2500 with SAVE10');
  assert.equal((await run('template_list', { brand_id: 'brand-1' })).find((row: Fields) => row.id === offer.id).data.body, 'Buy for {{price}} with {{discount}}');
});


function flatContext() {
  const rows = new Map<string, Row>();
  const key = (kind: string, id: string) => `${kind}/${id}`;
  const ctx: Context = {
    tenantId: 'tenant', workspaceId: 'workspace', actorId: 'owner', role: 'owner', now: start,
    get(kind, id) {
      const row = rows.get(key(kind, id));
      if (!row) throw new Problem(404, 'NOT_FOUND', `Missing ${kind}/${id}`);
      return row;
    },
    list: kind => [...rows].filter(([path]) => path.startsWith(`${kind}/`)).map(([, row]) => row),
    create(kind, values) {
      const id = randomUUID();
      const row = { ...values, id, version: 1, created_at: start, updated_at: start };
      rows.set(key(kind, id), row);
      return row;
    },
    update(kind, id, patch) {
      const original = ctx.get(kind, id);
      const row = { ...original, ...patch, version: original.version + 1 };
      rows.set(key(kind, id), row);
      return row;
    },
    remove: (kind, id) => { rows.delete(key(kind, id)); },
    emit() {},
  };
  async function call<T>(operations: Operation[], name: string, body: Data, id?: string): Promise<T> {
    const operation = operations.find(candidate => candidate.name === name);
    assert.ok(operation, name);
    return await operation.run(ctx, { body, params: id ? { id } : {}, query: {} }) as T;
  }
  return { ctx, call };
}

test('[AS05-EXPIRED-PAID] an expired asset grant blocks a new paid proposal from entering approval', async () => {
  const { ctx, call } = flatContext();
  const brand = ctx.create('brand', {});
  const account = await call<Row>(adsOperations, 'ads_register_account', {
    provider: 'meta_ads', external_account_id: 'asset-test', brand_id: brand.id, currency: 'USD', timezone: 'UTC', spend_cap_snapshot: 1000,
  });
  const asset = ctx.create('asset', { brand_id: brand.id, status: 'ready' });
  const version = ctx.create('asset_version', { asset_id: asset.id });
  const rendition = ctx.create('asset_rendition', { asset_version_id: version.id, status: 'ready' });
  const creative = await call<Row>(adsOperations, 'ads_create_creative', { brand_id: brand.id, origin: 'asset', origin_ref: asset.id });
  const variant = await call<Row>(adsOperations, 'ads_create_creative_variant', {
    headline: 'Headline', primary_text: 'Copy', rendition_ids: [rendition.id], locale: 'en',
  }, creative.id);
  const grant = ctx.create('rights_grant', { brand_id: brand.id, status: 'active' });
  const terms = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, usages: ['paid_ads'], regions: ['US'], valid_from: start, valid_until: expiry });
  ctx.update('rights_grant', grant.id, { active_revision_id: terms.id, current_revision_id: terms.id });
  ctx.create('rights_grant_asset', { rights_grant_id: grant.id, asset_id: asset.id, asset_version_id: version.id, version_scope: 'specific_version' });
  ctx.now = expiry;
  const proposal = await call<Row>(adsOperations, 'ads_create_proposal', { ad_account_id: account.id, revision: {
    objective: 'sales', market_ids: ['US'], creative_variant_ids: [variant.id],
    schedule: { starts_at: expiry, ends_at: '2026-11-22T12:00:00Z' }, budget: { type: 'daily', currency: 'USD', amount_minor: 100, cap_minor: 150 },
  } });
  await assert.rejects(call(adsOperations, 'ads_submit_proposal', {}, proposal.id), { code: 'RIGHTS_UNAVAILABLE' });
  assert.deepEqual(ctx.list('ad_approval_request'), []);
  assert.deepEqual(ctx.list('ad_operation'), []);
});

test('flat content commits move draft targets and grant revocation invalidates their prechecks', async () => {
  const { ctx, call } = flatContext();
  const brand = ctx.create('brand', { name: 'Brand' });
  const { item } = await call<{ item: Row }>(contentOperations, 'content_create_item', { brand_id: brand.id, title: 'Draft' });
  const { variant } = await call<{ variant: Row }>(contentOperations, 'content_create_variant', { platform: 'instagram', format: 'feed_image', locale: 'en', body_markdown: 'Original caption' }, item.id);
  const file = ctx.create('file_object', { purpose: 'asset', scan_status: 'clean', sha256: 'a'.repeat(64), mime_type: 'image/jpeg' });
  const asset = await call<Row>(assetOperations, 'asset_create', { brand_id: brand.id, file_object_id: file.id, title: 'Photo', kind: 'image' });
  const grant = await call<Row>(assetOperations, 'rights_create_draft', { brand_id: brand.id, grant_type: 'owned', asset_ids: [asset.id], usages: ['organic_social'] });
  const protectedSource = ctx.create('asset', { brand_id: brand.id, status: 'archived' });
  const protectedVersion = ctx.create('asset_version', { asset_id: protectedSource.id });
  const protectedTarget = ctx.create('publish_target', { plan_status: 'ready' });
  ctx.create('publish_target_ref', { publish_target_id: protectedTarget.id, ref_type: 'asset_version', ref_id: protectedVersion.id });
  const history = await call<{ publish_targets: Row[] }>(assetOperations, 'asset_usage', {}, protectedSource.id);
  assert.deepEqual(history.publish_targets.map(row => row.id), [protectedTarget.id]);
  await assert.rejects(call(assetOperations, 'asset_delete', {}, protectedSource.id), { code: 'ASSET_REFERENCED' });
  assert.deepEqual(ctx.get('asset_version', protectedVersion.id), protectedVersion);
  assert.equal(assetOperations.some(op => ['DELETE', 'PATCH', 'PUT'].includes(op.method) && op.path === '/asset-versions/:id'), false);
  const rendition = await call<Row>(assetOperations, 'asset_request_rendition', { kind: 'cover' }, String(asset.current_version_id));
  const finish = (status: string, attempt: number, more = {}) => call(assetOperations, 'asset_finish_rendition', { status, attempt, ...more }, rendition.id);
  await finish('processing', 1);
  await finish('failed', 1, { error: 'decoder error' });
  const retry = await call<Row>(assetOperations, 'asset_request_rendition', { kind: 'cover' }, String(asset.current_version_id));
  assert.equal(retry.id, rendition.id);
  await assert.rejects(finish('processing', 1), { code: 'RENDITION_STALE_ATTEMPT' });
  await finish('processing', 2);
  await finish('ready', 2, { file_object_id: file.id });
  await assert.rejects(finish('ready', 2, { file_object_id: file.id }), { code: 'RENDITION_INVALID_STATE' });
  assert.equal((assetOperations.find(op => op.name === 'rights_activate') as Operation & { mcp?: boolean }).mcp, false);
  Object.assign(ctx, { agentCredentialId: 'pat' });
  await assert.rejects(call(assetOperations, 'rights_activate', {}, grant.id), { code: 'PERMISSION_DENIED' });
  assert.equal(ctx.get('rights_grant', grant.id).status, 'draft');
  Object.assign(ctx, { agentCredentialId: undefined });
  const active = await call<Row>(assetOperations, 'rights_activate', {}, grant.id);
  assert.equal(active.active_revision_id, active.current_revision_id);
  const check = () => call<{ items: Data[] }>(assetOperations, 'asset_check_usage', { asset_ids: [asset.id], usage: 'organic' });
  assert.equal((await check()).items[0]?.allowed, true);
  ctx.update('file_object', file.id, { scan_status: 'infected' });
  assert.equal((await check()).items[0]?.code, 'file_unavailable');
  ctx.update('file_object', file.id, { scan_status: 'clean' });
  const { revision } = await call<{ revision: Row }>(contentOperations, 'content_commit_revision', { base_revision_id: null, media: [{ asset_version_id: asset.current_version_id }] }, variant.id);
  assert.equal((revision.media as Data[])[0]?.asset_id, asset.id);
  const target = ctx.create('publish_target', { content_variant_id: variant.id, variant_revision_id: revision.id, plan_status: 'draft' });
  const updated = await call<{ revision: Row }>(contentOperations, 'content_commit_revision', { base_revision_id: revision.id, body_markdown: 'Updated caption' }, variant.id);
  assert.equal(ctx.get('publish_target', target.id).variant_revision_id, updated.revision.id);
  await call(assetOperations, 'rights_revoke', { revocation_effect: 'stop_new_use' }, grant.id);
  assert.equal(ctx.get('content_variant', variant.id).readiness, 'stale');
  assert.equal(ctx.get('publish_target', target.id).approval_invalidated_reason, 'rights_revoked');
  assert.equal((ctx.get('content_revision', revision.id).rendered as Data).text, 'Original caption');

  const expiring = await call<Row>(assetOperations, 'rights_create_draft', {
    brand_id: brand.id, grant_type: 'owned', asset_ids: [asset.id], usages: ['organic_social'], valid_until: expiry,
  });
  await call(assetOperations, 'rights_activate', {}, expiring.id);
  await assert.rejects(call(assetOperations, 'rights_renew', { valid_until: expiry }, expiring.id), { code: 'INVALID_INPUT' });
  const renewed = await call<Row>(assetOperations, 'rights_renew', { valid_until: '2026-11-22T12:00:00.000Z' }, expiring.id);
  ctx.create('publish_target_ref', { publish_target_id: target.id, ref_type: 'rights_grant', ref_id: renewed.id });
  const task = ctx.create('execution_task', { publish_target_id: target.id });
  const used = ctx.create('platform_post', { execution_task_id: task.id, post_status: 'live' });
  ctx.create('platform_post', { execution_task_id: task.id, post_status: 'deleted' });
  ctx.now = String(renewed.valid_until);
  await call(assetOperations, 'rights_scan_expiry', {});
  await call(assetOperations, 'rights_scan_expiry', {});
  assert.deepEqual(ctx.list('rights_impact').map(row => [row.platform_post_id, row.required_action]), [[used.id, 'review']]);
});

const ffmpegAvailable = ['ffmpeg', 'ffprobe'].every(program => spawnSync(program, ['-version'], { stdio: 'ignore' }).status === 0);

test('media worker generates verified thumbnails, crops and resized images once', { skip: !ffmpegAvailable }, async t => {
  const { ctx, call } = flatContext();
  const root = await mkdtemp(join(tmpdir(), 'smartsell-asset-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const media = createMediaFiles({ storage: localStorage(root), signingKey: randomBytes(32) });
  const sample = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=640x480', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']);
  assert.equal(sample.status, 0, sample.stderr.toString());
  const bytes = sample.stdout;
  const upload = media.begin(ctx, { purpose: 'asset', mime_type: 'image/png', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const file = await media.complete(ctx, upload.id, bytes.toString('base64'));
  const brand = ctx.create('brand', {});
  const asset = await call<Row>(assetOperations, 'asset_create', { brand_id: brand.id, upload_id: upload.id, kind: 'image', title: 'Source' });
  const rendition = ctx.list('asset_rendition').find(row => row.asset_version_id === asset.current_version_id)!;
  const event = { type: 'asset.rendition.requested', payload: { rendition_id: rendition.id, attempt: 1 } };
  await applyAssetEvent(ctx, event, media);
  await applyAssetEvent(ctx, event, media);
  const result = ctx.get('asset_rendition', rendition.id);
  assert.equal(result.status, 'ready', String(result.error));
  assert.deepEqual([result.meta && (result.meta as Data).width, result.meta && (result.meta as Data).height], [320, 240]);
  assert.equal(ctx.list('file_object').length, 2);
  assert.notEqual(result.file_object_id, file.id);
  const versionId = String(asset.current_version_id);
  await assert.rejects(call(assetOperations, 'asset_request_rendition', { kind: 'crop', params: { width: 300, height: 180, crop: { x: 400, y: 0 } } }, versionId), { code: 'INVALID_INPUT' });
  for (const [kind, width, height, crop] of [['crop', 300, 180, { x: 90, y: 50 }], ['platform_resize', 256, 384, undefined]] as const) {
    const parameters = { width, height, ...(crop && { crop }) };
    const queued = await call<Row>(assetOperations, 'asset_request_rendition', { kind, params: parameters }, versionId);
    await applyAssetEvent(ctx, { type: 'asset.rendition.requested', payload: { rendition_id: queued.id, attempt: 1 } }, media);
    const output = ctx.get('asset_rendition', queued.id);
    assert.equal(output.status, 'ready', String(output.error));
    assert.deepEqual([(output.meta as Data).width, (output.meta as Data).height], [width, height]);
  }
  const recipes = [{ kind: 'cover' }, { kind: 'preview' }, { kind: 'cover' }, { kind: 'transcode', params: { format: 'jpeg' } }];
  const batch = await call<{ items: Row[] }>(assetOperations, 'asset_request_rendition_batch', { recipes }, versionId);
  assert.equal(batch.items[0]?.id, batch.items[2]?.id);
  for (const item of batch.items) await applyAssetEvent(ctx, { type: 'asset.rendition.requested', payload: { rendition_id: item.id, attempt: 1 } }, media);
  for (const item of batch.items) assert.equal(ctx.get('asset_rendition', item.id).status, 'ready');
  const jpeg = ctx.get('asset_rendition', batch.items[3]!.id);
  assert.equal(ctx.get('file_object', String(jpeg.file_object_id)).mime_type, 'image/jpeg');
  assert.deepEqual([(jpeg.meta as Data).width, (jpeg.meta as Data).height], [640, 480]);
  assert.equal(ctx.get('asset_version', String(asset.current_version_id)).file_object_id, file.id);
});


test('HTTP intake approval copies private media into the library without granting usage', { skip: !ffmpegAvailable }, async t => {
  const { ctx, call } = flatContext();
  const root = await mkdtemp(join(tmpdir(), 'smartsell-submission-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldDirectory = process.env.MEDIA_DIRECTORY;
  const oldEndpoint = process.env.MEDIA_S3_ENDPOINT;
  let host: ReturnType<typeof createMediaHost>;
  try {
    process.env.MEDIA_DIRECTORY = root;
    delete process.env.MEDIA_S3_ENDPOINT;
    host = createMediaHost(configuration({}));
  } finally {
    if (oldDirectory === undefined) delete process.env.MEDIA_DIRECTORY;
    else process.env.MEDIA_DIRECTORY = oldDirectory;
    if (oldEndpoint !== undefined) process.env.MEDIA_S3_ENDPOINT = oldEndpoint;
  }
  const ops = assetOperations.map(operation => host.bind({ ...operation, module: 'asset' }));
  const brand = ctx.create('brand', {});
  const box = await call<Row>(ops, 'submission_box_create', { brand_id: brand.id, name: 'Intake', expires_at: expiry });
  const bytes = Buffer.from('Creator attachment');
  Object.assign(ctx, { actorId: 'submitter', role: 'editor' });
  const upload = host.media.begin(ctx, { purpose: 'import', mime_type: 'text/plain', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const original = await host.media.complete(ctx, upload.id, bytes.toString('base64'));
  const submission = await call<Row>(ops, 'submission_receive', {
    file_object_id: original.id, kind: 'document', title: 'Attachment', submitter: 'Creator',
    declared_rights: { usages: ['organic_social'], valid_from: start, valid_until: expiry },
  }, box.id);
  Object.assign(ctx, { actorId: 'reviewer', role: 'reviewer' });
  const accepted = await call<Row>(ops, 'submission_accept', {}, submission.id);
  const [assetId] = accepted.accepted_asset_ids as string[];
  assert.equal(ctx.get('rights_grant', String(accepted.rights_grant_id)).status, 'draft');
  const version = ctx.get('asset_version', String(ctx.get('asset', assetId).current_version_id));
  assert.notEqual(version.file_object_id, original.id);
  assert.equal(ctx.get('file_object', String(version.file_object_id)).purpose, 'asset');
  assert.equal(ctx.get('file_object', original.id).purpose, 'import');
  Object.assign(ctx, { actorId: 'viewer', role: 'viewer' });
  const download = await call<{ url: string }>(ops, 'asset_download_version', {}, version.id);
  assert.ok(download.url.includes(String(version.file_object_id)));
  const rights = await call<{ items: Data[] }>(ops, 'asset_check_usage', { asset_ids: [assetId], usage: 'organic' });
  assert.equal(rights.items[0]?.allowed, false);
});
