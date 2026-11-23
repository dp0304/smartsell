import type { SocialStatusPost } from '../../connector/src/social-status.ts';
import { inspectXLogin } from './x-login.ts';

export type XPostsObservation = { kind: 'unverified' | 'login_required' | 'identity_mismatch' }
  | { kind: 'profile' | 'navigating'; identity: string }
  | { kind: 'posts'; identity: string; posts: SocialStatusPost[] };

// Run in the main frame's isolated world. The only navigation is to the
// canonical profile derived from the visible authenticated account control.
function inspectXPosts(login: typeof inspectXLogin, expected: string | undefined, navigate: boolean): XPostsObservation {
  const loginState = login();
  if (loginState === 'blocked') return { kind: 'unverified' };
  if (loginState === 'login') return { kind: 'login_required' };
  const here = new URL(location.href);
  const origin = 'https://x.com';
  const visible = (node: HTMLElement) => node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    !node.closest('[hidden], [aria-hidden="true"], [inert]') && Array.from(node.getClientRects()).some(rect =>
      rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight);
  const all = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(visible);

  const link = (node: HTMLElement) => node instanceof HTMLAnchorElement && node.origin === origin && !node.username && !node.password &&
    !node.search && !node.hash ? node.pathname : '';
  const profileHandle = (node: HTMLElement) => /^\/([a-z0-9_]{1,15})\/?$/i.exec(link(node))?.[1].toLowerCase();
  const selfControls = all(document, 'header a[data-testid="AppTabBar_Profile_Link"], [role="banner"] a[data-testid="AppTabBar_Profile_Link"]');
  const identity = selfControls.length === 1 ? profileHandle(selfControls[0]) : undefined;
  if (!identity || /^(?:home|explore|login|settings|notifications|messages|i|compose|search)$/.test(identity)) return { kind: 'unverified' };
  if (expected !== undefined && expected.replace(/^@/, '').toLowerCase() !== identity) return { kind: 'identity_mismatch' };
  if (here.pathname.toLowerCase() !== `/${identity}` || here.search || here.hash) {
    if (!navigate) return { kind: 'profile', identity };
    location.assign(`${origin}/${identity}`);
    return { kind: 'navigating', identity };
  }

  const columns = all(document, 'main [data-testid="primaryColumn"]');
  if (columns.length !== 1) return { kind: 'unverified' };
  const column = columns[0];
  const selected = all(column, '[role="tab"][aria-selected="true"]').filter(node => profileHandle(node) === identity);
  if (selected.length !== 1) return { kind: 'unverified' };
  const timelines = all(column, 'section[aria-labelledby] [aria-label]').filter(node => /^(?:Timeline\s*:|时间线\s*[:：]|時間軸\s*[:：]|タイムライン\s*[:：])/i.test(node.getAttribute('aria-label') ?? ''));
  if (timelines.length !== 1) return { kind: 'unverified' };
  const timeline = timelines[0];
  if (all(timeline, '[role="alert"], [role="progressbar"], [aria-busy="true"]').length) return { kind: 'unverified' };
  const articles = all(timeline, 'article[data-testid="tweet"]');
  const posts: SocialStatusPost[] = [];
  const seen = new Set<string>();
  for (const article of articles) {
    if (article.parentElement?.closest('article, [data-testid="quoteTweet"]') ||
      all(article, '[data-testid="socialContext"], [data-testid="promotedIndicator"], [data-testid="adBadge"], [data-testid="quoteTweet"], div[role="link"]').length ||
      all(article, 'span').some(node => !node.closest('[data-testid="tweetText"], [data-testid="User-Name"]') &&
        /^(?:ad|promoted|广告|廣告|プロモーション)$/i.test(node.innerText.trim()))) continue;
    const author = all(article, '[data-testid="User-Name"]');
    if (author.length !== 1 || !all(author[0], 'a[href]').some(node => profileHandle(node) === identity)) continue;
    const stamps = all(author[0], 'a[href]').filter(node => all(node, 'time[datetime]').length === 1);
    const status = stamps.length === 1 ? /^\/([a-z0-9_]{1,15})\/status\/([1-9][0-9]{0,19})$/i.exec(link(stamps[0])) : null;
    if (!status || status[1].toLowerCase() !== identity || seen.has(status[2])) continue;
    const text = all(article, '[data-testid="tweetText"]');
    if (text.length > 1) continue;
    const has_video = all(article, 'video, [data-testid="videoPlayer"]').some(node => !node.closest('[data-testid="card.wrapper"], [data-testid="quoteTweet"]'));
    if (!text.length && !has_video && !all(article, '[data-testid="tweetPhoto"]').length) continue;
    const id = status[2];
    seen.add(id);
    posts.push({ id, url: `${origin}/${identity}/status/${id}`,
      text: (text[0]?.innerText ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500).replace(/[\uD800-\uDBFF]$/, ''), has_video });
    if (posts.length === 5) break;
  }
  if (posts.length) return { kind: 'posts', identity, posts };
  const empty = all(timeline, '[data-testid="emptyState"] [data-testid="emptyStateHeader"]');
  return !timeline.querySelector('article[data-testid="tweet"]') && empty.length === 1 &&
    /^(?:no posts yet|you haven[’']t posted(?: yet)?|尚无帖子|尚無貼文|まだポストがありません)[.!。]?$/i.test(empty[0].innerText.trim())
    ? { kind: 'posts', identity, posts: [] } : { kind: 'unverified' };
}

export function xPostsScript(expected: string | undefined, navigate: boolean) {
  return `(${inspectXPosts.toString()})(${inspectXLogin.toString()}, ${JSON.stringify(expected) ?? 'undefined'}, ${navigate})`;
}
