// SmartSell Worker extension (Manifest V3, core-automation-proposal §3.2).
//
// It talks to one peer only: the native messaging host com.smartsell.worker, which the SmartSell Worker App registered
// on this computer and which relays bytes to the running Worker. The Worker asks it to open tabs and to run Chrome
// DevTools Protocol commands in them through chrome.debugger (trusted input events, isolated-world reads).
//
// Boundaries, enforced here and not only in the Worker:
// - It works only in tabs it opened itself, in its own "SmartSell" window; it never lists, reads or attaches to the
//   owner's other tabs.
// - Only the CDP domains the drivers use are allowed, and navigation only to http(s) and about:blank.
// - The debugger is attached only while the Worker is connected; when the Worker goes away every attachment is dropped
//   (Chrome's "started debugging this browser" bar disappears) and the tabs stay for the owner.
// - It changes nothing about the browser's identity: no navigator/webdriver/fingerprint overrides of any kind.

const HOST = 'com.smartsell.worker';
const DOMAINS = ['Page.', 'DOM.', 'Runtime.', 'Input.', 'Network.', 'Accessibility.', 'Emulation.setFocusEmulationEnabled'];
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

let port = null;
let retries = 0;
let retryTimer = null;
let lastError = null;
const attached = new Set();

// ---------- state that survives a service-worker restart (this browser session only) ----------

async function session() {
  const { owned = [], windowId = null } = await chrome.storage.session.get(['owned', 'windowId']);
  return { owned, windowId };
}
async function setSession(value) { await chrome.storage.session.set(value); }
async function owns(tabId) { return (await session()).owned.includes(tabId); }

async function installId() {
  const { install_id: existing } = await chrome.storage.local.get('install_id');
  if (existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ install_id: id });
  return id;
}

// ---------- connection to the Worker ----------

function post(message) {
  try { port?.postMessage(message); } catch { /* the port closed; onDisconnect handles it */ }
}

async function hello() {
  post({
    type: 'hello', install_id: await installId(), version: chrome.runtime.getManifest().version,
    chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null,
    file_access: await chrome.extension.isAllowedFileSchemeAccess(),
  });
}

function connect() {
  if (port) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  try { port = chrome.runtime.connectNative(HOST); }
  catch (error) { lastError = String(error?.message ?? error); schedule(); return; }
  port.onMessage.addListener(message => { retries = 0; lastError = null; void handle(message); });
  port.onDisconnect.addListener(() => {
    lastError = chrome.runtime.lastError?.message ?? 'disconnected';
    port = null;
    void detachAll();
    schedule();
  });
  void hello();
}

function schedule() {
  if (retryTimer) return;
  const delay = RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)];
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
}

async function detachAll() {
  for (const tabId of [...attached]) {
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

// ---------- requests from the Worker ----------

function allowedUrl(value) {
  if (value === 'about:blank') return true;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}

async function smartsellWindow() {
  const { windowId } = await session();
  if (windowId !== null) {
    const window = await chrome.windows.get(windowId).catch(() => null);
    if (window) return window.id;
  }
  return null;
}

async function open(url) {
  if (!allowedUrl(url)) throw new Error('URL not allowed');
  let windowId = await smartsellWindow();
  let tab;
  if (windowId === null) {
    // A window of its own keeps SmartSell's work out of the owner's tab strip; unfocused so it does not take the screen.
    const window = await chrome.windows.create({ url, focused: false, type: 'normal' });
    windowId = window.id;
    tab = window.tabs[0];
  } else {
    tab = await chrome.tabs.create({ windowId, url, active: true });
  }
  const { owned } = await session();
  await setSession({ owned: [...owned, tab.id], windowId });
  return { tabId: tab.id };
}

async function requireOwned(tabId) {
  if (!Number.isInteger(tabId) || !await owns(tabId)) throw new Error('Not a SmartSell tab');
}

async function attach(tabId) {
  await requireOwned(tabId);
  if (attached.has(tabId)) return {};
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  return {};
}

async function command(tabId, method, params) {
  await requireOwned(tabId);
  if (!attached.has(tabId)) throw new Error('Not attached');
  if (typeof method !== 'string' || !DOMAINS.some(prefix => method === prefix || method.startsWith(prefix))) throw new Error(`${method} is not allowed`);
  if (method === 'Page.navigate' && !allowedUrl(params?.url)) throw new Error('URL not allowed');
  return await chrome.debugger.sendCommand({ tabId }, method, params ?? {}) ?? {};
}

async function close(tabId) {
  await requireOwned(tabId);
  if (attached.delete(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
  const { owned } = await session();
  await setSession({ owned: owned.filter(id => id !== tabId) });
  return {};
}

async function activate(tabId) {
  await requireOwned(tabId);
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return {};
}

async function tabs() {
  const { owned } = await session();
  const found = [];
  for (const tabId of owned) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) found.push({ tabId, url: tab.url ?? tab.pendingUrl ?? '', attached: attached.has(tabId) });
  }
  return { tabs: found };
}

const operations = {
  open: message => open(String(message.url ?? 'about:blank')),
  attach: message => attach(message.tabId),
  cdp: message => command(message.tabId, message.method, message.params),
  close: message => close(message.tabId),
  activate: message => activate(message.tabId),
  tabs: () => tabs(),
};

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'ping') { post({ type: 'pong' }); return; }
  const operation = operations[message.op];
  if (typeof message.id !== 'number') return;
  if (!operation) { post({ id: message.id, error: `Unknown operation ${String(message.op)}` }); return; }
  try { post({ id: message.id, result: await operation(message) }); }
  catch (error) { post({ id: message.id, error: String(error?.message ?? error) }); }
}

// ---------- events back to the Worker ----------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined && attached.has(source.tabId)) post({ type: 'event', tabId: source.tabId, method, params: params ?? {} });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined || !attached.delete(source.tabId)) return;
  // reason "canceled_by_user": the owner pressed Cancel on Chrome's debugging bar. The Worker stops that job.
  post({ type: 'detached', tabId: source.tabId, reason });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void session().then(({ owned }) => {
    if (!owned.includes(tabId)) return;
    attached.delete(tabId);
    post({ type: 'closed', tabId });
    return setSession({ owned: owned.filter(id => id !== tabId) });
  });
});

// ---------- popup status ----------

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'status') return false;
  void Promise.all([installId(), chrome.extension.isAllowedFileSchemeAccess()]).then(([id, fileAccess]) => reply({
    connected: !!port && !lastError, error: lastError, install_id: id, file_access: fileAccess, tabs: attached.size,
  }));
  return true;
});

// ---------- start ----------

// An open native port keeps this service worker alive; the alarm brings it back after Chrome stopped it while the Worker
// App was not running.
chrome.alarms.create('smartsell-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'smartsell-reconnect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
