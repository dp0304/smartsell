import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { makeContext } from '../../apps/server/src/context.ts';
import { ingestPlatformMessage, startReplyDispatch, recordReplyReceipt } from '../../apps/server/src/modules/inbox/index.ts';
import { commandContext } from '../../apps/server/src/modules/inbox/operations.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileStore } from '../../packages/db/src/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { createServer } from '../../apps/server/src/server.ts';

async function fixture(t, subscriber) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-engagement-'));
  const setupToken = 'engagement-test-token';
  const store = await fileStore(join(directory, 'state.sqlite'));
  const discovered = await discoverOperations();
  const app = createServer({ config: configuration({ SETUP_TOKEN: setupToken, HOST: '127.0.0.1', ROLE: 'all' }),
    store, ...discovered, subscribers: [...discovered.subscribers, ...(subscriber ? [subscriber] : [])] });
  t.after(async () => { await app.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const setup = await fetch(`${origin}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': setupToken }, body: JSON.stringify({ email: 'owner@example.test', name: 'Owner', workspaceName: 'Engagement', password: 'acceptance-only-1234' }) });
  assert.equal(setup.status, 201);
  const { csrf_token: csrf, workspaces, user } = (await setup.json()).data;
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const prefix = `${origin}/api/v1/workspaces/${workspaces[0].id}`;
  const call = async (method, path, body, { status = 200, version, key } = {}) => {
    const response = await fetch(prefix + path, { method, headers: { cookie, 'x-csrf-token': csrf,
      ...(version && { 'if-match': String(version) }), ...(key && { 'idempotency-key': key }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const content = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${content}`);
    return content ? JSON.parse(content).data : undefined;
  };
  const ingest = (extra = {}, overrides = {}) => call('POST', '/inbox/ingest', { messages: [{ brand_id: 'brand', social_account_id: 'account', provider: 'meta_facebook',
    external_message_id: 'comment-1', kind: 'comment_thread', external_user_id: 'external-1', display_name: '同暱稱',
    external_url: 'https://social.example.test/posts/1', body_text: '原始評論', platform_created_at: '2026-11-20T00:00:00Z', ...extra }] }, overrides);
  const conversations = async () => {
    const result = await call('GET', '/conversations');
    return Array.isArray(result) ? result : result.items;
  };
  const workspaceId = workspaces[0].id;
  const scope = await store.transaction({ readOnly: true }, ({ identity }) => ({
    workspaceId, actorId: user.id, tenantId: identity.get(`workspace/${workspaceId}`).tenantId,
  }));
  const seed = run => store.transaction({}, async tx => run(makeContext(await tx.workspace(scope), scope, 'owner')));
  return { call, ingest, conversations, user, seed };
}

test('IN06 records moderation with intact original and actor, and keeps private messages out', async t => {
  const { call, ingest, conversations, user } = await fixture(t);
  await ingest();
  await ingest({ kind: 'private_thread', external_message_id: 'dm-1', external_thread_id: 'dm-thread' });
  const rows = await conversations();
  const comment = rows.find(row => row.kind === 'comment_thread');
  const dm = rows.find(row => row.kind === 'private_thread');
  const detail = await call('GET', `/conversations/${comment.id}`);
  const privateDetail = await call('GET', `/conversations/${dm.id}`);
  const path = `/conversations/${comment.id}/moderation`;
  assert.deepEqual(await call('GET', path), { mode: 'manual_only', source_url: 'https://social.example.test/posts/1', actions: [] });
  assert.equal((await call('GET', `/conversations/${dm.id}/moderation`)).mode, 'unavailable');
  const body = { message_id: detail.messages[0].id, action: 'hide', source_url: 'https://social.example.test/posts/1', reason: '人工確認', confirmed_on_platform: true };
  await call('POST', path, { ...body, message_id: privateDetail.messages[0].id }, { status: 422 });
  await call('POST', path, { ...body, confirmed_on_platform: false }, { status: 422 });
  const audit = await call('POST', path, body);
  assert.equal(audit.actor_id, user.id);
  assert.equal(audit.original_text, '原始評論');
  assert.equal(audit.status, 'operator_reported');
  await ingest({ body_text: '平台編輯後', platform_updated_at: '2026-11-20T00:05:00Z' });
  assert.equal((await call('GET', path)).actions[0].original_text, '原始評論');
  assert.equal((await call('GET', `/conversations/${comment.id}`)).messages[0].untrusted_content.body_text, '平台編輯後');
});

test('IN07 and EM01 leave same-nickname participants separate and audit manual linking and undo', async t => {
  const { call, ingest, conversations, user } = await fixture(t);
  await ingest();
  await ingest({ social_account_id: 'account-2', provider: 'meta_instagram', external_message_id: 'comment-2', external_user_id: 'external-2' });
  const [first, second] = await conversations();
  const firstPath = `/conversations/${first.id}/customer-link`;
  const secondPath = `/conversations/${second.id}/customer-link`;
  const one = await call('GET', firstPath);
  const two = await call('GET', secondPath);
  assert.equal(one.participant.display_name, two.participant.display_name);
  assert.notEqual(one.participant.id, two.participant.id);
  assert.equal(one.customer, null);
  assert.equal(two.customer, null);
  assert.deepEqual(await call('GET', '/cases'), []);
  assert.deepEqual(await call('GET', '/customers'), []);
  const customer = await call('POST', '/customers', { brand_id: 'brand' });
  const identity = await call('POST', `/customers/${customer.id}/identities`, { kind: 'social_participant', namespace: 'acceptance',
    value_hash: createHash('sha256').update('customer-1').digest('hex'), verified: true, verification_method: 'manual_evidence', evidence_ids: ['fixture-confirmation'] }, { version: customer.version });
  const link = `/inbox/participants/${one.participant.id}/link-customer`;
  await call('POST', link, { customer_identity_id: identity.id }, { version: one.participant.version, status: 422 });
  const linked = await call('POST', link, { customer_identity_id: identity.id, manual_confirmation: 'Verified independently with customer' }, { version: one.participant.version });
  assert.equal((await call('GET', firstPath)).customer.id, customer.id);
  assert.equal((await call('GET', secondPath)).customer, null);
  await call('DELETE', link, { reason: 'Customer requested correction' }, { version: linked.version });
  const undone = await call('GET', firstPath);
  assert.equal(undone.customer, null);
  assert.equal(undone.history.length, 2);
  assert.deepEqual(undone.history.map(row => row.actor_id), [user.id, user.id]);
  assert.ok(undone.history.some(row => row.prior_identity_id === identity.id && row.reason === 'Customer requested correction'));
});

test('IN10 separates public reviews from DMs and supports handoff and manual verification only', async t => {
  const { call, ingest, conversations, user } = await fixture(t);
  const sourceUrl = 'https://reviews.example.test/shop';
  const source = await call('POST', '/inbox/review-sources', { label: 'External reviews', source_url: sourceUrl });
  const importPath = `/inbox/review-sources/${source.id}/import`;
  const rating = { external_review_id: 'review-1', source_url: `${sourceUrl}/1`, rating: 4, scale_max: 5, email: 'private@example.test' };
  await call('POST', importPath, { ...rating, source_url: 'https://different.example.test/1' }, { status: 422 });
  const review = await call('POST', importPath, rating);
  await ingest({ kind: 'review' }, { status: 422 });
  await ingest({ kind: 'private_thread', external_thread_id: 'private-1' });
  assert.deepEqual((await conversations()).map(row => row.kind), ['private_thread']);
  assert.equal((await call('GET', '/reviews'))[0].id, review.id);
  assert.equal(review.editable_by_brand, false);
  assert.equal(review.reply_capability, 'unknown');
  assert.equal(JSON.stringify(review).includes('private@example.test'), false);
  const path = `/reviews/${review.id}`;
  await call('DELETE', path, undefined, { status: 404 });
  const verification = { reply_url: `${sourceUrl}/1#reply`, evidence_note: '對照平台已顯示回覆' };
  await call('POST', `${path}/verify-reply`, verification, { version: review.version, status: 409 });
  const handed = await call('POST', `${path}/handoff`, { assignee_user_id: user.id }, { version: review.version });
  assert.equal(handed.status, 'handed_off');
  await call('POST', `${path}/verify-reply`, { ...verification, reply_url: 'https://another.example.test/reply' }, { version: handed.version, status: 422 });
  assert.deepEqual((await call('GET', path)).verification_history, []);
  const reply = await call('POST', `${path}/verify-reply`, verification, { version: handed.version });
  assert.equal(reply.status, 'reply_verified_manually');
  await call('POST', `${path}/handoff`, { assignee_user_id: user.id }, { version: reply.version, status: 409 });
  const updated = await call('POST', importPath, { ...rating, rating: 0 });
  assert.equal(updated.id, review.id);
  assert.equal(updated.rating, 0);
  assert.equal(updated.status, 'reply_verified_manually');
  const [observed] = (await call('GET', path)).verification_history;
  assert.equal(observed.verification, 'manual');
  assert.equal(observed.actor_id, user.id);
  assert.equal(observed.reply_url, `${sourceUrl}/1#reply`);
  assert.equal(observed.evidence_note, '對照平台已顯示回覆');
  await call('POST', importPath, { ...rating, external_review_id: 'review-2', rating: 8, scale_max: 10 });
  const summary = await call('GET', '/inbox/review-summary');
  assert.equal(summary.coverage, 'imported_public_reviews');
  assert.deepEqual(summary.items.sort((a, b) => a.scale_max - b.scale_max), [
    { source_id: source.id, scale_max: 5, sample_count: 1, replies_verified_manually: 1, average_rating: 0 },
    { source_id: source.id, scale_max: 10, sample_count: 1, replies_verified_manually: 0, average_rating: 8 },
  ]);
});

test('EM01 rechecks channel consent on every ESP scheduling request', async t => {
  const { call } = await fixture(t);
  const brand = await call('POST', '/brands', { name: 'Consent brand', slug: 'consent-brand' });
  const brand_id = brand.id;
  const customer = await call('POST', '/customers', { brand_id });
  const consentPath = `/customers/${customer.id}/consents`;
  const draft = async channel => {
    const copy = await call('POST', '/consent-texts', { channel, purpose: 'marketing', locale: 'en', text: `${channel} updates` });
    await call('POST', consentPath, { channel, purpose: 'marketing', source: 'support_request', action: 'opt_in',
      source_ref: `opt-in-${channel}`, evidence_ids: [`evidence-${channel}`], consent_text_version_id: copy.id });
    const segment = await call('POST', '/segments', { brand_id, name: `${channel} audience`, required_consent: { channel, purpose: 'marketing' } });
    const account = await call('POST', '/esp-accounts', { brand_id, channel, provider: 'klaviyo', external_account_id: `account-${channel}`, is_sending_system_of_record: true });
    return call('POST', '/esp-campaigns', { esp_account_id: account.id, segment_version_id: segment.current_version_id, template_ref: 'newsletter' });
  };
  const email = await draft('email');
  const sms = await draft('sms');
  const submit = (campaign, action, status = 200) => call('POST', `/esp-campaigns/${campaign.id}/${action}`, {}, { version: campaign.version, status });
  assert.equal((await submit(email, 'schedule')).status, 'manual_required');
  await call('POST', consentPath, { channel: 'email', purpose: 'marketing', source: 'unsubscribe_link', action: 'withdrawn',
    source_ref: 'email-unsubscribe', evidence_ids: ['withdrawal-receipt'] });
  await submit(email, 'schedule', 409);
  await submit(email, 'test-send', 409);
  assert.equal((await submit(sms, 'schedule')).status, 'manual_required');
  assert.equal((await call('GET', `/esp-campaigns/${email.id}`)).status, 'draft');
});

test('EM02 retains separate audience previews and immutable ESP send observations', async t => {
  const { call } = await fixture(t);
  const { id: brand_id } = await call('POST', '/brands', { name: 'Audience', slug: 'audience' });
  const segment = await call('POST', '/segments', { brand_id, name: 'Email audience', required_consent: { channel: 'email', purpose: 'marketing' } });
  const segmentPath = `/segments/${segment.id}`;
  const preview = await call('POST', `${segmentPath}/preview`, {});
  assert.equal(preview.eligible_count, 0);
  const account = await call('POST', '/esp-accounts', { brand_id, channel: 'email', provider: 'fixture', external_account_id: 'account' });
  const draft = { esp_account_id: account.id, segment_version_id: segment.current_version_id, template_ref: 'newsletter' };
  const campaign = await call('POST', '/esp-campaigns', draft);
  const campaignPath = `/esp-campaigns/${campaign.id}`;
  const path = `${campaignPath}/send-observation`;
  const observation = { external_campaign_id: 'campaign-1', source_ref: 'message-report-1', esp_count: 3, sent_at: new Date(Date.now() - 1000).toISOString() };
  await call('POST', path, { ...observation, sent_at: new Date(Date.now() + 60_000).toISOString() }, { status: 422 });
  const actual = await call('POST', path, observation);
  assert.equal(actual.purpose, 'send_execution');
  assert.equal(actual.esp_count, 3);
  assert.equal(actual.eligible_count, undefined);
  assert.equal(actual.member_hash, undefined);
  assert.deepEqual(await call('POST', path, observation), actual);
  await call('POST', path, { ...observation, esp_count: 5 }, { status: 409 });
  const duplicate = await call('POST', '/esp-campaigns', draft);
  await call('POST', `/esp-campaigns/${duplicate.id}/send-observation`, observation, { status: 409 });
  assert.equal((await call('GET', campaignPath)).send_snapshot_id, actual.id);
  const saved = await call('GET', `${segmentPath}/snapshots`);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.find(row => row.purpose === 'preview'), preview);
  assert.deepEqual(saved.find(row => row.purpose === 'send_execution'), actual);
});

test('EM05 reports channel coverage and keeps ESP opens, clicks and purchases separate', async t => {
  const { call } = await fixture(t);
  const { id: brand_id } = await call('POST', '/brands', { name: 'Delivery health', slug: 'delivery-health' });
  const account = channel => call('POST', '/esp-accounts', { brand_id, channel, provider: 'fixture', external_account_id: `health-${channel}` });
  const email = await account('email');
  await account('sms');
  const path = '/lifecycle/health';
  const now = Date.now();
  const dayAgo = days => new Date(now - days * 86_400_000).toISOString();
  await call('POST', path, { esp_account_id: email.id, source_ref: 'email-report-1', period_from: dayAgo(4),
    period_until: dayAgo(3), observed_at: dayAgo(2), sent: 10, opened: 5, clicked: 2, purchased: 0 });
  const report = await call('GET', `${path}?brand_id=${brand_id}`);
  assert.deepEqual(Object.fromEntries(report.channel_coverage.map(row => [row.channel, row.coverage])), {
    email: 'imported_esp_reports_only', sms: 'no_report_in_period', whatsapp: 'not_connected', push: 'not_connected',
  });
  const [snapshot] = report.snapshots;
  assert.equal(snapshot.opened, 5);
  assert.equal(snapshot.clicked, 2);
  assert.equal(snapshot.purchased, 0);
  assert.equal(snapshot.bounced, undefined);
  assert.equal((await call('GET', `${path}?${new URLSearchParams({ brand_id, from: dayAgo(1) })}`)).coverage, 'unavailable');
});

test('IN08 reports SLA samples and policy-excluded time through the inbox API', async t => {
  const { call, ingest, conversations, seed } = await fixture(t);
  await call('POST', '/inbox/sla-policies', { name: 'Support', conditions: { social_account_id: 'account' },
    first_response_minutes: 10, resolution_minutes: 60, pause_on_status: ['waiting_customer'] });
  await ingest({ platform_created_at: new Date().toISOString() });
  await ingest({ social_account_id: 'other-account', external_message_id: 'other-comment', platform_created_at: new Date().toISOString() });
  const conversation = (await conversations()).find(row => row.social_account_id === 'account');
  const path = `/conversations/${conversation.id}`;
  const sample = '/inbox/sla-sample';
  const baseline = { sample_count: 1, without_policy_count: 1, first_response_count: 0, resolution_count: 0, policy_pause_seconds: 0 };
  assert.deepEqual(await call('GET', sample), baseline);
  const waiting = await call('PATCH', path, { status: 'waiting_customer' }, { version: conversation.version });
  // Move the pause fixture back so the HTTP report can be checked without a wall-clock delay.
  await seed(ctx => {
    const row = ctx.list('conversation_sla').find(item => item.conversation_id === conversation.id);
    assert.ok(row?.paused_at);
    ctx.update('conversation_sla', row.id, { paused_at: new Date(Date.now() - 65 * 60_000).toISOString() });
  });
  const during = await call('GET', sample);
  assert.ok(during.policy_pause_seconds >= 3900);
  assert.deepEqual({ ...during, policy_pause_seconds: 0 }, baseline);
  await call('PATCH', path, { status: 'resolved' }, { version: waiting.version });
  const after = await call('GET', sample);
  assert.ok(after.policy_pause_seconds >= during.policy_pause_seconds);
  assert.deepEqual({ ...after, policy_pause_seconds: 0 }, { ...baseline, resolution_count: 1 });
});

async function approveReply(call, path, body) {
  const draft = await call('POST', `${path}/reply-drafts`, { reply_mode: 'public_reply', body_text: body });
  const pending = await call('POST', `/reply-drafts/${draft.id}/submit-approval`, {}, { version: draft.version });
  return call('POST', `/reply-drafts/${draft.id}/approve`, {}, { version: pending.version });
}

test('IN03 sends only the approved reply to a loopback executor and reconciles platform readback', async t => {
  const captures = [];
  const platform = httpServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/comments') {
      const data = [];
      for await (const chunk of req) data.push(chunk);
      captures.push(JSON.parse(Buffer.concat(data)));
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'fixture-reply' }));
    } else if (req.method === 'GET' && req.url === '/comments/fixture-reply' && captures.length) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'fixture-reply', ...captures[0] }));
    } else res.writeHead(404).end();
  });
  platform.listen(0, '127.0.0.1');
  await once(platform, 'listening');
  t.after(() => new Promise(resolve => platform.close(resolve)));
  const origin = `http://127.0.0.1:${platform.address().port}`;
  const { call, ingest, seed } = await fixture(t, {
    id: 'inbox.loopback-fixture', accepts: type => type === 'inbox.reply.submitted',
    async run(ctx, event) {
      if (event.data.executor !== 'api') return;
      const cmd = commandContext(ctx);
      const { attempt, payload } = await startReplyDispatch(cmd, event.data.outbound_reply_id, event.id);
      const response = await fetch(`${origin}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 201);
      const { id } = await response.json();
      await recordReplyReceipt(cmd, attempt.id, { outcome: 'accepted', receipt_ref: id });
      const observed = await fetch(`${origin}/comments/${id}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(observed.status, 200);
      const result = await observed.json();
      await ingestPlatformMessage(cmd, { brand_id: 'brand', social_account_id: result.social_account_id, provider: 'meta_facebook',
        kind: 'comment_thread', direction: 'outbound', source: 'poll', external_message_id: result.id,
        parent_external_id: result.target_external_id, body_text: result.body_text, platform_created_at: ctx.now });
    },
  });
  await seed(ctx => ctx.create('inbox_capability', { social_account_id: 'account', capability: 'comment.reply', status: 'available' }));
  const { conversation } = (await ingest({ platform_created_at: new Date().toISOString() })).items[0];
  const path = `/conversations/${conversation.id}`;
  const secret = 'Private note must stay within inbox';
  await call('POST', `${path}/notes`, { body: secret });
  const body = 'Thanks for contacting support';
  const approved = await approveReply(call, path, body);
  const lease = await call('POST', `${path}/occupancy`, { purpose: 'reply' });
  const queued = await call('POST', `/reply-drafts/${approved.id}/send`, { mode: 'api', fencing_token: lease.fencing_token }, { version: approved.version, key: 'inbox-fixture-send-01' });
  assert.equal(queued.status, 'queued');
  const deliveryPath = `/outbound-replies/${queued.id}`;
  let delivery;
  for (let i = 0; i < 40; i++) {
    delivery = await call('GET', deliveryPath);
    if (delivery.reply.status === 'accepted') break;
    await delay(150);
  }
  assert.equal(delivery.reply.status, 'accepted');
  assert.equal(delivery.attempts.length, 1);
  assert.equal(delivery.receipts[0].receipt_ref, 'fixture-reply');
  assert.deepEqual(captures, [{ social_account_id: 'account', target_external_id: 'comment-1', reply_mode: 'public_reply', body_text: body }]);
  const delivered = await call('POST', `${deliveryPath}/reconcile`, {});
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.verification, 'platform_readback');
  const detail = await call('GET', path);
  assert.equal(detail.messages.find(row => row.id === delivered.result_message_id).untrusted_content.body_text, body);
  assert.equal(detail.notes[0].body, secret);
  assert.ok(!JSON.stringify(detail.messages).includes(secret));
});

test('IN11 audits occupied and already-replied skips without modifying the linked customer consent ledger', async t => {
  const { call, ingest } = await fixture(t);
  const brand = await call('POST', '/brands', { name: 'Support', slug: 'support' });
  const account = await call('POST', '/social-accounts', { provider: 'meta_facebook', external_account_id: 'fixture-account',
    display_name: 'Support page', brand_id: brand.id, owned_account_confirmed: true });
  const customer = await call('POST', '/customers', { brand_id: brand.id });
  const identity = await call('POST', `/customers/${customer.id}/identities`, {
    kind: 'social_participant', namespace: 'acceptance', value_hash: createHash('sha256').update('rule-fixture').digest('hex'),
    verified: true, verification_method: 'manual_evidence', evidence_ids: ['customer-confirmation'],
  }, { version: customer.version });
  const consentPath = `/customers/${customer.id}/consents`;
  await call('POST', consentPath, { channel: 'platform_dm', purpose: 'marketing', action: 'opt_out', source: 'support_request',
    source_ref: 'customer-marketing-choice', evidence_ids: ['customer-opt-out'] });
  const baseline = await call('GET', consentPath);
  assert.equal(baseline.records.length, 1);
  assert.equal(baseline.states.find(row => row.channel === 'platform_dm' && row.purpose === 'marketing').state, 'opted_out');
  const rule = await call('POST', '/inbox/auto-rules', { trigger: 'keyword', keyword: 'help', social_account_id: account.id,
    body_text: 'Rule draft only', window_minutes: 60, max_per_participant_per_day: 5 });
  const rulePath = `/inbox/auto-rules/${rule.id}`;
  const enabled = await call('PATCH', rulePath, { enabled: true }, { version: rule.version });
  const base = { brand_id: brand.id, social_account_id: account.id, body_text: 'Help with an order', platform_created_at: new Date().toISOString() };
  const occupied = (await ingest(base)).items[0];
  const replied = (await ingest({ ...base, external_message_id: 'comment-2' })).items[0];
  assert.notEqual(occupied.conversation.id, replied.conversation.id);
  const participant = await call('GET', `/conversations/${occupied.conversation.id}/customer-link`);
  await call('POST', `/inbox/participants/${participant.participant.id}/link-customer`, { customer_identity_id: identity.id,
    manual_confirmation: 'Customer confirmed both records' }, { version: participant.participant.version });
  assert.equal((await call('GET', `/conversations/${replied.conversation.id}/customer-link`)).customer.id, customer.id);
  await call('POST', `/conversations/${occupied.conversation.id}/occupancy`, { purpose: 'reply' });
  const replyPath = `/conversations/${replied.conversation.id}`;
  const lease = await call('POST', `${replyPath}/occupancy`, { purpose: 'reply' });
  const approved = await approveReply(call, replyPath, 'Personal support reply');
  const manual = await call('POST', `/reply-drafts/${approved.id}/send`, { mode: 'manual', fencing_token: lease.fencing_token }, { version: approved.version, key: 'inbox-manual-01' });
  await call('POST', `/outbound-replies/${manual.id}/manual-complete`, {
    fencing_token: lease.fencing_token, platform_url: 'https://social.example.test/comments/manual-evidence',
  }, { version: manual.version });
  assert.equal((await call('GET', replyPath)).conversation.status, 'waiting_customer');
  await call('DELETE', `${replyPath}/occupancy`, { fencing_token: lease.fencing_token });
  for (const [entry, outcome] of [[occupied, 'skipped_occupied'], [replied, 'skipped_replied']]) {
    const endpoint = `/inbox/messages/${entry.message.id}/evaluate-rules`;
    const runs = await call('POST', endpoint, {});
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, outcome);
    assert.equal(runs[0].rule_version, enabled.version);
    assert.equal(runs[0].reply_draft_id, null);
    assert.deepEqual(await call('POST', endpoint, {}), runs);
  }
  const audit = await call('GET', `${rulePath}/runs`);
  assert.deepEqual(Object.fromEntries(audit.map(row => [row.message_id, row.outcome])), {
    [occupied.message.id]: 'skipped_occupied', [replied.message.id]: 'skipped_replied',
  });
  assert.deepEqual(await call('GET', '/inbox/auto-reply-review'), []);
  assert.deepEqual(await call('GET', consentPath), baseline);
});


test('IN01 distinguishes a missing permission, an unsupported API, and unverified access', async t => {
  const { call, seed } = await fixture(t);
  const brand = await call('POST', '/brands', { name: 'Coverage', slug: 'coverage' });
  const account = (provider, external_account_id) => call('POST', '/social-accounts', {
    provider, external_account_id, display_name: external_account_id, brand_id: brand.id, owned_account_confirmed: true,
  });
  const facebook = await account('meta_facebook', 'facebook-page');
  const red = await account('xiaohongshu', 'red-account');
  const unverified = await account('meta_instagram', 'unverified-account');
  await seed(ctx => ctx.create('capability', { source: 'account_probe', executor: 'api', operation: 'comment_read',
    social_account_id: facebook.id, status: 'needs_authorization', reason: 'missing_scope' }));
  const coverage = await call('GET', '/inbox/coverage');
  const comments = id => coverage.capabilities.find(row => row.social_account_id === id && row.capability === 'comment.read');
  assert.equal(comments(facebook.id).status, 'needs_authorization');
  assert.equal(comments(facebook.id).reason, 'missing_scope');
  assert.equal(comments(red.id).status, 'unsupported');
  assert.equal(comments(unverified.id).status, 'unverified');
  assert.equal(comments(facebook.id).last_synced_at, null);
  assert.equal(coverage.unknown_when_missing, true);
});
