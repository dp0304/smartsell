import assert from 'node:assert/strict';
import { test } from 'vitest';
import { commands, ingestPlatformMessage, operations, releaseMemberOccupancy } from './index.ts';
import { commandContext } from './operations.ts';
import { workspaceFixture } from './workspace-fixture.ts';
import type { Entity, Fields } from '../types.ts';

const base = { kind: 'comment_thread', provider: 'youtube', social_account_id: 'social', brand_id: 'brand', body_text: 'Test comment' };

test('late ancestors merge provisional threads and webhook/poll duplicates stay deduplicated', async () => {
  const { ctx, events } = workspaceFixture(operations);
  const command = commandContext(ctx);
  const ingest = async (input: Fields) => await commands.ingest_message.run(command, { ...base, ...input }) as { conversation: Entity; message: Entity; deduplicated: boolean };
  const child = await ingest({ external_message_id: 'child', parent_external_id: 'parent', platform_created_at: '2026-11-19T10:20:00Z' });
  assert.equal(child.conversation.data.sync_state, 'partial');
  const root = await ingest({ external_message_id: 'root', platform_created_at: '2026-11-19T10:00:00Z' });
  const parent = await ingest({ external_message_id: 'parent', parent_external_id: 'root', platform_created_at: '2026-11-19T10:10:00Z' });
  assert.equal(parent.conversation.id, root.conversation.id);
  assert.equal(parent.conversation.data.sync_state, 'synced');
  assert.equal((await command.get('inbox', 'message', child.message.id))?.data.conversation_id, root.conversation.id);
  const duplicate = await ingestPlatformMessage(command, { ...base, external_message_id: 'child', parent_external_id: 'parent', platform_created_at: '2026-11-19T10:20:00Z', source: 'webhook' });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(events.filter(event => event.type === 'inbox.message.received').length, 3);
});

test('membership removal fences the old holder inside the workspace transaction', async () => {
  const { ctx } = workspaceFixture(operations);
  const command = commandContext(ctx);
  const seeded = await commands.ingest_message.run(command, { ...base, external_message_id: 'root', platform_created_at: '2026-11-19T11:00:00Z' }) as { conversation: Entity };
  const id = seeded.conversation.id;
  const old = await commands.claim.run(command, { conversation_id: id }) as Entity;
  const nextActor = { ...command, actorId: 'another-user' };
  await assert.rejects(() => commands.claim.run(nextActor, { conversation_id: id }), { code: 'LEASE_HELD' });
  assert.equal(await releaseMemberOccupancy(command, command.actorId), 1);
  const replacement = await commands.claim.run(nextActor, { conversation_id: id }) as Entity;
  assert.ok(replacement.data.fencing_token > old.data.fencing_token);
  await assert.rejects(() => commands.release.run(command, { conversation_id: id, fencing_token: old.data.fencing_token }), { code: 'LEASE_HELD' });
});

test('SLA pauses resolution while awaiting a customer and emits breach only once', async () => {
  const { ctx, events } = workspaceFixture(operations);
  await commands.create_sla_policy.run(commandContext(ctx), { name: 'Support', first_response_minutes: 10, resolution_minutes: 60, pause_on_status: ['waiting_customer'] });
  const initial = await commands.ingest_message.run(commandContext(ctx), { ...base, external_message_id: 'root', platform_created_at: ctx.now }) as { conversation: Entity };
  const id = initial.conversation.id;
  ctx.now = '2026-11-19T12:05:00.000Z';
  await ingestPlatformMessage(commandContext(ctx), { ...base, external_message_id: 'reply', parent_external_id: 'root', platform_created_at: ctx.now, direction: 'outbound', source: 'poll' });
  ctx.now = '2026-11-19T13:10:00.000Z';
  await commands.sla_tick.run(commandContext(ctx), {});
  assert.equal(events.filter(event => event.type === 'inbox.sla.breached').length, 0);
  await commands.ingest_message.run(commandContext(ctx), { ...base, external_message_id: 'follow-up', parent_external_id: 'root', platform_created_at: ctx.now });
  const sla = await commandContext(ctx).get('inbox', 'conversation_sla', id);
  assert.equal(sla?.data.resolution_due_at, '2026-11-19T14:05:00.000Z');
  assert.equal(sla?.data.paused_seconds, 3900);
  const sample = operations.find(operation => operation.name === 'inbox_get_sla_sample');
  assert.deepEqual(await sample?.run(ctx, { body: {}, params: {}, query: {} }), {
    sample_count: 1, without_policy_count: 0, first_response_count: 1, resolution_count: 0, policy_pause_seconds: 3900,
  });
  ctx.now = '2026-11-19T14:06:00.000Z';
  await commands.sla_tick.run(commandContext(ctx), {});
  await commands.sla_tick.run(commandContext(ctx), {});
  assert.equal(events.filter(event => event.type === 'inbox.sla.breached' && event.data.target === 'resolution').length, 1);
});
