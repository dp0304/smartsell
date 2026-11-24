import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATION_NOTICE_VERSION, Problem, RISK_TERMS_VERSION, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import '../planning/index.js';
import {
  channelLabel, channelLoginState, channelReadiness, channelSettingsOrDefault, effectiveMode, ensureChannelSettings,
} from './channel-settings.js';
import { defaultBrand, registerWorkerChannels } from './channel-registration.js';

/** In-memory Operations context with the workspace members a Worker registration checks. */
function memory(now = '2026-11-24T10:00:00.000Z') {
  const rows = new Map<string, Row[]>();
  let serial = 0;
  const events: { type: string; payload: Data }[] = [];
  const ctx: Context = {
    actorId: 'owner', role: 'owner', tenantId: 'tenant', workspaceId: 'workspace', now,
    list: (kind: string) => rows.get(kind) ?? [],
    get(kind: string, id: string) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${id}`);
      return row;
    },
    create(kind: string, data: Data) {
      const row = { ...structuredClone(data), id: `${kind}-${++serial}`, version: 1, created_at: ctx.now, updated_at: ctx.now } as Row;
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind: string, id: string, data: Data) {
      const row = ctx.get(kind, id);
      const updated = { ...row, ...structuredClone(data), id, version: row.version + 1, updated_at: ctx.now } as Row;
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? updated : item));
      return updated;
    },
    remove(kind: string, id: string) { rows.set(kind, ctx.list(kind).filter(row => row.id !== id)); },
    emit(type: string, payload: Data) { events.push({ type, payload }); },
  };
  Object.assign(ctx, { activeWorkspaceMembers: [{ userId: 'owner', role: 'owner' as Role }] });
  return { ctx, events };
}

function account(ctx: Context, provider: string, extra: Data = {}) {
  return ctx.create('social_account', { provider, status: 'active', brand_id: 'brand', external_account_id: provider === 'x' ? 'lurelab' : '7000000001', display_name: 'Lure Lab', ...extra });
}

test('ensureChannelSettings creates the §3.3 defaults per provider in the workspace time zone', () => {
  const { ctx, events } = memory();
  ctx.create('workspace', { name: 'Lure Lab', default_timezone: 'Asia/Shanghai' });
  const x = ensureChannelSettings(ctx, account(ctx, 'x').id);
  assert.deepEqual({ ...x, id: undefined, created_at: undefined, updated_at: undefined, chrome_profile_key: undefined }, {
    id: undefined, version: 1, created_at: undefined, updated_at: undefined, social_account_id: x.social_account_id,
    execution_mode: 'browser_auto', approval_mode: 'needs_approval', approval_mode_confirmed_at: null, automation_notice_ack: null, risk_ack: null,
    daily_cap: 10, window: null, timezone: 'Asia/Shanghai', lateness_limit_min: 30, caption_limit: null, chrome_profile_key: undefined,
    platform_defaults: { x: { reply_settings: 'everyone' } }, settings_generation: 1, approval_generation: 1,
  });
  assert.match(x.chrome_profile_key, /^ch-[0-9a-f]{12}$/);
  assert.equal(ensureChannelSettings(ctx, x.social_account_id).id, x.id, 'idempotent');
  const tiktok = ensureChannelSettings(ctx, account(ctx, 'tiktok').id, { profileKey: 'ch-worker0001' });
  assert.equal(tiktok.daily_cap, 3);
  assert.deepEqual(tiktok.platform_defaults, {});
  assert.equal(tiktok.chrome_profile_key, 'ch-worker0001');
  assert.equal(ensureChannelSettings(ctx, account(ctx, 'youtube').id).daily_cap, 3);
  assert.throws(() => ensureChannelSettings(ctx, account(ctx, 'douyin').id), (error: Problem) => error.code === 'CHANNEL_PROVIDER_UNSUPPORTED');
  assert.equal(events.filter(event => event.type === 'account.channel_settings.created').length, 3);
});

test('read paths get unsaved defaults instead of a write error', () => {
  const { ctx } = memory();
  const id = account(ctx, 'x').id;
  const readOnly = { ...ctx, create() { throw new Error('Write in read-only transaction'); } } as Context;
  const view = ensureChannelSettings(readOnly, id);
  assert.equal(view.id, '');
  assert.equal(view.version, 1, 'the first save sends If-Match: 1');
  assert.equal(ctx.list('channel_settings').length, 0);
  assert.deepEqual(channelSettingsOrDefault(ctx, id).platform_defaults, { x: { reply_settings: 'everyone' } });
});

test('effectiveMode reads execution_mode, the provider driver and the current risk terms', () => {
  const { ctx } = memory();
  const x = account(ctx, 'x');
  const settings = ensureChannelSettings(ctx, x.id);
  assert.equal(effectiveMode(ctx, x.id), 'assist', 'no risk acceptance');
  ctx.update('channel_settings', settings.id, { risk_ack: { at: ctx.now, by_user_id: 'owner', terms_version: RISK_TERMS_VERSION, text_sha256: 'x' } });
  assert.equal(effectiveMode(ctx, x.id), 'auto');
  ctx.update('channel_settings', settings.id, { risk_ack: { at: ctx.now, by_user_id: 'owner', terms_version: 'browser-automation-risk-2025-01', text_sha256: 'x' } });
  assert.equal(effectiveMode(ctx, x.id), 'assist', 'terms changed: the old acceptance no longer unlocks clicking');
  ctx.update('channel_settings', settings.id, { risk_ack: { at: ctx.now, by_user_id: 'owner', terms_version: RISK_TERMS_VERSION, text_sha256: 'x' }, execution_mode: 'browser_assist' });
  assert.equal(effectiveMode(ctx, x.id), 'assist');
  ctx.update('channel_settings', settings.id, { execution_mode: 'api' });
  assert.equal(effectiveMode(ctx, x.id), 'owner');
  assert.equal(effectiveMode(ctx, account(ctx, 'meta_instagram').id), 'owner', 'no driver in phase 1');
});

test('readiness, label and login state come from settings, session, machine presence and jobs', () => {
  const { ctx } = memory();
  const tiktok = account(ctx, 'tiktok', { handle: null, display_name: 'Lure Lab' });
  assert.equal(channelLabel(ctx, tiktok.id), 'TikTok Lure Lab');
  ctx.update('social_account', tiktok.id, { handle: 'lurelab' });
  assert.equal(channelLabel(ctx, tiktok.id), 'TikTok @lurelab');
  const settings = ensureChannelSettings(ctx, tiktok.id);
  assert.deepEqual(channelReadiness(ctx, tiktok.id), { logged_in: false, automation_notice: false, defaults_ready: false,
    approval_mode_chosen: false, risk_ack_or_assist: false, dry_run_passed: false });
  const device = ctx.create('connector_device', { name: 'win-c', status: 'active', last_seen_at: ctx.now });
  const binding = ctx.create('account_execution_binding', { social_account_id: tiktok.id, mode: 'connector', connector_channel: 'browser', device_id: device.id });
  const session = ctx.create('browser_session', { binding_id: binding.id, device_id: device.id, social_account_id: tiktok.id, status: 'verified', checked_at: ctx.now });
  ctx.update('channel_settings', settings.id, {
    automation_notice_ack: { at: ctx.now, via: 'web', by: 'owner', version: AUTOMATION_NOTICE_VERSION }, approval_mode_confirmed_at: ctx.now, execution_mode: 'browser_assist',
    platform_defaults: { tiktok: { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false } },
  });
  ctx.create('worker_job', { kind: 'publish_post', dry_run: true, status: 'succeeded', social_account_id: tiktok.id });
  assert.deepEqual(channelReadiness(ctx, tiktok.id), { logged_in: true, automation_notice: true, defaults_ready: true,
    approval_mode_chosen: true, risk_ack_or_assist: true, dry_run_passed: true });
  assert.equal(channelLoginState(ctx, tiktok.id).state, 'verified');
  const check = ctx.create('worker_job', { kind: 'check_login', status: 'claimed', social_account_id: tiktok.id });
  assert.equal(channelLoginState(ctx, tiktok.id).state, 'checking');
  ctx.update('worker_job', check.id, { status: 'succeeded' });
  ctx.update('browser_session', session.id, { status: 'challenge' });
  assert.equal(channelLoginState(ctx, tiktok.id).state, 'challenge');
  ctx.update('browser_session', session.id, { status: 'pending_identity' });
  assert.equal(channelLoginState(ctx, tiktok.id).state, 'unknown');
  ctx.update('connector_device', device.id, { last_seen_at: '2026-11-24T09:00:00.000Z' });
  ctx.update('browser_session', session.id, { status: 'verified' });
  assert.equal(channelLoginState(ctx, tiktok.id).state, 'unknown', 'an offline machine cannot vouch for its login');
});

// ---------- Worker App registration (§8.16 server side) ----------

function worker(now?: string) {
  const memo = memory(now);
  const { ctx } = memo;
  ctx.create('workspace', { name: 'Lure Lab 釣具', default_timezone: 'Asia/Shanghai' });
  const device = ctx.create('connector_device', { name: 'mac-b.local', status: 'active', owner_id: 'owner', allow_channel_registration: true, last_seen_at: ctx.now });
  const register = (...selections: Data[]) => registerWorkerChannels(ctx, device, { confirmed: true, selections });
  const social = (platform: string, external_id: string, extra: Data = {}) => ({ kind: 'social', platform, external_id, observed_at: ctx.now, ...extra });
  return { ...memo, device, register, social };
}
const code = (expected: string) => (error: Problem) => error.code === expected;

test('an X registration stores the lowercase handle as identity, the workspace zone and the Worker profile key', () => {
  const { ctx, register, social, events, device } = worker();
  assert.throws(() => register(social('x', 'not a handle')), code('INVALID_INPUT'));
  assert.throws(() => register(social('x', 'way_too_long_handle_x')), code('INVALID_INPUT'));
  assert.throws(() => register(social('x', 'lurelab', { handle: 'someone_else' })), code('INVALID_WORKER_CHANNEL_INPUT'));
  assert.throws(() => register(social('x', 'lurelab', { profile_key: 'UPPER' })), code('INVALID_INPUT'));
  assert.throws(() => register(social('x', 'lurelab', { automation_notice_version: 'automation-notice-2025-01' })), code('AUTOMATION_NOTICE_OUTDATED'));
  const [entry] = register(social('x', '@LureLab', { profile_key: 'ch-1a2b3c4d5e6f', automation_notice_version: AUTOMATION_NOTICE_VERSION, portal_url: 'https://x.com/home' })).registrations;
  const row = ctx.get('social_account', entry.resource_id);
  assert.deepEqual({ external_account_id: row.external_account_id, handle: row.handle, display_name: row.display_name, default_timezone: row.default_timezone },
    { external_account_id: 'lurelab', handle: 'lurelab', display_name: '@lurelab', default_timezone: 'Asia/Shanghai' });
  assert.equal(entry.profile_key, 'ch-1a2b3c4d5e6f');
  const settings = ensureChannelSettings(ctx, row.id);
  assert.equal(settings.timezone, 'Asia/Shanghai');
  assert.deepEqual(settings.automation_notice_ack, { at: ctx.now, via: 'worker_app', by: `device:${device.id}`, version: AUTOMATION_NOTICE_VERSION });
  assert.ok(events.some(event => event.type === 'account.automation_notice.acked'));
  const [session] = ctx.list('browser_session');
  assert.deepEqual({ status: session.status, observed_identity: session.observed_identity, observed_handle: session.observed_handle }, { status: 'verified', observed_identity: 'lurelab', observed_handle: 'lurelab' });
  // The profile key is fixed after creation: a later registration returns the hub's key.
  assert.equal(register(social('x', 'lurelab', { profile_key: 'ch-ffffffffffff' })).registrations[0].profile_key, 'ch-1a2b3c4d5e6f');
  assert.equal(ctx.list('social_account').length, 1);
});

test('a TikTok registration writes the display handle and keeps the numeric ID as identity', () => {
  const { ctx, register, social } = worker();
  const [entry] = register(social('tiktok', '7000000001', { handle: '@Lure.Lab_TV', display_name: 'Lure Lab' })).registrations;
  const row = ctx.get('social_account', entry.resource_id);
  assert.deepEqual({ external_account_id: row.external_account_id, handle: row.handle }, { external_account_id: '7000000001', handle: 'lure.lab_tv' });
  assert.equal(ensureChannelSettings(ctx, row.id).automation_notice_ack, null, 'no notice version sent: the web acknowledgement is still needed');
  register(social('tiktok', '7000000001', { handle: 'lurelab_new' }));
  assert.equal(ctx.get('social_account', row.id).handle, 'lurelab_new');
});

test('Worker channels go into the default brand, which gets a worker_channel_scope', () => {
  const empty = worker();
  const [first] = empty.register(empty.social('x', 'lurelab')).registrations;
  const [brand] = empty.ctx.list('brand');
  assert.deepEqual({ name: brand.name, slug: brand.slug }, { name: 'Lure Lab 釣具', slug: 'lure-lab' });
  assert.equal(empty.ctx.get('social_account', first.resource_id).brand_id, brand.id);
  assert.deepEqual(empty.ctx.list('worker_channel_scope').map(row => row.brand_id), [brand.id]);
  const existing = worker();
  const archived = existing.ctx.create('brand', { name: 'Old', slug: 'old', status: 'archived' });
  const main = existing.ctx.create('brand', { name: 'Main', slug: 'main', status: 'active' });
  existing.ctx.create('brand', { name: 'Second', slug: 'second', status: 'active' });
  existing.ctx.create('worker_channel_scope', { brand_id: archived.id });
  assert.equal(defaultBrand(existing.ctx), main.id, 'a scope on an archived brand is not reused');
  assert.deepEqual(existing.ctx.list('worker_channel_scope').map(row => row.brand_id), [archived.id, main.id]);
  assert.equal(defaultBrand(existing.ctx), main.id);
  assert.equal(existing.ctx.list('worker_channel_scope').length, 2);
  const [entry] = existing.register(existing.social('tiktok', '7000000002')).registrations;
  assert.equal(existing.ctx.get('social_account', entry.resource_id).brand_id, main.id);
});

test('a channel whose session needs sign-in again can be registered again and returns to verified', () => {
  for (const status of ['login_required', 'challenge', 'identity_mismatch']) {
    const { ctx, register, social } = worker();
    register(social('x', 'lurelab'));
    const [session] = ctx.list('browser_session');
    ctx.update('browser_session', session.id, { status });
    register(social('x', 'lurelab'));
    assert.equal(ctx.get('browser_session', session.id).status, 'verified', status);
  }
  const { ctx, register, social } = worker();
  register(social('x', 'lurelab'));
  const [session] = ctx.list('browser_session');
  ctx.update('browser_session', session.id, { status: 'suspended' });
  assert.throws(() => register(social('x', 'lurelab')), code('WORKER_CHANNEL_SESSION_UNAVAILABLE'));
});
