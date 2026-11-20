import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWorkspace } from '../ingest/test-context';
import { type Commands, type Fields } from '../types';
import { commands } from './commands';

const orderHeader = 'external_order_id,placed_at,currency,total_minor,financial_status,buyer-email,ship-postal-code';
const orderRow = (number: string, amount: string, status = 'paid') => `${number},2026-11-15T10:00:00Z,USD,${amount},${status},private@example.test,12345`;
const productCsv = 'Handle,Title,Variant SKU,Option1 Name,Option1 Value,Variant Price,Variant Inventory Qty\ncoat,"Heavy, warm\ncoat",s-1,Color,Blue,19.90,20';
async function setup(provider = 'amazon_sp') {
  const workspace = testWorkspace();
  const run: typeof workspace.run = (_commands, action, input, options) => workspace.run(commands, action, input, options);
  const s = await run(commands, 'create_store', { name: 'Store', provider, default_currency: 'USD', default_locale: 'en' });
  const preview = (key: string, csv: string, options?: Fields) => run(commands, 'preview_import', { store_id: s.id, template_key: key, csv, options });
  const action = (name: string, batch: any) => run(commands, name, { batch_id: batch.batch_id, expected_version: batch.version });
  return { workspace, s, run, preview, action };
}

test('Amazon financial import allows only known fields, rejects invalid rows atomically, and deduplicates and rolls back', async () => {
  const { workspace, preview, action, run, s } = await setup();
  const invalid = await preview('order_list', `${orderHeader}\n${orderRow('A-1', '2000')}\n${orderRow('A-2', 'xx')}`);
  assert.equal(invalid.counts.invalid, 1);
  assert.equal(invalid.issues[0].line, 3);
  assert.equal(JSON.stringify(invalid).includes('private@example.test'), false);
  await assert.rejects(action('commit_import', invalid), { code: 'import_invalid' });
  assert.equal(workspace.list('commerce', 'order').length, 0);
  await assert.rejects(run(commands, 'preview_import', { store_id: s.id, template_key: 'order_list', csv: orderHeader }, { role: 'editor' }), { code: 'forbidden' });
  const csv = `${orderHeader}\n${orderRow('A-1', '2000')}\n${orderRow('A-1', '2000')}`;
  const batch = await preview('order_list', csv);
  assert.equal(batch.counts.duplicate, 1);
  const [commit, replay] = await Promise.all([action('commit_import', batch), action('commit_import', batch)]);
  assert.deepEqual(commit, replay);
  const [order] = workspace.list('commerce', 'order');
  assert.equal(order.data.total_minor, 2000);
  assert.equal(order.data.source.batch_id, commit.batch_id);
  assert.equal(workspace.events().filter(row => row.event === 'commerce.order.upserted').length, 1);
  const refund = await preview('refund_list', 'external_order_id,external_refund_id,created_at,currency,amount_minor,status,buyer-name\nA-1,R-1,2026-11-16T09:00:00Z,USD,250,succeeded,Private Buyer');
  const mergedRefund = await action('commit_import', refund);
  assert.equal(workspace.list('commerce', 'refund')[0].data.order_id, order.id);
  await assert.rejects(action('rollback_import', commit), { code: 'rollback_conflict' });
  await action('rollback_import', mergedRefund);
  await action('rollback_import', commit);
  assert.equal(workspace.list('commerce', 'order')[0].data.rolled_back, true);
  const snapshots = JSON.stringify([...workspace.list('commerce', 'import_batch'), ...workspace.list('commerce', 'refund'), ...workspace.events()]);
  assert.doesNotMatch(snapshots, /private@example\.test|12345|Private Buyer|buyer-email|buyer-name|ship-postal-code/);
  const newBatch = await preview('order_list', csv);
  assert.equal(newBatch.batch_id, batch.batch_id);
  assert.equal(newBatch.status, 'previewed');
  await action('commit_import', newBatch);
  assert.equal(workspace.list('commerce', 'order')[0].data.rolled_back, false);
});

test('changed preflight and injected write failures preserve transactional boundaries', async () => {
  const { workspace, preview, action, run } = await setup();
  const first = await preview('order_list', `${orderHeader}\n${orderRow('A-1', '1100')}`);
  const second = await preview('order_list', `${orderHeader}\n${orderRow('A-1', '1250')}`);
  const commit = await action('commit_import', first);
  await assert.rejects(action('commit_import', second), { code: 'preflight_changed' });
  const fresh = await action('preflight_import', second);
  assert.equal(fresh.counts.changed, 1);
  await assert.rejects(run(commands, 'commit_import', { batch_id: fresh.batch_id, expected_version: fresh.version }, { beforeWrite: (_, kind) => {
    if (kind === 'import_batch') throw new Error('forced failure after domain writes');
  } }), /forced failure/);
  assert.equal(workspace.list('commerce', 'order')[0].data.total_minor, 1100);
  assert.equal(workspace.events().filter(row => row.event === 'commerce.order.upserted').length, 1);
  const updated = await action('commit_import', fresh);
  assert.equal(workspace.list('commerce', 'order')[0].data.total_minor, 1250);
  await assert.rejects(action('rollback_import', commit), { code: 'rollback_conflict' });
  await action('rollback_import', updated);
  assert.equal(workspace.list('commerce', 'order')[0].data.total_minor, 1100);
});

test('Shopify location inventory takes priority over product CSV inventory and reverts snapshots on rollback', async () => {
  const { workspace, s, preview, action, run } = await setup('shopify');
  const seed: Commands = { market: { roles: ['owner'], run: (ctx) => ctx.insert('workspace', 'market', { locale: 'en' }, 'market-1') } };
  await workspace.run(seed, 'market');
  const market = { market_id: 'market-1', channel: 'online_store' };
  await run(commands, 'configure_store_market', { store_id: s.id, ...market, price_source: 'store_base_price', inventory_locations: ['New York'], low_stock_threshold: 5, snapshot_ttl_minutes: 60 });
  const batch = await preview('product_list', productCsv);
  await action('commit_import', batch);
  const [variant] = workspace.list('commerce', 'product_variant');
  const aliasInventory = 'Handle,SKU,Option1 Value,Location,Available (not editable)\ncoat,s-1,Blue,New York,2\ncoat,s-1,Blue,Boston,15';
  const inventory = await preview('inventory_list', aliasInventory);
  const done = await action('commit_import', inventory);
  const current = () => workspace.list('commerce', 'listing_snapshot').find(row => row.data.is_current)!;
  assert.equal(current().data.inventory_quantity, 2);
  assert.equal(current().data.price_amount_minor, 1990);
  assert.deepEqual(current().data.source.locations, { 'New York': 2 });
  assert.equal(workspace.list('commerce', 'change_event')[0].data.change_type, 'stock_low');
  const next = await preview('product_list', productCsv.replace('19.90,20', '21.90,99'));
  const later = await action('commit_import', next);
  assert.equal(current().data.inventory_quantity, 2);
  assert.equal(current().data.price_amount_minor, 2190);
  await assert.rejects(action('rollback_import', done), { code: 'rollback_conflict' });
  const available = await run(commands, 'market_snapshot', { variant_ids: [variant.id], ...market }, { now: '2026-11-19T13:01:00.000Z' });
  assert.equal(available[0].publishable_price, false);
  assert.equal(available[0].is_stale, true);
  await action('rollback_import', later);
  assert.equal(current().data.price_amount_minor, 1990);
});

test('CSV parses localized instants and rejects ambiguity, supports empty financial coverage, and blocks Lazada', async () => {
  const { preview, action, run } = await setup();
  const header = 'amazon-order-id\tpurchase-date\tcurrency\torder-total\torder-status';
  const batch = await preview('order_list', `﻿${header}\nA-1\t2026-11-14 12:30\tJPY\t1520\tShipped`, { timezone: 'Asia/Tokyo' });
  assert.equal(batch.rows[0].values.placed_at, '2026-11-14T03:30:00.000Z');
  assert.equal(batch.rows[0].values.total_minor, 1520);
  const bad = await preview('order_list', `${header}\nA-1\t2026-11-01 01:30\tUSD\t10.50\tShipped`, { timezone: 'America/New_York' });
  assert.equal(bad.counts.invalid, 1);
  const empty = await preview('order_list', header);
  assert.equal(empty.row_count, 0);
  assert.equal((await action('commit_import', empty)).status, 'committed');
  await assert.rejects(run(commands, 'import_template', { provider: 'lazada', template_key: 'product_list' }), { code: 'invalid_input' });
});

test('normalized settlement and reports share internal identifiers and drop extra data', async () => {
  const { workspace, preview, action, run, s } = await setup();
  const batch = await preview('order_list', `${orderHeader}\n${orderRow('A-1', '1100')}`);
  await action('commit_import', batch);
  const [original] = workspace.list('commerce', 'order');
  await run(commands, 'apply_settlement_rows', { store_id: s.id, template_key: 'order_list', rows: [{ external_order_id: 'A-1', placed_at: '2026-11-15T10:00:00Z', currency: 'USD', total_minor: 1200, financial_status: 'paid', buyerInfo: { name: 'private name' } }] });
  await run(commands, 'apply_settlement_rows', { store_id: s.id, template_key: 'refund_list', rows: [
    { external_order_id: 'A-1', external_refund_id: 'R-1', created_at: '2026-11-16T00:00:00Z', currency: 'USD', amount_minor: 250, status: 'succeeded' },
    { external_order_id: 'A-1', external_refund_id: 'R-2', created_at: '2026-11-16T00:00:00Z', currency: 'USD', amount_minor: 500, status: 'pending' },
  ] });
  const [updated] = workspace.list('commerce', 'order');
  assert.equal(updated.id, original.id);
  assert.equal(updated.data.total_minor, 1200);
  assert.doesNotMatch(JSON.stringify([updated, workspace.events()]), /buyerInfo|private name/);
  const summary = await run(commands, 'orders_summary', { store_id: s.id });
  assert.equal(summary.currencies[0].paid_total_less_refund_minor, 950);
});

test('local promotion plans distinguish scheduled, active, and observed use', async () => {
  const { run, s } = await setup('shopify');
  const result = await run(commands, 'save_promotion', { store_id: s.id, name: 'Winter sale', valid_from: '2026-11-20T00:00:00Z', valid_until: '2026-11-22T00:00:00Z', state: 'scheduled', rule: { percent_off: 15 }, codes: [{ code: 'WINTER15' }] });
  assert.equal(result.effective_state, 'scheduled');
  const active = await run(commands, 'promotion_get', { promotion_id: result.promotion.id }, { now: '2026-11-21T00:00:00Z' });
  assert.equal(active.effective_state, 'active');
  assert.equal(active.codes[0].data.code, 'WINTER15');
  assert.equal(active.observed_usage_count, 0);
  assert.equal(active.has_verified_offer, false);
});

test('versioned facts and localization preserve approval history', async () => {
  const { run, s, workspace } = await setup('file_import');
  const product = await run(commands, 'create_product', { store_id: s.id, title: 'Coat' });
  const bare = await run(commands, 'catalog_propose_fact', { product_id: product.id, fact_key: 'material', category: 'claim', value: { type: 'text', text: 'Wool' }, agentClientId: 'untrusted-input' });
  assert.equal(bare.revision.data.source.kind, 'manual');
  const propose = commands.catalog_propose_fact!;
  const agentCommands: Commands = {
    catalog_propose_fact: { ...propose, run(ctx, input) {
      const authenticated = { ...ctx, agentClientId: 'verified-credential' };
      return propose.run(authenticated, input);
    } },
  };
  const draftInput = { product_id: product.id, fact_key: 'weight', category: 'spec', value: { type: 'number', number: 1, unit: 'kg' } };
  const agent = await workspace.run(agentCommands, 'catalog_propose_fact', draftInput, { role: 'editor', actorId: 'editor-1' });
  assert.equal(agent.revision.data.source.kind, 'agent');
  assert.equal(agent.revision.data.created_by_id, 'editor-1');
  assert.equal(agent.revision.data.review_status, 'draft');
  await assert.rejects(workspace.run(agentCommands, 'catalog_propose_fact', draftInput, { role: 'viewer' }), { code: 'forbidden' });
  await assert.rejects(run(commands, 'review_fact_revision', { revision_id: bare.revision.id, expected_version: bare.fact.version, decision: 'approve' }), { code: 'evidence_required' });
  const draft = await run(commands, 'catalog_update_localization', { product_id: product.id, field_key: 'title', locale: 'fr-CA', text: 'Manteau' });
  const submitting = await run(commands, 'submit_localization', { localization_id: draft.localization.id, expected_version: draft.localization.version });
  const approved = await run(commands, 'review_localization', { localization_id: submitting.id, expected_version: submitting.version, decision: 'approve' });
  const candidate = await run(commands, 'catalog_update_localization', { localization_id: approved.id, expected_version: approved.version, text: 'Veste', origin: 'agent' });
  assert.equal(candidate.localization.data.approved_revision_id, draft.revision.id);
  assert.equal(candidate.localization.data.status, 'approved');
  await run(commands, 'update_product', { product_id: product.id, expected_version: product.version, title: 'Heavy coat' });
  assert.equal(workspace.list('commerce', 'product_localization')[0].data.status, 'stale');
});
