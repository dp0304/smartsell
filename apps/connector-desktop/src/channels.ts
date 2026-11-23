import { inspectXLogin } from './x-login.ts';

type LinkRule = { selector: string; path: string; hosts?: string[]; label?: string; preferred?: boolean };
type FieldRule = { selector: string; pattern: string; path?: string; preferred?: boolean };
type RouteRule = { path: string; selectors: string[]; pathPrefix?: string };
type ChannelRule = {
  hosts: string[];
  loginHosts?: string[];
  loginHostPath?: string;
  loginPath?: string;
  links?: LinkRule[];
  fields?: FieldRule[];
  ownedRoute?: RouteRule;
  menu?: string;
};

type Channel = { name: string; group: 'social' | 'commerce'; mark: string; page: string; help: string; rule: ChannelRule };
const sellerAmazon = ['sellercentral.amazon.com', 'sellercentral.amazon.ca', 'sellercentral.amazon.com.mx', 'sellercentral.amazon.com.br', 'sellercentral.amazon.co.uk', 'sellercentral.amazon.de', 'sellercentral.amazon.fr', 'sellercentral.amazon.it', 'sellercentral.amazon.es', 'sellercentral.amazon.co.jp', 'sellercentral.amazon.com.au', 'sellercentral.amazon.in'];
const sellerShopee = ['seller.shopee.tw', 'seller.shopee.sg', 'seller.shopee.com.my', 'seller.shopee.co.th', 'seller.shopee.vn', 'seller.shopee.ph', 'seller.shopee.co.id', 'seller.shopee.com.br'];
const accountArea = 'header [class*="user"], [role="banner"] [class*="user"], [role="menu"], [class*="userInfo"], [class*="user-info"]';
const storeField = { selector: 'main, [role="main"], form, [class*="shop-profile"], [class*="account-info"]', pattern: '(?:^|\\n)\\s*(?:Shop ID|Store ID|Seller ID|Merchant Token|店铺 ID|店舖 ID|賣場編號|卖场编号|店铺编号|店舖編號)\\s*[:：]?\\s*([A-Za-z0-9][A-Za-z0-9_.:-]{1,127})(?=\\s*(?:\\n|$))' };

export const channels = {
  douyin: {
    name: '抖音', group: 'social', mark: '♪', page: 'https://creator.douyin.com/', help: '创作者中心 · 打开右上角账号菜单，查看抖音号。',
    rule: { hosts: ['creator.douyin.com'], loginHosts: ['sso.douyin.com'], loginPath: '^/(?:login|passport)(?:/|$)',
      fields: [{ selector: accountArea, pattern: '(?:抖音号|抖音號)\\s*[:：]\\s*([A-Za-z0-9_.-]{2,64})(?=\\s|$)' }],
      menu: 'header [aria-label="账号菜单"], header [aria-label="个人中心"]' },
  },
  xhs: {
    name: '小红书', group: 'social', mark: '小红书', page: 'https://creator.xiaohongshu.com/', help: '创作服务平台 · 打开账号菜单，查看小红书号或个人主页入口。',
    rule: { hosts: ['creator.xiaohongshu.com'], loginPath: '^/(?:login|new/login)(?:/|$)',
      fields: [{ selector: accountArea, pattern: '(?:小红书号|小紅書號)\\s*[:：]\\s*([A-Za-z0-9_.-]{2,64})(?=\\s|$)' }],
      links: [{ selector: 'header a, [role="menu"] a, [class*="user-info"] a', hosts: ['www.xiaohongshu.com', 'creator.xiaohongshu.com'], path: '^/user/profile/([0-9a-f]{12,32})/?$', preferred: true, label: '^(?:个人主页|個人主頁|我的主页|我的主頁|查看主页|查看主頁)$' }] },
  },
  tiktok: {
    name: 'TikTok', group: 'social', mark: '♪', page: 'https://www.tiktok.com/setting', help: 'TikTok 国际版 · 在设置或 Studio 账号信息中显示数字用户 ID。',
    rule: { hosts: ['www.tiktok.com', 'tiktok.com', 'studio.tiktok.com'], loginPath: '^/(?:login|signup|passport|verify)(?:/|$)',
      fields: [{ selector: 'main, [role="main"], [data-e2e="account-information"]',
        path: '^/(?:(?:setting|settings|account)|tiktokstudio/(?:account|settings))(?:/account-information)?/?$',
        pattern: '(?:^|\\n)\\s*(?:TikTok User ID|User ID|Account ID|用户 ID|用戶 ID|帳號 ID)\\s*[:：]?\\s*([0-9]{8,25})(?=\\s*(?:\\n|$))' }] },
  },
  youtube: {
    name: 'YouTube', group: 'social', mark: '▶', page: 'https://studio.youtube.com/', help: 'YouTube Studio · 打开自己的频道后台。',
    rule: { hosts: ['studio.youtube.com'], loginHosts: ['accounts.google.com', 'consent.youtube.com'], loginPath: '^/signin(?:/|$)',
      ownedRoute: { path: '^/channel/(UC[A-Za-z0-9_-]{22})(?:/|$)', selectors: ['ytcp-navigation-drawer a[href]', '#left-nav a[href]'], pathPrefix: '/channel/' } },
  },
  facebook: {
    name: 'Facebook', group: 'social', mark: 'f', page: 'https://www.facebook.com/', help: '打开右上角账户菜单，显示「查看个人主页」。',
    rule: { hosts: ['www.facebook.com', 'facebook.com'], loginPath: '^/(?:login(?:\\.php)?|checkpoint|two_step_verification)(?:/|$)',
      links: [{ selector: '[role="dialog"] a, [role="menu"] a, header a, [role="banner"] a', path: '^/((?![0-9]+/?$)[A-Za-z0-9.]{3,80})/?$',
        label: '^(?:See your profile|View your profile|Your profile|查看个人主页|查看個人檔案|查看你的个人主页|你的個人檔案)$' },
      { selector: '[role="dialog"] a, [role="menu"] a, [role="banner"] a', path: '^/profile\\.php\\?id=([0-9]+)(?:&|$)',
        label: '^(?:See your profile|View your profile|Your profile|查看个人主页|查看個人檔案|查看你的个人主页|你的個人檔案)$' }],
      menu: '[role="banner"] [aria-label="Your profile"], [role="banner"] [aria-label="账户"], [role="banner"] [aria-label="帳號"]' },
  },
  x: {
    name: 'X', group: 'social', mark: '𝕏', page: 'https://x.com/home', help: '首页侧栏 · 登录后显示自己的个人资料入口。',
    rule: { hosts: ['x.com'],
      links: [{ selector: 'header a[data-testid="AppTabBar_Profile_Link"], [role="banner"] a[data-testid="AppTabBar_Profile_Link"]', path: '^/([A-Za-z0-9_]{1,15})/?$' }] },
  },
  instagram: {
    name: 'Instagram', group: 'social', mark: '◎', page: 'https://www.instagram.com/', help: '侧栏 · 登录后显示自己的个人主页入口。',
    rule: { hosts: ['www.instagram.com', 'instagram.com'], loginPath: '^/(?:accounts/login|challenge|accounts/two_factor)(?:/|$)',
      links: [{ selector: 'nav a, [role="navigation"] a, a[aria-label="Profile"], a[aria-label="个人主页"]',
        path: '^/((?![0-9]+/?$)[A-Za-z0-9_.]{1,30})/?$', label: '^(?:Profile|个人主页|個人檔案|个人资料|個人資料|[A-Za-z0-9_.]+(?:’|\')s profile picture|[A-Za-z0-9_.]+的头像)$' }],
      fields: [{ selector: 'main, [role="main"]', path: '^/accounts/(?:edit|account_information)(?:/|$)', preferred: true,
        pattern: '(?:^|\\n)\\s*(?:Instagram User ID|Account ID|用户 ID|用戶 ID|帳號 ID)\\s*[:：]?\\s*([0-9]{1,32})(?=\\s*(?:\\n|$))' }] },
  },
  reddit: {
    name: 'Reddit', group: 'social', mark: 'r/', page: 'https://www.reddit.com/', help: '打开右上角账号菜单，显示「View Profile」。',
    rule: { hosts: ['www.reddit.com', 'reddit.com'], loginPath: '^/(?:login|register|account/login)(?:/|$)',
      links: [{ selector: '#user-drawer-content a, [role="menu"] a, header a', path: '^/user/([A-Za-z0-9_-]{3,32})/?$',
        label: '^(?:View Profile|My Profile|Profile|查看个人资料|查看個人資料)(?:\\b|\\s|$)' }],
      menu: '#expand-user-drawer-button[aria-expanded="false"], button[data-testid="user-menu-button"][aria-expanded="false"]' },
  },
  shopify: {
    name: 'Shopify', group: 'commerce', mark: 'S', page: 'https://admin.shopify.com/', help: 'Shopify Admin · 进入要验证的店铺后台。',
    rule: { hosts: ['admin.shopify.com'], loginHosts: ['accounts.shopify.com', 'login.shopify.com'], loginPath: '^/(?:login|auth/login|store-login)(?:/|$)',
      ownedRoute: { path: '^/store/([a-z0-9][a-z0-9-]*)(?:/|$)', selectors: ['a[href*="/products"]', 'a[href*="/settings"]'], pathPrefix: '/store/' } },
  },
  amazon_sp: {
    name: 'Amazon', group: 'commerce', mark: 'a', page: 'https://sellercentral.amazon.com/', help: 'Seller Central · 进入账户信息，显示可见的 Seller ID。',
    rule: { hosts: sellerAmazon, loginHosts: sellerAmazon.map(host => host.replace('sellercentral.', 'www.')),
      loginHostPath: '^/ap/(?:signin|mfa|cvf)(?:/|$)', loginPath: '^/(?:ap/(?:signin|mfa|cvf)|signin|login)(?:/|$)',
      fields: [{ selector: storeField.selector, path: '^/(?:sw/AccountInfo|settings/account|gp/seller)(?:/|$)',
        pattern: '(?:^|\\n)\\s*(?:Seller ID|Merchant Token|卖家 ID|賣家 ID)\\s*[:：]?\\s*([A-Z0-9]{8,32})(?=\\s*(?:\\n|$))' }] },
  },
  shopee: {
    name: 'Shopee（虾皮）', group: 'commerce', mark: '虾', page: 'https://seller.shopee.tw/', help: '卖家中心 · 选择地区，在店铺资料页显示店铺 ID。',
    rule: { hosts: sellerShopee, loginPath: '^/(?:account/signin|account/login|portal/login|login|signin)(?:/|$)',
      fields: [{ ...storeField, path: '^/portal/(?:settings/shop|shop/profile|shop/settings)(?:/|$)' }] },
  },
} as const satisfies Record<string, Channel>;

export type ChannelId = keyof typeof channels;
const ids = Object.keys(channels) as ChannelId[];
const registrationRules: Partial<Record<ChannelId, { platform: string; identity?: RegExp }>> = {
  douyin: { platform: 'douyin' }, xhs: { platform: 'xiaohongshu', identity: /^[0-9a-f]{24}$/ },
  tiktok: { platform: 'tiktok', identity: /^[0-9]{8,25}$/ }, youtube: { platform: 'youtube', identity: /^UC[A-Za-z0-9_-]{22}$/ },
  instagram: { platform: 'meta_instagram', identity: /^[0-9]{1,32}$/ },
  facebook: { platform: 'meta_facebook', identity: /^[0-9]{1,32}$/ },
  shopify: { platform: 'shopify' }, amazon_sp: { platform: 'amazon_sp', identity: /^[A-Z0-9]{8,32}$/ }, shopee: { platform: 'shopee' },
};
export function registrationPlatform(id: ChannelId, identity: string) {
  const rule = registrationRules[id];
  if (rule && (!rule.identity || rule.identity.test(identity))) return rule.platform;
}
export const channelRows = ids.map(id => {
  const { name, group, mark, help } = channels[id];
  return { id, name, group, mark, help, supportsRegistration: Boolean(registrationRules[id]) };
});
export function channelId(value: unknown): ChannelId {
  if (typeof value !== 'string' || !Object.hasOwn(channels, value)) throw new Error('不支持此 Chrome 渠道。');
  return value as ChannelId;
}

export type Observation = { kind: 'identity'; identity: string } | { kind: 'login' } | { kind: 'unknown'; invalidated?: boolean; control?: { x: number; y: number } };

// Runs in an isolated world in the visible Chrome tab. Read only visible self-account controls.
function inspectPage(rule: ChannelRule, inspectLogin?: typeof inspectXLogin): Observation {
  const here = new URL(location.href);
  if (here.protocol !== 'https:') return { kind: 'unknown', invalidated: true };
  const loginState = inspectLogin?.();
  if (loginState === 'blocked') return { kind: 'unknown', invalidated: true };
  if (loginState === 'login') return { kind: 'login' };
  const loginPath = rule.loginPath && new RegExp(rule.loginPath, 'i').test(here.pathname);
  if (rule.loginHosts?.includes(here.hostname) && (!rule.loginHostPath || new RegExp(rule.loginHostPath, 'i').test(here.pathname))) return { kind: 'login' };
  if (!rule.hosts.includes(here.hostname)) return { kind: 'unknown', invalidated: true };
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const all = (selector: string) => {
    const nodes: Element[] = [];
    const roots: (Document | ShadowRoot)[] = [document];
    for (let index = 0; index < roots.length && index < 100; index++) {
      const root = roots[index];
      root.querySelectorAll(selector).forEach(element => nodes.push(element));
      root.querySelectorAll('*').forEach(element => { if (element.shadowRoot) roots.push(element.shadowRoot); });
    }
    return nodes.filter(visible);
  };
  if (!inspectLogin && (loginPath || all('input[type="password"]').length)) return { kind: 'login' };
  // A claimed identity must be unambiguous. Never use a public profile's URL or page title.
  const identities = new Set<string>();
  const preferred = new Set<string>();
  for (const link of rule.links || []) {
    for (const element of all(link.selector)) {
      if (!(element instanceof HTMLAnchorElement)) continue;
      const url = new URL(element.href, here);
      const label = [element.getAttribute('aria-label'), element.innerText, element.querySelector('img')?.alt].filter(Boolean);
      if (url.protocol !== 'https:' || !(link.hosts ?? rule.hosts).includes(url.hostname) || url.username || url.password ||
        (link.label && !label.some(value => new RegExp(link.label!, 'i').test(value!.trim())))) continue;
      const id = new RegExp(link.path).exec(url.pathname + url.search)?.[1];
      if (id && !/^(?:profile|login|settings|privacy|help|home|explore|accounts)$/i.test(id)) (link.preferred ? preferred : identities).add(id);
    }
  }
  for (const field of rule.fields || []) {
    if (field.path && !new RegExp(field.path, 'i').test(here.pathname)) continue;
    for (const element of all(field.selector)) {
      if (!(element instanceof HTMLElement) || element.innerText.length > 12_000) continue;
      const matches = [...element.innerText.matchAll(new RegExp(field.pattern, 'gi'))];
      if (!matches.length) continue;
      const descendants = Array.from(element.querySelectorAll('*'));
      for (const [, id] of matches) {
        // innerText still includes layout text under opacity:0. Reject that
        // candidate instead of using invisible IDs as account evidence.
        if (!descendants.some(child => child.textContent?.includes(id) &&
          !child.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) &&
          getComputedStyle(child).display !== 'contents')) (field.preferred ? preferred : identities).add(id);
      }
    }
  }
  if (rule.ownedRoute) {
    const id = new RegExp(rule.ownedRoute.path).exec(here.pathname)?.[1];
    const prefix = `${rule.ownedRoute.pathPrefix}${id}`;
    const authenticatedNav = id && rule.ownedRoute.selectors.every(selector => all(selector).some(element =>
      element instanceof HTMLAnchorElement && element.origin === here.origin && (element.pathname === prefix || element.pathname.startsWith(`${prefix}/`))));
    if (authenticatedNav) identities.add(id);
  }
  const candidates = preferred.size ? preferred : identities;
  if (candidates.size === 1) return { kind: 'identity', identity: [...candidates][0] };
  if (candidates.size > 1) return { kind: 'unknown', invalidated: true };
  if (inspectLogin) return { kind: 'unknown' };
  const signIn = all('a[href], button').some(element => {
    if (!(element instanceof HTMLElement)) return false;
    const label = (element.getAttribute('aria-label') || element.innerText).trim();
    return /^(?:log ?in|sign in|登录|登入|登錄|立即登录|登录创作者中心|使用帳號登入)$/i.test(label);
  });
  if (!identities.size && signIn) return { kind: 'login' };
  const control = rule.menu && all(rule.menu)[0];
  if (control && control.getAttribute('aria-expanded') !== 'true') {
    const { x, y, width, height } = control.getBoundingClientRect();
    const center = { x: x + width / 2, y: y + height / 2 };
    const hit = document.elementFromPoint(center.x, center.y);
    if (hit && (control.contains(hit) || hit.shadowRoot?.contains(control))) return { kind: 'unknown', control: center };
  }
  return { kind: 'unknown' };
}

export function observationScript(id: ChannelId) {
  const login = id === 'x' ? `, ${inspectXLogin.toString()}` : '';
  return `(${inspectPage.toString()})(${JSON.stringify(channels[id].rule)}${login})`;
}

export function canInspect(id: ChannelId, location: string) {
  const url = URL.parse(location);
  const rule: ChannelRule = channels[id].rule;
  return Boolean(url?.protocol === 'https:' && !url.username && !url.password && !url.port &&
    (rule.hosts.includes(url.hostname) || (rule.loginHosts?.includes(url.hostname) &&
      (!rule.loginHostPath || new RegExp(rule.loginHostPath, 'i').test(url.pathname)))));
}
