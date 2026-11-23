import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const field = (key, expected) => data => assert.deepEqual(data?.[key], expected);
const has = expected => data => assert.ok(JSON.stringify(data)?.includes(String(expected)), `Missing fixture value ${expected}`);
const rows = data => Array.isArray(data) ? data : data?.rows ?? data?.items ?? [];
const args = (body, id, version) => ({ ...(body !== undefined && { body }), ...(id && { params: { id } }), ...(version !== undefined && { expected_version: version }) });
const depend = (data, operation) => { assert.ok(data, `Prerequisite did not pass: ${operation}`); return data; };

async function pair({ src, rest, origin, ws, sensitive }) {
  const require = createRequire(resolve(src, 'package.json'));
  const { pairOverHttp, SignedDeviceClient, createSignedHttpTransport } = require('tsx/cjs/api')
    .require(resolve(src, 'apps/connector/src/device-client.ts'), __filenameForRequire);
  const { pairing_code } = await rest('POST', '/devices/pairing-codes', { owned_device_confirmed: true });
  sensitive(pairing_code);
  const { privateKey } = generateKeyPairSync('ed25519');
  const deviceId = await pairOverHttp(origin, ws, pairing_code, 'darwin', 'Gateway synthetic device', privateKey, { userInitiated: true, ownsDevice: true });
  const transport = createSignedHttpTransport(origin);
  const device = new SignedDeviceClient(ws, deviceId, privateKey, (action, ...input) => {
    assert.equal(action, 'heartbeat');
    return transport(action, ...input);
  });
  return { deviceId, heartbeat: () => device.heartbeat('gateway-fixture/1.0') };
}
const __filenameForRequire = import.meta.url;

export async function priority(env) {
  const { call, rest, readback, section, listener, json, sha, now, dir } = env;
  const brandName = 'Gateway desk lamp';
  const brandArgs = { body: { name: brandName, slug: 'gateway-desk-lamp' }, idempotency_key: randomUUID() };
  const brand = depend(await call('workspace_brand_create', brandArgs, field('name', brandName)), 'workspace_brand_create');
  await call('workspace_brand_create', brandArgs, field('id', brand.id), { replay: true, status: 'idempotent_replay', assertion: 'Same key and input return the original ID' });
  await call('workspace_brand_get', args(undefined, brand.id), field('id', brand.id));
  await call('workspace_brands_list', {}, has(brand.id));
  await readback('workspace_brand_create', `/brands/${brand.id}`, field('name', brandName));
  const market = depend(await call('workspace_market_create', args({ country_code: 'CN', primary_language: 'zh-CN', currency: 'CNY', timezone: 'Asia/Shanghai', name: 'Gateway CN' }, brand.id), field('timezone', 'Asia/Shanghai')), 'workspace_market_create');
  await call('workspace_market_get', args(undefined, market.id), field('id', market.id));
  await call('workspace_markets_list', args(undefined, brand.id), has(market.id));
  let store, product;

  await section('video, rights, content, publishing', async () => {
    const account = await rest('POST', '/social-accounts', { brand_id: brand.id, provider: 'meta_facebook', external_account_id: `synthetic-${randomUUID()}`,
      display_name: 'Gateway local-only account', default_timezone: 'Asia/Shanghai', owned_account_confirmed: true });
    const displayName = 'Gateway local Facebook fixture';
    await call('account_update_social_account', args({ display_name: displayName }, account.id, account.version), field('display_name', displayName));
    await call('account_get_social_account', args(undefined, account.id), field('display_name', displayName));
    await call('account_list_social_accounts', { query: { brand_id: brand.id } }, has(account.id));
    await call('account_check_operation', { params: { id: account.id }, query: { operation: 'publish', content_format: 'video' } },
      data => { assert.equal(data.decision, 'manual'); assert.deepEqual(data.paths.map(path => path.executor), ['manual']); }, { status: 'boundary_confirmed' });
    const file = resolve(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
    const bytes = await readFile(file);
    const ticket = depend(await call('file_begin_upload', args({ purpose: 'asset', mime_type: 'video/mp4', original_filename: 'clip.mp4', size_bytes: bytes.length, sha256: sha(bytes) }), data => {
      assert.ok(data.id); assert.ok(data.max_inline_bytes >= bytes.length); assert.equal(data.direct_upload, false);
    }), 'file_begin_upload');
    const uploaded = depend(await call('file_complete_upload', args({ base64: bytes.toString('base64') }, ticket.id), has(sha(bytes))), 'file_complete_upload');
    await call('file_get', args(undefined, uploaded.id), data => { assert.equal(data.sha256, sha(bytes)); assert.equal(data.size_bytes, bytes.length); });
    await call('file_download', args(undefined, uploaded.id), undefined, { expectedCode: 'HUMAN_REQUIRED' });
    await env.mediaReadback(uploaded.id, bytes);
    const asset = depend(await call('asset_create', args({ brand_id: brand.id, title: 'Gateway test video', kind: 'video', file_object_id: uploaded.id }), has('Gateway test video')), 'asset_create');
    await call('asset_get', args(undefined, asset.id), has(asset.asset_version.id));
    await call('asset_list_versions', args(undefined, asset.id), has(asset.asset_version.id));
    await call('asset_update', args({ tags: ['gateway', '视频'] }, asset.id, asset.version), has('视频'));
    const grant = await rest('POST', '/rights-grants', { brand_id: brand.id, grant_type: 'owned', usages: ['organic_social'], asset_ids: [asset.id] });
    await rest('POST', `/rights-grants/${grant.id}/activate`, {}, grant.version);
    await call('rights_get', args(undefined, grant.id), data => { has(asset.id)(data); has('organic_social')(data); });
    const queued = await call('asset_request_rendition', args({ kind: 'cover' }, asset.asset_version.id), field('status', 'queued'));
    if (queued) await call('asset_get_rendition', args(undefined, queued.id), data => {
      assert.equal(data.asset_version_id, asset.asset_version.id);
      assert.ok(['queued', 'processing', 'ready'].includes(data.status), data.status);
    });
    const item = depend(await call('content_create_item', args({ brand_id: brand.id, title: 'Gateway video content' }), data => assert.equal(data.item.title, 'Gateway video content')), 'content_create_item').item;
    const made = depend(await call('content_create_variant', args({ platform: 'facebook', format: 'video', market_id: market.id, locale: 'zh-CN' }, item.id), has('video')), 'content_create_variant');
    const variant = made.variant ?? made;
    const copy = '暖光桌灯。 #桌灯 #网关测试';
    const draft = depend(await call('content_autosave_variant', args({ body_markdown: copy, media: [{ asset_version_id: asset.asset_version.id, role: 'primary' }] }, variant.id, variant.version), has(copy)), 'content_autosave_variant');
    const committed = depend(await call('content_commit_revision', args({ base_revision_id: null }, variant.id, draft.version), data => assert.ok(data.revision.id)), 'content_commit_revision');
    await call('content_get_variant', args(undefined, variant.id), data => { has(copy)(data); has(asset.asset_version.id)(data); });
    await call('content_get', args(undefined, item.id), has(item.id));
    await call('content_list_revisions', args(undefined, variant.id), has(committed.revision.id));
    const scheduled = new Date(Date.now() + 3600_000).toISOString();
    const target = depend(await call('publishing_create_target', args({ social_account_id: account.id, content_variant_id: variant.id, revision_id: committed.revision.id,
      scheduled_at: scheduled, schedule_tz: 'Asia/Shanghai', connector_mode_pref: 'assist' }), field('scheduled_at', scheduled)), 'publishing_create_target');
    const updatedTarget = await call('publishing_update_target', args({ options: { internal_note: 'Gateway local draft review' } }, target.id, target.version), has('Gateway local draft review'));
    const checked = await call('publishing_run_precheck', args({ stage: 'schedule' }, target.id), data => {
      assert.equal(data.publish_target_id, target.id); assert.notEqual(data.overall, 'blocked'); assert.ok(data.items.length);
    });
    const afterCheck = checked ? await rest('GET', `/publish-targets/${target.id}`) : updatedTarget ?? target;
    const later = new Date(Date.parse(scheduled) + 600_000).toISOString();
    const rescheduled = await call('publishing_reschedule', args({ scheduled_at: later, schedule_tz: 'Asia/Shanghai' }, target.id, afterCheck.version), field('scheduled_at', later));
    const submitted = depend(await call('publishing_request_approval', args({}, target.id, (rescheduled ?? target).version), field('plan_status', 'awaiting_approval')), 'publishing_request_approval');
    await call('publishing_approve', args({}, target.id, submitted.version), undefined, { expectedCode: 'HUMAN_REQUIRED' });
    const checkTarget = data => {
      assert.equal(data.plan_status, 'awaiting_approval');
      assert.equal(data.execution_status, null);
      assert.equal(data.variant_revision_id, committed.revision.id);
      assert.equal(data.platform_post_id, null);
    };
    await call('publishing_get_target', args(undefined, target.id), checkTarget);
    await call('publishing_list_targets', {}, has(target.id));
    await readback('video_schedule_pending_human', `/publish-targets/${target.id}`, checkTarget);
    await readback('video_committed_revision', `/content-variants/${variant.id}`, data => { has(committed.revision.id)(data); has(copy)(data); });
    await call('publishing_list_approvals', { query: { view: 'submitted' } }, has(target.id));
    const planTime = new Date(Date.parse(later) + 86_400_000).toISOString();
    const items = [{ social_account_id: account.id, content_variant_id: variant.id, revision_id: committed.revision.id,
      scheduled_at: planTime, schedule_tz: 'Asia/Shanghai', connector_mode_pref: 'assist' }];
    const previewCheck = data => {
      assert.ok(data.preview_hash); assert.equal(data.items.length, 1); assert.equal(data.items[0].action, 'add');
      assert.notEqual(data.items[0].precheck.overall, 'blocked'); assert.equal(data.items[0].requires_approval, true);
    };
    await call('publishing_preview_plan_items', args({ items }), previewCheck, { status: 'computed_verified' });
    const plan = await call('publishing_create_plan', args({ title: 'Gateway one-item review plan', items }), field('status', 'draft'));
    if (!plan) return;
    await call('publishing_update_plan', args({ title: 'Gateway reviewed plan' }, plan.id, plan.version), field('title', 'Gateway reviewed plan'));
    const preview = await call('publishing_preview_plan', args({}, plan.id), previewCheck, { status: 'computed_verified' });
    if (!preview) return;
    const scheduledPlan = await call('publishing_schedule', args({ preview_hash: preview.preview_hash }, plan.id), data => {
      assert.equal(data.status, 'succeeded'); assert.equal(data.items.length, 1);
      assert.equal(data.items[0].status, 'approval_required'); assert.ok(data.items[0].target_id);
    });
    if (!scheduledPlan) return;
    const targetId = scheduledPlan.items[0].target_id;
    await call('publishing_get_plan', args(undefined, plan.id), data => { assert.equal(data.status, 'committed'); has(targetId)(data); });
    const scheduledDraft = await readback('plan_committed_to_approval', `/publish-targets/${targetId}`, checkTarget);
    await call('publishing_cancel', args({ reason: 'Synthetic plan target cleanup' }, targetId, scheduledDraft.version), field('plan_status', 'cancelled'));
    await readback('plan_target_cancelled', `/publish-targets/${targetId}`, data => {
      assert.equal(data.plan_status, 'cancelled'); assert.equal(data.platform_post_id, null); assert.equal(data.execution_status, null);
    });
    const originalId = committed.revision.id;
    const revisedCopy = '暖光桌灯，适合阅读。 #桌灯';
    const edited = await call('content_update_variant', args({ body_markdown: revisedCopy, base_revision_id: originalId,
      expected_version: committed.variant.version }, variant.id, committed.variant.version), has(revisedCopy));
    if (edited) {
      const nextId = (edited.variant ?? edited).current_revision_id;
      assert.ok(nextId && nextId !== originalId);
      await call('content_get_revision', args(undefined, nextId), has(revisedCopy));
      await call('content_diff_revisions', { params: { a: originalId, b: nextId } }, data => {
        assert.equal(data.revision_a, originalId); assert.equal(data.revision_b, nextId); has(revisedCopy)(data.changes);
      });
    }
  });

  await section('product, shop, CSV', async () => {
    store = depend(await call('commerce_store_create', args({ brand_id: brand.id, provider: 'file_import', mode: 'import', name: 'Gateway CSV local store',
      default_currency: 'CNY', default_locale: 'zh-CN' }), field('status', 'import_only')), 'commerce_store_create');
    const storeName = 'Gateway local CSV catalog';
    const updatedStore = await call('commerce_store_update', args({ name: storeName }, store.id, store.version), field('name', storeName));
    if (updatedStore) await call('commerce_store_get', args(undefined, store.id), field('name', storeName));
    await call('commerce_store_list', {}, has(store.id));
    await call('commerce_store_market_configure', args({ market_id: market.id, channel: 'online_store', price_source: 'store_market_price' }, store.id), has(market.id));
    await call('commerce_store_market_list', args(undefined, store.id), has(market.id));
    product = depend(await call('commerce_product_create', args({ store_id: store.id, title: 'Gateway lamp draft', status: 'draft' }), field('title', 'Gateway lamp draft')), 'commerce_product_create');
    await call('commerce_product_update', args({ title: 'Gateway lamp revised' }, product.id, product.version), field('title', 'Gateway lamp revised'));
    const sku = await call('commerce_variant_create', args({ sku: 'GATEWAY-LOCAL-V1', options: { size: 'small' } }, product.id), field('sku', 'GATEWAY-LOCAL-V1'));
    if (sku) {
      await call('commerce_variant_update', args({ sku: 'GATEWAY-LOCAL-V2' }, sku.id, sku.version), field('sku', 'GATEWAY-LOCAL-V2'));
      const listing = await call('commerce_record_listing', args({ market_id: market.id, channel: 'online_store', price_minor: 12900,
        available_for_sale: true }, sku.id), data => { assert.equal(data.variant_id, sku.id); assert.equal(data.price_amount_minor, 12900); });
      if (listing) await call('market_snapshot', args(undefined, sku.id), data => {
        const same = data.find(row => row.id === listing.id);
        assert.equal(same.price_amount_minor, 12900); assert.equal(same.currency, 'CNY');
      });
      const group = await call('commerce_variant_group_create', args({ brand_id: brand.id, name: 'Gateway variant group' }), field('name', 'Gateway variant group'));
      if (group) {
        const member = await call('commerce_variant_group_link', args({ variant_id: sku.id }, group.id), field('variant_id', sku.id));
        if (member) {
          await call('commerce_variant_group_member_list', args(undefined, group.id), has(member.id));
          await call('commerce_variant_group_unlink', { params: { id: group.id, memberId: member.id }, body: { reason: 'Fixture mapping replaced' } },
            data => { assert.equal(data.id, member.id); assert.ok(data.unlinked_at); });
          const second = await call('commerce_variant_create', args({ sku: 'GATEWAY-LOCAL-BATCH' }, product.id), field('sku', 'GATEWAY-LOCAL-BATCH'));
          if (second) await call('commerce_variant_group_link_batch', args({ members: [{ variant_id: sku.id }, { variant_id: second.id }] }, group.id),
            data => assert.deepEqual(data.map(row => row.variant_id), [sku.id, second.id]));
          if (second) await readback('variant_group_history', `/variant-groups/${group.id}/members`, data => {
            assert.ok(data.find(row => row.id === member.id)?.unlinked_at);
            assert.deepEqual(data.filter(row => !row.unlinked_at).map(row => row.variant_id).sort(), [sku.id, second.id].sort());
          });
        }
      }
    }
    const fact = await call('catalog_propose_fact', args({ fact_key: 'material', category: 'spec', value: 'Aluminum' }, product.id), field('fact_key', 'material'));
    if (fact) await call('commerce_fact_revise', args({ value: 'Brushed aluminum' }, fact.id, fact.version), data => {
      assert.equal(data.id, fact.id); assert.notEqual(data.current_revision_id, fact.current_revision_id);
    });
    const localization = await call('catalog_update_localization', args({ field_key: 'title', locale: 'fr-FR', text: 'Lampe de bureau' }, product.id), data => {
      assert.equal(data.locale, 'fr-FR'); assert.equal(data.status, 'draft'); assert.ok(data.current_revision_id);
    });
    if (localization) await call('commerce_localization_submit', args({}, localization.id, localization.version), data => {
      assert.equal(data.id, localization.id); assert.equal(data.status, 'in_review');
    });
    await call('commerce_localization_list', args(undefined, product.id), has('fr-FR'));
    await call('catalog_list_facts', args(undefined, product.id), data => assert.deepEqual(data, []), {
      status: 'valid_empty', assertion: 'No fact revisions have been approved. Draft and revised facts stay out of the Agent read.' });
    await call('catalog_get_product', args(undefined, product.id), has('Gateway lamp revised'));
    await call('catalog_search', { query: { store_id: store.id } }, has(product.id));
    await call('import_template_list', {}, has('product_list'));
    const csv = (key, title) => `external_product_id,external_variant_id,title,sku,currency,price,available,market_id\n${key},${key}-v1,${title},${key}-sku,CNY,129.00,12,${market.id}`;
    const batch = await call('import_create', args({ template_key: 'product_list', store_id: store.id, csv_text: csv('gateway-csv-1', 'Gateway imported lamp') }), data => assert.equal(data.stats.valid, 1));
    const mapped = await call('import_create', args({ template_key: 'product_list', store_id: store.id,
      csv_text: csv('gateway-csv-remap', 'Gateway remapped lamp').replace(',title,', ',Heading,') }), data => assert.ok(data.id && data.mapping));
    if (mapped) {
      const remapped = await call('import_preview', args({ mapping: { ...mapped.mapping, Heading: 'title' } }, mapped.id, mapped.version), data => assert.equal(data.stats.valid, 1));
      if (remapped) {
        const preset = await call('import_mapping_preset_create', args({ name: 'Gateway reviewed CSV headings', import_batch_id: mapped.id }), data => {
          assert.equal(data.mapping.Heading, 'title'); assert.equal(data.template_key, 'product_list');
        });
        if (preset) await call('import_mapping_preset_list', {}, has(preset.id));
      }
    }
    await call('commerce_store_import', args({ template_key: 'product_list', csv_text: csv('gateway-csv-2', 'Gateway preview lamp') }, store.id), data => assert.equal(data.stats.valid, 1));
    if (batch) {
      await call('import_rows', args(undefined, batch.id), has('Gateway imported lamp'));
      await call('import_confirm', args({}, batch.id), data => { assert.equal(data.status, 'merged'); assert.equal(data.merged_rows, 1); });
      await call('import_get', args(undefined, batch.id), field('status', 'merged'));
      await readback('import_confirm', `/imports/${batch.id}`, data => { assert.equal(data.status, 'merged'); assert.equal(data.merged_rows, 1); });
    }
    await readback('store_has_no_remote_connection', `/stores/${store.id}`, data => { assert.equal(data.status, 'import_only'); assert.equal(data.connection_id, null); });
    await readback('local_products', '/products', data => {
      assert.equal(rows(data).find(row => row.id === product.id)?.external_product_id, null);
      assert.ok(rows(data).some(row => row.external_product_id === 'gateway-csv-1'));
    });
  });

  await section('authorized loopback collection', async () => {
    const fixture = { name: '棱镜暖光桌灯', sku: 'GATEWAY-QA-21', price_minor: 12900, currency: 'CNY', availability: '有货' };
    const source = await listener((req, res) => req.url === '/desk-lamp' && req.method === 'GET'
      ? res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(fixture)) : res.writeHead(404).end());
    let capture;
    try {
      const url = `http://127.0.0.1:${source.address().port}/desk-lamp`;
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200);
      capture = { source_url: response.url, observed_at: now(), http_status: response.status, sha256: sha(bytes), fields: JSON.parse(bytes.toString()), scope: '本次自建回环样页，授权读取和入库' };
      assert.deepEqual(capture.fields, fixture);
    } finally { await new Promise(resolve => source.close(resolve)); }
    await json('collection-source.json', capture);
    const board = depend(await call('research_board_create', args({ brand_id: brand.id, title: 'Gateway authorized sample' }), field('title', 'Gateway authorized sample')), 'research_board_create');
    const item = depend(await call('research_add_item', args({ item_type: 'link', url: capture.source_url, title: capture.fields.name, body: JSON.stringify(capture), labels: ['授权样页'] }, board.id), field('url', capture.source_url)), 'research_add_item');
    const check = data => assert.deepEqual(JSON.parse(data.items.find(row => row.id === item.id).body), capture);
    await call('research_board_get', args(undefined, board.id), check);
    await call('research_boards_list', {}, has(board.id));
    const note = await call('research_create_note', args({ title: 'Gateway local evidence', body: '回环样页已读取', stance: 'evidence', evidence_refs: [item.id] }, board.id), has('回环样页已读取'));
    if (note) {
      await call('research_item_evidence', args(undefined, note.id), has(item.id));
      await call('research_item_update', args({ title: 'Gateway confirmed local evidence' }, note.id, note.version), field('title', 'Gateway confirmed local evidence'));
    }
    await call('research_board_update', args({ title: 'Gateway verified authorized sample' }, board.id, board.version), field('title', 'Gateway verified authorized sample'));
    const reference = await call('creative_reference_create', args({ url: capture.source_url, structure: { hook: 'Warm desk light' }, tags: ['gateway-fixture'] }), field('rights', 'reference_only'));
    if (reference) {
      await call('creative_reference_annotate', args({ structure: { topic: 'Desk lighting' } }, reference.id, reference.version), data => {
        assert.equal(data.structure.topic, 'Desk lighting'); assert.equal(data.rights, 'reference_only');
      });
      await call('creative_references_list', { query: { tag: 'gateway-fixture' } }, has(reference.id));
    }
    const converted = await call('research_item_convert', args({ destination: 'idea' }, item.id, item.version), data => assert.ok(data.converted_to?.id));
    if (converted) await call('idea_get', args(undefined, converted.converted_to.id), has(capture.source_url));
    const candidate = await call('product_candidate_create', args({ name: 'Gateway lamp candidate', brand_id: brand.id }), field('status', 'proposed'));
    if (candidate) {
      const researching = await call('product_candidate_update', args({ status: 'researching' }, candidate.id, candidate.version), field('status', 'researching'));
      if (researching) await call('product_candidates_score', args({ dimension: 'demand_evidence', score: 75, uncertainty: 0.2,
        evidence_item_ids: [item.id] }, candidate.id, researching.version), has(item.id));
      await call('product_candidate_get', args(undefined, candidate.id), field('status', 'researching'));
    }
    await readback('source_fields_and_time', `/research-boards/${board.id}`, check);
  });

  await section('synthetic device registration and support', async () => {
    const { deviceId, heartbeat } = await pair(env);
    await heartbeat();
    const checkHeartbeat = data => {
      const device = data.find(row => row.id === deviceId);
      assert.ok(device?.last_seen_at); assert.equal(device.client_version, 'gateway-fixture/1.0');
    };
    await call('account_list_devices', {}, checkHeartbeat);
    await readback('paired_simulated_device', '/devices', checkHeartbeat);
    if (product && store) {
      const capability = await call('desktop_request_capability', args({ capability: 'product_listing', product_id: product.id, store_id: store.id }), data => {
        assert.equal(data.status, 'unsupported'); assert.equal(data.reason, 'product_listing_not_supported');
      }, { status: 'boundary_confirmed' });
      if (capability) await call('desktop_get_capability_request', args(undefined, capability.id), field('status', 'unsupported'), { status: 'boundary_confirmed' });
    }
    const verifyQueue = data => { assert.equal(data.device_id, deviceId); assert.equal(data.mode, 'login_check'); assert.equal(data.status, 'queued'); };
    const queue = await call('zhihu_stats_create', args({ device_id: deviceId, mode: 'login_check' }), verifyQueue);
    if (queue) {
      await call('zhihu_stats_get', args(undefined, queue.id), verifyQueue);
      await readback('simulated_device_queue', `/zhihu-stats/${queue.id}`, verifyQueue);
    }
    await json('device-fixture.json', { deviceId, pairing: 'real registered public key, ephemeral synthetic client', signedHeartbeat: true, issuedRemoteAction: false, queuedTask: queue?.id });
  });
}

const first = (env, kind) => [...env.domainRows(env.recordList())].find(([key]) => key.startsWith(`row/${kind}/`))?.[1];

export async function expand(env) {
  const { call, rest, section, readback, catalog, calls } = env;
  const brand = first(env, 'brand'), market = first(env, 'market'), product = first(env, 'product');
  const account = first(env, 'social_account');
  const start = new Date(Date.now() + 86_400_000).toISOString();
  const end = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await section('workspace tasks, change approval drafts and job lifecycle', async () => {
    await call('workspace_brand_update', args({ name: 'Gateway desk lamp studio' }, brand.id, brand.version), field('name', 'Gateway desk lamp studio'));
    await call('workspace_market_update', args({ name: 'Gateway Shanghai market' }, market.id, market.version), field('name', 'Gateway Shanghai market'));
    const task = await call('tasks_create', args({ title: 'Gateway review checklist', brand_id: brand.id }), field('title', 'Gateway review checklist'));
    if (task) {
      const changed = await call('tasks_update', args({ title: 'Gateway revised checklist', status: 'in_progress' }, task.id, task.version), data => {
        assert.equal(data.title, 'Gateway revised checklist'); assert.equal(data.status, 'in_progress');
      });
      if (changed) {
        const closed = await call('tasks_complete', args({}, task.id, changed.version), field('status', 'done'));
        if (closed) await call('tasks_reopen', args({}, task.id, closed.version), field('status', 'open'));
      }
      const current = await rest('GET', `/work-items/${task.id}`);
      await call('change_sets_create', args({ title: 'Gateway review proposal', rationale: 'Synthetic title edit', items: [
        { target_type: 'work_item', target_id: task.id, expected_version: current.version, patch: { title: 'Gateway proposed title' } },
      ] }), data => { assert.equal(data.status, 'pending'); has(task.id)(data); });
    }
    const job = await rest('POST', '/agent-jobs', { title: 'Gateway collect fixture note', expected_output: { type: 'note' }, input_scope: { brand_ids: [brand.id] } });
    await call('agent_jobs_list', { query: { status: 'open' } }, has(job.id));
    const claimed = await call('agent_jobs_claim', args({}, job.id, job.version), data => assert.ok(Number.isSafeInteger(data.fencing_token)));
    if (claimed) {
      const beat = await call('agent_jobs_heartbeat', args({ fencing_token: claimed.fencing_token, progress_note: 'Gateway fixture reviewed' }, job.id, claimed.version), has('Gateway fixture reviewed'));
      const lease = beat ?? claimed;
      const note = 'Gateway authorized local sample verified';
      const verify = data => { assert.equal(data.status, 'submitted'); assert.equal(data.result_ref.note, note); };
      const submitted = await call('agent_jobs_submit_result', args({ fencing_token: lease.fencing_token, result_ref: { note } }, job.id, lease.version), verify);
      if (submitted) {
        await call('agent_jobs_get', args(undefined, job.id), verify);
        await readback('agent_jobs_submit_result', `/agent-jobs/${job.id}`, verify);
      }
    }
  });
  await section('campaign, creator and commerce fixtures', async () => {
    const plan = await call('campaign_create_draft', args({ brand_id: brand.id, name: 'Gateway launch plan', kind: 'launch', timezone: 'Asia/Shanghai',
      starts_at: start, ends_at: end, products: [{ product_id: product.id, role: 'hero' }] }), field('name', 'Gateway launch plan'));
    if (plan) {
      const goal = await call('campaign_goal_create', args({ metric_key: 'norm.post.views', unit: 'count', baseline_value: 12, baseline_source: 'synthetic sample', target_value: 100, due_at: end }, plan.id), field('target_value', 100));
      if (goal) await call('campaign_goal_update', { params: { id: plan.id, goalId: goal.id }, expected_version: goal.version, body: { target_value: 120, reason: 'Synthetic target adjustment' } }, field('target_value', 120));
      const slot = await call('campaign_plan_slot_create', args({ stage: 'launch', platform: 'facebook', planned_count: 1, locale: 'zh-CN' }, plan.id), field('planned_count', 1));
      if (slot) await call('campaign_plan_slot_update', { params: { id: plan.id, slotId: slot.id }, expected_version: slot.version, body: { planned_count: 2 } }, field('planned_count', 2));
      await call('commerce_product_usage', args(undefined, product.id), has(plan.id));
    }
    await call('commerce_variant_group_create', args({ brand_id: brand.id, name: 'Gateway variant group' }), field('name', 'Gateway variant group'));
    await call('creators_create', args({ display_name: 'Gateway synthetic creator' }), field('display_name', 'Gateway synthetic creator'));
    await call('customers_create', args({ brand_id: brand.id }), field('brand_id', brand.id));
  });
  await section('monitoring and inbox local fixtures', async () => {
    const target = await call('watch_target_create', args({ name: 'Gateway sample monitoring', target_type: 'keyword', query: { keywords: ['Gateway'] } }), field('name', 'Gateway sample monitoring'));
    if (target) {
      const sample = JSON.parse(await readFile(resolve(env.dir, 'collection-source.json'), 'utf8'));
      await call('watch_target_update', args({ name: 'Gateway authorized sample monitoring' }, target.id, target.version), field('name', 'Gateway authorized sample monitoring'));
      const observed = await call('observation_record', args({ watch_target_id: target.id, subject_type: 'post', url: sample.source_url,
        observed_at: sample.observed_at, published_at: new Date(Date.parse(sample.observed_at) - 3600_000).toISOString(),
        metrics: { likes: { value: 12, availability: 'observed' } }, note: 'Gateway source fixture (synthetic engagement)' }), has('synthetic engagement'));
      if (observed) {
        await call('observations_list', args(undefined, target.id), has(observed.id));
        const compare = age => ({ query: { watch_target_ids: target.id, age } });
        await call('observations_compare', compare('24h'), data => { assert.equal(data.sample[0].average, 12); assert.equal(data.sample[0].sample_size, 1); });
        await call('observations_compare', compare('7d'), data => assert.equal(data.sample[0].sample_size, 0), {
          status: 'valid_empty', assertion: 'The synthetic one-hour observation is outside the seven-day age bucket.' });
      }
      const mention = await call('mention_record', args({ watch_target_id: target.id, platform: 'youtube', url: sample.source_url,
        observed_at: sample.observed_at, text_excerpt: 'Synthetic desk lamp mention' }), has('Synthetic desk lamp mention'));
      if (mention) {
        await call('mentions_query', {}, has(mention.id));
        const followUp = await call('mention_escalate', args({ title: 'Review synthetic desk lamp mention' }, mention.id, mention.version), data => {
          assert.equal(data.resource_id, mention.id); assert.equal(data.resource_type, 'mention');
        });
        if (followUp) await call('tasks_get', args(undefined, followUp.id), field('resource_id', mention.id));
      }
    }
    if (!account) return;
    const inbound = { brand_id: brand.id, social_account_id: account.id, provider: 'meta_facebook', external_message_id: 'gateway-local-comment',
      kind: 'comment_thread', external_user_id: 'synthetic-participant', display_name: 'Gateway sample participant',
      body_text: 'Gateway synthetic inbound message', platform_created_at: new Date(Date.now() - 2_000).toISOString() };
    await call('inbox_ingest_batch', args({ messages: [inbound] }), data => assert.ok(data && typeof data === 'object'));
    const [conversation] = rows(await rest('GET', '/conversations'));
    if (conversation) {
      const claim = await call('inbox_claim', args({ purpose: 'review' }, conversation.id), field('conversation_id', conversation.id));
      if (claim) await call('inbox_release', args({ fencing_token: claim.fencing_token }, conversation.id), field('released', true));
      const opened = await call('inbox_create_case', args({ conversation_ids: [conversation.id], kind: 'product_issue', title: 'Gateway synthetic inbox case' }), field('status', 'open'));
      if (opened) await call('inbox_get_case', args(undefined, opened.id), has(conversation.id));
    }
  });
  await section('content library, local promotion, and personal views', async () => {
    const pillar = await call('content_create_pillar', args({ brand_id: brand.id, name: 'Gateway editorial' }), field('name', 'Gateway editorial'));
    if (pillar) await call('content_update_pillar', args({ name: 'Gateway editorial revised' }, pillar.id, pillar.version), field('name', 'Gateway editorial revised'));
    const source = JSON.parse(await readFile(resolve(env.dir, 'collection-source.json'), 'utf8'));
    const idea = await call('idea_create', args({ brand_id: brand.id, pillar_id: pillar?.id, title: 'Gateway lamp story',
      origin_refs: [{ type: 'url', url: source.source_url }] }), field('title', 'Gateway lamp story'));
    if (idea) await call('idea_update', args({ title: 'Gateway revised lamp story' }, idea.id, idea.version), field('title', 'Gateway revised lamp story'));
    const folder = await call('asset_create_folder', args({ brand_id: brand.id, name: 'Gateway video folder' }), field('name', 'Gateway video folder'));
    if (folder) await call('asset_update_folder', args({ name: 'Gateway video review folder' }, folder.id, folder.version), field('name', 'Gateway video review folder'));
    await call('knowledge_propose', args({ brand_id: brand.id, kind: 'tone', title: 'Gateway editorial tone', body: 'Use plain language.' }), has('Use plain language.'));
    const view = await call('workspace_saved_views_create', args({ name: 'Gateway media search', resource_type: 'asset', filters: { q: 'Gateway' } }), field('name', 'Gateway media search'));
    if (view) await call('workspace_saved_views_update', args({ name: 'Gateway saved media search', resource_type: 'asset', filters: { q: 'video' } }, view.id, view.version), field('name', 'Gateway saved media search'));
    const store = first(env, 'store');
    if (store) {
      const promotion = await call('commerce_promotion_create', args({ store_id: store.id, name: 'Gateway local promotion draft',
        state: 'scheduled', valid_from: start, valid_until: end, rule: { percent_off: 15 }, codes: [{ code: 'TESTGATEWAY' }] }), data => {
        assert.equal(data.state, 'scheduled'); assert.equal(data.offer_verified, false);
      });
      if (promotion) {
        const updated = await call('commerce_promotion_update', args({ name: 'Gateway revised promotion draft' }, promotion.id, promotion.version), field('name', 'Gateway revised promotion draft'));
        if (updated) {
          await call('commerce_promotion_cancel', args({}, updated.id, updated.version), field('state', 'cancelled'));
          await call('promotion_get', args(undefined, updated.id), field('state', 'cancelled'));
        }
      }
    }
  });
  await section('local ads creative, import source, UTM and consent', async () => {
    const ad = await call('ads_register_account', args({ brand_id: brand.id, provider: 'meta_ads', external_account_id: 'act_10001', currency: 'CNY', timezone: 'Asia/Shanghai' }), field('external_account_id', 'act_10001'));
    if (ad) {
      await call('ads_list_accounts', {}, has(ad.id));
      const dataSource = await call('data_source_create', args({ name: 'Gateway ads CSV source', ad_account_id: ad.id, resources: ['ad_report'] }), field('name', 'Gateway ads CSV source'));
      if (dataSource) {
        await call('data_source_get', args(undefined, dataSource.id), field('id', dataSource.id));
        const to = new Date(Date.now() - 60_000).toISOString();
        const from = new Date(Date.parse(to) - 86_400_000).toISOString();
        await call('data_source_coverage', { params: { id: dataSource.id }, query: { resource: 'ad_report', from, to } },
          data => assert.deepEqual(data, [{ from, to, status: 'not_collected' }]), { status: 'boundary_confirmed' });
      }
      await call('ads_import_report', args({ source_ref: 'gateway-ad-csv', entity: { level: 'campaign', external_id: 'gateway-local-ad-1', name: 'Gateway imported ad' }, observations: [] }, ad.id), has('gateway-local-ad-1'));
    }
    const creative = await call('ads_create_creative', args({ brand_id: brand.id, origin: 'new' }), field('status', 'draft'));
    if (creative) await call('ads_archive_creative', args({}, creative.id, creative.version), field('status', 'archived'));
    const utm = await call('utm_create', args({ name: 'Gateway tracking template', params: { utm_source: 'gateway', utm_medium: 'test', utm_campaign: 'lamp' } }), field('name', 'Gateway tracking template'));
    if (utm) await call('utm_update', args({ name: 'Gateway tracking template revised' }, utm.id, utm.version), field('name', 'Gateway tracking template revised'));
    const consent = await call('lifecycle_create_consent_text', args({ channel: 'email', purpose: 'marketing', locale: 'zh-CN', text: 'Gateway synthetic opt-in text' }), has('Gateway synthetic opt-in text'));
    if (consent) await call('lifecycle_get_consent_text', args(undefined, consent.id), field('id', consent.id));
    const segment = await call('segments_create', args({ brand_id: brand.id, name: 'Gateway synthetic segment', required_consent: { channel: 'email', purpose: 'marketing' } }), field('mode', 'local_definition'));
    if (segment) await call('segments_get', args(undefined, segment.id), field('name', 'Gateway synthetic segment'));
    const creator = first(env, 'creator'), campaign = first(env, 'campaign');
    if (creator && campaign) await call('collaborations_create', args({ creator_id: creator.id, campaign_id: campaign.id, type: 'gifted' }), field('creator_id', creator.id));
  });
  await section('catalog reads using persisted fixtures', () => exerciseReads(env));
}

// Map each path segment to the persisted resource used by that route.
const subjects = {
  'views/products': 'product', 'views/plans': 'campaign', 'brands': 'brand', 'markets': 'market', 'work-items': 'work_item',
  'social-accounts': 'social_account', 'imports': 'import_batch', 'stores': 'store', 'products': 'product', 'variants': 'product_variant',
  'variant-groups': 'variant_group', 'campaigns': 'campaign', 'watch-targets': 'watch_target', 'research-boards': 'research_board',
  'research-items': 'research_item', 'content-items': 'content_item', 'content-variants': 'content_variant',
  'content-revisions': 'content_revision', 'assets': 'asset', 'rights-grants': 'rights_grant', 'publish-targets': 'publish_target',
  'conversations': 'conversation', 'messages': 'message', 'creators': 'creator', 'customers': 'customer', 'agent-jobs': 'agent_job',
  'change-sets': 'change_set', 'desktop-capability-requests': 'desktop_capability_request', 'files': 'file_object',
  'content-pillars': 'content_pillar', 'ideas': 'idea', 'asset-folders': 'asset_folder', 'knowledge': 'knowledge_entry', 'promotions': 'promotion',
  'ad-creatives': 'ad_creative', 'collaborations': 'collaboration', 'segments': 'segment', 'data-sources': 'data_source',
};
const childSubjects = { goalId: 'campaign_goal', slotId: 'campaign_plan_slot' };
const requiresQuery = new Set(['account_check_operation', 'account_preview_binding_migration', 'observations_compare', 'share_of_voice_get',
  'publishing_suggest_slots', 'data_provenance_get', 'posts_performance_get', 'accounts_performance_get', 'links_performance_get',
  'ads_query_performance', 'revenue_query', 'contribution_query', 'posting_time_get', 'audience_insights_get', 'research_search', 'search_query']);
const excludedReads = /(?:^|_)(?:download|export|error_file|probe|reconcile|suggest_post_match)(?:_|$)/;
const queryFor = {
  search_query: ({ brand }) => ({ q: brand.name }),
  data_provenance_get: ({ imported }) => imported && ({ resource_type: 'product', resource_id: imported.id }),
  publishing_suggest_slots: ({ account }) => account && ({ social_account_id: account.id }),
  views_calendar: () => ({ from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }),
  research_search: ({ research }) => research && ({ kind: 'research_item', id: research.id }),
  campaign_historical_baselines: () => ({ metric_key: 'norm.post.views', unit: 'count' }),
  content_list_product_facts: ({ product }) => product && ({ product_id: product.id }),
  content_list_product_prices: ({ product }) => product && ({ product_id: product.id }),
  cohorts_list: () => ({ from: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }),
};

async function exerciseReads(env) {
  const { call, catalog, calls } = env;
  const attempted = new Set(['posts_list', ...calls.map(item => item.operation)]);
  const records = [...env.domainRows(env.recordList())];
  const rowIds = new Set(records.map(([, row]) => row.id).filter(Boolean));
  const candidate = (kind, match = () => true) => records.find(([key, row]) => key.startsWith(`row/${kind}/`) && match(row))?.[1];
  const context = { brand: candidate('brand'), imported: candidate('product', row => row.external_product_id === 'gateway-csv-1'),
    product: candidate('product'), account: candidate('social_account'), research: candidate('research_item') };
  const containsRecord = value => value && typeof value === 'object'
    ? Object.values(value).some(containsRecord) : typeof value === 'string' && rowIds.has(value);
  for (const operation of catalog.values()) {
    if (operation.method !== 'GET' || attempted.has(operation.name) || excludedReads.test(operation.name)) continue;
    const params = {};
    const matches = [...operation.path.matchAll(/:([\w]+)/g)];
    if (matches.length) {
      const collection = operation.path.slice(1, matches[0].index - 1);
      const kind = subjects[collection];
      const id = kind && candidate(kind)?.id;
      if (!id || !['id', 'brandId'].includes(matches[0][1])) continue;
      params[matches[0][1]] = id;
      for (const [, name] of matches.slice(1)) {
        const child = candidate(childSubjects[name], row => row.campaign_id === id);
        if (child) params[name] = child.id;
      }
      if (matches.length !== Object.keys(params).length) continue;
    }
    const query = queryFor[operation.name]?.(context);
    if (!query && requiresQuery.has(operation.name)) continue;
    await call(operation.name, { ...(matches.length && { params }), ...(query && { query }) }, data => {
      if (Array.isArray(data) && data.length === 0) return 'valid_empty';
      if (containsRecord(data)) return 'fixture_reference_observed';
      return 'response_only';
    }, { phase: 'catalog_read', assertion: 'Use a persisted fixture for each path ID. Check for an empty list or a returned fixture ID. General read results require a domain-specific assertion to count as business successes.' });
  }
}
