import assert from 'node:assert/strict';
import test from 'node:test';
import { type Context, type Data, type Row } from '../../../contracts/src/module.js';
import { AUTOMATION_NOTICE_VERSION, RISK_TERMS_VERSION, type ChannelSettingsRecord } from '../../../contracts/src/phase1.js';
import {
  approvalValid, assessTarget, channelDayUsage, channelEffectiveMode, channelMediaRule, channelVideoLimits, deviceOnline, hasExecutionRisk, inPublishWindow,
  onRevisionCreated, taskFor,
} from './index.js';

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

// ---------- Phase 1 channels (phase1-design §4.4, S2) ----------

const later = '2026-06-02T09:00:00.000Z';
function channelFixture(provider: 'x' | 'tiktok' | 'youtube' = 'x', overrides: Partial<ChannelSettingsRecord> = {}) {
  const { ctx } = fixture();
  const device = ctx.create('connector_device', { name: 'mac-b.local', display_name: 'Mac-B', status: 'active', last_seen_at: ctx.now });
  const account = ctx.create('social_account', { provider, status: 'active', brand_id: 'brand', handle: 'lurelab', external_account_id: provider === 'x' ? 'lurelab' : '7000000001' });
  const binding = ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: device.id, connector_mode: 'assist' });
  const session = ctx.create('browser_session', { binding_id: binding.id, device_id: device.id, social_account_id: account.id, status: 'verified' });
  const settings = ctx.create('channel_settings', {
    social_account_id: account.id, execution_mode: 'browser_auto', approval_mode: 'direct', approval_mode_confirmed_at: ctx.now,
    automation_notice_ack: { at: ctx.now, via: 'worker_app', by: `device:${device.id}`, version: AUTOMATION_NOTICE_VERSION },
    risk_ack: { at: ctx.now, by_user_id: 'actor', terms_version: RISK_TERMS_VERSION, text_sha256: 'f'.repeat(64) },
    daily_cap: 10, window: null, timezone: 'UTC', lateness_limit_min: 30, caption_limit: null, chrome_profile_key: 'ch-0123456789ab',
    platform_defaults: {}, settings_generation: 1, approval_generation: 1, ...overrides,
  });
  const item = ctx.create('content_item', { brand_id: 'brand' });
  const variant = ctx.create('content_variant', { content_item_id: item.id, platform: provider, format: 'short_video' });
  const file = ctx.create('file_object', { sha256: 'a'.repeat(64), scan_status: 'skipped', mime_type: 'video/mp4', byte_size: 31_000_000 });
  const asset = ctx.create('asset', { kind: 'video', brand_id: null, ownership: 'owned', status: 'ready' });
  // A probed 1080x1920, 30 s clip: E44 checks the platform's video limits from this meta (no meta is an E3 risk).
  const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, sha256: 'a'.repeat(64), mime_type: 'video/mp4',
    meta: { duration_ms: 30_000, width: 1080, height: 1920 } });
  const tiktok = { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false };
  const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'clip', rendered: { text: 'New lure test' },
    media: [{ asset_id: asset.id, asset_version_id: version.id, role: 'primary' }], settings: { platform_options: provider === 'tiktok' ? { tiktok } : {} } });
  ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
  const target: Data = { brand_id: 'brand', content_item_id: item.id, social_account_id: account.id, content_variant_id: variant.id,
    variant_revision_id: revision.id, scheduled_at: later, schedule_tz: 'UTC', content_format: 'short', operation: 'publish' };
  const keys = (stage: 'schedule' | 'approval' | 'preflight' | 'execution' = 'schedule', at: Data = target) =>
    Object.fromEntries(assessTarget(ctx, at, stage).items.map(row => [row.check_key, row.severity]));
  return { ctx, device, account, binding, session, settings, item, variant, file, asset, version, revision, target, keys };
}

test('effectiveMode follows the §3.3 truth table, including a risk acceptance for outdated terms', () => {
  const current = { at: '2026-01-01T00:00:00Z', by_user_id: 'u', terms_version: RISK_TERMS_VERSION, text_sha256: 'x' };
  const outdated = { ...current, terms_version: 'browser-automation-risk-2026-01' };
  const cases: [string, ChannelSettingsRecord['execution_mode'], ChannelSettingsRecord['risk_ack'], string][] = [
    ['x', 'api', current, 'owner'], ['youtube', 'browser_auto', current, 'owner'], ['meta_instagram', 'browser_assist', null, 'owner'],
    ['x', 'browser_assist', current, 'assist'], ['tiktok', 'browser_auto', null, 'assist'], ['x', 'browser_auto', outdated, 'assist'],
    ['x', 'browser_auto', current, 'auto'], ['tiktok', 'browser_auto', current, 'auto'],
  ];
  for (const [provider, execution_mode, risk_ack, expected] of cases) {
    assert.equal(channelEffectiveMode(provider, { execution_mode, risk_ack }), expected, `${provider} ${execution_mode} ${risk_ack?.terms_version ?? 'none'}`);
  }
});

test('a channel account takes the Worker route and skips capability, connector and session checks', () => {
  const { ctx, target, keys, session } = channelFixture('x');
  const assessment = assessTarget(ctx, target, 'schedule');
  assert.equal(assessment.route, 'worker');
  assert.equal(assessment.effective_mode, 'auto');
  assert.equal(assessment.overall, 'pass');
  for (const legacy of ['capability', 'connector_mode', 'device_online', 'session_identity', 'account_connection', 'rights']) assert.equal(keys()[legacy], undefined, legacy);
  assert.equal(keys().automation_mode, 'info');
  ctx.update('browser_session', session.id, { status: 'login_required' });
  assert.equal(keys().login_state, 'risk');
});

test('owned and brandless media skip the rights and brand checks; foreign-brand media still block', () => {
  const { ctx, asset, target, keys } = channelFixture('x');
  assert.equal(keys().media_spec, undefined);
  assert.equal(keys().rights, undefined);
  ctx.update('asset', asset.id, { ownership: undefined, brand_id: null });
  assert.equal(keys().rights, undefined);
  assert.equal(keys().media_spec, undefined);
  ctx.update('asset', asset.id, { ownership: undefined, brand_id: 'other-brand' });
  assert.equal(keys().media_spec, 'blocker');
  ctx.update('asset', asset.id, { ownership: undefined, brand_id: 'brand' });
  assert.equal(keys().rights, 'blocker', 'a brand asset without a grant still needs rights');
  assert.ok(assessTarget(ctx, target, 'schedule').payload.media_bindings.length === 1);
});

test('media still uploading is a risk at schedule and approval and a blocker at execution; failed media always block', () => {
  const { ctx, asset, version, target, keys } = channelFixture('tiktok');
  const hash = assessTarget(ctx, target, 'schedule').hash;
  ctx.update('asset', asset.id, { status: 'uploading' });
  ctx.update('asset_version', version.id, { file_object_id: null });
  assert.equal(keys('schedule').media_spec, 'risk');
  assert.equal(keys('approval').media_spec, 'risk');
  assert.equal(keys('execution', { ...target, scheduled_at: ctx.now }).media_spec, 'blocker');
  assert.equal(assessTarget(ctx, target, 'schedule').hash, hash, 'the declared SHA-256 keeps the frozen hash stable while uploading');
  ctx.update('asset', asset.id, { status: 'processing' });
  assert.equal(keys('schedule').media_spec, 'risk');
  ctx.update('asset', asset.id, { status: 'failed' });
  assert.equal(keys('schedule').media_spec, 'blocker');
});

test('media_kind: X takes one video or one to four images; TikTok takes exactly one video', () => {
  assert.equal(channelMediaRule('x', ['video']), null);
  assert.equal(channelMediaRule('x', ['image', 'image', 'image', 'image']), null);
  assert.notEqual(channelMediaRule('x', ['image', 'image', 'image', 'image', 'image']), null);
  assert.notEqual(channelMediaRule('x', ['video', 'image']), null);
  assert.notEqual(channelMediaRule('x', ['video', 'video']), null);
  assert.equal(channelMediaRule('tiktok', ['video']), null);
  assert.notEqual(channelMediaRule('tiktok', ['image']), null);
  assert.notEqual(channelMediaRule('tiktok', ['video', 'video']), null);
  assert.equal(channelMediaRule('youtube', ['video', 'image']), null);
  const { ctx, revision, version, asset, keys } = channelFixture('tiktok');
  assert.equal(keys().media_kind, undefined);
  ctx.update('content_revision', revision.id, { media: [{ asset_id: asset.id, asset_version_id: version.id, role: 'primary' }, { asset_id: asset.id, asset_version_id: version.id, role: 'primary' }] });
  assert.equal(keys().media_kind, 'blocker');
});

test('channel_defaults reads the TikTok options on the bound revision, not the account defaults', () => {
  const { ctx, settings, revision, keys } = channelFixture('tiktok');
  assert.equal(keys().channel_defaults, undefined);
  ctx.update('content_revision', revision.id, { settings: { platform_options: { tiktok: { allow_comment: false, allow_duet: false, allow_stitch: false } } } });
  ctx.update('channel_settings', settings.id, { platform_defaults: { tiktok: { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: true, allow_stitch: true, commercial_disclosure: 'none', ai_generated: false } } });
  assert.equal(keys().channel_defaults, 'blocker');
  const item = assessTarget(ctx, channelFixture('tiktok').target, 'schedule');
  assert.equal(item.items.some(row => row.check_key === 'caption_rules'), false, 'the legacy option rule is replaced');
});

test('daily_cap counts ready and published posts on the channel-local day, never the target itself', () => {
  const { ctx, account, target, keys } = channelFixture('x', { daily_cap: 2, timezone: 'Asia/Shanghai' });
  const self = ctx.create('publish_target', { ...target, plan_status: 'ready' });
  const at = (iso: string) => ({ ...target, social_account_id: account.id, scheduled_at: iso });
  assert.equal(keys('schedule', { ...self }).daily_cap, undefined);
  ctx.create('publish_target', { ...at('2026-06-02T02:00:00.000Z'), plan_status: 'ready' });
  assert.equal(keys('schedule', { ...self }).daily_cap, undefined, 'one other plus itself fits a cap of two');
  const published = ctx.create('publish_target', { ...at('2026-06-01T23:00:00.000Z'), plan_status: 'closed', close_reason: 'published' });
  ctx.create('platform_post', { social_account_id: account.id, publish_target_id: published.id, verification: 'system_verified', published_at: '2026-06-01T23:30:00.000Z' });
  ctx.create('publish_target', { ...at('2026-06-02T03:00:00.000Z'), plan_status: 'awaiting_approval' });
  ctx.create('publish_target', { ...at('2026-06-02T17:00:00.000Z'), plan_status: 'ready' });   // next Shanghai day
  assert.equal(channelDayUsage(ctx, account.id, later, 'Asia/Shanghai', self.id), 2);
  assert.equal(keys('schedule', { ...self }).daily_cap, 'blocker');
});

test('publish_window, machine checks and the automation notice gate the Worker route', () => {
  const { ctx, settings, device, target, keys, binding } = channelFixture('x');
  ctx.update('channel_settings', settings.id, { window: { start: '22:00', end: '02:00', days: [1] } });
  assert.equal(keys().publish_window, 'blocker');   // 2026-06-02 09:00 UTC is a Tuesday morning
  assert.equal(inPublishWindow({ start: '22:00', end: '02:00', days: [1] }, '2026-06-02T01:30:00.000Z', 'UTC'), true, 'Monday night window spills into Tuesday');
  assert.equal(inPublishWindow({ start: '08:00', end: '10:00', days: [2] }, later, 'UTC'), true);
  ctx.update('channel_settings', settings.id, { window: null, automation_notice_ack: null });
  assert.equal(keys().automation_notice, 'blocker');
  ctx.update('channel_settings', settings.id, { automation_notice_ack: { at: ctx.now, via: 'web', by: 'actor', version: 'automation-notice-2025-01' } });
  assert.equal(keys().automation_notice, 'blocker');
  ctx.update('connector_device', device.id, { last_seen_at: '2026-06-01T11:00:00.000Z' });
  assert.equal(keys('schedule').machine_online, 'risk');
  assert.equal(keys('approval').machine_online, 'risk');
  assert.equal(keys('execution', { ...target, scheduled_at: ctx.now }).machine_online, undefined, 'lateness covers offline machines at execution');
  const presence = Object.assign(Object.create(ctx), { presence: () => ({ last_seen_at: ctx.now }) }) as Context;
  assert.equal(deviceOnline(presence, ctx.get('connector_device', device.id)), true, 'in-memory presence wins over the stored row (C14)');
  ctx.update('connector_device', device.id, { paused: true });
  assert.equal(keys().machine_paused, 'blocker');
  ctx.update('account_execution_binding', binding.id, { device_id: 'missing' });
  assert.equal(keys().machine_binding, 'blocker');
});

test('X captions use the weighted length: CJK counts 2 and each URL 23, with caption_limit overriding 280', () => {
  const { ctx, revision, settings, keys } = channelFixture('x');
  const caption = (text: string) => { ctx.update('content_revision', revision.id, { rendered: { text } }); return keys().caption_rules; };
  assert.equal(caption('中'.repeat(140)), undefined, '140 CJK characters weigh exactly 280');
  assert.equal(caption('中'.repeat(141)), 'blocker');
  const url = `https://example.com/${'p'.repeat(200)}`;
  assert.equal(caption(`${'a'.repeat(256)} ${url}`), undefined, '256 + 1 space + 23 for the URL = 280');
  assert.equal(caption(`${'a'.repeat(257)} ${url}`), 'blocker');
  ctx.update('channel_settings', settings.id, { caption_limit: 25_000 });
  assert.equal(caption('中'.repeat(141)), undefined, 'X Premium raises the limit through caption_limit');
});

test('an empty caption is allowed for video posts and a non-driver platform falls back to the owner', () => {
  const { ctx, revision, keys, target } = channelFixture('youtube');
  ctx.update('content_revision', revision.id, { rendered: { text: '' } });
  const assessment = assessTarget(ctx, target, 'schedule');
  assert.equal(assessment.route, 'manual');
  assert.equal(assessment.effective_mode, 'owner');
  assert.equal(keys().driver_unavailable, 'risk');
  assert.equal(keys().caption_rules, undefined);
  assert.equal(keys().machine_binding, undefined);
});

test('a channel-policy approval is valid only while the channel stays direct at the same approval generation', () => {
  const { ctx, settings, target } = channelFixture('x');
  const row = ctx.create('publish_target', { ...target, plan_status: 'ready' });
  const hash = assessTarget(ctx, row, 'schedule').hash;
  const request = ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: row.id, resource_hash: hash, status: 'approved', approved_via: 'channel_policy', channel_approval_generation: 1 });
  const bound = ctx.update('publish_target', row.id, { frozen_hash: hash, approval_request_id: request.id });
  assert.equal(approvalValid(ctx, bound, hash), true);
  ctx.update('channel_settings', settings.id, { approval_generation: 2 });
  assert.equal(approvalValid(ctx, bound, hash), false);
  ctx.update('channel_settings', settings.id, { approval_generation: 1, approval_mode: 'needs_approval' });
  assert.equal(approvalValid(ctx, bound, hash), false);
  ctx.update('channel_settings', settings.id, { approval_mode: 'direct' });
  assert.equal(approvalValid(ctx, bound, hash), true);
  ctx.update('approval_request', request.id, { approved_via: 'human', channel_approval_generation: null });
  ctx.update('channel_settings', settings.id, { approval_mode: 'needs_approval', approval_generation: 7 });
  assert.equal(approvalValid(ctx, bound, hash), true, 'a person\'s approval does not depend on the channel policy');
});

// ---------- Wave 6 (G2): E44 video limits, E37 rejection, E35 pause wording ----------

test('E44: X and TikTok video limits block only when the probed file is certainly over; unknown length is an E3 risk', () => {
  const MiB = 1024 * 1024;
  const GiB = 1024 * MiB;
  const media = (provider: 'x' | 'tiktok', meta: Data | null, bytes = 31_000_000, overrides: Partial<ChannelSettingsRecord> = {}) => {
    const world = channelFixture(provider, overrides);
    world.ctx.update('asset_version', world.version.id, { meta });
    world.ctx.update('file_object', world.file.id, { byte_size: bytes });
    const item = assessTarget(world.ctx, world.target, 'schedule').items.find(row => row.check_key === 'media_spec');
    return item ? [item.severity, item.message] : undefined;
  };
  // The reviewer's case: 15 minutes, 4 GB, 3840x400 to a standard X account.
  const oversized = media('x', { duration_ms: 900_000, width: 3840, height: 400 }, 4 * GiB);
  assert.equal(oversized?.[0], 'blocker');
  assert.match(String(oversized?.[1]), /^影片長 15:00，超過 X 非 Premium 帳號的 2 分 20 秒上限，這則發不出去。/);
  assert.match(String(oversized?.[1]), /文案上限設為 25,000/, 'tells a Premium owner how to lift the limit');
  assert.equal(media('x', { duration_ms: 140_400, width: 1080, height: 1920 }), undefined, '2:20 with container rounding still fits');
  assert.equal(media('x', { duration_ms: 142_000, width: 1080, height: 1920 })?.[0], 'blocker');
  assert.match(String(media('x', { duration_ms: 60_000, width: 1080, height: 1920 }, 600 * MiB)?.[1]), /^影片檔 600 MB，超過 X 非 Premium 帳號的 512 MB 上限/);
  assert.equal(media('x', { duration_ms: 60_000, width: 1080, height: 1920 }, 512 * MiB), undefined, '512 MB exactly is allowed');
  // X Premium (E7: caption_limit 25,000): under 4 hours and 16 GB.
  assert.equal(media('x', { duration_ms: 900_000, width: 1080, height: 1920 }, 4 * GiB, { caption_limit: 25_000 }), undefined);
  assert.equal(media('x', { duration_ms: 5 * 3_600_000, width: 1080, height: 1920 }, 4 * GiB, { caption_limit: 25_000 })?.[0], 'blocker');
  assert.equal(media('x', { duration_ms: 60_000, width: 1080, height: 1920 }, 17 * GiB, { caption_limit: 25_000 })?.[0], 'blocker');
  // TikTok Studio web upload: up to 30 minutes and less than 10 GB.
  assert.equal(media('tiktok', { duration_ms: 20 * 60_000, width: 1080, height: 1920 }, 2 * GiB), undefined);
  assert.match(String(media('tiktok', { duration_ms: 31 * 60_000, width: 1080, height: 1920 })?.[1]), /^影片長 31:00，超過 TikTok 網頁上傳的 30 分鐘上限，這則發不出去。請剪短後重新上傳。$/);
  assert.equal(media('tiktok', { duration_ms: 60_000, width: 1080, height: 1920 }, 11 * GiB)?.[0], 'blocker');
  // E3: no probed length → a risk, never a blocker; X's stated aspect range is a risk too, not a certain rejection.
  assert.deepEqual(media('tiktok', null), ['risk', '未取得影片長度與尺寸，無法在排程時檢查平台的影片限制']);
  assert.equal(media('x', { duration_ms: 60_000, width: 3840, height: 400 })?.[0], 'risk');
  assert.deepEqual([channelVideoLimits('youtube', { caption_limit: null }), channelVideoLimits('x', { caption_limit: 280 })?.tier], [null, 'standard']);
});

test('E37: a new revision leaves a rejected (changes_requested) target as the owner left it', () => {
  const { ctx, target, variant, revision } = channelFixture('x');
  const row = ctx.create('publish_target', { ...target, plan_status: 'changes_requested' });
  const request = ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: row.id, resource_hash: 'h', status: 'rejected' });
  ctx.update('publish_target', row.id, { approval_request_id: request.id });
  const edited = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'edited', rendered: { text: 'Edited' }, media: revision.media });
  onRevisionCreated(ctx, ctx.update('content_variant', variant.id, { current_revision_id: edited.id }), edited);
  assert.equal(ctx.get('publish_target', row.id).plan_status, 'changes_requested', 'not awaiting_approval without a request');
  assert.equal(ctx.get('approval_request', request.id).status, 'rejected');
});

test('E35: a hub channel post held by a pause says so in zh-Hant; a paused machine uses the Appendix C.2 wording', () => {
  const { ctx, account, device, keys, target } = channelFixture('x');
  ctx.create('pause_switch', { scope_type: 'social_account', scope_id: account.id, reason: 'Owner on holiday' });
  const pause = assessTarget(ctx, target, 'schedule').items.find(row => row.check_key === 'pause_switch');
  assert.deepEqual([pause?.severity, pause?.message], ['blocker', '已暫停：恢復前不會發出']);
  ctx.update('connector_device', device.id, { paused: true });
  assert.equal(keys().machine_paused, 'blocker');
  assert.equal(assessTarget(ctx, target, 'schedule').items.find(row => row.check_key === 'machine_paused')?.message, 'Mac-B 已暫停，這則不會發出，直到你恢復機器。');
});
