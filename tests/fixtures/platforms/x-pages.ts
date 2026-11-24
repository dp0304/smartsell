// Fixture X pages (§8.15). They mimic the structure the X driver relies on
// (data-testid, roles, toast, upload.json and CreateTweet responses). They are
// served from 127.0.0.1 only and contact nothing else.
import type { FixturePost, XScenario } from './server.ts';

const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** "Who can reply" (E40): the control's label per setting, and the menu items. */
type ReplyValue = 'everyone' | 'following' | 'verified' | 'mentioned';
export interface XReplyLabels { control: Record<ReplyValue, string>; items: Record<ReplyValue, string> }
export interface XLabels { textbox: string; post: string; toast: string; profile: string; discard: string; reply: XReplyLabels }
const replyEn: XReplyLabels = {
  control: { everyone: 'Everyone can reply', following: 'Accounts you follow can reply', verified: 'Verified accounts can reply', mentioned: 'Only accounts you mention can reply' },
  items: { everyone: 'Everyone', following: 'Accounts you follow', verified: 'Verified accounts', mentioned: 'Only accounts you mention' },
};
const replyZhHant: XReplyLabels = {
  control: { everyone: '所有人都可以回覆', following: '你跟隨的帳號可以回覆', verified: '已認證帳號可以回覆', mentioned: '只有你提及的帳號可以回覆' },
  items: { everyone: '所有人', following: '你跟隨的帳號', verified: '已認證的帳號', mentioned: '只有你提及的帳號' },
};
export function xLabels(scenario: XScenario): XLabels {
  if (scenario === 'zh_hant') return { textbox: '貼文文字', post: '發佈', toast: '你的貼文已傳送。', profile: '個人資料', discard: '捨棄', reply: replyZhHant };
  if (scenario === 'outdated') return { textbox: 'Compose something', post: 'Send', toast: 'Sent.', profile: 'Me', discard: 'Throw away', reply: replyEn };
  return { textbox: 'Post text', post: 'Post', toast: 'Your post was sent.', profile: 'Profile', discard: 'Discard', reply: replyEn };
}

const shell = (title: string, body: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:sans-serif;margin:0}header{padding:8px;border-bottom:1px solid #ccc}main{padding:12px}
[role=dialog]{position:fixed;top:40px;left:50%;transform:translateX(-50%);width:560px;max-height:calc(100vh - 60px);overflow-y:auto;background:#fff;border:1px solid #888;padding:16px;z-index:10}
#attachments video,#attachments img{max-width:160px;max-height:180px}
[data-testid=tweetTextarea_0],[role=textbox]{min-height:80px;border:1px solid #aaa;padding:6px;white-space:pre-wrap}
button{padding:6px 12px;margin:4px}.overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:50}
.overlay iframe{width:300px;height:200px;margin:80px auto;display:block;background:#fff}
.grok{position:fixed;inset:0;z-index:40;background:rgba(255,255,255,.97);padding:24px}
[data-testid=toast]{position:fixed;bottom:16px;left:16px;background:#1d9bf0;color:#fff;padding:8px;z-index:60}
article{border-bottom:1px solid #eee;padding:8px}</style></head><body>${body}<script>${script}</script></body></html>`;

const pollScenario = `
async function scenarioNow() { try { return (await (await fetch('/__fixture/scenario?platform=x')).json()).name; } catch { return null; } }`;

function nav(handle: string, scenario: XScenario, labels: XLabels) {
  const testid = scenario === 'outdated' ? '' : ' data-testid="AppTabBar_Profile_Link"';
  return `<header role="banner"><nav aria-label="Primary"><a${scenario === 'outdated' ? '' : ' data-testid="AppTabBar_Home_Link"'} href="/home">Home</a>
<a${testid} href="/${handle}" aria-label="${esc(labels.profile)}">${esc(labels.profile)}</a></nav></header>`;
}

const captchaOverlay = `<div class="overlay" id="arkose-overlay"><iframe id="arkose_iframe" title="Verification" src="/x/__challenge/arkoselabs.com/fc"></iframe></div>`;

export function xHome(handle: string, scenario: XScenario) {
  const labels = xLabels(scenario);
  return shell('Home / X', `${nav(handle, scenario, labels)}<main><h1>Home</h1><p>Fixture timeline</p></main>${scenario === 'captcha' ? captchaOverlay : ''}`,
    `${pollScenario}
setInterval(async () => { const name = await scenarioNow(); if (name && name !== 'captcha') document.getElementById('arkose-overlay')?.remove(); }, 400);`);
}

export function xCompose(handle: string, scenario: XScenario) {
  const labels = xLabels(scenario);
  const t = (id: string) => scenario === 'outdated' ? '' : ` data-testid="${id}"`;
  return shell('Compose / X', `${nav(handle, scenario, labels)}<main><h1>Home</h1></main>
<div role="dialog" aria-modal="true" aria-label="Compose" id="composer"${scenario === 'post_offscreen' ? ' style="max-height:none;overflow:visible"' : ''}>
  <div${t('tweetTextarea_0')} role="textbox" contenteditable="true" aria-multiline="true" aria-label="${esc(labels.textbox)}" id="text"></div>
  <input type="file"${t('fileInput')} accept="image/*,video/*" id="file" style="display:none">
  <div${t('attachments')} id="attachments"></div>
  <div id="status" aria-live="polite"></div>
  ${scenario === 'reply_control_missing' ? '' : `<div role="button" tabindex="0" aria-haspopup="menu" id="reply-control">${esc(labels.reply.control.everyone)}</div>
  <div${t('Dropdown')} role="menu" id="reply-menu" hidden>${(['everyone', 'following', 'verified', 'mentioned'] as const)
    .map(value => `<div role="menuitem" tabindex="0" data-value="${value}">${esc(labels.reply.items[value])}</div>`).join('')}</div>`}
  ${scenario === 'post_offscreen' ? '<div aria-hidden="true" style="height:2400px"></div>' : ''}
  <button${t('tweetButton')} role="button" aria-disabled="true" id="post">${esc(labels.post)}</button>
  <button${t('app-bar-close')} aria-label="Close" id="close">×</button>
</div>
<div role="dialog" id="sheet" hidden aria-label="Discard post?"><p>Discard post?</p>
  <button${t('confirmationSheetConfirm')} id="discard">${esc(labels.discard)}</button><button${t('confirmationSheetCancel')} id="keep">Cancel</button></div>
<div id="alerts"></div>${scenario === 'captcha' ? captchaOverlay : ''}
${scenario === 'grok_overlay' ? '<aside id="grok-drawer" class="grok" aria-label="Grok"><h2>Grok</h2><p>Ask anything</p></aside>' : ''}`, `${pollScenario}
const scenario = ${JSON.stringify(scenario)};
const grok = document.getElementById('grok-drawer');
if (grok) {
  // Like X's side panel: it sits above the composer and Escape closes only the panel.
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !document.getElementById('grok-drawer')) return;
    event.stopImmediatePropagation();
    document.getElementById('grok-drawer').remove();
    fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'x', event: 'grok_closed' }) });
  }, true);
}
const text = document.getElementById('text'), file = document.getElementById('file'), post = document.getElementById('post');
const attachments = document.getElementById('attachments'), sheet = document.getElementById('sheet');
let mediaSha = null, mediaReady = false, uploading = false, submitting = false, replySettings = 'everyone';
const replyControl = document.getElementById('reply-control'), replyMenu = document.getElementById('reply-menu');
const replyLabels = ${JSON.stringify(labels.reply.control)};
replyControl?.addEventListener('click', () => { replyMenu.hidden = !replyMenu.hidden; });
for (const item of replyMenu?.querySelectorAll('[role=menuitem]') ?? []) item.addEventListener('click', () => {
  replySettings = item.dataset.value; replyControl.textContent = replyLabels[replySettings]; replyMenu.hidden = true;
});
function refresh() {
  const hasText = text.innerText.trim().length > 0;
  const enabled = !uploading && !submitting && (mediaReady || (hasText && !mediaSha));
  post.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}
if (scenario === 'text_rejected') {
  text.addEventListener('beforeinput', event => { if (event.inputType.startsWith('insert')) event.preventDefault(); });
}
text.addEventListener('input', refresh);
file.addEventListener('change', async () => {
  const chosen = file.files[0];
  if (!chosen) return;
  uploading = true; mediaReady = false; refresh();
  const preview = document.createElement('video');
  preview.src = URL.createObjectURL(chosen); preview.muted = true; preview.width = 160;
  attachments.replaceChildren(preview);
  const remove = document.createElement('button'); remove.setAttribute('aria-label', 'Remove media'); remove.textContent = '×';
  attachments.append(remove);
  mediaSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await chosen.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join('');
  const init = await (await fetch('/x/i/media/upload.json?command=INIT', { method: 'POST', body: JSON.stringify({ bytes: chosen.size, sha256: mediaSha }) })).json();
  let info = (await (await fetch('/x/i/media/upload.json?command=FINALIZE&media_id=' + init.media_id_string, { method: 'POST' })).json()).processing_info;
  while (info && info.state !== 'succeeded' && info.state !== 'failed') {
    await new Promise(done => setTimeout(done, 500));
    info = (await (await fetch('/x/i/media/upload.json?command=STATUS&media_id=' + init.media_id_string)).json()).processing_info;
  }
  uploading = false; mediaReady = !info || info.state === 'succeeded';
  document.getElementById('status').textContent = mediaReady ? 'Media ready' : 'Media failed';
  refresh();
});
async function submit() {
  if (post.getAttribute('aria-disabled') === 'true' || submitting) return;
  submitting = true; refresh();
  fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'x', event: 'post_clicked' }) });
  if (scenario === 'challenge_after_post') {
    // A challenge instead of a result: nothing is created until the owner solves it (the fixture never resolves it).
    document.body.insertAdjacentHTML('beforeend', '<div class="overlay" id="arkose-after"><iframe title="Verification" src="/x/__challenge/arkoselabs.com/fc"></iframe></div>');
    return;
  }
  const response = await fetch('/x/i/api/graphql/abc/CreateTweet', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: text.innerText, media_sha256: mediaSha, reply_settings: replySettings }) });
  const body = await response.json();
  submitting = false;
  if (body.errors) {
    const alert = document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = body.errors[0].message;
    document.getElementById('alerts').append(alert); refresh(); return;
  }
  text.textContent = ''; attachments.replaceChildren(); mediaSha = null; mediaReady = false; refresh();
  const id = body.data?.create_tweet?.tweet_results?.result?.rest_id;
  document.getElementById('composer').hidden = true;
  if (id && body.toast !== false) {
    const toast = document.createElement('div');
    if (scenario !== 'outdated') toast.setAttribute('data-testid', 'toast');
    toast.setAttribute('role', 'alert');
    toast.innerHTML = ${JSON.stringify(esc(labels.toast))} + ' <a href="/${handle}/status/' + id + '">View</a>';
    document.body.append(toast);
  }
}
post.addEventListener('click', submit);
function hasDraft() { return text.innerText.trim().length > 0 || !!mediaSha; }
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (hasDraft()) sheet.hidden = false; else document.getElementById('composer').hidden = true;
});
document.getElementById('close').addEventListener('click', () => { if (hasDraft()) sheet.hidden = false; else document.getElementById('composer').hidden = true; });
document.getElementById('discard').addEventListener('click', () => {
  text.textContent = ''; attachments.replaceChildren(); mediaSha = null; mediaReady = false; sheet.hidden = true;
  document.getElementById('composer').hidden = true; fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'x', event: 'discarded' }) });
});
document.getElementById('keep').addEventListener('click', () => { sheet.hidden = true; });
setInterval(async () => {
  const name = await scenarioNow();
  if (name && name !== 'captcha') document.getElementById('arkose-overlay')?.remove();
  try {
    const owner = await (await fetch('/__fixture/owner-click?platform=x')).json();
    if (owner.pending) submit();
  } catch {}
}, 400);
refresh();`);
}

export function xLogin(next: string) {
  return shell('Log in to X / X', `<main><h1>Sign in to X</h1><form role="form"><label>Phone, email, or username<input name="text" autocomplete="username"></label>
<button type="button" data-testid="loginButton">Next</button></form></main>`, `${pollScenario}
setInterval(async () => { const name = await scenarioNow(); if (name && name !== 'login_expired') location.href = ${JSON.stringify(next)}; }, 400);`);
}

export function xTwoFactor(next: string) {
  return shell('Verification / X', `<main><h1>Enter your verification code</h1><p>We sent a verification code to your phone.</p><input name="code"></main>`,
    `${pollScenario}
setInterval(async () => { const name = await scenarioNow(); if (name && name !== 'two_factor') location.href = ${JSON.stringify(next)}; }, 400);`);
}

function article(post: FixturePost, pinned = false) {
  return `<article data-testid="tweet">${pinned ? '<div data-testid="socialContext">Pinned</div>' : ''}
<div data-testid="User-Name"><a href="/${post.author}">Fixture ${esc(post.author)}</a> <span>@${esc(post.author)}</span></div>
<div data-testid="tweetText" lang="en">${esc(post.text)}</div>
<a href="/${post.author}/status/${post.id}"><time datetime="${post.created_at}">${post.created_at}</time></a></article>`;
}

export function xProfile(handle: string, viewer: string, posts: FixturePost[], scenario: XScenario) {
  const labels = xLabels(scenario);
  const pinned: FixturePost = { platform: 'x', id: '1000000000000000001', author: handle, text: 'Pinned welcome post', media_sha256: null, created_at: '2026-01-01T00:00:00.000Z', job_hint: null };
  return shell(`${handle} / X`, `${nav(viewer, scenario, labels)}<main><h1>@${esc(handle)}</h1>${article(pinned, true)}${posts.map(post => article(post)).join('')}</main>`);
}

export function xStatus(viewer: string, post: FixturePost, scenario: XScenario) {
  return shell(`${post.author} on X`, `${nav(viewer, scenario, xLabels(scenario))}<main>${article(post)}</main>`);
}

export function xError() {
  return shell('X', `<main><h1>Something went wrong, but don’t fret — let’s give it another shot.</h1></main>`);
}
