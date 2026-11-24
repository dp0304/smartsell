// Wave 6 (G3-worker) driver regressions on scripted pages (§8.15a), with a virtual clock so waits cost no real time:
// WA-1 (TikTok read-back must never claim an older video), WA-5 (TikTok options are set before a caption hand-off),
// E40 / WA-7 (X "Who can reply"), WA-9 (pre-click platform_error copy) and WA-10 (a refused owner click is a fact).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockerMessage } from '../../apps/connector-desktop/src/drivers/messages.ts';
import { defaultSelectors } from '../../apps/connector-desktop/src/drivers/selectors.ts';
import { READBACK_CLICK_SKEW_MS } from '../../apps/connector-desktop/src/drivers/steps.ts';
import { TikTokDriver } from '../../apps/connector-desktop/src/drivers/tiktok.ts';
import type { DriverBlocker, DriverContext, PublishOptions } from '../../apps/connector-desktop/src/drivers/types.ts';
import { XDriver } from '../../apps/connector-desktop/src/drivers/x.ts';
import type { PublishPostPayload } from '../../apps/connector-desktop/src/runtime/contracts.ts';
import { FakeCdpPage, type FakeNode } from './fakes/fake-cdp-page.ts';
import { publishJob } from './fakes/driver-harness.ts';

const table = defaultSelectors();
const css = (provider: 'x' | 'tiktok', step: string, index = 0) => table[provider].steps[step].primary[index].css!;
const clip = { sha256: 'a'.repeat(64), bytes: 1000 };

/** Virtual time: sleeping advances it at once. */
function clock(start = Date.parse('2026-11-25T01:00:00.000Z')) {
  let now = start;
  return { now: () => now, sleep: async (ms: number) => { now += ms; await new Promise(done => setImmediate(done)); } };
}

function context(page: FakeCdpPage, provider: 'x' | 'tiktok', time = clock()): DriverContext {
  return {
    page, platformUrl: path => `http://127.0.0.1:9/${provider}${path}`, expectedIdentity: provider === 'x' ? 'fixture_x' : '7234567890123456789',
    signal: new AbortController().signal, evidence: async label => `sha-${label}`, log: () => {}, now: time.now, sleep: time.sleep,
    selectors: table, mediaPaths: ['/tmp/video.mp4'], blockerPollMs: 20, trace: [],
    messages: { machine: 'Mac-B', channel: provider === 'x' ? 'X @fixture_x' : 'TikTok @fixture_tt', deadline: '09:30' },
  };
}

function options(ctx: DriverContext, overrides: Partial<PublishOptions> = {}) {
  const state = { beforeClick: 0, ownerWaits: [] as DriverBlocker[] };
  const value: PublishOptions = {
    dryRun: false, mode: 'auto', revoked: () => false, ownerWaitUntil: ctx.now() + 60_000,
    onBeforeClick: async () => { state.beforeClick += 1; return true; },
    onOwnerWait: async blocker => { state.ownerWaits.push(blocker); }, ...overrides,
  };
  return Object.assign(value, { state });
}

// ---------- TikTok read-back (WA-1) ----------

interface Row { id: string; text: string; time?: string }
function contentPage(rows: Row[]) {
  const page = new FakeCdpPage();
  page.onGoto = url => { page.url_ = url; };
  for (const row of rows) {
    const node = page.add({ css: [css('tiktok', 'tt.content_row')], text: row.text || '(no caption)' });
    page.add({ css: [css('tiktok', 'tt.row_link')], attrs: { href: `/@fixture_tt/video/${row.id}` }, parent: node.id });
    if (row.time) page.add({ css: [css('tiktok', 'tt.row_time')], attrs: { datetime: row.time }, parent: node.id });
  }
  return page;
}

async function readBack(rows: Row[], hint: { known_ids?: string[]; caption?: string; clickAt?: number }) {
  const page = contentPage(rows);
  const ctx = context(page, 'tiktok');
  const clickAt = hint.clickAt ?? ctx.now();
  const caption = hint.caption ?? 'New lure test 🎣 #fishing #lure';
  return new TikTokDriver().readBack(ctx, publishJob('tiktok', clip), {
    submittedAt: clickAt, captionPrefix: [...caption].slice(0, 30).join(''), ...(hint.known_ids && { known_ids: hint.known_ids }),
  });
}

const OLD = '7400000000000000001', NEW = '7400000000000000002';
const yesterday = (now: number) => new Date(now - 86_400_000).toISOString();

test('WA-1 (a): empty caption, the new video not listed yet, an older video with no readable time → not_yet (never that video)', async () => {
  assert.deepEqual(await readBack([{ id: OLD, text: '' }], { caption: '' }), { kind: 'not_yet' });
});

test('WA-1 (b): a repeated caption on an older video whose time cannot be read → not_yet without a pre-click list', async () => {
  assert.deepEqual(await readBack([{ id: OLD, text: 'New lure test 🎣 #fishing #lure' }], {}), { kind: 'not_yet' });
});

test('WA-1 (c): a same-caption post 90 s before the click (two 9:00 posts back to back) is not this post', async () => {
  const now = clock().now();
  assert.deepEqual(await readBack([{ id: OLD, text: 'New lure test 🎣 #fishing #lure', time: new Date(now - 90_000).toISOString() }], { clickAt: now }), { kind: 'not_yet' });
  assert.ok(90_000 > READBACK_CLICK_SKEW_MS);
});

test('WA-1: with the pre-click list, the new video is found without a readable time and the older one is skipped', async () => {
  const found = await readBack([{ id: NEW, text: 'New lure test 🎣 #fishing #lure' }, { id: OLD, text: 'New lure test 🎣 #fishing #lure' }], { known_ids: [OLD] });
  assert.deepEqual(found.kind === 'found' && [found.external_post_id, found.url], [NEW, `https://www.tiktok.com/@fixture_tt/video/${NEW}`]);
  // Not yet listed: only the known older video → not_yet.
  assert.deepEqual(await readBack([{ id: OLD, text: 'New lure test 🎣 #fishing #lure' }], { known_ids: [OLD] }), { kind: 'not_yet' });
});

test('WA-1: an empty caption matches only by a new id (the pre-click list), never by text', async () => {
  const found = await readBack([{ id: NEW, text: '' }, { id: OLD, text: '' }], { known_ids: [OLD], caption: '' });
  assert.equal(found.kind === 'found' && found.external_post_id, NEW);
});

test('WA-1: an unknown untimed row below a row that existed before the click is not taken', async () => {
  assert.deepEqual(await readBack([{ id: OLD, text: 'other video' }, { id: NEW, text: 'New lure test 🎣 #fishing #lure' }], { known_ids: [OLD] }), { kind: 'not_yet' });
});

test('WA-1: without a pre-click list a readable time after the click and a matching caption are both required', async () => {
  const now = clock().now();
  const found = await readBack([{ id: NEW, text: 'New lure test 🎣 #fishing #lure', time: new Date(now + 5_000).toISOString() },
    { id: OLD, text: 'New lure test 🎣 #fishing #lure', time: yesterday(now) }], { clickAt: now });
  assert.equal(found.kind === 'found' && found.external_post_id, NEW);
  assert.deepEqual(await readBack([{ id: NEW, text: '', time: new Date(now + 5_000).toISOString() }], { clickAt: now, caption: '' }), { kind: 'not_yet' });
});

// ---------- TikTok upload form (WA-1 snapshot, WA-5, WA-10) ----------

function tiktokPage(time: ReturnType<typeof clock>, content: Row[] = []) {
  const page = new FakeCdpPage();
  page.url_ = 'http://127.0.0.1:9/tiktok/tiktokstudio/upload?from=upload';
  page.onGoto = url => { page.url_ = url; };
  page.add({ css: ['body'], text: content.length ? 'Posts' : 'No content yet' });
  for (const row of content) {
    const node = page.add({ css: [css('tiktok', 'tt.content_row')], text: row.text });
    page.add({ css: [css('tiktok', 'tt.row_link')], attrs: { href: `/@fixture_tt/video/${row.id}` }, parent: node.id });
  }
  page.add({ css: [css('tiktok', 'tt.ready'), css('tiktok', 'tt.file_input')], visible: false, onFiles: () => { page.add({ css: [css('tiktok', 'tt.uploaded')] }); } });
  page.add({ css: [css('tiktok', 'tt.caption')], text: 'video' });
  page.add({ css: [css('tiktok', 'tt.mention_popover')] });
  const who = page.add({ css: [css('tiktok', 'tt.visibility')], text: 'Everyone', onClick: () => {
    for (const name of ['Everyone', 'Friends', 'Only you']) page.add({ role: 'option', name, onClick: () => { who.text = name; } });
  } });
  const toggle = (label: string, checked: boolean) => {
    const node = page.add({ css: ['label.Checkbox__root'], text: label, attrs: { 'aria-checked': String(checked) } });
    node.onClick = () => { node.attrs = { ...node.attrs, 'aria-checked': node.attrs!['aria-checked'] === 'true' ? 'false' : 'true' }; };
    return node;
  };
  const comment = toggle('Comment', false);
  toggle('Reuse of content', true);
  const respond = (body: object) => page.responses.push({ url: 'https://www.tiktok.com/tiktok/web/project/post/v1/', status: 200, body: JSON.stringify(body), at: time.now() });
  const post = page.add({ css: [css('tiktok', 'tt.post_button')], attrs: { 'aria-disabled': 'false' }, onClick: () => respond({ status_code: 0 }) });
  return { page, who, comment, post, respond };
}

test('WA-1: TikTok publish reads the content list before the upload and hands the known ids to read-back', async () => {
  const time = clock();
  const { page, post } = tiktokPage(time, [{ id: OLD, text: 'yesterday' }, { id: '7400000000000000000', text: 'older' }]);
  const ctx = context(page, 'tiktok', time);
  const outcome = await new TikTokDriver().publish(ctx, publishJob('tiktok', clip), options(ctx));
  assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
  assert.deepEqual(outcome.kind === 'submitted' && outcome.hint.known_ids, [OLD, '7400000000000000000']);
  const order = page.calls.map(call => call.method === 'goto' ? `goto:${new URL(String(call.args?.[0])).pathname}` : call.method);
  assert.ok(order.indexOf('goto:/tiktok/tiktokstudio/content') < order.indexOf('setFiles'), 'the list is read before the video exists');
  assert.equal(page.count('click', post.id), 1);
});

test('WA-1: an empty content list is a valid snapshot (known_ids = []); a dry run reads no list', async () => {
  const time = clock();
  const { page } = tiktokPage(time);
  const ctx = context(page, 'tiktok', time);
  const outcome = await new TikTokDriver().publish(ctx, publishJob('tiktok', clip), options(ctx));
  assert.deepEqual(outcome.kind === 'submitted' && outcome.hint, { known_ids: [] });
  const dry = tiktokPage(time);
  const dryCtx = context(dry.page, 'tiktok', time);
  assert.equal((await new TikTokDriver().publish(dryCtx, publishJob('tiktok', clip), options(dryCtx, { dryRun: true }))).kind, 'dry_run_done');
  assert.ok(!dry.page.navigations().some(call => String(call.args?.[0]).includes('/tiktokstudio/content')));
});

test('WA-5: a rejected TikTok caption is handed to the owner only after privacy and the other options are set and read back', async () => {
  const time = clock();
  const { page, who, comment, post } = tiktokPage(time);
  page.onInsert = () => {}; // the editor refuses program input
  const ctx = context(page, 'tiktok', time);
  let atHandOff: string[] = [];
  const o = options(ctx, { ownerWaitUntil: time.now() + 3_000, onOwnerWait: async blocker => {
    atHandOff = [blocker.code, who.text ?? '', comment.attrs?.['aria-checked'] ?? ''];
  } });
  const outcome = await new TikTokDriver().publish(ctx, publishJob('tiktok', clip), o);
  assert.deepEqual(atHandOff, ['caption_rejected', 'Only you', 'true'], 'SELF_ONLY and comments set before the owner sees the page');
  assert.equal(outcome.kind === 'blocked' && outcome.blocker.code, 'caption_rejected');
  assert.equal(page.count('click', post.id), 0);
  assert.equal(o.state.beforeClick, 0);
});

test('WA-5: an option that cannot be set stops as driver_outdated before any hand-off of a rejected caption', async () => {
  const time = clock();
  const { page, who } = tiktokPage(time);
  page.onInsert = () => {};
  who.onClick = () => {}; // the privacy menu never opens
  const ctx = context(page, 'tiktok', time);
  const o = options(ctx);
  const outcome = await new TikTokDriver().publish(ctx, publishJob('tiktok', clip), o);
  assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.step, outcome.blocker.phase], ['driver_outdated', 'tt.visibility', 'before_submit']);
  assert.equal(o.state.ownerWaits.length, 0);
});

test('WA-10: TikTok assist — the owner clicked Post and TikTok refused it → after_submit platform_error, not "not clicked", no discard', async () => {
  const time = clock();
  const { page, respond } = tiktokPage(time);
  const discard = page.add({ role: 'button', name: 'Discard' });
  const ctx = context(page, 'tiktok', time);
  const o = options(ctx, { mode: 'assist', ownerWaitUntil: time.now() + 10_000, onOwnerWait: async () => { respond({ code: 7, message: 'Permission Denied' }); } });
  const outcome = await new TikTokDriver().publish(ctx, publishJob('tiktok', clip), o);
  assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['platform_error', 'after_submit'], JSON.stringify(outcome));
  assert.match(outcome.kind === 'blocked' ? outcome.blocker.message : '', /Permission Denied.*不會自動重發/);
  assert.equal(page.count('click', discard.id), 0, 'the uploaded video stays in the window');
});

test('WA-10: TikTok assist — a refused click followed by the owner\'s successful click counts as posted by the owner', async () => {
  const time = clock();
  const { page, respond } = tiktokPage(time);
  const ctx = context(page, 'tiktok', time);
  const o = options(ctx, { mode: 'assist', ownerWaitUntil: time.now() + 30_000, onOwnerWait: async () => {
    respond({ code: 7, message: 'Permission Denied' });
    setImmediate(() => respond({ status_code: 0 }));
  } });
  const outcome = await new TikTokDriver().publish(ctx, publishJob('tiktok', clip), o);
  assert.equal(outcome.kind === 'submitted' && outcome.submitted_by, 'owner', JSON.stringify(outcome));
});

// ---------- X composer (E40 / WA-7, WA-10, WA-9) ----------

function xPage(time: ReturnType<typeof clock>, behaviour: { reply?: 'present' | 'missing' | 'stuck'; createBodies?: object[]; rejectText?: boolean } = {}) {
  const page = new FakeCdpPage();
  page.url_ = 'http://127.0.0.1:9/x/compose/post';
  page.onGoto = url => { page.url_ = url; };
  const dialog = page.add({ css: ['[role="dialog"]'] });
  const box = page.add({ css: [css('x', 'x.ready'), css('x', 'x.textbox')], role: 'textbox', name: 'Post text', text: '', parent: dialog.id });
  page.add({ css: [css('x', 'x.identity')], attrs: { href: '/fixture_x' } });
  if (behaviour.rejectText) page.onInsert = () => {};
  page.add({ css: [css('x', 'x.file_input')], visible: false, parent: dialog.id, onFiles: () => {
    page.add({ css: [css('x', 'x.attached')], parent: dialog.id });
    page.responses.push({ url: 'https://upload.x.com/i/media/upload.json?command=STATUS', status: 200, body: JSON.stringify({ processing_info: { state: 'succeeded' } }), at: time.now() });
  } });
  const labels = { everyone: 'Everyone can reply', following: 'Accounts you follow can reply', verified: 'Verified accounts can reply', mentioned: 'Only accounts you mention can reply' };
  let control: FakeNode | undefined;
  const items: FakeNode[] = [];
  if (behaviour.reply !== 'missing') {
    control = page.add({ role: 'button', name: labels.everyone, text: labels.everyone, parent: dialog.id, onClick: () => {
      if (items.length) return;
      for (const [value, label] of [['everyone', 'Everyone'], ['following', 'Accounts you follow'], ['verified', 'Verified accounts'], ['mentioned', 'Only accounts you mention']] as const) {
        items.push(page.add({ css: [css('x', 'x.reply_menu_item')], role: 'menuitem', name: label, text: label, onClick: () => {
          if (behaviour.reply === 'stuck') return;
          control!.text = labels[value]; control!.name = labels[value];
          page.remove(node => items.includes(node)); items.length = 0;
        } }));
      }
    } });
  }
  const bodies = [...(behaviour.createBodies ?? [{ data: { create_tweet: { tweet_results: { result: { rest_id: '1861' } } } } }])];
  const create = () => page.responses.push({ url: 'https://x.com/i/api/graphql/abc/CreateTweet', status: 200, at: time.now(), body: JSON.stringify(bodies.shift() ?? bodies.at(-1)) });
  const post = page.add({ css: [css('x', 'x.post_button')], role: 'button', name: 'Post', attrs: { 'aria-disabled': 'false' }, parent: dialog.id, onClick: create });
  page.onPress = key => { if (key === 'Escape') page.add({ css: [css('x', 'x.discard')], role: 'button', name: 'Discard' }); else if (key === 'Enter') box.text += '\n'; };
  return { page, box, post, control: () => control, create };
}

const xJob = (reply: 'everyone' | 'following' | 'verified' | 'mentioned', caption = 'New lure test #lure') =>
  publishJob('x', clip, { options: { x: { reply_settings: reply } }, caption: { text: caption, title: null } } as Partial<PublishPostPayload>);

test('E40: X "Who can reply" is set in the composer and read back before the single Post click', async () => {
  const time = clock();
  const { page, post, control } = xPage(time);
  const ctx = context(page, 'x', time);
  const o = options(ctx);
  const outcome = await new XDriver().publish(ctx, xJob('following'), o);
  assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
  assert.equal(control()!.text, 'Accounts you follow can reply');
  const clicks = page.calls.filter(call => call.method === 'click').map(call => call.node);
  assert.ok(clicks.indexOf(control()!.id) < clicks.indexOf(post.id), 'reply setting before Post');
  assert.equal(page.count('click', post.id), 1);
  assert.ok(ctx.trace.some(step => step.step === 'x.reply_settings' && step.matched !== 'none'));
});

test('E40: "everyone" is X\'s default and is skipped (the control is never touched)', async () => {
  const time = clock();
  const { page, control } = xPage(time);
  const ctx = context(page, 'x', time);
  assert.equal((await new XDriver().publish(ctx, xJob('everyone'), options(ctx))).kind, 'submitted');
  assert.equal(page.count('click', control()!.id), 0);
});

test('E40: no "Who can reply" control → driver_outdated (before_submit) at x.reply_settings, never clicked Post', async () => {
  const time = clock();
  const { page, post } = xPage(time, { reply: 'missing' });
  const ctx = context(page, 'x', time);
  const o = options(ctx);
  const outcome = await new XDriver().publish(ctx, xJob('mentioned'), o);
  assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.step, outcome.blocker.phase], ['driver_outdated', 'x.reply_settings', 'before_submit']);
  assert.match(outcome.kind === 'blocked' ? outcome.blocker.message : '', /設定誰可以回覆/);
  assert.equal(page.count('click', post.id), 0);
  assert.equal(o.state.beforeClick, 0);
});

test('E40: a choice that does not read back stops as driver_outdated', async () => {
  const time = clock();
  const { page, post } = xPage(time, { reply: 'stuck' });
  const ctx = context(page, 'x', time);
  const outcome = await new XDriver().publish(ctx, xJob('verified'), options(ctx));
  assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.step], ['driver_outdated', 'x.reply_settings']);
  assert.equal(page.count('click', post.id), 0);
});

test('E40: a rejected caption is handed to the owner with the reply setting already applied', async () => {
  const time = clock();
  const { page, control } = xPage(time, { rejectText: true });
  const ctx = context(page, 'x', time);
  let atHandOff: string[] = [];
  const o = options(ctx, { ownerWaitUntil: time.now() + 3_000, onOwnerWait: async blocker => { atHandOff = [blocker.code, control()!.text ?? '']; } });
  const outcome = await new XDriver().publish(ctx, xJob('following'), o);
  assert.deepEqual(atHandOff, ['caption_rejected', 'Accounts you follow can reply'], JSON.stringify(outcome));
});

test('WA-10: X assist — a refused CreateTweet then the owner\'s second, successful click → submitted by the owner (the refusal does not hide it)', async () => {
  const time = clock();
  const { page, create } = xPage(time, { createBodies: [{ errors: [{ code: 131, message: 'Something went wrong.' }] }, { data: { create_tweet: { tweet_results: { result: { rest_id: '1999' } } } } }] });
  const ctx = context(page, 'x', time);
  const o = options(ctx, { mode: 'assist', ownerWaitUntil: time.now() + 30_000, onOwnerWait: async () => { create(); setImmediate(create); } });
  const outcome = await new XDriver().publish(ctx, xJob('everyone'), o);
  assert.deepEqual(outcome.kind === 'submitted' && [outcome.submitted_by, outcome.hint.external_post_id], ['owner', '1999'], JSON.stringify(outcome));
});

test('WA-10: X assist — the owner clicked and X refused → after_submit risk_prompt at the deadline, no discard, one screenshot', async () => {
  const time = clock();
  const { page, create } = xPage(time, { createBodies: [{ errors: [{ code: 226, message: 'This request looks like it might be automated.' }] }] });
  const ctx = context(page, 'x', time);
  const shots: string[] = [];
  ctx.evidence = async label => { shots.push(label); return `sha-${label}`; };
  const o = options(ctx, { mode: 'assist', ownerWaitUntil: time.now() + 20_000, onOwnerWait: async () => { create(); } });
  const outcome = await new XDriver().publish(ctx, xJob('everyone'), o);
  assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['risk_prompt', 'after_submit'], JSON.stringify(outcome));
  const escapes = page.calls.filter(call => call.method === 'press' && call.args?.[0] === 'Escape').length;
  assert.equal(escapes, 0, 'the draft is not discarded');
  assert.equal(shots.filter(label => label === 'blocker_risk_prompt').length, 1, 'no screenshot per poll');
});

test('WA-10: X auto — a later CreateTweet success after a refused one is the result (rest_id checked first)', async () => {
  const time = clock();
  const { page, post } = xPage(time, { createBodies: [{ errors: [{ code: 131, message: 'retry' }] }, { data: { create_tweet: { tweet_results: { result: { rest_id: '2001' } } } } }] });
  post.onClick = () => {
    page.responses.push({ url: 'https://x.com/i/api/graphql/abc/CreateTweet', status: 200, at: time.now(), body: JSON.stringify({ errors: [{ code: 131, message: 'retry' }] }) });
    page.responses.push({ url: 'https://x.com/i/api/graphql/abc/CreateTweet', status: 200, at: time.now(), body: JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '2001' } } } } }) });
  };
  const ctx = context(page, 'x', time);
  const outcome = await new XDriver().publish(ctx, xJob('everyone'), options(ctx));
  assert.deepEqual(outcome.kind === 'submitted' && outcome.hint.external_post_id, '2001', JSON.stringify(outcome));
});

test('WA-9: a platform error page before the click says nothing was posted and 「恢復」 retries; after the click it stays "maybe posted"', async () => {
  const context_ = { machine: 'Mac-B', channel: 'X @fixture_x', deadline: '09:30' };
  for (const phase of ['prepare', 'before_submit'] as const) {
    const message = blockerMessage('platform_error', context_, phase);
    assert.match(message, /這則還沒有發出/);
    assert.match(message, /「恢復」再試一次（截止 09:30）/);
    assert.doesNotMatch(message, /可能已經發出|貼上網址/);
  }
  assert.match(blockerMessage('platform_error', context_, 'after_submit'), /可能已經發出，也可能沒有.*系統不會自動重發/);
  assert.match(blockerMessage('platform_error', context_), /可能已經發出/, 'without a phase the conservative wording stays');
  // The X driver's compose step meets "Something went wrong" before any click.
  const time = clock();
  const page = new FakeCdpPage();
  page.onGoto = url => { page.url_ = url; };
  page.body = 'Something went wrong, but don’t fret — let’s give it another shot.';
  const prepared = await new XDriver().prepare(context(page, 'x', time), publishJob('x', clip));
  assert.deepEqual(!prepared.ok && [prepared.blocker.code, prepared.blocker.phase], ['platform_error', 'prepare']);
  assert.match(!prepared.ok ? prepared.blocker.message : '', /X @fixture_x 出現錯誤頁面，已停止，這則還沒有發出/);
});
