'use strict';

const api = window.connector;
const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = value; };
const show = (id, visible) => { byId(id).hidden = !visible; };
const names = { douyin: '抖音', xhs: '小红书' };
const time = value => new Date(value).toLocaleTimeString();
let attempt;
let applying = false;
let revision = 0;

function render(state) {
  const { task, busy, connected } = state;
  const live = connected && !busy;
  const handedOff = Boolean(task?.until);
  if (attempt !== task?.id) {
    for (const id of ['confirm', 'outcome']) byId(id).reset();
    attempt = task?.id;
  }
  text('connection', state.storageIssue ? '无法读取系统安全存储中的配对记录' : state.paired
    ? `${state.online ? '在线' : '已断开'} · ${state.workspace} / ${state.device}` : '未配对');
  text('origin', (state.origin || '正式服务未配置') + (state.serviceMatches ? '' : ' · 现有配对属于另一服务'));
  text('message', state.message);
  show('pair', Boolean(state.origin && !state.paired && !state.storageIssue && state.secureStorage));
  show('connect', state.paired && state.serviceMatches && !connected);
  show('disconnect', connected);
  show('forget', state.paired || state.storageIssue);
  show('workbench', Boolean(state.workbench));
  show('idle', connected && !task);
  show('task', Boolean(task));
  if (task) {
    text('task-meta', `${names[task.app] || task.app} · ${task.kind} · 租约至 ${time(task.expires)}`);
    text('task-scope', [task.id, `预期账号 ${task.identity}`, task.profile && `专用浏览器会话 ${task.profile}`, task.expectedPost && `待核实作品 ${task.expectedPost}`].filter(Boolean).join(' · '));
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
    text('handoff', Date.now() >= task.until ? '交接窗口已结束。请勿再次提交作品。' : task.revision
      ? `请在 ${time(task.until)} 前在官方页面亲自提交一次。找不到证据时可回填结果未知。` : '请在官方页面核对原作品并回填观察结果。');
    show('receipt', task.kind !== 'post.verify_visible');
    show('captured', task.kind === 'post.capture_result');
    show('submitted', Boolean(task.revision));
    show('visible', task.kind === 'post.verify_visible');
    show('not-visible', task.kind === 'post.verify_visible');
    show('challenge', connected && !task.pending);
    show('report', Boolean(task.pending));
  }
  for (const element of document.querySelectorAll('button, input, select')) {
    if (!['stop', 'disconnect'].includes(element.id)) element.disabled = busy || applying;
  }
  byId('claim').disabled = !live || applying;
  text('update-status', state.updates.status);
  byId('update-check').disabled = !state.updates.enabled || state.updates.busy || state.updates.ready || applying;
  show('update-install', state.updates.ready);
  byId('update-install').disabled = Boolean(task) || applying;
}

async function invoke(action, arg, display = true) {
  const urgent = action === 'stop' || action === 'disconnect';
  if (display && applying && !urgent) return;
  const order = display ? ++revision : revision;
  if (display) applying = true;
  try {
    const reply = await api[action](arg);
    if (order !== revision) return;
    if (display) { applying = false; text('error', reply.error || ''); }
    if (reply.state) render(reply.state);
    return reply;
  } catch {
    if (order === revision && display) { applying = false; text('error', '连接器窗口暂时无法访问本机服务。'); }
  }
}

for (const [id, action] of Object.entries({ stop: 'stop', connect: 'connect', disconnect: 'disconnect', forget: 'forget', claim: 'claim',
  workbench: 'workbench', creator: 'creator', media: 'media', report: 'report', 'update-check': 'updateCheck', 'update-install': 'updateInstall' })) {
  byId(id).addEventListener('click', () => void invoke(action));
}
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
