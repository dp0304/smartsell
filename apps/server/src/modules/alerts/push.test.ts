import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { Problem, type Context } from '@smartsell/contracts';
import { alertFixture, seedHub, type AlertFixture } from './fixtures.js';
import { createOwnerAlert } from './raise.js';
import { configureAlerts, resetAlertHooks } from './model.js';
import { PUSH_BACKOFF_MS, PUSH_MAX_ATTEMPTS, createAlertsDrain, formatPush, maskPushUrl, sendPush } from './push.js';
import { EgressDenied, publicAddressFor } from '../../integration/public-egress.js';
import { configuration } from '../../config.js';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: Record<string, unknown>; inTransaction: boolean }
const seen: Seen[] = [];
let respond: (url: string) => { status: number; body?: unknown; delayMs?: number } = () => ({ status: 200, body: { ok: true, code: 200 } });
let inTransaction = false;
let base = '';
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: text ? JSON.parse(text) : {}, inTransaction });
    const reply = respond(req.url ?? '');
    setTimeout(() => {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    }, reply.delayMs ?? 0);
  });
});
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
  respond = () => ({ status: 200, body: { ok: true, code: 200 } });
  resetAlertHooks();
  // The fake services listen on 127.0.0.1, as a hub's own ntfy may (S6: the hub allows private push addresses).
  configureAlerts({ secretKey: randomBytes(32), telegramApiBase: `${base}/tg`, publicOrigin: 'https://hub.tail1234.ts.net', privateEgress: true });
});

const NTFY_TOKEN = 'tk_ntfyAccessToken123';
const TG_TOKEN = '123456789:AAHfakeTelegramBotTokenForTests_0001';

function configure(f: AlertFixture, channels: unknown[]) {
  return f.run<{ channels: Record<string, unknown>[] }>('hub_alerts_update_channels', { body: { channels } });
}
function transact(f: AlertFixture) {
  return async <T>(run: (ctx: Context) => T | Promise<T>) => {
    inTransaction = true;
    try { return await run(f.ctx); } finally { inTransaction = false; }
  };
}
function captchaAlert(f: AlertFixture, hub: ReturnType<typeof seedHub>) {
  const target = f.ctx.create('publish_target', { social_account_id: hub.x.id, scheduled_at: '2026-11-25T01:00:00.000Z', caption: 'Spring lure sale #fishing' });
  return createOwnerAlert(f.ctx, { kind: 'worker_blocker', severity: 'urgent', dedupe_key: 'job-1:captcha:0',
    title: 'Mac-B 的 X @fixture_x：出現驗證碼，已停止。', body: 'Spring lure sale #fishing — this body must never reach a phone. 第二句。',
    machine_id: hub.macB.id, social_account_id: hub.x.id, post_id: target.id })!;
}

test('push format carries only machine, account, local time, one sentence and the link', () => {
  const f = alertFixture();
  const hub = seedHub(f);
  const alert = captchaAlert(f, hub);
  const message = formatPush(alert, 'Asia/Shanghai');
  assert.equal(message.title, 'SmartSell · 需要你處理');
  assert.equal(message.message, ['機器：Mac-B', '帳號：X @fixture_x', '時間：11/25 08:00', 'Mac-B 的 X @fixture_x：出現驗證碼，已停止。',
    `https://hub.tail1234.ts.net/app/ws-1/posts/${alert.post_id}`].join('\n'));
  assert.doesNotMatch(message.message, /Spring lure|fishing|第二句/);
  // A long or multi-sentence title is cut to its first sentence.
  const noisy = createOwnerAlert(f.ctx, { kind: 'machine_setup', severity: 'normal', dedupe_key: 'n', title: '第一句。第二句不應出現。', body: 'x' })!;
  assert.match(formatPush(noisy, 'UTC').message, /第一句。\n/);
  assert.doesNotMatch(formatPush(noisy, 'UTC').message, /第二句/);
});

test('channel settings: human-only writes, strict validation, tokens sealed at rest and never returned', () => {
  const f = alertFixture();
  seedHub(f);
  const view = configure(f, [
    { kind: 'ntfy', url: `${base}/smartsell-alerts`, token: NTFY_TOKEN },
    { kind: 'bark', url: `${base}/bark/BarkDeviceKey123` },
    { kind: 'telegram', chat_id: '-1001234567890', bot_token: TG_TOKEN },
  ]);
  assert.deepEqual(view.channels.map(channel => [channel.kind, channel.token_set]), [['ntfy', true], ['bark', undefined], ['telegram', true]]);
  const stored = JSON.stringify(f.ctx.list('alert_channel'));
  assert.ok(!stored.includes(NTFY_TOKEN) && !stored.includes(TG_TOKEN), 'tokens are encrypted at rest');
  const read = JSON.stringify(f.run('hub_alerts_get_channels'));
  assert.ok(!read.includes(NTFY_TOKEN) && !read.includes(TG_TOKEN) && !read.includes('token_sealed'));
  // Omitted token keeps it, null clears it; removing a kind deletes its row.
  configure(f, [{ kind: 'ntfy', url: `${base}/smartsell-alerts` }, { kind: 'telegram', chat_id: '-1001234567890' }]);
  assert.deepEqual(f.run<{ channels: Record<string, unknown>[] }>('hub_alerts_get_channels').channels.map(channel => [channel.kind, channel.token_set]),
    [['ntfy', true], ['telegram', true]]);
  configure(f, [{ kind: 'ntfy', url: `${base}/smartsell-alerts`, token: null }]);
  assert.deepEqual(f.run<{ channels: Record<string, unknown>[] }>('hub_alerts_get_channels').channels.map(channel => [channel.kind, channel.token_set]), [['ntfy', false]]);
  const invalid = (body: Record<string, unknown>) => assert.throws(() => f.run('hub_alerts_update_channels', { body }),
    (error: unknown) => error instanceof Problem && error.status === 422 && error.code === 'INVALID_ARGUMENTS');
  invalid({ channels: [{ kind: 'telegram', chat_id: '42' }] });                         // no bot token anywhere
  invalid({ channels: [{ kind: 'ntfy', url: 'ftp://example.com/topic' }] });
  invalid({ channels: [{ kind: 'ntfy', url: 'https://user:pw@example.com/topic' }] });
  invalid({ channels: [{ kind: 'ntfy', url: 'https://example.com/' }] });              // no topic
  invalid({ channels: [{ kind: 'bark', url: 'https://api.day.app/key', token: 'x' }] }); // unknown field
  invalid({ channels: [{ kind: 'email', url: 'https://example.com/a' }] });
  invalid({ channels: [{ kind: 'ntfy', url: `${base}/a` }, { kind: 'ntfy', url: `${base}/b` }] });
  invalid({ preferences: { published: 'no' } });
  invalid({ volume: 3 });
  f.ctx.role = 'manager';
  assert.throws(() => f.run('hub_alerts_get_channels'), (error: unknown) => error instanceof Problem && error.status === 403);
  // Without a configured key or APP_SECRET, a token cannot be stored: an explicit error, never a silent plaintext write.
  f.ctx.role = 'owner';
  resetAlertHooks();
  configureAlerts({ privateEgress: true });
  const secret = process.env.APP_SECRET;
  delete process.env.APP_SECRET;
  try {
    assert.throws(() => configure(f, [{ kind: 'ntfy', url: `${base}/t`, token: NTFY_TOKEN }]),
      (error: unknown) => error instanceof Problem && error.status === 503);
  } finally { if (secret !== undefined) process.env.APP_SECRET = secret; }
});

test('E46 (SEC-1): an Agent credential reads push URLs with the Bark key and ntfy topic masked; the settings page sees them in full', () => {
  const f = alertFixture();
  seedHub(f);
  configure(f, [
    { kind: 'bark', url: 'https://api.day.app/SECRETDEVICEKEY123/' },
    { kind: 'ntfy', url: 'https://ntfy.sh/smartsell-owner-7f3a9c', token: NTFY_TOKEN },
  ]);
  const urls = () => f.run<{ channels: { kind: string; url?: string }[] }>('hub_alerts_get_channels').channels.map(channel => [channel.kind, channel.url]);
  // The owner on the settings page (a session, no Agent credential).
  assert.deepEqual(urls(), [['ntfy', 'https://ntfy.sh/smartsell-owner-7f3a9c'], ['bark', 'https://api.day.app/SECRETDEVICEKEY123']]);
  // The same owner's Codex through hub_v1 (agentCredentialId, as integration/workspace-services.ts sets it).
  Object.assign(f.ctx, { agentCredentialId: 'agent-connection-1' });
  assert.deepEqual(urls(), [['ntfy', 'https://ntfy.sh/****3a9c'], ['bark', 'https://api.day.app/****Y123']]);
  const read = JSON.stringify(f.run('hub_alerts_get_channels'));
  assert.ok(!read.includes('SECRETDEVICEKEY') && !read.includes('smartsell-owner') && !read.includes(NTFY_TOKEN), read);
  // Short secrets show no characters; a base path stays, the query (ntfy ?auth=) is hidden.
  assert.equal(maskPushUrl('ntfy', 'https://push.example.com/ntfy/abc123?auth=tk_secret'), 'https://push.example.com/ntfy/****?****');
  assert.equal(maskPushUrl('bark', 'https://bark.example.com/ShortKey/extra'), 'https://bark.example.com/****');
  assert.equal(maskPushUrl('bark', 'not a url'), '****');
});

test('the drain sends ntfy, Bark and Telegram requests outside any transaction and records them sent', async () => {
  const f = alertFixture();
  const hub = seedHub(f);
  configure(f, [
    { kind: 'ntfy', url: `${base}/smartsell-alerts`, token: NTFY_TOKEN },
    { kind: 'bark', url: `${base}/bark/BarkDeviceKey123` },
    { kind: 'telegram', chat_id: '-1001234567890', bot_token: TG_TOKEN },
  ]);
  const alert = captchaAlert(f, hub);
  assert.equal(alert.push_status, 'pending');
  await createAlertsDrain()(transact(f));
  assert.equal(seen.length, 3);
  assert.ok(seen.every(request => request.method === 'POST' && !request.inTransaction), 'no HTTP while a transaction is open');
  const postUrl = `https://hub.tail1234.ts.net/app/ws-1/posts/${alert.post_id}`;
  const ntfy = seen.find(request => request.url === '/')!;
  assert.equal(ntfy.headers.authorization, `Bearer ${NTFY_TOKEN}`);
  assert.deepEqual({ ...ntfy.body, message: undefined }, { topic: 'smartsell-alerts', title: 'SmartSell · 需要你處理', message: undefined, click: postUrl, priority: 5, tags: ['warning'] });
  const bark = seen.find(request => request.url === '/bark/BarkDeviceKey123')!;
  assert.equal(bark.body.level, 'timeSensitive');
  assert.equal(bark.body.url, postUrl);
  assert.equal(bark.body.group, 'SmartSell');
  const telegram = seen.find(request => request.url === `/tg/bot${TG_TOKEN}/sendMessage`)!;
  assert.equal(telegram.body.chat_id, '-1001234567890');
  assert.equal(telegram.body.disable_notification, false);
  for (const text of [ntfy.body.message, bark.body.body, telegram.body.text]) {
    assert.match(String(text), /機器：Mac-B\n帳號：X @fixture_x\n時間：11\/25 08:00\nMac-B 的 X @fixture_x：出現驗證碼，已停止。/);
    assert.doesNotMatch(String(text), /Spring lure|fishing|body must never/);
  }
  const row = f.ctx.get('owner_alert', alert.id);
  assert.equal(row.push_status, 'sent');
  assert.deepEqual((row.deliveries as { status: string; attempts: number }[]).map(delivery => [delivery.status, delivery.attempts]), [['sent', 1], ['sent', 1], ['sent', 1]]);
  await createAlertsDrain()(transact(f));
  assert.equal(seen.length, 3, 'a sent alert is never pushed twice');
});

test('a failing push is retried 3 times with backoff, then recorded as failed', async () => {
  const f = alertFixture();
  const hub = seedHub(f);
  configure(f, [{ kind: 'ntfy', url: `${base}/smartsell-alerts` }]);
  respond = () => ({ status: 500 });
  const alert = captchaAlert(f, hub);
  let clock = Date.parse('2026-11-25T00:00:00.000Z');
  const drain = createAlertsDrain({ now: () => clock });
  await drain(transact(f));
  assert.equal(seen.length, 1);
  await drain(transact(f));
  assert.equal(seen.length, 1, 'no retry before the backoff elapses');
  for (const wait of PUSH_BACKOFF_MS) {
    clock += wait;
    await drain(transact(f));
  }
  assert.equal(seen.length, PUSH_MAX_ATTEMPTS);
  assert.equal(PUSH_MAX_ATTEMPTS, 4);
  clock += 3_600_000;
  await drain(transact(f));
  assert.equal(seen.length, 4, 'nothing after the third retry');
  const row = f.ctx.get('owner_alert', alert.id);
  assert.equal(row.push_status, 'failed');
  const [delivery] = row.deliveries as { status: string; attempts: number; last_error: string }[];
  assert.deepEqual([delivery!.status, delivery!.attempts, delivery!.last_error], ['failed', 4, 'ntfy HTTP 500']);
  const channel = f.ctx.list('alert_channel')[0]!;
  assert.deepEqual({ ...(channel.last_delivery as object), at: undefined }, { alert_id: alert.id, at: undefined, status: 'failed', error: 'ntfy HTTP 500', attempts: 4 });
  // The alert itself still reached the bell and stream; only the phone push failed.
  assert.equal(f.ctx.list('notification').length, 1);
});

test('a retry that succeeds ends sent; a stale send lease is retried; an unreadable token fails without a request', async () => {
  const f = alertFixture();
  const hub = seedHub(f);
  configure(f, [{ kind: 'bark', url: `${base}/bark/BarkDeviceKey123` }]);
  let calls = 0;
  respond = () => (++calls === 1 ? { status: 503 } : { status: 200, body: { code: 200 } });
  const alert = captchaAlert(f, hub);
  let clock = Date.parse(f.ctx.now);
  const drain = createAlertsDrain({ now: () => clock });
  await drain(transact(f));
  clock += PUSH_BACKOFF_MS[0]!;
  await drain(transact(f));
  assert.equal(f.ctx.get('owner_alert', alert.id).push_status, 'sent');
  assert.equal(seen.length, 2);

  // The hub died mid-send: the delivery is still 'sending'; after the lease it is retried.
  const second = createOwnerAlert(f.ctx, { kind: 'missed', severity: 'urgent', dedupe_key: 'j2', title: 'Win-C 的 TikTok @fixture_tt 貼文沒有發出。', body: 'b' })!;
  f.ctx.update('owner_alert', second.id, { deliveries: (second.deliveries as object[]).map(delivery => ({ ...delivery, status: 'sending', lease_until: new Date(clock + 60_000).toISOString() })) });
  await drain(transact(f));
  assert.equal(seen.length, 2);
  clock += 61_000;
  await drain(transact(f));
  assert.equal(seen.length, 3);
  assert.equal(f.ctx.get('owner_alert', second.id).push_status, 'sent');

  const g = alertFixture();
  seedHub(g);
  configure(g, [{ kind: 'telegram', chat_id: '42', bot_token: TG_TOKEN }]);
  const third = createOwnerAlert(g.ctx, { kind: 'published', severity: 'info', dedupe_key: 'p', title: 'X 已發出。', body: 'b' })!;
  configureAlerts({ secretKey: randomBytes(32) });   // key rotated: the stored token no longer opens
  const before = seen.length;
  await createAlertsDrain()(transact(g));
  assert.equal(seen.length, before);
  assert.deepEqual((g.ctx.get('owner_alert', third.id).deliveries as { status: string; last_error: string }[]).map(delivery => [delivery.status, delivery.last_error]),
    [['failed', 'token_unavailable']]);
});

test('hub_alerts_test queues one test push per channel; the drain sends it once and reports the outcome', async () => {
  const f = alertFixture();
  seedHub(f);
  assert.throws(() => f.run('hub_alerts_test'), (error: unknown) => error instanceof Problem && error.status === 422);
  configure(f, [{ kind: 'ntfy', url: `${base}/smartsell-alerts` }, { kind: 'telegram', chat_id: '42', bot_token: TG_TOKEN }]);
  respond = url => url.startsWith('/tg/') ? { status: 401, body: { ok: false, description: `Unauthorized for ${TG_TOKEN}` } } : { status: 200 };
  const queued = f.run<{ test_id: string; status: string; channels: string[] }>('hub_alerts_test');
  assert.equal(queued.status, 'queued');
  assert.deepEqual(queued.channels, ['ntfy', 'telegram']);
  assert.equal(seen.length, 0, 'the operation itself does no IO');
  await createAlertsDrain()(transact(f));
  await createAlertsDrain()(transact(f));
  assert.equal(seen.length, 2, 'a test push is attempted once');
  assert.match(String(seen.find(request => request.url === '/')!.body.message), /這是一則測試通知/);
  const channels = f.run<{ channels: { kind: string; last_test: { status: string; error: string | null } }[] }>('hub_alerts_get_channels').channels;
  assert.deepEqual(channels.map(channel => [channel.kind, channel.last_test.status]), [['ntfy', 'sent'], ['telegram', 'failed']]);
  const error = channels[1]!.last_test.error!;
  assert.match(error, /^Telegram HTTP 401/);
  assert.ok(!error.includes(TG_TOKEN), 'errors never carry the token');
  assert.equal(f.ctx.get('alert_push_test', queued.test_id).status, 'partial');
});

test('sendPush reports timeouts and network errors without the URL', async () => {
  respond = () => ({ status: 200, delayMs: 300 });
  const message = { title: 't', message: 'm', url: 'https://hub/x', severity: 'normal' as const };
  assert.deepEqual(await sendPush({ kind: 'bark', url: `${base}/bark/k`, chat_id: null, token: null }, message, fetch, 50), { ok: false, error: 'timeout' });
  assert.deepEqual(await sendPush({ kind: 'bark', url: 'http://127.0.0.1:1/bark/k', chat_id: null, token: null }, message, fetch, 1000), { ok: false, error: 'network_error' });
});

test('S6: outside the hub, push to loopback, private or metadata addresses is refused before any request; the hub still reaches its own ntfy', async () => {
  const message = { title: 't', message: 'm', url: 'https://hub/x', severity: 'normal' as const };
  configureAlerts({ privateEgress: false });
  for (const url of [`${base}/bark/k`, 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.7/topic', 'http://[::1]:8080/topic', 'http://100.101.102.103/topic']) {
    assert.deepEqual(await sendPush({ kind: 'bark', url, chat_id: null, token: null }, message), { ok: false, error: 'destination_not_public' }, url);
    assert.deepEqual(await sendPush({ kind: 'ntfy', url, chat_id: null, token: null }, message), { ok: false, error: 'destination_not_public' }, url);
  }
  assert.equal(seen.length, 0, 'nothing reached the loopback service');
  // The guard itself: literal addresses need no DNS; only public ones pass.
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '[::1]', '0.0.0.0']) {
    await assert.rejects(publicAddressFor(host), EgressDenied, host);
  }
  assert.equal(await publicAddressFor('93.184.216.34'), '93.184.216.34');
  // Channel settings refuse a plainly private URL at once.
  const f = alertFixture();
  seedHub(f);
  for (const url of [`${base}/smartsell-alerts`, 'http://localhost:2586/alerts', 'http://169.254.169.254/latest']) {
    assert.throws(() => configure(f, [{ kind: 'ntfy', url }]), (error: unknown) => error instanceof Problem && error.code === 'INVALID_ARGUMENTS', url);
  }
  assert.equal(configure(f, [{ kind: 'ntfy', url: 'https://ntfy.sh/smartsell-alerts' }]).channels.length, 1);
  // The home hub (and an explicit SMARTSELL_PUSH_PRIVATE_NETWORK=1) keeps loopback and tailnet ntfy working.
  configureAlerts({ privateEgress: true });
  assert.equal(configure(f, [{ kind: 'ntfy', url: `${base}/smartsell-alerts` }]).channels.length, 1);
  assert.deepEqual(await sendPush({ kind: 'ntfy', url: `${base}/smartsell-alerts`, chat_id: null, token: null }, message), { ok: true });
  assert.equal(seen.length, 1);
});

test('S6: private push addresses are allowed in hub mode or by an explicit setting only', () => {
  const production = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://fixture/db', PUBLIC_ORIGIN: 'https://app.example.test', APP_SECRET: randomBytes(32).toString('hex') };
  assert.equal(configuration(production).pushPrivateNetwork, false);
  assert.equal(configuration({ ...production, SMARTSELL_PUSH_PRIVATE_NETWORK: '1' }).pushPrivateNetwork, true);
  assert.equal(configuration({}).pushPrivateNetwork, false, 'development too, unless set');
  assert.equal(configuration({ SMARTSELL_MODE: 'hub', NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://hub.tail1234.ts.net', APP_SECRET: randomBytes(32).toString('hex'),
    SMARTSELL_HUB_DIR: '/tmp/smartsell-hub-config-fixture' }).pushPrivateNetwork, true);
});
