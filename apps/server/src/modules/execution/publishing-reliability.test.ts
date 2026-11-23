import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Row } from '@smartsell/contracts';
import { buildApp } from '../../app.js';
import { configuration } from '../../config.js';
import { makeContext, type DomainEvent } from '../../context.js';
import { createCommerceProviders } from '../../integration/commerce-providers.js';
import { createMediaHost } from '../../integration/media-host.js';
import { localStore } from '../../local.js';
import { registerOperationRoutes } from '../../operation-server.js';
import { discoverOperations } from '../../operations.js';
import { loopbackAdapter, publishingTransactions } from './publishing-http-fixture.js';
import { createExecutionWorker, type Submission } from './worker.js';

const minute = 60_000;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');

test('publishing preserves one external effect and one audited result across lost replies and SQLite reopen', { timeout: 60_000 }, async t => {
  const setupToken = randomUUID();
  const config = configuration({ NODE_ENV: 'test', SETUP_TOKEN: setupToken });
  const { operations, loadFailures, missingModules } = await discoverOperations();
  assert.deepEqual([...loadFailures], []);
  assert.deepEqual(missingModules, []);
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-publish-reliability-'));
  const path = join(directory, 'publishing.sqlite');
  const env = process.env;
  const { media, boundOperations } = (() => {
    try {
      process.env = { MEDIA_DIRECTORY: join(directory, 'media') };
      const providers = createCommerceProviders(config);
      return { media: createMediaHost(config), boundOperations: operations.map(op => providers.bindOperation(op)) };
    } finally { process.env = env; }
  })();

  const scenarios = new Map<string, {
    mode: 'crash' | 'disconnect' | 'accept';
    submissions: Submission[];
    reads: number;
    verified: boolean;
    received?: () => void;
  }>();
  const acknowledgements: string[] = [];
  const provider = createServer(async (req, res) => {
    const respond = (data: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (req.method === 'POST' && req.url === '/posts') {
      const parts: Uint8Array[] = [];
      for await (const part of req) parts.push(part);
      const submission: Submission = JSON.parse(Buffer.concat(parts).toString());
      const scenario = scenarios.get(submission.task_id);
      if (!scenario) { res.writeHead(404).end(); return; }
      // Each POST represents a separate external effect, even if a request ID repeats.
      scenario.submissions.push(submission);
      scenario.received?.();
      if (scenario.mode === 'disconnect') req.socket.destroy();
      if (scenario.mode === 'accept') {
        acknowledgements.push(submission.task_id);
        respond({ status: 'accepted', reference: `receipt-${submission.task_id}` });
      }
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/posts/')) {
      const requestId = decodeURIComponent(req.url.slice('/posts/'.length));
      for (const scenario of scenarios.values()) {
        const submission = scenario.submissions.find(row => row.client_request_id === requestId);
        if (!submission) continue;
        scenario.reads++;
        respond(scenario.verified ? { status: 'published', external_post_id: submission.task_id,
          permalink: `https://publisher.example.invalid/posts/${submission.task_id}` } : { status: 'inconclusive' });
        return;
      }
    }
    res.writeHead(404).end();
  });
  let current: Awaited<ReturnType<typeof open>> | undefined;
  t.after(async () => {
    try { await current?.app.close(); }
    finally {
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let dropKey: string | undefined;
  let droppedResponses = 0;
  async function open(existing = false) {
    const store = localStore(path, { existing });
    const { app } = buildApp({ ...config, store, registry: new Map(),
      operationApi: { config, operations: boundOperations, register: registerOperationRoutes, media } });
    app.addHook('onSend', async (req, reply, payload) => {
      if (dropKey && req.headers['idempotency-key'] === dropKey && reply.statusCode === 200) {
        dropKey = undefined;
        droppedResponses++;
        reply.hijack();
        reply.raw.destroy();
      }
      return payload;
    });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    return { store, app, base };
  }
  current = await open();
  const app = () => {
    assert.ok(current);
    return current;
  };
  async function request(method: string, route: string, body?: object, headers: Record<string, string> = {}) {
    return fetch(app().base + route, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers }, signal: AbortSignal.timeout(10_000) });
  }
  async function checked(response: Response, status = 200) {
    const raw = await response.text();
    assert.equal(response.status, status, `${response.url}: ${raw}`);
    return raw ? JSON.parse(raw) : undefined;
  }
  async function session(response: Response) {
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const { csrf_token } = await checked(await request('GET', '/api/v1/session/csrf', undefined, { cookie }));
    return { cookie, 'x-csrf-token': String(csrf_token) };
  }
  const setup = await request('POST', '/api/v1/setup', { email: 'owner@example.invalid', name: 'Owner',
    password: 'fixture-owner-password', workspaceName: 'Publishing reliability' }, { 'x-setup-token': setupToken });
  const { workspaces: [{ id: workspaceId }] } = await checked(setup, 201);
  const owner = await session(setup);
  const root = `/api/v1/workspaces/${workspaceId}`;
  const send = (method: string, route: string, body?: object, { actor = owner, version, key = randomUUID() as string }:
    { actor?: typeof owner; version?: number; key?: string } = {}) => request(method, root + route, body, {
    ...actor, 'idempotency-key': key, ...(version !== undefined && { 'if-match': String(version) }),
  });
  const get = async (route: string) => (await checked(await send('GET', route))).data;
  const socketClosed = (error: Error & { cause?: NodeJS.ErrnoException }) => error.cause?.code === 'UND_ERR_SOCKET';
  const post = async (route: string, body: object = {}, options?: Parameters<typeof send>[3], status = 200) => {
    const json = await checked(await send('POST', route, body, options), status);
    return status < 300 ? json.data : json.code;
  };
  const reviewerUser = { email: 'reviewer@example.invalid', name: 'Reviewer', password: 'fixture-reviewer-password' };
  const { invitation_token: token } = await post('/members/invite', { email: reviewerUser.email, role: 'reviewer' });
  await checked(await request('POST', '/api/v1/member-invitations/accept', { ...reviewerUser, token }), 204);
  const signedIn = await request('POST', '/api/v1/session', reviewerUser);
  const { user: reviewerRecord } = await checked(signedIn);
  const reviewer = await session(signedIn);
  const brand = await post('/brands', { name: 'Fixture brand', slug: 'publishing-reliability' });
  const account = await post('/social-accounts', { brand_id: brand.id, provider: 'meta_facebook', external_account_id: 'fixture-page',
    display_name: 'Fixture page', owned_account_confirmed: true });
  // Replace OAuth with a local connection and capability. All publication records are created through HTTP.
  await (await publishingTransactions(app().store)).transact(ctx => {
    const connection = ctx.create('connection', { purpose: 'social', provider: 'meta_facebook', status: 'active', brand_id: brand.id });
    ctx.create('social_account_connection', { social_account_id: account.id, connection_id: connection.id });
    ctx.create('capability', { social_account_id: account.id, connection_id: connection.id, operation: 'publish', content_format: 'text',
      status: 'available', executor: 'api' });
  });
  await checked(await send('PUT', `/execution-settings/workspace/${workspaceId}`, {
    verify_schedule_seconds: [1, 120], unknown_to_manual_after_minutes: 1,
  }));
  const upload = await post('/files/uploads', { purpose: 'evidence', mime_type: 'image/png', original_filename: 'fixture.png',
    size_bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
  const file = await post(`/files/uploads/${upload.id}/complete`, { base64: png.toString('base64') });

  async function prepare(mode: 'crash' | 'disconnect' | 'accept') {
    const title = `Approved ${mode} fixture`;
    const { variants: [draft] } = await post('/content-items', { title, brand_id: brand.id,
      variants: [{ platform: 'facebook', format: 'text', locale: 'en', body_markdown: title }] });
    const { variant, revision } = await post(`/content-variants/${draft.id}/revisions`, { base_revision_id: null });
    await post(`/content-variants/${draft.id}/readiness`, {}, { version: variant.version });
    const target = await post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id,
      variant_revision_id: revision.id, scheduled_at: new Date(Date.now() + 60 * minute).toISOString(), schedule_tz: 'UTC' });
    const targetPath = `/publish-targets/${target.id}`;
    const submitOptions = { version: target.version, key: randomUUID() };
    let committedApprovalId: string | undefined;
    if (mode === 'disconnect') {
      dropKey = submitOptions.key;
      await assert.rejects(send('POST', `${targetPath}/submit`, {}, submitOptions), socketClosed);
      const persisted = await get(targetPath);
      assert.equal(persisted.plan_status, 'awaiting_approval');
      assert.ok(persisted.approval_request_id);
      committedApprovalId = persisted.approval_request_id;
    }
    const submitted = await post(`${targetPath}/submit`, {}, submitOptions);
    assert.equal(submitted.plan_status, 'awaiting_approval', JSON.stringify(submitted));
    if (committedApprovalId) assert.equal(submitted.approval_request_id, committedApprovalId);
    assert.deepEqual(await get(`/execution-tasks?publish_target_id=${target.id}`), []);
    const approve = () => send('POST', `${targetPath}/approve`, { approval_request_id: submitted.approval_request_id,
      resource_hash: submitted.frozen_hash }, { actor: reviewer, version: submitted.version });
    const replies = await Promise.all([approve(), approve()]);
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
    const approved = (await checked(replies.find(reply => reply.ok)!)).data;
    assert.equal((await checked(replies.find(reply => !reply.ok)!, 409)).code, 'VERSION_CONFLICT');
    assert.equal(approved.plan_status, 'ready');
    const [task] = await get(`/execution-tasks?publish_target_id=${target.id}`);
    assert.equal(task.approval_request_id, submitted.approval_request_id);
    assert.equal(task.frozen_hash, submitted.frozen_hash);
    const taskPath = `/execution-tasks/${task.id}`;
    const scenario = { mode, submissions: [] as Submission[], reads: 0, verified: false, received: undefined as (() => void) | undefined };
    scenarios.set(task.id, scenario);
    assert.equal((await post(`${taskPath}/run-now`, {}, { version: task.version })).status, 'queued');
    return { target, targetPath, task, taskPath, scenario, title, submitted };
  }
  const worker = async () => createExecutionWorker((await publishingTransactions(app().store)).transact, [loopbackAdapter(origin)]);
  const tick = async () => assert.deepEqual((await (await worker()).tick()).failures, []);
  const go = (minutes: number) => t.mock.timers.setTime(Date.now() + minutes * minute);
  const posts = async (taskId: string) => (await get(`/platform-posts?social_account_id=${account.id}`) as Row[])
    .filter(row => row.execution_task_id === taskId);
  async function pendingOutcome(f: Awaited<ReturnType<typeof prepare>>, expected: string) {
    const detail = await get(f.taskPath);
    assert.equal(detail.status, expected);
    assert.notEqual((await get(f.targetPath)).display_status, 'published');
    assert.equal(detail.platform_post, null);
    assert.equal(detail.attempts.length, 1);
    assert.deepEqual(detail.pending_side_effects, [detail.attempts[0].id]);
    assert.deepEqual(detail.verifications.map((row: Row) => row.status), ['requested']);
    assert.deepEqual(await posts(f.task.id), []);
    assert.equal(f.scenario.submissions.length, 1);
    for (const action of ['run-now', 'retry', 'handover']) {
      assert.equal(await post(`${f.taskPath}/${action}`, {}, { version: detail.version }, 409), 'OUTCOME_UNKNOWN');
    }
    return detail;
  }
  async function audited(f: Awaited<ReturnType<typeof prepare>>, verification: string, expectedAccepted: number, expectedUnknown: number) {
    const detail = await get(f.taskPath);
    const [attempt] = detail.attempts;
    assert.equal(detail.status, 'published');
    assert.equal(detail.attempts.length, 1);
    assert.deepEqual(detail.pending_side_effects, []);
    assert.equal(attempt.status, 'verified_published');
    assert.equal(attempt.client_request_id, f.scenario.submissions[0].client_request_id);
    assert.equal(f.scenario.submissions[0].request_hash, f.submitted.frozen_hash);
    assert.equal((f.scenario.submissions[0].frozen.rendered as { text: string }).text, f.title);
    assert.equal(detail.steps.filter((row: Row) => row.step === 'submit').length, 1);
    assert.deepEqual(detail.verifications.map((row: Row) => [row.status, row.outcome]), [['completed', 'published']]);
    assert.equal(detail.evidence.length, 1);
    assert.deepEqual(detail.platform_post.evidence_ids, [detail.evidence[0].id]);
    assert.deepEqual(await posts(f.task.id), [detail.platform_post]);
    assert.equal(detail.platform_post.external_post_id, f.task.id);
    assert.equal(detail.platform_post.verification, verification);
    const { background, workspace } = await publishingTransactions(app().store);
    const count = await background.transact(workspace, true, (records, scope) => {
      const ctx = makeContext(records, scope, 'owner');
      const requests = ctx.list('approval_request').filter(row => row.resource_id === f.target.id);
      assert.deepEqual(requests.map(row => [row.id, row.status]), [[f.submitted.approval_request_id, 'approved']]);
      const decisions = ctx.list('approval_decision').filter(row => row.request_id === f.submitted.approval_request_id);
      assert.deepEqual(decisions.map(row => [row.decision, row.decided_by_user_id]), [['approve', reviewerRecord.id]]);
      const events = records.list<DomainEvent>('outbox/').filter(event =>
        event.payload.task_id === f.task.id || event.payload.execution_task_id === f.task.id);
      return ['execution.attempt.accepted', 'execution.attempt.outcome_unknown', 'execution.task.published',
        'execution.platform_post.linked'].map(type => events.filter(event => event.type === type).length);
    });
    assert.deepEqual(count, [expectedAccepted, expectedUnknown, 1, 1]);
    assert.equal(f.scenario.submissions.length, 1);
    assert.equal(acknowledgements.filter(taskId => taskId === f.task.id).length, expectedAccepted);
    return detail.platform_post;
  }

  await t.test('a killed consumer recovers the persisted submission boundary and verifies after reopening SQLite', async sub => {
    const f = await prepare('crash');
    const received = new Promise<void>(resolve => { f.scenario.received = resolve; });
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./publishing-http-fixture.ts', import.meta.url)),
      path, origin, f.task.id], { stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      await Promise.race([received, exited.then(() => assert.fail(`Consumer exited before submission: ${stderr}`))]);
      const inFlight = await get(f.taskPath);
      assert.equal(inFlight.status, 'running');
      assert.equal(inFlight.attempts[0].side_effect_possible, true);
      assert.ok(inFlight.attempts[0].submission_started_at);
      assert.equal(inFlight.platform_post, null);
      await app().app.close();
      current = undefined;
    } finally {
      child.kill('SIGKILL');
      assert.deepEqual(await exited, [null, 'SIGKILL'], stderr);
    }
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    current = await open(true);
    await tick();
    assert.equal((await get(f.taskPath)).status, 'running');
    go(11);
    await tick();
    const recovered = await pendingOutcome(f, 'outcome_unknown');
    assert.equal(recovered.status_reason, 'lease_expired_after_submission_boundary');
    f.scenario.verified = true;
    go(1);
    await tick();
    await tick();
    assert.equal(f.scenario.reads, 1);
    await audited(f, 'system_verified', 0, 1);
    sub.diagnostic('1 external submission, 0 acceptance receipts, 1 durable unknown outcome, 1 read-back, 1 linked publication');
  });

  await t.test('a lost provider reply waits for human evidence and concurrent confirmations link one post', async sub => {
    const f = await prepare('disconnect');
    const consumer = await worker();
    const ticks = await Promise.all([consumer.tick(), consumer.tick()]);
    assert.deepEqual(ticks.flatMap(result => result.failures), []);
    const unresolved = await pendingOutcome(f, 'outcome_unknown');
    assert.equal(unresolved.status_reason, 'adapter_interrupted_after_submission_boundary');
    go(2);
    await tick();
    const manual = await pendingOutcome(f, 'manual');
    assert.equal(manual.sub_status, 'awaiting_evidence');
    assert.equal(f.scenario.reads, 1);
    assert.equal(manual.verifications[0].outcome, 'inconclusive');
    assert.equal(await post(`${f.taskPath}/manual-start`, {}, {}, 409), 'OUTCOME_UNKNOWN');
    const registration = `${f.targetPath}/register-post`;
    const evidence = { permalink: `https://publisher.example.invalid/posts/${f.task.id}`, external_post_id: f.task.id, evidence_file_ids: [file.id] };
    const key = randomUUID();
    dropKey = key;
    const [, confirmed] = await Promise.all([
      assert.rejects(send('POST', registration, evidence, { key }), socketClosed),
      post(registration, evidence),
    ]);
    assert.equal(droppedResponses, 2);
    await app().app.close();
    current = undefined;
    current = await open(true);
    assert.deepEqual(await post(registration, evidence, { key }), confirmed);
    assert.deepEqual(await post(registration, { permalink: evidence.permalink }), confirmed);
    const rejected = await send('POST', registration, { ...evidence, external_post_id: 'conflicting-id' });
    assert.equal(rejected.status, 409, 'A matching permalink must not acknowledge a conflicting external ID');
    assert.equal((await checked(rejected, 409)).code, 'POST_ALREADY_LINKED');
    assert.deepEqual(await audited(f, 'manual_confirmed', 0, 1), confirmed);
    sub.diagnostic('2 dropped business replies replayed, 1 external submission, 0 acceptance receipts, 1 inconclusive read-back, 1 manual evidence record, 1 linked publication');
  });

  await t.test('acceptance never counts as publication and concurrent read-back commits once', async sub => {
    const f = await prepare('accept');
    await tick();
    const accepted = await pendingOutcome(f, 'accepted');
    assert.equal(accepted.attempts[0].receipt, `receipt-${f.task.id}`);
    assert.equal(f.scenario.reads, 0);
    f.scenario.verified = true;
    const consumer = await worker();
    await Promise.all([consumer.reconcile(f.task.id), consumer.reconcile(f.task.id)]);
    assert.equal(f.scenario.reads, 2);
    await audited(f, 'system_verified', 1, 0);
    sub.diagnostic('1 external submission, 1 acceptance receipt, 2 concurrent read-backs, 1 evidence record, 1 linked publication');
  });
  const publications = await get(`/platform-posts?social_account_id=${account.id}`) as Row[];
  assert.deepEqual(publications.map(row => row.external_post_id).sort(), [...scenarios.keys()].sort());
});
