import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Row } from '@smartsell/contracts';
import { beginReplyAttempt, ingestPlatformMessage, operations, recordReplyReceipt } from './index.js';
import { commandContext } from './operations.js';
import { at, byId, workspaceFixture } from './workspace-fixture.js';

const seed = { kind: 'comment_thread', provider: 'meta_facebook', brand_id: 'brand', social_account_id: 'account', external_thread_id: 'root', external_message_id: 'root', platform_created_at: '2026-11-19T11:55:00.000Z', body_text: 'Question', source: 'poll' };
async function setup() {
  const fixture = workspaceFixture(operations);
  const { ctx, run } = fixture;
  const { conversation, message } = await ingestPlatformMessage(commandContext(ctx), seed);
  const lease = await run('inbox_claim', {}, byId(conversation.id));
  let draft = await run('inbox_draft_reply', { body_text: 'Answer', status: 'approved', in_reply_to_message_id: message.id }, byId(conversation.id));
  assert.equal(draft.status, 'editing');
  draft = await run('inbox_submit_reply_approval', {}, at(draft));
  draft = await run('inbox_approve_reply', {}, at(draft));
  return { ...fixture, conversation, message, lease, draft };
}

test('inbox deduplicates deliveries, tracks personal read state and keeps notes separate', async () => {
  const { ctx, run, conversation, message } = await setup();
  const duplicate = await ingestPlatformMessage(commandContext(ctx), seed);
  assert.equal(duplicate.message.id, message.id);
  assert.equal(ctx.list('message').length, 1);
  await run('inbox_mark_read', { message_id: message.id }, byId(conversation.id));
  assert.equal(ctx.get('conversation', conversation.id).status, 'open');
  await run('inbox_add_note', { body: 'Internal' }, byId(conversation.id));
  const details = await run<{ messages: Row[]; notes: Row[] }>('inbox_get_conversation', {}, byId(conversation.id));
  assert.equal(details.messages.length, 1);
  assert.equal(details.messages[0].body_text, undefined);
  assert.deepEqual(details.messages[0].untrusted_content, { body_text: 'Question', edit_history: [] });
  assert.equal(details.notes[0].body, 'Internal');
});

test('manual reply uses fencing and requires evidence without creating a platform message', async () => {
  const { ctx, run, lease, draft, conversation } = await setup();
  const send = { ...at(draft), idempotencyKey: 'manual-1' };
  await assert.rejects(run('inbox_send_reply', { fencing_token: 99 }, send), { code: 'LEASE_HELD' });
  const reply = await run('inbox_send_reply', { fencing_token: lease.fencing_token }, send);
  assert.equal(reply.status, 'manual');
  await assert.rejects(run('inbox_manual_complete_reply', { fencing_token: lease.fencing_token }, at(reply)), { code: 'invalid_input' });
  const delivered = await run('inbox_manual_complete_reply', { fencing_token: lease.fencing_token, platform_url: 'https://example.com/comments/123' }, at(reply));
  assert.equal(delivered.verification, 'manual_evidence');
  assert.equal(delivered.result_message_id, null);
  assert.equal(ctx.list('message').length, 1);
  assert.equal(ctx.get('conversation', conversation.id).status, 'waiting_customer');
});

test('API receipt tracks timeout, rejects blind retry and verifies only platform readback', async () => {
  const { ctx, run, lease, draft, events } = await setup();
  const send = { ...at(draft), idempotencyKey: 'api-1' };
  await assert.rejects(run('inbox_send_reply', { mode: 'api', fencing_token: lease.fencing_token }, send), { code: 'CAPABILITY_UNAVAILABLE' });
  ctx.create('inbox_capability', { social_account_id: 'account', capability: 'comment.reply', status: 'available' });
  const reply = await run('inbox_send_reply', { mode: 'api', fencing_token: lease.fencing_token }, send);
  const attempt = await beginReplyAttempt(commandContext(ctx), reply.id, 'provider-request-1');
  const accepted = await recordReplyReceipt(commandContext(ctx), attempt.id, { outcome: 'accepted', receipt_ref: 'receipt-1' });
  assert.equal(accepted.data.status, 'accepted');
  assert.equal(events.filter(event => event.type === 'inbox.reply.delivered').length, 0);
  const unknown = await run('inbox_reconcile_reply', {}, byId(reply.id));
  assert.equal(unknown.status, 'outcome_unknown');
  await assert.rejects(run('inbox_retry_reply', { fencing_token: lease.fencing_token }, at(unknown)), { code: 'OUTCOME_UNKNOWN' });
  const retryable = await recordReplyReceipt(commandContext(ctx), attempt.id, { outcome: 'not_delivered', receipt_ref: 'definite-platform-rejection' });
  const queued = await run('inbox_retry_reply', { fencing_token: lease.fencing_token }, at(ctx.get('outbound_reply', retryable.id)));
  assert.equal(queued.status, 'queued');
  const second = await beginReplyAttempt(commandContext(ctx), reply.id, 'provider-request-2');
  await assert.rejects(recordReplyReceipt(commandContext(ctx), attempt.id, { outcome: 'accepted', receipt_ref: 'stale' }), { code: 'STALE_ATTEMPT' });
  await recordReplyReceipt(commandContext(ctx), second.id, { outcome: 'outcome_unknown' });
  const result = await ingestPlatformMessage(commandContext(ctx), { ...seed, external_message_id: 'sent', parent_external_id: 'root', direction: 'outbound', body_text: 'Answer', platform_created_at: ctx.now });
  const delivered = await run('inbox_reconcile_reply', {}, byId(reply.id));
  assert.equal(delivered.verification, 'platform_readback');
  assert.equal(delivered.result_message_id, result.message.id);
  assert.equal(ctx.list('outbound_reply_receipt').length, 3);
});

test('new inbound message invalidates an approved draft', async () => {
  const { ctx, run, lease, draft } = await setup();
  await ingestPlatformMessage(commandContext(ctx), { ...seed, external_message_id: 'follow-up', parent_external_id: 'root', body_text: 'Different question' });
  await assert.rejects(run('inbox_send_reply', { fencing_token: lease.fencing_token }, { ...at(draft), idempotencyKey: 'manual-2' }), { code: 'PRECHECK_BLOCKED' });
});


test('case handoff requires acknowledgment before external resolution', async () => {
  const { ctx, run, conversation } = await setup();
  const entry = await run('inbox_create_case', { conversation_ids: [conversation.id], kind: 'product_issue', title: 'Escalation' });
  const handoff = await run('inbox_handoff_case', { target: 'helpdesk', handoff_dedupe_key: 'case-1' }, at(entry));
  const pending = ctx.get('case', entry.id);
  assert.equal(pending.status, 'handed_off');
  await assert.rejects(run('inbox_update_case', { status: 'resolved' }, at(pending)), { code: 'INVALID_STATE' });
  const acknowledged = await run('inbox_update_case', { status: 'accepted_by_external', external_ref: 'ticket-42' }, at(pending));
  assert.equal(ctx.get('case_handoff', handoff.id).acknowledged_at, ctx.now);
  const resolved = await run('inbox_update_case', { status: 'resolved' }, at(acknowledged));
  assert.equal((await run('inbox_update_case', { status: 'closed' }, at(resolved))).status, 'closed');
});

test('trusted inbox messages trigger draft-only rules once and respect participant limits', async () => {
  const { ctx, run } = workspaceFixture(operations);
  ctx.role = 'admin';
  const account = ctx.create('social_account', {});
  ctx.create('inbox_capability', { social_account_id: account.id, capability: 'comment.reply', status: 'available' });
  const input = { social_account_id: account.id, trigger: 'keyword', keyword: 'question', body_text: 'Draft only', window_minutes: 30, max_per_participant_per_day: 1 };
  await assert.rejects(run('inbox_create_auto_rule', { ...input, mode: 'auto_send' }), { code: 'INVALID_INPUT' });
  const rule = await run('inbox_create_auto_rule', input);
  await run('inbox_enable_auto_rule', { enabled: true }, at(rule));
  const first = { ...seed, social_account_id: account.id, external_user_id: 'customer' };
  await ingestPlatformMessage(commandContext(ctx), first);
  await ingestPlatformMessage(commandContext(ctx), first);
  await ingestPlatformMessage(commandContext(ctx), { ...first, external_thread_id: 'next', external_message_id: 'next', platform_created_at: ctx.now });
  assert.equal(ctx.list('reply_draft').length, 1);
  assert.equal(ctx.list('outbound_reply').length, 0);
  assert.deepEqual(ctx.list('auto_rule_run').map(row => row.outcome), ['drafted', 'skipped_frequency']);
});
