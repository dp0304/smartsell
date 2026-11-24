import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeNotClickable } from '../../apps/connector-desktop/src/drivers/cdp-page.ts';
import { defaultSelectors } from '../../apps/connector-desktop/src/drivers/selectors.ts';
import { TikTokDriver } from '../../apps/connector-desktop/src/drivers/tiktok.ts';
import type { DriverBlocker, DriverContext, PublishOptions } from '../../apps/connector-desktop/src/drivers/types.ts';
import { XDriver } from '../../apps/connector-desktop/src/drivers/x.ts';
import { FakeCdpPage, type FakeNode } from './fakes/fake-cdp-page.ts';
import { publishJob } from './fakes/driver-harness.ts';

const table = defaultSelectors();
const css = (provider: 'x' | 'tiktok', step: string, index = 0) => table[provider].steps[step].primary[index].css!;

function context(page: FakeCdpPage, provider: 'x' | 'tiktok'): DriverContext {
  return {
    page, platformUrl: path => `http://127.0.0.1:9/${provider}${path}`, expectedIdentity: provider === 'x' ? 'fixture_x' : '7234567890123456789',
    signal: new AbortController().signal, evidence: async label => `sha-${label}`, log: () => {}, now: () => Date.now(),
    sleep: ms => new Promise(done => setTimeout(done, Math.min(ms, 20))), selectors: table, mediaPaths: ['/tmp/video.mp4'], blockerPollMs: 20, trace: [],
    messages: { machine: 'Mac-B', channel: provider === 'x' ? 'X @fixture_x' : 'TikTok @fixture_tt', deadline: '09:30' },
  };
}

function options(overrides: Partial<PublishOptions> = {}): PublishOptions & { beforeClick: number; ownerWaits: DriverBlocker[] } {
  const state = { beforeClick: 0, ownerWaits: [] as DriverBlocker[] };
  return Object.assign(state, {
    dryRun: false, mode: 'auto' as const, revoked: () => false, ownerWaitUntil: Date.now() + 60_000,
    onBeforeClick: async () => { state.beforeClick += 1; return true; },
    onOwnerWait: async (blocker: DriverBlocker) => { state.ownerWaits.push(blocker); },
    ...overrides,
  });
}

/** Fake X compose dialog with the testids the driver uses. */
function xPage(behaviour: { createBody?: object; rejectText?: boolean } = {}) {
  const page = new FakeCdpPage();
  let post!: FakeNode;
  page.onGoto = url => { page.url_ = url; };
  page.url_ = 'http://127.0.0.1:9/x/compose/post';
  const box = page.add({ css: [css('x', 'x.ready'), css('x', 'x.textbox')], role: 'textbox', name: 'Post text', text: '' });
  page.add({ css: [css('x', 'x.identity')], attrs: { href: '/fixture_x' } });
  if (behaviour.rejectText) page.onInsert = () => {};
  page.add({ css: [css('x', 'x.file_input')], visible: false, onFiles: () => {
    page.add({ css: [css('x', 'x.attached')] });
    page.responses.push({ url: 'https://upload.x.com/i/media/upload.json?command=FINALIZE', status: 200, body: JSON.stringify({ processing_info: { state: 'pending' } }), at: Date.now() });
    page.responses.push({ url: 'https://upload.x.com/i/media/upload.json?command=STATUS', status: 200, body: JSON.stringify({ processing_info: { state: 'succeeded' } }), at: Date.now() });
  } });
  post = page.add({ css: [css('x', 'x.post_button')], role: 'button', name: 'Post', attrs: { 'aria-disabled': 'false' }, onClick: () => {
    page.responses.push({ url: 'https://x.com/i/api/graphql/abc/CreateTweet', status: 200, at: Date.now(),
      body: JSON.stringify(behaviour.createBody ?? { data: { create_tweet: { tweet_results: { result: { rest_id: '1861' } } } } }) });
    if (!behaviour.createBody) page.add({ css: [css('x', 'x.toast')], attrs: { href: '/fixture_x/status/1861' } });
  } });
  page.onPress = key => { if (key === 'Escape') page.add({ css: [css('x', 'x.discard')], role: 'button', name: 'Discard' }); else if (key === 'Enter') box.text += '\n'; };
  return { page, box, post: () => post };
}

test('X: media is attached before text, text is typed line by line, and Post is clicked exactly once', async () => {
  const { page, post } = xPage();
  const job = publishJob('x', { sha256: 'a'.repeat(64), bytes: 1000 }, { caption: { text: 'Line one\nLine two #lure', title: null } });
  const opts = options();
  const outcome = await new XDriver().publish(context(page, 'x'), job, opts);
  assert.equal(outcome.kind, 'submitted');
  assert.deepEqual(outcome.kind === 'submitted' && outcome.hint, { external_post_id: '1861', url: 'https://x.com/fixture_x/status/1861' });
  assert.equal(page.count('click', post().id), 1);
  assert.equal(opts.beforeClick, 1);
  const order = page.calls.map(call => call.method);
  assert.ok(order.indexOf('setFiles') < order.indexOf('insertText'), 'media before text');
  assert.deepEqual(page.calls.filter(call => call.method === 'insertText').map(call => call.args?.[0]), ['Line one', 'Line two #lure']);
});

test('X: onBeforeClick false (revoked) means zero Post clicks and the draft is discarded', async () => {
  const { page, post } = xPage();
  const outcome = await new XDriver().publish(context(page, 'x'), publishJob('x', { sha256: 'a'.repeat(64), bytes: 1000 }), options({ onBeforeClick: async () => false }));
  assert.deepEqual(outcome, { kind: 'aborted' });
  assert.equal(page.count('click', post().id), 0);
  assert.ok(page.calls.some(call => call.method === 'press' && call.args?.[0] === 'Escape'));
  assert.equal(page.count('click', page.nodes.find(node => node.css?.includes(css('x', 'x.discard')))!.id), 1);
});

test('X: CreateTweet error 226 after the click is a risk_prompt after submit, with no second click', async () => {
  const { page, post } = xPage({ createBody: { errors: [{ code: 226, message: 'This request looks like it might be automated.' }] } });
  const outcome = await new XDriver().publish(context(page, 'x'), publishJob('x', { sha256: 'a'.repeat(64), bytes: 1000 }), options());
  assert.equal(outcome.kind, 'blocked');
  assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['risk_prompt', 'after_submit']);
  assert.equal(page.count('click', post().id), 1);
});

test('X: a click that fails after onBeforeClick is never retried and is reported conservatively', async () => {
  const { page, post } = xPage();
  const original = page.click.bind(page);
  let attempts = 0;
  page.click = async node => { if (node.backendNodeId === post().id) { attempts += 1; throw new NodeNotClickable('detached'); } return original(node); };
  const outcome = await new XDriver().publish(context(page, 'x'), publishJob('x', { sha256: 'a'.repeat(64), bytes: 1000 }), options());
  assert.equal(attempts, 1);
  assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['platform_error', 'after_submit']);
});

test('X: rejected text gets the one documented correction, then is handed to the owner without any click', async () => {
  const { page, post } = xPage({ rejectText: true });
  const opts = options({ ownerWaitUntil: Date.now() + 120 });
  const outcome = await new XDriver().publish(context(page, 'x'), publishJob('x', { sha256: 'a'.repeat(64), bytes: 1000 }), opts);
  const keys = page.calls.filter(call => call.method === 'press').map(call => call.args?.[0]);
  assert.deepEqual(keys.slice(0, 3), ['End', ' ', 'Backspace']);
  assert.equal(opts.ownerWaits[0]?.code, 'caption_rejected');
  assert.match(opts.ownerWaits[0].message, /頁面已填好，請到 Mac-B 檢查後自己按發布/);
  assert.equal(outcome.kind === 'blocked' && outcome.blocker.code, 'caption_rejected');
  assert.equal(page.count('click', post().id), 0);
  assert.equal(opts.beforeClick, 0);
});

test('X: dry run stops before the click and discards', async () => {
  const { page, post } = xPage();
  const opts = options({ dryRun: true });
  const outcome = await new XDriver().publish(context(page, 'x'), publishJob('x', { sha256: 'a'.repeat(64), bytes: 1000 }), opts);
  assert.equal(outcome.kind, 'dry_run_done');
  assert.equal(page.count('click', post().id), 0);
  assert.equal(opts.beforeClick, 0);
});

/** Fake TikTok Studio upload form. */
function tiktokPage(postResponse: object, continueDialog = false) {
  const page = new FakeCdpPage();
  page.url_ = 'http://127.0.0.1:9/tiktok/tiktokstudio/upload?from=upload';
  page.onGoto = url => { page.url_ = url; };
  // WA-1: publish first reads the Studio content list; this account has no videos yet.
  page.add({ css: ['body'], text: 'No content yet' });
  page.add({ css: [css('tiktok', 'tt.ready'), css('tiktok', 'tt.file_input')], visible: false, onFiles: () => {
    page.add({ css: [css('tiktok', 'tt.uploaded')] });
  } });
  const caption = page.add({ css: [css('tiktok', 'tt.caption')], text: 'video' });
  page.add({ css: [css('tiktok', 'tt.mention_popover')] });
  const who = page.add({ css: [css('tiktok', 'tt.visibility')], text: 'Everyone', onClick: () => {
    for (const name of ['Everyone', 'Friends', 'Only you']) page.add({ role: 'option', name, onClick: () => { who.text = name; } });
  } });
  const toggle = (label: string, checked: boolean) => {
    const node = page.add({ css: ['label.Checkbox__root'], text: label, attrs: { 'aria-checked': String(checked) } });
    node.onClick = () => { node.attrs = { ...node.attrs, 'aria-checked': node.attrs!['aria-checked'] === 'true' ? 'false' : 'true' }; };
  };
  toggle('Comment', false);
  toggle('Reuse of content', true);
  let posted = 0;
  const submit = () => {
    posted += 1;
    page.responses.push({ url: 'https://www.tiktok.com/tiktok/web/project/post/v1/', status: 200, body: JSON.stringify(postResponse), at: Date.now() });
  };
  const post = page.add({ css: [css('tiktok', 'tt.post_button')], attrs: { 'aria-disabled': 'false' }, onClick: () => {
    if (!continueDialog) { submit(); return; }
    const dialog = page.add({ css: ['[role="dialog"]'], text: 'Continue to post? Content check lite is still running.' });
    page.add({ role: 'button', name: 'Post now', parent: dialog.id, onClick: () => { page.remove(node => node.id === dialog.id); submit(); } });
  } });
  void caption;
  return { page, post, posted: () => posted, who };
}

test('TikTok: privacy is set explicitly, "Continue to post?" is confirmed, and Post is clicked exactly once', async () => {
  const { page, post, posted, who } = tiktokPage({ status_code: 0 }, true);
  const job = publishJob('tiktok', { sha256: 'a'.repeat(64), bytes: 1000 });
  const opts = options();
  const outcome = await new TikTokDriver().publish(context(page, 'tiktok'), job, opts);
  assert.equal(outcome.kind, 'submitted');
  assert.equal(page.count('click', post.id), 1);
  assert.equal(posted(), 1);
  assert.equal(who.text, 'Only you', 'SELF_ONLY chosen explicitly although the form showed Everyone');
  const comment = page.nodes.find(node => node.text === 'Comment')!;
  assert.equal(comment.attrs?.['aria-checked'], 'true');
  const reuse = page.nodes.find(node => node.text === 'Reuse of content')!;
  assert.equal(reuse.attrs?.['aria-checked'], 'false');
  assert.ok(page.calls.some(call => call.method === 'typeChars' && call.args?.[0] === '#fishing'), 'hashtags typed slowly');
});

test('TikTok: code 7 (Permission Denied) after Post stops as platform_error after submit; no retry', async () => {
  const { page, post, posted } = tiktokPage({ code: 7, message: 'Permission Denied' });
  const outcome = await new TikTokDriver().publish(context(page, 'tiktok'), publishJob('tiktok', { sha256: 'a'.repeat(64), bytes: 1000 }), options());
  assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['platform_error', 'after_submit']);
  assert.match(outcome.kind === 'blocked' ? outcome.blocker.message : '', /系統不會自動重發/);
  assert.equal(page.count('click', post.id), 1);
  assert.equal(posted(), 1);
});
