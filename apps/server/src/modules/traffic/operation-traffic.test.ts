import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { createPublicTrafficHandler } from '../../../../public/src/traffic.js';
import { linkOperations } from './links.js';
import { formOperations, decryptLeadContact, recordLeadHandoffReceipt } from './forms.js';
import { pageOperations } from './pages.js';
import { probeDestination } from './probe.js';
import { trafficPublicBridge, type PublicTrafficRequest } from './operation-bridge.js';

function setup(workspaceId = 'workspace') {
  const data = new Map<string, Row[]>();
  const events: Data[] = [];
  let sequence = 0;
  const ctx: Context = {
    workspaceId, tenantId: 'tenant', actorId: 'admin', role: 'admin', now: '2026-11-19T12:00:00.000Z',
    list(kind) { return data.get(kind) ?? []; },
    get(kind, id) {
      const row = ctx.list(kind).find(row => row.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Resource not found');
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: `r${++sequence}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      data.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, values) {
      const row = ctx.get(kind, id);
      const updated = { ...row, ...values, version: row.version + 1, updated_at: ctx.now };
      data.set(kind, ctx.list(kind).map(value => value.id === id ? updated : value));
      return updated;
    },
    remove(kind, id) { data.set(kind, ctx.list(kind).filter(row => row.id !== id)); },
    emit(type, payload) { events.push({ type, ...payload }); },
  };
  const ops: Operation[] = [...linkOperations, ...pageOperations, ...formOperations];
  function run<T = Row>(name: string, body: Data = {}, id?: string, query: Input['query'] = {}): T {
    return ops.find(op => op.name === name)!.run(ctx, { body, params: id ? { id } : {}, query }) as T;
  }
  const secrets = { piiKey: Buffer.alloc(32, 8), trackingKey: Buffer.alloc(32, 2) };
  const bridge = (input: PublicTrafficRequest) => trafficPublicBridge(ctx, input, secrets);
  return { ctx, events, run, bridge, secrets };
}

const hostname = 'go.brand.co';
test('HTTP checks revalidate redirect hosts and keep inconclusive results unknown', async () => {
  const { ctx, run } = setup();
  run('links_allow_host', { hostname: 'shop.brand.co' });
  const seen: string[] = [];
  const checks = await probeDestination(ctx, 'https://shop.brand.co/offer', 'zh', async (url, method) => {
    seen.push(`${method} ${url.pathname}`);
    if (url.pathname === '/offer') return { status: 301, location: '/new' };
    if (method === 'HEAD') return { status: 405 };
    return { status: 200, language: 'zh-Hant' };
  });
  assert.deepEqual(seen, ['HEAD /offer','HEAD /new','GET /new']);
  assert.deepEqual(checks.map(row => row.result), ['pass','pass']);
  let requests = 0;
  const blocked = await probeDestination(ctx, 'https://shop.brand.co/offer', undefined, async () => {
    requests++;
    return { status: 302, location: 'https://other.brand.co/offer' };
  });
  assert.equal(requests, 1);
  assert.equal(blocked[0]?.result, 'fail');
  const unavailable = await probeDestination(ctx, 'https://shop.brand.co/offer', undefined, async () => ({ status: 503 }));
  assert.equal(unavailable[0]?.result, 'unknown');
});
test('short links revalidate exact hosts, preserve revisions and classify observed redirects', () => {
  const { ctx, run, bridge } = setup();
  const domain = ctx.create('link_domain', { hostname, verification_status: 'verified', tls_status: 'active' });
  const allow = run('links_allow_host', { hostname: 'shop.brand.co' });
  const data = { domain_id: domain.id, code: 'sale', brand_id: 'brand', destination_url: 'https://shop.brand.co/sale' };
  for (const candidate of ['https://shop.brand.co.evil.co', 'https://shop.brand.co@evil.co', 'https://127.0.0.1', '//shop.brand.co', 'http://shop.brand.co']) {
    assert.throws(() => run('links_create', { ...data, destination_url: candidate }), Problem);
  }
  const link = run('links_create', data);
  assert.deepEqual(bridge({ type: 'redirect', hostname, code: 'sale', userAgent: 'Twitterbot' }), { type: 'redirect', location: data.destination_url });
  assert.throws(() => bridge({ type: 'redirect', hostname: 'another.brand.co', code: 'sale' }), Problem);
  ctx.create('platform_post', { short_link_id: link.id });
  const next = { destination_url: 'https://shop.brand.co/new', reason: 'New landing' };
  assert.throws(() => run('links_change_destination', next, link.id), Problem);
  const revision = run('links_change_destination', { ...next, confirm_in_use: true }, link.id);
  bridge({ type: 'redirect', hostname, code: 'sale', userAgent: 'Mozilla/5.0', navigation: true });
  assert.deepEqual(ctx.list('click_event').map(row => [row.revision_id, row.classification]), [[link.current_revision_id,'bot_preview'], [revision.id,'human_likely']]);
  const stats = run<{ items: Data[] }>('links_get_stats', {}, link.id);
  assert.equal(stats.items[0]?.redirects, 2);
  assert.equal(stats.items[0]?.human_likely, 1);
  run('links_revoke_host', {}, allow.id);
  assert.throws(() => bridge({ type: 'redirect', hostname, code: 'sale' }), Problem);
});

function checkedPage(fixture: ReturnType<typeof setup>, blocks: Data[]) {
  const { run } = fixture;
  const page = run<Row & { draft: Row }>('pages_create_draft', { title: '<Private tag>', slug: 'brand', brand_id: 'brand', blocks, private_notes: 'never public' });
  assert.throws(() => run('pages_publish', { version_id: page.draft.id }, page.id), Problem);
  const checks = { target_type: 'landing_page_version', target_id: page.draft.id };
  assert.equal(run('links_check', checks).status, 'unknown');
  run('links_check', { ...checks, items: [{ check: 'http_status', result: 'pass', detail: 'Operator observed response' }] });
  run('pages_publish', { version_id: page.draft.id }, page.id);
  return page;
}

test('published forms are scoped, use exact consent versions and store encrypted contacts', async () => {
  const fx = setup();
  const { ctx, run, bridge, secrets, events } = fx;
  const form = run('forms_create', { slug: 'contact', name: 'Contact', brand_id: 'brand' });
  const copy = ctx.create('consent_text_version', { channel: 'email', purpose: 'service', text: 'Email me about this inquiry', effective_from: ctx.now });
  const formVersion = run('forms_create_version', { title: 'Contact', service_contact_only: true,
    fields: [{ key: 'email', label: 'Contact email', required: true }], channel_options: [{ purpose: 'service', channel: 'email', consent_text_version_id: copy.id, checked: true }] }, form.id);
  run('forms_activate', { version_id: formVersion.id }, form.id);
  const page = checkedPage(fx, [{ type: 'text', text: '<script>alert(1)</script>' }, { type: 'form', form_id: form.id }]);
  const handler = createPublicTrafficHandler((host, input) => {
    assert.equal(host, hostname);
    return bridge(input);
  });
  const resp = await handler(new Request(`https://${hostname}/p/brand`));
  assert.equal(resp?.status, 200);
  const html = await resp!.text();
  assert.match(html, /viewport/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /type="checkbox" name="consent" value="email:service"/);
  assert.doesNotMatch(html, /<script|\bchecked\b|never public/);
  assert.equal((await handler(new Request(`https://${hostname}/f/${form.id}/submit`, { method: 'POST', headers: { origin: 'https://foreign.co' }, body: new URLSearchParams() })))?.status, 403);
  const fields = { email: 'person@brand.co' };
  const request = { type: 'submit', slug: 'brand', versionId: page.draft.id, formId: form.id } as const;
  assert.throws(() => bridge({ ...request, body: { form_version_id: 'stale', fields } }), Problem);
  const data = { form_version_id: formVersion.id, fields, consents: ['email:service'] };
  assert.deepEqual(bridge({ ...request, body: data }), { type: 'submit', accepted: true });
  bridge({ ...request, body: data });
  assert.equal(ctx.list('lead').length, 1);
  assert.deepEqual(ctx.list('consent_record').map(row => [row.channel, row.purpose, row.consent_text_version_id]), [['email','service', copy.id]]);
  const lead = ctx.list('lead')[0]!;
  assert.equal(lead.status, 'contact_permitted');
  assert.doesNotMatch(JSON.stringify([lead, events, run('leads_list')]), /person@brand\.co/);
  assert.doesNotMatch(JSON.stringify(run('leads_list')), /contact_encrypted|ciphertext|dedupe_key/);
  assert.deepEqual(decryptLeadContact(ctx, lead.id, secrets.piiKey), fields);
  ctx.role = 'viewer';
  assert.throws(() => decryptLeadContact(ctx, lead.id, secrets.piiKey), Problem);
  assert.throws(() => setup('other').bridge({ ...request, body: data }), Problem);
  ctx.role = 'admin';
  assert.throws(() => run('leads_update', { status: 'contacted', channel: 'email', purpose: 'marketing', outcome: 'Replied' }, lead.id), Problem);
  run('leads_update', { status: 'contacted', channel: 'email', purpose: 'service', outcome: 'Replied' }, lead.id);
  run('leads_update', { status: 'qualified' }, lead.id);
  const pending = run('leads_handoff', { channel: 'email', destination: 'crm-connection' }, lead.id);
  assert.equal(pending.handoff_status, 'pending');
  assert.equal(ctx.get('lead', lead.id).status, 'qualified');
  assert.equal(events.some(event => event.type === 'traffic.lead.handed_off'), false);
  recordLeadHandoffReceipt(ctx, { requestId: String(pending.handoff_id), outcome: 'unknown' });
  assert.throws(() => run('leads_handoff', { channel: 'email', destination: 'crm-connection' }, lead.id), Problem);
  recordLeadHandoffReceipt(ctx, { requestId: String(pending.handoff_id), outcome: 'confirmed', externalRef: 'contact-001' });
  assert.equal(ctx.get('lead', lead.id).status, 'handed_off');
});

test('unticked consent creates no opt-in and tracking requires an opted-in first-party session', () => {
  const fx = setup();
  const { ctx, run, bridge } = fx;
  const form = run('forms_create', { slug: 'signup', name: 'Signup', brand_id: 'brand' });
  const copy = ctx.create('consent_text_version', { channel: 'email', purpose: 'marketing', text: 'Email updates', effective_from: ctx.now });
  const version = run('forms_create_version', { title: 'Signup', fields: [{ key: 'email', label: 'Email' }],
    channel_options: [{ channel: 'email', consent_text_version_id: copy.id }] }, form.id);
  run('forms_activate', { version_id: version.id }, form.id);
  const page = checkedPage(fx, [{ type: 'form', form_id: form.id }]);
  bridge({ type: 'submit', slug: 'brand', versionId: page.draft.id, formId: form.id, body: { form_version_id: version.id, fields: { email: 'person@brand.co' } } });
  assert.equal(ctx.list('consent_record').length, 0);
  assert.equal(ctx.list('lead')[0]?.status, 'contact_not_permitted');
  const event = { type: 'touchpoint', slug: 'brand', versionId: page.draft.id, eventId: 'one' } as const;
  assert.deepEqual(bridge(event), { type: 'touchpoint', recorded: false });
  const visitor = { consent: true, sessionRef: 'random-session' } as const;
  assert.deepEqual(bridge({ ...event, visitor }), { type: 'touchpoint', recorded: true });
  bridge({ ...event, visitor });
  assert.equal(ctx.list('touchpoint_event').length, 1);
  assert.notEqual(ctx.list('touchpoint_event')[0]?.session_ref, visitor.sessionRef);
});

test('market choice uses saved routes rather than query-supplied destinations', async () => {
  const { ctx, run, bridge } = setup();
  const domain = ctx.create('link_domain', { hostname, verification_status: 'verified', tls_status: 'active' });
  run('links_allow_host', { hostname: 'shop.brand.co' });
  run('links_create', { domain_id: domain.id, code: 'offers', brand_id: 'brand', destination_url: 'https://shop.brand.co/offer',
    market_routes: [{ market_id: 'tw', label: 'Taiwan', url: 'https://shop.brand.co/tw/offer' }] });
  const handler = createPublicTrafficHandler((_, input) => bridge(input));
  const url = `https://${hostname}/offers`;
  const choice = await handler(new Request(url));
  assert.equal(choice?.status, 200);
  assert.match(await choice!.text(), /\?market=tw/);
  assert.equal(ctx.list('click_event').length, 0);
  const route = await handler(new Request(`${url}?market=tw&url=https://foreign.co`));
  assert.equal(route?.headers.get('location'), 'https://shop.brand.co/tw/offer');
  assert.equal(ctx.list('click_event')[0]?.route_market_id, 'tw');
});

test('listing-backed links and purchase CTAs must use the storefront URL', () => {
  const fx = setup();
  const { ctx, run, bridge } = fx;
  run('links_allow_host', { hostname: 'shop.brand.co' });
  run('links_allow_host', { hostname: 'shopee.tw' });
  const domain = ctx.create('link_domain', { hostname, verification_status: 'verified', tls_status: 'active' });
  const store = ctx.create('store', { provider: 'shopee' });
  const product = ctx.create('product', { store_id: store.id });
  const variant = ctx.create('product_variant', { product_id: product.id });
  const url = 'https://shopee.tw/product/1/2';
  ctx.create('listing_snapshot', { variant_id: variant.id, is_current: true, purchase_url: url, availability: 'observed',
    is_estimate: false, price_amount_minor: 100, currency: 'TWD', price_source: 'store_base_price', observed_at: ctx.now });
  const link = { domain_id: domain.id, brand_id: 'brand', product_variant_id: variant.id };
  assert.throws(() => run('links_create', { ...link, destination_url: 'https://shop.brand.co/checkout' }), Problem);
  assert.equal(run('links_create', { ...link, destination_url: url }).product_variant_id, variant.id);
  checkedPage(fx, [{ type: 'product', product_variant_id: variant.id, label: 'Store' }]);
  const page = bridge({ type: 'page', slug: 'brand' });
  assert.ok(page.type === 'page');
  const block = page.blocks[0];
  assert.ok(block?.type === 'product');
  assert.equal(block.url, url);
  assert.equal(block.observed_at, ctx.now);
  assert.equal('product_variant_id' in block, false);
  ctx.update('store', store.id, { provider: 'lazada' });
  const published = ctx.list('landing_page_version')[0]!;
  const check = run('links_check', { target_type: 'landing_page_version', target_id: published.id,
    items: [{ check: 'http_status', result: 'pass', detail: 'Local fixture' }] });
  assert.equal(check.status, 'unknown');
  assert.equal((check.items as Row[]).find(item => item.check === 'platform_redirect')?.result, 'unknown');
  assert.throws(() => bridge({ type: 'page', slug: 'brand' }), /Platform destination policy unknown/);
});

test('page experiments follow the agreed versions, time window and stable visitor bucket', () => {
  const fx = setup();
  const { ctx, run, bridge } = fx;
  const block = { type: 'text', text: 'Original' };
  const page = checkedPage(fx, [block]);
  const variant = run('pages_create_version', { title: 'Variant', blocks: [block] }, page.id);
  run('links_check', { target_type: 'landing_page_version', target_id: variant.id, items: [{ check: 'http_status', result: 'pass', detail: 'Operator observed response' }] });
  const exp = ctx.create('experiment', { type: 'page', status: 'draft', period: { from: '2026-11-18', to: '2026-11-20' },
    variants: [{ ref_id: page.draft.id, allocation: 20 }, { ref_id: variant.id, allocation: 80 }] });
  run('pages_configure_experiment', { experiment_id: exp.id, arms: [{ arm_key: 'a', version_id: page.draft.id, weight: 20 }, { arm_key: 'b', version_id: variant.id, weight: 80 }] }, page.id);
  ctx.update('experiment', exp.id, { status: 'running' });
  const report = () => fx.run('pages_experiment_report', {}, page.id, { experiment_id: exp.id });
  assert.equal(report().coverage, 'unavailable');
  ctx.create('experiment_result_snapshot', { experiment_id: exp.id, as_of: '2026-11-19', source: 'page',
    variants: [{ ref_id: variant.id, sample_size: 4, value: 0 }, { ref_id: page.draft.id, sample_size: 0, value: null }] });
  assert.equal(report().coverage, 'insufficient_traffic');
  assert.deepEqual(report().arms, [{ arm_key: 'a', sample_size: 0, value: null }, { arm_key: 'b', sample_size: 4, value: 0 }]);
  const baseline = bridge({ type: 'page', slug: 'brand' });
  assert.equal(baseline.type === 'page' && baseline.versionId, page.draft.id);
  const requests = Array.from({ length: 8 }, (_, index) => ({ type: 'page', slug: 'brand', visitor: { consent: true, sessionRef: `visitor-${index}` } } as const));
  const results = requests.map(bridge);
  assert.ok(results.some(result => result.type === 'page' && result.versionId === variant.id));
  assert.deepEqual(requests.map(bridge), results);
  ctx.now = '2026-11-21T00:00:00.000Z';
  assert.deepEqual(bridge(requests[0]!), baseline);
});
