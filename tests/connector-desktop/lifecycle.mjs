import assert from 'node:assert/strict';
import { createHash, randomBytes, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, expect } from '@playwright/test';
import { frozenRevisionHash, importDevicePublicKey } from '../../packages/connector-tasks/src/index.ts';

// Load the bundled production entry. Replace only host boundaries that would
// touch the system Keychain, real Chrome, or a native file-picker dialog.
function startFixture() {
  const assert = require('node:assert/strict');
  const { dialog, safeStorage, shell } = require('electron');
  const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { readFileSync, appendFileSync } = require('node:fs');
  const key = Buffer.from(process.env.FIXTURE_STORAGE_KEY, 'hex');
  require('node:os').hostname = () => 'Fixture Worker';
  Object.assign(safeStorage, {
    isEncryptionAvailable() {
      appendFileSync(process.env.FIXTURE_OBSERVATIONS, 'storage:available\n');
      return true;
    },
    encryptString(text) {
      appendFileSync(process.env.FIXTURE_OBSERVATIONS, 'storage:encrypt\n');
      if (settings().denyStorage) throw new Error('fixture keychain denial');
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      if (settings().denyDecrypt) throw new Error('fixture keychain denial');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
    },
  });
  const settings = () => JSON.parse(readFileSync(process.env.FIXTURE_SETTINGS, 'utf8'));
  dialog.showOpenDialog = async () => {
    const file = settings().file;
    return { canceled: !file, filePaths: file ? [file] : [] };
  };
  shell.openExternal = async url => { appendFileSync(process.env.FIXTURE_AUTHORIZATION, `${url}\n`); };
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    assert.equal(new URL(input).origin, process.env.FIXTURE_ORIGIN);
    return fetch(input, options);
  };
  require('node:child_process').spawn = (_executable, args) => {
    assert(args.includes('--remote-debugging-pipe'), 'never spawn a real browser');
    const child = new EventEmitter(), source = new PassThrough(), sink = new PassThrough();
    child.stdio = [null, null, null, source, sink];
    child.kill = () => child.emit('exit', 0);
    const tabs = new Map();
    let buffer = '';
    source.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const { id, method, params, sessionId } = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const url = tabs.get(sessionId);
        let result = {};
        switch (method) {
          case 'Browser.getVersion':
            appendFileSync(process.env.FIXTURE_OBSERVATIONS, 'chrome:version\n');
            result = { product: settings().rejectChrome ? 'Other/fixture' : 'Chrome/fixture' };
            break;
          case 'Target.getTargets': result = { targetInfos: [...tabs].map(([targetId, url]) => ({ targetId, url, type: 'page' })) }; break;
          case 'Target.createTarget': {
            const targetId = String(tabs.size + 1);
            tabs.set(targetId, params.url);
            result = { targetId };
            break;
          }
          case 'Target.attachToTarget': result = { sessionId: params.targetId }; break;
          case 'Target.activateTarget': break;
          case 'Page.navigate':
            tabs.set(sessionId, params.url);
            appendFileSync(process.env.FIXTURE_OBSERVATIONS, `navigate:${new URL(params.url).hostname}\n`);
            break;
          case 'Page.getFrameTree': result = { frameTree: { frame: { id: sessionId, url } } }; break;
          case 'Page.createIsolatedWorld': result = { executionContextId: 1 }; break;
          case 'Runtime.evaluate': {
            const zhihu = new URL(url).hostname === 'www.zhihu.com';
            appendFileSync(process.env.FIXTURE_OBSERVATIONS, zhihu ? 'zhihu\n' : 'channel\n');
            const host = new URL(url).hostname;
            if (host === 'x.com' && params.expression.includes('inspectXPosts')) {
              let value = { kind: 'profile', identity: 'fixturex' };
              if (params.expression.endsWith(', true)')) {
                tabs.set(sessionId, 'https://x.com/fixturex');
                value = { kind: 'navigating', identity: 'fixturex' };
              } else if (url === 'https://x.com/fixturex') {
                value = { kind: 'posts', identity: 'fixturex', posts: [
                  { id: '123', url: 'https://x.com/fixturex/status/123', text: 'Local fixture video', has_video: true },
                ] };
              }
              result = { result: { value } };
              break;
            }
            result = { result: { value: zhihu ? { kind: 'login-required' } : settings().channels?.[host] ?? settings().channel } };
            break;
          }
          case 'Browser.close': setImmediate(child.kill); break;
          default: throw new Error(`Unexpected fixture browser action: ${method}`);
        }
        const reply = () => sink.write(`${JSON.stringify({ id, result })}\0`);
        const delay = method === 'Browser.getVersion' && settings().chromeVersionDelay;
        if (delay) setTimeout(reply, delay);
        else reply();
      }
    });
    return child;
  };
  require('./dist/main.cjs');
}

export async function runLifecycle({ directory, executablePath, evidence }) {
  const temp = await mkdtemp(join(tmpdir(), 'smartsell-lifecycle-'));
  const fixtureSettings = join(temp, 'settings.json'), observations = join(temp, 'observations.txt');
  const authorization = join(temp, 'authorization.txt');
  const file = join(temp, 'selected.csv'), replacement = join(temp, 'replacement.csv');
  const media = join(temp, 'fixture.mp4'), mediaBytes = Buffer.from('local media fixture');
  let settings = { channel: { kind: 'login' } };
  const configure = async patch => { settings = { ...settings, ...patch }; await writeFile(fixtureSettings, JSON.stringify(settings)); };
  let electron, publicKey, social, socialStatus, zhihu, waitingUpload;
  const socialReports = [];
  const browserReports = [], ready = [];
  const uploads = [], reports = [], requests = [], registered = new Map(), nonces = new Set(), committed = new Map();
  let pairs = 0, heartbeats = 0, catalogClaims = 0;
  let catalogAvailable = false, rejectHeartbeat = true;
  const server = createServer(async (req, res) => {
    try {
      const bytes = Buffer.concat(await Array.fromAsync(req));
      const body = JSON.parse(bytes.toString());
      const ok = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); };
      const path = req.url;
      if (path === '/api/v1/device/pair') {
        pairs++;
        publicKey = importDevicePublicKey(body.public_key);
        assert(verify(null, Buffer.from(JSON.stringify(['smartsell.pair.v1', 'fixture-workspace', 'a'.repeat(32), body.public_key, process.platform, 'Fixture Worker'])), publicKey, Buffer.from(body.proof, 'base64url')));
        return ok({ device_id: 'fixture-device' });
      }
      const action = ({ '/api/v1/device/heartbeat': 'heartbeat', '/api/v1/device/claim': 'claim',
        '/api/v1/device/social-status/claim': 'social.status.claim', '/api/v1/device/social-status/report': 'social.status.report',
        '/api/v1/attempts/social-fixture/ready': 'attempt.ready', '/api/v1/attempts/social-fixture/device-report': 'attempt.report',
        '/api/v1/device/catalog/claim': 'catalog.claim',
        '/api/v1/device/catalog/upload': 'catalog.upload', '/api/v1/device/channels/register': 'channels.register', '/api/v1/device/zhihu-stats/claim': 'zhihu.stats.claim', '/api/v1/device/zhihu-stats/report': 'zhihu.stats.report' })[path];
      assert(action, `Unexpected service route ${path}`);
      const nonce = req.headers['x-smartsell-nonce'];
      assert(nonce && !nonces.has(nonce));
      nonces.add(nonce);
      assert.equal(req.headers['x-smartsell-workspace'], 'fixture-workspace');
      assert.equal(req.headers['x-smartsell-device'], 'fixture-device');
      const signed = ['smartsell.device.v1', 'fixture-workspace', 'fixture-device', action, req.headers['x-smartsell-timestamp'], nonce, createHash('sha256').update(bytes).digest('hex')];
      assert(verify(null, Buffer.from(JSON.stringify(signed)), publicKey, Buffer.from(req.headers['x-smartsell-signature'], 'base64url')));
      switch (action) {
        case 'channels.register': {
          requests.push(body);
          assert.equal(body.confirmed, true);
          for (const row of body.selections) assert(Number.isFinite(Date.parse(row.observed_at)));
          if (requests.length === 1) { req.socket.destroy(); return; }
          if (requests.length === 2) { res.statusCode = 409; res.end(); return; }
          return ok({ registrations: body.selections.map(({ kind, platform, external_id }) => {
            const result = { kind, platform, external_id, resource_id: `fixture-${platform}`, device_id: 'fixture-device' };
            registered.set(platform, result);
            return result;
          }) });
        }
        case 'heartbeat':
          assert.equal(body.social_status_version, body.include_browser_work ? 1 : undefined);
          heartbeats++;
          if (rejectHeartbeat) { res.statusCode = 503; return res.end(); }
          return ok({ status: 'online', ...(body.include_browser_work && { social_status_version: 1, browser_work: { pending_identity: [] } }) });
        case 'social.status.claim': {
          assert.deepEqual(body, {});
          const claim = socialStatus;
          socialStatus = undefined;
          return ok({ claim: claim ?? null });
        }
        case 'social.status.report': socialReports.push(body); return ok({ id: body.id, status: 'completed' });
        case 'claim': {
          assert.deepEqual(body, { channel: 'browser' });
          const claim = social;
          social = undefined;
          return ok({ claim: claim ?? null });
        }
        case 'attempt.ready': ready.push(body); return ok({ status: 'verified' });
        case 'attempt.report': browserReports.push(body); return ok({ status: 'outcome_unknown' });
        case 'zhihu.stats.claim': {
          const claim = zhihu;
          zhihu = undefined;
          return ok({ claim: claim ?? null });
        }
        case 'zhihu.stats.report': reports.push(body); return ok({ id: body.id, status: body.result.status });
        case 'catalog.claim':
          if (!catalogAvailable) return ok({ job: null });
          catalogClaims++;
          return ok({ job: { id: 'fixture-job', store_id: 'fixture-store', device_id: 'fixture-device', store_name: 'Fixture Shop', provider: 'shopify',
            external_store_id: 'fixture.myshopify.com', portal_url: 'https://admin.shopify.com/store/fixture', claim_id: 'fixture-lease', expires_at: new Date(Date.now() + 120_000).toISOString() } });
        case 'catalog.upload':
          uploads.push(body);
          if (uploads.length === 1) {
            catalogAvailable = false;
            committed.set(body.job_id, { import_id: 'fixture-import', status: 'previewed' });
            waitingUpload = res;
            return; // Committed by the isolated fixture; the response never reaches the app.
          }
          assert.deepEqual(body, uploads[0]);
          return ok(committed.get(body.job_id));
      }
    } catch (error) {
      res.statusCode = 500;
      res.end();
      console.error(error);
    }
  });
  try {
    await configure({});
    await writeFile(observations, '');
    await writeFile(media, mediaBytes);
    await writeFile(file, 'product_id,title\nitem,Fixture product\n');
    await writeFile(replacement, 'product_id,title\nother,Another product\n');
    await symlink(join(directory, 'dist'), join(temp, 'dist'), 'junction');
    await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'smartsell-lifecycle-fixture', main: 'entry.cjs' }));
    await writeFile(join(temp, 'entry.cjs'), `(${startFixture.toString()})();`);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const storage = randomBytes(32).toString('hex');
    const profile = join(temp, 'user-data');
    const launch = () => _electron.launch({ executablePath,
      args: [temp, `--user-data-dir=${profile}`, '--disable-background-networking', '--no-proxy-server'],
      env: { ...process.env, FIXTURE_SETTINGS: fixtureSettings, FIXTURE_OBSERVATIONS: observations, FIXTURE_AUTHORIZATION: authorization, FIXTURE_ORIGIN: origin, FIXTURE_STORAGE_KEY: storage }, timeout: 20_000 });
    electron = await launch();
    let page = await electron.firstWindow();
    const status = () => page.locator('#connection');
    const waitOnline = () => expect(status()).toHaveText('在线');
    const click = id => page.locator(`#${id}`).click();
    await expect(page.getByText('正式服务未配置')).toBeVisible();
    const step = id => page.locator(`#setup-${id}-status`);
    await expect(step('storage')).toHaveText('待检查');
    await expect(page.locator('#pair')).toBeHidden();
    await page.screenshot({ path: join(evidence, 'setup-initial.png') });
    const premature = await page.evaluate(url => window.connector.pair({ url, ownsDevice: true }), origin);
    assert.match(premature.error, /系统安全存储/);
    assert.equal(pairs, 0);
    assert.equal((await readFile(observations, 'utf8')).includes('storage:'), false);
    await configure({ denyStorage: true });
    await click('setup-check-storage');
    await expect(step('storage')).toHaveText('需重试');
    await expect(page.locator('#pair')).toBeHidden();
    await configure({ denyStorage: false });
    await click('setup-check-storage');
    await expect(step('storage')).toHaveText('已通过');
    assert.equal((await readFile(observations, 'utf8')).split('\n').filter(line => line === 'storage:encrypt').length, 2);
    const unowned = await page.evaluate(url => window.connector.pair({ url, ownsDevice: false }), origin);
    assert.match(unowned.error, /确认设备授权/);
    assert.equal(pairs, 0);
    const begin = async () => {
      await page.getByLabel('工作台网址').fill(origin);
      await page.locator('#pair [name=owns]').check();
      await page.getByRole('button', { name: '连接本机 Worker' }).click();
      await expect(page.locator('#cancel-authorization')).toBeVisible();
      const urls = (await readFile(authorization, 'utf8')).trim().split('\n');
      const url = new URL(urls.at(-1));
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, '/worker-connect');
      assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(url.searchParams.get('name'), await page.locator('#machine-name').textContent());
      return `http://127.0.0.1:${url.searchParams.get('port')}/smartsell-worker`;
    };
    const cancelled = await begin();
    await expect(step('pair')).toHaveText('等待浏览器');
    assert.equal(pairs, 0);
    await click('cancel-authorization');
    await expect(step('pair')).toHaveText('待授权');
    await expect(page.locator('#message')).toContainText('已取消浏览器授权');
    await assert.rejects(fetch(cancelled));
    const callback = await begin();
    const urls = (await readFile(authorization, 'utf8')).trim().split('\n');
    const state = new URL(urls.at(-1)).searchParams.get('state');
    const callbackWindow = electron.waitForEvent('window');
    await electron.evaluate(({ BrowserWindow }, url) => {
      const browser = new BrowserWindow({ show: false });
      void browser.loadURL(url);
    }, `${callback}#${new URLSearchParams({ state, workspace: 'fixture-workspace', code: 'a'.repeat(32) })}`);
    const callbackPage = await callbackWindow;
    await expect(callbackPage.locator('#status')).toContainText('已将授权交给本机 Worker');
    assert.equal(new URL(callbackPage.url()).hash, '');
    await callbackPage.close();
    await expect(step('pair')).toHaveText('已通过');
    await expect(step('signature')).toHaveText('需重试');
    assert.equal(pairs, 1);
    rejectHeartbeat = false;
    await click('connect');
    await waitOnline();
    await expect(step('signature')).toHaveText('已通过');
    await expect(step('chrome')).toHaveText('待连接');
    await configure({ rejectChrome: true });
    await click('setup-connect-chrome');
    await expect(step('chrome')).toHaveText('需重试');
    await configure({ rejectChrome: false, chromeVersionDelay: 900 });
    await click('setup-connect-chrome');
    await expect.poll(async () => (await readFile(observations, 'utf8')).match(/chrome:version/g)?.length).toBe(2);
    const concurrent = await page.evaluate(() => window.connector.connectChrome());
    assert.match(concurrent.error, /上一项操作仍在进行/);
    await click('stop');
    await expect(status()).toContainText('已紧急停止');
    await expect(step('chrome')).toHaveText('待连接');
    await expect(page.locator('#connect')).toBeEnabled();
    await configure({ chromeVersionDelay: 0 });
    await click('connect');
    await waitOnline();
    await click('setup-connect-chrome');
    await expect(step('chrome')).toHaveText('已通过');
    assert.equal((await readFile(observations, 'utf8')).split('\n').filter(line => line === 'chrome:version').length, 3);
    assert.doesNotMatch(await readFile(observations, 'utf8'), /navigate:/);
    await page.locator('#setup-channel-select').selectOption('youtube');
    await click('setup-add-channel');
    const youtube = page.locator('[data-channel=youtube]');
    await youtube.getByRole('button', { name: '在 Chrome 打开 YouTube' }).click();
    await expect(youtube.getByRole('status')).toHaveText('未验证');
    await youtube.getByRole('button', { name: '验证 YouTube' }).click();
    await expect(youtube.getByRole('status')).toHaveText('需登录');
    await expect(step('channels')).toHaveText('0 / 1 已验证');
    await expect(page.locator('#setup-channel-status-youtube')).toHaveText('需登录');
    await configure({ channel: { kind: 'identity', identity: 'UCabcdefghijklmnopqrstuv' } });
    await youtube.getByRole('button', { name: '验证 YouTube' }).click();
    await expect(youtube.locator('.channel-proof')).toContainText('UCabcdefghijklmnopqrstuv');
    await expect(step('channels')).toHaveText('1 / 1 已验证');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, 'setup-verified.png') });
    await configure({ channel: { kind: 'identity', identity: 'UCzyxwvutsrqponmlkjihgfe' } });
    await youtube.getByRole('button', { name: '验证 YouTube' }).click();
    await expect(page.locator('#setup-channel-status-youtube')).toHaveText('身份已切换');
    await expect(step('channels')).toHaveText('0 / 1 已验证');
    await configure({ channel: { kind: 'identity', identity: 'UCabcdefghijklmnopqrstuv' } });
    await youtube.getByRole('button', { name: '验证 YouTube' }).click();
    await expect(step('channels')).toHaveText('1 / 1 已验证');
    const tiktok = page.locator('[data-channel=tiktok]');
    const amazon = page.locator('[data-channel=amazon_sp]');
    await tiktok.getByRole('button', { name: '在 Chrome 打开 TikTok' }).click();
    await amazon.getByRole('button', { name: '在 Chrome 打开 Amazon' }).click();
    await configure({ channels: {
      'www.tiktok.com': { kind: 'login' }, 'sellercentral.amazon.com': { kind: 'login' },
    } });
    await click('channel-scan');
    await expect(tiktok.getByRole('status')).toHaveText('需登录');
    await expect(amazon.getByRole('status')).toHaveText('需登录');
    await expect(tiktok.getByRole('checkbox')).toBeHidden();
    await expect(amazon.getByRole('checkbox')).toBeHidden();
    await configure({ channels: {
      'www.tiktok.com': { kind: 'identity', identity: '1234567890123456789' },
      'sellercentral.amazon.com': { kind: 'identity', identity: 'FIXTUREAMAZON' },
    } });
    await click('channel-scan');
    await expect(tiktok.getByRole('checkbox')).toBeVisible();
    await expect(amazon.getByRole('checkbox')).toBeVisible();
    await expect(page.locator('#channel-register')).toBeDisabled();
    await tiktok.getByRole('checkbox').check();
    await amazon.getByRole('checkbox').check();
    await click('channel-register');
    await expect(page.locator('#channel-error')).toContainText('未收到工作台');
    await click('channel-register');
    await expect(page.locator('#channel-error')).toContainText('绑定冲突');
    await click('channel-register');
    await expect(tiktok.locator('.channel-registration')).toHaveText('工作台已确认登记');
    await expect(amazon.locator('.channel-registration')).toHaveText('工作台已确认登记');
    await expect(youtube.locator('.channel-registration')).toBeHidden();
    assert.equal(registered.size, 2);
    for (const { selections } of requests) assert.deepEqual(selections.map(row => [row.kind, row.platform, row.external_id]), [
      ['social', 'tiktok', '1234567890123456789'], ['store', 'amazon_sp', 'FIXTUREAMAZON'],
    ]);
    await tiktok.getByRole('checkbox').check();
    await click('channel-register');
    await expect(page.locator('#message')).toContainText('已确认登记 1 个渠道');
    assert.equal(requests.length, 4);
    assert.equal(registered.size, 2);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, 'channels-registered.png'), fullPage: true });
    await click('disconnect');
    await expect(status()).toHaveText('已断开');
    await expect(youtube.getByRole('status')).toHaveText('已过期');
    await expect(page.locator('#setup-channel-status-youtube')).toHaveText('已过期');
    await expect(step('channels')).toHaveText('0 / 1 已验证');
    await configure({ channels: { ...settings.channels, 'creator.douyin.com': { kind: 'identity', identity: 'fixture-social' } } });
    assert(!(await readFile(observations, 'utf8')).includes('navigate:creator.douyin.com'));
    const revision = { id: 'fixture-revision', title: 'Fixture title', body: 'Fixture only', tags: [], visibility: 'private',
      media: [{ id: 'fixture-media', sha256: createHash('sha256').update(mediaBytes).digest('hex') }] };
    const hash = frozenRevisionHash(revision);
    social = { effective_mode: 'auto', fencing_token: 5, write_slot_token: 6, lease_expires_at: new Date(Date.now() + 120_000).toISOString(), task: {
      schema_version: 1, kind: 'douyin.video.publish', workspace_id: 'fixture-workspace', connector_device_id: 'fixture-device',
      attempt_id: 'social-fixture', account_id: 'fixture-account', binding_id: 'fixture-binding', platform_identity: 'fixture-social',
      target: { channel: 'browser', profile_id: 'fixture-session', app: 'douyin' }, payload: {
        frozen_hash: hash, approval: { id: 'fixture-approval', resource_hash: hash }, revision,
      },
    } };
    await click('connect');
    await waitOnline();
    await expect(page.locator('#task-proof')).toHaveText('已从专用 Chrome 读取并核对账号。');
    assert.equal((await readFile(observations, 'utf8')).split('\n').filter(line => line === 'navigate:creator.douyin.com').length, 1);
    assert.deepEqual(ready, []);
    assert.deepEqual(browserReports, []);
    await click('creator');
    await configure({ file: media });
    await click('media');
    await expect(page.locator('#picked')).toContainText('fixture.mp4');
    await page.locator('#confirm [name=confirmed]').check();
    await page.getByRole('button', { name: '确认账号及交接' }).click();
    await expect(page.locator('#handoff')).toContainText('在官方页面亲自提交一次');
    assert.deepEqual(ready, [{ attempt_id: 'social-fixture', fencing_token: 5, write_slot_token: 6, observed_platform_identity: 'fixture-social' }]);
    await page.getByRole('button', { name: '结果未知' }).click();
    await expect(page.locator('#task')).toBeHidden();
    assert.deepEqual(browserReports, [{ kind: 'outcome_unknown', attempt_id: 'social-fixture', fencing_token: 5 }]);
    await click('disconnect');
    await expect(status()).toHaveText('已断开');
    socialStatus = { id: 'fixture-x-recent', workspace_id: 'fixture-workspace', device_id: 'fixture-device',
      mode: 'recent_posts', platform: 'x', expected_identity: 'fixturex', fencing_token: 19, lease_expires_at: new Date(Date.now() + 60_000).toISOString() };
    await click('connect');
    await waitOnline();
    await expect(page.locator('#activity-list')).toContainText('工作台已确认社媒查询回填');
    assert.deepEqual(socialReports, [{ id: 'fixture-x-recent', fencing_token: 19, result: { channels: [{
      platform: 'x', status: 'verified', identity: 'fixturex', posts: [{ id: '123', url: 'https://x.com/fixturex/status/123', text: 'Local fixture video', has_video: true }],
    }] } }]);
    assert.equal((await readFile(observations, 'utf8')).split('\n').filter(line => line === 'navigate:x.com').length, 1);
    await click('disconnect');
    await expect(status()).toHaveText('已断开');
    zhihu = { id: 'fixture-zhihu', workspace_id: 'fixture-workspace', device_id: 'fixture-device', fencing_token: 7,
      mode: 'login_check', lease_expires_at: new Date(Date.now() + 60_000).toISOString() };
    await click('connect');
    await waitOnline();
    await expect(page.locator('#activity-list')).toContainText('已报告需要在专用 Chrome 手动登录，未提交统计');
    assert.deepEqual(reports, [{ id: 'fixture-zhihu', fencing_token: 7, result: { status: 'blocked', reason: 'login_required' } }]);
    assert.equal((await readFile(observations, 'utf8')).split('\n').filter(line => line === 'zhihu').length, 1);

    catalogAvailable = true;
    await expect(page.locator('#catalog-store')).toContainText('Fixture Shop', { timeout: 20_000 });
    await configure({ file });
    await click('catalog-file');
    await expect(page.locator('#catalog-picked')).toContainText('selected.csv');
    await configure({ file: null });
    await click('catalog-file');
    await expect(page.locator('#activity-list li').first()).toContainText('已取消选择商品表');
    await expect(page.locator('#catalog-upload-form'), 'cancelled replacement must not leave older file armed').toBeHidden({ timeout: 2500 });
    assert.equal(uploads.length, 0);

    const submit = async () => {
      await page.getByLabel('官方页面显示的实际店铺 ID').fill('fixture.myshopify.com');
      await page.locator('#catalog-upload-form input[type=checkbox]').check();
      await click('catalog-upload');
    };
    await configure({ file });
    await click('catalog-file');
    await submit();
    await expect.poll(() => committed.size).toBe(1);
    await click('stop');
    await expect(status()).toContainText('已紧急停止');
    waitingUpload.destroy();
    await expect(page.locator('#catalog-retry')).toBeVisible();
    await expect(page.locator('#catalog-result')).toBeHidden();
    assert.equal(uploads.length, 1);
    await click('connect');
    await waitOnline();
    await expect(page.locator('#catalog-store')).toContainText('Fixture Shop');
    await configure({ file: replacement });
    await click('catalog-file');
    await expect(page.locator('#catalog-error')).toContainText('请选回同一份商品表');
    await expect(page.locator('#catalog-upload-form')).toBeHidden();
    await configure({ file });
    await click('catalog-file');
    await expect(page.locator('#catalog-upload-form input[type=checkbox]')).not.toBeChecked();
    await submit();
    await expect(page.locator('#catalog-import')).toContainText('fixture-import');
    assert.equal(catalogClaims, 1);
    assert.equal(uploads.length, 2);
    assert.equal(committed.size, 1);
    assert.deepEqual(uploads[1], uploads[0]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, 'lifecycle-receipt.png'), fullPage: true });

    await electron.close();
    electron = undefined;
    const beforeRestart = heartbeats;
    electron = await launch();
    page = await electron.firstWindow();
    await expect(page.locator('#device-id')).toHaveText('fixture-device');
    await expect(status()).toHaveText('已断开');
    await expect(step('storage')).toHaveText('已通过');
    await expect(step('pair')).toHaveText('已通过');
    await expect(step('signature')).toHaveText('待连接');
    await expect(step('chrome')).toHaveText('待连接');
    await expect(page.locator('#setup-channel-status-youtube')).toHaveText('未验证');
    await expect(page.locator('#catalog-result')).toBeHidden();
    assert.equal(heartbeats, beforeRestart);
    await click('connect');
    await waitOnline();
    assert.equal(pairs, 1);
    assert.equal(uploads.length, 2);
    assert.equal(reports.length, 1);
    await electron.close();
    electron = undefined;
    const encryptedPairing = await readFile(join(profile, 'pairing.enc'));
    await configure({ denyDecrypt: true });
    electron = await launch();
    page = await electron.firstWindow();
    await expect(step('storage')).toHaveText('需重试');
    await expect(step('pair')).toHaveText('待授权');
    await expect(page.locator('#pair')).toBeHidden();
    await configure({ denyDecrypt: false });
    await click('setup-check-storage');
    await expect(step('storage')).toHaveText('已通过');
    await expect(step('pair')).toHaveText('已通过');
    await expect(step('signature')).toHaveText('待连接');
    assert.deepEqual(await readFile(join(profile, 'pairing.enc')), encryptedPairing);
    assert.equal(pairs, 1);
    console.log('Lifecycle setup: storage denial, retry and saved-pairing recovery; browser authorization cancellation; signed heartbeat failure and recovery; Chrome failure, cancellation and connection; per-channel login, verification, change and expiry passed');
    console.log('Lifecycle tasks: signed loopback pairing/restart, TikTok and Amazon registration/retry/conflict/replay, Zhihu login-only, signed X self-posts, signed browser identity and human handoff, and exact catalog preview replay passed');
  } finally {
    if (electron) await electron.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
}
