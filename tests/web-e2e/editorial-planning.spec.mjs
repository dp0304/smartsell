import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

async function fixture(dev, request) {
  const setup = await request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { name: 'Planning Owner', email: 'planning-owner@example.test', workspaceName: 'Planning acceptance', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { workspaces: [{ id }] } = await setup.json();
  const { csrf_token } = await (await request.get(`${dev.origin}/api/v1/session/csrf`)).json();
  async function call(method, path, data, status = 200) {
    const response = await request.fetch(`${dev.origin}/api/v1/workspaces/${id}${path}`, { method, data,
      headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID() } });
    expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
    const json = await response.json();
    return status === 200 ? json.data : json;
  }
  const post = (path, data, status) => call('POST', path, data, status);
  const get = path => call('GET', path);
  function seed(update) {
    dev.updateSnapshot(state => {
      const records = new Map(state.records);
      const put = (kind, data, id = randomUUID()) => {
        const entityId = `row/${kind}/${encodeURIComponent(id)}`;
        const key = JSON.stringify(['operation_runtime', 'record', entityId]);
        const previous = records.get(key);
        const now = new Date().toISOString();
        records.set(key, { module: 'operation_runtime', kind: 'record', id: entityId, created_at: now, updated_at: now, version: 1, ...previous, data: { value: JSON.stringify({ id, version: 1, created_at: now, updated_at: now,
          ...(previous && JSON.parse(previous.data.value)), ...data }) } });
        return id;
      };
      update(put);
      state.records = [...records];
    });
  }
  const brand = await post('/brands', { name: 'Planning brand', slug: 'planning-acceptance' });
  const account = await post('/social-accounts', { brand_id: brand.id, provider: 'meta_facebook', external_account_id: '1234', display_name: 'Fixture page', owned_account_confirmed: true });
  const { variants: [draft] } = await post('/content-items', { brand_id: brand.id, title: 'Planning acceptance', variants: [{ platform: 'facebook', format: 'text', locale: 'en', body_markdown: 'Editorial caption' }] });
  const { variant, revision } = await post(`/content-variants/${draft.id}/revisions`, { base_revision_id: null });
  const scheduled_at = new Date(Date.now() + 3_600_000).toISOString();
  const target = () => post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id, variant_revision_id: revision.id, scheduled_at, schedule_tz: 'UTC' });
  return { post, get, seed, target, account, brand, revision };
}

test('PL04 | Formal HTTP precheck fences expiry, catalog drift and unverified phones', async ({ dev, request }) => {
  const { post, seed, target, account, brand, revision } = await fixture(dev, request);
  const plan = await target();
  const path = `/publish-targets/${plan.id}/precheck`;
  const check = (stage = 'preflight') => post(path, { stage });
  const issue = (result, key) => result.items.find(row => row.check_key === key);
  expect(await check()).toMatchObject({ stage: 'preflight', route: 'manual' });
  let connection, binding, phone, phoneBinding, baseline, variant;
  seed(put => {
    connection = put('connection', { provider: account.provider, brand_id: brand.id, purpose: 'social', status: 'active', expires_at: new Date(Date.now() + 60_000).toISOString() });
    put('capability', { social_account_id: account.id, connection_id: connection, operation: 'publish', content_format: 'text', status: 'available', executor: 'api' });
  });
  const authorized = await check();
  expect(authorized.route).toBe('api');
  expect(issue(authorized, 'account_connection')).toBeUndefined();
  expect(Date.parse(authorized.valid_until) - Date.now()).toBeLessThanOrEqual(60_000);
  seed(put => put('connection', { expires_at: new Date(Date.now() - 60_000).toISOString() }, connection));
  for (const stage of ['preflight', 'execution']) {
    const expired = await check(stage);
    expect(expired.overall).toBe('blocked');
    expect(issue(expired, 'account_connection')).toMatchObject({ severity: 'blocker' });
  }
  seed(put => {
    const store = put('store', { brand_id: brand.id, provider: 'shopify', status: 'active', connection_id: connection });
    variant = put('product_variant', { store_id: store, status: 'active' });
    baseline = put('listing_snapshot', { variant_id: variant, channel: 'shopify', is_current: true, observed_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), availability: 'observed', price_amount_minor: 100, currency: 'USD' });
    put('content_revision', { product_refs: [{ variant_id: variant, listing_snapshot_id: baseline, field: 'price' }] }, revision.id);
  });
  expect(issue(await check(), 'product_fact')).toMatchObject({ severity: 'blocker', message: 'Listing snapshot requires fresh verification' });
  seed(put => {
    put('listing_snapshot', { is_current: false }, baseline);
    put('listing_snapshot', { variant_id: variant, channel: 'shopify', is_current: true, observed_at: new Date().toISOString(), availability: 'observed', price_amount_minor: 125, currency: 'USD' });
    const device = put('connector_device', { status: 'active', last_seen_at: new Date().toISOString() });
    phone = put('mobile_device', { device_id: device, status: 'offline', platform: 'ios', last_seen_at: new Date().toISOString(), signing_expires_at: new Date(Date.now() + 20 * 60_000).toISOString() });
    binding = put('account_execution_binding', { social_account_id: account.id, device_id: device, mobile_device_id: phone, mobile_app: 'facebook', mode: 'connector', connector_channel: 'mobile', connector_mode: 'auto' });
    put('capability', { social_account_id: account.id, operation: 'publish', content_format: 'text', status: 'available', executor: 'connector', connector_channel: 'mobile' });
  });
  const offline = await check();
  expect(issue(offline, 'product_fact')).toMatchObject({ severity: 'blocker', message: 'Product price changed after revision', detail: { old_snapshot_id: baseline } });
  expect(issue(offline, 'mobile_device_online')?.severity).toBe('blocker');
  expect(issue(offline, 'mobile_app_binding')?.severity).toBe('blocker');
  expect(issue(await check('schedule'), 'mobile_signing')?.severity).toBe('risk');
  seed(put => {
    put('mobile_device', { status: 'ready', signing_expires_at: new Date(Date.now() - 1000).toISOString() }, phone);
    phoneBinding = put('mobile_app_binding', { mobile_device_id: phone, social_account_id: account.id, app: 'facebook', status: 'identity_mismatch' });
  });
  const identity = await check('execution');
  expect(issue(identity, 'mobile_device_online')).toBeUndefined();
  expect(issue(identity, 'mobile_app_binding')?.severity).toBe('blocker');
  expect(issue(identity, 'mobile_signing')?.severity).toBe('blocker');
  seed(put => {
    put('mobile_app_binding', { status: 'verified' }, phoneBinding);
    put('mobile_device', { signing_expires_at: new Date(Date.now() + 86_400_000).toISOString() }, phone);
    put('account_execution_binding', { auto_halted: true }, binding);
  });
  const stopped = await check();
  expect(stopped).toMatchObject({ route: 'connector', effective_mode: 'assist' });
  expect(issue(stopped, 'automation_limits')).toMatchObject({ severity: 'risk', detail: { effective_mode: 'assist' } });
  expect(issue(stopped, 'connector_mode')?.message).toBe('A person must submit on the bound device');
});

test('PL07 | Formal reconciliation preserves every original plan field except closure metadata', async ({ dev, request }) => {
  const { post, get, seed, target, account } = await fixture(dev, request);
  const first = await target();
  const second = await target();
  const path = id => `/publish-targets/${id}`;
  const before = await get(path(first.id));
  const peer = await get(path(second.id));
  let postId;
  seed(put => {
    postId = put('platform_post', { origin: 'native', verification: 'system_verified', social_account_id: account.id,
      published_at: first.scheduled_at, caption: 'Editorial caption', external_post_id: '1234_5678', post_status: 'live' });
  });
  const suggested = await post('/reconciliation/candidates', { platform_post_id: postId });
  expect(suggested).toHaveLength(2);
  expect(suggested.every(row => !row.highlighted)).toBe(true);
  expect(await get(path(first.id))).toEqual(before);
  expect(await get(path(second.id))).toEqual(peer);
  expect((await get(`/platform-posts/${postId}`)).publish_target_id ?? null).toBeNull();
  const match = suggested.find(row => row.publish_target_id === first.id);
  expect((await post(`/reconciliation/candidates/${match.id}/confirm`, {})).status).toBe('confirmed');
  const after = await get(path(first.id));
  expect(after).toMatchObject({ plan_status: 'closed', close_reason: 'matched_native', display_status: 'published',
    platform_post_id: postId, post_verification: 'system_verified', published_at: first.scheduled_at });
  const derived = new Set(['version', 'updated_at', 'plan_status', 'close_reason', 'display_status', 'allowed_actions',
    'platform_post', 'platform_post_id', 'post_verification', 'published_at']);
  const original = row => Object.fromEntries(Object.entries(row).filter(([key]) => !derived.has(key)));
  expect(original(after)).toEqual(original(before));
  expect(await get(path(second.id))).toEqual(peer);
  expect((await get(`/platform-posts/${postId}`)).publish_target_id).toBe(first.id);
});
