import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../../apps/server/src/config.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { ingestPlatformMessage, recordReplyReceipt, startReplyDispatch } from '../../apps/server/src/modules/inbox/index.ts';
import { commandContext } from '../../apps/server/src/modules/inbox/operations.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { createServer } from '../../apps/server/src/server.ts';
import { fileStore } from '../../packages/db/src/index.ts';

const password = 'acceptance-only-password';
const inbound = { brand_id: 'brand', social_account_id: 'account', provider: 'meta_facebook',
  kind: 'comment_thread', external_message_id: 'comment-1', body_text: 'Question' };

async function fixture(t, subscriber) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-inbox-contention-'));
  const store = await fileStore(join(directory, 'state.sqlite'));
  const { operations } = await discoverOperations();
  const setupToken = 'inbox-contention-setup';
  const app = createServer({ config: configuration({ SETUP_TOKEN: setupToken, HOST: '127.0.0.1', ROLE: 'all' }),
    store, operations, subscribers: subscriber ? [subscriber] : [] });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(method, path, body, { headers, version, key, status = 200, code } = {}) {
    const response = await fetch(origin + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
      headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(version !== undefined && { 'if-match': String(version) }), ...(key && { 'idempotency-key': key }) },
    });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    const json = JSON.parse(raw);
    if (code) assert.equal(json.code, code, raw);
    return { json, headers: response.headers };
  }
  const setup = await request('POST', '/api/v1/setup', { email: 'owner@example.invalid', name: 'Owner',
    workspaceName: 'Inbox contention', password }, { status: 201, headers: { 'x-setup-token': setupToken } });
  const { user, workspaces: [workspace] } = setup.json.data;
  const root = `/api/v1/workspaces/${workspace.id}`;
  const session = ({ json, headers }) => ({ cookie: headers.get('set-cookie').split(';')[0], 'x-csrf-token': json.data.csrf_token });
  const caller = headers => async (method, path, body, options) =>
    (await request(method, root + path, body, { ...options, headers })).json.data;
  const owner = caller(session(setup));
  function workspaceTx(run) {
    return store.transaction({ identityWrite: true }, async tx => {
      const scope = { workspaceId: workspace.id, actorId: user.id, tenantId: tx.identity.get(`workspace/${workspace.id}`).tenantId };
      return run(makeContext(await tx.workspace(scope), scope, 'owner'), tx.identity);
    });
  }
  async function secondHuman() {
    const id = randomUUID();
    const email = 'editor@example.invalid';
    await workspaceTx((_ctx, identity) => {
      const { passwordHash } = identity.get(`user/${user.id}`);
      identity.put(`user/${id}`, { id, name: 'Editor', email, passwordHash });
      identity.put(`email/${email}`, id);
      identity.put(`member/${id}/${workspace.id}`, { userId: id, workspaceId: workspace.id, role: 'editor' });
    });
    const login = await request('POST', '/api/v1/login', { email, password });
    assert.equal(login.json.data.user.id, id);
    return { id, call: caller(session(login)) };
  }
  async function agent() {
    // Deliberately use the owner's delegated credential: the agent and its issuer are distinct lease holders.
    const { id, token } = await owner('POST', '/tokens', {
      access: 'write', tools: ['inbox_claim', 'inbox_release', 'inbox_send_reply'],
    }, { status: 201 });
    return { id, async call(name, params, body, code, args) {
      const { json } = await request('POST', '/mcp', { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
        params: { name, arguments: { workspace_id: workspace.id, params, body, ...args } } },
      { headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' } });
      const result = json.result?.structuredContent;
      assert.ok(result, JSON.stringify(json));
      assert.equal(Boolean(json.result.isError), Boolean(code), JSON.stringify(result));
      if (code) assert.equal(result.data?.code, code, JSON.stringify(result));
      else assert.ok(result.data, JSON.stringify(result));
      return result.data;
    } };
  }
  async function conversationPath() {
    const { items: [{ conversation }] } = await owner('POST', '/inbox/ingest', { messages: [{ ...inbound, platform_created_at: new Date().toISOString() }] });
    return `/conversations/${conversation.id}`;
  }
  return { owner, secondHuman, agent, conversationPath, workspaceTx, ownerId: user.id };
}

async function approve(owner, path, bodyText) {
  const draft = await owner('POST', `${path}/reply-drafts`, { reply_mode: 'public_reply', body_text: bodyText });
  const pending = await owner('POST', `/reply-drafts/${draft.id}/submit-approval`, {}, { version: draft.version });
  return owner('POST', `/reply-drafts/${draft.id}/approve`, {}, { version: pending.version });
}

const conflict = code => ({ status: 409, code });

async function competingLease(t) {
  const { owner, ownerId, secondHuman, agent, conversationPath, workspaceTx } = await fixture(t);
  const editor = await secondHuman();
  const delegated = await agent();
  const path = await conversationPath();
  const occupancy = `${path}/occupancy`;
  const params = { id: path.split('/').at(-1) };
  const purpose = { purpose: 'reply' };

  const agentLease = await delegated.call('inbox_claim', params, purpose);
  assert.equal(agentLease.holder_type, 'agent_client');
  assert.equal(agentLease.holder_id, delegated.id);
  await Promise.all([
    owner('POST', occupancy, purpose, conflict('LEASE_HELD')),
    editor.call('POST', occupancy, purpose, conflict('LEASE_HELD')),
    owner('DELETE', occupancy, { fencing_token: agentLease.fencing_token }, conflict('LEASE_HELD')),
  ]);
  assert.equal((await owner('GET', path)).occupancy.id, agentLease.id);
  await delegated.call('inbox_release', params, { fencing_token: agentLease.fencing_token });

  const draft = await approve(owner, path, 'Approved single reply');
  const sendPath = `/reply-drafts/${draft.id}/send`;
  const lease = await owner('POST', occupancy, purpose);
  assert.equal(lease.id, agentLease.id);
  assert.equal(lease.holder_type, 'user');
  assert.equal(lease.holder_id, ownerId);
  assert.ok(lease.fencing_token > agentLease.fencing_token);
  await delegated.call('inbox_release', params, { fencing_token: lease.fencing_token }, 'LEASE_HELD');
  const body = { mode: 'manual', fencing_token: lease.fencing_token };
  const options = { version: draft.version, key: 'winning-send' };
  await owner('POST', sendPath, body, { key: 'missing-version', status: 428, code: 'VERSION_REQUIRED' });
  await owner('POST', sendPath, body, { version: draft.version - 1, key: 'stale-version', ...conflict('VERSION_CONFLICT') });
  const [sent] = await Promise.all([
    owner('POST', sendPath, body, options),
    editor.call('POST', sendPath, body, { ...options, key: 'contending-send', ...conflict('LEASE_HELD') }),
    delegated.call('inbox_send_reply', { id: draft.id }, body, 'LEASE_HELD', {
      expected_version: draft.version, idempotency_key: 'agent-contending-send',
    }),
  ]);
  assert.equal(sent.status, 'manual');
  assert.equal(sent.requested_by, ownerId);
  assert.deepEqual(await owner('POST', sendPath, body, options), sent);
  // Once committed, a losing sender still gets the lease error even with a now-stale draft version.
  await editor.call('POST', sendPath, body, { ...options, key: 'late-send', ...conflict('LEASE_HELD') });
  assert.deepEqual(await workspaceTx(ctx => ctx.list('outbound_reply').map(reply => reply.id)), [sent.id]);
}

test('IN04 REST users and a delegated MCP agent contend for one inbox lease', { timeout: 15000 }, competingLease);

async function platformFixture(t, responseStatuses) {
  const posts = [];
  const platform = httpServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/comments') {
      const bytes = [];
      for await (const chunk of req) bytes.push(chunk);
      const observed = { id: `reply-${posts.length + 1}`, platform_created_at: new Date().toISOString(), ...JSON.parse(Buffer.concat(bytes)) };
      posts.push(observed);
      const status = responseStatuses[posts.length - 1];
      // A missing status simulates a server that read the POST and never sends response headers.
      if (status) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(observed));
    } else if (req.method === 'GET' && req.url === '/comments/reply-1' && posts.length) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(posts[0]));
    } else res.writeHead(404).end();
  });
  platform.listen(0, '127.0.0.1');
  await once(platform, 'listening');
  t.after(() => new Promise(resolve => { platform.close(resolve); platform.closeAllConnections(); }));
  const url = `http://127.0.0.1:${platform.address().port}/comments`;
  return { posts, url, subscriber: {
    id: 'inbox.contested-loopback', accepts: type => type === 'inbox.reply.submitted',
    async run(ctx, event) {
      const command = commandContext(ctx);
      const { attempt, payload } = await startReplyDispatch(command, event.data.outbound_reply_id, event.id);
      let response;
      try {
        response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(750) });
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        await recordReplyReceipt(command, attempt.id, { outcome: 'outcome_unknown', error_class: 'timeout' });
        return;
      }
      const { id } = await response.json();
      assert.ok([201, 422].includes(response.status));
      await recordReplyReceipt(command, attempt.id, { outcome: response.status === 201 ? 'accepted' : 'not_delivered', receipt_ref: id });
    },
  } };
}

async function apiReply(t, platform) {
  const { owner, conversationPath, workspaceTx } = await fixture(t, platform.subscriber);
  await workspaceTx(ctx => ctx.create('inbox_capability', { social_account_id: 'account', capability: 'comment.reply', status: 'available' }));
  const path = await conversationPath();
  const draft = await approve(owner, path, 'Approved API reply');
  const lease = await owner('POST', `${path}/occupancy`, { purpose: 'reply' });
  const body = { mode: 'api', fencing_token: lease.fencing_token };
  const send = (key, options) => owner('POST', `/reply-drafts/${draft.id}/send`, body, { version: draft.version, key, ...options });
  const queued = await send('api-send');
  assert.equal(queued.status, 'queued');
  const deliveryPath = `/outbound-replies/${queued.id}`;
  const read = () => owner('GET', deliveryPath);
  async function waitFor(status) {
    const deadline = Date.now() + 6500;
    let result;
    do {
      result = await read();
      if (result.reply.status === status) return result;
      await delay(50);
    } while (Date.now() < deadline);
    assert.equal(result.reply.status, status);
  }
  return { owner, queued, deliveryPath, lease, send, waitFor, read, workspaceTx };
}

test('IN05 times out after the loopback platform receives the POST and never resubmits blindly', { timeout: 18000 }, async t => {
  const platform = await platformFixture(t, []);
  const { owner, queued, lease, deliveryPath, send, waitFor, read, workspaceTx } = await apiReply(t, platform);
  const unknown = await waitFor('outcome_unknown');
  assert.equal(unknown.reply.needs_verification, true);
  assert.equal(unknown.reply.current_attempt_no, 1);
  assert.equal(unknown.attempts.length, 1);
  assert.equal(unknown.attempts[0].outcome, 'outcome_unknown');
  assert.ok(unknown.attempts[0].finished_at);
  assert.deepEqual(unknown.receipts.map(receipt => [receipt.outbound_reply_attempt_id, receipt.outcome, receipt.error_class]),
    [[unknown.attempts[0].id, 'outcome_unknown', 'timeout']]);
  assert.equal(platform.posts.length, 1);
  assert.equal(platform.posts[0].body_text, 'Approved API reply');
  assert.equal(platform.posts[0].target_external_id, inbound.external_message_id);

  assert.deepEqual(await send('api-send'), queued);
  await send('fresh-send-key', conflict('OUTCOME_UNKNOWN'));
  const blindRetry = reply => owner('POST', `${deliveryPath}/retry`, { fencing_token: lease.fencing_token },
    { key: 'blind-retry', version: reply.version, ...conflict('OUTCOME_UNKNOWN') });
  await blindRetry(unknown.reply);
  for (const status of ['outcome_unknown', 'outcome_unknown', 'manual']) {
    assert.equal((await owner('POST', `${deliveryPath}/reconcile`, {})).status, status);
  }
  const manual = await read();
  assert.equal(manual.reply.needs_verification, true);
  await blindRetry(manual.reply);
  await send('fresh-send-after-manual', conflict('OUTCOME_UNKNOWN'));
  // The outbox worker polls every second. Allow another cycle and the first retry backoff to elapse.
  await delay(2200);
  assert.equal(platform.posts.length, 1);
  assert.deepEqual(await read(), manual);

  const response = await fetch(`${platform.url}/reply-1`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const observed = await response.json();
  const { message } = await workspaceTx(ctx => ingestPlatformMessage(commandContext(ctx), { ...inbound,
    direction: 'outbound', source: 'poll', external_message_id: observed.id, parent_external_id: observed.target_external_id,
    body_text: observed.body_text, platform_created_at: observed.platform_created_at }));
  const delivered = await owner('POST', `${deliveryPath}/reconcile`, {});
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.verification, 'platform_readback');
  assert.equal(delivered.result_message_id, message.id);
  const final = await read();
  assert.deepEqual(final.attempts.map(attempt => [attempt.id, attempt.outcome]), [[unknown.attempts[0].id, 'delivered']]);
  assert.deepEqual(final.receipts, unknown.receipts);
  assert.equal(platform.posts.length, 1);
});

test('IN05 a confirmed non-delivery permits one explicit retry and fences the old receipt', { timeout: 15000 }, async t => {
  const platform = await platformFixture(t, [422, 201]);
  const { owner, lease, deliveryPath, waitFor, workspaceTx } = await apiReply(t, platform);
  const retryable = await waitFor('retryable');
  assert.equal(retryable.attempts[0].outcome, 'not_delivered');
  assert.equal(platform.posts.length, 1);
  const options = { key: 'confirmed-retry', version: retryable.reply.version };
  const body = { fencing_token: lease.fencing_token };
  const retry = () => owner('POST', `${deliveryPath}/retry`, body, options);
  const [queued, replay] = await Promise.all([retry(), retry()]);
  assert.equal(queued.status, 'queued');
  assert.deepEqual(replay, queued);
  const accepted = await waitFor('accepted');
  assert.deepEqual(accepted.attempts.map(attempt => [attempt.attempt_no, attempt.outcome]).sort(), [[1, 'not_delivered'], [2, 'accepted']]);
  assert.equal(platform.posts.length, 2);
  await assert.rejects(workspaceTx(ctx => recordReplyReceipt(commandContext(ctx), retryable.attempts[0].id,
    { outcome: 'accepted', receipt_ref: 'late-old-receipt' })), { code: 'STALE_ATTEMPT' });
});
