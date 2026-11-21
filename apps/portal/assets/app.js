import { appendText, bindLanguagePicker, resolve, updateText, writeText } from '../src/i18n.js';

const localized = {
  "語言": ["语言", "Language"],
  "客戶門戶": ["客户门户", "Client portal"],
  "載入中…": ["加载中…", "Loading…"],
  "此門戶為桌面版。建議使用寬度至少 1280px 的電腦瀏覽器。": ["此门户为桌面版。建议使用窗口宽度至少为 1280 像素的桌面浏览器。", "Use a desktop browser window at least 1280 pixels wide."],
  "待處理": ["待处理", "To do"],
  "進行中": ["进行中", "In progress"],
  "受阻": ["受阻", "Blocked"],
  "已完成": ["已完成", "Done"],
  "待完成": ["待完成", "Pending"],
  "已備妥": ["已就绪", "Ready"],
  "草稿": ["草稿", "Draft"],
  "已發布": ["已发布", "Published"],
  "有效": ["有效", "Active"],
  "已撤銷": ["已撤销", "Revoked"],
  "已到期": ["已到期", "Expired"],
  "已批准": ["已批准", "Approved"],
  "已要求修改": ["已要求修改", "Changes requested"],
  "未提供狀態": ["未提供状态", "Status unavailable"],
  "請確認登入資料或重新登入。": ["请检查登录信息，或重新登录。", "Check your sign-in details or sign in again."],
  "您目前沒有執行此操作的權限。": ["您没有执行此操作的权限。", "You don’t have permission to perform this action."],
  "此項目目前無法存取。": ["暂时无法访问此项目。", "This item is unavailable."],
  "此項目可能已變更。請重新整理後再試。": ["此项目可能已更改。请刷新页面后重试。", "This item may have changed. Refresh and try again."],
  "請檢查輸入資料後再試。": ["请检查输入的信息后重试。", "Check the information you entered and try again."],
  "操作次數過多，請稍後再試。": ["操作次数过多，请稍后再试。", "Too many attempts. Try again later."],
  "目前無法完成操作，請稍後再試。": ["暂时无法完成操作，请稍后重试。", "We couldn’t complete the request. Try again later."],
  "登入客戶門戶": ["登录客户门户", "Sign in to the client portal"],
  "選擇工作區後，即可查看您的任務與交付。": ["选择工作区后，即可查看您的任务和交付。", "Choose a workspace to see your tasks and deliveries."],
  "電子郵件": ["电子邮件", "Email"],
  "密碼": ["密码", "Password"],
  "登入": ["登录", "Sign in"],
  "載入門戶…": ["正在加载门户…", "Loading portal…"],
  "重試": ["重试", "Retry"],
  "無法載入門戶": ["无法加载门户", "Couldn’t load the portal"],
  "請稍後重試。": ["请稍后重试。", "Try again later."],
  "登出": ["退出登录", "Sign out"],
  "目前沒有可存取的工作區。": ["目前没有可访问的工作区。", "You currently have access to no workspaces."],
  "工作區": ["工作区", "Workspace"],
  "重新整理": ["刷新", "Refresh"],
  "工作區交付": ["工作区交付", "Workspace deliveries"],
  "追蹤任務進度、交付項目與客戶審閱。": ["跟踪任务进度、交付项目和客户审核。", "Track tasks, deliveries, and client reviews."],
  "載入工作區…": ["正在加载工作区…", "Loading workspace…"],
  "任務名稱": ["任务名称", "Task name"],
  "負責人 ID": ["负责人 ID", "Assignee ID"],
  "截止時間（本地時間）": ["截止时间（本地时间）", "Deadline (local time)"],
  "狀態": ["状态", "Status"],
  "儲存任務": ["保存任务", "Save task"],
  "建立任務": ["创建任务", "Create task"],
  "已更新任務。": ["已更新任务。", "Task updated."],
  "已建立任務。": ["已创建任务。", "Task created."],
  "任務": ["任务", "Tasks"],
  "新增任務": ["新增任务", "Add task"],
  "目前沒有任務。": ["目前没有任务。", "There are no tasks yet."],
  "未指派": ["未分配", "Unassigned"],
  "截止": ["截止", "Due"],
  "編輯任務": ["编辑任务", "Edit task"],
  "交付名稱": ["交付名称", "Delivery name"],
  "交付說明": ["交付说明", "Delivery description"],
  "交付項目": ["交付项目", "Delivery items"],
  "項目名稱": ["项目名称", "Item name"],
  "項目狀態": ["项目状态", "Item status"],
  "移除項目": ["移除项目", "Remove item"],
  "新增項目": ["新增项目", "Add item"],
  "建立草稿": ["创建草稿", "Create draft"],
  "已建立交付草稿。": ["已创建交付草稿。", "Delivery draft created."],
  "預覽分享內容": ["预览分享内容", "Preview share"],
  "持有連結的人可以查看交付內容，也可執行下列選定的操作": ["持有链接的人可以查看交付内容，并执行以下选中的操作", "People with the link can view the delivery and perform the selected actions."],
  "留言": ["留言", "Comment"],
  "批准或要求修改": ["批准或要求修改", "Approve or request changes"],
  "連結權限到期（本地時間）": ["链接权限到期时间（本地时间）", "Link permission expiry (local time)"],
  "建立唯讀連結或授予上述操作": ["创建链接并应用所选权限", "Create link with selected permissions"],
  "已建立分享。請從分享清單產生連結。": ["已创建分享。请在分享列表中生成链接。", "Share created. Generate a link from the share list."],
  "交付清單": ["交付列表", "Deliveries"],
  "新增交付": ["新增交付", "Add delivery"],
  "目前沒有交付項目。": ["目前没有交付项目。", "There are no deliveries yet."],
  "發布交付": ["发布交付", "Publish delivery"],
  "已發布交付。": ["已发布交付。", "Delivery published."],
  "分享連結": ["分享链接", "Share links"],
  "產生的連結有效期最長為 15 分鐘，且不會晚於分享權限到期時間。": ["生成的链接最长有效 15 分钟，且不会超过分享权限的到期时间。", "Generated links last up to 15 minutes and expire by the share’s permission deadline."],
  "目前沒有分享。": ["目前没有分享。", "There are no shares yet."],
  "交付分享": ["交付分享", "Shared delivery"],
  "到期": ["到期", "Expires"],
  "產生連結": ["生成链接", "Generate link"],
  "分享網址": ["分享链接", "Share URL"],
  "複製網址": ["复制链接", "Copy link"],
  "已複製網址。": ["已复制链接。", "Link copied."],
  "請複製已選取的網址。": ["请复制已选中的链接。", "Copy the selected link."],
  "確認撤銷": ["确认撤销", "Confirm revocation"],
  "撤銷分享": ["撤销分享", "Revoke share"],
  "已撤銷分享。": ["已撤销分享。", "Share revoked."],
  "無法開啟分享": ["无法打开分享", "Couldn’t open the share"],
  "此連結可能已失效。請向原分享者取得新連結。": ["此链接可能已失效。请联系分享者获取新链接。", "This link may have expired. Ask the sender for a new one."],
  "審閱": ["审核", "Review"],
  "留言內容": ["留言内容", "Comment"],
  "送出留言": ["提交留言", "Post comment"],
  "已送出留言。": ["已提交留言。", "Comment posted."],
  "審閱結果": ["审核结果", "Review decision"],
  "選擇審閱結果": ["选择审核结果", "Choose a decision"],
  "批准": ["批准", "Approve"],
  "要求修改": ["要求修改", "Request changes"],
  "確認審閱結果": ["确认审核结果", "Confirm review decision"],
  "已送出審閱結果。": ["已提交审核结果。", "Review decision submitted."],
  "暫時無法載入分享": ["暂时无法加载分享", "Couldn’t load the share"],
  "無法開啟交付": ["无法打开交付", "Couldn’t open the delivery"],
  "請向邀請您的團隊取得有效連結。": ["请联系邀请您的团队获取有效链接。", "Ask the team that invited you for a valid link."],
  "貼文網址（HTTPS）": ["帖子链接（HTTPS）", "Post URL (HTTPS)"],
  "送出貼文網址": ["提交帖子链接", "Submit post URL"],
  "創作者交付": ["创作者交付", "Creator delivery"],
  "提交已發布的貼文網址。": ["提交已发布帖子的链接。", "Submit the URL of the published post."],
  "已收到您的請求": ["已收到您的请求", "Request received"],
  "貼文網址已送出。": ["帖子链接已提交。", "Post URL submitted."],
  "找不到此頁面": ["找不到此页面", "Page not found"],
  "返回門戶": ["返回门户", "Back to the portal"],
  "請輸入有效的 HTTPS 貼文網址。": ["请输入有效的 HTTPS 帖子链接。", "Enter a valid HTTPS post URL."],
  "此分享已失效，請向原分享者取得新連結。": ["此分享已失效，请联系分享者获取新链接。", "This share has expired. Ask the sender for a new link."],
};

const languagePicker = document.querySelector('#language');
const locale = () => languagePicker.value;
let pageTitle;
const copy = text => () => locale() === 'zh-Hant' ? text : localized[text]?.[locale() === 'zh-Hans' ? 0 : 1] ?? text;

function setTitle(text) {
  pageTitle = text;
  document.title = `${resolve(text)} | SmartSell`;
}

function applyLocale() {
  document.documentElement.lang = locale();
  languagePicker.setAttribute('aria-label', resolve(copy('語言')));
  if (pageTitle) setTitle(pageTitle);
  updateText(document.body);
}

bindLanguagePicker(languagePicker, applyLocale);

const app = document.querySelector('#app');
const account = document.querySelector('#account');
const taskStatuses = new Map([['open', copy('待處理')], ['in_progress', copy('進行中')], ['blocked', copy('受阻')], ['done', copy('已完成')]]);
const statuses = new Map([...taskStatuses, ['pending', copy('待完成')], ['ready', copy('已備妥')], ['draft', copy('草稿')], ['published', copy('已發布')], ['active', copy('有效')], ['revoked', copy('已撤銷')], ['expired', copy('已到期')], ['approve', copy('已批准')], ['request_changes', copy('已要求修改')]]);
let workspaceLoad;

function node(tag, text, attributes = {}) {
  const item = document.createElement(tag);
  appendText(item, text);
  for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, value);
  return item;
}

function show(...children) {
  setTitle(copy('客戶門戶'));
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
  return Number.isNaN(parsed.valueOf()) ? '' : new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

function dateInput(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return '';
  return new Date(parsed.valueOf() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function badge(value) {
  return node('span', statuses.get(value) ?? copy('未提供狀態'), { class: 'badge' });
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
    [401, copy('請確認登入資料或重新登入。')], [403, copy('您目前沒有執行此操作的權限。')],
    [404, copy('此項目目前無法存取。')], [409, copy('此項目可能已變更。請重新整理後再試。')],
    [410, copy('此分享已失效，請向原分享者取得新連結。')], [400, copy('請檢查輸入資料後再試。')],
    [422, copy('請檢查輸入資料後再試。')], [429, copy('操作次數過多，請稍後再試。')],
  ]);
  writeText(status, messages.get(error.status) ?? copy('目前無法完成操作，請稍後再試。'));
}

function login() {
  account.replaceChildren();
  const section = node('section', null, { class: 'panel auth' });
  section.append(heading(copy('登入客戶門戶'), copy('選擇工作區後，即可查看您的任務與交付。')));
  const form = node('form');
  const email = field(form, copy('電子郵件'), 'email', { type: 'email', autocomplete: 'username', required: '' });
  const password = field(form, copy('密碼'), 'password', { type: 'password', autocomplete: 'current-password', required: '' });
  const submit = button(copy('登入'), 'primary', 'submit');
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
  show(heading(copy('載入門戶…')));
  try {
    const session = await request('/api/v1/session');
    if (!Array.isArray(session?.workspaces)) throw new Error('Invalid session');
    home(session);
  } catch (error) {
    if (error.status === 401) {
      login();
      return;
    }
    const retry = button(copy('重試'));
    retry.addEventListener('click', startSession);
    show(heading(copy('無法載入門戶'), copy('請稍後重試。')), retry);
  }
}

function home(session) {
  const identity = session.user?.name || session.user?.email;
  const logout = button(copy('登出'));
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
    show(heading(copy('客戶門戶'), copy('目前沒有可存取的工作區。')));
    return;
  }
  const toolbar = node('div', null, { class: 'toolbar' });
  const workspaceSelect = select(toolbar, copy('工作區'), 'workspace', workspaces.map(workspace => [workspace.id, workspace.name || copy('工作區')]));
  const refresh = button(copy('重新整理'));
  toolbar.append(refresh);
  const content = node('div', null, { class: 'workspace' });
  show(heading(copy('工作區交付'), copy('追蹤任務進度、交付項目與客戶審閱。')), toolbar, content);

  async function load(message = '') {
    workspaceLoad?.abort();
    const controller = new AbortController();
    workspaceLoad = controller;
    const { signal } = controller;
    const workspaceId = workspaceSelect.value;
    if (!workspaces.some(workspace => workspace.id === workspaceId)) return;
    const path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
    content.setAttribute('aria-busy', 'true');
    content.replaceChildren(node('p', copy('載入工作區…'), { role: 'status' }));
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
  const title = row ? null : field(form, copy('任務名稱'), 'title', { required: '', maxlength: '160' });
  const assignee = field(form, copy('負責人 ID'), 'assigneeId', { value: data?.assigneeId, maxlength: '128' });
  const due = field(form, copy('截止時間（本地時間）'), 'dueAt', { type: 'datetime-local', value: dateInput(data?.dueAt) });
  const state = row ? select(form, copy('狀態'), 'status', taskStatuses, data.status) : null;
  const submit = button(row ? copy('儲存任務') : copy('建立任務'), row ? 'secondary' : 'primary', 'submit');
  const feedback = note();
  form.append(submit, feedback);
  operation(submit, feedback, () => {
    const body = row ? { id, version, status: state.value } : { title: title.value.trim() };
    if (assignee.value.trim()) body.assigneeId = assignee.value.trim();
    else if (row && data.assigneeId) body.assigneeId = null;
    if (due.value && (!row || due.value !== dateInput(data.dueAt))) body.dueAt = new Date(due.value).toISOString();
    else if (!due.value && row && data.dueAt) body.dueAt = null;
    return context.command(row ? 'update_task' : 'create_task', body);
  }, () => context.refresh(row ? copy('已更新任務。') : copy('已建立任務。')), form, context.onError);
  return form;
}

function tasks(rows, context) {
  const section = panel(copy('任務'));
  if (context.can('create_task')) {
    const create = node('details');
    create.append(node('summary', copy('新增任務')), taskForm(context));
    section.append(create);
  }
  listState(section, rows,copy('目前沒有任務。'));
  for (const row of rows ?? []) {
    const item = node('article', null, { class: 'record' });
    item.append(node('h3', row.data.title), badge(row.data.status));
    const details = () => [row.data.assigneeId ? `${copy('負責人 ID')()} · ${row.data.assigneeId}` : copy('未指派')(), date(row.data.dueAt) && `${copy('截止')()} · ${date(row.data.dueAt)}`];
    item.append(node('p', () => details().filter(Boolean).join(' · '), { class: 'muted' }));
    if (context.can('update_task')) {
      const edit = node('details');
      edit.append(node('summary', copy('編輯任務')), taskForm(context, row));
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
  const title = field(form, copy('交付名稱'), 'title', { required: '', maxlength: '160' });
  const description = field(form, copy('交付說明'), 'description', { multiline: true, rows: '2', required: '', maxlength: '2000' });
  const items = node('fieldset');
  items.append(node('legend', copy('交付項目')));
  function addItem(focus = false) {
    const fields = node('div', null, { class: 'inline-form item-fields' });
    const itemTitle = field(fields, copy('項目名稱'), 'itemTitle', { required: '', maxlength: '160' });
    select(fields, copy('項目狀態'), 'itemStatus', new Map([['pending', copy('待完成')], ['ready', copy('已備妥')]]));
    const remove = button(copy('移除項目'));
    remove.addEventListener('click', () => {
      fields.remove();
      if (!items.querySelector('.item-fields')) addItem(true);
    });
    fields.append(remove);
    items.append(fields);
    if (focus) itemTitle.focus();
  }
  addItem();
  const add = button(copy('新增項目'));
  add.addEventListener('click', () => addItem(true));
  const submit = button(copy('建立草稿'), 'primary', 'submit');
  const feedback = note();
  form.append(items, add, submit, feedback);
  operation(submit, feedback, () => context.command('create_delivery', {
    title: title.value.trim(), description: description.value.trim(),
    items: [...items.querySelectorAll('.item-fields')].map(fields => ({
      title: fields.querySelector('[name=itemTitle]').value.trim(), status: fields.querySelector('select').value,
    })),
  }), () => context.refresh(copy('已建立交付草稿。')), form, context.onError);
  return form;
}

function setupShare(row, context) {
  const section = node('div');
  const trigger = button(copy('預覽分享內容'));
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
    permissions.append(node('legend', copy('持有連結的人可以查看交付內容，也可執行下列選定的操作')));
    for (const [value, label] of [['comment', copy('留言')], ['approve', copy('批准或要求修改')]]) {
      const wrapper = node('label', null, { class: 'choice' });
      wrapper.append(node('input', null, { type: 'checkbox', name: 'permission', value }), node('span', label));
      permissions.append(wrapper);
    }
    const expiry = field(form, copy('連結權限到期（本地時間）'), 'expiry', { type: 'datetime-local', required: '', value: dateInput(Date.now() + 86400000) });
    form.append(permissions);
    const submit = button(copy('建立唯讀連結或授予上述操作'), 'primary', 'submit');
    const shareFeedback = note();
    form.append(submit, shareFeedback);
    preview.replaceChildren(heading(result.title, result.description, 'h3'), itemList(result.items), form);
    operation(submit, shareFeedback, () => context.command('create_share', {
      deliveryId: result.deliveryId, previewVersion: result.previewVersion,
      permissions: ['view', ...new FormData(form).getAll('permission')], expiresAt: new Date(expiry.value).toISOString(),
    }), () => context.refresh(copy('已建立分享。請從分享清單產生連結。')), form, context.onError);
  }, trigger, context.onError);
  return section;
}

function deliveries(rows, context) {
  const section = panel(copy('交付清單'));
  if (context.can('create_delivery')) {
    const create = node('details');
    create.append(node('summary', copy('新增交付')), deliveryForm(context));
    section.append(create);
  }
  listState(section, rows,copy('目前沒有交付項目。'));
  for (const row of rows ?? []) {
    const item = node('article', null, { class: 'record' });
    item.append(node('h3', row.data.title), badge(row.data.status), node('p', row.data.description, { class: 'muted copy' }), itemList(row.data.items));
    if (row.data.status === 'draft' && context.can('publish_delivery')) {
      const publish = button(copy('發布交付'), 'primary');
      const feedback = note();
      item.append(publish, feedback);
      operation(publish, feedback, () => context.command('publish_delivery', { id: row.id, version: row.version }),
        () => context.refresh(copy('已發布交付。')), publish, context.onError);
    }
    if (row.data.status === 'published' && context.can('preview_share') && context.can('create_share')) item.append(setupShare(row, context));
    section.append(item);
  }
  return section;
}

function shares(rows, context, deliveryTitles) {
  const section = panel(copy('分享連結'), copy('產生的連結有效期最長為 15 分鐘，且不會晚於分享權限到期時間。'));
  listState(section, rows,copy('目前沒有分享。'));
  for (const row of rows ?? []) {
    const item = node('article', null, { class: 'record' });
    const { deliveryId, expiresAt, decision } = row.data;
    const state = row.data.status === 'active' && Date.parse(expiresAt) <= Date.now() ? 'expired' : row.data.status;
    item.append(node('h3', deliveryTitles.get(deliveryId) || copy('交付分享')), badge(state));
    if (expiresAt) item.append(node('p', () => `${copy('到期')()} · ${date(expiresAt)}`, { class: 'muted' }));
    if (decision?.action) item.append(decisionNote(decision));
    if (state === 'active' && context.can('create_share')) {
      const generate = button(copy('產生連結'));
      const feedback = note();
      const output = node('div');
      item.append(generate, feedback, output);
      operation(generate, feedback, () => context.mint(row.id), result => {
        if (typeof result?.token !== 'string' || !result.token) throw new Error('Invalid share token');
        const url = new URL(`/share#${encodeURIComponent(result.token)}`, location.origin).href;
        output.replaceChildren();
        const link = field(output, copy('分享網址'), 'shareLink', { readonly: '', value: url });
        const copyButton = button(copy('複製網址'));
        const copyStatus = note();
        copyButton.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(url);
            writeText(copyStatus, copy('已複製網址。'));
          } catch {
            link.focus();
            link.select();
            writeText(copyStatus, copy('請複製已選取的網址。'));
          }
        });
        output.append(copyButton, copyStatus);
        link.focus();
        link.select();
      }, generate, context.onError);
    }
    if (state === 'active' && context.can('revoke_share')) {
      const controls = node('details');
      const revoke = button(copy('確認撤銷'));
      const feedback = note();
      controls.append(node('summary', copy('撤銷分享')), revoke, feedback);
      item.append(controls);
      operation(revoke, feedback, () => context.command('revoke_share', { id: row.id, version: row.version }),
        () => context.refresh(copy('已撤銷分享。')), revoke, context.onError);
    }
    section.append(item);
  }
  return section;
}

function decisionNote(decision) {
  const result = node('div');
  result.append(badge(decision.action));
  if (date(decision.at)) result.append(node('span', () => ` ${date(decision.at)}`, { class: 'muted' }));
  return result;
}

function signedShare() {
  let token;
  try { token = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed link */ }
  function unavailable() {
    show(heading(copy('無法開啟分享'), copy('此連結可能已失效。請向原分享者取得新連結。')));
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
    const details = panel(copy('交付項目'));
    details.append(itemList(data.items));
    const review = panel(copy('審閱'));
    const comments = Array.isArray(data.comments) ? data.comments : [];
    if (data.decision?.action) review.append(decisionNote(data.decision));
    if (comments.length) {
      const list = node('ul', null, { class: 'comments' });
      for (const entry of comments) {
        const comment = node('li');
        comment.append(node('p', entry?.text, { class: 'copy' }), node('span', () => date(entry?.at), { class: 'muted' }));
        list.append(comment);
      }
      review.append(list);
    }
    if (permissions.includes('comment')) {
      const form = node('form');
      const text = field(form, copy('留言內容'), 'comment', { multiline: true, rows: '3', maxlength: '2000', required: '' });
      const submit = button(copy('送出留言'), 'primary', 'submit');
      const feedback = note();
      form.append(submit, feedback);
      review.append(form);
      operation(submit, feedback, () => share({ action: 'comment', text: text.value.trim() }),
        result => render(result, copy('已送出留言。')), form, shareError);
    }
    if (permissions.includes('approve') && !data.decision) {
      const form = node('form');
      const action = select(form, copy('審閱結果'), 'decision', [['', copy('選擇審閱結果')], ['approve', copy('批准')], ['request_changes', copy('要求修改')]]);
      action.required = true;
      const submit = button(copy('確認審閱結果'), 'primary', 'submit');
      const feedback = note();
      form.append(submit, feedback);
      review.append(form);
      operation(submit, feedback, () => share({ action: action.value }), result => render(result, copy('已送出審閱結果。')), form, shareError);
    }
    const columns = node('div', null, { class: 'share-layout' });
    columns.append(details);
    if (review.children.length > 1) columns.append(review);
    const shareHeading = heading(data.title, data.description);
    shareHeading.classList.add('share-heading');
    show(shareHeading, note(message), columns);
    setTitle(data.title);
    if (focusHeading) app.querySelector('h1').focus();
  }
  share({}).then(data => render(data, '', false)).catch(error => {
    if ([401, 403, 404, 410].includes(error.status)) unavailable();
    else {
      const retry = button(copy('重試'));
      retry.addEventListener('click', signedShare);
      show(heading(copy('暫時無法載入分享')), retry);
    }
  });
}

function creatorSubmission() {
  let token;
  try { token = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed link */ }
  if (!token) {
    show(heading(copy('無法開啟交付'), copy('請向邀請您的團隊取得有效連結。')));
    return;
  }
  const section = node('section', null, { class: 'panel auth' });
  const form = node('form');
  const url = field(form, copy('貼文網址（HTTPS）'), 'post_url', { type: 'url', required: '', maxlength: '2048' });
  const submit = button(copy('送出貼文網址'), 'primary', 'submit');
  const status = note();
  form.append(submit, status);
  section.append(heading(copy('創作者交付'), copy('提交已發布的貼文網址。')), form);
  show(section);
  operation(submit, status, async () => {
    let postUrl;
    try { postUrl = new URL(url.value.trim()); } catch { throw new Error('invalid_post_url'); }
    if (postUrl.protocol !== 'https:' || postUrl.username || postUrl.password) {
      throw new Error('invalid_post_url');
    }
    const response = await request('/api/portal/creator-submit', {
      method: 'POST', body: { token, post_url: postUrl.href }, credentials: 'omit',
    });
    if (response?.data?.accepted !== true) throw new Error('Unexpected response');
  }, () => {
    show(heading(copy('已收到您的請求'), copy('貼文網址已送出。')));
    app.querySelector('h1').focus();
  }, form, (error, feedback) => {
    if (error.message === 'invalid_post_url') writeText(feedback, copy('請輸入有效的 HTTPS 貼文網址。'));
    else if ([401, 403, 404, 410].includes(error.status)) {
      writeText(feedback, copy('請向邀請您的團隊取得有效連結。'));
    } else errorMessage(error, feedback);
  });
}

writeText(document.querySelector('.desktop-notice'), copy('此門戶為桌面版。建議使用寬度至少 1280px 的電腦瀏覽器。'));
writeText(document.querySelector('.header-label'), copy('客戶門戶'));
setTitle(copy('客戶門戶'));
writeText(app.querySelector('[role=status]'), copy('載入中…'));
applyLocale();

if (/^\/share\/?$/.test(location.pathname)) {
  signedShare();
  addEventListener('hashchange', () => location.reload());
} else if (/^\/creator\/?$/.test(location.pathname)) {
  creatorSubmission();
  addEventListener('hashchange', () => location.reload());
} else if (location.pathname === '/') {
  startSession();
} else {
  show(heading(copy('找不到此頁面')), node('a', copy('返回門戶'), { href: '/' }));
}
