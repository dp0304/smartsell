import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../types.ts';
import { commands, unsubscribe } from './index.ts';
import { context } from './test-context.ts';

test('withdrawals beat equal-time opt-ins and imported positives; newer proven consent can restore eligibility', async () => {
  const ctx = context();
  const customer = await commands.create_customer!.run(ctx, { market_id: 'tw', primary_locale: 'zh-TW' });
  const copy = await commands.create_consent_text!.run(ctx, { channel: 'email', purpose: 'marketing', locale: 'zh-TW', text: 'Send email updates' });
  const fields = { customer_id: customer.id, channel: 'email', purpose: 'marketing', evidence_ref: 'document-1' };
  const optIn = () => commands.record_consent!.run(ctx, { ...fields, action: 'opt_in', consent_text_version_id: copy.id });
  await optIn();
  const segment = await commands.create_segment!.run(ctx, { name: 'TW', definition: { market_id: 'tw' }, channel: 'email' });
  const preview = () => commands.segments_preview!.run(ctx, { segment_version_id: segment.version.id });
  assert.equal((await preview()).eligible_count, 1);
  const snapshot = await commands.segments_preview!.run(ctx, { segment_version_id: segment.version.id, save_snapshot: true });
  const token = await commands.create_unsubscribe_link!.run(ctx, { customer_id: customer.id, channel: 'email' });
  assert.match(token.id, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(await unsubscribe(ctx, token.id), { unsubscribed: true });
  await optIn();
  ctx.now = '2026-10-02T12:00:00.000Z';
  await commands.record_consent!.run(ctx, { ...fields, action: 'imported_state' });
  assert.equal((await preview()).excluded.opted_out, 1);
  assert.ok('snapshot_id' in snapshot);
  assert.equal((await ctx.get('lifecycle', 'segment_snapshot', snapshot.snapshot_id))?.data.eligible_count, 1);
  for (const [channel, purpose] of [['email', 'service'], ['sms', 'marketing']]) {
    assert.equal((await commands.get_consent_state!.run(ctx, { customer_id: customer.id, channel, purpose })).state, 'unknown');
  }
  await optIn();
  await unsubscribe(ctx, token.id);
  assert.equal((await preview()).eligible_count, 1);
  assert.equal((await ctx.list('lifecycle', 'consent_record')).filter(row => row.data.source === 'unsubscribe_link').length, 1);
  await assert.rejects(unsubscribe(context('other'), token.id), (error: DomainError) => error.status === 404);
  ctx.now = '2026-12-01T12:00:00.000Z';
  await assert.rejects(unsubscribe(ctx, token.id), (error: DomainError) => error.status === 404);
});

test('staff opt-ins require evidence and matching effective text', async () => {
  const ctx = context();
  const customer = await commands.create_customer!.run(ctx, {});
  const copy = await commands.create_consent_text!.run(ctx, { channel: 'email', purpose: 'service', locale: 'en', text: 'Reply to inquiry' });
  const fields = { customer_id: customer.id, channel: 'email', purpose: 'marketing', action: 'opt_in', consent_text_version_id: copy.id };
  await assert.rejects(commands.record_consent!.run(ctx, fields), /evidence_ref/);
  await assert.rejects(commands.record_consent!.run(ctx, { ...fields, evidence_ref: 'evidence' }), /purpose/);
  assert.deepEqual(await ctx.list('lifecycle', 'consent_record'), []);
});
