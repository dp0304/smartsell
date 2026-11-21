import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest, opaque } from '../identity.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Context, Data, Row } from '@smartsell/contracts';
import { fileStore } from '@smartsell/db';
import { Pool } from 'pg';
import { PostgresStore } from '../postgres.js';
import type { Store } from '../store.js';
import { buildApp } from '../app.js';
import { configuration } from '../config.js';
import { makeContext } from '../context.js';
import { MemoryStore } from '../memory.js';
import { operations as analytics } from '../modules/analytics/workspace-operations.js';
import { commands as lifecycle } from '../modules/lifecycle/index.js';
import { saveSuppression } from '../modules/lifecycle/audience.js';
import { commands as legacy, operations } from '../modules/traffic/index.js';
import { createServer } from '../server.js';
import { operationRecords } from './operation-records.js';

const publicHost = 'go.brand.co';
const otherHost = 'go.other.co';
const destination = 'https://shop.brand.co/sale';
const contact = 'visitor@example.org';
const origin = `https://${publicHost}`;
const config = (workspaceId: string) => configuration({ PUBLIC_ORIGIN: 'https://admin.brand.co',
  SMARTSELL_TRAFFIC_PII_KEY: 'aa'.repeat(32), SMARTSELL_TRAFFIC_HOSTS: JSON.stringify({
    [origin]: workspaceId, [`https://${otherHost}`]: randomUUID(),
  }) });

function http(address: string, path: string, options: { host?: string; headers?: Record<string, string>; body?: string | URLSearchParams } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const post = options.body !== undefined;
    const req = request(`${address}${path}`, { method: post ? 'POST' : 'GET', headers: {
      host: options.host ?? publicHost, ...(post ? { 'content-type': 'application/x-www-form-urlencoded', origin } : {}), ...options.headers,
    } }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body?.toString());
  });
}

function run(ctx: Context, name: string, body: Data = {}, id?: string) {
  return operations.find(operation => operation.name === name)!.run(ctx, { body, params: id ? { id } : {}, query: {} }) as Row;
}

function seed(ctx: Context) {
  const domain = ctx.create('link_domain', { hostname: publicHost, verification_status: 'verified', tls_status: 'active' });
  run(ctx, 'links_allow_host', { hostname: 'shop.brand.co' });
  run(ctx, 'links_create', { domain_id: domain.id, code: 'sale', brand_id: 'brand', destination_url: destination });
  const form = run(ctx, 'forms_create', { slug: 'contact', name: 'Contact', brand_id: 'brand' });
  const copy = ctx.create('consent_text_version', { channel: 'email', purpose: 'service', text: 'Reply to my inquiry', effective_from: ctx.now });
  const formVersion = run(ctx, 'forms_create_version', { title: 'Contact', fields: [{ key: 'email', label: 'Email', required: true }],
    channel_options: [{ purpose: 'service', channel: 'email', consent_text_version_id: copy.id }] }, form.id);
  run(ctx, 'forms_activate', { version_id: formVersion.id }, form.id);
  const page = run(ctx, 'pages_create_draft', { slug: 'campaign', brand_id: 'brand', title: '<Campaign>',
    blocks: [{ type: 'text', text: 'Published content', internal: 'private fixture' }, { type: 'form', form_id: form.id }] });
  const version = page.draft as Row;
  run(ctx, 'links_check', { target_type: 'landing_page_version', target_id: version.id,
    items: [{ check: 'http_status', result: 'pass', detail: 'Local fixture' }] });
  run(ctx, 'pages_publish', { version_id: version.id }, page.id);
  run(ctx, 'pages_create_draft', { slug: 'draft', brand_id: 'brand', title: 'Draft', blocks: [{ type: 'text', text: 'Draft' }] });
  const store = ctx.create('store', { provider: 'shopee' });
  const product = ctx.create('product', { store_id: store.id });
  const variant = ctx.create('product_variant', { product_id: product.id });
  const purchaseUrl = 'https://shop.brand.co/product/123/456';
  const priceTime = '2026-01-01T12:00:00.000Z';
  ctx.create('listing_snapshot', { variant_id: variant.id, is_current: true, purchase_url: purchaseUrl, availability: 'observed',
    price_amount_minor: 0, currency: 'USD', is_estimate: false, price_source: 'store_market_price', price_observed_at: priceTime, observed_at: ctx.now });
  const storePage = run(ctx, 'pages_create_draft', { slug: 'product', brand_id: 'brand', title: 'Product', blocks: [
    { type: 'product', product_variant_id: variant.id, label: '商店商品' },
    { type: 'cta', product_variant_id: variant.id, url: purchaseUrl, label: '前往商店' },
  ] });
  const storeVersion = storePage.draft as Row;
  run(ctx, 'links_check', { target_type: 'landing_page_version', target_id: storeVersion.id,
    items: [{ check: 'http_status', result: 'pass', detail: 'Local fixture' }] });
  run(ctx, 'pages_publish', { version_id: storeVersion.id }, storePage.id);
  return { form, formVersion, copy, version, purchaseUrl, priceTime };
}

async function exercise(address: string, fixture: ReturnType<typeof seed>) {
  const page = await http(address, '/p/campaign', { headers: { cookie: 'smartsell_visitor=untrusted' } });
  assert.equal(page.status, 200, page.body);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(String(page.headers['content-security-policy']), /form-action 'self'/);
  assert.match(page.body, /&lt;Campaign&gt;.*Published content/);
  assert.match(page.body, /name="consent" value="email:service"/);
  assert.doesNotMatch(page.body, /private fixture|checked|workspace_id|consent_text_version_id/);
  const preference = await checkLanguagePreference(address, fixture);
  const product = await http(address, '/p/product');
  assert.equal(product.status, 200, product.body);
  assert.ok(product.body.includes(`$0.00<small>店鋪市場價格 · <time datetime="${fixture.priceTime}">${fixture.priceTime}</time>`));
  assertProductLinks(product.body, fixture.purchaseUrl);
  const consentForm = '<form method="post" action="/p/product">' +
    '<button name="analytics" value="allow">允許分析</button> ' +
    '<button name="analytics" value="deny">拒絕分析</button></form>';
  assert.deepEqual(product.body.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi), [consentForm]);
  assert.doesNotMatch(product.body.replace(consentForm, ''), /<(?:form|button)\b/i);
  assert.doesNotMatch(product.body, /\b(?:checkout|cart|formaction)\b|<input\b|購物車|結帳/i);
  assert.equal(product.headers['referrer-policy'], 'same-origin');
  const rejectedConsent = await http(address, '/p/product', {
    body: new URLSearchParams({ analytics: 'allow' }), headers: { origin: 'https://foreign.example.org' },
  });
  assert.equal(rejectedConsent.status, 403);
  assert.equal(rejectedConsent.headers['set-cookie'], undefined);
  await checkLocalizedAnalytics(address, preference);
  assert.equal((await http(address, '/p/campaign', { host: otherHost })).status, 404);
  assert.equal((await http(address, '/p/campaign', { host: 'unknown.brand.co', headers: { 'x-forwarded-host': publicHost } })).status, 404);
  assert.equal((await http(address, '/api/v1/session')).status, 404);
  assert.equal((await http(address, '/api/v1/session', { host: `${publicHost}:444` })).status, 404);
  const redirect = await http(address, '/sale?destination=https://ignored.example.org/', { headers: { 'user-agent': 'Twitterbot' } });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, destination);
  const form = `/f/${fixture.form.id}/submit`;
  const body = new URLSearchParams({ slug: 'campaign', version_id: fixture.version.id, form_version_id: fixture.formVersion.id,
    email: contact, consent: 'email:service' });
  assert.equal((await http(address, form, { body, headers: { origin: 'https://foreign.example.org' } })).status, 403);
  assert.equal((await http(address, form, { body, headers: { 'content-type': 'application/json' } })).status, 415);
  assert.equal((await http(address, form, { body: 'a'.repeat(65 * 1024) })).status, 413);
  assert.equal((await http(address, form, { body: new URLSearchParams({ ...Object.fromEntries(body), form_version_id: 'stale' }) })).status, 409);
  const posted = await http(address, form, { body, headers: { cookie: 'smartsell_visitor=untrusted' } });
  assert.equal(posted.status, 200, posted.body);
  assert.match(posted.body, /已收到您的資料/);
  assert.doesNotMatch(posted.body, new RegExp(contact));
  await checkLocalizedSubmission(address, form, body, contact);
}

function verify(ctx: Context, fixture: ReturnType<typeof seed>) {
  assert.equal(ctx.list('click_event')[0]?.classification, 'bot_preview');
  assert.equal(ctx.list('touchpoint_event').length, 0);
  const leads = ctx.list('lead');
  assert.equal(leads.length, 1);
  assert.ok(leads[0]?.contact_encrypted);
  assert.doesNotMatch(JSON.stringify(leads), /visitor@example\.org/);
  assert.deepEqual(ctx.list('consent_record').map(row => row.consent_text_version_id), [fixture.copy.id]);
  saveSuppression(ctx, { customer_id: leads[0]?.customer_id, channel: 'email', reason: 'manual', source: 'manual', source_ref: 'test' });
  assert.throws(() => run(ctx, 'leads_update', { status: 'contacted', channel: 'email', purpose: 'service', outcome: 'Test' }, leads[0]!.id), /permitted contact/);
}

test('kernel public traffic over a local TCP socket', async t => {
  const root = await mkdtemp(join(tmpdir(), 'smartsell-traffic-'));
  const store = await fileStore(join(root, 'state.json'));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const scope = { workspaceId: randomUUID(), tenantId: randomUUID(), actorId: randomUUID() };
  const fixture = await store.transaction({ identityWrite: true }, async tx => {
    tx.identity.put(`workspace/${scope.workspaceId}`, { id: scope.workspaceId, tenantId: scope.tenantId });
    tx.identity.put(`tenant/${scope.tenantId}`, { status: 'active' });
    return seed(makeContext(await tx.workspace(scope), scope, 'owner'));
  });
  const app = createServer({ config: config(scope.workspaceId), store, operations: [] });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  await exercise(address, fixture);
  await store.transaction({}, async tx => verify(makeContext(await tx.workspace(scope), scope, 'owner'), fixture));
});

test('LP05 reads CRM handoff state and advances only after confirmed provider evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'smartsell-lead-handoff-'));
  const store = await fileStore(join(root, 'state.json'));
  const scope = { workspaceId: randomUUID(), tenantId: randomUUID(), actorId: randomUUID() };
  const settings = config(scope.workspaceId);
  const experimentOperations = new Set(['experiments_create', 'experiment_start', 'experiment_record_result']);
  const server = createServer({ config: settings, store, operations: [
    ...operations.map(operation => ({ ...operation, module: 'traffic' })),
    ...analytics.filter(operation => experimentOperations.has(operation.name)).map(operation => ({ ...operation, module: 'analytics' })),
  ] });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const token = opaque();
  const csrf = opaque();
  const fixture = await store.transaction({ identityWrite: true }, async tx => {
    tx.identity.put(`workspace/${scope.workspaceId}`, { id: scope.workspaceId, tenantId: scope.tenantId });
    tx.identity.put(`tenant/${scope.tenantId}`, { status: 'active' });
    tx.identity.put(`user/${scope.actorId}`, { id: scope.actorId });
    tx.identity.put(`member/${scope.actorId}/${scope.workspaceId}`, { userId: scope.actorId, workspaceId: scope.workspaceId, role: 'owner' });
    tx.identity.put(`session/${digest(token)}`, { userId: scope.actorId, csrf, expires: Math.floor(Date.now() / 1000) + 600 });
    return seed(makeContext(await tx.workspace(scope), scope, 'owner'));
  });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  await exercise(address, fixture);
  async function op(path: string, options: { body?: Data; version?: number; method?: string; status?: number } = {}) {
    const result = await fetch(`${address}/api/v1/workspaces/${scope.workspaceId}${path}`, {
      method: options.method ?? (options.body ? 'POST' : 'GET'), body: options.body && JSON.stringify(options.body),
      headers: { cookie: `${settings.secureCookie ? '__Host-' : ''}smartsell_session=${token}`, origin: settings.origin, 'x-csrf-token': csrf,
        ...(options.body && { 'content-type': 'application/json' }), ...(options.version && { 'if-match': String(options.version) }) },
    });
    const text = await result.text();
    assert.equal(result.status, options.status ?? 200, text);
    assert.doesNotMatch(text, /visitor@example\.org|contact_encrypted|dedupe_key|external_crm_ref/);
    return JSON.parse(text).data;
  }
  const pageId = String(fixture.version.page_id);
  const pagePath = `/landing-pages/${pageId}`;
  const getPage = async () => (await op('/landing-pages')).find((row: Row) => row.id === pageId);
  const variant = await op(`${pagePath}/versions`, { version: (await getPage()).version,
    body: { title: 'Alternate campaign', blocks: [{ type: 'text', text: 'Alternate content' }] } });
  const checkBody = { target_type: 'landing_page_version', target_id: variant.id };
  const checkQuery = `target_type=landing_page_version&target_id=${variant.id}`;
  assert.equal((await op('/page-checks', { body: checkBody })).status, 'unknown');
  const page = await getPage();
  await op(`${pagePath}/publish`, { version: page.version, body: { version_id: variant.id }, status: 409 });
  await op('/page-checks', { body: { ...checkBody, items: [{ check: 'http_status', result: 'pass', detail: 'Observed fixture' }] } });
  assert.deepEqual((await op(`/page-checks?${checkQuery}`)).map((row: Row) => row.status), ['unknown', 'pass']);
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const experiment = await op('/experiments', { body: { type: 'page', hypothesis: 'The alternate page improves conversion',
    primary_metric: 'conversion', success_criteria: 'Higher conversion', minimum_sample_size: 5,
    period: { from: today, to: tomorrow, tz: 'UTC' },
    variants: [{ ref_id: fixture.version.id, allocation: 50 }, { ref_id: variant.id, allocation: 50 }] } });
  const reportBody = { experiment_id: experiment.id, arms: [{ arm_key: 'control', version_id: fixture.version.id, weight: 50 },
    { arm_key: 'alternate', version_id: variant.id, weight: 50 }] };
  await op(`${pagePath}/experiment`, { version: page.version, method: 'PUT', body: reportBody });
  const reportPath = `${pagePath}/experiment?experiment_id=${experiment.id}`;
  assert.equal((await op(reportPath)).coverage, 'unavailable');
  await op(`/experiments/${experiment.id}/start`, { version: experiment.version, body: {} });
  const recordSamples = (source_ref: string, sample_size: number, value: number | null) => op(`/experiments/${experiment.id}/results`, {
    body: { source: 'page', source_ref, as_of: new Date().toISOString(), limitations: ['Local fixture'],
      variants: [{ ref_id: fixture.version.id, sample_size: 5, value: 0 }, { ref_id: variant.id, sample_size, value }] },
  });
  await recordSamples('no-alternate-sample', 0, null);
  const emptyReport = await op(reportPath);
  assert.equal(emptyReport.coverage, 'insufficient_traffic');
  assert.deepEqual(emptyReport.arms.map(({ sample_size, value }: Data) => [sample_size, value]), [[5, 0], [0, null]]);
  await recordSamples('small-alternate-sample', 2, 0);
  const report = await op(reportPath);
  assert.equal(report.minimum_sample_size, 5);
  assert.equal(report.coverage, 'insufficient_traffic');
  assert.deepEqual(report.arms.map(({ sample_size, value }: Data) => [sample_size, value]), [[5, 0], [2, 0]]);

  const [link] = await op('/short-links');
  const linkPath = `/short-links/${link.id}`;
  const botStats = await op(`${linkPath}/stats`);
  assert.equal(botStats.items[0].redirects, 1);
  assert.equal(botStats.items[0].human_likely, 0);
  const navigation = await http(address, '/sale', { headers: { 'user-agent': 'Mozilla/5.0 (Fixture)', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' } });
  assert.equal(navigation.status, 302);
  const { items: [stats] } = await op(`${linkPath}/stats`);
  assert.equal(stats.redirects, 2);
  assert.equal(stats.human_likely, 1);
  assert.equal(stats.bot_filtered, 1);
  const nextUrl = 'https://shop.brand.co/new';
  const revision = await op(`${linkPath}/destination`, { version: link.version, body: { destination_url: nextUrl, reason: 'Seasonal page' } });
  const revised = await op(linkPath);
  assert.deepEqual(revised.revisions.map((row: Row) => [row.id, row.destination_url]), [[link.current_revision_id, destination], [revision.id, nextUrl]]);
  assert.equal((await http(address, '/sale')).headers.location, nextUrl);

  const bio = await op('/bio-pages', { body: { handle: 'brand', brand_id: 'brand', title: '繁體品牌' } });
  const bioPath = `/bio-pages/${bio.id}`;
  const add = async (label: string, fields: Data = {}) => {
    const [current] = await op('/bio-pages');
    return op(`${bioPath}/items`, { version: current.version, body: { label, short_link_id: link.id, ...fields } });
  };
  await add('台灣連結', { market_ids: ['tw'] });
  await add('Expired item', { valid_until: '2020-01-01T00:00:00.000Z' });
  await add('Paused item', { status: 'paused' });
  const [currentBio] = await op('/bio-pages');
  await op(`${bioPath}/publish`, { version: currentBio.version, body: {} });
  const defaultBio = await http(address, '/b/brand', { headers: { 'accept-language': 'en-US' } });
  const marketBio = await http(address, '/b/brand?market=tw&lang=zh-Hans', { headers: { 'accept-language': 'en-US' } });
  assert.equal(defaultBio.status, 200);
  assert.equal(marketBio.status, 200);
  assert.match(defaultBio.body, /<html lang="en".*繁體品牌.*Some links have expired/);
  assert.match(marketBio.body, /<html lang="zh-Hans".*台灣連結.*部分链接已过期/);
  assert.match(marketBio.body, /href="\?market=tw&amp;lang=en"/);
  assert.match(marketBio.body, /href="\?lang=zh-Hans"[^>]*>所有市场/);
  assert.doesNotMatch(defaultBio.body, /台灣連結|Expired item|Paused item/);
  assert.doesNotMatch(marketBio.body, /Expired item|Paused item/);
  await op('/short-links', { body: { domain_id: link.domain_id, code: 'regional', brand_id: 'brand', destination_url: destination,
    market_routes: [{ market_id: 'tw', label: '臺灣特惠', url: nextUrl }] } });
  const marketChoice = await http(address, '/regional?lang=zh-Hans');
  assert.equal(marketChoice.status, 200);
  assert.match(marketChoice.body, /选择市场.*默认目的地.*href="\?lang=zh-Hans&amp;market=tw"[^>]*>臺灣特惠/);
  const routed = await http(address, '/regional?lang=zh-Hans&market=tw');
  assert.equal(routed.status, 302);
  assert.equal(routed.headers.location, nextUrl);

  const authored = await op('/landing-pages', { body: { slug: 'simplified-content', brand_id: 'brand', locale: 'zh-CN', title: '活动介绍',
    blocks: [{ type: 'text', text: '这是已发布的内容。' }] } });
  await op('/page-checks', { body: { target_type: 'landing_page_version', target_id: authored.draft.id,
    items: [{ check: 'http_status', result: 'pass', detail: 'Observed fixture' }] } });
  await op(`/landing-pages/${authored.id}/publish`, { version: authored.version, body: { version_id: authored.draft.id } });
  const fallback = await http(address, '/p/simplified-content', { headers: { 'accept-language': 'ja' } });
  assert.equal(fallback.status, 200);
  assert.match(fallback.body, /<html lang="zh-Hans".*<h1 lang="zh-CN">活动介绍<\/h1>.*action="\/p\/simplified-content".*允许分析/);
  assert.equal(fallback.headers['set-cookie'], undefined);
  const initialItems = await op(`${bioPath}/items`);
  assert.deepEqual(initialItems.map((row: Row) => row.disposition), ['active', 'expired', 'unlisted']);
  await op(linkPath, { method: 'PATCH', version: revised.version, body: { status: 'paused' } });
  assert.equal((await op(`${bioPath}/items`))[0].disposition, 'unlisted');
  assert.doesNotMatch((await http(address, '/b/brand?market=tw')).body, /台灣連結/);

  const [lead] = await op('/leads');
  assert.deepEqual(lead.service_contact_channels, ['email']);
  assert.equal(lead.status, 'contact_permitted');
  const path = `/leads/${lead.id}`;
  const update = (body: Data, version: number, status?: number) => op(path, { method: 'PATCH', body, version, status });
  const contacted = await update({ status: 'contacted', channel: 'email', purpose: 'service', outcome: 'Replied' }, lead.version);
  const qualified = await update({ status: 'qualified' }, contacted.version);
  const handoff = { channel: 'email', destination: 'fixture-crm' };
  await op(`${path}/handoff`, { version: qualified.version, body: { ...handoff, channel: 'sms' }, status: 409 });
  const queued = await op(`${path}/handoff`, { version: qualified.version, body: handoff });
  const pending = await op(path);
  assert.equal(pending.handoff_status, 'pending');
  assert.equal(pending.handoff_id, queued.handoff_id);
  assert.equal(pending.status, 'qualified');
  const receipt = { handoff_id: pending.handoff_id, evidence_ref: 'authorized-fixture-readback' };
  const unknown = await op(`${path}/handoff/receipt`, { version: pending.version, body: { ...receipt, outcome: 'unknown' } });
  assert.equal((await op(path)).handoff_status, 'unknown');
  await op(`${path}/handoff`, { version: unknown.version, body: handoff, status: 409 });
  await update({ status: 'converted' }, unknown.version, 409);
  const confirmed = await op(`${path}/handoff/receipt`, { version: unknown.version,
    body: { ...receipt, outcome: 'confirmed', external_ref: 'fixture-contact-01' } });
  assert.equal(confirmed.status, 'handed_off');
  assert.equal(confirmed.handoff_status, 'confirmed');
  const converted = await update({ status: 'converted', outcome: 'Fixture sale' }, confirmed.version);
  assert.equal(converted.status, 'converted');
});

async function exerciseCommand(t: TestContext, store: Store, provision: (id: string) => Promise<unknown> = async () => {}) {
  let app: ReturnType<typeof buildApp>['app'] | undefined;
  t.after(async () => { if (app) await app.close(); else await store.close(); });
  await store.ready();
  const token = 'fixture-session';
  await store.setup({ email: 'owner@example.org', name: 'Owner', workspaceName: 'Brand', passwordHash: 'unused' }, token);
  const [{ id: workspaceId }] = (await store.session(token))!.workspaces;
  const { fixture, landing, link } = await store.workspace(token, workspaceId, async unit => {
    const context = unit.context;
    let fixture!: ReturnType<typeof seed>;
    let landing!: { page: { id: string }; version: { id: string } };
    let link!: { link: { id: string } };
    await unit.command({ module: 'traffic', action: 'fixture', key: 'fixture', fingerprint: '' }, async () => {
      const { records, flush } = await operationRecords(context, false);
      fixture = seed(makeContext(records, context, 'owner'));
      await flush();
      const copy = await lifecycle.create_consent_text.run(context, { channel: 'email', purpose: 'service', locale: 'en', text: 'Reply to this message' });
      landing = await legacy.pages_create_draft.run(context, { title: 'Legacy campaign', description: 'Legacy copy',
        service_contact: { channel: 'email', consent_text_version_id: copy.id } });
      await legacy.publish_landing_page.run(context, { page_id: landing.page.id, version_id: landing.version.id,
        expected_version: (await context.get('traffic', 'landing_page', landing.page.id))!.version });
      await context.insert('traffic', 'destination_domain', { hostname: 'shop.brand.co', status: 'verified' });
      const created = await legacy.links_create.run(context, { destination_url: destination });
      // Legacy opaque IDs can start with a character that modern slugs disallow.
      const code = `_${'a'.repeat(31)}`;
      const revision = await context.insert('traffic', 'short_link_revision', { ...created.revision.data, short_link_id: code });
      link = { link: await context.insert('traffic', 'short_link', { ...created.link.data, code, current_revision_id: revision.id }, code) };
      return {};
    });
    return { fixture, landing, link };
  });
  await provision(workspaceId);
  ({ app } = buildApp({ ...config(workspaceId), store, registry: new Map() }));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  await exercise(address, fixture);
  const oldPage = await http(address, `/landing/${landing.page.id}`);
  assert.equal(oldPage.status, 200, oldPage.body);
  assert.match(oldPage.body, /Legacy copy/);
  const simplified = await http(address, `/landing/${landing.page.id}?lang=zh-Hans`);
  assert.match(simplified.body, /<html lang="zh-Hans".*Legacy copy.*电子邮箱.*Reply to this message/);
  assert.ok(simplified.body.includes(`name="form_version_id" value="${landing.version.id}"`));
  const oldLink = await http(address, `/r/${link.link.id}`);
  assert.equal(oldLink.status, 302);
  assert.equal(oldLink.headers.location, destination);
  const oldForm = `/f/${landing.page.id}/submit`;
  const body = new URLSearchParams({ slug: landing.page.id, version_id: landing.version.id, form_version_id: landing.version.id,
    email: 'legacy@example.org', consent: 'email:service' });
  assert.equal((await http(address, oldForm, { body })).status, 200);
  await store.workspace(token, workspaceId, async ({ context }) => {
    const { records } = await operationRecords(context, false);
    verify(makeContext(records, context, 'owner'), fixture);
    assert.equal((await legacy.leads_list.run(context, {}))[0]?.status, 'contact_permitted');
    assert.equal((await context.list('traffic', 'click_event')).length, 1);
  });
}

test('command host serves both data models over a local TCP socket', t => exerciseCommand(t, new MemoryStore()));

const pgRequest = process.env.TRAFFIC_TEST_DATABASE_URL;
const pgOwner = process.env.TRAFFIC_TEST_DATABASE_OWNER_URL;
test('command PostgreSQL traffic scope over a local TCP socket', { skip: !pgRequest || !pgOwner }, async t => {
  const owner = new Pool({ connectionString: pgOwner });
  t.after(() => owner.end());
  await exerciseCommand(t, new PostgresStore(pgRequest!), id => owner.query(`
    INSERT INTO ss.public_locators (locator, id, tenant_id, workspace_id)
    SELECT 'traffic.workspace', id::text, tenant_id, id FROM ss.workspaces WHERE id = $1::uuid`, [id]));
});

async function checkLanguagePreference(address: string, fixture: ReturnType<typeof seed>) {
  assert.equal((await http(address, '/assets/traffic.css')).status, 200);
  const simplified = await http(address, '/p/campaign?lang=zh-CN&source=fixture', {
    headers: { 'accept-language': 'en', cookie: 'smartsell_traffic_lang=zh-Hant' },
  });
  assert.match(simplified.body, /<html lang="zh-Hans"/);
  assert.match(simplified.body, /<h1 lang="zh-Hant">&lt;Campaign&gt;<\/h1>/);
  assert.match(simplified.body, /<legend lang="zh-Hans">服务联系<\/legend>/);
  assert.match(simplified.body, /Reply to my inquiry.*>提交<\/button>/);
  assert.match(simplified.body, /href="\?lang=en&amp;source=fixture"/);
  assert.ok(simplified.body.includes(`action="/f/${fixture.form.id}/submit?lang=zh-Hans"`));
  assert.ok(simplified.body.includes(`name="version_id" value="${fixture.version.id}"`));
  assert.ok(simplified.body.includes(`name="form_version_id" value="${fixture.formVersion.id}"`));
  assert.equal(simplified.headers.vary, 'Accept-Language, Cookie');
  const preferences = simplified.headers['set-cookie'] as string[];
  assert.equal(preferences.length, 1);
  assert.match(preferences[0]!, /^smartsell_traffic_lang=zh-Hans; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/);
  const preference = preferences[0]!.split(';', 1)[0]!;
  const saved = await http(address, '/p/product?lang=unsupported', { headers: { cookie: preference, 'accept-language': 'en' } });
  assert.match(saved.body, /<html lang="zh-Hans"/);
  assert.match(saved.body, /店铺市场价格/);
  assert.equal(saved.headers['set-cookie'], undefined);
  const negotiated = await http(address, '/p/product', { headers: { 'accept-language': 'zh-TW;q=0, en;q=0.3, zh-SG;q=0.9' } });
  assert.match(negotiated.body, /<html lang="zh-Hans"/);
  assert.equal(negotiated.headers['set-cookie'], undefined);
  const bareChinese = await http(address, '/p/product', { headers: { 'accept-language': 'zh' } });
  assert.match(bareChinese.body, /<html lang="zh-Hans">/);
  return preference;
}

function assertProductLinks(html: string, destination: string) {
  assert.deepEqual([...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)].map(match => match[1]),
    ['?lang=zh-Hant', '?lang=zh-Hans', '?lang=en', destination, destination]);
}

async function checkLocalizedAnalytics(address: string, preference: string) {
  const analytics = await http(address, '/p/campaign?lang=zh-Hans&source=fixture', { body: new URLSearchParams({ analytics: 'deny' }) });
  assert.equal(analytics.status, 303);
  assert.equal(analytics.headers.location, '/p/campaign?lang=zh-Hans&source=fixture');
  const afterAnalytics = await http(address, String(analytics.headers.location), {
    headers: { cookie: `${preference}; ${(analytics.headers['set-cookie'] as string[])[0]!.split(';', 1)[0]}` },
  });
  assert.match(afterAnalytics.body, /<html lang="zh-Hans"/);
  assert.match(afterAnalytics.body, /value="deny" disabled>拒绝分析/);
  const unpublished = await http(address, '/p/draft', { headers: { cookie: preference } });
  assert.equal(unpublished.status, 404);
  assert.match(unpublished.body, /找不到此页面/);
}

async function checkLocalizedSubmission(address: string, form: string, body: URLSearchParams, contact: string) {
  const localizedForm = `${form}?lang=zh-Hans`;
  const wrongOrigin = await http(address, localizedForm, { body, headers: { origin: 'https://foreign.example.org' } });
  assert.equal(wrongOrigin.status, 403);
  assert.match(wrongOrigin.body, /请从原活动页面提交/);
  const wrongFormat = await http(address, localizedForm, { body, headers: { 'content-type': 'application/json' } });
  assert.equal(wrongFormat.status, 415);
  assert.match(wrongFormat.body, /不支持此表单格式/);
  const oversized = await http(address, localizedForm, { body: 'a'.repeat(65 * 1024) });
  assert.equal(oversized.status, 413);
  assert.match(oversized.body, /请缩短留言后重试/);
  const stale = await http(address, localizedForm, { body: new URLSearchParams({ ...Object.fromEntries(body), form_version_id: 'stale' }) });
  assert.equal(stale.status, 409);
  assert.match(stale.body, /表单已更新/);
  const translatedReceipt = await http(address, localizedForm, { body });
  assert.equal(translatedReceipt.status, 200);
  assert.match(translatedReceipt.body, /<html lang="zh-Hans".*已收到您的信息/);
  assert.doesNotMatch(translatedReceipt.body, new RegExp(contact));
}
