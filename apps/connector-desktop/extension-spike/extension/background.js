// SmartSell measurement prototype (core-automation-proposal §3.5). Connects to the local spike runner on 127.0.0.1 and runs
// only the commands it sends: open/close its own tabs, read page facts, and attach chrome.debugger to its own tab for input.
const RUNNER = 'ws://127.0.0.1:47231';
let socket;

const settle = tabId => new Promise(resolve => {
  const done = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
  chrome.tabs.onUpdated.addListener(done);
  setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 20_000);
});

// Page reads run in the page's own world, so they see what the site sees.
const reads = {
  webdriver: () => navigator.webdriver,
  url: () => location.href,
  xLoggedIn: () => !!document.querySelector('[data-testid="SideNav_NewTweet_Button"], [data-testid="AppTabBar_Profile_Link"]'),
  xEditorPoint: () => {
    const editor = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!editor) return null;
    const box = editor.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + Math.min(box.height / 2, 20)) };
  },
  xEditorText: () => document.querySelector('[data-testid="tweetTextarea_0"]')?.innerText ?? null,
  xPostButton: () => {
    const button = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
    return button ? { found: true, disabled: button.disabled === true || button.getAttribute('aria-disabled') === 'true' } : { found: false };
  },
  tiktokUpload: () => ({ url: location.href, uploadInput: !!document.querySelector('input[type="file"]'), loginForm: /\/login/.test(location.pathname) }),
};

const commands = {
  async open({ url }) { const tab = await chrome.tabs.create({ url, active: true }); await settle(tab.id); return { tabId: tab.id }; },
  async navigate({ tabId, url }) { await chrome.tabs.update(tabId, { url }); await settle(tabId); return {}; },
  async read({ tabId, name }) {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: reads[name] });
    return { value: result?.result ?? null };
  },
  async attach({ tabId }) { await chrome.debugger.attach({ tabId }, '1.3'); return {}; },
  async detach({ tabId }) { await chrome.debugger.detach({ tabId }).catch(() => {}); return {}; },
  async cdp({ tabId, method, params }) { return { value: await chrome.debugger.sendCommand({ tabId }, method, params ?? {}) }; },
  async close({ tabId }) { await chrome.tabs.remove(tabId).catch(() => {}); return {}; },
  async version() { return { chrome: navigator.userAgent }; },
};

function connect() {
  socket = new WebSocket(RUNNER);
  socket.onmessage = async event => {
    const { id, cmd, args } = JSON.parse(event.data);
    try { socket.send(JSON.stringify({ id, ok: true, ...(await commands[cmd](args ?? {})) })); }
    catch (error) { socket.send(JSON.stringify({ id, ok: false, error: String(error?.message ?? error) })); }
  };
  socket.onclose = () => setTimeout(connect, 2000);
  socket.onerror = () => socket.close();
}
connect();
// Keep the service worker alive while the runner is up (an open WebSocket counts as activity in Chrome 116+).
setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send('{"ping":1}'); }, 20_000);
