import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { xPostsScript } from '../../apps/connector-desktop/src/x-posts.ts';
import { observationScript } from '../../apps/connector-desktop/src/channels.ts';
import { ChannelSessions } from '../../apps/connector-desktop/src/channel-sessions.ts';

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let markup = '';
  const requests = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    requests.push(url);
    return route.request().isNavigationRequest() && ['https://x.com/', 'https://x.com/home', 'https://x.com/fixture', 'https://x.com/i/flow/login', 'https://x.com/account/access', 'https://twitter.com/', 'https://x.com:8443/'].includes(url)
      ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">${markup}` }) : route.abort();
  });
  const page = await context.newPage();
  const self = '<header><a data-testid="AppTabBar_Profile_Link" href="/fixture">Profile</a></header>';
  const profile = body => `${self}<main><div data-testid="primaryColumn"><nav><a role="tab" aria-selected="true" href="/fixture">Posts</a></nav><section aria-labelledby="timeline"><h2 id="timeline">Timeline</h2><div aria-label="Timeline: Fixture’s posts">${body}</div></section></div></main>`;
  const post = (id, owner, text, extra = '', stampOwner = owner) => `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${owner}">@${owner}</a><a href="/${stampOwner}/status/${id}"><time datetime="2026-07-01T12:00:00Z">Jul 1</time></a></div><div data-testid="tweetText">${text}</div>${extra}</article>`;
  markup = self;
  await page.goto('https://x.com/home');
  assert.deepEqual(await page.evaluate(xPostsScript('other', true)), { kind: 'identity_mismatch' });
  assert.deepEqual(requests, ['https://x.com/home']);
  markup = profile(post('10', 'fixture', 'Own post', '<div data-testid="videoPlayer" style="width:30px;height:20px"></div>') +
    post('11', 'foreign', 'Another account', '', 'fixture') +
    post('12', 'fixture', 'Retweet', '<p data-testid="socialContext">You reposted</p>') +
    post('13', 'fixture', 'Ad', '<p data-testid="promotedIndicator">Promoted</p>') +
    post('14', 'fixture', 'Quote', '<div data-testid="quoteTweet">Someone else’s video</div>') +
    post('15', 'fixture', 'x'.repeat(550), '<div data-testid="videoPlayer" hidden>hidden media</div>'));
  const navigation = page.waitForURL('https://x.com/fixture');
  assert.deepEqual(await page.evaluate(xPostsScript('@Fixture', true)), { kind: 'navigating', identity: 'fixture' });
  await navigation;
  assert.deepEqual(await page.evaluate(xPostsScript('fixture', false)), { kind: 'posts', identity: 'fixture', posts: [
    { id: '10', url: 'https://x.com/fixture/status/10', text: 'Own post', has_video: true },
    { id: '15', url: 'https://x.com/fixture/status/15', text: 'x'.repeat(500), has_video: false },
  ] });
  markup = profile('<div role="progressbar">Loading</div>');
  await page.reload();
  assert.deepEqual(await page.evaluate(xPostsScript('fixture', false)), { kind: 'unverified' });
  markup = profile('<div data-testid="emptyState"><div data-testid="emptyStateHeader">No posts yet</div></div>');
  await page.reload();
  assert.deepEqual(await page.evaluate(xPostsScript('fixture', false)), { kind: 'posts', identity: 'fixture', posts: [] });
  markup = '<main>login required</main>';
  await page.goto('https://x.com/i/flow/login');
  assert.deepEqual(await page.evaluate(xPostsScript(undefined, true)), { kind: 'login_required' });

  const identifier = '<label for="identifier">电子邮件或用户名</label><input id="identifier" name="text" autocomplete="username">';
  const next = '<button type="submit">继续</button>';
  const providers = '<button>使用手机继续</button><button>使用 Google 继续</button><button>使用 Apple 继续</button>';
  const landing = (input = identifier, submit = next, actions = providers) =>
    `<main><h1>正发生。</h1>${actions}<form>${input}${submit}</form></main>`;
  const publicLogin = '<a href="/i/flow/login">登录</a>';
  const observe = async (url, html, recent, account) => {
    markup = html;
    await page.goto(url);
    assert.deepEqual(await page.evaluate(xPostsScript('other', true)), recent, `${url}: recent posts`);
    assert.equal((await page.evaluate(observationScript('x'))).kind, account, `${url}: account status`);
    assert.equal(page.url(), url);
  };
  const root = 'https://x.com/';
  const uncertain = { kind: 'unverified' };
  await observe(root, landing(), { kind: 'login_required' }, 'login');
  await observe(root, landing(identifier, '<button type="submit" disabled>继续</button>'), { kind: 'login_required' }, 'login');
  await observe(root, landing(identifier, '<div role="button" aria-disabled="true">继续</div>'), { kind: 'login_required' }, 'login');
  const commonLoginLinks = '<a href="/i/flow/login">使用手机号继续</a><a href="/i/flow/login">继续使用 Google</a><a href="/i/flow/login">继续使用 Apple</a>';
  const currentIdentifier = '<label for="username">邮件地址或用户名</label><input id="username" name="username" autocomplete="username">';
  await observe(root, landing(currentIdentifier, next, commonLoginLinks), { kind: 'login_required' }, 'login');
  const passkeyIdentifier = '<label>电子邮箱或用户名<input name="username_or_email" autocomplete="username webauthn" type="text"></label>';
  const passkeyChoices = '<button>使用手机继续</button><button>使用 Apple 继续</button>';
  const passkeyLanding = `<main><h1>正发生.</h1><form>${passkeyChoices}${passkeyIdentifier}</form></main>`;
  await observe(root, passkeyLanding, { kind: 'login_required' }, 'login');
  await observe(root, `${passkeyLanding}<div style="position:fixed;inset:0;pointer-events:none"><div></div></div>`, { kind: 'login_required' }, 'login');
  await observe(root, passkeyLanding.replace('<h1>正发生.</h1>', ''), uncertain, 'unknown');
  for (const html of [
    '', '<main aria-busy="true">Loading…</main>', publicLogin, landing('', '', '<button>使用 Google 继续</button>'),
    landing(identifier, '', providers), landing(identifier, next, '<button>使用 Google 继续</button>'),
    landing('<input type="search" aria-label="电子邮件或用户名">'),
    landing('<input style="opacity:0" name="text" autocomplete="username" aria-label="电子邮件或用户名">'),
    `<div style="margin-top:200vh">${landing()}</div>`,
    `${landing()}<div style="position:fixed;inset:0;background:white"></div>`,
    `${landing()}<div style="position:fixed;inset:0;background:white;pointer-events:none"></div>`,
    `${landing()}<div role="alertdialog">验证身份</div>`,
    `${landing()}<iframe title="CAPTCHA" src="https://fixture.invalid/captcha"></iframe>`,
  ]) await observe(root, html, uncertain, 'unknown');
  for (const url of ['https://x.com/home', 'https://x.com/account/access', 'https://twitter.com/', 'https://x.com:8443/']) {
    await observe(url, `${landing()}${publicLogin}`, uncertain, 'unknown');
  }
  await observe('https://twitter.com/', `${self}${landing()}`, uncertain, 'unknown');
  await observe(root, `${self}${landing()}`, { kind: 'identity_mismatch' }, 'identity');

  const claim = { mode: 'account_status', platform: 'x', expected_identity: 'other' };
  const signal = AbortSignal.timeout(5_000);
  const reads = [];
  const sessions = new ChannelSessions({
    session: 1,
    async hasTab() { return true; },
    async open() { assert.fail('The directed check should reuse the X tab'); },
    async click() { assert.fail('The directed check should only observe'); },
    async inspect(id) {
      const observation = await page.evaluate(observationScript(id));
      reads.push(observation.kind);
      if (reads.length === 1 && observation.kind === 'unknown') await page.setContent(landing());
      return observation;
    },
  });
  assert.deepEqual(await sessions.readSocialStatus(claim, signal), { channels: [{ platform: 'x', status: 'identity_mismatch' }] });
  reads.length = 0;
  await page.setContent('<main aria-busy="true">Loading…</main>');
  assert.deepEqual(await sessions.readSocialStatus(claim, signal), { channels: [{ platform: 'x', status: 'login_required' }] });
  assert.deepEqual(reads, ['unknown', 'login']);
  console.log('Chrome offline X fixture passed proof, owner filtering, video evidence, clipping, root login, and readiness checks');
} finally { await browser.close(); }
