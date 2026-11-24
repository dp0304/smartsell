'use strict';

const api = window.connector;
const byId = id => document.getElementById(id);
const text = (id, value) => {
  const element = byId(id);
  if (element.textContent !== value) element.textContent = value;
};
const show = (id, visible) => { byId(id).hidden = !visible; };
const names = { douyin: '抖音', xhs: '小红书', tiktok: 'TikTok' };
const providers = { shopify: 'Shopify', tiktok_shop: 'TikTok Shop', amazon_sp: 'Amazon', shopee: 'Shopee', lazada: 'Lazada', file_import: '文件导入', other: '其他商城' };
const providerName = provider => Object.hasOwn(providers, provider) ? providers[provider] : provider;
const taskKinds = {
  'douyin.video.publish': '发布视频',
  'xhs.note.publish': '发布笔记',
  'post.capture_result': '登记作品结果',
  'post.verify_visible': '核实作品可见性',
  'tiktok.app.publish': 'App 发布',
  'session.verify_identity': '核验会话账号',
  'mobile.verify_app_identity': '核验 App 账号',
  'mobile.push_media': '发送媒体到手机',
  'mobile.cleanup_media': '清理手机媒体',
};
const time = value => new Date(value).toLocaleTimeString();
let attempt;
let catalogSelection;
let suggestedAddress;
let applying = false;
let pairing = false;
let revision = 0;
let latestActivity;
const activityActions = {
  pair: ['◇', '配对设备', '绑定工作台工作区'],
  connect: ['↗', '连接设备', '检查设备与工作台的连线'],
  chromeConnect: ['↗', '连接专用 Chrome', '检查本机 Chrome 会话'],
  disconnect: ['↙', '断开设备', '结束本机连线'],
  stop: ['■', '紧急停止', '中止本机操作'],
  forget: ['×', '注销配对', '清除本机配对记录'],
  heartbeat: ['↯', '连接检查', '工作台心跳'],
  lease: ['◷', '任务到期', '检查任务租约'],
  claim: ['↓', '收到浏览器任务', '收到工作台派发'],
  creator: ['↗', '打开官方页面', '打开创作者页面'],
  verify: ['✓', '核验会话', '核对工作台浏览器账号'],
  media: ['▧', '选取媒体', '读取本机文件摘要'],
  confirm: ['✓', '确认交接', '核对任务账号与内容'],
  report: ['↑', '回填结果', '发送任务结果到工作台'],
  block: ['■', '中止任务', '回填平台限制'],
  retry: ['↻', '重试回填', '重发同一条任务报告'],
  channelScan: ['✓', '检查本机渠道', '检查专用 Chrome'],
  channelRegister: ['↑', '登记所选渠道', '提交所选社媒账号和商城店铺'],
  catalogLease: ['◷', '商品任务到期', '检查商品任务租约'],
  catalogClaim: ['↓', '收到商品任务', '收到工作台派发'],
  catalogPortal: ['↗', '打开卖家后台', '在系统浏览器打开官方页面'],
  catalogFile: ['▧', '选取商品导出表', '读取本机的商品资料'],
  catalogUpload: ['↑', '提交商品表预览', '向工作台发送商品资料'],
};
const activityTime = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'medium' });

function connectionCopy({ storageIssue, origin, paired, serviceMatches, connected, online, busy, connectionIssue, workbench, task, catalog, storageCheckFailed, awaitingAuthorization }) {
  const checkDevice = workbench ? '打开工作台检查设备授权。' : '在工作台检查设备授权。';
  if (storageIssue) return ['离线 · 配对记录不可读', '系统安全存储中的配对记录无法读取。', '检查系统授权后重试读取。', 'warning'];
  if (awaitingAuthorization) return ['等待浏览器授权', '请在系统浏览器授权这台设备。', '授权后返回 Worker。', 'neutral'];
  if (storageCheckFailed) return ['离线 · 安全存储未通过', '本机配对需要系统安全存储。', '检查系统授权后重试。', 'warning'];
  if (!origin) return ['离线 · 服务未配置', '还未连接工作台。', '在首次设置中完成工作台授权。', 'warning'];
  if (!serviceMatches) return ['离线 · 配对服务不匹配', '现有配对属于另一服务。', '确认目标服务后，注销本机配对并重新绑定。', 'warning'];
  if (connected && online) {
    if (busy) return ['在线', '工作台已确认设备在线，连接器正在处理请求。', '请求完成后可继续操作。', 'success'];
    if (task?.pending) return ['在线', '有一条任务报告等待工作台确认。', '在当前任务中重试同一条报告。', 'success'];
    if (task) return ['在线', '工作台已确认设备在线，有一项社媒任务。', '在下方继续核对账号或回填结果。', 'success'];
    if (catalog && !catalog.expired) return ['在线', '工作台已确认设备在线，有一项商品导入任务。', '在商城区域继续核对店铺和商品表。', 'success'];
    return ['在线', '工作台已确认设备在线，可以处理任务。', '在终端通过 SmartSell MCP 发起任务，Worker 会接收本机任务。', 'success'];
  }
  if (connectionIssue === 'stopped') return ['离线 · 已紧急停止', '本机连接与操作已停止。', paired ? '停止操作已打开的官方页面，确认安全后可手动重新连接。' : '确认安全后可配对设备。', 'warning'];
  if (connectionIssue === 'authorization') return ['离线 · 设备未获授权', '服务拒绝了此设备的请求。', checkDevice, 'warning'];
  if (connectionIssue === 'heartbeat' || connectionIssue === 'connect') return ['离线 · 连线失败', '未收到工作台的在线确认。', '检查网络与服务后，手动重新连接。', 'warning'];
  if (connectionIssue === 'lease' || connectionIssue === 'fence') return ['离线 · 任务已停止', connectionIssue === 'lease' ? '任务租约已过期。' : '服务拒绝了当前任务令牌。', '先到工作台核实任务结果，再手动连接。', 'warning'];
  if (paired) return ['已断开', '本机配对已保留。', task?.pending ? '重新连接后，重试待回填的报告。' : '连接后自动接收本机任务。', 'neutral'];
  return ['未配对', '此设备尚未绑定工作区。', '在首次设置中完成工作台授权。', 'neutral'];
}

const channelLabels = { unverified: '未验证', login: '需登录', verified: '已验证', expired: '已过期', changed: '身份已切换' };
const channelElements = new Map();
const setupChannels = new Map();
let setupState;

async function changeSetupSelection(id, selected) {
  const ids = setupState.setupChannels || [];
  await invoke('setupChannels', selected ? [...ids, id] : ids.filter(value => value !== id));
  byId('setup-channel-select').focus();
}

function renderSetup(state) {
  setupState = state;
  const { paired, secureStorage, storageCheckFailed, awaitingAuthorization, connected, online, connectionIssue,
    serviceMatches, chromeSetup, channelRows = [], channelStates = {}, busy } = state;
  const setupSelected = new Set(state.setupChannels);
  const signed = connected && online;
  const chrome = Boolean(chromeSetup?.connected);
  const selected = channelRows.filter(({ id }) => setupSelected.has(id));
  const verified = selected.filter(({ id }) => channelStates[id]?.status === 'verified').length;
  const allVerified = selected.length > 0 && verified === selected.length;
  const steps = [
    ['storage', secureStorage, storageCheckFailed ? '需重试' : '待检查'],
    ['pair', paired, awaitingAuthorization ? '等待浏览器' : '待授权'],
    ['signature', signed, connectionIssue ? '需重试' : '待连接'],
    ['chrome', chrome, chromeSetup?.error ? '需重试' : '待连接'],
    ['channels', allVerified, selected.length ? `${verified} / ${selected.length} 已验证` : '按需选择'],
  ];
  const current = steps.find(([, done]) => !done)?.[0];
  for (const [id, done, pending] of steps) {
    const step = byId(`setup-${id}`);
    step.dataset.complete = String(Boolean(done));
    if (id === current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
    text(`setup-${id}-status`, done && id !== 'channels' ? '已通过' : pending);
  }
  text('setup-progress', `${steps.filter(([, done]) => done).length} / ${steps.length} 项通过`);
  const storageName = state.platform === 'win32' ? 'Windows 系统加密' : 'macOS 钥匙串';
  const next = {
    storage: `检查${storageName}能否加密并恢复配对密钥。如果系统询问，请在系统窗口决定是否授权。`,
    pair: awaitingAuthorization ? '请在系统浏览器同意授权，或在此取消后重试。' : '填写工作台网址，确认本机所有权，再到系统浏览器授权。也可粘贴工作台已发出的配对网址。',
    signature: serviceMatches ? '连接工作台，等待签名心跳确认。' : '当前服务与已保存的配对不匹配。',
    chrome: chromeSetup?.error || '打开并检查 Worker 的专用 Google Chrome 会话。',
    channels: '只添加你需要的平台。在官方页面登录后，使用对应渠道的「验证」。',
  };
  text('setup-next', current ? next[current] : '所选平台身份已核验。');
  show('setup-check-storage', current === 'storage');
  show('pair', state.canPairWorkbench);
  show('connect-actions', paired && serviceMatches && !connected);
  show('setup-connect-chrome', current === 'chrome');
  show('setup-channel-picker', current === 'channels' || !current);
  show('setup-channel-list', selected.length > 0);
  const select = byId('setup-channel-select');
  const options = channelRows.filter(({ id }) => !setupSelected.has(id));
  if (Array.from(select.options).slice(1).map(option => option.value).join() !== options.map(({ id }) => id).join()) {
    select.replaceChildren(new Option('选择平台', ''), ...options.map(({ id, name }) => new Option(name, id)));
  }
  byId('setup-add-channel').disabled = busy || applying || !select.value;
  for (const [id, row] of setupChannels) {
    if (setupSelected.has(id)) continue;
    row.remove();
    setupChannels.delete(id);
  }
  for (const { id, name } of selected) {
    if (!setupChannels.has(id)) {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#${id}-status`;
      link.textContent = name;
      link.addEventListener('click', event => {
        event.preventDefault();
        const [open] = channelElements.get(id)?.buttons ?? [];
        open?.scrollIntoView({ block: 'center' });
        open?.focus();
      });
      const status = document.createElement('span');
      status.id = `setup-channel-status-${id}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '移除';
      remove.setAttribute('aria-label', `移除 ${name}`);
      remove.addEventListener('click', () => void changeSetupSelection(id, false));
      row.append(link, status, remove);
      setupChannels.set(id, row);
      byId('setup-channel-list').append(row);
    }
    const channel = channelStates[id];
    text(`setup-channel-status-${id}`, channel?.unavailable ? 'Chrome 未安装' : channelLabels[channel?.status || 'unverified']);
  }
}

async function channelAction(id, action) {
  if (applying) return;
  const { badge, buttons } = channelElements.get(id);
  badge.textContent = action === 'open' ? '正在打开…' : '正在验证…';
  buttons.forEach(button => { button.disabled = true; });
  try { await invoke(action === 'open' ? 'channelOpen' : 'channelVerify', id); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

function selectedChannels() {
  return [...channelElements.values()].filter(row => row.check.checked && row.selection).map(row => row.selection);
}

function renderSelection(canRegister) {
  const count = selectedChannels().length;
  byId('channel-register').disabled = !canRegister || applying || !count;
  text('channel-selection-note', count ? `已选择 ${count} 个渠道` : '请勾选已验证且可登记的渠道。');
}

function renderIntegrations({ channelRows = [], channelStates = {}, connected, online, pendingBrowserAccounts, busy, registrations = [] }) {
  const live = connected && online;
  const canRegister = live && !busy;
  show('channel-enrollment', live);
  for (const { id, group, name, mark, help, supportsRegistration } of channelRows) {
    if (channelElements.has(id)) continue;
    const row = byId('channel-row').content.firstElementChild.cloneNode(true);
    row.dataset.channel = id;
    row.querySelector('.platform-mark').textContent = mark;
    row.querySelector('.channel-name').textContent = name;
    row.querySelector('.channel-help p').textContent = help;
    const badge = row.querySelector('.platform-status');
    badge.id = `${id}-status`;
    const buttons = [...row.querySelectorAll('button')];
    for (const button of buttons) {
      button.setAttribute('aria-label', `${button.textContent} ${name}`);
      button.addEventListener('click', () => void channelAction(id, button.dataset.action));
    }
    const label = row.querySelector('.channel-select');
    const check = label.querySelector('input');
    label.querySelector('span').textContent = `选择 ${name}`;
    check.addEventListener('change', () => renderSelection(!byId('channel-enrollment').hidden));
    channelElements.set(id, { badge, buttons, label, check, group, supportsRegistration,
      registration: row.querySelector('.channel-registration'), proof: row.querySelector('.channel-proof'), note: row.querySelector('.channel-note') });
    byId(`${group}-channels`).append(row);
  }
  for (const [id, row] of channelElements) {
    const { badge, proof, note, check, label, group, registration, supportsRegistration } = row;
    const { status = 'unverified', identity, checkedAt, previousIdentity, note: detail, unavailable, registrationPlatform } = channelStates[id] || {};
    const selectable = live && status === 'verified' && Boolean(registrationPlatform);
    if (!selectable || row.selection?.identity !== identity || row.selection?.checkedAt !== checkedAt) check.checked = false;
    row.selection = selectable ? { id, identity, checkedAt } : undefined;
    label.hidden = !selectable;
    check.disabled = !canRegister || applying || !selectable;
    const confirmed = registrations.some(item => item.kind === (group === 'commerce' ? 'store' : 'social') &&
      item.platform === registrationPlatform && item.external_id === identity);
    const registrationText = confirmed ? '工作台已确认登记' : live && status === 'verified' && !registrationPlatform
      ? (supportsRegistration ? '请在官方页面显示稳定账号 ID 后重新验证。' : '此渠道可在本机验证。') : '';
    if (registration.textContent !== registrationText) registration.textContent = registrationText;
    registration.hidden = !registrationText;
    text(badge.id, unavailable ? 'Chrome 未安装' : channelLabels[status]);
    badge.dataset.tone = unavailable || ['login', 'expired', 'changed'].includes(status) ? 'warning' : status === 'verified' ? 'success' : 'neutral';
    const time = checkedAt && activityTime.format(new Date(checkedAt));
    const evidence = status === 'changed' ? `${previousIdentity} → ${identity} · 上次验证 ${time}`
      : identity && time ? `${identity} · ${status === 'verified' ? '验证于' : '上次验证'} ${time}` : '';
    if (proof.textContent !== evidence) proof.textContent = evidence;
    proof.hidden = !evidence;
    if (note.textContent !== (detail || '')) note.textContent = detail || '';
    note.hidden = !detail;
  }
  renderSelection(canRegister);
  text('pending-browser-identity', live && pendingBrowserAccounts
    ? `${pendingBrowserAccounts} 个账号等待核对。请在本机 Chrome 显示对应的官方账号资料，Worker 会自动核对。` : '');
}

function renderActivity(activity = []) {
  const latest = activity[0]?.id ?? 0;
  if (latestActivity === latest) return;
  latestActivity = latest;
  show('activity-empty', !activity.length);
  show('activity-list', Boolean(activity.length));
  byId('activity-list').replaceChildren(...activity.map(event => {
    const [glyph, action, description] = activityActions[event.action] || ['·', '本机操作', ''];
    const row = document.createElement('li');
    row.dataset.tone = event.tone;
    const icon = document.createElement('span');
    icon.className = 'activity-glyph';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = glyph;
    const label = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = action;
    const detail = document.createElement('div');
    detail.className = 'muted';
    detail.textContent = event.catalogProvider
      ? [providerName(event.catalogProvider), event.catalogStore].filter(Boolean).join(' · ')
      : [names[event.app], taskKinds[event.kind] || description].filter(Boolean).join(' · ');
    label.append(title, detail);
    const result = document.createElement('span');
    result.className = 'activity-result';
    result.textContent = event.result;
    const timestamp = document.createElement('time');
    timestamp.dateTime = event.time;
    timestamp.textContent = activityTime.format(new Date(event.time));
    row.append(icon, label, result, timestamp);
    return row;
  }));
}

function workspaceCopy(task) {
  if (task?.pending) return ['当前任务', '任务状态等待工作台确认。'];
  if (task?.until) return ['当前任务', '账号核对已完成，任务已交接。'];
  if (task) return ['当前任务', '请按任务要求核对账号、审批版本和媒体。'];
  return ['任务交接', '等待工作台派发任务。'];
}

function renderCatalog({ catalog, catalogResult, connected, online, workbench }) {
  const active = catalog && !catalog.expired;
  const controls = active && connected && online;
  const file = controls && catalog.file;
  const selection = file && `${catalog.id}/${catalog.expires}/${file.name}/${file.size}`;
  if (catalogSelection !== selection) {
    byId('catalog-upload-form').reset();
    catalogSelection = selection;
  }
  show('catalog-job', Boolean(catalog));
  show('catalog-controls', Boolean(controls));
  show('catalog-portal', Boolean(controls && catalog.canOpenPortal));
  show('catalog-upload-form', Boolean(file));
  show('catalog-retry', Boolean(catalog?.uploadUnconfirmed));
  show('catalog-result', Boolean(catalogResult));
  show('catalog-return-actions', Boolean(workbench));
  text('catalog-picked', file ? `已选择 ${file.name}（${Math.ceil(file.size / 1000)} KB）` : '');
  if (catalog) {
    text('catalog-store', `${catalog.store} · ${providerName(catalog.provider)}`);
    text('catalog-external-id', catalog.externalId);
    text('catalog-lease', catalog.expired ? '已结束。请在工作台核对状态。' : `有效至 ${activityTime.format(new Date(catalog.expires))}`);
    text('catalog-portal-help', catalog.canOpenPortal
      ? '请在该店铺专用浏览器配置中登录官方卖家后台，核对店铺并导出商品。'
      : '此任务没有可安全打开的卖家后台链接。请在店铺专用浏览器配置中打开官方后台并导出商品。');
  }
  if (catalogResult) text('catalog-import', `导入 ID ${catalogResult.import_id}。请在工作台核对并确认导入。`);
}

function render(state) {
  const { task, busy, connected } = state;
  const handedOff = Boolean(task?.until);
  const previousFocus = document.activeElement;
  if (attempt !== task?.id) {
    for (const id of ['confirm', 'outcome']) byId(id).reset();
    for (const id of ['task-details', 'challenge']) byId(id).open = false;
    attempt = task?.id;
  }
  const [status, note, next, tone] = connectionCopy(state);
  const [heading, intro] = workspaceCopy(task);
  text('connection', status);
  text('connection-note', note);
  text('connection-next', next);
  byId('connection').dataset.tone = tone;
  text('workspace-id', state.workspace || '—');
  text('device-id', state.device || '—');
  text('machine-name', state.machineName || '—');
  text('pair-machine', state.machineName || '');
  text('channel-machine', state.machineName || '');
  text('origin', state.origin || '正式服务未配置');
  show('workspace-panel', Boolean(task));
  const address = state.workbench || state.origin || '';
  if (suggestedAddress !== address) {
    suggestedAddress = address;
    if (!byId('pair').elements.url.value) byId('pair').elements.url.value = address;
  }
  text('workspace-heading', heading);
  text('workspace-note', intro);
  text('message', state.message);
  show('disconnect', connected);
  show('forget', state.paired || state.storageIssue);
  show('workbench', Boolean(state.workbench));
  renderCatalog(state);
  show('task', Boolean(task));
  if (task) {
    text('task-meta', `${names[task.app] || task.app} · ${taskKinds[task.kind] || task.kind} · 租约至 ${time(task.expires)}`);
    text('task-id', task.id);
    text('task-identity', task.identity);
    text('task-post', task.expectedPost || '');
    show('task-post-row', Boolean(task.expectedPost));
    show('revision-label', Boolean(task.revision));
    show('revision', Boolean(task.revision));
    if (task.revision) {
      const ref = task.revision;
      text('revision', [ref.title, ref.body, ref.tags.join(' / '), `可见范围 ${ref.visibility}`, ...ref.media.map(item => `${item.id}  ${item.sha256}`)].join('\n'));
    }
    show('prepare', connected && !task.pending && !handedOff && task.channel === 'browser');
    show('media', Boolean(task.revision?.media.length));
    show('media-note', Boolean(task.revision?.media.length));
    show('picked', Boolean(task.media.length));
    text('picked', task.media.map(item => `${item.name}  ${item.hash}`).join('\n'));
    text('task-proof', task.identityMatched ? '已从专用 Chrome 读取并核对账号。' : '请在专用 Chrome 打开官方页面并显示账号资料。');
    show('confirm', task.portal && task.kind !== 'session.verify_identity');
    text('confirm-label', task.revision ? '我有权操作该账号，已在其专用浏览器配置中准备审批版本，核对了账号、内容和可见范围，尚未提交。'
      : '我有权操作该账号，并已在其专用浏览器配置中核对实际登录账号。');
    show('outcome', connected && !task.pending && handedOff);
    if (handedOff) {
      const expired = Date.now() >= task.until;
      byId('handoff').dataset.tone = expired ? 'warning' : 'neutral';
      text('handoff', expired ? '交接窗口已结束。请勿再次提交作品。' : task.revision
        ? `请在 ${time(task.until)} 前在官方页面亲自提交一次。找不到证据时可回填结果未知。` : '请在官方页面核对原作品并回填观察结果。');
    }
    show('receipt', task.kind !== 'post.verify_visible');
    show('captured', task.kind === 'post.capture_result');
    show('submitted', Boolean(task.revision));
    show('visible', task.kind === 'post.verify_visible');
    show('not-visible', task.kind === 'post.verify_visible');
    show('challenge', connected && !task.pending);
    show('pending', Boolean(task.pending));
    text('pending-note', task.pending === 'outcome_unknown'
      ? '待回填的报告标记为结果未知。可重试发送同一条报告，请勿重复提交作品。'
      : '可重试发送同一条报告，请勿重复执行任务。');
  }
  for (const element of document.querySelectorAll('button, input, select')) {
    if (!['stop', 'disconnect'].includes(element.id)) element.disabled = busy || applying;
  }
  show('cancel-authorization', state.awaitingAuthorization);
  byId('cancel-authorization').disabled = false;
  text('update-status', state.updates.status);
  show('update-actions', state.updates.enabled);
  byId('update-check').disabled = !state.updates.enabled || state.updates.busy || state.updates.ready || applying;
  show('update-install', state.updates.ready);
  const hasTask = Boolean(task || state.zhihu || (state.catalog && !state.catalog.expired));
  show('update-task-note', state.updates.ready && hasTask);
  byId('update-install').disabled = hasTask || busy || applying;
  renderIntegrations(state);
  renderSetup(state);
  renderActivity(state.activity);
  if (previousFocus?.closest('[hidden]') || (previousFocus?.tagName !== 'SUMMARY' && previousFocus?.closest('details:not([open])'))) {
    if (previousFocus.closest('.setup')) byId('setup-heading').focus();
    else if (previousFocus.closest('#catalog-job') && state.catalogResult) byId('catalog-result-heading').focus();
    else if (previousFocus.closest('#catalog-job') && state.catalog) byId('catalog-job-heading').focus();
    else byId(byId('workspace-panel').hidden ? 'device-heading' : 'workspace-heading').focus();
  }
}

async function invoke(action, arg, display = true) {
  const urgent = action === 'stop' || action === 'disconnect';
  if (display && applying && !urgent) return;
  const errorTarget = /Catalog|^catalog/.test(action) ? 'catalog-error'
    : ['channelScan', 'channelRegister'].includes(action) ? 'channel-error'
      : ['checkStorage', 'connectChrome', 'setupChannels', 'pair', 'connect'].includes(action) ? 'setup-error' : 'error';
  const order = display ? ++revision : revision;
  if (display) {
    applying = true;
    text('error', '');
    text('catalog-error', '');
    text('channel-error', '');
    text('setup-error', '');
  }
  try {
    const reply = await api[action](arg);
    if (order !== revision) return;
    if (display) { revision++; applying = false; text(errorTarget, reply.error || ''); }
    if (reply.state) render(reply.state);
    return reply;
  } catch {
    if (order === revision && display) { applying = false; text(errorTarget, '连接器窗口暂时无法访问本机服务。'); }
  }
}

for (const [id, action] of Object.entries({ stop: 'stop', connect: 'connect', disconnect: 'disconnect', forget: 'forget',
  'setup-check-storage': 'checkStorage', 'setup-connect-chrome': 'connectChrome',
  workbench: 'workbench', creator: 'creator', media: 'media', report: 'report', 'update-check': 'updateCheck', 'update-install': 'updateInstall',
  'catalog-portal': 'catalogPortal', 'catalog-return': 'workbench' })) {
  byId(id).addEventListener('click', () => void invoke(action));
}
byId('setup-channel-select').addEventListener('change', () => renderSetup(setupState));
byId('setup-add-channel').addEventListener('click', () => {
  const select = byId('setup-channel-select');
  if (!select.value) return;
  void changeSetupSelection(select.value, true);
});
byId('channel-scan').addEventListener('click', () => void invoke('channelScan'));
byId('channel-register').addEventListener('click', async () => {
  const selections = selectedChannels();
  if (!selections.length || applying) return;
  const reply = await invoke('channelRegister', { confirmed: true, selections });
  if (reply && !reply.error) {
    for (const row of channelElements.values()) row.check.checked = false;
    renderSelection(!byId('channel-enrollment').hidden);
  }
});
byId('cancel-authorization').addEventListener('click', () => void api.cancelAuthorization());
byId('catalog-file').addEventListener('click', () => {
  byId('catalog-upload-form').reset();
  void invoke('catalogFile');
});
byId('catalog-upload-form').addEventListener('submit', event => {
  event.preventDefault();
  const { observed, confirmed } = event.currentTarget.elements;
  const body = { observed: observed.value.trim(), confirmed: confirmed.checked };
  confirmed.checked = false;
  void invoke('uploadCatalog', body);
});
byId('block').addEventListener('click', () => void invoke('block', { reason: byId('reason').value }));
byId('pair').addEventListener('submit', async event => {
  event.preventDefault();
  if (applying) return;
  const { url, owns } = event.currentTarget.elements;
  const body = { url: url.value.trim(), ownsDevice: owns.checked };
  const address = URL.parse(body.url);
  if (address && address.hash) {
    address.hash = '';
    url.value = address.href;
  }
  owns.checked = false;
  pairing = true;
  try { await invoke('pair', body); }
  finally { pairing = false; }
});
byId('confirm').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const confirmed = form.elements.confirmed.checked;
  form.reset();
  void invoke('confirm', { confirmed });
});
byId('outcome').addEventListener('submit', event => {
  event.preventDefault();
  const result = event.submitter?.value;
  if (!result) return;
  const receipt = Object.fromEntries([...new FormData(byId('outcome'))].map(([name, value]) => [name, value.trim()]));
  const include = ['captured', 'submitted'].includes(result) && Object.values(receipt).some(Boolean);
  void invoke('finish', { result, ...(include && { receipt }) });
});
void invoke('state', undefined, false);
setInterval(() => { if (!applying || pairing) void invoke('state', undefined, false); }, 750);
