const preferenceKey = 'public-locale';
const localized = {
  "語言": ["语言", "Language"],
  "載入中…": ["加载中…", "Loading…"],
  "電子郵件": ["电子邮件", "Email"],
  "簡訊": ["短信", "Text message"],
  "已收到您的請求": ["已收到您的请求", "Request received"],
  "謝謝，您的請求已送出。": ["谢谢，您的请求已提交。", "Thank you. Your request has been submitted."],
  "請至少填寫電子郵件或電話。": ["请至少填写电子邮箱或电话号码。", "Enter an email address or phone number."],
  "姓名（選填）": ["姓名（选填）", "Name (optional)"],
  "電話（含國碼，例如 +12025550123）": ["电话号码（含国家或地区代码，例如 +12025550123）", "Phone number (with country code, for example +12025550123)"],
  "留言（選填）": ["留言（选填）", "Message (optional)"],
  "服務聯絡": ["服务联系", "Service contact"],
  "允許服務聯絡": ["允许服务联系", "Allow service contact"],
  "行銷訂閱（選填）": ["营销订阅（选填）", "Marketing subscriptions (optional)"],
  "送出資料": ["提交信息", "Submit"],
  "請填寫電子郵件或電話。": ["请填写电子邮箱或电话号码。", "Enter an email address or phone number."],
  "請填寫已勾選聯絡渠道所需的資料。": ["请填写所选联系方式需要的信息。", "Enter the contact information required for the selected channel."],
  "頁面可能已更新。請重新載入並確認最新同意文字。": ["页面可能已更新。请重新加载页面并确认最新的同意条款。", "This page may have changed. Reload it and review the latest consent wording."],
  "送出次數過多，請稍後再試。": ["提交次数过多，请稍后再试。", "Too many attempts. Try again later."],
  "目前無法送出，請確認資料後再試。": ["暂时无法提交，请检查填写的信息后重试。", "Check the information you entered and try again."],
  "服務暫時無法使用，請稍後重試。": ["服务暂时不可用，请稍后重试。", "The service is temporarily unavailable. Try again later."],
  "無法使用此連結": ["无法使用此链接", "Link unavailable"],
  "請開啟原始郵件中的取消訂閱連結。": ["请打开原始邮件中的退订链接。", "Open the unsubscribe link in the original email."],
  "確認取消訂閱": ["确认退订", "Confirm unsubscribe"],
  "目前無法送出取消訂閱請求，請稍後再試。": ["暂时无法提交退订请求，请稍后重试。", "We couldn’t submit your unsubscribe request. Try again later."],
  "取消訂閱": ["退订", "Unsubscribe"],
  "確認後，我們會送出這個連結所對應的取消訂閱請求。": ["确认后，我们将提交此链接对应的退订请求。", "Confirm to submit the unsubscribe request associated with this link."],
  "找不到此頁面": ["找不到此页面", "Page not found"],
  "這個連結可能已失效，請向提供者索取最新連結。": ["此链接可能已失效，请联系提供方获取新链接。", "This link may have expired. Ask the sender for a new one."],
  "重新載入": ["重新加载", "Reload"],
  "暫時無法載入": ["暂时无法加载", "Temporarily unavailable"],
  "請稍後重試。": ["请稍后重试。", "Try again later."],
  "請開啟活動或郵件中提供的完整連結。": ["请打开活动页面或邮件中提供的完整链接。", "Open the full link provided in the campaign or email."],
};

const languagePicker = document.querySelector('#language');
const translations = new WeakMap();
let pageTitle;

function supportedLocale(tag) {
  if (!tag) return;
  try {
    const { language, script, region } = new Intl.Locale(tag.trim().replaceAll('_', '-'));
    if (language === 'en') return 'en';
    if (language !== 'zh') return;
    if (script) return script === 'Hans' ? 'zh-Hans' : script === 'Hant' ? 'zh-Hant' : undefined;
    return ['TW', 'HK', 'MO'].includes(region) ? 'zh-Hant' : 'zh-Hans';
  } catch {
    return;
  }
}

function rememberLocale(locale) {
  try { localStorage.setItem(preferenceKey, locale); } catch { /* storage can be blocked */ }
}

const requestedLocale = supportedLocale(new URLSearchParams(location.search).get('lang'));
let savedLocale;
try { savedLocale = supportedLocale(localStorage.getItem(preferenceKey)); } catch { /* storage can be blocked */ }
let locale = requestedLocale ?? savedLocale ?? (navigator.languages ?? []).map(supportedLocale).find(Boolean) ?? 'zh-Hant';
if (requestedLocale) rememberLocale(requestedLocale);

const resolve = text => typeof text === 'function' ? text() : text;
const copy = text => () => locale === 'zh-Hant' ? text : localized[text]?.[locale === 'zh-Hans' ? 0 : 1] ?? text;

function appendText(parent, text) {
  if (typeof text !== 'string' && typeof text !== 'function') return;
  const child = document.createTextNode(resolve(text));
  if (typeof text === 'function') translations.set(child, text);
  parent.append(child);
}

function writeText(parent, text) {
  parent.replaceChildren();
  appendText(parent, text);
}

function setTitle(text) {
  pageTitle = text;
  document.title = `${resolve(text)} | SmartSell`;
}

function applyLocale() {
  document.documentElement.lang = locale;
  languagePicker.value = locale;
  languagePicker.setAttribute('aria-label', resolve(copy('語言')));
  if (pageTitle) setTitle(pageTitle);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const translate = translations.get(walker.currentNode);
    if (translate) walker.currentNode.data = translate();
  }
}

languagePicker.addEventListener('change', () => {
  locale = languagePicker.value;
  rememberLocale(locale);
  // An explicit URL preference controls the initial view. Clear it when the reader changes it.
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.delete('lang');
    history.replaceState(history.state, '', url);
  }
  applyLocale();
});

const app = document.querySelector('#app');
const channels = new Map([['email', copy('電子郵件')], ['sms', copy('簡訊')], ['whatsapp', 'WhatsApp']]);

function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  appendText(node, text);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function show(title, description, ...children) {
  setTitle(title);
  app.replaceChildren(element('h1', title, { tabindex: '-1' }), element('p', description, { class: 'description' }), ...children);
  app.removeAttribute('aria-busy');
}

async function request(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw Object.assign(new Error('Request failed'), { status: response.status });
  return (await response.json()).data;
}

function field(form, label, name, options) {
  const wrapper = element('label', label, { class: 'field' });
  const { multiline, ...attributes } = options;
  const input = element(multiline ? 'textarea' : 'input', null, { name, ...attributes });
  wrapper.append(input);
  form.append(wrapper);
  return input;
}

function choice(group, text, label) {
  const wrapper = element('label', null, { class: 'choice' });
  const input = element('input', null, { type: 'checkbox' });
  const copy = element('span');
  copy.append(element('strong', label), element('span', text));
  wrapper.append(input, copy);
  group.append(wrapper);
  return input;
}

function onSubmit(form, button, status, submit, errorText) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    status.textContent = '';
    button.disabled = true;
    try {
      const data = await submit();
      if (data?.accepted !== true) throw new Error('Unexpected response');
      show(copy('已收到您的請求'), copy('謝謝，您的請求已送出。'));
      app.querySelector('h1').focus();
    } catch (error) {
      writeText(status, errorText(error));
      button.disabled = false;
    }
  });
}

async function landing(key) {
  const path = `/api/public/landing/${encodeURIComponent(key)}`;
  const data = await request(path);
  if (typeof data?.title !== 'string' || typeof data.version_id !== 'string') throw new Error('Invalid landing');
  const form = element('form');
  form.append(element('p', copy('請至少填寫電子郵件或電話。'), { class: 'hint' }));
  field(form, copy('姓名（選填）'), 'name', { autocomplete: 'name', maxlength: '120' });
  const email = field(form, copy('電子郵件'), 'email', { type: 'email', autocomplete: 'email', maxlength: '254' });
  const phone = field(form, copy('電話（含國碼，例如 +12025550123）'), 'phone', { type: 'tel', autocomplete: 'tel', maxlength: '16', pattern: '\\+[1-9][0-9]{6,14}' });
  field(form, copy('留言（選填）'), 'message', { multiline: true, maxlength: '2000', rows: '3' });
  let service;
  if (typeof data.service_contact?.text === 'string') {
    const group = element('fieldset');
    group.append(element('legend', copy('服務聯絡')));
    service = choice(group, data.service_contact.text, channels.get(data.service_contact.channel) ?? copy('允許服務聯絡'));
    form.append(group);
  }
  const marketing = new Map();
  if (data.service_contact_only !== true && Array.isArray(data.channel_options)) {
    const group = element('fieldset');
    group.append(element('legend', copy('行銷訂閱（選填）')));
    for (const option of data.channel_options) {
      if (channels.has(option?.channel) && typeof option.text === 'string' && !marketing.has(option.channel)) {
        marketing.set(option.channel, choice(group, option.text, channels.get(option.channel)));
      }
    }
    if (marketing.size) form.append(group);
  }
  const status = element('p', '', { class: 'notice', role: 'status' });
  const button = element('button', copy('送出資料'), { type: 'submit' });
  form.append(status, button);
  onSubmit(form, button, status, () => {
    const fields = new FormData(form);
    const body = { version_id: data.version_id };
    for (const name of ['name', 'email', 'phone', 'message']) {
      const value = fields.get(name).trim();
      if (value) body[name] = value;
    }
    if (!body.email && !body.phone) {
      email.focus();
      throw new Error('contact');
    }
    const needs = channel => channel === 'email' ? body.email : body.phone;
    if (service?.checked && !needs(data.service_contact.channel)) {
      (data.service_contact.channel === 'email' ? email : phone).focus();
      throw new Error('channel');
    }
    for (const [channel, input] of marketing) {
      if (input.checked && !needs(channel)) {
        (channel === 'email' ? email : phone).focus();
        throw new Error('channel');
      }
    }
    if (service) body.service_contact = service.checked;
    if (marketing.size) body.marketing = Object.fromEntries([...marketing].map(([channel, input]) => [channel, input.checked]));
    return request(path, body);
  }, error => {
    if (error.message === 'contact') return copy('請填寫電子郵件或電話。');
    if (error.message === 'channel') return copy('請填寫已勾選聯絡渠道所需的資料。');
    if (error.status === 409) return copy('頁面可能已更新。請重新載入並確認最新同意文字。');
    if (error.status === 429) return copy('送出次數過多，請稍後再試。');
    if ([400, 422].includes(error.status)) return copy('目前無法送出，請確認資料後再試。');
    if ([404, 410].includes(error.status)) return copy('這個連結可能已失效，請向提供者索取最新連結。');
    return copy('服務暫時無法使用，請稍後重試。');
  });
  show(data.title, typeof data.description === 'string' ? data.description : '', form);
}

function unsubscribe() {
  let token;
  try { token = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed link */ }
  if (!token) {
    show(copy('無法使用此連結'), copy('請開啟原始郵件中的取消訂閱連結。'));
    return;
  }
  const form = element('form');
  const status = element('p', '', { class: 'notice', role: 'status' });
  const button = element('button', copy('確認取消訂閱'), { type: 'submit' });
  form.append(status, button);
  onSubmit(form, button, status, () => request('/api/public/unsubscribe', { token }),
    error => {
      if ([400, 404, 410, 422].includes(error.status)) return copy('請開啟原始郵件中的取消訂閱連結。');
      if (error.status === 429) return copy('送出次數過多，請稍後再試。');
      return copy('目前無法送出取消訂閱請求，請稍後再試。');
    });
  show(copy('取消訂閱'), copy('確認後，我們會送出這個連結所對應的取消訂閱請求。'), form);
}

writeText(app.querySelector('[role=status]'), copy('載入中…'));
applyLocale();

const match = location.pathname.match(/^\/landing\/([^/]+)\/?$/);
if (match) {
  Promise.resolve().then(() => landing(decodeURIComponent(match[1]))).catch(error => {
    if (error.status === 404 || error.status === 422 || error instanceof URIError) {
      show(copy('找不到此頁面'), copy('這個連結可能已失效，請向提供者索取最新連結。'));
    } else {
      const retry = element('button', copy('重新載入'), { type: 'button' });
      retry.addEventListener('click', () => location.reload());
      show(copy('暫時無法載入'), copy('請稍後重試。'), retry);
    }
  });
} else if (/^\/unsubscribe\/?$/.test(location.pathname)) {
  unsubscribe();
  addEventListener('hashchange', () => location.reload());
} else {
  show(location.pathname === '/' ? 'SmartSell' : copy('找不到此頁面'), copy('請開啟活動或郵件中提供的完整連結。'));
}
