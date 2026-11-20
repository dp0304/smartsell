import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileStore } from '@smartsell/db';
import { configuration } from '../../config.ts';
import { discoverOperations } from '../../operations.ts';
import { createServer } from '../../server.ts';
import { buildApp } from '../../app.ts';
import { MemoryStore } from '../../memory.ts';
import { register, type Registry } from '../../registry.ts';
import { testWorkspace } from '../ingest/test-context.ts';
import type { Commands, Fields } from '../types.ts';
import { operations as executionOperations } from '../execution/ops.ts';
import { testWorkspace as restWorkspace } from '../lifecycle/workspace-test-context.ts';
import type { Row } from '@smartsell/contracts';
import { applyContentEvent, commands, handleContentEvent, operations, recordFeedItems, recordTranscriptResult, scanContentDue } from './index.ts';
import { commandContext } from './operations.ts';

function fixture() {
  const store = testWorkspace();
  const internal: Commands = {
    seed: { roles: ['owner'], run: (ctx, { module, kind, data, id }) => ctx.insert(module, kind, data, id) },
    event: { roles: ['owner'], run: (ctx, { event, payload }) => handleContentEvent(ctx, event, payload) },
    feed_result: { roles: ['owner'], run: (ctx, { feedId, entries }) => recordFeedItems(ctx, feedId, { entries }) },
  };
  return { store, run: (action: string, input: Fields = {}, options?: Parameters<typeof store.run>[3]) => store.run(commands, action, input, options),
    internal: (action: string, input: Fields) => store.run(internal, action, input) };
}
const textVariant = { platform: 'generic', format: 'text', locale: 'en', body: 'First #draft', market: 'US' };

function conflict(error: unknown, assertions: (details: Fields) => void) {
  const failure = error as { code: string; status: number; details: Fields };
  assert.equal(failure.code, 'VERSION_CONFLICT');
  assert.equal(failure.status, 409);
  assertions(failure.details);
  return true;
}

test('working drafts and immutable revisions use row and revision checks', async () => {
  const { run, store } = fixture();
  const { variants: [variant] } = await run('content_create_item', { brand_id: 'brand', title: 'Campaign draft', variants: [textVariant] });
  const draft = await run('content_autosave_variant', { variant_id: variant.id, expected_version: variant.version, body: 'Human draft' });
  assert.equal(draft.data.current_revision_id, null);
  assert.equal(store.list('content', 'content_revision').length, 0);
  await assert.rejects(run('content_autosave_variant', { variant_id: variant.id, expected_version: variant.version, body: 'Outdated draft' }), error => conflict(error, detail => {
    assert.equal(detail.current_draft.body, 'Human draft');
  }));
  const first = await run('content_commit_revision', { variant_id: variant.id, expected_version: draft.version, base_revision_id: null });
  const second = await run('content_commit_revision', { variant_id: variant.id, expected_version: first.variant.version, base_revision_id: first.revision.id, body: 'Human final' }, { actorId: 'editor' });
  await assert.rejects(run('content_update_variant', { variant_id: variant.id, expected_version: first.variant.version, base_revision_id: first.revision.id, body: 'Agent edit' }), error => conflict(error, detail => {
    assert.equal(detail.base.body, 'Human draft');
    assert.equal(detail.mine.body, 'Agent edit');
    assert.equal(detail.current.body, 'Human final');
  }));
  const restored = await run('content_restore_revision', { revision_id: first.revision.id, base_revision_id: second.revision.id, expected_version: second.variant.version });
  assert.equal(restored.revision.data.restored_from_revision_id, first.revision.id);
  assert.equal(restored.revision.data.revision_no, 3);
  assert.deepEqual(await run('content_get_revision', { revision_id: first.revision.id }), first.revision);
  assert.deepEqual((await run('content_diff_revisions', { revision_a: first.revision.id, revision_b: second.revision.id })).changes.body, { before: 'Human draft', after: 'Human final' });
  assert.equal(store.events().filter(event => event.event === 'content.revision.created').length, 3);
  await assert.rejects(run('content_get_variant', { variant_id: variant.id }, { workspaceId: 'another-workspace' }), { code: 'not_found' });
});

test('TikTok selections are human-controlled and remain absent on localized copies', async () => {
  const { run } = fixture();
  const variantInput = { ...textVariant, platform: 'tiktok' };
  const selection = { platform_options: { tiktok: { privacy_level: 'PUBLIC_TO_EVERYONE', commercial_disclosure: 'none', allow_comment: true } } };
  await assert.rejects(run('content_create_draft', { brand_id: 'brand', title: 'TikTok draft', variants: [{ ...variantInput, settings: selection }] }), { code: 'human_selection_required' });
  const { variants: [variant] } = await run('content_create_draft', { brand_id: 'brand', title: 'TikTok draft', variants: [variantInput] });
  const result = await run('content_validate_variant', { variant_id: variant.id });
  assert.equal(result.preview.approximate, true);
  assert.deepEqual(result.issues.filter((issue: Fields) => issue.severity === 'blocking').map((issue: Fields) => issue.code), ['tiktok_privacy_required', 'tiktok_commercial_disclosure_required']);
  await assert.rejects(run('content_set_readiness', { variant_id: variant.id, expected_version: variant.version }), { code: 'validation_failed' });
  const staleDraft = await run('content_autosave_variant', { variant_id: variant.id, expected_version: variant.version, body: 'Human work' });
  await assert.rejects(run('content_update_variant', { variant_id: variant.id, expected_version: variant.version, base_revision_id: variant.data.current_revision_id, body: 'Agent work' }), { code: 'VERSION_CONFLICT' });
  const { variant: selected, revision } = await run('content_commit_revision', { variant_id: variant.id, expected_version: staleDraft.version, base_revision_id: variant.data.current_revision_id, settings: selection });
  assert.deepEqual(revision.data.settings.platform_options.tiktok, { allow_comment: true, allow_duet: false, allow_stitch: false, privacy_level: 'PUBLIC_TO_EVERYONE', commercial_disclosure: 'none' });
  assert.equal((await run('content_set_readiness', { variant_id: selected.id, expected_version: selected.version })).data.state, 'ready');
  const translated = await run('content_create_translation', { source_variant_id: variant.id, locale: 'fr', market: 'FR', text: 'Bonjour' });
  assert.equal(translated.revision.data.settings.platform_options.tiktok.privacy_level, undefined);
  assert.equal(translated.revision.data.settings.platform_options.tiktok.allow_comment, false);
});

test('translation review retains localized body and reopens after accepted divergence', async () => {
  const { run } = fixture();
  const { variants: [source] } = await run('content_create_draft', { brand_id: 'brand', title: 'Content', variants: [textVariant] });
  const translation = await run('content_create_translation', { source_variant_id: source.id, locale: 'fr', text: 'Local body' });
  const advance = await run('content_commit_revision', { variant_id: source.id, base_revision_id: source.data.current_revision_id, body: 'Source advance' });
  const [changed] = await run('content_list_translations', { variant_id: source.id });
  assert.equal(changed.translation_link.data.status, 'source_changed');
  assert.equal(changed.target_variant.data.readiness, 'stale');
  await run('content_mark_divergence', { translation_link_id: changed.translation_link.id, expected_version: changed.translation_link.version, source_revision_id: advance.revision.id, note: 'Local market wording' });
  await run('content_commit_revision', { variant_id: source.id, base_revision_id: advance.revision.id, body: 'Second source change' });
  const [changedAgain] = await run('content_list_translations', { variant_id: source.id });
  assert.equal(changedAgain.translation_link.data.status, 'source_changed');
  assert.equal(changedAgain.target_variant.data.draft_doc.body, 'Local body');
  assert.equal(changedAgain.target_variant.data.current_revision_id, translation.revision.id);
});

test('product changes stale the current variant while its published text stays frozen', async () => {
  const { run, internal, store } = fixture();
  await internal('seed', { module: 'commerce', kind: 'listing_snapshot', id: 'listing-v1', data: { variant_id: 'product', market_id: 'US', currency: 'USD', is_current: true } });
  const { variants: [variant], revisions: [revision] } = await run('content_create_draft', {
    brand_id: 'brand', title: 'Offer', variants: [{ ...textVariant, body: 'Only $10', product_refs: [{ variant_id: 'product', listing_snapshot_id: 'listing-v1', market_id: 'US', currency: 'USD', field: 'price', inserted_text: '$10' }] }],
  });
  await internal('event', { event: 'commerce.listing.changed', payload: { previous_snapshot_id: 'listing-v1' } });
  assert.equal((await run('content_list_stale', { reason: ['listing_changed'] }))[0].id, variant.id);
  assert.equal((await run('content_get_revision', { revision_id: revision.id })).data.body, 'Only $10');
  assert.ok(store.list('content', 'content_reference').some(row => row.data.ref_id === 'listing-v1'));
});

test('external feed preview deduplicates entries and preserves attribution without granting rights', async () => {
  const { run, internal, store } = fixture();
  const feed = await run('content_create_feed', { brand_id: 'brand', url: 'https://example.org/feed' });
  await run('content_poll_feed', { feed_source_id: feed.id });
  const entry = { title: 'Source article', author: 'Author', url: 'https://example.org/article', guid: '1' };
  const preview = await internal('feed_result', { feedId: feed.id, entries: [entry, entry, { ...entry, guid: '2' }] });
  assert.equal(preview.duplicate_count, 2);
  assert.equal(preview.items[0].data.grants_republication_rights, false);
  const idea = await run('content_import_feed_item', { feed_item_id: preview.items[0].id });
  assert.equal(idea.data.origin_refs[0].author, 'Author');
  assert.equal((await run('content_import_feed_item', { feed_item_id: preview.items[0].id })).id, idea.id);
  assert.equal(store.list('content', 'content_item').length, 0);
});

test('batch previews leave no writes and rejected batches roll back content changes', async () => {
  const { run, store } = fixture();
  const { item, variants: [variant] } = await run('content_create_draft', { brand_id: 'brand', title: 'Batch draft', variants: [textVariant] });
  const changes = [
    { variant_id: variant.id, base_revision_id: variant.data.current_revision_id, expected_version: variant.version, body: 'Updated copy' },
    { content_item_id: item.id, ...textVariant, locale: 'fr', body: 'Bonjour' },
  ];
  const preview = await run('content_batch_variants', { dry_run: true, changes });
  assert.deepEqual(preview.results.map((result: Fields) => [result.operation, result.preview.text]), [['update', 'Updated copy'], ['create', 'Bonjour']]);
  assert.equal(store.list('content', 'content_revision').length, 1);
  await assert.rejects(run('content_batch_variants', { dry_run: false, changes: [changes[0], { ...changes[1], format: 'invalid' }] }), { code: 'invalid_input' });
  assert.equal(store.list('content', 'content_revision').length, 1);
  await run('content_batch_variants', { dry_run: false, changes });
  assert.equal(store.list('content', 'content_revision').length, 3);
});

test('idea conversion stays reusable and handoff never creates publishing records', async () => {
  const { run, store } = fixture();
  const idea = await run('idea_create', { brand_id: 'brand', title: 'Test idea', origin_refs: [{ type: 'url', url: 'https://example.org/note' }] });
  const { item, variants: [variant] } = await run('idea_convert', { idea_id: idea.id, variants: [textVariant], tasks: [{ title: 'Check wording' }] });
  await run('idea_convert', { idea_id: idea.id });
  assert.equal(store.list('content', 'content_item').filter(row => row.data.idea_id === idea.id).length, 2);
  const drafting = await run('content_set_stage', { content_item_id: item.id, expected_version: item.version, to: 'drafting' });
  const review = await run('content_set_stage', { content_item_id: item.id, expected_version: drafting.version, to: 'internal_review' });
  await assert.rejects(run('content_set_stage', { content_item_id: item.id, expected_version: review.version, to: 'ready' }), { code: 'handoff_blocked' });
  const committed = await run('content_commit_revision', { variant_id: variant.id, base_revision_id: null });
  await run('content_set_readiness', { variant_id: variant.id, expected_version: committed.variant.version });
  const ready = await run('content_set_stage', { content_item_id: item.id, expected_version: review.version, to: 'ready' });
  assert.equal(ready.data.production_stage, 'ready');
  assert.deepEqual(store.list('content', 'content_stage_history').filter(row => row.data.content_item_id === item.id).map(row => row.data.to_stage), ['accepted', 'drafting', 'internal_review', 'ready']);
  assert.equal(store.list('planning', 'publish_target').length, 0);
  assert.equal(store.list('execution', 'execution_task').length, 0);
});

test('authenticated command endpoint commits a revision and safely replays the result', async t => {
  const token = Buffer.alloc(32, 22).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const store = new MemoryStore();
  await store.setup({ email: 'owner@example.invalid', name: 'Owner', workspaceName: 'Content test', passwordHash: 'unused' }, tokenHash);
  const session = await store.session(tokenHash);
  assert.ok(session);
  const wid = session.workspaces[0].id;
  const registry: Registry = new Map();
  register(registry, 'content', commands);
  const { app } = buildApp({ store, registry, secureCookie: false, origins: new Set() });
  t.after(() => app.close());
  const request = (action: string, payload: Fields, key: string) => app.inject({
    method: 'POST', url: `/api/v1/workspaces/${wid}/commands/content/${action}`, payload,
    headers: { cookie: `smartsell_session=${token}`, 'idempotency-key': key },
  });
  const created = await request('content_create_item', { brand_id: 'brand', title: 'API draft', variants: [textVariant] }, 'create');
  assert.equal(created.statusCode, 200, created.body);
  const [variant] = created.json().data.variants;
  const input = { variant_id: variant.id, expected_version: variant.version, base_revision_id: null };
  const committed = await request('content_commit_revision', input, 'commit');
  assert.equal(committed.statusCode, 200, committed.body);
  assert.equal(committed.json().data.revision.data.body, textVariant.body);
  assert.deepEqual((await request('content_commit_revision', input, 'commit')).json(), committed.json());
  const outdated = await request('content_update_variant', { ...input, body: 'Outdated' }, 'outdated');
  assert.equal(outdated.statusCode, 409);
  assert.equal(outdated.json().error.code, 'VERSION_CONFLICT');
});

test('PC04 REST pins approved facts and rejects speculative writes atomically', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-pc04-'));
  const config = configuration({ PORT: '3401' });
  const discovery = await discoverOperations();
  const app = createServer({ config, store: await fileStore(join(directory, 'test.sqlite')), ...discovery });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: {
    email: 'pc04@example.test', password: 'fixture-password-123', workspace_name: 'PC04 test',
  } });
  assert.equal(setup.statusCode, 201, setup.body);
  const session = setup.json().data;
  const root = `/api/v1/workspaces/${session.workspaces[0].id}`;
  async function call(method: 'GET' | 'POST' | 'PATCH', path: string, payload?: Fields, version?: number, status = 200) {
    const response = await app.inject({ method, url: root + path, payload, headers: {
      cookie: String(setup.headers['set-cookie']).split(';')[0], origin: config.origin, 'x-csrf-token': session.csrf_token,
      'idempotency-key': randomUUID(), ...(version != null && { 'if-match': String(version) }),
    } });
    assert.equal(response.statusCode, status, `${method} ${path} ${response.body}`);
    return response.json();
  }
  const post = async (path: string, body: Fields = {}, version?: number) => (await call('POST', path, body, version)).data;
  const brand = await post('/brands', { name: 'Fact brand', slug: 'fact-brand' });
  const store = await post('/stores', { brand_id: brand.id, name: 'Fact store', external_store_id: 'pc04', provider: 'shopify', default_currency: 'USD', default_locale: 'en' });
  const product = await post('/products', { store_id: store.id, title: 'Bottle' });
  const sku = await post(`/products/${product.id}/variants`, { sku: 'BOTTLE-1' });
  const facts = `/products/${product.id}/facts`;
  const material = await post(facts, { fact_key: 'material', category: 'spec', value: 'Stainless steel' });
  const speculative = await post(facts, { fact_key: 'lifespan', category: 'speculation', value: 'Lasts forever' });
  const draft = await post(facts, { fact_key: 'size', category: 'spec', value: 'XL' });
  const first = await post(`/fact-revisions/${material.current_revision_id}/approve`);
  await post(`/fact-revisions/${speculative.current_revision_id}/approve`);
  const { variants: [variant] } = await post('/content-items', { brand_id: brand.id, title: 'Bottle copy', variants: [textVariant] });
  const base = `/content-variants/${variant.id}`;
  const picker = `${base}/product-facts`;
  const choices = (await call('GET', `${picker}?product_id=${product.id}`)).data;
  assert.deepEqual(choices.map((row: Fields) => row.fact_revision_id), [first.id]);
  assert.equal(choices[0].collected_at, first.created_at);
  assert.equal(first.source.collected_at, first.created_at);
  const ref = (fact_revision_id: string) => ({ fact_revision_id, variant_id: sku.id });
  for (const revisionId of [speculative.current_revision_id, draft.current_revision_id]) {
    const denied = await call('POST', picker, { fact_revision_id: revisionId, product_variant_id: sku.id }, variant.version, 422);
    assert.match(denied.code, /invalid_product_reference/i);
  }
  for (const [method, path, body] of [
    ['PATCH', base, { product_refs: [ref(speculative.current_revision_id)] }],
    ['POST', `${base}/revisions`, { base_revision_id: null, product_refs: [ref(speculative.current_revision_id)] }],
    ['POST', '/content-items/draft', { brand_id: brand.id, title: 'Rejected copy', variants: [{ ...textVariant, product_refs: [ref(speculative.current_revision_id)] }] }],
  ] as const) {
    assert.match((await call(method, path, body, variant.version, 422)).code, /invalid_product_reference/i);
  }
  assert.deepEqual((await call('GET', base)).data.variant.draft_doc.product_refs, []);
  assert.deepEqual((await call('GET', `${base}/revisions`)).data, []);
  const working = await post(picker, { ...ref(first.id), product_variant_id: sku.id, collected_at: '2000-01-01T00:00:00Z', inserted_text: 'Forged' }, variant.version);
  assert.equal(working.draft_doc.body, `${textVariant.body}\nStainless steel`);
  const { revision } = await post(`${base}/revisions`, { expected_version: working.version, base_revision_id: null });
  const [pin] = revision.product_refs;
  assert.deepEqual(pin, { ...ref(first.id), market_id: 'US', fact_id: material.id, fact_key: 'material', fact_revision_no: 1, collected_at: first.created_at, inserted_text: 'Stainless steel' });
  const current = (await call('GET', facts)).data[0];
  const revised = await post(`/facts/${material.id}/revisions`, { value: 'Aluminum' }, current.version);
  const next = await post(`/fact-revisions/${revised.current_revision_id}/approve`);
  assert.equal((await call('GET', `${picker}?product_id=${product.id}`)).data[0].fact_revision_id, next.id);
  const deadline = Date.now() + 15_000;
  let currentVariant = (await call('GET', base)).data.variant;
  while (currentVariant.readiness !== 'stale' && Date.now() < deadline) {
    await delay(100);
    currentVariant = (await call('GET', base)).data.variant;
  }
  assert.deepEqual(currentVariant.stale_reasons, [{ kind: 'fact_revised', ref_id: first.id }]);
  const frozen = (await call('GET', `/content-revisions/${revision.id}`)).data;
  assert.deepEqual(frozen.product_refs, [pin]);
  assert.equal(frozen.body, working.draft_doc.body);
});

test('changed working drafts lose readiness and a concurrent first draft edit cannot be overwritten', async () => {
  const { run, store } = fixture();
  const { variants: [variant] } = await run('content_create_item', { brand_id: 'brand', title: 'Ready item', variants: [textVariant] });
  const edited = await run('content_autosave_variant', { variant_id: variant.id, expected_version: variant.version, body: 'Manual first edit' });
  await assert.rejects(run('content_commit_revision', { variant_id: variant.id, base_revision_id: null, body: 'Overwrites first edit' }), error => conflict(error, details => {
    assert.equal(details.current_draft.body, 'Manual first edit');
  }));
  const first = await run('content_commit_revision', { variant_id: variant.id, base_revision_id: null, expected_version: edited.version });
  const ready = await run('content_set_readiness', { variant_id: variant.id, expected_version: first.variant.version });
  const unchanged = await run('content_autosave_variant', { variant_id: variant.id, expected_version: ready.version, body: 'Manual first edit' });
  assert.equal(unchanged.version, ready.version);
  const dirty = await run('content_autosave_variant', { variant_id: variant.id, expected_version: ready.version, body: 'Unsaved next revision' });
  assert.equal(dirty.data.readiness, 'draft');
  assert.equal(dirty.data.current_revision_id, first.revision.id);
  assert.equal(store.list('content', 'content_revision').length, 1);
});

test('listing event replay only stales superseded references in the affected market and channel', async () => {
  const { ctx, call } = restWorkspace(operations);
  const catalog = { variant_id: 'sku', market_id: 'US', channel: 'shop', currency: 'USD' };
  const old = ctx.create('listing_snapshot', { ...catalog, is_current: true });
  const create = (source: Row) => call<Promise<{ variants: Row[] }>>('content_create_draft', {
    title: 'Price', brand_id: 'brand', variants: [{ ...textVariant, body: 'Only $10', product_refs: [{
      variant_id: 'sku', listing_snapshot_id: source.id, market_id: 'US', currency: 'USD', field: 'price', inserted_text: '$10',
    }] }],
  });
  const { variants: [superseded] } = await create(old);
  ctx.update('listing_snapshot', old.id, { is_current: false });
  const replacement = ctx.create('listing_snapshot', { ...catalog, is_current: true });
  const { variants: [current] } = await create(replacement);
  const event = { type: 'commerce.listing.changed', payload: { ...catalog, snapshot_id: replacement.id } };
  await applyContentEvent(ctx, event);
  const stale = ctx.get('content_variant', superseded!.id);
  assert.equal(stale.readiness, 'stale');
  assert.equal(ctx.get('content_variant', current!.id).readiness, 'draft');
  await applyContentEvent(ctx, event);
  assert.equal(ctx.get('content_variant', superseded!.id).version, stale.version);
});

test('variant validation uses account publish limits and prioritizes the available path', async () => {
  const { ctx, call } = restWorkspace(operations);
  const account = ctx.create('social_account', { brand_id: 'brand', provider: 'tiktok', status: 'active' });
  const base = { social_account_id: account.id, operation: 'publish', content_format: 'text' };
  ctx.create('capability', { ...base, operation: 'insights', status: 'available', limits: { max_characters: 1 } });
  ctx.create('capability', { ...base, status: 'needs_authorization' });
  ctx.create('capability', { ...base, status: 'available', limits: { privacy_level_options: ['SELF_ONLY'], comment_disabled: true } });
  const { variants: [variant] } = await call<Promise<{ variants: Row[] }>>('content_create_item', {
    brand_id: 'brand', title: 'TikTok', variants: [{ ...textVariant, platform: 'tiktok', social_account_id: account.id,
      settings: { platform_options: { tiktok: { privacy_level: 'PUBLIC_TO_EVERYONE', commercial_disclosure: 'none', allow_comment: true } } },
    }],
  });
  const result = await call<Promise<{ issues: Fields[] }>>('content_validate_variant', {}, variant!.id);
  assert.deepEqual(result.issues.map(issue => issue.code), ['tiktok_privacy_unsupported', 'tiktok_interaction_disabled']);
});

test('content details retain older published posts, delegate maintenance, and show the verified result', async () => {
  const { ctx, call } = restWorkspace([...operations, ...executionOperations]);
  const { item, variants: [variant], revisions: [first] } = await call<Promise<{ item: Row; variants: Row[]; revisions: Row[] }>>('content_create_draft', {
    brand_id: 'brand', title: 'Publication', variants: [textVariant],
  });
  const target = ctx.create('publish_target', { variant_revision_id: first!.id, plan_status: 'closed' });
  const post = ctx.create('platform_post', { publish_target_id: target.id, post_status: 'live', caption_snapshot: textVariant.body });
  const { revision } = await call<Promise<{ revision: Row }>>('content_commit_revision', { base_revision_id: first!.id, body: 'Replacement caption' }, variant!.id);
  const request = await call<Promise<Row>>('content_request_post_maintenance', { action: 'edit', new_revision_id: revision.id }, post.id);
  assert.equal(request.status, 'manual');
  assert.equal(ctx.get('platform_post', post.id).caption_snapshot, textVariant.body);
  const operationId = String(request.post_operation_id);
  const evidence = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  await call('posts_complete_operation', { outcome: 'completed', observed_caption: 'Replacement caption', evidence_file_ids: [evidence.id] }, operationId);
  assert.equal(ctx.get('platform_post', post.id).caption_snapshot, 'Replacement caption');
  const detail = await call<Promise<{ platform_posts: Row[]; maintenance_requests: { execution_operation: Row }[] }>>('content_get', {}, item.id);
  assert.equal(detail.platform_posts[0]?.id, post.id);
  assert.equal(detail.maintenance_requests[0]?.execution_operation.status, 'verified');
});


test('draft rendition requests reuse Asset work and block readiness while pending', async () => {
  const { ctx, call } = restWorkspace(operations);
  const asset = ctx.create('asset', { brand_id: 'brand', status: 'active' });
  const file = ctx.create('file_object', { purpose: 'asset', scan_status: 'clean' });
  const source = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, meta: { width: 1600, height: 900 } });
  const grant = ctx.create('rights_grant', { brand_id: 'brand', status: 'active' });
  const terms = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, usages: ['organic_social'], valid_from: '2026-01-01T00:00:00Z', allow_modification: true });
  ctx.update('rights_grant', grant.id, { active_revision_id: terms.id });
  ctx.create('rights_grant_asset', { asset_id: asset.id, rights_grant_id: grant.id, version_scope: 'all_versions' });
  const { variants: [variant] } = await call<Promise<{ variants: Row[] }>>('content_create_item', {
    brand_id: 'brand', title: 'Resize', variants: [{ ...textVariant, platform: 'instagram', format: 'image', media: [{ asset_version_id: source.id }] }],
  });
  const request = (expected_version: number) => call<Promise<{ rendition: Row; variant: Row }>>('content_request_rendition', {
    expected_version, media_index: 0, kind: 'platform_resize', params: { width: 1080, height: 1080 },
  }, variant!.id);
  const first = await request(variant!.version);
  const reissued = await request(first.variant.version);
  assert.equal(reissued.rendition.id, first.rendition.id);
  const result = await call<Promise<{ issues: Fields[]; preview: Fields }>>('content_validate_variant', {}, variant!.id);
  assert.ok(result.issues.some(issue => issue.code === 'rendition_not_ready'));
  assert.deepEqual(result.preview.media_layout[0].dimensions, { width: 1600, height: 900 });
  ctx.update('asset_rendition', first.rendition.id, { status: 'ready', meta: { width: 1080, height: 1080 } });
  const ready = await call<Promise<{ valid: boolean; preview: Fields }>>('content_validate_variant', {}, variant!.id);
  assert.equal(ready.valid, true);
  assert.equal(ready.preview.approximate, true);
  assert.equal(ready.preview.media_layout[0].aspect_ratio, 1);
  assert.deepEqual(ready.preview.media_layout[0].dimensions, { width: 1080, height: 1080 });
});


test('feed scheduling expires previews and bounded opted-in imports preserve the source', async () => {
  const { ctx, call, events } = restWorkspace(operations);
  const pillar = await call<Promise<Row>>('content_create_pillar', { brand_id: 'brand', name: 'Editorial' });
  const feed = await call<Promise<Row>>('content_create_feed', {
    brand_id: 'brand', pillar_id: pillar.id, url: 'https://example.org/feed', poll_interval_minutes: 15, expire_after_days: 1,
    auto_enqueue_rule: { enabled: true, max_per_poll: 1 },
  });
  await scanContentDue(ctx);
  await scanContentDue(ctx);
  const event = events.filter(event => event.type === 'content.feed.poll_requested');
  assert.equal(event.length, 1);
  const result = await recordFeedItems(commandContext(ctx), feed.id, { source_version: event[0]!.data.source_version, entries: [
    { title: 'First', url: 'https://example.org/first', author: 'Reporter' }, { title: 'Second', url: 'https://example.org/second' },
  ] });
  assert.deepEqual(result.items.map(item => item.data.status), ['imported', 'new']);
  const [idea] = ctx.list('idea');
  assert.equal(idea?.pillar_id, pillar.id);
  assert.deepEqual(idea?.origin_refs, [{ type: 'url', url: 'https://example.org/first', author: 'Reporter' }]);
  await assert.rejects(recordFeedItems(commandContext(ctx), feed.id, { source_version: event[0]!.data.source_version, entries: [] }), { code: 'VERSION_CONFLICT' });
  ctx.now = '2026-11-20T12:00:00.000Z';
  await scanContentDue(ctx);
  assert.deepEqual(ctx.list('feed_item').map(item => item.status), ['imported', 'expired']);
  assert.equal(events.filter(event => event.type === 'content.feed.poll_requested').length, 2);
});

test('idea ranking uses only latest observed lifetime metrics and reports sample size', async () => {
  const { ctx, call } = restWorkspace(operations);
  const seedIdea = (title: string) => ctx.create('idea', { title, brand_id: 'brand' });
  const empty = seedIdea('No metrics');
  const observed = seedIdea('Measured');
  const item = ctx.create('content_item', { idea_id: observed.id, brand_id: 'brand' });
  const post = ctx.create('platform_post', { content_item_id: item.id });
  const metric = { subject_type: 'platform_post', subject_id: post.id, metric_key: 'norm.post.engagements', period_kind: 'lifetime', availability: 'observed' };
  ctx.create('metric_observation', { ...metric, observed_at: '2026-11-17T00:00:00Z', value: 2 });
  ctx.create('metric_observation', { ...metric, observed_at: '2026-11-18T00:00:00Z', value: 9 });
  ctx.create('metric_observation', { ...metric, observed_at: '2026-11-19T00:00:00Z', value: 400, availability: 'estimated' });
  const ranked = await call<Promise<Row[]>>('idea_list', {}, undefined, { brand_id: 'brand', sort: 'historical_engagement' });
  assert.deepEqual(ranked.map(row => [row.id, row.historical_engagement]), [[observed.id, { mean: 9, observed_post_count: 1 }], [empty.id, null]]);
});

test('transcript results replay safely and require a versioned human review', async () => {
  const { ctx, call } = restWorkspace(operations);
  const version = ctx.create('asset_version', {});
  const request = await call<Promise<Row>>('content_request_transcript', { asset_version_id: version.id, locale: 'en' });
  const result = { model: 'worker-test-model', segments: [{ start_ms: 0, end_ms: 1000, text: 'Unreviewed' }] };
  const ready = await recordTranscriptResult(commandContext(ctx), request.id, result);
  assert.equal((await recordTranscriptResult(commandContext(ctx), request.id, result)).version, ready.version);
  await assert.rejects(call<Promise<Row>>('content_review_transcript', { expected_version: request.version }, request.id), { code: 'VERSION_CONFLICT' });
  const reviewed = await call<Promise<Row>>('content_review_transcript', {
    expected_version: ready.version, segments: [{ start_ms: 0, end_ms: 1000, text: 'Corrected' }],
  }, request.id);
  assert.equal(reviewed.reviewed, true);
  assert.deepEqual((await call<Promise<Row>>('content_get_transcript', {}, request.id)).segments, [{ start_ms: 0, end_ms: 1000, text: 'Corrected' }]);
});


test('feed worker handles Atom redirects and 304, limits redirects, and rejects XML document types', async () => {
  const { ctx, call, events } = restWorkspace(operations);
  const feed = await call<Promise<Row>>('content_create_feed', { brand_id: 'brand', kind: 'atom', url: 'https://example.org/feed' });
  await scanContentDue(ctx);
  const event = events.find(event => event.type === 'content.feed.poll_requested')!;
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Launch &amp; updates</title><id>1</id><link href="/article"/><author><name>Reporter</name></author></entry></feed>';
  await applyContentEvent(ctx, event, async url => url.hostname === 'example.org'
    ? { status: 302, location: 'https://feeds.example.org/new' } : { status: 200, body: atom, etag: '"1"' });
  assert.equal(ctx.list('feed_item')[0]?.url, 'https://feeds.example.org/article');
  assert.equal(ctx.list('feed_item')[0]?.author, 'Reporter');
  assert.equal(ctx.list('feed_item')[0]?.title, 'Launch & updates');
  await applyContentEvent(ctx, event, async () => { throw new Error('A delivered event should not fetch again'); });
  ctx.now = '2026-11-20T12:00:00.000Z';
  await scanContentDue(ctx);
  const next = events.filter(event => event.type === 'content.feed.poll_requested').at(-1)!;
  await assert.rejects(applyContentEvent(ctx, next, async () => ({ status: 302, location: '/again' })), /feed response|redirect/i);
  await assert.rejects(applyContentEvent(ctx, next, async () => ({ status: 200, body: '<!DOCTYPE feed>' + atom })), /document type/);
  await applyContentEvent(ctx, next, async (_url, headers) => {
    assert.equal(headers['If-None-Match'], '"1"');
    return { status: 304 };
  });
  assert.equal(ctx.get('feed_source', feed.id).etag, '"1"');
  assert.equal(ctx.list('feed_item').length, 1);
});


test('normalized manual file previews require an explicit import even when auto-import is configured', async () => {
  const { ctx, call } = restWorkspace(operations);
  const pillar = await call<Promise<Row>>('content_create_pillar', { brand_id: 'brand', name: 'Manual preview' });
  const feed = await call<Promise<Row>>('content_create_feed', { brand_id: 'brand', pillar_id: pillar.id, kind: 'file',
    url: 'https://example.org/export.json', auto_enqueue_rule: { enabled: true, max_per_poll: 5 } });
  const result = await call<Promise<{ items: Row[] }>>('content_preview_feed_import', { expected_version: feed.version, entries: [
    { url: 'https://example.org/reference', title: 'Verified title' },
  ] }, feed.id);
  assert.equal(result.items[0]?.status, 'new');
  assert.equal(ctx.list('idea').length, 0);
  const imported = await call<Promise<Row>>('content_import_feed_item', {}, result.items[0]?.id);
  assert.equal(imported.title, 'Verified title');
  assert.equal(imported.pillar_id, pillar.id);
});

test('CO06 unsupported media fields remain attached and pending rendition blocks readiness', async () => {
  const { ctx, call } = restWorkspace(operations);
  const asset = ctx.create('asset', { brand_id: 'brand', status: 'active' });
  const original = ctx.create('asset_version', { asset_id: asset.id });
  const grant = ctx.create('rights_grant', { brand_id: 'brand', status: 'active' });
  const terms = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, usages: ['organic_social'], valid_from: '2026-01-01T00:00:00Z', allow_modification: true });
  ctx.update('rights_grant', grant.id, { active_revision_id: terms.id });
  ctx.create('rights_grant_asset', { asset_id: asset.id, rights_grant_id: grant.id, version_scope: 'all_versions' });
  const caption = ctx.create('asset_rendition', { asset_version_id: original.id, kind: 'subtitle', status: 'ready' });
  const resize = ctx.create('asset_rendition', { asset_version_id: original.id, target_platform: 'instagram', status: 'pending' });
  const media = { asset_version_id: original.id, alt_text: 'A bicycle', caption_rendition_id: caption.id, rendition_id: resize.id, requires_rendition: true };
  const { variants: [variant] } = await call<Promise<{ variants: Row[] }>>('content_create_item', {
    brand_id: 'brand', title: 'Accessibility', variants: [{ ...textVariant, platform: 'instagram', format: 'reel', media: [media] }],
  });
  const committed = await call<Promise<{ variant: Row; revision: Row }>>('content_commit_revision', { base_revision_id: null }, variant!.id);
  assert.deepEqual(committed.revision.media, [{ ...media, order: 0, asset_id: asset.id }]);
  const validate = () => call<Promise<{ valid: boolean; issues: Fields[] }>>('content_validate_variant', {}, variant!.id);
  const markReady = () => call<Promise<Row>>('content_set_readiness', { expected_version: committed.variant.version }, variant!.id);
  const pending = await validate();
  assert.equal(pending.valid, false);
  assert.ok(pending.issues.some(issue => issue.code === 'rendition_not_ready' && issue.severity === 'blocking' && issue.field === 'media.0.rendition_id'));
  await assert.rejects(markReady(), { code: 'validation_failed' });
  ctx.update('asset_rendition', resize.id, { status: 'ready' });
  const ready = await validate();
  assert.equal(ready.valid, true);
  assert.deepEqual(ready.issues.filter(issue => ['alt_text_unsupported', 'captions_unsupported'].includes(issue.code)), [
    { code: 'alt_text_unsupported', severity: 'warning', field: 'media.0.alt_text' },
    { code: 'captions_unsupported', severity: 'warning', field: 'media.0.caption_rendition_id' },
  ]);
  assert.equal((await markReady()).readiness, 'ready');
  assert.deepEqual(ctx.get('content_revision', committed.revision.id).media, committed.revision.media);
});

test('CO08 draft reuse rechecks rights and product references, and links first committed revision', async () => {
  const { ctx, call } = restWorkspace(operations);
  const brand_id = 'brand';
  const asset = ctx.create('asset', { brand_id, status: 'active' });
  const original = ctx.create('asset_version', { asset_id: asset.id });
  const grant = ctx.create('rights_grant', { brand_id, status: 'active' });
  const terms = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, usages: ['organic_social'], valid_from: '2026-01-01T00:00:00Z' });
  ctx.update('rights_grant', grant.id, { active_revision_id: terms.id });
  ctx.create('rights_grant_asset', { asset_id: asset.id, rights_grant_id: grant.id, version_scope: 'all_versions' });
  const product = ctx.create('product', { brand_id });
  const sku = ctx.create('product_variant', { product_id: product.id });
  const fact = ctx.create('product_fact', { product_id: product.id, brand_id, status: 'active' });
  const approved = ctx.create('product_fact_revision', { fact_id: fact.id, category: 'spec', revision_no: 1, value: { type: 'locale_text', by_locale: { en: 'Steel' } }, source: { kind: 'manual', collected_at: '2026-01-02T00:00:00Z' }, review_status: 'approved' });
  ctx.update('product_fact', fact.id, { approved_revision_id: approved.id });
  const listingFields = { variant_id: sku.id, market_id: 'US', channel: 'shop', currency: 'USD' };
  const listing = ctx.create('listing_snapshot', { ...listingFields, is_current: true, price_amount_minor: 1000 });
  const product_refs = [{ variant_id: sku.id, fact_revision_id: approved.id }, { variant_id: sku.id, listing_snapshot_id: listing.id, market_id: 'US', currency: 'USD', field: 'price', inserted_text: '$10' }];
  const { item, variants: [variant] } = await call<Promise<{ item: Row; variants: Row[] }>>('content_create_item', {
    brand_id, title: 'Offer', variants: [{ ...textVariant, platform: 'tiktok', body: 'Only $10', product_refs, media: [{ asset_version_id: original.id }],
      settings: { platform_options: { tiktok: { privacy_level: 'PUBLIC_TO_EVERYONE', commercial_disclosure: 'none', allow_comment: true } } },
    }],
  });
  const { revision } = await call<Promise<{ revision: Row }>>('content_commit_revision', { base_revision_id: null }, variant!.id);
  const newest = ctx.create('product_fact_revision', { fact_id: fact.id, category: 'spec', revision_no: 2, value: { type: 'locale_text', by_locale: { en: 'Alloy' } }, source: { kind: 'manual', collected_at: '2026-01-03T00:00:00Z' }, review_status: 'approved' });
  ctx.update('product_fact', fact.id, { approved_revision_id: newest.id });
  ctx.update('listing_snapshot', listing.id, { is_current: false });
  const latestPrice = ctx.create('listing_snapshot', { ...listingFields, is_current: true, price_amount_minor: 1400 });
  ctx.update('rights_grant', grant.id, { status: 'revoked' });
  const copy = await call<Promise<{ item: Row; variants: Row[]; warnings: Fields[] }>>('content_duplicate', { title: 'New offer' }, item.id);
  const [draft] = copy.variants;
  assert.equal(copy.item.derived_from_item_id, item.id);
  assert.equal(copy.item.production_stage, 'accepted');
  assert.equal(draft!.parent_variant_id, variant!.id);
  assert.equal(draft!.derived_from_revision_id, revision.id);
  assert.equal(draft!.current_revision_id, null);
  const working = draft!.draft_doc as Fields;
  assert.equal(working.body, 'Only $10');
  assert.deepEqual(working.media, []);
  assert.deepEqual(working.settings.platform_options.tiktok, { allow_comment: false, allow_duet: false, allow_stitch: false });
  assert.equal(working.product_refs[0].fact_revision_id, newest.id);
  assert.equal(working.product_refs[1].listing_snapshot_id, latestPrice.id);
  assert.deepEqual(copy.warnings.map(warning => [warning.code, warning.variant_id]), [['asset_removed', draft!.id], ['product_copy_review', draft!.id], ['product_copy_review', draft!.id]]);
  assert.equal(copy.warnings[1]?.before.fact_revision_id, approved.id);
  assert.equal(copy.warnings[1]?.after.fact_revision_id, newest.id);
  assert.equal(copy.warnings[2]?.before.listing_snapshot_id, listing.id);
  assert.equal(copy.warnings[2]?.after.listing_snapshot_id, latestPrice.id);
  assert.deepEqual(ctx.get('content_revision', revision.id).product_refs, revision.product_refs);
  assert.equal((revision.product_refs as Fields[])[0]?.inserted_text, 'Steel');
  assert.equal(working.product_refs[0].inserted_text, 'Alloy');
  assert.equal(working.product_refs[0].fact_revision_no, 2);
  assert.equal(working.product_refs[0].collected_at, '2026-01-03T00:00:00Z');
  const committed = await call<Promise<{ revision: Row; variant: Row }>>('content_commit_revision', {
    base_revision_id: null, settings: { platform_options: { tiktok: { privacy_level: 'SELF_ONLY', commercial_disclosure: 'none' } } },
  }, draft!.id);
  assert.equal(committed.revision.derived_from_revision_id, revision.id);
  await assert.rejects(call('content_set_readiness', { expected_version: committed.variant.version }, draft!.id), { code: 'reuse_review_required' });
  assert.equal((await call<Promise<Row>>('content_set_readiness', { expected_version: committed.variant.version, confirm_reuse_review: true }, draft!.id)).readiness, 'ready');
});

test('production workload groups active production tasks by their assignee', async () => {
  const { run, internal } = fixture();
  const { item, tasks } = await run('content_create_item', { brand_id: 'brand', title: 'Production', owner_user_id: 'lead', tasks: [
    { title: 'Resize photos', assignee_id: 'designer', blocked_reason: 'Waiting for assets', due_at: '2020-01-01' },
    { title: 'Draft copy' },
  ] });
  await internal('seed', { module: 'workspace', kind: 'work_item', data: {
    subject_ref: { kind: 'content_item', id: item.id }, kind: 'production_task', assignee_id: 'designer', status: 'done',
  } });
  await internal('seed', { module: 'workspace', kind: 'work_item_dependency', data: { work_item_id: tasks[0].id, depends_on_id: tasks[1].id } });
  assert.deepEqual(await run('content_production_workload', { brand_id: 'brand' }), [
    { owner_user_id: null, outstanding: 1, blocked: 0, overdue: 0 },
    { owner_user_id: 'designer', outstanding: 1, blocked: 1, overdue: 1 },
  ]);
  assert.deepEqual(await run('content_production_workload', { owner_user_id: 'designer' }), [
    { owner_user_id: 'designer', outstanding: 1, blocked: 1, overdue: 1 },
  ]);
  const details = await run('content_get', { content_item_id: item.id });
  assert.equal(details.task_dependencies[0].data.depends_on_id, tasks[1].id);
});

test('customer question capture derives the brand and links to Inbox without copying messages', async () => {
  const { ctx, call } = restWorkspace(operations);
  const conversation = ctx.create('conversation', { brand_id: 'brand', status: 'open' });
  const capture = (body: Fields) => call<Promise<Row>>('idea_create_from_conversation', { conversation_id: conversation.id, title: 'Size questions', ...body });
  await assert.rejects(capture({ brand_id: 'other' }), { code: 'invalid_input' });
  const idea = await capture({ origin_refs: [{ type: 'url', url: 'https://example.org' }] });
  assert.equal(idea.brand_id, 'brand');
  assert.equal(idea.origin, 'customer_question');
  assert.deepEqual(idea.origin_refs, [{ type: 'conversation', id: conversation.id }]);
  assert.deepEqual(ctx.get('conversation', conversation.id), conversation);
});

test('asset rights events warn on a scoped grant and stale only when coverage is lost', async () => {
  const { ctx, call } = restWorkspace(operations);
  const asset = ctx.create('asset', { brand_id: 'brand', status: 'active' });
  const version = ctx.create('asset_version', { asset_id: asset.id });
  function grant(status: string, regions: string[]) {
    const row = ctx.create('rights_grant', { brand_id: 'brand', status });
    const terms = ctx.create('rights_grant_revision', { rights_grant_id: row.id, usages: ['organic_social'], regions, valid_from: '2026-01-01T00:00:00Z' });
    ctx.update('rights_grant', row.id, { active_revision_id: terms.id });
    ctx.create('rights_grant_asset', { asset_id: asset.id, rights_grant_id: row.id, version_scope: 'specific_version', asset_version_id: version.id });
    return row;
  }
  const expiring = grant('expiring', ['US']);
  grant('active', ['FR']);
  const { variants: [us, fr], revisions: [frozen] } = await call<Promise<{ variants: Row[]; revisions: Row[] }>>('content_create_draft', {
    brand_id: 'brand', title: 'Rights', variants: ['US', 'FR'].map(market => ({ ...textVariant, market, media: [{ asset_version_id: version.id }] })),
  });
  const row = (id: string) => ctx.get('content_variant', id);
  const apply = (status: string) => applyContentEvent(ctx, { type: `asset.rights_grant.${status}`, payload: { rights_grant_id: expiring.id } });
  await apply('expiring');
  assert.deepEqual(row(us!.id).notices, [{ kind: 'rights_expiring', ref_id: expiring.id }]);
  assert.equal(row(fr!.id).notices, undefined);
  ctx.update('rights_grant', expiring.id, { status: 'revoked', revoked_at: ctx.now });
  await apply('revoked');
  const stale = row(us!.id);
  assert.equal(stale.state, 'stale');
  assert.deepEqual(stale.notices, []);
  assert.deepEqual(stale.stale_reasons, [{ kind: 'rights_revoked', ref_id: expiring.id }]);
  assert.equal(row(fr!.id).readiness, 'draft');
  await apply('revoked');
  await apply('expiring');
  assert.equal(row(us!.id).version, stale.version);
  assert.deepEqual(ctx.get('content_revision', frozen!.id), frozen);
});

test('glossary activation scopes translation review and returns source changes without rewriting the translation', async () => {
  const { ctx, call } = restWorkspace(operations);
  const { variants: [source] } = await call<Promise<{ variants: Row[] }>>('content_create_draft', {
    brand_id: 'brand', title: 'Localization', variants: [textVariant],
  });
  const create = (locale: string, text: string) => call<Promise<{ variant: Row; translation_link: Row }>>('content_create_translation', { locale, text }, source!.id);
  const french = await create('fr', 'Bonjour');
  const japanese = await create('ja', 'こんにちは');
  const { revision } = await call<Promise<{ revision: Row }>>('content_commit_revision', { base_revision_id: source!.current_revision_id, body: 'Updated source' }, source!.id);
  const entry = ctx.create('knowledge_entry', { kind: 'glossary_term', brand_id: 'brand', locales: ['fr'], status: 'active', active_revision_id: 'current-fr' });
  const activation = { type: 'asset.knowledge.activated', payload: { knowledge_entry_id: entry.id, knowledge_revision_id: 'current-fr' } };
  await applyContentEvent(ctx, activation);
  const [fr, ja] = await call<Promise<Fields[]>>('content_list_translations', {}, source!.id);
  assert.equal(fr!.current_source_revision.id, revision.id);
  assert.equal(fr!.target_revision.body, 'Bonjour');
  assert.deepEqual(fr!.source_diff.changes.body, { before: textVariant.body, after: 'Updated source' });
  assert.ok(fr!.pending_glossary_version);
  assert.equal(ja!.pending_glossary_version, null);
  assert.equal(ja!.target_variant.id, japanese.variant.id);
  await applyContentEvent(ctx, activation);
  assert.equal(ctx.get('content_variant', french.variant.id).version, fr!.target_variant.version);
  const reviewed = await call<Promise<Row>>('content_mark_divergence', { expected_version: fr!.translation_link.version, source_revision_id: revision.id,
    glossary_version: fr!.pending_glossary_version, note: 'Local usage' }, french.translation_link.id);
  assert.equal(reviewed.status, 'accepted_divergence');
  await applyContentEvent(ctx, activation);
  assert.equal(ctx.get('translation_link', reviewed.id).status, 'accepted_divergence');
});
