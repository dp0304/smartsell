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
let serviceOrigin;
let applying = false;
let revision = 0;
let latestActivity;
let lastStoreSummary;
const activityActions = {
  pair: ['◇', '配对设备', '绑定工作台工作区'],
  connect: ['↗', '连接设备', '检查设备与工作台的连线'],
  disconnect: ['↙', '断开设备', '结束本机连线'],
  stop: ['■', '紧急停止', '中止本机操作'],
  forget: ['×', '注销配对', '清除本机配对记录'],
  heartbeat: ['↯', '连接检查', '工作台心跳'],
  lease: ['◷', '任务到期', '检查任务租约'],
  claim: ['↓', '领取任务', '检查工作台队列'],
  creator: ['↗', '打开官方页面', '打开创作者页面'],
  verify: ['✓', '核验会话', '核对工作台浏览器账号'],
  media: ['▧', '选取媒体', '读取本机文件摘要'],
  confirm: ['✓', '确认交接', '核对任务账号与内容'],
  report: ['↑', '回填结果', '发送任务结果到工作台'],
  block: ['■', '中止任务', '回填平台限制'],
  retry: ['↻', '重试回填', '重发同一条任务报告'],
  service: ['⚙', '设置服务', '配置工作台服务地址'],
  catalogLease: ['◷', '商品任务到期', '检查商品任务租约'],
  catalogClaim: ['↓', '领取商品任务', '检查工作台的商品任务'],
  catalogPortal: ['↗', '打开卖家后台', '在系统浏览器打开官方页面'],
  catalogFile: ['▧', '选取商品导出表', '读取本机的商品资料'],
  catalogUpload: ['↑', '提交商品表预览', '向工作台发送商品资料'],
};
const activityTime = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'medium' });

function connectionCopy({ storageIssue, secureStorage, origin, paired, serviceMatches, connected, online, busy, connectionIssue, workbench, task, catalog, canSetOrigin }) {
  const checkDevice = workbench ? '打开工作台检查设备授权。' : '在工作台检查设备授权。';
  if (storageIssue) return ['离线 · 配对记录不可读', '系统安全存储中的配对记录无法读取。', '注销本机配对后重新绑定。', 'warning'];
  if (!origin) return ['离线 · 服务未配置', '缺少服务地址，无法连接或配对。', canSetOrigin ? '展开「设置服务地址」，填写工作台提供的地址。' : '请向管理员获取已配置服务的连接器。', 'warning'];
  if (!serviceMatches) return ['离线 · 配对服务不匹配', '现有配对属于另一服务。', '确认目标服务后，注销本机配对并重新绑定。', 'warning'];
  if (connected && online) {
    if (busy) return ['在线', '工作台已确认设备在线，连接器正在处理请求。', '请求完成后可继续操作。', 'success'];
    if (task?.pending) return ['在线', '有一条任务报告等待工作台确认。', '在当前任务中重试同一条报告。', 'success'];
    if (task) return ['在线', '工作台已确认设备在线，有一项社媒任务。', '在下方继续核对账号或回填结果。', 'success'];
    if (catalog && !catalog.expired) return ['在线', '工作台已确认设备在线，有一项商品导入任务。', '在商城区域继续核对店铺和商品表。', 'success'];
    return ['在线', '工作台已确认设备在线，可以处理任务。', '准备好后，手动领取社媒或商品导入任务。', 'success'];
  }
  if (connectionIssue === 'stopped') return ['离线 · 已紧急停止', '本机连接与操作已停止。', paired ? '停止操作已打开的官方页面，确认安全后可手动重新连接。' : '确认安全后可配对设备。', 'warning'];
  if (connectionIssue === 'authorization') return ['离线 · 设备未获授权', '服务拒绝了此设备的请求。', checkDevice, 'warning'];
  if (connectionIssue === 'heartbeat' || connectionIssue === 'connect') return ['离线 · 连线失败', '未收到工作台的在线确认。', '检查网络与服务后，手动重新连接。', 'warning'];
  if (connectionIssue === 'lease' || connectionIssue === 'fence') return ['离线 · 任务已停止', connectionIssue === 'lease' ? '任务租约已过期。' : '服务拒绝了当前任务令牌。', '先到工作台核实任务结果，再手动连接。', 'warning'];
  if (paired) return ['已断开', '本机配对已保留。', task?.pending ? '重新连接后，重试待回填的报告。' : '手动连接后即可领取任务。', 'neutral'];
  if (!secureStorage) return ['离线 · 安全存储不可用', '系统安全存储暂不可用，无法保存配对密钥。', '恢复系统安全存储后再配对。', 'warning'];
  return ['未配对', '此设备尚未绑定工作区。', '从工作台获取工作区 ID 和配对码后，在下方配对。', 'neutral'];
}

function renderIntegrations({ task, connected, online, catalog, bindings }) {
  const live = connected && online;
  const current = live && task?.channel === 'browser' && task.binding && Date.now() < task.expires ? task : undefined;
  const social = live ? bindings?.social : undefined;
  for (const [app, provider] of [['douyin', 'douyin'], ['xhs', 'xiaohongshu']]) {
    const count = social?.[provider] ?? 0;
    const assigned = current?.app === app;
    byId(`${app}-status`).dataset.tone = count || assigned ? 'success' : 'neutral';
    text(`${app}-status`, count ? `已绑定 ${count} 个账号` : social ? '本机未绑定' : assigned ? '有任务绑定' : '接入状态未知');
  }
  text('social-connection', social
    ? Object.values(social).some(Boolean)
      ? '绑定来自工作台。实际登录账号请在官方创作者页面确认。'
      : '工作台尚未为本机绑定受支持的浏览器账号。'
    : current ? '当前任务已分配账号。完整绑定列表请在工作台查看。'
      : '账号接入状态未知。请在工作台查看设备绑定。');
  const activeCatalog = live && catalog && !catalog.expired;
  const commerce = live ? bindings?.commerce : undefined;
  const stores = Object.entries(commerce ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const storeSummary = JSON.stringify(stores);
  if (storeSummary !== lastStoreSummary) {
    lastStoreSummary = storeSummary;
    const list = byId('store-platforms');
    list.replaceChildren(...stores.filter(([, count]) => count > 0).map(([provider, count]) => {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = providerName(provider);
      const quantity = document.createElement('span');
      quantity.textContent = `${count} 家店铺`;
      item.append(name, quantity);
      return item;
    }));
    list.hidden = !list.childElementCount;
  }
  const total = stores.reduce((sum, [, count]) => sum + count, 0);
  byId('commerce-status').dataset.tone = total || activeCatalog ? 'success' : 'neutral';
  text('commerce-status', total ? `已绑定 ${total} 家店铺` : commerce ? '本机未绑定店铺' : activeCatalog ? '有商品任务绑定' : '店铺接入状态未知');
  text('commerce-connection', stores.length
    ? '店铺绑定来自工作台。登录状态请在官方卖家后台确认。'
    : commerce ? '可在工作台将店铺的商品导入任务分配给本机。'
      : activeCatalog ? `当前任务店铺 · ${providerName(catalog.provider)} · ${catalog.store}。登录状态请在官方卖家后台确认。`
        : '请在工作台查看店铺及其商品导入设备。');
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

function workspaceCopy(state, canPair, canConnect) {
  const { task, workbench } = state;
  if (task?.pending) return ['当前任务', '任务状态等待工作台确认。'];
  if (task?.until) return ['当前任务', '账号核对已完成，任务已交接。'];
  if (task) return ['当前任务', '请按任务要求核对账号、审批版本和媒体。'];
  if (canPair) return ['配对设备', workbench ? '打开工作台获取工作区 ID 和配对码，然后在此绑定设备。' : '在工作台获取工作区 ID 和配对码，然后在此绑定设备。'];
  if (canConnect) return ['连接设备', '连接后即可领取工作台任务。'];
  return ['任务交接', '连接后可领取任务。请查看连接状态以继续。'];
}

function renderCatalog({ catalog, catalogNotice, catalogResult, connected, online, task, workbench }) {
  const active = catalog && !catalog.expired;
  const controls = active && connected && online;
  const file = controls && catalog.file;
  const selection = file && `${catalog.id}/${catalog.expires}/${file.name}/${file.size}`;
  if (catalogSelection !== selection) {
    byId('catalog-upload-form').reset();
    catalogSelection = selection;
  }
  show('catalog-claim-actions', connected && online && !task && !active);
  show('catalog-job', Boolean(catalog));
  show('catalog-controls', Boolean(controls));
  show('catalog-portal', Boolean(controls && catalog.canOpenPortal));
  show('catalog-upload-form', Boolean(file));
  show('catalog-retry', Boolean(catalog?.uploadUnconfirmed));
  show('catalog-result', Boolean(catalogResult));
  show('catalog-return-actions', Boolean(workbench));
  text('catalog-notice', catalogNotice || '');
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
  const live = connected && !busy;
  const handedOff = Boolean(task?.until);
  const previousFocus = document.activeElement;
  const canPair = Boolean(state.origin && !state.paired && !state.storageIssue && state.secureStorage);
  const canConnect = state.paired && state.serviceMatches && !connected;
  if (attempt !== task?.id) {
    for (const id of ['confirm', 'outcome']) byId(id).reset();
    for (const id of ['task-details', 'challenge']) byId(id).open = false;
    attempt = task?.id;
  }
  const [status, note, next, tone] = connectionCopy(state);
  const [heading, intro] = workspaceCopy(state, canPair, canConnect);
  text('connection', status);
  text('connection-note', note);
  text('connection-next', next);
  byId('connection').dataset.tone = tone;
  text('workspace-id', state.workspace || '—');
  text('device-id', state.device || '—');
  text('origin', state.origin || '正式服务未配置');
  show('workspace-panel', Boolean(task || canPair || canConnect));
  show('service-settings', state.canSetOrigin);
  if (serviceOrigin !== (state.origin || '')) {
    serviceOrigin = state.origin || '';
    byId('pair').reset();
    byId('service-form').elements.origin.value = serviceOrigin;
    byId('service-settings').open = false;
  }
  text('workspace-heading', heading);
  text('workspace-note', intro);
  text('message', state.message);
  show('pair', canPair);
  show('connect-actions', canConnect);
  show('disconnect', connected);
  show('forget', state.paired || state.storageIssue);
  show('workbench', Boolean(state.workbench));
  show('idle', connected && state.online && !task && !(state.catalog && !state.catalog.expired));
  renderCatalog(state);
  show('task', Boolean(task));
  if (task) {
    text('task-meta', `${names[task.app] || task.app} · ${taskKinds[task.kind] || task.kind} · 租约至 ${time(task.expires)}`);
    text('task-id', task.id);
    text('task-identity', task.identity);
    text('task-profile', task.profile || '');
    text('task-post', task.expectedPost || '');
    show('task-profile-row', Boolean(task.profile));
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
    show('confirm', task.portal);
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
  byId('claim').disabled = !live || applying;
  text('update-status', state.updates.status);
  show('update-actions', state.updates.enabled);
  byId('update-check').disabled = !state.updates.enabled || state.updates.busy || state.updates.ready || applying;
  show('update-install', state.updates.ready);
  const hasTask = Boolean(task || (state.catalog && !state.catalog.expired));
  show('update-task-note', state.updates.ready && hasTask);
  byId('update-install').disabled = hasTask || busy || applying;
  renderIntegrations(state);
  renderActivity(state.activity);
  if (previousFocus?.closest('[hidden]') || (previousFocus?.tagName !== 'SUMMARY' && previousFocus?.closest('details:not([open])'))) {
    if (previousFocus.closest('#catalog-claim-actions, #catalog-job')) {
      if (state.catalogResult) byId('catalog-result-heading').focus();
      else if (state.catalog) byId('catalog-job-heading').focus();
    } else if (previousFocus.id === 'connect' && connected && state.online && !byId('idle').hidden) {
      byId('claim').focus();
    } else if (previousFocus.id === 'report' && !byId('idle').hidden) {
      byId('claim').focus();
    } else byId(byId('workspace-panel').hidden ? 'device-heading' : 'workspace-heading').focus();
  }
}

async function invoke(action, arg, display = true) {
  const urgent = action === 'stop' || action === 'disconnect';
  if (display && applying && !urgent) return;
  const errorTarget = /Catalog|^catalog/.test(action) ? 'catalog-error' : 'error';
  const order = display ? ++revision : revision;
  if (display) {
    applying = true;
    text('error', '');
    text('catalog-error', '');
  }
  try {
    const reply = await api[action](arg);
    if (order !== revision) return;
    if (display) { applying = false; text(errorTarget, reply.error || ''); }
    if (reply.state) render(reply.state);
    return reply;
  } catch {
    if (order === revision && display) { applying = false; text(errorTarget, '连接器窗口暂时无法访问本机服务。'); }
  }
}

for (const [id, action] of Object.entries({ stop: 'stop', connect: 'connect', disconnect: 'disconnect', forget: 'forget', claim: 'claim',
  workbench: 'workbench', creator: 'creator', media: 'media', report: 'report', 'update-check': 'updateCheck', 'update-install': 'updateInstall',
  'catalog-claim': 'claimCatalog', 'catalog-portal': 'catalogPortal', 'catalog-return': 'workbench' })) {
  byId(id).addEventListener('click', () => void invoke(action));
}
byId('service-form').addEventListener('submit', event => {
  event.preventDefault();
  void invoke('setOrigin', event.currentTarget.elements.origin.value);
});
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
for (const app of ['douyin', 'xhs']) byId(app).addEventListener('click', () => void invoke('sessionCreator', app));
byId('block').addEventListener('click', () => void invoke('block', { reason: byId('reason').value }));
byId('pair').addEventListener('submit', event => {
  event.preventDefault();
  const form = byId('pair');
  const { workspace, code, name, owns } = form.elements;
  const body = { workspace: workspace.value.trim(), code: code.value, name: name.value, ownsDevice: owns.checked };
  code.value = '';
  owns.checked = false;
  void invoke('pair', body);
});
for (const [id, action] of [['confirm', 'confirm'], ['session', 'verifySession']]) {
  byId(id).addEventListener('submit', event => {
    event.preventDefault();
    const form = byId(id);
    const { observed, confirmed, session } = form.elements;
    const body = { observed: observed.value.trim(), confirmed: confirmed.checked, ...(session && { session: session.value.trim() }) };
    form.reset();
    void invoke(action, body);
  });
}
byId('outcome').addEventListener('submit', event => {
  event.preventDefault();
  const result = event.submitter?.value;
  if (!result) return;
  const receipt = Object.fromEntries([...new FormData(byId('outcome'))].map(([name, value]) => [name, value.trim()]));
  const include = ['captured', 'submitted'].includes(result) && Object.values(receipt).some(Boolean);
  void invoke('finish', { result, ...(include && { receipt }) });
});
void invoke('state', undefined, false);
setInterval(() => { if (!applying) void invoke('state', undefined, false); }, 750);
