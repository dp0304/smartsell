// Fixture platform pages (§8.15, interface C9). Local HTTP server that plays X
// under /x and TikTok Studio under /tiktok, with switchable scenarios and
// assertion endpoints under /__fixture. Loopback only; it never proxies or
// contacts a real platform.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { xCompose, xError, xHome, xLogin, xProfile, xStatus, xTwoFactor } from './x-pages.ts';
import { ttContent, ttLegacyFrame, ttLogin, ttSettings, ttUpload } from './tiktok-pages.ts';

export type Platform = 'x' | 'tiktok';
// Beyond the §8.15 table (additive, L-worker): grok_overlay (a side panel covers the composer until Escape),
// challenge_after_post (a captcha appears instead of a result after Post), cookie_banner (TikTok's shadow-DOM cookie
// banner), legacy_iframe (the older TikTok layout with the form inside iframe[data-tt="Upload_index_iframe"]).
// S8: post_offscreen (X: the composer cannot scroll and the Post button sits below the viewport, so no click can reach it).
// G3 (wave 6): post_error_once (X: the first CreateTweet is refused, a second click succeeds, WA-10), reply_control_missing
// (X: the composer has no "Who can reply" control, E40), text_rejected for TikTok (the caption editor refuses program
// input, WA-5). The X composer carries the "Everyone can reply" control and CreateTweet records reply_settings (E40).
export type XScenario = 'ok' | 'zh_hant' | 'login_expired' | 'captcha' | 'two_factor' | 'outdated' | 'slow_upload' | 'no_toast'
  | 'created_hidden' | 'post_error_not_created' | 'text_rejected' | 'handle_changed' | 'grok_overlay' | 'challenge_after_post' | 'post_offscreen'
  | 'post_error_once' | 'reply_control_missing';
export type TikTokScenario = 'ok' | 'zh_hant' | 'login_expired' | 'captcha' | 'two_factor' | 'outdated' | 'slow_upload' | 'popups'
  | 'continue_dialog' | 'no_toast' | 'created_hidden' | 'post_error_not_created' | 'handle_changed' | 'cookie_banner' | 'legacy_iframe'
  | 'challenge_after_post' | 'text_rejected';
export type Scenario = XScenario | TikTokScenario;

export const X_SCENARIOS: readonly XScenario[] = ['ok', 'zh_hant', 'login_expired', 'captcha', 'two_factor', 'outdated', 'slow_upload', 'no_toast',
  'created_hidden', 'post_error_not_created', 'text_rejected', 'handle_changed', 'grok_overlay', 'challenge_after_post', 'post_offscreen',
  'post_error_once', 'reply_control_missing'];
export const TIKTOK_SCENARIOS: readonly TikTokScenario[] = ['ok', 'zh_hant', 'login_expired', 'captcha', 'two_factor', 'outdated', 'slow_upload', 'popups',
  'continue_dialog', 'no_toast', 'created_hidden', 'post_error_not_created', 'handle_changed', 'cookie_banner', 'legacy_iframe', 'challenge_after_post',
  'text_rejected'];

export interface FixturePost {
  platform: Platform; id: string; author: string; text: string; media_sha256: string | null; created_at: string; job_hint: string | null;
  hidden?: boolean; options?: Record<string, unknown>;
}

export interface PlatformFixtures {
  origin: string;
  /** Origins to put in SMARTSELL_TEST_PLATFORM_ORIGINS. */
  origins: { x: string; tiktok: string };
  setScenario(platform: Platform, name: Scenario): void;
  scenario(platform: Platform): Scenario;
  posts(): FixturePost[];
  pageLoads(): Record<string, number>;
  events(): { platform: string; event: string; at: string }[];
  ownerClick(platform: Platform): void;
  /** WA-1: an existing post (older video) on the account, as if published before this test. Returns it. */
  seedPost(post: Pick<FixturePost, 'platform' | 'text'> & Partial<FixturePost>): FixturePost;
  /** WA-1: TikTok Studio's real content list shows no machine-readable row time; false renders rows without <time>. */
  setContentRowTimes(visible: boolean): void;
  reset(): void;
  close(): Promise<void>;
}

export const FIXTURE_X_HANDLE = 'fixture_x';
export const FIXTURE_TT_HANDLE = 'fixture_tt';
export const FIXTURE_TT_USER_ID = '7234567890123456789';

export interface FixtureOptions { port?: number; host?: string; uploadMs?: number; slowUploadMs?: number; xProcessingMs?: number }

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { return {}; }
}

export async function startPlatformFixtures(options: FixtureOptions = {}): Promise<PlatformFixtures> {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Fixtures bind to loopback only');
  const uploadMs = options.uploadMs ?? 1500;
  const slowUploadMs = options.slowUploadMs ?? 40_000;
  const xProcessingMs = options.xProcessingMs ?? 1500;
  let scenarios: Record<Platform, Scenario> = { x: 'ok', tiktok: 'ok' };
  let posts: FixturePost[] = [];
  let loads: Record<string, number> = {};
  let events: { platform: string; event: string; at: string }[] = [];
  let ownerClicks: Record<Platform, number> = { x: 0, tiktok: 0 };
  let uploads = new Map<string, { finalizedAt: number; sha256: string | null }>();
  let lastPrivacy = 'PUBLIC_TO_EVERYONE';
  let xRefusedOnce = false;
  let contentRowTimes = true;
  let counter = 1861234567890123000n;
  const nextId = () => (counter += 1n).toString();

  const send = (response: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    response.end(body);
  };
  const json = (response: ServerResponse, status: number, value: unknown) => send(response, status, JSON.stringify(value), 'application/json');
  const redirect = (response: ServerResponse, location: string) => { response.writeHead(302, { location, 'cache-control': 'no-store' }); response.end(); };
  const page = (response: ServerResponse, path: string, html: string) => { loads[path] = (loads[path] ?? 0) + 1; send(response, 200, html); };

  const xViewer = () => scenarios.x === 'handle_changed' ? 'fixture_x2' : FIXTURE_X_HANDLE;
  const ttViewer = () => scenarios.tiktok === 'handle_changed' ? 'fixture_tt2' : FIXTURE_TT_HANDLE;

  async function handleX(request: IncomingMessage, response: ServerResponse, url: URL) {
    const path = url.pathname.slice(2) || '/';
    const scenario = scenarios.x as XScenario;
    if (request.method === 'GET' && path.startsWith('/__challenge/')) return send(response, 200, '<!doctype html><title>challenge</title><p>Verify you are human</p>');
    if (path === '/i/media/upload.json') {
      const command = url.searchParams.get('command');
      if (command === 'INIT') {
        const body = await readBody(request);
        const id = nextId();
        uploads.set(id, { finalizedAt: 0, sha256: typeof body.sha256 === 'string' ? body.sha256 : null });
        return json(response, 202, { media_id: Number(id.slice(-9)), media_id_string: id, expires_after_secs: 86400 });
      }
      const id = url.searchParams.get('media_id') ?? '';
      const upload = uploads.get(id);
      if (!upload) return json(response, 400, { errors: [{ code: 324, message: 'Invalid media id' }] });
      if (command === 'FINALIZE') { upload.finalizedAt = Date.now(); return json(response, 200, { media_id_string: id, processing_info: { state: 'pending', check_after_secs: 1 } }); }
      if (command === 'STATUS') {
        const wait = scenario === 'slow_upload' ? slowUploadMs : xProcessingMs;
        const elapsed = Date.now() - upload.finalizedAt;
        const state = elapsed >= wait ? 'succeeded' : 'in_progress';
        return json(response, 200, { media_id_string: id, processing_info: { state, ...(state !== 'succeeded' && { check_after_secs: 1, progress_percent: Math.floor(elapsed / wait * 100) }) } });
      }
      return json(response, 400, { errors: [{ code: 38, message: 'command missing' }] });
    }
    if (request.method === 'POST' && /^\/i\/api\/graphql\/[^/]+\/CreateTweet$/.test(path)) {
      const body = await readBody(request);
      if (scenario === 'post_error_not_created' || (scenario === 'post_error_once' && !xRefusedOnce)) {
        xRefusedOnce = true;
        return json(response, 200, { errors: [{ code: 131, message: 'Something went wrong. Try sending your post again in a minute.' }] });
      }
      const post: FixturePost = { platform: 'x', id: nextId(), author: xViewer(), text: String(body.text ?? '').replace(/ /g, ' '), media_sha256: typeof body.media_sha256 === 'string' ? body.media_sha256 : null,
        created_at: new Date().toISOString(), job_hint: null, options: { reply_settings: String(body.reply_settings ?? 'everyone') },
        ...(scenario === 'created_hidden' && { hidden: true }) };
      posts.push(post);
      if (scenario === 'no_toast' || scenario === 'created_hidden') return json(response, 200, { data: { create_tweet: {} }, toast: false });
      return json(response, 200, { data: { create_tweet: { tweet_results: { result: { rest_id: post.id, legacy: { full_text: post.text } } } } } });
    }
    if (request.method !== 'GET') return json(response, 404, { error: 'not found' });
    if (path === '/i/flow/login') return page(response, '/x/i/flow/login', xLogin(url.searchParams.get('next') ?? '/x/home'));
    if (path === '/i/flow/two-factor') return page(response, '/x/i/flow/two-factor', xTwoFactor(url.searchParams.get('next') ?? '/x/home'));
    if (path === '/home' || path === '/compose/post') {
      if (scenario === 'login_expired') return redirect(response, `/x/i/flow/login?next=${encodeURIComponent(`/x${path}`)}`);
      if (scenario === 'two_factor') return redirect(response, `/x/i/flow/two-factor?next=${encodeURIComponent(`/x${path}`)}`);
      return page(response, `/x${path}`, path === '/home' ? xHome(xViewer(), scenario) : xCompose(xViewer(), scenario));
    }
    const status = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/.exec(path);
    if (status) {
      const post = posts.find(item => item.platform === 'x' && item.id === status[2] && !item.hidden);
      if (!post) return page(response, '/x/status/missing', xError());
      return page(response, `/x/${status[1]}/status`, xStatus(xViewer(), post, scenario));
    }
    const profile = /^\/([A-Za-z0-9_]{1,15})$/.exec(path);
    if (profile) {
      const own = posts.filter(item => item.platform === 'x' && !item.hidden && item.author.toLowerCase() === profile[1].toLowerCase()).reverse();
      return page(response, `/x/${profile[1]}`, xProfile(profile[1], xViewer(), own, scenario));
    }
    return send(response, 404, xError());
  }

  async function handleTikTok(request: IncomingMessage, response: ServerResponse, url: URL) {
    const path = url.pathname.slice('/tiktok'.length) || '/';
    const scenario = scenarios.tiktok as TikTokScenario;
    if (request.method === 'POST' && path === '/tiktok/web/project/post/v1/') {
      const body = await readBody(request);
      if (scenario === 'post_error_not_created') return json(response, 200, { code: 7, message: 'Permission Denied' });
      const post: FixturePost = { platform: 'tiktok', id: (7300000000000000000n + BigInt(posts.length + 1)).toString(), author: ttViewer(),
        text: String(body.caption ?? '').replace(/ /g, ' '), media_sha256: typeof body.media_sha256 === 'string' ? body.media_sha256 : null,
        created_at: new Date().toISOString(), job_hint: null, options: body, ...(scenario === 'created_hidden' && { hidden: true }) };
      posts.push(post);
      lastPrivacy = String(body.privacy_level ?? lastPrivacy);
      return json(response, 200, { status_code: 0, status_msg: '', navigate: scenario !== 'no_toast' && scenario !== 'created_hidden' });
    }
    if (request.method !== 'GET') return json(response, 404, { error: 'not found' });
    if (path === '/login') return page(response, '/tiktok/login', ttLogin(url.searchParams.get('next') ?? '/tiktok/tiktokstudio/upload', false));
    if (path === '/login/verify') return page(response, '/tiktok/login/verify', ttLogin(url.searchParams.get('next') ?? '/tiktok/tiktokstudio/upload', true));
    if (path.startsWith('/tiktokstudio/')) {
      const next = `/tiktok${path}${url.search}`;
      if (scenario === 'login_expired') return redirect(response, `/tiktok/login?next=${encodeURIComponent(next)}`);
      if (scenario === 'two_factor') return redirect(response, `/tiktok/login/verify?next=${encodeURIComponent(next)}`);
      if (path === '/tiktokstudio/upload/legacy-frame') return page(response, '/tiktok/tiktokstudio/upload/legacy-frame', ttLegacyFrame());
      if (path === '/tiktokstudio/upload') return page(response, '/tiktok/tiktokstudio/upload', ttUpload(ttViewer(), scenario, { uploadMs: scenario === 'slow_upload' ? slowUploadMs : uploadMs, lastPrivacy }));
      if (path === '/tiktokstudio/settings') return page(response, '/tiktok/tiktokstudio/settings', ttSettings(ttViewer(), FIXTURE_TT_USER_ID, scenario));
      if (path === '/tiktokstudio/content') {
        const own = posts.filter(item => item.platform === 'tiktok' && !item.hidden).reverse();
        return page(response, '/tiktok/tiktokstudio/content', ttContent(ttViewer(), own, { times: contentRowTimes }));
      }
    }
    return send(response, 404, '<!doctype html><title>Not found</title><h1>Page not available</h1>');
  }

  async function handleFixture(request: IncomingMessage, response: ServerResponse, url: URL) {
    const platform = (url.searchParams.get('platform') ?? '') as Platform;
    switch (url.pathname) {
      case '/__fixture/posts': return json(response, 200, posts);
      case '/__fixture/page-loads': return json(response, 200, loads);
      case '/__fixture/events': return json(response, 200, events);
      case '/__fixture/event': {
        const body = await readBody(request);
        events.push({ platform: String(body.platform ?? ''), event: String(body.event ?? ''), at: new Date().toISOString() });
        return json(response, 200, { ok: true });
      }
      case '/__fixture/scenario': {
        if (request.method === 'POST') {
          const body = await readBody(request);
          api.setScenario(body.platform as Platform, body.name as Scenario);
          return json(response, 200, { ok: true });
        }
        return json(response, 200, { name: scenarios[platform] ?? null });
      }
      case '/__fixture/owner-click': {
        if (request.method === 'POST') {
          const body = await readBody(request);
          api.ownerClick(body.platform as Platform);
          return json(response, 200, { ok: true });
        }
        const pending = (ownerClicks[platform] ?? 0) > 0;
        if (pending) ownerClicks[platform] -= 1;
        return json(response, 200, { pending });
      }
      case '/__fixture/reset': api.reset(); return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: 'unknown fixture endpoint' });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    const route = url.pathname.startsWith('/__fixture/') ? handleFixture : url.pathname === '/x' || url.pathname.startsWith('/x/') ? handleX
      : url.pathname === '/tiktok' || url.pathname.startsWith('/tiktok/') ? handleTikTok : null;
    if (!route) return send(response, 404, 'not found', 'text/plain');
    route(request, response, url).catch(error => { if (!response.headersSent) json(response, 500, { error: String(error) }); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, host, () => resolve()); });
  const { port } = server.address() as AddressInfo;
  const origin = `http://${host === '::1' ? '[::1]' : host}:${port}`;

  const api: PlatformFixtures = {
    origin,
    origins: { x: `${origin}/x`, tiktok: `${origin}/tiktok` },
    setScenario(platform, name) {
      const allowed: readonly string[] = platform === 'x' ? X_SCENARIOS : TIKTOK_SCENARIOS;
      if (!allowed.includes(name)) throw new Error(`Unknown ${platform} scenario ${name}`);
      scenarios = { ...scenarios, [platform]: name };
    },
    scenario: platform => scenarios[platform],
    posts: () => structuredClone(posts),
    pageLoads: () => ({ ...loads }),
    events: () => [...events],
    ownerClick(platform) { ownerClicks = { ...ownerClicks, [platform]: (ownerClicks[platform] ?? 0) + 1 }; },
    seedPost(input) {
      const post: FixturePost = {
        id: input.platform === 'tiktok' ? (7200000000000000000n + BigInt(posts.length + 1)).toString() : nextId(),
        author: input.platform === 'tiktok' ? ttViewer() : xViewer(), media_sha256: null, created_at: new Date(Date.now() - 86_400_000).toISOString(),
        job_hint: null, ...input,
      };
      posts.push(post);
      return structuredClone(post);
    },
    setContentRowTimes(visible) { contentRowTimes = visible; },
    reset() {
      scenarios = { x: 'ok', tiktok: 'ok' }; posts = []; loads = {}; events = []; ownerClicks = { x: 0, tiktok: 0 }; uploads = new Map();
      lastPrivacy = 'PUBLIC_TO_EVERYONE'; xRefusedOnce = false; contentRowTimes = true;
    },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  return api;
}
