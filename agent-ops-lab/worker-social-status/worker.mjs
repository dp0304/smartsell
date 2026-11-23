import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { DesktopConnector } from '../../apps/connector-desktop/src/controller.ts';
import { ChannelSessions } from '../../apps/connector-desktop/src/channel-sessions.ts';

const desktop = new URL('../../apps/connector-desktop/', import.meta.url);
async function domScripts() {
  // Match the product's esbuild treatment of functions serialized with toString().
  const { build } = createRequire(new URL('package.json', desktop))('esbuild');
  const bundle = await build({ absWorkingDir: fileURLToPath(desktop), bundle: true, format: 'esm', platform: 'node', target: 'node24', write: false, stdin: {
    contents: `export { observationScript } from './src/channels.ts'; export { xPostsScript } from './src/x-posts.ts';`,
    resolveDir: fileURLToPath(desktop),
  } });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}
import { createSignedHttpTransport, SignedDeviceClient } from '../../apps/connector/src/device-client.ts';

const requestName = 'worker_social_status_request';
const getName = 'worker_social_status_get';
const reportName = 'worker_social_status_report';
const identity = 'fixture_angler';
const article = (handle, id, text, video = false) => `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${handle}">${handle}</a> <a href="/${handle}/status/${id}"><time datetime="2026-01-01T01:00:00Z">Jan 1</time></a></div><div data-testid="tweetText">${text}</div>${video ? '<div data-testid="videoPlayer" style="width:120px;height:30px">Fixture clip</div>' : ''}</article>`;
const header = `<header><a href="/${identity}" data-testid="AppTabBar_Profile_Link">Profile</a></header>`;
const profilePage = `${header}<main><div data-testid="primaryColumn"><a role="tab" aria-selected="true" href="/${identity}">Posts</a><section aria-labelledby="posts"><h2 id="posts">Posts</h2><div aria-label="Timeline: Fixture posts">${article(identity, '1001', 'fixture_video', true)}${article(identity, '1002', 'fixture_plain')}${article('fixture_other', '1003', 'fixture_excluded', true)}</div></section></div></main>`;

async function offlineBrowser() {
  const { observationScript, xPostsScript } = await domScripts();
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--proxy-server=http://127.0.0.1:1', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let signedIn = true;
    let page;
    const traffic = { navigations: 0, fulfilled: 0, blocked: 0, observations: [] };
    async function navigate(url) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8_000 }); }
      catch (error) { traffic.observations.push(error.message.match(/net::ERR_[A-Z_]+/)?.[0] ?? 'navigation_failed'); throw error; }
    }
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (route.request().isNavigationRequest()) traffic.navigations++;
      if (url.origin !== 'https://x.com' || !route.request().isNavigationRequest()) {
        traffic.blocked++;
        return route.abort();
      }
      traffic.fulfilled++;
      const markup = url.pathname === '/home' ? header : url.pathname === `/${identity}` ? profilePage : '<main><button>Log in</button></main>';
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">${markup}` });
    });
    return {
      traffic, close: () => browser.close(),
      async signOut() { signedIn = false; await page?.close(); page = undefined; },
      get session() { return 1; },
      async open(id, url, signal) {
        signal.throwIfAborted();
        assert.equal(id, 'x');
        assert.equal(url, 'https://x.com/home');
        page ??= await context.newPage();
        await navigate(signedIn ? url : 'https://x.com/i/flow/login');
      },
      async hasTab(id) { return id === 'x' && Boolean(page); },
      async focus() {},
      async click() { throw new Error('Offline fixture has no action controls'); },
      async inspect(id, signal) { signal.throwIfAborted(); return page.evaluate(observationScript(id)); },
      async readRecentX(expected, signal) {
        signal.throwIfAborted();
        try {
          const current = await page.evaluate(xPostsScript(expected, false));
          traffic.observations.push(current.kind);
          if (current.kind !== 'profile') return current;
          // Virtual navigation uses the product parser's own visible self-handle.
          await navigate(`https://x.com/${current.identity}`);
          signal.throwIfAborted();
          const posts = await page.evaluate(xPostsScript(expected, false));
          traffic.observations.push(posts.kind);
          return posts;
        } catch (error) {
          traffic.observations.push(error.message.match(/(?:ReferenceError|TypeError): [\w ]{1,60}/)?.[0] ?? 'evaluation_failed');
          throw error;
        }
      },
    };
  } catch (error) { await browser.close(); throw error; }
}

function mcpData(reply) {
  const result = reply.body?.result;
  return result?.structuredContent ?? (result?.content?.[0]?.type === 'text' ? JSON.parse(result.content[0].text) : reply.body?.error);
}
const value = result => result?.data ?? result;

export async function runFixture({ base, workspace, workspaceOp, rpc, record, redact, protocol, native, webConfirm }) {
  const call = (name, args = {}, token) => rpc('tools/call', { name, arguments: args }, token);
  const startTask = async (body = {}) => value(mcpData(await call(requestName, { body, idempotency_key: randomUUID() })));
  const get = async id => value(mcpData(await call(getName, { params: { id } })));
  const noDevice = await startTask();
  record('no_worker', redact(noDevice));
  assert.equal(noDevice.error?.code, 'SOCIAL_STATUS_WORKER_UNPAIRED', 'Missing Worker blocker');

  const readOnly = await workspaceOp('/tokens', { method: 'POST', body: { access: 'read' } });
  assert.equal(readOnly.status, 201);
  const reader = readOnly.body.data.token;
  const readList = await rpc('tools/list', {}, reader);
  assert(readList.body?.result?.tools.some(tool => tool.name === getName), 'read-only credential GET');
  assert(!readList.body?.result?.tools.some(tool => tool.name === requestName), 'read-only credential request unavailable');
  const forbidden = await call(requestName, { body: {}, idempotency_key: randomUUID() }, reader);
  record('read_only_permission', { http: forbidden.status, outcome: redact(mcpData(forbidden)), request_listed: false });
  assert.equal(mcpData(forbidden)?.error?.code, 'TOOL_UNAVAILABLE', 'read-only credential rejected');

  let paired, browser, connector, timer, lastHeartbeat;
  const fetcher = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, base);
    assert(url.pathname.startsWith('/api/v1/device/'));
    const response = await fetch(input, { ...init, redirect: 'error' });
    const signedRoute = url.pathname.split('/').at(-1);
    if (['heartbeat', 'claim', 'report'].includes(signedRoute) && (url.pathname.includes('social-status') || signedRoute === 'heartbeat')) {
      const raw = await response.clone().json();
      const data = value(raw);
      if (signedRoute !== 'claim' || data?.claim !== null) {
        const request = redact(JSON.parse(Buffer.from(init.body).toString()));
        const headers = new Headers(init.headers);
        const signed = ['x-smartsell-device', 'x-smartsell-signature', 'x-smartsell-nonce', 'x-smartsell-timestamp'].every(field => headers.has(field));
        assert(signed, 'Worker request lacks signature headers');
        const row = { route: url.pathname, action: signedRoute === 'heartbeat' ? 'heartbeat' : `social.status.${signedRoute}`, http: response.status, signed,
          request_id: redact(response.headers.get('x-request-id')), device_id: redact(headers.get('x-smartsell-device')), request, response: redact(data) };
        if (signedRoute === 'heartbeat') {
          const key = JSON.stringify([row.http, row.device_id, row.request, row.response]);
          if (key === lastHeartbeat) return response;
          lastHeartbeat = key;
        }
        protocol.push(row);
      }
    }
    return response;
  };
  const close = async () => { clearInterval(timer); connector?.stop(); await browser?.close(); };
  try {
    browser = await offlineBrowser();
    const channels = new ChannelSessions(browser);
    connector = new DesktopConnector({ origin: base, version: '99.0.0-fixture', platform: 'darwin', channels,
      vault: { available: () => true, load: () => paired, save: data => { paired = data; } },
      openPlatform: async () => { throw new Error('Unexpected interactive platform opening'); }, pickMedia: async () => undefined, fetcher });
    const code = await workspaceOp('/devices/pairing-codes', { method: 'POST', body: { owned_device_confirmed: true, allow_channel_registration: true } });
    assert.ok([200, 201].includes(code.status), 'Device pairing code');
    await connector.pair({ workspace, code: code.body.data.pairing_code, name: 'Offline Chrome Fixture', ownsDevice: true });
    const signed = new SignedDeviceClient(workspace, paired.device, paired.key, createSignedHttpTransport(base, fetcher));
    await signed.heartbeat('1.0.0');
    const old = await startTask();
    record('legacy_worker', redact(old));
    assert.equal(old.error?.code, 'SOCIAL_STATUS_WORKER_UNSUPPORTED', 'Old Worker blocker');
    await connector.connect();
    timer = setInterval(() => void connector.tick(), 350);
    timer.unref();
    const confirm = async (id, mode, minimum, { status, channelStatus, task }) => {
      const readback = await workspaceOp(`/worker-social-status/${id}`);
      assert.equal(readback.status, 200, 'Web task readback');
      const web = value(readback.body);
      if (task) assert.deepEqual(web, task, 'Web/MCP task parity');
      assert.equal(web.id, id);
      assert.equal(web.device_id, paired.device);
      assert.equal(web.mode, mode);
      assert.equal(web.status, status);
      assert(Date.parse(web.reported_at) >= minimum, 'Report must be newer than the start of this case');
      const x = web.result.channels.find(channel => channel.platform === 'x');
      assert.equal(x.status, channelStatus);
      if (channelStatus === 'verified') assert.equal(x.identity, identity);
      if (channelStatus === 'verified' && mode === 'recent_posts') {
        assert.deepEqual(x.posts.map(post => [post.id, post.text, post.has_video]), [['1001', 'fixture_video', true], ['1002', 'fixture_plain', false]]);
      } else assert.equal(x.posts, undefined);
      const idAlias = redact(id);
      const claim = protocol.find(row => row.action === 'social.status.claim' && row.response?.claim?.id === idAlias);
      const report = protocol.find(row => row.action === 'social.status.report' && row.request?.id === idAlias && row.http === 200);
      assert(claim?.signed && report?.signed, 'Signed claim/report for same task');
      assert.equal(claim.device_id, report.device_id);
      const auditResponse = await workspaceOp('/mcp-tool-calls?limit=100');
      assert.equal(auditResponse.status, 200, 'Web audit readback');
      const audit = value(auditResponse.body).filter(row => row.task_id === id && [requestName, getName, reportName].includes(row.tool));
      for (const name of [requestName, getName, reportName]) assert(audit.some(row => row.tool === name), `Audit missing ${name}`);
      assert(audit.some(row => row.tool === reportName && redact(row.request_id) === report.request_id), 'Signed report request ID must match Web audit');
      for (const name of [requestName, getName]) {
        const rpcRow = protocol.find(row => row.tool === name && value(row.result)?.id === idAlias && (name === requestName || ['completed', 'blocked'].includes(value(row.result)?.status)));
        assert(rpcRow && audit.some(row => row.tool === name && redact(row.request_id) === rpcRow.request_id), 'MCP request ID must match Web audit');
      }
      const reportAudit = audit.find(row => row.tool === reportName && redact(row.request_id) === report.request_id);
      record('web_terminal', { task: redact(web), web_request_id: redact(readback.headers.get('x-request-id')), claim_request_id: claim.request_id,
        report_request_id: report.request_id, audit: redact(audit.map(({ tool, outcome, request_id, task_id, device_id, occurred_at }) => ({ tool, outcome, request_id, task_id, device_id, occurred_at }))) });
      await webConfirm(web, reportAudit.request_id);
      record('web_ui_receipt', { task_id: idAlias, device_id: report.device_id, report_request_id: report.request_id, status: web.status });
      return web;
    };
    const runCase = async (label, body, terminal, channelStatus) => {
      record('fixture_case_start', { label });
      const minimum = Date.now();
      const queued = await startTask(body);
      assert.equal(queued.status, 'queued', 'Fresh request must queue');
      assert.equal(queued.result, undefined, 'Queued task must have no cached result');
      assert.equal(queued.device_id, paired.device, 'Automatically resolved Worker');
      let task;
      for (let i = 0; i < 20; i++) {
        task = await get(queued.id);
        if (['blocked', 'completed'].includes(task.status)) break;
        await delay(250);
      }
      await confirm(queued.id, queued.mode, minimum, { status: terminal, channelStatus, task });
      return queued.id;
    };
    if (!native) {
      const recent = await runCase('recent_posts', { mode: 'recent_posts', platform: 'x' }, 'completed', 'verified');
      const general = await runCase('default_account_status', {}, 'blocked', 'verified');
      await browser.signOut();
      const login = await runCase('signed_out', { platform: 'x' }, 'blocked', 'login_required');
      assert.equal(new Set([recent, general, login]).size, 3, 'Independent fresh tasks');
      record('offline_chrome', browser.traffic);
      await close();
      return;
    }
    return { close, async verify(evidence) {
      const taskIds = new Set();
      for (const [i, mode] of ['recent_posts', 'account_status'].entries()) {
        const check = evidence.checks.filter(row => row.name === 'native_prompt')[i];
        assert(check?.exit === 0 && check.completed, `Native prompt ${i + 1} did not complete`);
        assert(check.canary.lists > 0 && !check.canary.calls.length && !check.direct, `Native prompt ${i + 1} used a direct tool or missed canary discovery`);
        const calls = protocol.slice(check.protocol_start, check.protocol_end);
        assert(calls.every(row => row.method !== 'tools/call' || [requestName, getName].includes(row.tool)), 'Native invoked non-social or fallback tools');
        const requested = calls.find(row => row.tool === requestName && value(row.result)?.status === 'queued');
        assert(requested, `Native prompt ${i + 1} did not create a fresh task`);
        const queued = value(requested.result);
        assert(!taskIds.has(queued.id), 'Each native prompt must create its own task');
        taskIds.add(queued.id);
        assert.equal(queued.result, undefined);
        assert.equal(queued.mode, mode);
        assert.equal(requested.args.body?.device_id, undefined);
        if (i === 0) assert.equal(queued.platform, 'x');
        const fetched = calls.find(row => row.tool === getName && value(row.result)?.id === queued.id && ['completed', 'blocked'].includes(value(row.result)?.status));
        assert(fetched, `Native prompt ${i + 1} did not GET the terminal state`);
        const report = protocol.find(row => row.action === 'social.status.report' && row.request?.id === queued.id && row.http === 200);
        assert(report, 'Missing real Worker report');
        assert.equal(report.device_id, queued.device_id);
        const terminal = value(fetched.result);
        const original = await workspaceOp('/mcp-tool-calls?limit=100');
        const id = value(original.body).find(row => row.task_id && redact(row.task_id) === queued.id)?.task_id;
        assert(id, 'Native task absent from Web audit');
        const web = await confirm(id, mode, Date.parse(evidence.started_at), { status: terminal.status, channelStatus: 'verified' });
        assert.deepEqual(redact(web), terminal, 'Native GET and Web must show the same task result');
      }
      record('offline_chrome', browser.traffic);
    } };
  } catch (error) { if (browser) record('offline_chrome', browser.traffic); await close(); throw error; }
}
