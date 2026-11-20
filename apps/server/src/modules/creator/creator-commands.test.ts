import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Row } from '@smartsell/contracts';
import { commandContext } from '../inbox/operations.ts';
import { workspaceFixture } from '../inbox/workspace-fixture.ts';
import type { Fields } from '../types.ts';
import { commands, operations, submitPortalDeliverable } from './index.ts';

const due = '2026-11-20T12:00:00Z';

function setup() {
  const fixture = workspaceFixture(operations);
  const { ctx } = fixture;
  ctx.role = 'admin';
  // Copy the adapter so the test exercises the workspace command path used by the stores.
  const command = { ...commandContext(ctx, 'creator') };
  command.insert = async (module, kind, data, id) => {
    const { id: savedId, version, created_at, updated_at } = fixture.seed(kind, data, id);
    return { id: savedId, module, kind, data, version, created_at, updated_at, tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId };
  };
  const run = async (name: string, input: Fields): Promise<Row> => {
    assert.ok(commands[name].roles.includes(command.role));
    return await commands[name].run(command, input) as Row;
  };
  return { ...fixture, command, run };
}

test('Creator commands and scoped portal submissions share delivery state', async () => {
  const { ctx, command, run, events } = setup();
  const campaign = ctx.create('campaign', { brand_id: 'brand' });
  const creator = await run('creators_create', { display_name: 'Creator' });
  const collaboration = await run('collaborations_create', { creator_id: creator.id, campaign_id: campaign.id, type: 'gifted' });
  const outreach = await run('outreach_draft', { collaboration_id: collaboration.id, body: 'Invitation', channel: 'email' });
  await run('outreach_record_sent', { outreach_id: outreach.id, expected_version: outreach.version, external_message_ref: 'invite-1', sent_at: ctx.now });
  await run('outreach_record_reply', { collaboration_id: collaboration.id, channel: 'email', external_message_ref: 'reply-1', body: 'Yes' });
  const current = ctx.get('collaboration', collaboration.id);
  const deliverable = await run('deliverables_create', { collaboration_id: current.id, kind: 'short_video', due_at: due, acceptance_criteria: [] });
  await assert.rejects(() => submitPortalDeliverable(command, deliverable.id, { post_url: 'https://example.com/video' }), { code: 'invalid_status' });
  await assert.rejects(() => run('collaborations_create_terms', { collaboration_id: collaboration.id, expected_version: 1 }), { code: 'version_conflict' });
  const terms = await run('collaborations_create_terms', { collaboration_id: collaboration.id, expected_version: current.version });
  const sent = await run('collaborations_send_terms', { terms_revision_id: terms.id, expected_version: terms.version, signature_request_ref: 'request-1' });
  const evidence = ctx.create('evidence', { kind: 'file' });
  await run('collaborations_mark_terms_signed', { terms_revision_id: sent.id, expected_version: sent.version, signed_evidence_ids: [evidence.id] });
  const other = await run('deliverables_create', { collaboration_id: current.id, kind: 'short_video', due_at: due, acceptance_criteria: [] });
  const submitted = await submitPortalDeliverable(command, deliverable.id, { deliverable_id: other.id, post_url: 'https://example.com/video', asset_ids: ['bad'] });
  assert.equal(submitted.data.deliverable_id, deliverable.id);
  assert.deepEqual(submitted.data.asset_ids, []);
  assert.equal(ctx.get('deliverable', other.id).status, 'requested');
  assert.equal(ctx.get('deliverable', deliverable.id).status, 'submitted');
  const reviewed = await run('deliverables_review', { deliverable_version_id: submitted.id, expected_version: submitted.version, status: 'accepted' });
  assert.equal(reviewed.review_status, 'accepted');
  assert.equal(ctx.get('deliverable', deliverable.id).accepted_version_id, submitted.id);
  assert.equal(events.filter(event => event.type === 'creator.deliverable.submitted').length, 1);
});

test('deliverable acceptance checks the submitted asset version and paid scope', async () => {
  const { ctx, run } = setup();
  const collaboration = ctx.create('collaboration', { status: 'active', brand_id: 'brand' });
  const market = ctx.create('market', { country_code: 'US' });
  const terms = ctx.create('collaboration_terms', {
    collaboration_id: collaboration.id, sign_status: 'signed',
    usage_rights_required: { channels: ['youtube'], market_ids: [market.id], paid_use: true, end_at: '2026-11-30T00:00:00.000Z' },
  });
  ctx.update('collaboration', collaboration.id, { current_terms_revision_id: terms.id });
  const deliverable = await run('deliverables_create', { collaboration_id: collaboration.id, kind: 'short_video', due_at: due, acceptance_criteria: [] });
  const asset = ctx.create('asset', { brand_id: 'brand', current_version_id: 'first-version' });
  const submitted = await run('deliverables_submit', { deliverable_id: deliverable.id, expected_version: deliverable.version, asset_ids: [asset.id] });
  ctx.update('asset', asset.id, { current_version_id: 'second-version' });
  const grant = ctx.create('rights_grant', { brand_id: 'brand', status: 'active' });
  const revision = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, valid_from: ctx.now, platforms: ['youtube'], regions: ['US'], usages: ['organic_social'] });
  ctx.update('rights_grant', grant.id, { active_revision_id: revision.id });
  const link = ctx.create('rights_grant_asset', { asset_id: asset.id, rights_grant_id: grant.id, version_scope: 'specific_version', asset_version_id: 'second-version' });
  const linkRights = () => run('deliverables_link_rights', { deliverable_id: deliverable.id, expected_version: ctx.get('deliverable', deliverable.id).version, rights_grant_ids: [grant.id] });
  await assert.rejects(linkRights, { code: 'RIGHTS_MISMATCH' });
  ctx.update('rights_grant_asset', link.id, { asset_version_id: 'first-version' });
  await assert.rejects(linkRights, { code: 'RIGHTS_REQUIRED' });
  ctx.update('rights_grant_revision', revision.id, { usages: ['organic_social', 'paid_ads'] });
  await linkRights();
  ctx.update('rights_grant', grant.id, { status: 'revoked' });
  await assert.rejects(() => run('deliverables_review', { deliverable_version_id: submitted.id, expected_version: submitted.version, status: 'accepted' }), { code: 'RIGHTS_MISMATCH' });
});

test('Creator command registry calculates paid-order commissions and excludes external settlements from self-payment', async () => {
  const { ctx, run, events } = setup();
  const affiliation = ctx.create('affiliate_assignment', { collaboration_id: 'unused', kind: 'discount_code', code: 'save', valid_from: '2026-11-18T00:00:00.000Z' });
  const collaboration = ctx.create('collaboration', { status: 'active', brand_id: 'brand' });
  const terms = ctx.create('collaboration_terms', { collaboration_id: collaboration.id, sign_status: 'signed', commission_rule: { kind: 'rate', rate_bps: 1000, observation_days: 0, settlement_by: 'shopify_collabs' } });
  ctx.update('collaboration', collaboration.id, { current_terms_revision_id: terms.id });
  ctx.update('affiliate_assignment', affiliation.id, { collaboration_id: collaboration.id });
  const store = ctx.create('store', { brand_id: 'brand' });
  const order = ctx.create('order', { store_id: store.id, currency: 'USD', financial_status: 'paid', paid_at: ctx.now });
  const line = ctx.create('order_line', { order_id: order.id, external_line_id: 'line-1', unit_price_minor: 5000, quantity: 2, discount_minor: 1000 });
  ctx.create('discount_usage', { order_id: order.id, code: 'SAVE' });
  const data = { affiliate_assignment_id: affiliation.id, order_line_id: line.id };
  const entry = await run('commissions_accrue', data);
  const replay = await run('commissions_accrue', data);
  assert.equal(entry.id, replay.id);
  assert.equal(entry.basis_amount_minor, 9000);
  assert.equal(entry.commission_minor, 900);
  assert.equal(events.find(event => event.type === 'creator.commission.accrued')?.data.commission_entry_id, entry.id);
  await run('commissions_mature', {});
  const version = ctx.get('commission_entry', entry.id).version;
  await run('commissions_approve', { commission_entry_id: entry.id, expected_version: version });
  await assert.rejects(() => run('commissions_create_batch', { commission_entry_ids: [entry.id], currency: 'USD', period: '2026-11' }), { code: 'INELIGIBLE_SETTLEMENT' });
});
