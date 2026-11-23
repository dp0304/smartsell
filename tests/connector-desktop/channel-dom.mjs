import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { observationScript } from '../../apps/connector-desktop/src/channels.ts';
import { zhihuObservationScript, zhihuOrigin } from '../../apps/connector-desktop/src/zhihu-dom.ts';

// Real visible Google Chrome running entirely synthetic page fixtures. All network is intercepted.
const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let html;
  await context.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">${html}` })
    : route.abort());
  const tab = await context.newPage();
  const fixtures = [
    ['douyin', 'https://creator.douyin.com/', '<header><div class="user-info">抖音号：fixture88</div></header>', 'fixture88'],
    ['xhs', 'https://creator.xiaohongshu.com/', '<header><div class="user-info">小红书号：fixture18</div></header>', 'fixture18'],
    ['tiktok', 'https://www.tiktok.com/setting', '<main><p>TikTok User ID: 1234567890123456789</p></main>', '1234567890123456789'],
    ['youtube', 'https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv', '<div id="left-nav"><a href="/channel/UCabcdefghijklmnopqrstuv/videos">Content</a></div><ytcp-navigation-drawer><a href="/channel/UCabcdefghijklmnopqrstuv/analytics">Analytics</a></ytcp-navigation-drawer>', 'UCabcdefghijklmnopqrstuv'],
    ['facebook', 'https://www.facebook.com/', '<div role="dialog"><a href="/profile.php?id=12345">See your profile</a></div>', '12345'],
    ['x', 'https://x.com/home', '<a href="/fixture_x" data-testid="AppTabBar_Profile_Link">Profile</a>', 'fixture_x'],
    ['instagram', 'https://www.instagram.com/', '<nav><a href="/fixture_ig/">Profile</a></nav>', 'fixture_ig'],
    ['reddit', 'https://www.reddit.com/', '<div id="user-drawer-content"><a href="/user/fixture_reddit/">View Profile</a></div>', 'fixture_reddit'],
    ['shopify', 'https://admin.shopify.com/store/fixture-store', '<nav><a href="/store/fixture-store/products">Products</a><a href="/store/fixture-store/settings">Settings</a></nav>', 'fixture-store'],
    ['amazon_sp', 'https://sellercentral.amazon.com/sw/AccountInfo/', '<main><p>Seller ID: FIXTUREAMAZON</p></main>', 'FIXTUREAMAZON'],
    ['shopee', 'https://seller.shopee.tw/portal/settings/shop', '<main><p>賣場編號：87654321</p></main>', '87654321'],
  ];
  for (const [id, url, markup, identity] of fixtures) {
    html = markup;
    await tab.goto(url);
    assert.deepEqual(await tab.evaluate(observationScript(id)), { kind: 'identity', identity }, id);
  }
  html = '<main><button>Log in</button></main>';
  await tab.goto('https://www.tiktok.com/login');
  assert.deepEqual(await tab.evaluate(observationScript('tiktok')), { kind: 'login' });
  await tab.goto('https://sellercentral.amazon.com/ap/signin');
  assert.deepEqual(await tab.evaluate(observationScript('amazon_sp')), { kind: 'login' });
  html = '<main><a href="/@public_profile">Public Creator</a><p>User ID: 1234567890123456789</p></main>';
  await tab.goto('https://www.tiktok.com/@public_profile');
  assert.deepEqual(await tab.evaluate(observationScript('tiktok')), { kind: 'unknown' });
  html = '<main><p>Account settings</p><div style="opacity:0"><p>Seller ID: HIDDENAMAZON</p></div></main>';
  await tab.goto('https://sellercentral.amazon.com/sw/AccountInfo/');
  assert.deepEqual(await tab.evaluate(observationScript('amazon_sp')), { kind: 'unknown' }, 'an invisible seller ID inside visible settings is not proof');
  html = '<main><p>Seller ID: FIXTUREAMAZON</p></main>';
  await tab.goto('https://sellercentral.amazon.com/products');
  assert.deepEqual(await tab.evaluate(observationScript('amazon_sp')), { kind: 'unknown' });
  html = '<main><a href="/fixture_ig/"><img alt="fixture_ig profile picture" width="12" height="12"></a></main>';
  await tab.goto('https://www.instagram.com/fixture_ig/');
  assert.deepEqual(await tab.evaluate(observationScript('instagram')), { kind: 'unknown' });
  html = '<nav><a href="/first/">Profile</a><a href="/hidden/" style="opacity:0">Profile</a></nav>';
  await tab.goto('https://www.instagram.com/');
  assert.deepEqual(await tab.evaluate(observationScript('instagram')), { kind: 'identity', identity: 'first' });
  html = '<nav><a href="/first/">Profile</a><a href="/second/">Profile</a></nav>';
  await tab.goto('https://www.instagram.com/');
  assert.deepEqual(await tab.evaluate(observationScript('instagram')), { kind: 'unknown', invalidated: true });
  html = '<form><input type="password" aria-label="fixture password"></form>';
  await tab.goto('https://accounts.google.com/v3/signin');
  assert.deepEqual(await tab.evaluate(observationScript('youtube')), { kind: 'login' });
  html = '<button id="expand-user-drawer-button" aria-expanded="false" onclick="this.setAttribute(\'aria-expanded\', \'true\'); document.querySelector(\'[role=menu]\').hidden = false">账户菜单</button><nav role="menu" hidden><a href="/user/after_click/">View Profile</a></nav>';
  await tab.goto('https://www.reddit.com/');
  const before = await tab.evaluate(observationScript('reddit'));
  assert.equal(before.kind, 'unknown');
  assert(before.control);
  await tab.mouse.click(before.control.x, before.control.y);
  await tab.getByRole('link', { name: 'View Profile' }).waitFor();
  assert.deepEqual(await tab.evaluate(observationScript('reddit')), { kind: 'identity', identity: 'after_click' });
  console.log(`Visible Google Chrome: ${fixtures.length} synthetic DOM identity adapters, login, public profile rejection, ambiguity, and account-menu click passed`);

  const zhihu = (slug, loginCheck = false) => tab.evaluate(zhihuObservationScript(slug, false, loginCheck));
  html = '<form class="SignFlow"><input name="phoneNo"><button class="SignFlow-submitButton">登录</button></form>';
  await tab.goto(`${zhihuOrigin}/signin`);
  assert.deepEqual(await zhihu(undefined, true), { kind: 'login-required' });
  html += '<div class="Captcha">Fixture challenge</div>';
  await tab.reload();
  assert.deepEqual(await zhihu(undefined, true), { kind: 'challenge' });
  const profile = '<div class="Profile-sideColumn"><a class="NumberBoard-item" href="/people/fixture/followers"><span class="NumberBoard-itemName">粉丝</span> <span class="NumberBoard-itemValue">1.2 万</span></a><p class="IconGraf">获得 3,456 次赞同</p></div>';
  html = `<header><div class="AppHeader-profile"><a href="/people/fixture">我的主页</a></div></header>${profile}`;
  await tab.goto(`${zhihuOrigin}/people/fixture`);
  assert.deepEqual(await zhihu('fixture', true), { kind: 'signed-in' }, 'login check returns no slug or counts');
  assert.deepEqual(await zhihu('another'), { kind: 'mismatch' }, 'never report another visible profile');
  assert.deepEqual(await zhihu('fixture'), { kind: 'stats', followers: '1.2 万', upvotes: '获得 3,456 次赞同' });
  html = `${profile}<aside class="Profile-sideColumn"><p class="IconGraf">获得 5 次赞同</p></aside>`;
  await tab.reload();
  assert.deepEqual(await zhihu('fixture'), { kind: 'ambiguous' }, 'different visible counts are not a result');
  console.log('Visible Google Chrome: synthetic Zhihu sign-in, challenge, login-only, wrong profile, exact metrics and ambiguous counts passed');
} finally { await browser.close(); }
