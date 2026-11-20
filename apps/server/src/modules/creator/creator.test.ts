import assert from 'node:assert/strict';
import { test } from 'node:test';
import { at, byId, workspaceFixture } from '../inbox/workspace-fixture.js';
import { operations } from './index.js';

async function prepare(type = 'gifted', settlementBy = 'self') {
  const fixture = workspaceFixture(operations);
  const { ctx, run } = fixture;
  const campaign = ctx.create('campaign', { brand_id: 'brand' });
  const creator = await run('creators_create', { display_name: 'Creator', value_encrypted: 'ignore' });
  assert.equal(creator.value_encrypted, undefined);
  let collaboration = await run('collaborations_create', { creator_id: creator.id, campaign_id: campaign.id, type, status: 'active' });
  assert.equal(collaboration.status, 'prospect');
  const outreach = await run('outreach_draft', { channel: 'email', body: 'Invitation' }, byId(collaboration.id));
  await run('outreach_send', {}, { ...at(outreach), idempotencyKey: 'outreach' });
  assert.equal(ctx.get('outreach', outreach.id).status, 'draft');
  await run('outreach_record_sent', { external_message_ref: 'email-1', sent_at: ctx.now }, at(outreach));
  await run('outreach_record_reply', { external_message_ref: 'email-2', channel: 'email', body: 'Interested' }, byId(collaboration.id));
  collaboration = ctx.get('collaboration', collaboration.id);
  assert.equal(collaboration.status, 'negotiating');
  const terms = await run('collaborations_create_terms', type === 'commission' ? {
    commission_rule: { kind: 'rate', rate_bps: 1000, observation_days: 1, settlement_by: settlementBy },
  } : {}, at(collaboration));
  const sent = await run('collaborations_send_terms', { signature_request_ref: 'request' }, at(terms));
  await assert.rejects(run('collaborations_mark_terms_signed', { signed_evidence_ids: ['unknown'] }, at(sent)), { status: 404 });
  const evidence = ctx.create('evidence', { kind: 'file' });
  const signed = await run('collaborations_mark_terms_signed', { signed_evidence_ids: [evidence.id] }, at(sent));
  collaboration = ctx.get('collaboration', collaboration.id);
  assert.equal(collaboration.status, 'active');
  return { ...fixture, collaboration, signed, evidence };
}

test('creator outreach, terms, delivery revisions and publication use distinct evidence', async () => {
  const { ctx, run, collaboration } = await prepare();
  const delivery = await run('deliverables_create', { kind: 'short_video', due_at: ctx.now, acceptance_criteria: ['15 seconds'] }, byId(collaboration.id));
  const v1 = await run('deliverables_submit', { post_url: 'https://example.com/first' }, at(delivery));
  assert.equal(v1.review_status, 'pending');
  await assert.rejects(run('deliverables_verify_publication', { platform_url: 'https://example.com/first' }, at(ctx.get('deliverable', delivery.id))), { code: 'INVALID_STATE' });
  await run('deliverables_review', { status: 'changes_requested', note: 'Shorten' }, at(v1));
  const v2 = await run('deliverables_submit', { post_url: 'https://example.com/second' }, at(ctx.get('deliverable', delivery.id)));
  await assert.rejects(run('deliverables_review', { status: 'accepted' }, at(ctx.get('deliverable_version', v1.id))), { code: 'INVALID_STATE' });
  await run('deliverables_review', { status: 'accepted' }, at(v2));
  const accepted = ctx.get('deliverable', delivery.id);
  assert.equal(accepted.accepted_version_id, v2.id);
  assert.deepEqual(accepted.rights_grant_ids, []);
  const published = await run('deliverables_verify_publication', { platform_url: 'https://example.com/second' }, at(accepted));
  assert.equal(published.verification, 'manual_link');
  assert.equal((await run('collaborations_update', { status: 'completed' }, at(ctx.get('collaboration', collaboration.id)))).status, 'completed');
});

async function ledger(settlementBy = 'self') {
  const fixture = await prepare('commission', settlementBy);
  const { ctx, run, collaboration } = fixture;
  const assignment = await run('creators_assign_affiliate', { kind: 'discount_code', code: 'CODE' }, byId(collaboration.id));
  const store = ctx.create('store', { brand_id: 'brand' });
  const order = ctx.create('order', { store_id: store.id, currency: 'USD', financial_status: 'paid', paid_at: ctx.now });
  ctx.create('discount_usage', { order_id: order.id, code: 'CODE' });
  const line = ctx.create('order_line', { order_id: order.id, external_line_id: 'line1', unit_price_minor: 1_200, quantity: 1, discount_minor: 200 });
  const input = { affiliate_assignment_id: assignment.id, order_line_id: line.id };
  await assert.rejects(run('commissions_accrue', { ...input, estimated: true }), { code: 'invalid_input' });
  const accrual = await run('commissions_accrue', input);
  assert.equal(accrual.basis_amount_minor, 1000);
  assert.equal(accrual.commission_minor, 100);
  assert.equal((await run('commissions_accrue', input)).id, accrual.id);
  return { ...fixture, accrual, order, line };
}

test('verified refund appends a deduplicated negative commission entry', async () => {
  const { ctx, run, accrual, order, line } = await ledger();
  const refund = ctx.create('refund', { order_id: order.id, currency: 'USD', status: 'succeeded', lines: [{ external_line_id: line.external_line_id, amount_minor: 1000 }] });
  const reversal = await run('commissions_reverse', { refund_id: refund.id }, at(accrual));
  assert.equal(reversal.reversal_of_id, accrual.id);
  assert.equal(reversal.commission_minor, -100);
  const original = ctx.get('commission_entry', accrual.id);
  assert.equal(original.commission_minor, 100);
  assert.equal(original.status, 'reversed');
  assert.equal((await run('commissions_reverse', { refund_id: refund.id }, at(original))).id, reversal.id);
});

test('external commissions cannot enter a self-settlement batch', async () => {
  const { ctx, run, accrual, evidence } = await ledger('shopify_collabs');
  ctx.now = '2026-11-21T12:00:00.000Z';
  await run('commissions_mature');
  const approved = await run('commissions_approve', {}, at(ctx.get('commission_entry', accrual.id)));
  await assert.rejects(run('commissions_create_batch', { commission_entry_ids: [accrual.id], currency: 'USD', period: '2026-11' }), { code: 'INELIGIBLE_SETTLEMENT' });
  const platform = await run('commissions_record_platform_settlement', { external_settlement_id: 'report-1', evidence_id: evidence.id }, at(approved));
  assert.equal(platform.status, 'platform_settled');
  await assert.rejects(run('commissions_create_batch', { commission_entry_ids: [platform.id], currency: 'USD', period: '2026-11' }), { code: 'INELIGIBLE_SETTLEMENT' });
  assert.deepEqual(ctx.list('settlement_batch'), []);
});


test('sample delivery records logistics evidence and does not accept creator work', async () => {
  const { ctx, run, collaboration } = await prepare();
  const variant = ctx.create('product_variant', { sku: 'SAMPLE' });
  const shipment = await run('creators_create_shipment', {
    collaboration_id: collaboration.id, lines: [{ product_variant_id: variant.id, qty: 1 }], ship_to_ref: 'private-address-ref',
  });
  assert.equal(shipment.ship_to_ref, undefined);
  const requested = await run('creators_update_shipment', { status: 'requested' }, at(shipment));
  const picking = await run('creators_update_shipment', { status: 'picking' }, at(requested));
  await assert.rejects(run('creators_update_shipment', { status: 'shipped' }, at(picking)), { code: 'INVALID_INPUT' });
  const shipped = await run('creators_update_shipment', { status: 'shipped', source_ref: 'carrier-1' }, at(picking));
  const delivered = await run('creators_update_shipment', { status: 'delivered', source_ref: 'confirmation-1' }, at(shipped));
  assert.equal(delivered.status, 'delivered');
  assert.equal(ctx.get('collaboration', collaboration.id).status, 'active');
  assert.equal(ctx.list('deliverable').length, 0);
});


test('a reconciled partial refund lowers the amount approved for settlement', async () => {
  const { ctx, run, accrual, order, line } = await ledger();
  ctx.update('order', order.id, { financial_status: 'partially_refunded' });
  const refund = ctx.create('refund', { order_id: order.id, currency: 'USD', status: 'succeeded', lines: [{ external_line_id: line.external_line_id, amount_minor: 250 }] });
  ctx.now = '2026-11-21T12:00:00.000Z';
  await run('commissions_mature');
  assert.equal(ctx.get('commission_entry', accrual.id).status, 'observing');
  const adjustment = await run('commissions_reverse', { refund_id: refund.id }, at(accrual));
  assert.equal(adjustment.commission_minor, -25);
  await run('commissions_mature');
  const approved = await run('commissions_approve', {}, at(ctx.get('commission_entry', accrual.id)));
  assert.equal(approved.commission_minor, 100);
  assert.equal(approved.approved_minor, 75);
  const batch = await run('commissions_create_batch', { commission_entry_ids: [approved.id], currency: 'USD', period: '2026-11' });
  assert.equal(batch.total_minor, 75);
});


test('creator evaluation preserves unknown dimensions and requires evidence for scores', async () => {
  const { ctx, run } = workspaceFixture(operations);
  const campaign = ctx.create('campaign', { brand_id: 'brand' });
  const creator = ctx.create('creator', { display_name: 'Candidate' });
  const evidence = ctx.create('evidence', { kind: 'file' });
  ctx.role = 'agent';
  const fields = { creator_id: creator.id, decision: 'hold', reason: 'Check other markets' };
  await assert.rejects(run('creators_evaluate', { ...fields, scores: { brand_fit: { score: 80 } } }, byId(campaign.id)), { code: 'INVALID_INPUT' });
  const [evaluation] = await run<import('@smartsell/contracts').Row[]>('creators_evaluate', {
    ...fields, scores: { brand_fit: { score: 80, evidence_refs: [evidence.id] } },
  }, byId(campaign.id));
  assert.equal(evaluation.total, 80);
  assert.equal(evaluation.scored_dimensions, 1);
  assert.equal(evaluation.ai_generated, true);
});
