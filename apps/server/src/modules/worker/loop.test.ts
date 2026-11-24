// M2 acceptance (phase1-design §11.3): the real hub in-process, two machines paired with the real signed protocol, an X
// channel and a TikTok channel registered by the real Worker runtime, posts scheduled through the REST operations, and the
// real S6 runtime publishing against the fixture platform pages in headless Chrome. Plus the captcha case (§10.2 E2E-4).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { RISK_TERMS_VERSION, type Context, type Data, type Row } from '@smartsell/contracts';
import type { FastifyInstance } from 'fastify';
import { start } from '../../bootstrap.js';
import { configuration } from '../../config.js';
import { makeContext } from '../../context.js';
import { prepareAssembledObject, recordAssembledObject, mediaStorageFromConfig } from '../../extensions/media-files.js';
import { workspaceServices } from '../../integration/workspace-services.js';
import type { BackgroundStore } from '../../runtime.js';
import type { Workspace } from '../../identity.js';
import { applyChannelDefaults } from '../content/index.js';
import { toOwnerAlert } from '../alerts/index.js';
import { MemoryNonceStore, configureDeviceNonces } from './nonces.js';
import { addChannel, parseArgs, pair } from '../../../../connector-desktop/src/headless/runner.ts';
import { FileVault } from '../../../../connector-desktop/src/headless/file-vault.ts';
import { createWorkerRuntime, type WorkerRuntime } from '../../../../connector-desktop/src/runtime/worker.ts';
import { startPlatformFixtures, type PlatformFixtures } from '../../../../../tests/fixtures/platforms/server.ts';

const chrome = [process.env.SMARTSELL_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((path): path is string => !!path && existsSync(path));

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value as T; } catch (error) { last = error; }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.fail(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`);
}

/** A small file with an MP4 header; the fixture pages only hash it. */
function makeClip(dir: string, size = 300_000) {
  const bytes = Buffer.alloc(size);
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(bytes);
  for (let index = 16; index < size; index++) bytes[index] = (index * 31) & 0xff;
  const path = join(dir, 'video.mp4');
  writeFileSync(path, bytes);
  return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

describe('M2: hub job engine with the real Worker runtime and the fixture platforms', {
  skip: chrome ? false : 'Google Chrome is not installed (set SMARTSELL_CHROME_PATH)', concurrency: false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-m2-'));
  const saved = { ...process.env };
  let app: FastifyInstance;
  let background: BackgroundStore;
  let ws: Workspace;
  let base = '';
  let owner: Record<string, string> = {};
  let fixtures: PlatformFixtures;
  const machines: { name: string; dir: string; provider: 'x' | 'tiktok'; runtime?: WorkerRuntime; deviceId?: string; accountId?: string }[] = [
    { name: 'Mac-B', dir: join(dir, 'mac-b'), provider: 'x' },
    { name: 'Win-C', dir: join(dir, 'win-c'), provider: 'tiktok' },
  ];
  let config: ReturnType<typeof configuration>;
  let assetId = '';
  let versionId = '';
  let clip: ReturnType<typeof makeClip>;

  const enrich = workspaceServices([]);
  const read = <T>(run: (ctx: Context) => T) => background.transact(ws, true, (records, scope, identity) => run(enrich(makeContext(records, scope, 'owner'), identity)));
  const write = <T>(run: (ctx: Context) => T | Promise<T>) => background.transact(ws, false, (records, scope, identity) => run(enrich(makeContext(records, scope, 'owner'), identity)));
  async function rest(method: string, path: string, body?: Data, headers: Record<string, string> = {}, status = 200) {
    const response = await fetch(`${base}/api/v1/workspaces/${ws.id}${path}`, { method, headers: { ...owner, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return (JSON.parse(text) as { data: unknown }).data as Data;
  }
  const jobFor = (targetId: string) => read(ctx => ctx.list('worker_job').filter(job => job.publish_target_id === targetId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]);

  async function schedule(machine: (typeof machines)[number], text: string, at: number) {
    const brand = await read(ctx => String(ctx.get('social_account', machine.accountId!).brand_id));
    const draft = await rest('POST', '/content-items/draft', { brand_id: brand, title: text, variants: [{
      platform: machine.provider, format: 'short_video', social_account_id: machine.accountId, body: text,
      media: [{ asset_id: assetId, asset_version_id: versionId, role: 'primary' }] }] }) as { variants: Row[] };
    const variant = draft.variants[0];
    // What S4's hub_posts_schedule does for a channel: the owner's platform defaults go onto a new revision (§4.4).
    await write(async ctx => {
      const settings = ctx.list('channel_settings').find(row => row.social_account_id === machine.accountId)!;
      await applyChannelDefaults(ctx, variant.id, settings.platform_defaults as never);
    });
    const target = await rest('POST', '/publish-targets', { social_account_id: machine.accountId, content_variant_id: variant.id,
      scheduled_at: new Date(at).toISOString(), late_policy: 'skip', grace_minutes: 5 });
    const submitted = await rest('POST', `/publish-targets/${target.id}/submit`, {});
    assert.equal(submitted.plan_status, 'ready', `direct channel auto-approves: ${JSON.stringify(submitted.precheck ?? submitted)}`);
    return String(target.id);
  }

  before(async () => {
    fixtures = await startPlatformFixtures({ uploadMs: 600, xProcessingMs: 600 });
    const env = {
      ...saved, NODE_ENV: 'test', SETUP_TOKEN: 'm2-loop-setup-token', SMARTSELL_DATA_FILE: join(dir, 'hub', 'smartsell.sqlite'),
      SMARTSELL_TEST_UNREPORTED_GRACE_SEC: '30', SMARTSELL_TEST_PREPARE_LEAD_SEC: '4', SMARTSELL_TEST_READBACK_SCHEDULE_SEC: '1,2,3',
      // Worker side (S6 §8.14): fixture origins only; nothing can reach a real platform.
      SMARTSELL_TEST_MODE: '1', SMARTSELL_CHROME_PATH: chrome!, SMARTSELL_TEST_PLATFORM_ORIGINS: JSON.stringify(fixtures.origins),
      SMARTSELL_TEST_BLOCKER_POLL_SEC: '1', SMARTSELL_OPERATION_API: '1',
    };
    delete (env as Record<string, string | undefined>).DATABASE_URL;
    process.env = env;
    config = configuration(env);
    app = await start({ ...config, port: 0 }, { beforeListen(_app, services) { background = services.background!; } });
    // What the hub does (§2.10): nonces in memory, so an idle heartbeat writes nothing.
    configureDeviceNonces(new MemoryNonceStore());
    const address = app.server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
    const setup = await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': 'm2-loop-setup-token' },
      body: JSON.stringify({ name: 'M2 Owner', workspaceName: 'M2 Loop', email: 'm2-owner@example.invalid', password: randomUUID() }) });
    assert.equal(setup.status, 201, await setup.clone().text());
    const session = ((await setup.json()) as { data: { csrf_token?: string; workspaces: { id: string }[] } }).data;
    const cookie = String(setup.headers.get('set-cookie')).split(';')[0];
    const csrf = session.csrf_token ?? ((await (await fetch(`${base}/api/v1/session/csrf`, { headers: { cookie } })).json()) as { csrf_token: string }).csrf_token;
    owner = { cookie, 'x-csrf-token': csrf, origin: config.origin };
    ws = (await background.workspaces()).find(item => item.id === session.workspaces[0].id)!;
    assert.ok(ws, 'the background store sees the workspace');
    clip = makeClip(dir);
  });

  after(async () => {
    for (const machine of machines) await machine.runtime?.stop().catch(() => {});
    await new Promise(done => setTimeout(done, 800));
    await app?.close();
    await fixtures?.close();
    process.env = saved;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('pairs two machines with the signed protocol and registers an X and a TikTok channel through the Worker', async () => {
    for (const machine of machines) {
      const code = await rest('POST', '/devices/pairing-codes', { owned_device_confirmed: true, allow_channel_registration: true });
      machine.deviceId = await pair(parseArgs(['--data-dir', machine.dir, '--name', machine.name, 'pair', '--hub', base, '--workspace', ws.id,
        '--code', String(code.pairing_code), '--platform', machine.name === 'Mac-B' ? 'darwin' : 'win32']));
      const added = await addChannel(parseArgs(['--data-dir', machine.dir, 'add-channel', '--provider', machine.provider]));
      const registration = (added.registrations as Data[])[0];
      machine.accountId = String(registration.resource_id);
      assert.equal(registration.device_id, machine.deviceId);
    }
    const state = await read(ctx => machines.map(machine => ({
      account: ctx.get('social_account', machine.accountId!),
      settings: ctx.list('channel_settings').find(row => row.social_account_id === machine.accountId)!,
      session: ctx.list('browser_session').find(row => row.social_account_id === machine.accountId)!,
    })));
    assert.deepEqual(state.map(item => [item.account.provider, item.account.external_account_id, item.account.handle]),
      [['x', 'fixture_x', 'fixture_x'], ['tiktok', '7234567890123456789', 'fixture_tt']]);
    assert.ok(state.every(item => item.session.status === 'verified' && (item.settings.automation_notice_ack as Data | null)?.via === 'worker_app'));
  });

  test('owner settings: direct approval, risk acknowledgement and TikTok defaults through the person-only REST operations', async () => {
    for (const machine of machines) {
      const settings = await read(ctx => ctx.list('channel_settings').find(row => row.social_account_id === machine.accountId)!);
      await rest('PATCH', `/hub/channels/${machine.accountId}/settings`, {
        approval_mode: 'direct', lateness_limit_min: 5,
        ...(machine.provider === 'tiktok' && { platform_defaults: { tiktok: { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false,
          allow_stitch: false, commercial_disclosure: 'none', ai_generated: false } } }),
      }, { 'if-match': `"${settings.version}"` });
      const ack = await rest('POST', `/hub/channels/${machine.accountId}/risk-ack`, { terms_version: RISK_TERMS_VERSION,
        typed_handle: machine.provider === 'x' ? '@fixture_x' : '@fixture_tt' });
      assert.equal(ack.effective_mode, 'auto');
    }
    // Media through S5's assembled-upload tail (prepare outside the transaction, record in a short one).
    const ids = await write(ctx => {
      const asset = ctx.create('asset', { kind: 'video', title: 'video.mp4', brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'uploading', current_version_id: null });
      const version = ctx.create('asset_version', { asset_id: asset.id, version_no: 1, sha256: clip.sha256, mime_type: 'video/mp4', file_object_id: null, meta: null });
      ctx.update('asset', asset.id, { current_version_id: version.id });
      return { asset: asset.id, version: version.id };
    });
    assetId = ids.asset;
    versionId = ids.version;
    const prepared = await prepareAssembledObject(mediaStorageFromConfig(config), { path: clip.path, sha256: clip.sha256, size: clip.bytes.length,
      mime: 'video/mp4', filename: 'video.mp4', workspaceId: ws.id, tenantId: ws.tenantId });
    // prepareAssembledObject may move the file; recreate it for later assertions.
    if (!existsSync(clip.path)) writeFileSync(clip.path, clip.bytes);
    await write(ctx => recordAssembledObject(ctx, prepared, { asset_id: assetId, asset_version_id: versionId, createdBy: 'm2-test' }));
  });

  test('both posts go out at the scheduled time from each channel\'s machine and the URLs come back', async () => {
    const at = Date.now() + 20_000;
    const targets = [await schedule(machines[0], 'M2 loop X post', at), await schedule(machines[1], 'M2 loop TikTok post', at)];
    // Dispatch-ahead on approval: one queued job per post, routed to the channel's machine (§5.2).
    const dispatched = await Promise.all(targets.map(jobFor));
    assert.deepEqual(dispatched.map(job => [job.status, job.device_id]), [['queued', machines[0].deviceId], ['queued', machines[1].deviceId]]);
    const tasks = await read(ctx => targets.map(id => ctx.list('execution_task').find(row => row.publish_target_id === id)!));
    assert.ok(tasks.every((task, index) => (task.route as Data[])[0].executor === 'worker' && (task.route as Data[])[0].device_id === machines[index].deviceId));
    for (const machine of machines) {
      const vault = new FileVault(machine.dir).load()!;
      machine.runtime = createWorkerRuntime({ dataDir: machine.dir, identity: { origin: vault.origin, workspaceId: vault.workspace_id, deviceId: vault.device_id,
        privateKey: vault.private_key_pem, machineName: vault.machine_name }, clientVersion: '0.2.0', headless: true, heartbeatMs: 500 });
      machine.runtime.start();
    }
    const done = await until(async () => {
      const jobs = await Promise.all(targets.map(jobFor));
      return jobs.every(job => job.status === 'succeeded') && jobs;
    }, 150_000, 'both jobs succeeded');
    const facts = await read(ctx => targets.map(id => {
      const target = ctx.get('publish_target', id);
      const task = ctx.list('execution_task').find(row => row.publish_target_id === id)!;
      const post = ctx.get('platform_post', String(target.platform_post_id));
      const attempt = ctx.list('execution_attempt').find(row => row.task_id === task.id)!;
      const events = ctx.list('worker_job_event').filter(row => row.job_id === target.worker_job_id).map(row => String(row.event));
      return { target, task, post, attempt, events };
    }));
    assert.match(String(facts[0].post.permalink), /^https:\/\/x\.com\/fixture_x\/status\/\d+$/);
    assert.match(String(facts[1].post.permalink), /^https:\/\/www\.tiktok\.com\/@fixture_tt\/video\/\d+$/);
    for (const [index, fact] of facts.entries()) {
      assert.equal(fact.target.plan_status, 'closed');
      assert.equal(fact.task.status, 'published');
      assert.equal(fact.attempt.status, 'verified_published');
      assert.equal(fact.attempt.executor, 'worker');
      assert.equal(fact.post.verification, 'system_verified');
      assert.equal(fact.post.registered_via, 'worker_readback');
      assert.equal(fact.post.worker_job_id, done[index].id);
      assert.equal(done[index].go_source, 'hub');
      for (const event of ['dispatched', 'claimed', 'prepared', 'go', 'started', 'submitting', 'submitted', 'result']) assert.ok(fact.events.includes(event), `${event} in ${fact.events.join(',')}`);
      const result = done[index].result as Data;
      assert.ok((result.evidence_ids as string[]).length >= 1, 'evidence uploaded before the result and linked');
    }
    const posts = fixtures.posts();
    assert.equal(posts.filter(post => post.platform === 'x' && post.text.startsWith('M2 loop X post')).length, 1);
    assert.equal(posts.filter(post => post.platform === 'tiktok' && post.text.startsWith('M2 loop TikTok post')).length, 1);
    assert.ok(posts.every(post => post.media_sha256 === clip.sha256), 'the media bytes arrived intact through the signed download');
    const published = await read(ctx => ctx.list('owner_alert').filter(row => row.kind === 'published').map(toOwnerAlert));
    assert.equal(published.length, 2);
  });

  test('captcha: the job stops as needs_owner, the owner alert names the machine and account, then it resumes and posts', async () => {
    fixtures.setScenario('x', 'captcha');
    const target = await schedule(machines[0], 'M2 captcha post', Date.now() + 12_000);
    const blocked = await until(async () => { const job = await jobFor(target); return job?.status === 'needs_owner' && job; }, 90_000, 'needs_owner');
    assert.equal((blocked.blocker as Data).code, 'captcha');
    assert.equal((blocked.blocker as Data).machine_name, 'Mac-B');
    assert.equal((blocked.blocker as Data).channel_label, 'X @fixture_x');
    const alert = await until(() => read(ctx => ctx.list('owner_alert').map(toOwnerAlert).find(row => row.kind === 'worker_blocker' && row.post?.id === target)), 20_000, 'owner alert');
    assert.equal(alert.severity, 'urgent');
    assert.match(`${alert.title} ${alert.body}`, /Mac-B/);
    assert.match(`${alert.title} ${alert.body}`, /@fixture_x/);
    const session = await read(ctx => ctx.list('browser_session').find(row => row.social_account_id === machines[0].accountId)!);
    assert.equal(session.status, 'challenge');
    assert.equal(fixtures.posts().filter(post => post.text.startsWith('M2 captcha post')).length, 0);
    fixtures.setScenario('x', 'ok');
    const posted = await until(async () => { const job = await jobFor(target); return job?.status === 'succeeded' && job; }, 120_000, 'published after the captcha cleared');
    assert.ok(posted.result);
    assert.equal(fixtures.posts().filter(post => post.text.startsWith('M2 captcha post')).length, 1);
  });

  test('heartbeats keep presence in memory: an idle heartbeat does not rewrite the snapshot', async () => {
    const revision = () => read(ctx => [...ctx.list('connector_device').map(row => `${row.id}:${row.version}`), `nonces:${ctx.list('device_nonce').length}`].join(','));
    const first = await revision();
    await new Promise(done => setTimeout(done, 2500));
    assert.equal(await revision(), first, 'connector_device rows are unchanged across several idle heartbeats');
    const online = await read(ctx => machines.map(machine => (ctx as Context & { presence?: (id: string) => unknown }).presence?.(machine.deviceId!)));
    assert.ok(online.every(Boolean));
  });
});
