const app = document.querySelector('#app');
const channels = new Map([['email', '電子郵件'], ['sms', '簡訊'], ['whatsapp', 'WhatsApp']]);

function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (typeof text === 'string') node.textContent = text;
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function show(title, description, ...children) {
  document.title = `${title} | SmartSell`;
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
      show('已收到您的請求', '謝謝，您的請求已送出。');
      app.querySelector('h1').focus();
    } catch (error) {
      status.textContent = errorText(error);
      button.disabled = false;
    }
  });
}

async function landing(key) {
  const path = `/api/public/landing/${encodeURIComponent(key)}`;
  const data = await request(path);
  if (typeof data?.title !== 'string' || typeof data.version_id !== 'string') throw new Error('Invalid landing');
  const form = element('form');
  form.append(element('p', '請至少填寫電子郵件或電話。', { class: 'hint' }));
  field(form, '姓名（選填）', 'name', { autocomplete: 'name', maxlength: '120' });
  const email = field(form, '電子郵件', 'email', { type: 'email', autocomplete: 'email', maxlength: '254' });
  const phone = field(form, '電話（含國碼，例如 +12025550123）', 'phone', { type: 'tel', autocomplete: 'tel', maxlength: '16', pattern: '\\+[1-9][0-9]{6,14}' });
  field(form, '留言（選填）', 'message', { multiline: true, maxlength: '2000', rows: '3' });
  let service;
  if (typeof data.service_contact?.text === 'string') {
    const group = element('fieldset');
    group.append(element('legend', '服務聯絡'));
    service = choice(group, data.service_contact.text, channels.get(data.service_contact.channel) ?? '允許服務聯絡');
    form.append(group);
  }
  const marketing = new Map();
  if (data.service_contact_only !== true && Array.isArray(data.channel_options)) {
    const group = element('fieldset');
    group.append(element('legend', '行銷訂閱（選填）'));
    for (const option of data.channel_options) {
      if (channels.has(option?.channel) && typeof option.text === 'string' && !marketing.has(option.channel)) {
        marketing.set(option.channel, choice(group, option.text, channels.get(option.channel)));
      }
    }
    if (marketing.size) form.append(group);
  }
  const status = element('p', '', { class: 'notice', role: 'status' });
  const button = element('button', '送出資料', { type: 'submit' });
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
    if (error.message === 'contact') return '請填寫電子郵件或電話。';
    if (error.message === 'channel') return '請填寫已勾選聯絡渠道所需的資料。';
    if (error.status === 409) return '頁面可能已更新。請重新載入並確認最新同意文字。';
    if (error.status === 429) return '送出次數過多，請稍後再試。';
    return '目前無法送出，請確認資料後再試。';
  });
  show(data.title, typeof data.description === 'string' ? data.description : '', form);
}

function unsubscribe() {
  let token;
  try { token = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed link */ }
  if (!token) {
    show('無法使用此連結', '請開啟原始郵件中的取消訂閱連結。');
    return;
  }
  const form = element('form');
  const status = element('p', '', { class: 'notice', role: 'status' });
  const button = element('button', '確認取消訂閱', { type: 'submit' });
  form.append(status, button);
  onSubmit(form, button, status, () => request('/api/public/unsubscribe', { token }),
    () => '目前無法送出取消訂閱請求，請稍後再試。');
  show('取消訂閱', '確認後，我們會送出這個連結所對應的取消訂閱請求。', form);
}

const match = location.pathname.match(/^\/landing\/([^/]+)\/?$/);
if (match) {
  Promise.resolve().then(() => landing(decodeURIComponent(match[1]))).catch(error => {
    if (error.status === 404 || error.status === 422 || error instanceof URIError) {
      show('找不到此頁面', '這個連結可能已失效，請向提供者索取最新連結。');
    } else {
      const retry = element('button', '重新載入', { type: 'button' });
      retry.addEventListener('click', () => location.reload());
      show('暫時無法載入', '請稍後重試。', retry);
    }
  });
} else if (/^\/unsubscribe\/?$/.test(location.pathname)) {
  unsubscribe();
  addEventListener('hashchange', () => location.reload());
} else {
  show(location.pathname === '/' ? 'SmartSell' : '找不到此頁面', '請開啟活動或郵件中提供的完整連結。');
}
