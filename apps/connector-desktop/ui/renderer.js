// SmartSell Worker UI (§8.17). Worker mode: 連線、這台機器的設定、帳號、任務、進階.
// Laptop Agent mode: hub address and status, 連接 Codex／Claude Code, the last 20
// alerts and background uploads. Only textContent is used for data.
'use strict';

const api = window.smartsell;
const root = document.getElementById('app');
const toast = document.getElementById('toast');
let state = null;
let busy = false;
const drafts = {};

const PROVIDER = { x: 'X', tiktok: 'TikTok', youtube: 'YouTube', meta_instagram: 'Instagram', meta_facebook: 'Facebook' };
const JOB_STATE = {
  claimed: '已領取', downloading: '下載影片中', media_ready: '影片已就緒', preflighting: '檢查登入中', preparing: '準備中', ready: '已準備好',
  blocked: '要你處理', waiting_go: '等待開跑', running: '發布中', submitting: '已點擊發布', result_pending: '確認結果中',
};
const CONNECTION = { starting: '正在連線', online: '在線', reconnecting: '中樞連不上，正在重試', device_revoked: '已在中樞撤銷或停用', stopped: '已停止', vault_locked: '無法讀取配對金鑰', unpaired: '尚未配對' };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

function show(message, tone = 'error') {
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = !message;
  if (message) setTimeout(() => { if (toast.textContent === message) toast.hidden = true; }, 8000);
}

async function call(name, body) {
  if (busy && name !== 'state') return;
  busy = name !== 'state';
  try {
    const reply = await api.call(name, body);
    if (reply?.state) { state = reply.state; render(); }
    if (reply?.error) show(reply.error);
    return reply?.result ?? null;
  } catch { show('操作失敗，請重試。'); }
  finally { if (name !== 'state') busy = false; }
}

function time(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleString('zh-Hant', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function countdown(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '已到時間';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分鐘後`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} 小時 ${minutes % 60} 分後` : `${Math.floor(hours / 24)} 天後`;
}

function card(title, ...body) { return el('section', { class: 'card' }, el('h2', { text: title }), ...body); }
function row(label, value) { return el('div', { class: 'fact' }, el('dt', { text: label }), el('dd', {}, value)); }
function button(label, onclick, extra = {}) { return el('button', { type: 'button', onclick, ...extra }, label); }

// ---------- first run ----------

function chooser() {
  return card('這台機器要做什麼？',
    el('p', { class: 'muted', text: '之後要改用途，請在「進階」登出本機配對後重新選擇。' }),
    el('div', { class: 'choices' },
      el('button', { type: 'button', class: 'choice primary', onclick: () => call('choose-role', { role: 'worker' }) },
        el('strong', { text: '發文的機器（Worker）' }), el('span', { text: '這台機器用自己的 Chrome 替帳號發文，例如 Mac-B、Win-C。' })),
      el('button', { type: 'button', class: 'choice', onclick: () => call('choose-role', { role: 'agent' }) },
        el('strong', { text: '這台是我的筆電（只連 Codex，不發文）' }), el('span', { text: '顯示所有機器的通知，並在 Codex 結束後繼續背景上傳。' }))));
}

// ---------- Worker mode ----------

function pairForm(worker) {
  const hub = el('input', { name: 'hub', type: 'url', required: true, placeholder: 'https://hub.tail1234.ts.net', autocomplete: 'off', spellcheck: 'false', value: drafts.hub ?? '' });
  const name = el('input', { name: 'name', required: true, maxlength: 100, value: drafts.name ?? state.default_machine_name });
  const owns = el('input', { type: 'checkbox', name: 'owns', required: true });
  const workspace = el('input', { name: 'workspace', autocomplete: 'off', spellcheck: 'false', placeholder: '工作區 ID（選填）' });
  const code = el('input', { name: 'code', autocomplete: 'off', spellcheck: 'false', placeholder: '配對碼（選填）' });
  hub.addEventListener('input', () => { drafts.hub = hub.value; });
  name.addEventListener('input', () => { drafts.name = name.value; });
  const form = el('form', { class: 'stack', onsubmit: event => {
    event.preventDefault();
    call('pair', { hub: hub.value, name: name.value, owns: owns.checked, workspace: workspace.value, code: code.value });
  } },
  el('label', {}, '中樞位址（在中樞的「開始設定」頁複製）', hub),
  el('label', {}, '這台機器叫什麼名字？請用你平常叫它的名字，Codex 會用這個名字找機器。', name),
  el('label', { class: 'check' }, owns, el('span', { text: '這台機器是我的，或我有權管理它；同意把它配對到這個中樞。' })),
  el('details', {}, el('summary', { text: '已經有配對碼？' }), el('div', { class: 'stack' }, workspace, code)),
  el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'primary', disabled: worker?.phase === 'pairing' }, '配對'),
    worker?.phase === 'pairing' ? button('取消', () => call('cancel-pairing')) : null));
  return card('連接到中樞',
    el('ol', { class: 'steps' },
      el('li', { text: '這台機器要先安裝 Tailscale、登入同一個 tailnet，不要設定 exit node，並在 Tailscale 後台關閉這台機器的金鑰到期。' }),
      el('li', { text: '貼上中樞位址並為機器命名，按「配對」。瀏覽器會開啟中樞的配對頁，登入後按「核准」。' })),
    form, worker?.message ? el('p', { class: 'notice', text: worker.message }) : null);
}

function connectionCard(worker) {
  const update = worker.update;
  const status = CONNECTION[worker.connection] ?? worker.connection;
  const retry = worker.connection === 'reconnecting' && worker.next_retry_at ? `（${Math.max(0, Math.round((Date.parse(worker.next_retry_at) - Date.now()) / 1000))} 秒後重試）` : '';
  return card('連線',
    el('dl', { class: 'facts' },
      row('中樞', worker.hub_origin ?? '—'),
      row('狀態', el('span', { class: `status ${worker.connection}`, text: `${status}${retry}` })),
      row('這台機器', el('span', {}, worker.machine_name, ' ', button('在網頁改名', () => call('open-web', { target: 'machine' }), { class: 'link' }))),
      row('時鐘偏差', worker.clock_offset_ms === null ? '—' : `${Math.round(worker.clock_offset_ms / 1000)} 秒${worker.clock_warning ? '（超過 30 秒，請校正系統時間）' : ''}`),
      worker.machine_paused || worker.pause_all ? row('暫停', '這台機器已在中樞暫停，不會發文。') : null,
      worker.outbox_depth ? row('待送回報', `${worker.outbox_depth} 筆`) : null),
    worker.connection_message ? el('p', { class: 'notice', text: worker.connection_message }) : null,
    update?.rejected ? el('div', { class: 'update' },
      el('strong', { text: `已拒絕 SmartSell Worker ${update.rejected.version} 的更新` }),
      el('p', { class: 'notice', text: update.rejected.message })) : null,
    update?.available ? el('div', { class: 'update' },
      el('strong', { text: `SmartSell Worker ${update.available.version} 可更新${update.verification === 'verified' ? '（發行簽章已驗證）' : ''}` }),
      update.verification_notice ? el('p', { class: 'notice', text: update.verification_notice }) : null,
      update.keychain_notice ? el('p', { class: 'muted', text: update.keychain_notice }) : null,
      update.message ? el('p', { class: 'notice', text: update.message }) : null,
      update.phase === 'downloading' ? el('progress', { max: 1, value: update.progress }) : null,
      el('div', { class: 'actions' },
        button('更新', async () => {
          const result = await call('update-install', {});
          if (result && result.ok === false && result.code === 'DUE_SOON' && confirm(result.message)) await call('update-install', { confirm: true });
        }, { class: 'primary', disabled: update.blocked || update.phase === 'downloading' || update.phase === 'installing' }),
        update.blocked ? el('span', { class: 'muted', text: '有貼文正在發布，結束後才能更新。' }) : null)) : null);
}

function machineCard(worker) {
  const advice = worker.posture_advice ?? [];
  return card('這台機器的設定',
    advice.length ? el('ul', { class: 'advice' }, advice.map(item => el('li', { class: item.code === 'remote_access' ? 'ok' : 'warn' }, el('strong', { text: item.text }), el('span', { text: item.how }))))
      : el('p', { class: 'muted', text: worker.posture ? '沒有發現會讓貼文錯過的設定。' : '正在讀取電源與登入設定…' }));
}

function enrollment(worker) {
  const e = worker.enrollment;
  if (!e) {
    const select = el('select', {}, el('option', { value: 'x', text: 'X' }), el('option', { value: 'tiktok', text: 'TikTok' }));
    return el('div', { class: 'actions' }, select, button('新增帳號', () => call('add-account', { provider: select.value }), { class: 'primary', disabled: worker.phase !== 'running' }));
  }
  const name = PROVIDER[e.provider];
  if (e.status === 'waiting_login') {
    const where = worker.browser?.mode === 'own_chrome'
      ? `已在你的 Chrome（SmartSell 視窗）開啟 ${name}。已經登入的話馬上會偵測到；沒登入請在那裡登入（驗證碼與二次驗證都由你完成）。`
      : `已在新的 Chrome 視窗開啟 ${name}。請在那個視窗自己登入（驗證碼與二次驗證都由你完成）。偵測到帳號後會在這裡詢問你。`;
    return el('div', { class: 'enroll' }, el('p', { text: where }),
      button('取消', () => call('cancel-account')));
  }
  if (e.status === 'failed') return el('div', { class: 'enroll' }, el('p', { class: 'notice', text: e.error }), button('關閉', () => call('cancel-account')));
  if (e.status === 'registered') return el('div', { class: 'enroll' }, el('p', { text: e.note ?? '已加入。' }), button('好', () => call('cancel-account')));
  return el('div', { class: 'enroll' },
    el('p', {}, el('strong', { text: `偵測到 ${e.label}，加入 SmartSell？` })),
    el('blockquote', { text: e.notice }),
    el('p', { class: 'muted', text: '按「加入」表示你已讀過上面的自動化告知。代按發布另外需要在網頁的帳號頁確認風險；在那之前，到點時會請你在這台機器按「發布」。' }),
    e.error ? el('p', { class: 'notice', text: e.error }) : null,
    el('div', { class: 'actions' }, button('加入', () => call('confirm-account'), { class: 'primary', disabled: e.status === 'registering' }), button('取消', () => call('cancel-account'))));
}

function browserCard(worker) {
  const b = worker.browser;
  if (!b) return null;
  const ownChrome = b.mode === 'own_chrome';
  if (!ownChrome) {
    return card('用哪個 Chrome 發文',
      el('p', { text: b.chosen ? '現在：每個帳號一個獨立的 Chrome（要在那個視窗另外登入）。' : '現在：每個帳號一個獨立的 Chrome。' }),
      el('p', { class: 'muted', text: '建議改用你自己的 Chrome：Worker 直接在你平常用、已經登入的 Chrome 裡操作，不用再登入一次；沒登入的帳號會提醒你去登入。需要安裝 SmartSell 擴充功能（約 1 分鐘）。' }),
      el('div', { class: 'actions' },
        button('改用我自己的 Chrome（建議）', () => call('browser-mode', { mode: 'own_chrome' }), { class: 'primary' }),
        !b.chosen ? button('維持獨立的 Chrome', () => call('browser-mode', { mode: 'profiles' })) : null));
  }
  const connected = b.connected ?? [];
  const status = connected.length
    ? el('p', { class: 'ok', text: connected.length === 1 ? `已連上你的 Chrome（${connected[0].chrome ? `Chrome ${connected[0].chrome.split('.')[0]}` : 'Chrome'}）。` : `已連上 ${connected.length} 個 Chrome 設定檔。` })
    : el('p', { class: 'notice', text: '還沒連上你的 Chrome。請照下面的步驟安裝 SmartSell 擴充功能；Chrome 要開著。' });
  const steps = el('ol', { class: 'steps' },
    el('li', {}, '在 Chrome 網址列輸入 ', el('code', { text: 'chrome://extensions' }), '，打開右上角的「開發人員模式」。'),
    el('li', {}, '按「載入未封裝項目」，選這個資料夾：', el('code', { text: b.extension_dir ?? '—' }), ' ', button('打開資料夾', () => call('open-extension-folder'), { class: 'link' })),
    el('li', { text: '在 SmartSell Worker 擴充功能按「詳細資料」，開啟「允許存取檔案網址」（上傳影片需要）。' }),
    el('li', { text: '同一個平台有第二個帳號時，把它放在另一個 Chrome 設定檔，並在那個設定檔也裝一次。' }));
  const noFiles = connected.filter(item => item.file_access === false);
  const pick = connected.length > 1 ? el('div', { class: 'stack' }, el('p', { class: 'muted', text: '有好幾個 Chrome 設定檔，請為每個帳號選一個：' }),
    worker.channels.map(channel => {
      const select = el('select', { onchange: event => call('bind-browser', { id: channel.social_account_id, install_id: event.target.value }) },
        el('option', { value: '', text: '（請選擇）' }),
        connected.map((item, index) => el('option', { value: item.install_id, selected: b.bindings[channel.profile_key] === item.install_id, text: `Chrome 設定檔 ${index + 1}（${item.install_id.slice(0, 8)}）` })));
      return el('label', {}, `${PROVIDER[channel.provider] ?? channel.provider} ${channel.handle ? `@${channel.handle}` : ''}`, select);
    })) : null;
  return card('用哪個 Chrome 發文',
    el('p', { text: '現在：你自己的 Chrome。SmartSell 只在它自己開的「SmartSell」視窗裡操作，不碰你正在看的分頁。' }),
    status,
    b.host_error ? el('p', { class: 'notice', text: b.host_error }) : null,
    noFiles.length ? el('p', { class: 'notice', text: '擴充功能還沒開啟「允許存取檔案網址」，上傳影片會失敗。請在 chrome://extensions 的 SmartSell Worker「詳細資料」開啟它。' }) : null,
    connected.some(item => item.webdriver === true) ? el('p', { class: 'notice', text: '網頁看得到這個 Chrome 是自動化瀏覽器（navigator.webdriver 為 true）。請確認不是用除錯參數啟動的 Chrome，並回報給我們。' })
      : connected.some(item => item.webdriver === false) ? el('p', { class: 'muted', text: '檢查過：SmartSell 操作時，網頁看到的 navigator.webdriver 是 false（和你自己操作時一樣）。' }) : null,
    connected.length ? el('details', {}, el('summary', { text: '安裝步驟' }), steps) : steps,
    pick,
    el('p', { class: 'muted', text: 'Worker 操作時，Chrome 頂端會顯示「SmartSell Worker 已開始對這個瀏覽器進行偵錯」；按「取消」會中斷那一則，不會自動重發。' }),
    el('div', { class: 'actions' }, button('改回每個帳號一個獨立 Chrome', () => call('browser-mode', { mode: 'profiles' }), { class: 'link' })));
}

function remoteCard(worker) {
  const r = worker.remote;
  if (!r || (!r.browser.enabled && !r.phone.enabled)) return null;
  return card('遙控（Agent 一步一步操作）',
    r.browser.enabled ? el('p', {}, '瀏覽器：Agent 可以在你的 Chrome（SmartSell 視窗）操作這些網站：', el('strong', { text: r.browser.sites.join('、') })) : null,
    r.browser.enabled && worker.browser?.mode !== 'own_chrome' ? el('p', { class: 'notice', text: '瀏覽器遙控需要「用我自己的 Chrome」。' }) : null,
    r.phone.enabled ? el('p', {}, '手機：Agent 可以在插在這台電腦的 Android 手機上操作這些 App：', el('strong', { text: r.phone.apps.join('、') })) : null,
    el('p', { class: 'muted', text: '在網頁的機器頁開關與修改。改東西之前 Agent 會先問你；遇到登入、驗證碼或付款畫面會停下來請你處理。' }));
}

function accountsCard(worker) {
  const rows = worker.channels.map(channel => el('li', { class: 'item' },
    el('div', {}, el('strong', { text: `${PROVIDER[channel.provider] ?? channel.provider} ${channel.handle ? `@${channel.handle}` : ''}` }),
      el('span', { class: 'muted', text: channel.blocked ? '要你處理（見下方任務）' : channel.last_login_check_at ? `上次確認登入：${time(channel.last_login_check_at)}` : '尚未確認登入' }),
      channel.paused ? el('span', { class: 'muted', text: '已暫停' }) : null,
      channel.effective_mode === 'assist' ? el('span', { class: 'muted', text: '到點時請你按發布（沒有開啟代按發布）' }) : null),
    el('div', { class: 'actions' },
      button('開啟 Chrome', () => call('open-chrome', { id: channel.social_account_id })),
      button('檢查登入', async () => {
        const result = await call('check-login', { id: channel.social_account_id });
        if (result) show(result.state === 'verified' ? '已登入，帳號正確。' : result.state === 'identity_mismatch' ? `Chrome 登入的是 ${result.identity}，不是這個帳號。` : '沒有登入，請按「重新登入」。', result.state === 'verified' ? 'ok' : 'error');
      }),
      button('重新登入', () => call('relogin', { id: channel.social_account_id })),
      button('在網頁設定', () => call('open-web', { target: 'channel', id: channel.social_account_id }), { class: 'link' }))));
  return card('帳號', rows.length ? el('ul', { class: 'list' }, rows) : el('p', { class: 'muted', text: '這台機器還沒有帳號。' }), enrollment(worker));
}

function jobsCard(worker) {
  const rows = worker.jobs.map(job => el('li', { class: `item ${job.needs_owner ? 'attention' : ''}` },
    el('div', {}, el('strong', { text: `${time(job.not_before)} ${job.channel_label}` }),
      el('span', { class: 'muted', text: `${job.kind === 'check_login' ? '登入檢查' : job.dry_run ? '試跑' : '發布'}・${JOB_STATE[job.state] ?? job.state}・${countdown(job.not_before)}` }),
      job.blocker ? el('span', { class: 'notice', text: job.blocker.message }) : null),
    job.needs_owner ? button('開啟該 Chrome 處理', () => call('open-job-chrome', { id: job.job_id }), { class: 'primary' }) : null));
  return card('任務', rows.length ? el('ul', { class: 'list' }, rows) : el('p', { class: 'muted', text: '目前沒有領到的任務。' }));
}

function advancedCard(kind) {
  const settings = state.settings;
  const worker = state.worker;
  const autostart = el('input', { type: 'checkbox', checked: worker ? worker.autostart : settings.autostart === true, onchange: event => call('autostart', { enabled: event.target.checked }) });
  const legacy = el('input', { type: 'checkbox', checked: settings.legacy_lines, onchange: event => call('legacy-enable', { enabled: event.target.checked }) });
  return el('details', { class: 'card advanced' }, el('summary', { text: '進階' }),
    el('label', { class: 'check' }, autostart, el('span', { text: '登入電腦時自動啟動 SmartSell（建議開啟，重開機後才會自動上線）' })),
    kind === 'worker' ? el('label', { class: 'check' }, legacy, el('span', { text: '舊工作線（抖音、小紅書人工交接、知乎、商品匯入）' })) : null,
    el('div', { class: 'actions' },
      kind === 'worker' && settings.legacy_lines ? button('打開舊工作線', () => call('legacy-open')) : null,
      button('日誌', () => call('open-logs')),
      kind === 'worker' && worker?.phase === 'running' ? (worker.emergency_stop ? button('解除緊急停止', () => call('resume')) : button('緊急停止', () => call('stop'), { class: 'stop' })) : null,
      kind === 'worker' ? button('刪除舊版 Chrome 資料', () => call('legacy-chrome-delete')) : null,
      kind === 'worker' && worker && worker.phase !== 'unpaired' ? button('登出本機配對', () => call('forget'), { class: 'danger' }) : null),
    el('p', { class: 'muted', text: `SmartSell Worker ${state.version}` }));
}

function workerView(worker) {
  if (!worker || worker.phase === 'unpaired' || worker.phase === 'pairing') return [pairForm(worker), advancedCard('worker')];
  if (worker.phase === 'vault_locked') {
    return [card('無法讀取配對金鑰',
      el('p', { text: state.platform === 'darwin' ? '這台機器的鑰匙圈沒有允許 SmartSell 讀取配對金鑰，所以無法連線。請按「重試」，出現鑰匙圈提示時按「永遠允許」。' : 'Windows 認證儲存無法解開配對金鑰，所以無法連線。請按「重試」。' }),
      el('div', { class: 'actions' }, button('重試', () => call('retry-vault'), { class: 'primary' }))), advancedCard('worker')];
  }
  return [connectionCard(worker), machineCard(worker), browserCard(worker), remoteCard(worker), accountsCard(worker), jobsCard(worker), advancedCard('worker')].filter(Boolean);
}

// ---------- Agent mode ----------

function agentView(agent) {
  const hub = el('input', { type: 'url', placeholder: 'https://hub.tail1234.ts.net', value: drafts.agentHub ?? agent?.hub_origin ?? '' });
  hub.addEventListener('input', () => { drafts.agentHub = hub.value; });
  const ALERT_STATE = { idle: '尚未連接', connecting: '連線中', open: '已連上，會顯示所有機器的通知', reconnecting: '連不上，正在重試', unauthorized: '連線已撤銷或過期，請重新連接', stopped: '已停止' };
  const last = agent?.last_connect;
  const uploads = agent?.uploads ?? [];
  return [
    card('中樞與連線',
      el('form', { class: 'actions', onsubmit: event => { event.preventDefault(); call('agent-hub', { hub: hub.value }); } }, hub, el('button', { type: 'submit' }, '儲存')),
      el('dl', { class: 'facts' }, row('通知', ALERT_STATE[agent?.alerts_state ?? 'idle']), row('已連接', agent?.connected_client === 'codex' ? 'Codex' : agent?.connected_client === 'claude_code' ? 'Claude Code' : '—')),
      el('div', { class: 'actions' },
        button('連接 Codex', () => call('agent-connect', { client: 'codex' }), { class: 'primary', disabled: agent?.connecting }),
        button('連接 Claude Code', () => call('agent-connect', { client: 'claude_code' }), { disabled: agent?.connecting }),
        agent?.connecting ? button('取消', () => call('agent-cancel')) : null),
      agent?.connecting ? el('p', { class: 'muted', text: '請在剛開啟的瀏覽器登入中樞並同意建立連線。' }) : null,
      last ? el('p', { class: 'ok', text: `已連接 ${last.client === 'codex' ? 'Codex' : 'Claude Code'}。${last.restart_hint}` }) : null,
      last?.manual_command ? el('div', {}, el('p', { text: '找不到 claude 命令，請在終端機執行：' }), el('code', { text: last.manual_command })) : null,
      last && last.previous_revoked === false ? el('p', { class: 'muted', text: '舊的連線沒有自動撤銷，請到網頁的 Agent 頁撤銷。' }) : null,
      last?.codex_backup ? el('p', { class: 'muted', text: `原本的 Codex 設定已備份到 ${last.codex_backup}。` }) : null,
      agent?.error ? el('p', { class: 'notice', text: agent.error }) : null,
      el('p', { class: 'muted', text: '筆電與手機也要加入同一個 tailnet，通知中的連結才打得開。' })),
    card('背景上傳', uploads.length ? el('ul', { class: 'list' }, uploads.map(item => el('li', { class: 'item' },
      el('div', {}, el('strong', { text: item.filename }), el('span', { class: 'muted', text: item.status === 'uploading' ? `上傳中 ${Math.floor((item.received / item.bytes) * 100)}%，請保持筆電不睡眠` : item.status === 'ready' ? '已完成' : item.status === 'processing' ? '中樞處理中' : `失敗：${item.error ?? ''}` })),
      item.status === 'uploading' ? el('progress', { max: item.bytes, value: item.received }) : null)))
      : el('p', { class: 'muted', text: '沒有背景上傳。Codex 回傳「背景上傳」時，這裡會接手繼續。' })),
    card('最近的通知', (agent?.alerts ?? []).length ? el('ul', { class: 'list' }, agent.alerts.map(alert => el('li', { class: `item ${alert.severity}` },
      el('div', {}, el('strong', { text: alert.title }), el('span', { text: alert.body }), el('span', { class: 'muted', text: time(alert.at) })),
      button('打開', () => call('open-url', { url: alert.web_url }), { class: 'link' }))))
      : el('p', { class: 'muted', text: '還沒有通知。' })),
    advancedCard('agent'),
  ];
}

function render() {
  if (!state) return;
  const role = state.settings.role;
  document.getElementById('title').textContent = role === 'agent' ? '筆電' : 'Worker';
  const worker = state.worker;
  const stopped = !!worker?.emergency_stop;
  document.getElementById('top-stop').hidden = role !== 'worker' || worker?.phase !== 'running' || stopped;
  document.getElementById('top-resume').hidden = role !== 'worker' || !stopped;
  const focus = document.activeElement && root.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
  if (focus) return; // do not re-render under the owner's cursor
  root.replaceChildren(...(role === null ? [chooser()] : role === 'agent' ? agentView(state.agent) : workerView(worker)));
}

document.getElementById('top-stop').addEventListener('click', () => call('stop'));
document.getElementById('top-resume').addEventListener('click', () => call('resume'));
api.onChange(() => { void call('state'); });
setInterval(() => { void call('state'); }, 5000);
void call('state');
