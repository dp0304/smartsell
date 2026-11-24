// Fixture TikTok Studio pages (§8.15): upload form with a Draft.js-style
// caption, hashtag suggestions, visibility combobox, checkboxes, disclosure,
// post button, continue dialog, content list and settings page.
import type { FixturePost, TikTokScenario } from './server.ts';

const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

interface Labels { select: string; uploaded: string; comment: string; reuse: string; who: string; everyone: string; friends: string; only: string; post: string; discard: string; showMore: string }
function labels(scenario: TikTokScenario): Labels {
  if (scenario === 'zh_hant') return { select: '選擇影片', uploaded: '已上傳', comment: '留言', reuse: '內容再利用', who: '誰可以觀看這部影片', everyone: '所有人', friends: '朋友', only: '只有你', post: '發佈', discard: '捨棄', showMore: '顯示更多' };
  return { select: 'Select video', uploaded: 'Uploaded', comment: 'Comment', reuse: 'Reuse of content', who: scenario === 'outdated' ? 'Audience' : 'Who can watch this video', everyone: 'Everyone', friends: 'Friends', only: 'Only you', post: scenario === 'outdated' ? 'Publish' : 'Post', discard: 'Discard', showMore: 'Show more' };
}

const shell = (title: string, body: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:sans-serif;margin:0;padding:0 12px 400px}header{padding:8px;border-bottom:1px solid #ccc}
[role=dialog]{position:fixed;top:60px;left:50%;transform:translateX(-50%);width:420px;background:#fff;border:1px solid #888;padding:16px;z-index:30}
.modal-cover{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:20}
#captcha_container{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:90}
[contenteditable]{min-height:60px;border:1px solid #aaa;padding:6px}
label.Checkbox__root{display:inline-block;margin:6px;padding:4px;border:1px solid #ccc}
button{padding:6px 12px;margin:4px}</style></head><body>${body}<script>${script}</script></body></html>`;

const pollScenario = `
async function scenarioNow() { try { return (await (await fetch('/__fixture/scenario?platform=tiktok')).json()).name; } catch { return null; } }`;

const captcha = `<div id="captcha_container"><div class="captcha_verify_container"><p>Drag the slider to fit the puzzle</p><div class="secsdk-captcha-drag-icon"></div></div></div>`;

function header(handle: string) {
  return `<header role="banner"><span>TikTok Studio</span> <span data-e2e="nav-profile"><span data-e2e="user-unique-id">@${esc(handle)}</span></span></header>`;
}

export function ttSettings(handle: string, userId: string, scenario: TikTokScenario) {
  return shell('Settings | TikTok Studio', `${header(handle)}<main data-e2e="account-information"><h1>Account information</h1>
<div>TikTok User ID: ${esc(userId)}</div><div>Username: @${esc(handle)}</div></main>${scenario === 'captcha' ? captcha : ''}`, `${pollScenario}
setInterval(async () => { const name = await scenarioNow(); if (name && name !== 'captcha') document.getElementById('captcha_container')?.remove(); }, 400);`);
}

/** The page inside iframe[data-tt="Upload_index_iframe"] of the older layout (legacy_iframe). */
export function ttLegacyFrame() {
  return shell('Upload', `<div class="upload-card"><input type="file" accept="video/*" id="legacy-file"><p>Select video to upload</p></div>`, `
document.getElementById('legacy-file').addEventListener('change', () => {
  fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'tiktok', event: 'legacy_upload_started' }) });
});`);
}

/** TikTok's cookie banner is a custom element with an open shadow root (cookie_banner). */
const cookieBanner = `<tiktok-cookie-banner></tiktok-cookie-banner><script>
customElements.define('tiktok-cookie-banner', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>.banner{position:fixed;left:0;right:0;bottom:0;height:45vh;z-index:80;background:#161823;color:#fff;padding:16px}</style>'
      + '<div class="banner" role="region" aria-label="Cookie banner"><p>We use cookies to improve your experience.</p>'
      + '<button id="decline">Decline optional cookies</button><button id="allow">Allow all</button></div>';
    const choose = event => { fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'tiktok', event }) }); this.remove(); };
    root.getElementById('decline').addEventListener('click', () => choose('cookies_essential_only'));
    root.getElementById('allow').addEventListener('click', () => choose('cookies_all'));
  }
});
</script>`;

export function ttUpload(handle: string, scenario: TikTokScenario, opts: { uploadMs: number; lastPrivacy: string }) {
  if (scenario === 'legacy_iframe') {
    return shell('Upload | TikTok Studio', `${header(handle)}<main><iframe data-tt="Upload_index_iframe" src="/tiktok/tiktokstudio/upload/legacy-frame"
  style="width:640px;height:360px;border:1px solid #ccc" title="Upload"></iframe></main>`);
  }
  const l = labels(scenario);
  const e2e = (id: string) => scenario === 'outdated' ? `data-e2e="${id}_v2"` : `data-e2e="${id}"`;
  const privacyText = { PUBLIC_TO_EVERYONE: l.everyone, MUTUAL_FOLLOW_FRIENDS: l.friends, SELF_ONLY: l.only }[opts.lastPrivacy] ?? l.everyone;
  const popups = scenario === 'popups' ? `<div class="modal-cover" id="cover"></div>
<div role="dialog" class="common-modal" id="pop1" aria-label="Content checks"><p>Turn on automatic content checks?</p>
  <div class="common-modal-footer"><button data-type="neutral" id="pop1-cancel">Cancel</button><button data-type="primary" id="pop1-on">Turn on</button></div></div>
<div role="dialog" id="pop2" aria-label="New editing features"><p>New editing features</p><button id="pop2-ok">Got it</button></div>
<div role="dialog" id="pop3" aria-label="Tour" class="react-joyride__tooltip"><p>Take a quick tour</p><button id="pop3-no">Not now</button></div>` : '';
  return shell('Upload | TikTok Studio', `${header(handle)}<main>
<div class="upload-text-container" id="picker"><input type="file" accept="video/*" id="file" style="display:none"><button id="select" aria-label="${esc(l.select)}">${esc(l.select)}</button></div>
<div data-e2e="upload_status_container" id="progress"></div>
<form id="form" hidden>
  <div class="caption-editor"><div contenteditable="true" role="combobox" aria-expanded="false" aria-label="Caption" class="public-DraftEditor-content" id="caption"></div></div>
  <div class="mention-list-popover" id="popover" hidden><span class="hash-tag-topic" id="suggestion"></span></div>
  <div ${e2e('video_visibility_container')}><span>${esc(l.who)}</span>
    <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(l.who)}" id="who">${esc(privacyText)}</button>
    <div role="listbox" id="options" hidden>
      <div role="option" data-value="PUBLIC_TO_EVERYONE">${esc(l.everyone)}</div><div role="option" data-value="MUTUAL_FOLLOW_FRIENDS">${esc(l.friends)}</div>
      <div role="option" data-value="SELF_ONLY">${esc(l.only)}</div></div></div>
  <p>Allow users to:</p>
  <label class="Checkbox__root" aria-checked="true" id="comment-label"><input type="checkbox" id="comment" checked>${esc(l.comment)}</label>
  <label class="Checkbox__root" aria-checked="true" id="reuse-label"><input type="checkbox" id="reuse" checked>${esc(l.reuse)}</label>
  <div data-e2e="advanced_settings_container"><button type="button" id="more">${esc(l.showMore)}</button>
    <div id="advanced" hidden>
      <div role="switch" tabindex="0" aria-checked="false" aria-label="Disclose post content" id="disclose">Disclose post content</div>
      <div id="disclose-options" hidden>
        <label class="Checkbox__root" aria-checked="false" id="brand-label"><input type="checkbox" id="brand">Your brand</label>
        <label class="Checkbox__root" aria-checked="false" id="branded-label"><input type="checkbox" id="branded">Branded content</label></div>
      <div role="switch" tabindex="0" aria-checked="false" aria-label="AI-generated content" id="ai">AI-generated content</div></div></div>
  <button type="button" ${e2e('post_video_button')} aria-disabled="true" data-disabled="true" id="post">${esc(l.post)}</button>
  <button type="button" id="discard">${esc(l.discard)}</button>
</form>
<div id="errors"></div>
</main>${popups}${scenario === 'captcha' ? captcha : ''}${scenario === 'cookie_banner' ? cookieBanner : ''}`, `${pollScenario}
const scenario = ${JSON.stringify(scenario)}, uploadMs = ${opts.uploadMs};
const file = document.getElementById('file'), form = document.getElementById('form'), caption = document.getElementById('caption');
if (scenario === 'text_rejected') {
  // The caption editor refuses program input (WA-5); deleting still works, so the box ends up empty.
  caption.addEventListener('beforeinput', event => { if (event.inputType.startsWith('insert')) event.preventDefault(); });
}
const post = document.getElementById('post'), progress = document.getElementById('progress'), popover = document.getElementById('popover');
let sha = null, uploaded = false, privacy = ${JSON.stringify(opts.lastPrivacy)}, posting = false;
function mark(label, input) { label.setAttribute('aria-checked', input.checked ? 'true' : 'false'); }
for (const [label, input] of [['comment-label','comment'],['reuse-label','reuse'],['brand-label','brand'],['branded-label','branded']]) {
  const box = document.getElementById(input); box.addEventListener('change', () => mark(document.getElementById(label), box));
}
function closePopup(id) { document.getElementById(id)?.remove(); if (!document.querySelector('[role=dialog][id^=pop]')) document.getElementById('cover')?.remove(); }
document.getElementById('pop1-cancel')?.addEventListener('click', () => closePopup('pop1'));
document.getElementById('pop1-on')?.addEventListener('click', () => { fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'tiktok', event: 'account_setting_changed' }) }); closePopup('pop1'); });
document.getElementById('pop2-ok')?.addEventListener('click', () => closePopup('pop2'));
document.getElementById('pop3-no')?.addEventListener('click', () => closePopup('pop3'));
document.getElementById('select').addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  const chosen = file.files[0]; if (!chosen) return;
  sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await chosen.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join('');
  document.getElementById('picker').hidden = true;
  form.hidden = false;
  caption.textContent = chosen.name.replace(/\\.[^.]+$/, '');
  const started = Date.now();
  await new Promise(done => { const tick = () => { const pct = Math.min(99, Math.floor((Date.now() - started) / uploadMs * 100));
    progress.textContent = 'Uploading ' + pct + '%'; if (Date.now() - started >= uploadMs) done(); else setTimeout(tick, 200); }; tick(); });
  progress.innerHTML = ${JSON.stringify(esc(l.uploaded))} + ' <div class="resolution-label-text">1080p</div>';
  uploaded = true;
  post.setAttribute('aria-disabled', 'false'); post.setAttribute('data-disabled', 'false');
});
caption.addEventListener('input', () => {
  const words = caption.innerText.split(/\\s/); const last = words[words.length - 1] || '';
  if (/^#[\\p{L}\\p{N}_]+$/u.test(last)) { document.getElementById('suggestion').textContent = last; popover.hidden = false; }
  else popover.hidden = true;
});
const who = document.getElementById('who'), options = document.getElementById('options');
who.addEventListener('click', () => { options.hidden = !options.hidden; who.setAttribute('aria-expanded', String(!options.hidden)); });
for (const option of options.querySelectorAll('[role=option]')) option.addEventListener('click', () => {
  privacy = option.dataset.value; who.textContent = option.textContent; options.hidden = true; who.setAttribute('aria-expanded', 'false'); });
document.getElementById('more').addEventListener('click', () => { document.getElementById('advanced').hidden = false; });
for (const id of ['disclose', 'ai']) {
  const sw = document.getElementById(id);
  sw.addEventListener('click', () => {
    if (id === 'ai' && sw.getAttribute('aria-checked') === 'false') {
      const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', 'AI-generated content');
      dialog.innerHTML = '<p>Label AI-generated content?</p><button id="ai-later">Not now</button><button id="ai-on">Turn on</button>';
      document.body.append(dialog);
      dialog.querySelector('#ai-on').addEventListener('click', () => { sw.setAttribute('aria-checked', 'true'); dialog.remove(); });
      dialog.querySelector('#ai-later').addEventListener('click', () => dialog.remove());
      return;
    }
    const on = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(on));
    if (id === 'disclose') document.getElementById('disclose-options').hidden = !on;
  });
}
async function submit() {
  if (posting) return; posting = true;
  const body = { caption: caption.innerText, media_sha256: sha, privacy_level: privacy, allow_comment: document.getElementById('comment').checked,
    allow_reuse: document.getElementById('reuse').checked, brand: document.getElementById('brand').checked, branded: document.getElementById('branded').checked,
    ai_generated: document.getElementById('ai').getAttribute('aria-checked') === 'true' };
  const reply = await (await fetch('/tiktok/tiktok/web/project/post/v1/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (reply.status_code === 0) {
    if (reply.navigate) location.href = '/tiktok/tiktokstudio/content';
    return;
  }
  posting = false;
  const error = document.createElement('div'); error.setAttribute('role', 'alert');
  error.textContent = 'Something went wrong. You can try again or replace it with a different video.';
  document.getElementById('errors').append(error);
}
function clickPost() {
  if (post.getAttribute('aria-disabled') === 'true') return;
  if (scenario === 'challenge_after_post') {
    // A captcha instead of the publish request; it is never solved in the fixture, so nothing is created.
    fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'tiktok', event: 'post_clicked' }) });
    document.body.insertAdjacentHTML('beforeend', '<div class="captcha-verify-container" id="captcha-after" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:90"><p>Select 2 objects that are the same shape</p></div>');
    return;
  }
  if (scenario === 'continue_dialog') {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.id = 'continue';
    dialog.innerHTML = '<p>Continue to post?</p><p>Content check lite is still running.</p><button id="continue-cancel">Cancel</button><button id="continue-now">Post now</button>';
    document.body.append(dialog);
    dialog.querySelector('#continue-now').addEventListener('click', () => { dialog.remove(); submit(); });
    dialog.querySelector('#continue-cancel').addEventListener('click', () => dialog.remove());
    fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'tiktok', event: 'post_clicked' }) });
    return;
  }
  fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'tiktok', event: 'post_clicked' }) });
  submit();
}
post.addEventListener('click', clickPost);
document.getElementById('discard').addEventListener('click', () => {
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.id = 'discard-dialog';
  dialog.innerHTML = '<p>Discard this post?</p><button id="discard-yes">${esc(l.discard)}</button><button id="discard-no">Keep editing</button>';
  document.body.append(dialog);
  dialog.querySelector('#discard-yes').addEventListener('click', () => { dialog.remove(); form.hidden = true; document.getElementById('picker').hidden = false; sha = null; uploaded = false;
    progress.textContent = ''; fetch('/__fixture/event', { method: 'POST', body: JSON.stringify({ platform: 'tiktok', event: 'discarded' }) }); });
  dialog.querySelector('#discard-no').addEventListener('click', () => dialog.remove());
});
setInterval(async () => {
  const name = await scenarioNow();
  if (name && name !== 'captcha') document.getElementById('captcha_container')?.remove();
  try {
    const owner = await (await fetch('/__fixture/owner-click?platform=tiktok')).json();
    if (owner.pending) { clickPost(); setTimeout(() => document.getElementById('continue-now')?.click(), 300); }
  } catch {}
}, 400);`);
}

export function ttContent(handle: string, posts: FixturePost[], options: { times?: boolean } = {}) {
  // The real Studio list shows a human date; `times: false` renders rows without a machine-readable <time> (WA-1).
  const when = (post: FixturePost) => options.times === false ? `<span class="date">${esc(new Date(post.created_at).toDateString())}</span>`
    : `<time datetime="${post.created_at}">${post.created_at}</time>`;
  const rows = posts.map(post => `<div data-tt="components_PostInfoCell_Container" class="row">
  <a href="/@${esc(post.author)}/video/${post.id}">${esc(post.text) || '(no caption)'}</a>
  <span class="status">Processing · Only me</span> ${when(post)}</div>`).join('');
  return shell('Posts | TikTok Studio', `${header(handle)}<main><h1>Posts</h1><div data-tt="components_PostTable_Container">${rows || '<p class="empty">No content yet</p>'}</div></main>`);
}

export function ttLogin(next: string, verify: boolean) {
  return shell(verify ? 'Verify | TikTok' : 'Log in | TikTok', `<main><h1>${verify ? 'Enter 6-digit code' : 'Log in to TikTok'}</h1>${verify ? '<p>Two-step verification</p><input name="code">' : '<button>Use phone / email / username</button>'}</main>`,
    `${pollScenario}
setInterval(async () => { const name = await scenarioNow(); if (name && name !== ${JSON.stringify(verify ? 'two_factor' : 'login_expired')}) location.href = ${JSON.stringify(next)}; }, 400);`);
}
