import assert from 'node:assert/strict';
import test from 'node:test';
import { type Context, type Data, type Row } from '../../../contracts/src/module.js';
import { assessTarget, hasExecutionRisk, onRevisionCreated, taskFor } from './index.js';

function fixture() {
  const now = '2026-06-01T12:00:00.000Z';
  const records = new Map<string, Row[]>();
  let serial = 0;
  const ctx: Context = {
    now, role: 'owner', actorId: 'actor', workspaceId: 'workspace', tenantId: 'tenant',
    list(kind) { return records.get(kind) ?? []; },
    get(kind, id) { return this.list(kind).find(row => row.id === id)!; },
    create(kind, fields) {
      const row = { ...fields, id: String(++serial), version: 1, created_at: now, updated_at: now };
      records.set(kind, [...this.list(kind), row]);
      return row;
    },
    update(kind, id, fields) {
      const current = this.get(kind, id);
      const row = { ...current, ...fields, id, version: current.version + 1 };
      records.set(kind, this.list(kind).map(value => value.id === id ? row : value));
      return row;
    },
    remove(kind, id) { records.set(kind, this.list(kind).filter(row => row.id !== id)); },
    emit() {},
  };
  const item = ctx.create('content_item', { brand_id: 'brand' });
  const account = ctx.create('social_account', { provider: 'instagram', status: 'active', brand_id: 'brand' });
  const variant = ctx.create('content_variant', { content_item_id: item.id, platform: 'instagram' });
  const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'immutable', rendered: { text: 'Hello' } });
  ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
  const target: Data = { brand_id: 'brand', content_item_id: item.id, social_account_id: account.id, content_variant_id: variant.id, variant_revision_id: revision.id, scheduled_at: now, content_format: 'text', operation: 'publish' };
  return { ctx, account, variant, revision, target };
}

test('precheck honors the account connection expiry even if an API capability remains available', () => {
  const { ctx, account, target } = fixture();
  const connection = ctx.create('connection', { status: 'active', provider: 'instagram', expires_at: ctx.now });
  ctx.create('capability', { social_account_id: account.id, connection_id: connection.id, operation: 'publish', content_format: 'text', status: 'available', executors: ['api'] });
  assert.equal(assessTarget(ctx, target, 'schedule').items.find(item => item.check_key === 'account_connection')?.severity, 'blocker');
  ctx.update('connection', connection.id, { expires_at: '2026-06-01T12:05:00.000Z' });
  assert.equal(assessTarget(ctx, target, 'schedule').valid_until, '2026-06-01T12:05:00.000Z');
});

test('precheck recognizes that fresh inventory may carry over an expired price observation', () => {
  const { ctx, target, revision } = fixture();
  const store = ctx.create('store', { connection_id: 'catalog-connection', status: 'active' });
  const variant = ctx.create('product_variant', { store_id: store.id });
  ctx.create('store_market', { store_id: store.id, market_id: 'market', channel: 'shop', snapshot_ttl_minutes: 30, enabled: true });
  const values = { variant_id: variant.id, market_id: 'market', channel: 'shop', currency: 'JPY', price_amount_minor: 200, availability: 'observed', price_observed_at: '2026-06-01T10:00:00.000Z' };
  const baseline = ctx.create('listing_snapshot', { ...values, is_current: false, observed_at: '2026-06-01T10:00:00.000Z' });
  ctx.create('listing_snapshot', { ...values, is_current: true, observed_at: ctx.now });
  ctx.update('content_revision', revision.id, { product_refs: [{ variant_id: variant.id, listing_snapshot_id: baseline.id, field: 'price', market_id: 'market', currency: 'JPY' }] });
  assert.equal(assessTarget(ctx, target, 'schedule').items.find(item => item.check_key === 'product_fact')?.severity, 'risk');
  assert.equal(assessTarget(ctx, target, 'execution').items.find(item => item.check_key === 'product_fact')?.severity, 'blocker');
});

test('approval hashes bind immutable revision IDs and selected drafts do not follow later revisions', () => {
  const { ctx, target, variant, revision } = fixture();
  const explicit = ctx.create('publish_target', { ...target, plan_status: 'draft', follow_latest_revision: false });
  const automatic = ctx.create('publish_target', { ...target, plan_status: 'draft' });
  const next = ctx.create('content_revision', { variant_id: variant.id, content_hash: revision.content_hash, rendered: revision.rendered });
  onRevisionCreated(ctx, variant, next);
  assert.equal(ctx.get('publish_target', explicit.id).variant_revision_id, revision.id);
  assert.equal(ctx.get('publish_target', automatic.id).variant_revision_id, next.id);
  assert.notEqual(assessTarget(ctx, target, 'schedule').hash, assessTarget(ctx, { ...target, variant_revision_id: next.id }, 'schedule').hash);
});

test('precheck uses account-configured daily windows and respects an operations halt', () => {
  const { ctx, account, target } = fixture();
  const device = ctx.create('connector_device', { status: 'active', last_seen_at: ctx.now });
  const binding = ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', connector_mode: 'auto', device_id: device.id, auto_ack_by: 'actor', auto_ack_at: ctx.now, auto_ack_terms_version: '1', daily_cap: 5, allowed_windows: [{ start: '11:00', end: '13:00' }] });
  ctx.create('capability', { social_account_id: account.id, operation: 'publish', content_format: 'text', status: 'available', executor: 'connector', connector_channel: 'browser' });
  ctx.create('browser_session', { binding_id: binding.id, device_id: device.id, social_account_id: account.id, status: 'verified' });
  assert.equal(assessTarget(ctx, target, 'schedule').effective_mode, 'auto');
  ctx.create('connector_auto_policy', { ops_halt_rule_ids: ['halt'] });
  assert.equal(assessTarget(ctx, target, 'schedule').effective_mode, 'assist');
  assert.equal(ctx.get('account_execution_binding', binding.id).connector_mode, 'auto');
});

test('a scheduled promotion may be bound only within its effective window', () => {
  const { ctx, target } = fixture();
  const promotion = ctx.create('promotion', { state: 'scheduled', valid_from: '2026-06-02T10:00:00.000Z', valid_until: '2026-06-03T10:00:00.000Z' });
  const plan = { ...target, promotion_ids: [promotion.id] };
  assert.ok(assessTarget(ctx, plan, 'schedule').items.some(item => item.check_key === 'promotion_validity'));
  const inWindow = assessTarget(ctx, { ...plan, scheduled_at: '2026-06-02T10:00:00.000Z' }, 'schedule');
  assert.ok(inWindow.payload.refs.some(ref => ref.ref_id === promotion.id));
  assert.ok(assessTarget(ctx, { ...plan, scheduled_at: promotion.valid_until }, 'schedule').items.some(item => item.check_key === 'promotion_validity'));
});

test('story tasks retain their execution fence and cannot be mistaken for post-management tasks', () => {
  const { ctx } = fixture();
  const target = ctx.create('publish_target', {});
  const edit = ctx.create('execution_task', { publish_target_id: target.id, operation: 'edit', status: 'published' });
  const story = ctx.create('execution_task', { publish_target_id: target.id, operation: 'publish_story', status: 'blocked' });
  assert.equal(taskFor(ctx, { ...target, execution_task_id: edit.id })?.id, story.id);
  assert.equal(hasExecutionRisk(ctx, target), false);
  ctx.create('execution_attempt', { task_id: story.id, status: 'outcome_unknown' });
  assert.equal(hasExecutionRisk(ctx, target), true);
});
