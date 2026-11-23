export const zhihuOrigin = 'https://www.zhihu.com';
export const zhihuSignIn = `${zhihuOrigin}/signin?next=%2F`;

type Point = { x: number; y: number };
export type ZhihuLoginDiagnostic = 'challenge' | 'sign-in-unrecognized' | 'off-origin' | 'page-error';
export type VisibleZhihu = { kind: 'manual' | 'waiting' | 'ambiguous' | 'mismatch' | 'login-required' | 'signed-in' | ZhihuLoginDiagnostic }
  | { kind: 'menu'; point: Point }
  | { kind: 'profile'; point: Point; slug: string }
  | { kind: 'stats'; followers: string; upvotes: string }
  | { kind: 'clicked' };
export type ZhihuProfileStep = Extract<VisibleZhihu, { kind: 'menu' | 'profile' }>;

// Executed only in the main frame's isolated world. Never reads form values,
// storage, cookies, hidden metrics, or arbitrary page text.
function inspect(origin: string, selectedSlug: string | undefined, menuOpened: boolean, loginCheck: boolean, approved?: ZhihuProfileStep): VisibleZhihu {
  const here = new URL(location.href);
  if (here.origin !== origin || here.username || here.password) return { kind: 'off-origin' };
  const route = /^\/people\/([A-Za-z0-9_-]{1,100})\/?$/;
  const visible = (item: HTMLElement) => item.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    !item.closest('[hidden], [aria-hidden="true"], [inert]') && Array.from(item.getClientRects()).some(rect =>
      rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight);
  const all = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible);
  const point = (item: HTMLElement) => {
    const rect = item.getBoundingClientRect();
    const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
    const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && item.contains(hit) ? { x, y } : undefined;
  };
  if (/^\/(?:signup|account|captcha|challenge|unhuman|authentication)(?:\/|$)/i.test(here.pathname) ||
    all('.Captcha, [class*="Captcha"], [class*="captcha"], .Verification, [class^="Verification-"], [class*=" Verification-"], [class*="geetest"], iframe[src*="captcha"], iframe[src*="challenge"], [role="alertdialog"]').length) {
    return { kind: 'challenge' };
  }
  if (/^\/error(?:\/|$)/i.test(here.pathname) ||
    all('.ErrorPage, .SignFlow-errorMessage, .SignFlow [role="alert"]').length) return { kind: 'page-error' };

  const signinRoute = /^\/(?:signin|login)\/?$/i.test(here.pathname);
  const signInForms = all('form.SignFlow');
  for (const form of signInForms) {
    const interactable = (selector: string) => Array.from(form.querySelectorAll<HTMLElement>(selector))
      .filter(item => visible(item) && point(item));
    const signIn = interactable('button.SignFlow-submitButton').some(button =>
      /^(?:登录|登入|登錄|登录知乎|登录\s*[/／]\s*注册|注册\s*[/／]\s*登录|sign in|log in)$/i.test(button.innerText.trim()));
    if (signIn && interactable('input[name="username"], input[name="password"], input[name="phoneNo"], input[type="tel"], .SignFlow-accountInput input').length) {
      return { kind: 'login-required' };
    }
  }
  // QR login may be a sibling of the phone/password form on the full login page.
  if (signinRoute && all('.Qrcode-container .Qrcode-content .Qrcode-img img, .Qrcode-container .Qrcode-content .Qrcode-img canvas, .Qrcode-container .Qrcode-content img.Qrcode-img').some(point)) {
    return { kind: 'login-required' };
  }
  if (signinRoute || signInForms.length) return { kind: 'sign-in-unrecognized' };
  if (all('input[type="password"]').length ||
    all('header button, header a').some(node => /^(?:登录|登入|登錄|立即登录|sign in|log in)$/i.test(node.innerText.trim()))) {
    return { kind: 'manual' };
  }

  if (!loginCheck && selectedSlug !== undefined) {
    const found = route.exec(here.pathname)?.[1];
    if (!found) return { kind: 'waiting' };
    if (found !== selectedSlug || here.search || here.hash) return { kind: 'mismatch' };
    const followerItems = all('.Profile-sideColumn a.NumberBoard-item, .Profile-mainColumn a.NumberBoard-item').filter(item => {
      if (!(item instanceof HTMLAnchorElement) || item.origin !== origin || item.username || item.password || item.search || item.hash) return false;
      return item.pathname === `/people/${selectedSlug}/followers` || item.pathname === `/people/${selectedSlug}/followers/`;
    });
    const followers = followerItems.map(item => {
      const label = item.querySelector<HTMLElement>('.NumberBoard-itemName');
      const number = item.querySelector<HTMLElement>('.NumberBoard-itemValue');
      return label && number && visible(label) && visible(number) && point(number) && /^(?:关注者|關注者|粉丝|粉絲)$/.test(label.innerText.trim())
        ? number.innerText : '';
    }).filter(Boolean);
    const count = '[0-9０-９](?:[0-9０-９,.，．\\s]*[0-9０-９])?\\s*[万萬亿億千]?';
    const countText = new RegExp(`^\\s*${count}\\s*$`);
    const upvoteText = new RegExp(`^\\s*(?:获得|獲得)\\s*${count}\\s*次[赞贊]同\\s*$`);
    const achievements = '.IconGraf, .Profile-sideColumnItem, .Profile-lightListItem, .Profile-sideColumn .Card :is(div, span)';
    // The current sidebar adds a zero-width layout marker before the visible line.
    const achievementText = (item: HTMLElement) => item.innerText.replace(/^​\s*/, '');
    const upvotes = all(achievements).filter(item => item.closest('.Profile-sideColumn') && point(item) && upvoteText.test(achievementText(item)))
      .filter(item => !Array.from(item.querySelectorAll<HTMLElement>(achievements)).some(child =>
        visible(child) && point(child) && achievementText(child) === achievementText(item))).map(achievementText);
    if (followers.length > 1 || upvotes.length > 1) return { kind: 'ambiguous' };
    if (followers.length !== 1 || upvotes.length !== 1 || !countText.test(followers[0]) ||
      followers[0].length > 128 || upvotes[0].length > 128) return { kind: 'waiting' };
    return { kind: 'stats', followers: followers[0], upvotes: upvotes[0] };
  }

  // Re-prove the control and activate it in the same document, rather than
  // sending coordinates that could hit another page after a concurrent redirect.
  const click = (node: HTMLElement, current: ZhihuProfileStep): VisibleZhihu => {
    if (!approved) return current;
    if (approved.kind !== current.kind || (current.kind === 'profile' && (approved.kind !== 'profile' || approved.slug !== current.slug)) ||
      Math.abs(approved.point.x - current.point.x) > 2 || Math.abs(approved.point.y - current.point.y) > 2) return { kind: 'manual' };
    if (current.kind === 'profile') location.assign(`${origin}/people/${current.slug}`);
    else node.click();
    return { kind: 'clicked' };
  };
  // Only the authenticated account's labeled entry, not an arbitrary people link.
  const profileLinks = 'header .AppHeader-profile a[href], header .AppHeader-userInfo a[href]';
  // A portaled entry is trusted only in the account popover opened by this operation.
  const portalLinks = ', .Popover-content a.Menu-item[href], .Popover-content [role="menu"] a[href]';
  const links = all(profileLinks + (menuOpened ? portalLinks : ''))
    .filter(node => /^(?:我的主页|我的主頁|我的个人主页|我的個人主頁|My Profile)$/i.test(node.innerText.trim()));
  if (links.length > 1) return { kind: 'ambiguous' };
  if (links.length === 1) {
    const link = links[0];
    if (!(link instanceof HTMLAnchorElement) || link.origin !== origin || link.username || link.password || link.search || link.hash ||
      link.hasAttribute('download') || (link.target && link.target !== '_self')) return { kind: 'ambiguous' };
    const slug = route.exec(link.pathname)?.[1];
    const hit = point(link);
    if (!slug || !hit) return { kind: 'ambiguous' };
    return loginCheck ? { kind: 'signed-in' } : click(link, { kind: 'profile', point: hit, slug });
  }
  const controls = all('header button.AppHeader-profileEntry, header .AppHeader-profile button[aria-haspopup="true"], header .AppHeader-userInfo button[aria-haspopup="true"]')
    .filter(node => loginCheck || node.getAttribute('aria-expanded') !== 'true');
  if (controls.length > 1) return { kind: 'ambiguous' };
  const control = controls[0] && point(controls[0]);
  if (!control) return { kind: 'waiting' };
  if (controls[0].closest('form')) return { kind: 'ambiguous' };
  return loginCheck ? { kind: 'signed-in' } : click(controls[0], { kind: 'menu', point: control });
}

export function zhihuObservationScript(slug?: string, menuOpened = false, loginCheck = false, approved?: ZhihuProfileStep) {
  // tsx/esbuild keepNames can inject this helper inside the serialized function.
  return `(() => { const __name = fn => fn; return (${inspect.toString()})(${JSON.stringify(zhihuOrigin)},${JSON.stringify(slug) ?? 'undefined'},${menuOpened},${loginCheck},${JSON.stringify(approved) ?? 'undefined'}); })()`;
}
