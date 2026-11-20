import { completedReportVersion } from './report-version.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const loopback = '127.0.0.1';
const password = 'launch-acceptance-only-2026';
const owner = { email: 'launch-owner@example.invalid', name: 'Launch owner', password };
const reviewer = { email: 'launch-reviewer@example.invalid', name: 'Launch reviewer', password };
const iso = offset => new Date(Date.now() + offset).toISOString();
const day = offset => iso(offset).slice(0, 10);
const oneDay = 86_400_000;
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function port() {
  const socket = createServer().listen(0, loopback);
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-launch-'));
  const listenPort = await port();
  const origin = `http://${loopback}:${listenPort}`;
  const setupToken = randomBytes(24).toString('hex');
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_ENV: 'test', HOST: loopback, PORT: String(listenPort),
    APP_SECRET: randomBytes(32).toString('hex'), SETUP_TOKEN: setupToken,
    SMARTSELL_DATA_FILE: join(dir, 'launch.sqlite'), MEDIA_DIRECTORY: join(dir, 'media'),
  };
  let child;
  let exited;
  let log = '';
  async function stop() {
    if (!child) return;
    child.kill('SIGTERM');
    const forced = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(forced); child = undefined; }
  }
  t.after(async () => {
    try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  async function start() {
    log = '';
    const restrictFetch = `const fetchOriginal = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.hostname !== '${loopback}') throw new Error('Launch acceptance blocks outbound fetch');
        return fetchOriginal(input, { ...options, redirect: 'error' });
      };`;
    child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(restrictFetch)}`, '--import', 'tsx', 'src/command-main.ts'], {
      cwd: new URL('../../apps/server/', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = once(child, 'exit');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-8000); });
    for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt++) {
      const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) }).catch(() => null);
      if (health?.ok) return;
      await delay(50);
    }
    assert.fail(`Commands server did not start:\n${log}`);
  }
  async function request(method, path, body, { headers = {}, version, status = 200 } = {}) {
    const result = await fetch(`${origin}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(8000), headers: {
      origin, ...(method !== 'GET' && { 'idempotency-key': randomUUID() }),
      ...(version != null && { 'if-match': String(version) }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await result.text();
    assert.equal(result.status, status, `${method} ${path}\n${text}\n${result.status >= 500 ? log : ''}`);
    const mediaType = result.headers.get('content-type')?.split(';')[0].trim();
    const json = text && (mediaType === 'application/json' || mediaType?.endsWith('+json')) ? JSON.parse(text) : undefined;
    return { headers: result.headers, json, text };
  }
  await start();
  const setup = await request('POST', '/api/v1/setup', { ...owner, workspaceName: 'Cross-border launch acceptance' }, {
    headers: { 'x-setup-token': setupToken }, status: 201,
  });
  const wid = setup.json.workspaces[0].id;
  async function session(credential) {
    const login = await request('POST', '/api/v1/session', credential);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const csrf = await request('GET', '/api/v1/session/csrf', undefined, { headers: { cookie } });
    const headers = { cookie, 'x-csrf-token': csrf.json.csrf_token };
    const workspace = login.json.workspaces.find(row => row.id === wid);
    assert.ok(workspace);
    const call = async (method, path, body, options) => {
      const r = await request(method, `/api/v1/workspaces/${wid}${path}`, body, { ...options, headers });
      return r.json?.data ?? r.json;
    };
    return { user: login.json.user, role: workspace.role, call, get: path => call('GET', path),
      post: (path, body = {}, options) => call('POST', path, body, options) };
  }
  const author = await session(owner);
  const invite = await author.post('/members/invite', { email: reviewer.email, role: 'reviewer' });
  await request('POST', '/api/v1/member-invitations/accept', { ...reviewer, token: invite.invitation_token }, { status: 204 });
  const approver = await session(reviewer);
  assert.equal(author.role, 'owner');
  assert.equal(approver.role, 'reviewer');
  assert.notEqual(author.user.id, approver.user.id);
  return { author, approver, wid, request, restart: async () => { await stop(); await start(); return session(owner); } };
}

async function importCsv(author, path, body) {
  const preview = await author.post(path, body);
  const result = await author.post(`/imports/${preview.id}/confirm`, {});
  assert.ok(preview.id);
  return result;
}

test('plan §7.1 uses one campaign from catalog CSV to frozen closeout', { timeout: 60_000 }, async t => {
  const { author, approver, wid, restart } = await fixture(t);
  const { get, post, call } = author;
  const brand = await post('/brands', { name: 'Launch Laboratory', slug: 'launch-laboratory' });
  const markets = [];
  for (const [name, country_code, primary_language, currency, timezone] of [
    ['US', 'US', 'en-US', 'USD', 'America/New_York'], ['Japan', 'JP', 'ja-JP', 'JPY', 'Asia/Tokyo'],
  ]) markets.push(await post(`/brands/${brand.id}/markets`, { name, country_code, primary_language, currency, timezone }));
  const [us, jp] = markets;
  const store = await post('/stores', { brand_id: brand.id, provider: 'shopify', name: 'Synthetic launch shop', default_currency: 'USD', default_locale: 'en-US' });
  for (const market of markets) await call('PUT', `/stores/${store.id}/markets`, { market_id: market.id, channel: 'online_store', price_source: 'store_base_price' });
  await importCsv(author, `/stores/${store.id}/imports`, {
    csv: 'external_product_id,external_variant_id,handle,title,sku,option1,price,currency\r\nP-1,V-1,launch-mug,"Travel Mug, 300 mL",LAUNCH-300,Blue,19.99,USD\r\n',
  });
  const [hit] = await get(`/products?query=LAUNCH-300&store_id=${store.id}`);
  const product = await get(`/products/${hit.id}`);
  const [sku] = product.variants;
  assert.equal(product.title, 'Travel Mug, 300 mL');
  assert.equal(sku.sku, 'LAUNCH-300');
  assert.equal(sku.store_id, store.id);
  const listings = await get(`/variants/${sku.id}/listings`);
  assert.ok(listings.length, JSON.stringify(listings));
  t.diagnostic(`01 workspace=${wid} sku=${sku.id} store=${store.id} markets=${us.id},${jp.id}`);

  const campaign = await post('/campaigns', { brand_id: brand.id, name: 'Travel mug launch', kind: 'launch',
    starts_at: iso(-oneDay), ends_at: iso(oneDay), timezone: 'UTC', owner_user_id: author.user.id,
    markets: [{ market_id: us.id, locales: ['en-US'] }, { market_id: jp.id, locales: ['ja-JP'] }],
    products: [{ product_id: product.id, variant_ids: [sku.id], market_ids: [us.id, jp.id], role: 'hero' }],
    goals: [{ metric_key: 'views', unit: 'count', baseline_value: 0, baseline_source: 'No previous campaign', target_value: 25, due_at: iso(oneDay) }],
  });
  const ca = `/campaigns/${campaign.id}`;
  const brief = await post(`${ca}/briefs`, { title: 'Launch brief', revision: { markdown: '# Launch\nIntroduce the travel mug in the US and Japan.' } });
  const briefPath = `/brief-revisions/${brief.revision.id}`;
  const submittedBrief = await post(`${briefPath}/submit`, {}, { version: brief.revision.version });
  const approvedBrief = await post(`${briefPath}/approve`, {}, { version: submittedBrief.version });
  const context = await get(ca);
  assert.equal(approvedBrief.status, 'approved');
  assert.equal(context.id, campaign.id);
  assert.equal(context.version, campaign.version);
  assert.deepEqual(context.markets.map(row => [row.market_id, row.locales]).sort(), [[us.id, ['en-US']], [jp.id, ['ja-JP']]].sort());
  assert.deepEqual(context.products.map(row => [row.product_id, row.variant_ids]), [[product.id, [sku.id]]]);
  assert.deepEqual(context.briefs.map(row => row.approved_revision.id), [approvedBrief.id]);
  const transition = (current, to) => post(`${ca}/transition`, { to }, { version: current.version });
  const planned = await transition(context, 'planned');
  const active = await transition(planned, 'active');
  assert.equal(active.status, 'active');

  const milestone = await post(`${ca}/milestones`, { title: 'Production sign-off', due_at: iso(oneDay), gate: 'ready_for_scheduling', assignee_id: author.user.id });
  const workPath = `/work-items/${milestone.id}`;
  const started = await call('PATCH', workPath, { status: 'in_progress' }, { version: milestone.version });
  await post(`${workPath}/complete`, {}, { version: started.version });
  assert.equal((await get(workPath)).status, 'done');
  const idea = await post('/ideas', { brand_id: brand.id, campaign_id: campaign.id, title: 'Show the travel mug in use',
    origin_refs: [{ type: 'brief_revision', id: approvedBrief.id }] });
  const { item } = await post(`/ideas/${idea.id}/convert`, { campaign_id: campaign.id });
  assert.equal(item.campaign_id, campaign.id);
  const revisions = [];
  for (const [market, caption] of [[us, 'A travel mug for the morning commute.'], [jp, '通勤に便利なトラベルマグ。']]) {
    const { variant } = await post(`/content-items/${item.id}/variants`, { platform: 'facebook', format: 'text',
      market_id: market.id, locale: market.primary_language, body_markdown: caption });
    const revision = await post(`/content-variants/${variant.id}/revisions`, { expected_version: variant.version, base_revision_id: null });
    assert.equal(variant.locale, market.primary_language);
    assert.equal(variant.market, market.id);
    revisions.push({ variant, revision });
  }
  const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: '451', display_name: 'Synthetic launch account',
    brand_id: brand.id, owned_account_confirmed: true });
  const { variant, revision } = revisions[0];
  const target = await post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id, variant_revision_id: revision.id,
    scheduled_at: iso(oneDay / 2), schedule_tz: 'UTC' });
  const targetPath = `/publish-targets/${target.id}`;
  const submitted = await post(`${targetPath}/submit`, {}, { version: target.version });
  assert.equal(submitted.plan_status, 'awaiting_approval', JSON.stringify(submitted));
  const approved = await approver.post(`${targetPath}/approve`, {}, { version: submitted.version });
  assert.equal(approved.plan_status, 'ready', JSON.stringify(approved));
  assert.equal(approved.frozen_hash, submitted.frozen_hash);
  const preflight = await post(`${targetPath}/precheck`, { stage: 'preflight' });
  assert.equal(preflight.publish_target_id, target.id);
  assert.equal(preflight.stage, 'preflight');
  assert.notEqual(preflight.overall, 'blocked', JSON.stringify(preflight.items));

  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64');
  const ticket = await post('/files/uploads', { purpose: 'evidence', mime_type: 'image/png', size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  const evidence = await post(`/files/uploads/${ticket.id}/complete`, { base64: bytes.toString('base64') });
  const publishedAt = iso(-3_600_000);
  const publication = await post(`${targetPath}/register-post`, { external_post_id: '452', permalink: 'https://www.facebook.com/451/posts/452',
    published_at: publishedAt, evidence_file_ids: [evidence.id] });
  assert.equal(publication.verification, 'manual_confirmed');
  assert.equal(publication.publish_target_id, target.id);
  assert.equal((await get(targetPath)).campaign_id, campaign.id);
  const { execution_task_id: taskId } = publication;
  const execution = await get(`/execution-tasks/${taskId}`);
  assert.equal(execution.status, 'published');
  assert.equal(execution.platform_post.id, publication.id);
  assert.equal(execution.publish_target_id, target.id);
  assert.deepEqual(execution.attempts.map(row => [row.executor, row.status]), [['manual', 'verified_published']]);
  assert.equal((await get(ca)).progress.published, 1);

  const { items: [{ conversation, message }] } = await post('/inbox/ingest', { messages: [{ brand_id: brand.id,
    social_account_id: account.id, provider: 'meta_facebook', external_message_id: 'launch-comment', kind: 'comment_thread',
    external_user_id: 'launch-shopper', platform_post_id: publication.id, external_url: publication.permalink,
    body_text: 'How much does this mug hold?', platform_created_at: iso(-60_000),
  }] });
  const conversationPath = `/conversations/${conversation.id}`;
  assert.equal(conversation.platform_post_id, publication.id);
  const assigned = await call('PATCH', conversationPath, { assignee_user_id: author.user.id }, { version: conversation.version });
  assert.equal(assigned.assignee_user_id, author.user.id);
  const lease = await post(`${conversationPath}/occupancy`, { purpose: 'reply' });
  const reply = await post(`${conversationPath}/reply-drafts`, { body_text: 'This travel mug holds 300 mL.', reply_mode: 'public_reply', in_reply_to_message_id: message.id });
  const replyPath = `/reply-drafts/${reply.id}`;
  const pendingReply = await post(`${replyPath}/submit-approval`, {}, { version: reply.version });
  const approvedReply = await approver.post(`${replyPath}/approve`, {}, { version: pendingReply.version });
  const outbound = await post(`${replyPath}/send`, { mode: 'manual', fencing_token: lease.fencing_token }, { version: approvedReply.version });
  const outboundPath = `/outbound-replies/${outbound.id}`;
  const replyUrl = `${publication.permalink}?comment_id=453`;
  const delivered = await post(`${outboundPath}/manual-complete`, {
    fencing_token: lease.fencing_token, platform_url: replyUrl,
  }, { version: outbound.version });
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.verification, 'manual_evidence');
  const replyStatus = await get(outboundPath);
  assert.equal(replyStatus.reply.id, outbound.id);
  assert.equal(replyStatus.reply.conversation_id, conversation.id);
  assert.deepEqual(replyStatus.attempts.map(row => [row.executor, row.outcome, row.platform_url]), [['manual', 'delivered', replyUrl]]);
  assert.equal((await get(conversationPath)).conversation.status, 'waiting_customer');
  const occupancyPath = `${conversationPath}/occupancy`;
  const deniedRelease = await call('DELETE', occupancyPath, undefined, { status: 409 });
  assert.equal(deniedRelease.code, 'LEASE_HELD');
  assert.deepEqual(await call('DELETE', occupancyPath, { fencing_token: lease.fencing_token }), { released: true });

  const views = 'norm.post.views';
  const observe = (secondsAfterPublication, value) => post('/metrics/observations', { observations: [{
    metric_key: views, subject_type: 'platform_post', subject_id: publication.id,
    observed_at: new Date(Date.parse(publishedAt) + secondsAfterPublication * 1000).toISOString(), value,
    dims: { campaign_id: campaign.id }, availability: 'observed', source: { method: 'manual_import' },
  }] });
  await observe(600, 15);
  const report = await post('/reports', { title: 'Travel mug launch report', kind: 'campaign', scope: { campaign_ids: [campaign.id] },
    period: { from: day(-oneDay), to: day(oneDay), tz: 'UTC' }, sections: [{ key: 'views', type: 'table',
      query: { metrics: [views], subject: { type: 'platform_post', filter: { subject_ids: [publication.id], campaign_ids: [campaign.id] } },
        time: { basis: 'published_at' }, age_bucket: '24h' } }],
  });
  const draft = await completedReportVersion(get, await post(`/reports/${report.id}/versions`, {}, { status: 202 }));
  const frozen = await post(`/report-versions/${draft.id}/finalize`, {}, { version: draft.version });
  const reportValue = version => version.results[0].data.rows[0].values[views].value;
  assert.equal(reportValue(frozen), 15);
  const wrapping = await transition(await get(ca), 'wrapping');
  const preview = await post(`${ca}/closeout/draft`);
  assert.deepEqual(preview.facts.unfinished, []);
  const closeout = await post(`${ca}/closeout`, { report_version_id: frozen.id, retrospective_doc: doc('Retain the bilingual product copy.') }, { version: wrapping.version });
  assert.equal(closeout.campaign_id, campaign.id);
  assert.equal(closeout.report_version_id, frozen.id);
  assert.deepEqual(await get(`${ca}/closeout`), closeout);
  assert.equal((await get(ca)).status, 'closed');

  await observe(1200, 75);
  const backfill = await post(`${ca}/reports/${report.id}/backfill`);
  assert.notEqual(backfill.id, frozen.id);
  assert.equal(backfill.version_no, 2);
  assert.equal(reportValue(backfill), 75);
  const reopened = await restart();
  assert.equal((await reopened.get(ca)).status, 'closed');
  assert.deepEqual(await reopened.get(`${ca}/closeout`), closeout);
  assert.deepEqual(await reopened.get(`/report-versions/${frozen.id}`), frozen);
  assert.equal(reportValue(await reopened.get(`/report-versions/${backfill.id}`)), 75);
  t.diagnostic(`campaign=${campaign.id} post=${publication.id} report=${frozen.id} closeout=${closeout.id}`);
});
