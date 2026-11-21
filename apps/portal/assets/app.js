const app = document.querySelector('#app');
const account = document.querySelector('#account');
const taskStatuses = new Map([['open', '待處理'], ['in_progress', '進行中'], ['blocked', '受阻'], ['done', '已完成']]);
const statuses = new Map([...taskStatuses, ['pending', '待完成'], ['ready', '已備妥'], ['draft', '草稿'], ['published', '已發布'], ['active', '有效'], ['revoked', '已撤銷'], ['expired', '已到期'], ['approve', '已批准'], ['request_changes', '已要求修改']]);
let workspaceLoad;

function node(tag, text, attributes = {}) {
  const item = document.createElement(tag);
  if (typeof text === 'string') item.textContent = text;
  for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, value);
  return item;
}

function show(...children) {
  app.replaceChildren(...children);
  app.removeAttribute('aria-busy');
}

function heading(title, description, level = 'h1') {
  const section = node('div', null, { class: 'heading' });
  section.append(node(level, title, { tabindex: '-1' }));
  if (description) section.append(node('p', description, { class: 'muted copy' }));
  return section;
}

function panel(title, description) {
  const section = node('section', null, { class: 'panel' });
  section.append(heading(title, description, 'h2'));
  return section;
}

function field(form, label, name, options = {}) {
  const wrapper = node('label', label);
  const { multiline, value, ...attributes } = options;
  const input = node(multiline ? 'textarea' : 'input', null, { name, ...attributes });
  input.value = value ?? '';
  wrapper.append(input);
  form.append(wrapper);
  return input;
}

function select(form, label, name, options, value) {
  const wrapper = node('label', label);
  const input = node('select', null, { name });
  for (const [key, text] of options) input.append(node('option', text, { value: key }));
  if (value !== undefined) input.value = value;
  wrapper.append(input);
  form.append(wrapper);
  return input;
}

function date(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '' : new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

function dateInput(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return '';
  return new Date(parsed.valueOf() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function badge(value) {
  return node('span', statuses.get(value) ?? '未提供狀態', { class: 'badge' });
}

function note(text = '') {
  return node('p', text, { class: 'notice', role: 'status' });
}

function button(text, kind = 'secondary', type = 'button') {
  return node('button', text, { type, class: kind });
}

function operation(control, status, run, done, eventTarget = control, onError = errorMessage) {
  let pending = false;
  eventTarget.addEventListener(eventTarget === control ? 'click' : 'submit', async event => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    control.disabled = true;
    status.textContent = '';
    try {
      const result = await run();
      if (control.isConnected) await done?.(result);
    } catch (error) {
      if (control.isConnected) onError(error, status);
    } finally {
      pending = false;
      control.disabled = false;
    }
  });
}

async function request(path, { method = 'GET', body, key, csrfToken, signal, credentials = 'same-origin' } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (typeof csrfToken === 'string' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, {
    method, headers, credentials, signal, redirect: 'error', cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error('Request failed'), { status: response.status });
  return response.status === 204 ? null : response.json();
}

function errorMessage(error, status) {
  const messages = new Map([
    [401, '請確認登入資料或重新登入。'], [403, '您目前沒有執行此操作的權限。'],
    [404, '此項目目前無法存取。'], [409, '此項目可能已變更。請重新整理後再試。'],
    [422, '請檢查輸入資料後再試。'], [429, '操作次數過多，請稍後再試。'],
  ]);
  status.textContent = messages.get(error.status) ?? '目前無法完成操作，請稍後再試。';
}

function login() {
  account.replaceChildren();
  const section = node('section', null, { class: 'panel auth' });
  section.append(heading('登入客戶門戶', '選擇工作區後，即可查看您的任務與交付。'));
  const form = node('form');
  const email = field(form, '電子郵件', 'email', { type: 'email', autocomplete: 'username', required: '' });
  const password = field(form, '密碼', 'password', { type: 'password', autocomplete: 'current-password', required: '' });
  const submit = button('登入', 'primary', 'submit');
  const status = note();
  form.append(submit, status);
  section.append(form);
  show(section);
  operation(submit, status, async () => {
    await request('/api/v1/session', { method: 'POST', body: { email: email.value.trim(), password: password.value } });
    password.value = '';
  }, startSession, form);
}

async function startSession() {
  account.replaceChildren();
  show(heading('載入門戶…'));
  try {
    const session = await request('/api/v1/session');
    if (!Array.isArray(session?.workspaces)) throw new Error('Invalid session');
    home(session);
  } catch (error) {
    if (error.status === 401) {
      login();
      return;
    }
    const retry = button('重試');
    retry.addEventListener('click', startSession);
    show(heading('無法載入門戶', '請稍後重試。'), retry);
  }
}

function home(session) {
  const identity = session.user?.name || session.user?.email;
  const logout = button('登出');
  const logoutStatus = note();
  account.replaceChildren(node('span', identity), logout, logoutStatus);
  const csrfToken = session.csrf_token;
  operation(logout, logoutStatus, () => request('/api/v1/session', { method: 'DELETE', csrfToken }), () => {
    workspaceLoad?.abort();
    login();
  }, logout, (error, status) => {
    if (error.status === 401) {
      workspaceLoad?.abort();
      login();
    } else errorMessage(error, status);
  });
  const workspaces = session.workspaces.filter(workspace => typeof workspace?.id === 'string');
  if (!workspaces.length) {
    show(heading('客戶門戶', '目前沒有可存取的工作區。'));
    return;
  }
  const toolbar = node('div', null, { class: 'toolbar' });
  const workspaceSelect = select(toolbar, '工作區', 'workspace', workspaces.map(workspace => [workspace.id, workspace.name || '工作區']));
  const refresh = button('重新整理');
  toolbar.append(refresh);
  const content = node('div', null, { class: 'workspace' });
  show(heading('工作區交付', '追蹤任務進度、交付項目與客戶審閱。'), toolbar, content);

  async function load(message = '') {
    workspaceLoad?.abort();
    const controller = new AbortController();
    workspaceLoad = controller;
    const { signal } = controller;
    const workspaceId = workspaceSelect.value;
    if (!workspaces.some(workspace => workspace.id === workspaceId)) return;
    const path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
    content.setAttribute('aria-busy', 'true');
    content.replaceChildren(node('p', '載入工作區…', { role: 'status' }));
    try {
      const command = (action, body, signal) => request(`${path}/commands/team/${action}`, {
        method: 'POST', body, key: crypto.randomUUID(), csrfToken, signal,
      }).then(value => value.data);
      const [{ items }, board] = await Promise.all([
        request(`${path}/commands`, { signal }),
        command('list_board', {}, signal),
      ]);
      if (signal.aborted) return;
      const commands = new Set(Array.isArray(items) ? items.filter(item => item.module === 'team').map(item => item.action) : []);
      const context = {
        can: action => commands.has(action),
        command,
        mint: shareId => request('/api/portal/share-token', { method: 'POST', body: { workspaceId, shareId }, csrfToken }).then(value => value.data),
        refresh: text => !signal.aborted && load(text),
        onError: (error, feedback) => error.status === 401 ? login() : errorMessage(error, feedback),
      };
      if (![board?.tasks, board?.deliveries, board?.shares].every(Array.isArray)) throw new Error('Invalid board');
      const deliveryTitles = new Map(board.deliveries.map(({ id, data }) => [id, data.title]));
      content.replaceChildren(note(message), tasks(board.tasks, context), deliveries(board.deliveries, context), shares(board.shares, context, deliveryTitles));
    } catch (error) {
      if (!signal.aborted) {
        if (error.status === 401) {
          login();
          return;
        }
        const feedback = note();
        errorMessage(error, feedback);
        content.replaceChildren(feedback);
      }
    } finally {
      if (!signal.aborted) content.removeAttribute('aria-busy');
    }
  }

  workspaceSelect.addEventListener('change', () => load());
  refresh.addEventListener('click', () => load());
  load();
}

function listState(section, rows, empty) {
  if (!rows.length) section.append(node('p', empty, { class: 'muted' }));
}

function taskForm(context, row) {
  const form = node('form', null, { class: 'inline-form' });
  const { data, id, version } = row ?? {};
  const title = row ? null : field(form, '任務名稱', 'title', { required: '', maxlength: '160' });
  const assignee = field(form, '負責人 ID', 'assigneeId', { value: data?.assigneeId, maxlength: '128' });
  const due = field(form, '截止時間（本地時間）', 'dueAt', { type: 'datetime-local', value: dateInput(data?.dueAt) });
  const state = row ? select(form, '狀態', 'status', taskStatuses, data.status) : null;
  const submit = button(row ? '儲存任務' : '建立任務', row ? 'secondary' : 'primary', 'submit');
  const feedback = note();
  form.append(submit, feedback);
  operation(submit, feedback, () => {
    const body = row ? { id, version, status: state.value } : { title: title.value.trim() };
    if (assignee.value.trim()) body.assigneeId = assignee.value.trim();
    else if (row && data.assigneeId) body.assigneeId = null;
    if (due.value && (!row || due.value !== dateInput(data.dueAt))) body.dueAt = new Date(due.value).toISOString();
    else if (!due.value && row && data.dueAt) body.dueAt = null;
    return context.command(row ? 'update_task' : 'create_task', body);
  }, () => context.refresh(row ? '已更新任務。' : '已建立任務。'), form, context.onError);
  return form;
}

function tasks(rows, context) {
  const section = panel('任務');
  if (context.can('create_task')) {
    const create = node('details');
    create.append(node('summary', '新增任務'), taskForm(context));
    section.append(create);
  }
  listState(section, rows,'目前沒有任務。');
  for (const row of rows ?? []) {
    const item = node('article', null, { class: 'record' });
    item.append(node('h3', row.data.title), badge(row.data.status));
    const details = [row.data.assigneeId ? `負責人 ID：${row.data.assigneeId}` : '未指派', date(row.data.dueAt) && `截止：${date(row.data.dueAt)}`];
    item.append(node('p', details.filter(Boolean).join(' · '), { class: 'muted' }));
    if (context.can('update_task')) {
      const edit = node('details');
      edit.append(node('summary', '編輯任務'), taskForm(context, row));
      item.append(edit);
    }
    section.append(item);
  }
  return section;
}

function itemList(items) {
  const list = node('ul', null, { class: 'checklist' });
  for (const item of Array.isArray(items) ? items : []) {
    const entry = node('li');
    entry.append(node('span', item?.title), badge(item?.status));
    list.append(entry);
  }
  return list;
}

function deliveryForm(context) {
  const form = node('form');
  const title = field(form, '交付名稱', 'title', { required: '', maxlength: '160' });
  const description = field(form, '交付說明', 'description', { multiline: true, rows: '2', required: '', maxlength: '2000' });
  const items = node('fieldset');
  items.append(node('legend', '交付項目'));
  function addItem(focus = false) {
    const fields = node('div', null, { class: 'inline-form item-fields' });
    const itemTitle = field(fields, '項目名稱', 'itemTitle', { required: '', maxlength: '160' });
    select(fields, '項目狀態', 'itemStatus', new Map([['pending', '待完成'], ['ready', '已備妥']]));
    const remove = button('移除項目');
    remove.addEventListener('click', () => {
      fields.remove();
      if (!items.querySelector('.item-fields')) addItem(true);
    });
    fields.append(remove);
    items.append(fields);
    if (focus) itemTitle.focus();
  }
  addItem();
  const add = button('新增項目');
  add.addEventListener('click', () => addItem(true));
  const submit = button('建立草稿', 'primary', 'submit');
  const feedback = note();
  form.append(items, add, submit, feedback);
  operation(submit, feedback, () => context.command('create_delivery', {
    title: title.value.trim(), description: description.value.trim(),
    items: [...items.querySelectorAll('.item-fields')].map(fields => ({
      title: fields.querySelector('[name=itemTitle]').value.trim(), status: fields.querySelector('select').value,
    })),
  }), () => context.refresh('已建立交付草稿。'), form, context.onError);
  return form;
}

function setupShare(row, context) {
  const section = node('div');
  const trigger = button('預覽分享內容');
  const feedback = note();
  const preview = node('div');
  section.append(trigger, feedback, preview);
  operation(trigger, feedback, () => {
    preview.replaceChildren();
    return context.command('preview_share', { deliveryId: row.id });
  }, result => {
    if (result?.deliveryId !== row.id || !Number.isInteger(result.previewVersion)) throw new Error('Invalid preview');
    const form = node('form');
    const permissions = node('fieldset');
    permissions.append(node('legend', '持有連結的人可以查看交付內容，也可執行下列選定的操作'));
    for (const [value, label] of [['comment', '留言'], ['approve', '批准或要求修改']]) {
      const wrapper = node('label', null, { class: 'choice' });
      wrapper.append(node('input', null, { type: 'checkbox', name: 'permission', value }), node('span', label));
      permissions.append(wrapper);
    }
    const expiry = field(form, '連結權限到期（本地時間）', 'expiry', { type: 'datetime-local', required: '', value: dateInput(Date.now() + 86400000) });
    form.append(permissions);
    const submit = button('建立唯讀連結或授予上述操作', 'primary', 'submit');
    const shareFeedback = note();
    form.append(submit, shareFeedback);
    preview.replaceChildren(heading(result.title, result.description, 'h3'), itemList(result.items), form);
    operation(submit, shareFeedback, () => context.command('create_share', {
      deliveryId: result.deliveryId, previewVersion: result.previewVersion,
      permissions: ['view', ...new FormData(form).getAll('permission')], expiresAt: new Date(expiry.value).toISOString(),
    }), () => context.refresh('已建立分享。請從分享清單產生連結。'), form, context.onError);
  }, trigger, context.onError);
  return section;
}

function deliveries(rows, context) {
  const section = panel('交付清單');
  if (context.can('create_delivery')) {
    const create = node('details');
    create.append(node('summary', '新增交付'), deliveryForm(context));
    section.append(create);
  }
  listState(section, rows,'目前沒有交付項目。');
  for (const row of rows ?? []) {
    const item = node('article', null, { class: 'record' });
    item.append(node('h3', row.data.title), badge(row.data.status), node('p', row.data.description, { class: 'muted copy' }), itemList(row.data.items));
    if (row.data.status === 'draft' && context.can('publish_delivery')) {
      const publish = button('發布交付', 'primary');
      const feedback = note();
      item.append(publish, feedback);
      operation(publish, feedback, () => context.command('publish_delivery', { id: row.id, version: row.version }),
        () => context.refresh('已發布交付。'), publish, context.onError);
    }
    if (row.data.status === 'published' && context.can('preview_share') && context.can('create_share')) item.append(setupShare(row, context));
    section.append(item);
  }
  return section;
}

function shares(rows, context, deliveryTitles) {
  const section = panel('分享連結', '產生的連結有效期最長為 15 分鐘，且不會晚於分享權限到期時間。');
  listState(section, rows,'目前沒有分享。');
  for (const row of rows ?? []) {
    const item = node('article', null, { class: 'record' });
    const { deliveryId, expiresAt, decision } = row.data;
    const state = row.data.status === 'active' && Date.parse(expiresAt) <= Date.now() ? 'expired' : row.data.status;
    item.append(node('h3', deliveryTitles.get(deliveryId) || '交付分享'), badge(state));
    if (expiresAt) item.append(node('p', `到期：${date(expiresAt)}`, { class: 'muted' }));
    if (decision?.action) item.append(decisionNote(decision));
    if (state === 'active' && context.can('create_share')) {
      const generate = button('產生連結');
      const feedback = note();
      const output = node('div');
      item.append(generate, feedback, output);
      operation(generate, feedback, () => context.mint(row.id), result => {
        if (typeof result?.token !== 'string' || !result.token) throw new Error('Invalid share token');
        const url = new URL(`/share#${encodeURIComponent(result.token)}`, location.origin).href;
        output.replaceChildren();
        const link = field(output, '分享網址', 'shareLink', { readonly: '', value: url });
        const copy = button('複製網址');
        const copyStatus = note();
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(url);
            copyStatus.textContent = '已複製網址。';
          } catch {
            link.focus();
            link.select();
            copyStatus.textContent = '請複製已選取的網址。';
          }
        });
        output.append(copy, copyStatus);
        link.focus();
        link.select();
      }, generate, context.onError);
    }
    if (state === 'active' && context.can('revoke_share')) {
      const controls = node('details');
      const revoke = button('確認撤銷');
      const feedback = note();
      controls.append(node('summary', '撤銷分享'), revoke, feedback);
      item.append(controls);
      operation(revoke, feedback, () => context.command('revoke_share', { id: row.id, version: row.version }),
        () => context.refresh('已撤銷分享。'), revoke, context.onError);
    }
    section.append(item);
  }
  return section;
}

function decisionNote(decision) {
  const result = node('div');
  result.append(badge(decision.action));
  const time = date(decision.at);
  if (time) result.append(node('span', ` ${time}`, { class: 'muted' }));
  return result;
}

function signedShare() {
  let token;
  try { token = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed link */ }
  function unavailable() {
    show(heading('無法開啟分享', '此連結可能已失效。請向原分享者取得新連結。'));
  }
  if (!token) {
    unavailable();
    return;
  }
  const share = body => request('/api/portal/share', { method: 'POST', body: { token, ...body }, credentials: 'omit' }).then(value => value.data);
  const shareError = (error, status) => {
    if ([401, 404, 410].includes(error.status)) unavailable();
    else errorMessage(error, status);
  };
  function render(data, message = '', focusHeading = true) {
    if (typeof data?.title !== 'string') throw new Error('Invalid share response');
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    document.title = `${data.title} | SmartSell`;
    const details = panel('交付項目');
    details.append(itemList(data.items));
    const review = panel('審閱');
    const comments = Array.isArray(data.comments) ? data.comments : [];
    if (data.decision?.action) review.append(decisionNote(data.decision));
    if (comments.length) {
      const list = node('ul', null, { class: 'comments' });
      for (const entry of comments) {
        const comment = node('li');
        comment.append(node('p', entry?.text, { class: 'copy' }), node('span', date(entry?.at), { class: 'muted' }));
        list.append(comment);
      }
      review.append(list);
    }
    if (permissions.includes('comment')) {
      const form = node('form');
      const text = field(form, '留言內容', 'comment', { multiline: true, rows: '3', maxlength: '2000', required: '' });
      const submit = button('送出留言', 'primary', 'submit');
      const feedback = note();
      form.append(submit, feedback);
      review.append(form);
      operation(submit, feedback, () => share({ action: 'comment', text: text.value.trim() }),
        result => render(result, '已送出留言。'), form, shareError);
    }
    if (permissions.includes('approve') && !data.decision) {
      const form = node('form');
      const action = select(form, '審閱結果', 'decision', [['', '選擇審閱結果'], ['approve', '批准'], ['request_changes', '要求修改']]);
      action.required = true;
      const submit = button('確認審閱結果', 'primary', 'submit');
      const feedback = note();
      form.append(submit, feedback);
      review.append(form);
      operation(submit, feedback, () => share({ action: action.value }), result => render(result, '已送出審閱結果。'), form, shareError);
    }
    const columns = node('div', null, { class: 'share-layout' });
    columns.append(details);
    if (review.children.length > 1) columns.append(review);
    const shareHeading = heading(data.title, data.description);
    shareHeading.classList.add('share-heading');
    show(shareHeading, note(message), columns);
    if (focusHeading) app.querySelector('h1').focus();
  }
  share({}).then(data => render(data, '', false)).catch(error => {
    if ([401, 403, 404, 410].includes(error.status)) unavailable();
    else {
      const retry = button('重試');
      retry.addEventListener('click', signedShare);
      show(heading('暫時無法載入分享'), retry);
    }
  });
}

function creatorSubmission() {
  let token;
  try { token = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed link */ }
  if (!token) {
    show(heading('無法開啟交付', '請向邀請您的團隊取得有效連結。'));
    return;
  }
  const section = node('section', null, { class: 'panel auth' });
  const form = node('form');
  const url = field(form, '貼文網址（HTTPS）', 'post_url', { type: 'url', required: '', maxlength: '2048' });
  const submit = button('送出貼文網址', 'primary', 'submit');
  const status = note();
  form.append(submit, status);
  section.append(heading('創作者交付', '提交已發布的貼文網址。'), form);
  show(section);
  operation(submit, status, async () => {
    const postUrl = new URL(url.value.trim());
    if (postUrl.protocol !== 'https:' || postUrl.username || postUrl.password) {
      throw Object.assign(new Error('Invalid URL'), { status: 422 });
    }
    const response = await request('/api/portal/creator-submit', {
      method: 'POST', body: { token, post_url: postUrl.href }, credentials: 'omit',
    });
    if (response?.data?.accepted !== true) throw new Error('Unexpected response');
  }, () => {
    show(heading('已收到您的請求', '貼文網址已送出。'));
    app.querySelector('h1').focus();
  }, form, errorMessage);
}

if (/^\/share\/?$/.test(location.pathname)) {
  signedShare();
  addEventListener('hashchange', () => location.reload());
} else if (/^\/creator\/?$/.test(location.pathname)) {
  creatorSubmission();
  addEventListener('hashchange', () => location.reload());
} else if (location.pathname === '/') {
  startSession();
} else {
  show(heading('找不到此頁面'), node('a', '返回門戶', { href: '/' }));
}
