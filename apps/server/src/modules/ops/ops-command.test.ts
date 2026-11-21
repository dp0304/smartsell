import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context, Entity, Fields } from '../types.js';
import { commands, appendUsageEvent, evaluateEgress, forbiddenJobFlags, getRetentionPolicy, getUsage,
  inheritConnectorAutoStop, isConnectorAutoStopped, recordHeartbeat, requireEgress, requireUsageCapacity, type OpsContext } from './index.js';
import { workspaceHalt } from '../account/policy.js';

const date = '2026-11-19T12:00:00.000Z';
function fixture() {
  const rows: Entity[] = [];
  const events: { event: string; payload: Fields }[] = [];
  function context(workspaceId: string, role: Context['role'] = 'owner'): OpsContext {
    const belongs = (row: Entity, module: string, kind: string) => row.workspace_id === workspaceId && row.module === module && row.kind === kind;
    return {
      workspaceId, tenantId: 'tenant', actorId: 'actor', role, now: date,
      async get(module, kind, id) { return rows.find(row => belongs(row, module, kind) && row.id === id); },
      async list(module, kind) { return rows.filter(row => belongs(row, module, kind)); },
      async insert(module, kind, data, id = `r${rows.length}`) {
        assert.equal(await this.get(module, kind, id), undefined);
        const row = { module, kind, data, id, version: 1, workspace_id: workspaceId, tenant_id: this.tenantId, created_at: this.now, updated_at: this.now };
        rows.push(row);
        return row;
      },
      async update(module, kind, id, patch, expectedVersion) {
        const old = await this.get(module, kind, id);
        assert.ok(old);
        assert.equal(old.version, expectedVersion);
        const row = { ...old, data: { ...old.data, ...patch }, version: old.version + 1, updated_at: this.now };
        rows[rows.indexOf(old)] = row;
        return row;
      },
      async emit(event, payload) { events.push({ event, payload }); },
    };
  }
  return { context, rows, events };
}

const policy = (rules: unknown[], default_effect = 'deny') => ({ default_effect, rules });
const rule = (destination_id: string | null, effect: string, data_classes = ['content'], destination_kind = 'model_provider') =>
  ({ destination_kind, destination_id, effect, data_classes });

test('egress denies by default and requires a per-provider confirmation and every category', async () => {
  const { context } = fixture();
  const ctx = context('alpha');
  await assert.rejects(requireEgress(ctx, 'model_provider', ['content'], 'confirmed'), { code: 'EGRESS_BLOCKED' });
  await commands.set_egress_policy.run(ctx, policy([rule(null, 'allow'), rule('confirmed', 'allow')], 'allow'));
  await requireEgress(ctx, 'model_provider', ['content'], 'confirmed');
  for (const [ref, categories] of [['new', ['content']], ['confirmed', ['content', 'order']], ['confirmed', ['credential']],
    ['confirmed', ['unknown']], ['confirmed', []]] as const) {
    await assert.rejects(requireEgress(ctx, 'model_provider', categories, ref), { code: 'EGRESS_BLOCKED' });
  }
  await assert.rejects(requireEgress(context('beta'), 'model_provider', ['content'], 'confirmed'), { code: 'EGRESS_BLOCKED' });
});

test('workspace rules precede tenant inheritance, and masked payloads require caller support', async () => {
  const { context } = fixture();
  const ctx = context('alpha');
  ctx.opsTenantStore = context('_tenant');
  ctx.opsTenantRole = 'owner';
  await commands.set_egress_policy.run(ctx, { ...policy([rule('provider', 'allow')]), workspace_id: 'default' });
  await requireEgress(ctx, 'model_provider', ['content'], 'provider');
  await commands.set_egress_policy.run(ctx, policy([rule(null, 'deny'), rule('provider', 'allow_masked')]));
  assert.equal(await evaluateEgress(ctx, 'model_provider', ['content'], 'provider'), 'allow_masked');
  await assert.rejects(requireEgress(ctx, 'model_provider', ['content'], 'provider'), { code: 'EGRESS_BLOCKED' });
  await assert.rejects(commands.set_egress_policy.run(context('alpha', 'viewer'), policy([])), { code: 'forbidden' });
  await assert.rejects(commands.set_egress_policy.run(ctx, { ...policy([]), version: 0 }), { code: 'version_conflict' });
});

test('connector stops are layered and safe mode affects only side-effect worker flags', async () => {
  const { context, events } = fixture();
  const ctx = context('alpha');
  const other = context('beta');
  ctx.opsTenantStore = other.opsTenantStore = context('_tenant');
  ctx.opsTenantRole = 'owner';
  ctx.opsProjectConnectorHalt = async (_scope, id, stopped, reason) => {
    await workspaceHalt(ctx, stopped, reason, id);
    await workspaceHalt(other, stopped, reason, id);
  };
  await ctx.insert('account', 'account_execution_binding', { connector_mode: 'auto', auto_ack_terms_version: 'v1' }, 'binding');
  await commands.emergency_stop.run(ctx, { reason: 'Workspace stop' });
  await commands.emergency_stop.run(ctx, { scope_value: 'all', reason: 'Global stop' });
  const newWorkspace = context('new');
  newWorkspace.opsTenantStore = ctx.opsTenantStore;
  await inheritConnectorAutoStop(newWorkspace);
  assert.equal((await newWorkspace.get('account', 'connector_auto_policy', 'connector_auto_policy'))?.data.halted, true);
  assert.equal(await isConnectorAutoStopped(other), true);
  assert.deepEqual(await forbiddenJobFlags(ctx), []);
  await commands.set_safe_mode.run(ctx, { enabled: true, reason: 'Restoring' });
  assert.deepEqual(await forbiddenJobFlags(ctx), ['fx']);
  await commands.set_safe_mode.run(ctx, { enabled: false, reason: 'Restored' });
  assert.equal(await isConnectorAutoStopped(ctx), true);
  await commands.resume_connector_auto.run(ctx, { scope_value: 'all', reason: 'Global resume' });
  assert.equal(await isConnectorAutoStopped(other), false);
  assert.equal(await isConnectorAutoStopped(ctx), true);
  await workspaceHalt(ctx, true, 'Account-owned workspace stop');
  await commands.resume_connector_auto.run(ctx, { reason: 'Workspace resume' });
  assert.equal(await isConnectorAutoStopped(ctx), true);
  assert.deepEqual((await ctx.get('account', 'account_execution_binding', 'binding'))?.data,
    { connector_mode: 'auto', auto_ack_terms_version: 'v1' });
  assert.equal((await ctx.get('ops', 'job_pause_rule', 'connector_auto:alpha'))?.data.active, false);
  assert.ok(events.some(({ event }) => event === 'ops.connector_auto.stopped'));
  await assert.rejects(commands.emergency_stop.run(context('gamma'), { scope_value: 'all', reason: 'No tenant role' }), { code: 'forbidden' });
});

test('heartbeat summaries age nodes out at thirty seconds', async () => {
  const ctx = fixture().context('alpha');
  await recordHeartbeat(ctx, { node_id: 'main', version: 'v1', roles: ['api', 'worker'], status: { db: 'ok', storage: 'degraded', queue_lag_s: 3 } });
  assert.match(JSON.stringify(await commands.health.run(ctx, {})), /"online":true/);
  ctx.now = '2026-11-19T12:00:30.000Z';
  assert.match(JSON.stringify(await commands.health.run(ctx, {})), /"online":false/);
});

test('retention defaults, legal holds, and Amazon shortening are preserved', async () => {
  const { context } = fixture();
  const ctx = context('alpha');
  ctx.opsTenantStore = context('_tenant');
  ctx.opsTenantRole = 'owner';
  assert.equal((await getRetentionPolicy(ctx, 'raw_record'))?.retain_days, 90);
  assert.equal((await getRetentionPolicy(ctx, 'tool_call'))?.retain_days, 180);
  assert.equal((await getRetentionPolicy(ctx, 'audit_event'))?.retain_days, 730);
  assert.equal((await getRetentionPolicy(ctx, 'evidence'))?.retain_mode, 'follow_resource');
  const amazon = { data_class: 'store_pii_amazon', action: 'delete' };
  await commands.set_retention_policy.run(ctx, { ...amazon, retain_days: 15 });
  await commands.set_retention_policy.run(ctx, { ...amazon, workspace_id: 'default', retain_days: 10 });
  assert.equal((await getRetentionPolicy(ctx, 'store_pii_amazon'))?.retain_days, 10);
  assert.equal((await getRetentionPolicy(ctx, 'store_pii_amazon'))?.retain_anchor, 'order_delivered_at');
  await assert.rejects(commands.set_retention_policy.run(ctx, { ...amazon, retain_days: 20 }), { code: 'invalid_input' });
  await assert.rejects(commands.set_retention_policy.run(ctx, { ...amazon, retain_days: 5, legal_hold: true }), { code: 'invalid_input' });
  const raw = { data_class: 'raw_record', action: 'delete', retain_days: 10 };
  await commands.set_retention_policy.run(ctx, { ...raw, workspace_id: 'default', legal_hold: true });
  await commands.set_retention_policy.run(ctx, raw);
  assert.equal((await getRetentionPolicy(ctx, 'raw_record'))?.legal_hold, true);
});

test('usage tracks monthly gauge peaks with opening balance and deduplicates counter events', async () => {
  const ctx = fixture().context('alpha');
  ctx.now = '2026-10-30T12:00:00Z';
  await appendUsageEvent(ctx, 'brands', 3);
  await appendUsageEvent(ctx, 'model_tokens', 200);
  ctx.now = date;
  await appendUsageEvent(ctx, 'brands', 2);
  await appendUsageEvent(ctx, 'brands', -4);
  await appendUsageEvent(ctx, 'model_tokens', 100, 'job');
  await appendUsageEvent(ctx, 'model_tokens', 100, 'job');
  await assert.rejects(appendUsageEvent(ctx, 'model_tokens', 200, 'job'), { code: 'usage_source_mismatch' });
  assert.equal((await getUsage(ctx, 'brands')).quantity, 5);
  assert.equal((await getUsage(ctx, 'brands')).current, 1);
  assert.equal((await getUsage(ctx, 'model_tokens')).quantity, 100);
  await requireUsageCapacity(ctx, 'model_tokens', 100);
  ctx.opsUsageLimit = async () => 150;
  await assert.rejects(requireUsageCapacity(ctx, 'model_tokens', 51), { code: 'LICENSE_LIMIT' });
  await requireUsageCapacity(ctx, 'model_tokens', 50);
});
