#!/usr/bin/env node
/**
 * SmartSell 示範資料（Demo data through the Agent path）
 *
 * Builds the brand "Glow Lab 光研" the way a real local Agent would: every record is entered through the MCP
 * server with an Agent connection token. The signed-in person only does what a person must do: connect the Agent,
 * register the brand's own social accounts, approve publications, record what was published, and assign tasks.
 *
 *   pnpm seed:demo [--origin http://localhost:5173] [--email you@example.com] [--password …] [--slug glow-lab-demo]
 *
 * Password: --password, else SMARTSELL_SEED_PASSWORD, else .local/dev-credentials.txt (email=… / password=… lines).
 * Every write carries an idempotency key, and finished steps are remembered in .local/seed-demo.<slug>.json
 * (mode 600, includes the Agent token), so an interrupted run resumes where it stopped. Secrets are never printed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = { name: 'Glow Lab 光研', slug: 'glow-lab-demo' };
const TZ = 'Asia/Taipei';
const AGENT_LABEL = '示範資料 Agent';

// ───────────────────────────── arguments and credentials ─────────────────────────────
const { values: args } = parseArgs({ args: process.argv.slice(2).filter(arg => arg !== '--'), options: {
  origin: { type: 'string', default: 'http://localhost:5173' }, email: { type: 'string' }, password: { type: 'string' },
  slug: { type: 'string', default: BRAND.slug }, workspace: { type: 'string' }, 'stop-after': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} });
if (args.help) {
  console.log('Usage: pnpm seed:demo [--origin URL] [--email EMAIL] [--password PASSWORD] [--slug SLUG] [--workspace ID]');
  process.exit(0);
}
const origin = new URL(args.origin).origin;
const slug = args.slug;
if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) fatal('--slug 只能用小寫英數與連字號 (lowercase letters, digits, hyphens).');

function devCredentials() {
  const file = join(ROOT, '.local', 'dev-credentials.txt');
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.match(/^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/))
    .filter(Boolean).map(match => [match[1].toLowerCase(), match[2]]));
}
const local = devCredentials();
const email = args.email ?? process.env.SMARTSELL_SEED_EMAIL ?? local.email;
const password = args.password ?? process.env.SMARTSELL_SEED_PASSWORD ?? (!args.email || args.email === local.email ? local.password : undefined);
if (!email || !password) fatal('需要登入帳密：--email 與 --password，或設定 SMARTSELL_SEED_PASSWORD (credentials required).');

// ───────────────────────────── small pure helpers ─────────────────────────────
function fatal(message) { console.error(`\n✖ ${message}`); process.exit(1); }
const log = (message = '') => console.log(message);
const dayFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const localDate = (ms = Date.now()) => dayFmt.format(new Date(ms));
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** An instant at a Taipei wall-clock time (Taipei has no DST). */
export const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+08:00`).toISOString();
export function prng(seed) {
  let a = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const csv = rows => rows.map(row => row.map(cell => {
  const text = cell == null ? '' : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}).join(',')).join('\n') + '\n';
/** Daily views of one post: a launch-day spike that decays, with mild noise. Day 0 is the publication day. */
export function viewCurve(peak, days, random, evening = true) {
  return Array.from({ length: days }, (_, day) => {
    const shape = day === 0 ? (evening ? 0.45 : 0.8) : day === 1 ? 1 : Math.pow(0.62, day - 1);
    return Math.max(3, Math.round(peak * shape * (0.85 + random() * 0.3)));
  });
}
const mask = token => typeof token === 'string' ? `${token.slice(0, 11)}…（已遮罩 masked, ${token.length} chars）` : '—';
/** A tiny solid-colour PNG, enough to exercise the media upload path. */
function png(rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const size = 64, header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => rgb[i % 3])]);
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

// ───────────────────────────── resumable state ─────────────────────────────
const stateFile = join(ROOT, '.local', `seed-demo.${slug}.json`);
const scope = createHash('sha256').update(`${origin}|${email}|${slug}`).digest('hex').slice(0, 16);
let state = (() => {
  try { const saved = JSON.parse(readFileSync(stateFile, 'utf8')); if (saved.scope === scope) return saved; } catch { /* no state yet */ }
  return { scope, anchor: localDate(), steps: {} };
})();
function save() {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
  chmodSync(stateFile, 0o600);
}
const anchor = state.anchor; // "today" for this seed, kept on resume so keys and dates stay identical
const day = n => addDays(anchor, n);
const keyOf = step => `seed-demo:${slug}:${anchor}:${step}`.slice(0, 200);
/** Runs a logical step once. Its small result is remembered; a retried write replays through its idempotency key. */
async function step(name, run) {
  if (Object.hasOwn(state.steps, name)) return state.steps[name];
  const result = await run(keyOf(name));
  state.steps[name] = result ?? null;
  save();
  return result;
}

// ───────────────────────────── clients ─────────────────────────────
/** fetch with patient retries: a busy dev server or a 503 retry hint is retried with the same idempotency key. */
async function send(url, init, tries = 4) {
  for (let round = 1; ; round++) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 503 || round >= tries) return response;
    } catch (error) {
      if (round >= tries) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 3000 * round));
  }
}
class CallError extends Error {
  constructor(who, operation, status, code, message, details) {
    super(`${who} ${operation}: ${code} ${message}`);
    Object.assign(this, { who, operation, status, code, reason: message, details });
  }
}
// Operations the Agent was not allowed to run, and other findings; kept in the state so a resumed run still reports them.
state.refused ??= []; state.notes ??= [];
const refused = { push(row) { if (!state.refused.some(item => item.operation === row.operation)) state.refused.push(row); save(); } };
const notes = { push(text) { if (!state.notes.includes(text)) state.notes.push(text); save(); } };

const human = {
  cookie: '', csrf: '', ws: '', user: null,
  async login() {
    const response = await fetch(`${origin}/api/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password }) }).catch(error => fatal(`無法連線 ${origin}（${error.cause?.code ?? error.message}）。請先執行 pnpm dev。`));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) fatal(`登入失敗 Sign-in failed (HTTP ${response.status} ${body.error?.code ?? ''})。`);
    const session = body.data ?? body;
    if (!session.user) fatal('這個帳號需要二階段驗證，示範腳本無法代為完成 (2FA required).');
    this.cookie = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    this.csrf = session.csrf_token ?? (await this.raw('GET', '/api/v1/session/csrf')).csrf_token;
    this.user = session.user;
    const workspaces = session.workspaces ?? [];
    const chosen = args.workspace ? workspaces.find(row => row.id === args.workspace)
      : workspaces.find(row => ['owner', 'admin'].includes(row.role)) ?? workspaces[0];
    if (!chosen) fatal(args.workspace ? `找不到工作區 ${args.workspace}` : '這個帳號沒有工作區 (no workspace).');
    if (!['owner', 'admin'].includes(chosen.role)) fatal(`需要工作區擁有者或管理員 (owner/admin required; role is ${chosen.role}).`);
    this.ws = chosen.id;
    return chosen;
  },
  async raw(method, path, { body, version, key } = {}) {
    const headers = { origin, cookie: this.cookie, accept: 'application/json' };
    if (method !== 'GET') Object.assign(headers, { 'x-csrf-token': this.csrf, 'content-type': 'application/json' });
    if (key) headers['idempotency-key'] = key;
    if (version != null) headers['if-match'] = `"${version}"`;
    const response = await send(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 200) } }; }
    if (!response.ok) {
      const error = json.error ?? json;
      throw new CallError('human', `${method} ${path.replace(/^\/api\/v1\/workspaces\/[^/]+/, '')}`, response.status, error.code ?? response.status, error.message ?? '', error.details);
    }
    return json;
  },
  /** Workspace-relative REST call; returns `data`. */
  async call(method, path, options) { return (await this.raw(method, `/api/v1/workspaces/${this.ws}${path}`, options)).data; },
  async view(path, query = {}) {
    const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value != null)).toString();
    return this.raw('GET', `/api/v1/workspaces/${this.ws}/views/${path}${search ? `?${search}` : ''}`);
  },
};

const agent = {
  token: '', tools: new Set(), id: 0, calls: 0,
  async rpc(method, params) {
    const response = await send(`${origin}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.token}`,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, ...(params && { params }) }) });
    if (response.status === 401 || response.status === 403) throw new CallError('agent', method, response.status, 'UNAUTHENTICATED', 'Agent token rejected');
    const text = await response.text();
    const payload = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(message => message.id === this.id)
      : JSON.parse(text);
    if (payload?.error) throw new CallError('agent', method, response.status, payload.error.code, payload.error.message);
    return payload?.result;
  },
  async connect(token) {
    this.token = token;
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smartsell-seed-demo', version: '1.0.0' } });
    await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const { tools } = await this.rpc('tools/list', {});
    this.tools = new Set(tools.map(tool => tool.name));
    return tools.length;
  },
  /** Runs one Operation: its own curated tool when there is one, else smartsell_operation_call. Returns {data, next_cursor, etag}. */
  async op(operation, { params, query, body, version, key } = {}) {
    const input = { ...(params && { params }), ...(query && { query }), ...(body && { body }),
      ...(version != null && { expected_version: version }), ...(key && { idempotency_key: key }) };
    const curated = this.tools.has(operation);
    this.calls++;
    const result = await this.rpc('tools/call', { name: curated ? operation : 'smartsell_operation_call', arguments: curated ? input : { operation, ...input } });
    const content = result?.structuredContent ?? (() => { try { return JSON.parse(result?.content?.[0]?.text ?? '{}'); } catch { return {}; } })();
    if (result?.isError || content.error) {
      const error = content.error ?? {};
      const failure = new CallError('agent', operation, 0, error.code ?? 'TOOL_ERROR', error.message ?? 'Tool call failed', error.details);
      if (['HUMAN_REQUIRED', 'PERMISSION_DENIED', 'UNKNOWN_OPERATION', 'FORBIDDEN', 'HUMAN_SESSION_REQUIRED'].includes(failure.code)) {
        refused.push({ operation, code: failure.code, message: failure.reason });
      }
      throw failure;
    }
    // A refusal recorded by an earlier run no longer holds once the same operation succeeds.
    if (state.refused.some(row => row.operation === operation)) { state.refused = state.refused.filter(row => row.operation !== operation); save(); }
    return content;
  },
  async data(operation, options) { return (await this.op(operation, options)).data; },
  async list(operation, options = {}) {
    const rows = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const { data, next_cursor } = await this.op(operation, { ...options, query: { limit: 200, ...options.query, ...(cursor && { cursor }) } });
      rows.push(...(Array.isArray(data) ? data : []));
      if (!next_cursor) break;
      cursor = next_cursor;
    }
    return rows;
  },
};

/** Optional demo features: a refusal or a validation error is recorded and the seed carries on. */
async function attempt(label, run) {
  try {
    const result = await run();
    // A note left by an earlier failed run of this same step is stale once the step succeeds.
    if (state.notes.some(note => note.startsWith(`${label}：`))) { state.notes = state.notes.filter(note => !note.startsWith(`${label}：`)); save(); }
    return result;
  } catch (error) {
    if (!(error instanceof CallError)) throw error;
    notes.push(`${label}：${error.who === 'agent' ? 'Agent' : '人'} ${error.operation} → ${error.code} ${error.reason}`);
    return undefined;
  }
}

// ───────────────────────────── demo content ─────────────────────────────
const MARKETS = [
  { key: 'TW', name: '台灣', country_code: 'TW', primary_language: 'zh-TW', currency: 'TWD', timezone: 'Asia/Taipei' },
  { key: 'HK', name: '香港', country_code: 'HK', primary_language: 'zh-HK', currency: 'HKD', timezone: 'Asia/Hong_Kong' },
  { key: 'US', name: '美國', country_code: 'US', primary_language: 'en-US', currency: 'USD', timezone: 'America/Los_Angeles' },
];
// Prices are major units as a store export shows them; stock is units on hand. A missing market is not listed (未採集).
const PRODUCTS = [
  { id: 'GL-HA', title: '玻尿酸保濕精華 Hydra B5 Serum', handle: 'hydra-b5-serum', variants: [
    { id: 'GL-HA-30', sku: 'GL-HA-30ML', option: '30ml', TW: [1280, 86], HK: [328, 40], US: [42, 120] },
    { id: 'GL-HA-50', sku: 'GL-HA-50ML', option: '50ml', TW: [1880, 54], HK: [468, 22], US: [58, 75] }] },
  { id: 'GL-VC', title: '15% 維他命C亮白精華 Vitamin C Bright Serum', handle: 'vitamin-c-bright-serum', variants: [
    { id: 'GL-VC-30', sku: 'GL-VC-30ML', option: '30ml', TW: [1580, 12], HK: [398, 35], US: [52, 64] }] }, // TW low stock
  { id: 'GL-CER', title: '神經醯胺修護霜 Ceramide Barrier Cream', handle: 'ceramide-barrier-cream', variants: [
    { id: 'GL-CER-50', sku: 'GL-CER-50ML', option: '50ml', TW: [1480, 140], HK: [368, 0], US: [48, 90] }] }, // HK sold out
  { id: 'GL-AMN', title: '胺基酸溫和潔面乳 Amino Gentle Cleanser', handle: 'amino-gentle-cleanser', variants: [
    { id: 'GL-AMN-120', sku: 'GL-AMN-120ML', option: '120ml', TW: [580, 300], HK: [148, 85] },
    { id: 'GL-AMN-200', sku: 'GL-AMN-200ML', option: '200ml', TW: [820, 180], HK: [198, 60] }] },
  { id: 'GL-SPF', title: '清透防曬乳 SPF50+ PA++++ Daily Sunscreen', handle: 'daily-sunscreen-spf50', variants: [
    { id: 'GL-SPF-50', sku: 'GL-SPF-50ML', option: '50ml', TW: [880, 210], HK: [228, 95], US: [29, 140] }] },
];
// Entered by hand (not in the store export): a new product the store file does not have yet.
const MANUAL_PRODUCT = { title: '積雪草舒緩面膜 Cica Calming Mask', handle: 'cica-calming-mask', variants: [
  { sku: 'GL-CICA-5', option: '5 片/盒', TW: [680, 45] }, { sku: 'GL-CICA-10', option: '10 片/盒', TW: [1180, 26] }] };

const CAPTIONS = {
  launch: '冬季保濕季開跑 ❄️ 即日起至 11/30，全館滿 NT$2,000 送積雪草舒緩面膜 5 片裝。\n乾冷天的保濕三步驟：洗 → 精華 → 修護霜，一次備齊。\n#GlowLab光研 #冬季保濕',
  launchHK: '冬季保濕季開始喇 ❄️ 至 11/30 全店滿 HK$520 送積雪草面膜 5 片裝。\n#GlowLab光研 #冬日保濕',
  hydra: '乾燥肌急救三步驟 💧\n1️⃣ 溫和潔面不拔乾\n2️⃣ 玻尿酸精華趁濕按壓\n3️⃣ 神經醯胺霜鎖水\n留言告訴我們你最常在哪一步卡關？',
  hydra2: '乾燥肌急救三步驟 💧（更新：補上用量建議）\n1️⃣ 溫和潔面不拔乾\n2️⃣ 玻尿酸精華 2–3 滴，趁濕按壓\n3️⃣ 神經醯胺霜黃豆大小鎖水\n留言告訴我們你最常在哪一步卡關？',
  ceramide: '換季泛紅怎麼辦？🌿 先把屏障補回來。神經醯胺修護霜不含香精、酒精，敏感肌也能天天用。',
  cica: '睡前 15 分鐘的舒緩儀式 🌙 積雪草面膜冷藏後敷，泛紅、緊繃感明顯降溫。',
  review: '50ml 回購率最高的一瓶 ✨ 整理了 30 則真實回饋：「冬天不再脫皮」「上妝不卡粉」。',
  teaser: '12.12 只有一天 ⏰ 15% 維他命C亮白精華限時優惠，搭配防曬一起入手更划算。先收藏，當天見！',
  vcRoutine: '維C精華怎麼搭防曬？☀️ 早晨順序：潔面 → 維C精華 → 保濕 → 防曬，等 1 分鐘再上下一層。',
  story: '光研實驗室的一天 🔬 從配方打樣到 2,000 人試用，我們怎麼決定一瓶精華的濃度。',
  tiktok: '15 秒看懂乾燥肌保養順序 #保養 #乾燥肌',
  youtube: '【完整教學】換季敏感肌的修護保養：成分怎麼選、順序怎麼排',
};

// ───────────────────────────── phases ─────────────────────────────
async function main() {
  log(`SmartSell 示範資料 · ${BRAND.name} (${slug}) → ${origin}`);
  const ws = await human.login();
  log(`✓ 人：已登入 ${human.user.email}，工作區「${ws.name}」 (${ws.role})`);
  if (state.steps['done']) {
    log(`\n已在 ${state.steps.done.at} 完成過示範資料，這次不重複建立。`);
    return verify(state.steps.brand.id);
  }

  // 0 — Person sets the workspace time zone once, so dashboards show the demo's Taiwan-local times correctly.
  await step('workspace-timezone', async key => {
    const settings = await human.call('GET', '');
    if (settings.default_timezone && settings.default_timezone !== 'UTC') return { default_timezone: settings.default_timezone };
    return human.call('PATCH', '', { key, version: settings.version || undefined, body: { default_timezone: 'Asia/Taipei' } });
  });

  // 1 — Person connects the Agent (after checking the brand does not exist yet, so a re-run never leaves a stray token).
  const existing = (await human.call('GET', '/brands?limit=200')).find(row => row.slug === slug);
  if (existing && existing.id !== state.steps.brand?.id) {
    log(`\n品牌代號「${slug}」已存在（${existing.name}，id ${existing.id}），為避免重複，這次不做任何變更。`);
    log('Brand already exists; nothing was changed. 要重建請先在進階工作台封存它，或用 --slug 指定新代號。');
    return;
  }
  const connection = await step('agent-connection', async key => {
    const data = await human.call('POST', '/agent-connections', { key, body: { label: AGENT_LABEL, client: 'claude_code', expires_days: 30 } });
    return { id: data.id, token: data.token, mcp_url: data.mcp_url };
  });
  const toolCount = await agent.connect(connection.token).catch(error => fatal(`Agent 連線失敗：${error.message}（權杖可能已撤銷；刪除 ${stateFile} 後重跑）`));
  log(`✓ 人：已連接「${AGENT_LABEL}」，權杖 ${mask(connection.token)}；Agent 可用 ${toolCount} 個 MCP 工具`);

  // 2 — Agent: brand, markets, store, catalog.
  const brand = await phaseCatalog();
  if (args['stop-after'] === 'catalog') return;

  // 3 — Person: owned social accounts (only a person may attest ownership), before any scheduling.
  const accounts = await phaseAccounts(brand);

  // 4 — Agent: promotion plans, content, schedules, approvals requested.
  const plans = await phasePlans(brand, accounts);
  const content = await phaseContent(brand, accounts, plans);
  if (args['stop-after'] === 'content') return;

  // 5 — Person: approve some publications, record the ones already published, assign a task.
  await phaseHumanDecisions(brand, content, plans);

  // 6 — Agent: past posts and their daily results, ads, and the assigned task.
  const posts = await phaseResults(brand, accounts, content);
  await phaseAds(brand, plans);
  await phaseAgentJob(brand, plans);

  // 7 — Person: one open task for the Agent.
  await step('job-open', key => human.call('POST', '/agent-jobs', { key, body: { title: '幫雙12 維C亮白快閃寫 3 版 15 秒 TikTok 腳本，先存成草稿不要送審',
    kind: 'custom', expected_output: { type: 'note' }, input_scope: { brand_ids: [brand.id], campaign_id: plans.flash.id } } }).then(job => ({ id: job.id })));
  log('✓ 人：交辦了一件待 Agent 接手的任務');

  state.steps.done = { at: new Date().toISOString(), posts: posts.length };
  save();
  await verify(brand.id);
}

async function phaseCatalog() {
  const brand = await step('brand', async key => {
    const rows = await agent.list('workspace_brands_list');
    const found = rows.find(row => row.slug === slug);
    if (found) throw new CallError('agent', 'workspace_brands_list', 409, 'BRAND_EXISTS', `brand ${slug} already exists (${found.id})`);
    const row = await agent.data('workspace_brand_create', { key, body: { name: BRAND.name, slug } });
    return { id: row.id, version: row.version };
  });
  const markets = {};
  for (const market of MARKETS) {
    const { key: code, ...body } = market;
    markets[code] = await step(`market-${code}`, async key => {
      const row = await agent.data('workspace_market_create', { key, params: { id: brand.id }, body: { ...body, sales_channels: ['online_store'] } });
      return { id: row.id, currency: row.currency };
    });
  }
  await step('brand-default-market', async key => {
    const current = await agent.data('workspace_brand_get', { params: { id: brand.id } });
    if (current.default_market_id === markets.TW.id) return { skipped: true };
    const row = await agent.data('workspace_brand_update', { key, params: { id: brand.id }, version: current.version, body: { default_market_id: markets.TW.id } });
    return { version: row.version };
  });
  log(`✓ Agent：建立品牌「${BRAND.name}」與 3 個市場（台灣／香港／美國）`);

  const store = await step('store', async key => {
    const row = await agent.data('commerce_store_create', { key, body: { brand_id: brand.id, provider: 'file_import', mode: 'import',
      external_store_id: `${slug}-official`, name: 'Glow Lab 官方網店（檔案匯入）', default_currency: 'TWD', default_locale: 'zh-TW' } });
    return { id: row.id };
  });
  await step('store-markets', key => agent.data('commerce_store_market_configure', { key, params: { id: store.id }, body: {
    markets: MARKETS.map(market => ({ market_id: markets[market.key].id, channel: 'online_store', low_stock_threshold: 20, enabled: true })) } })
    .then(rows => ({ count: rows.length })));

  // The store export, as an Agent would import it: one row per variant and market.
  const header = ['external_product_id', 'external_variant_id', 'handle', 'title', 'sku', 'option1', 'market_id', 'channel', 'currency', 'price', 'available'];
  const rows = PRODUCTS.flatMap(product => product.variants.flatMap(variant => MARKETS.filter(market => variant[market.key]).map(market =>
    [product.id, variant.id, product.handle, product.title, variant.sku, variant.option, markets[market.key].id, 'online_store', market.currency,
      variant[market.key][0], variant[market.key][1]])));
  const batch = await step('import-products', async key => {
    const created = await agent.data('import_create', { key, body: { template_key: 'product_list', store_id: store.id, csv_text: csv([header, ...rows]) } });
    return { id: created.id, version: created.version };
  });
  await confirmImport('import-products', batch.id);
  await step('manual-product', async key => {
    const product = await agent.data('commerce_product_create', { key: `${key}:product`, body: { store_id: store.id, title: MANUAL_PRODUCT.title,
      handle: MANUAL_PRODUCT.handle, status: 'active', product_type: '面膜', vendor: 'Glow Lab' } });
    const variants = [];
    for (const [index, variant] of MANUAL_PRODUCT.variants.entries()) {
      const row = await agent.data('commerce_variant_create', { key: `${key}:variant-${index}`, params: { id: product.id }, body: { sku: variant.sku, options: { 規格: variant.option } } });
      await agent.data('commerce_record_listing', { key: `${key}:listing-${index}-TW`, params: { id: row.id }, body: { market_id: markets.TW.id, channel: 'online_store',
        price_amount_minor: variant.TW[0] * 100, currency: 'TWD', inventory_quantity: variant.TW[1], available_for_sale: true } });
      // Hong Kong is configured but nobody has checked the shelf there yet: say so instead of guessing.
      await agent.data('commerce_record_listing', { key: `${key}:listing-${index}-HK`, params: { id: row.id }, body: { market_id: markets.HK.id, channel: 'online_store',
        availability: 'not_collected' } });
      variants.push(row.id);
    }
    return { id: product.id, variants };
  });
  const catalog = await step('catalog', async () => {
    const found = await agent.list('catalog_search', { query: { store_id: store.id } });
    const products = {};
    for (const row of found) {
      const product = row.product ?? row;
      const code = PRODUCTS.find(item => item.title === product.title)?.id ?? (product.title === MANUAL_PRODUCT.title ? 'GL-CICA' : undefined);
      if (code && product.id) products[code] = product.id;
    }
    return { products };
  });
  if (!catalog.products['GL-HA']) notes.push(`catalog_search 沒找到匯入的商品（找到 ${Object.keys(catalog.products).length} 筆）`);
  log(`✓ Agent：匯入 ${PRODUCTS.length} 個商品（${rows.length} 列市場價格與庫存），另手動建立 1 個新品`);
  return { ...brand, markets, store, products: catalog.products };
}

/** Backpressure for the shared dev server: wait while a trivial read is slow (each imported row queues background jobs). */
async function settle() {
  for (let waited = 0; waited < 900_000;) {
    const started = Date.now();
    await human.raw('GET', '/api/v1/session').catch(() => undefined);
    if (Date.now() - started < 1500) return;
    await new Promise(resolve => setTimeout(resolve, 10_000));
    waited += Date.now() - started + 10_000;
  }
}

async function confirmImport(name, id) {
  return step(`${name}-confirm`, async key => {
    let batch;
    for (let round = 1; round <= 200; round++) {
      await settle();
      batch = await agent.data('import_confirm', { key: `${key}:${round}`, params: { id }, body: { limit: 40 } });
      if (batch.status !== 'merging') break;
    }
    if (batch.failed_rows > 0) {
      const failed = await agent.data('import_rows', { params: { id }, query: { status: 'merge_failed', limit: 5 } }).catch(() => []);
      const invalid = await agent.data('import_rows', { params: { id }, query: { status: 'invalid', limit: 5 } }).catch(() => []);
      notes.push(`${name}：${batch.failed_rows} 列未合併，例如 ${JSON.stringify([...failed, ...invalid].slice(0, 2).map(row => row.issues))}`);
    }
    return { status: batch.status, merged: batch.merged_rows, failed: batch.failed_rows, skipped: batch.skipped_rows };
  });
}

async function phaseAccounts(brand) {
  const defs = [
    { key: 'ig', provider: 'meta_instagram', platform: 'instagram', display_name: 'Glow Lab 光研｜Instagram', handle: 'glowlab.tw' },
    { key: 'tt', provider: 'tiktok', platform: 'tiktok', display_name: 'Glow Lab 光研｜TikTok', handle: 'glowlab.tw' },
    { key: 'yt', provider: 'youtube', platform: 'youtube', display_name: 'Glow Lab 光研 頻道', handle: 'GlowLabTW' },
  ];
  const accounts = {};
  for (const def of defs) {
    accounts[def.key] = await step(`account-${def.key}`, async key => {
      const row = await human.call('POST', '/social-accounts', { key, body: { provider: def.provider, external_account_id: `${slug}-${def.key}`,
        display_name: def.display_name, brand_id: brand.id, default_timezone: TZ, owned_account_confirmed: true } });
      return { id: row.id, platform: def.platform, handle: def.handle };
    });
  }
  log('✓ 人：登記品牌自有社群帳號 Instagram、TikTok、YouTube');
  return accounts;
}

async function phasePlans(brand, accounts) {
  const { markets, products } = brand;
  const winter = await step('plan-winter', async key => {
    const row = await agent.data('campaign_create_draft', { key, body: {
      brand_id: brand.id, name: '冬季保濕季 Winter Hydration Season', kind: 'seasonal', timezone: TZ,
      starts_at: at(day(-8), '10:00'), ends_at: at(day(10), '23:59'),
      objective_summary: '乾冷季節主打玻尿酸精華與修護霜，滿額送面膜拉高客單。',
      audience_note: '25–40 歲乾燥、敏感肌女性；台灣為主、香港為輔。',
      markets: [{ market_id: markets.TW.id, locales: ['zh-TW'] }, { market_id: markets.HK.id, locales: ['zh-HK'] }],
      products: [{ product_id: products['GL-HA'], role: 'hero' }, { product_id: products['GL-CER'], role: 'supporting' }, ...(products['GL-CICA'] ? [{ product_id: products['GL-CICA'], role: 'gift' }] : [])],
      goals: [
        { metric_key: 'norm.post.views', unit: 'count', baseline_value: 180000, baseline_source: '2026 夏季防曬活動實績', target_value: 250000, due_at: at(day(10), '23:59') },
        { metric_key: 'norm.post.engagements', unit: 'count', baseline_value: 9800, baseline_source: '2026 夏季防曬活動實績', target_value: 15000, due_at: at(day(10), '23:59') },
      ],
      plan_slots: [
        { stage: 'launch', platform: 'meta_instagram', social_account_id: accounts.ig.id, market_id: markets.TW.id, locale: 'zh-TW', planned_count: 6, content_format: 'feed_image' },
        { stage: 'sustain', platform: 'meta_instagram', social_account_id: accounts.ig.id, market_id: markets.HK.id, locale: 'zh-HK', planned_count: 2 },
        { stage: 'launch', platform: 'tiktok', social_account_id: accounts.tt.id, planned_count: 4, content_format: 'short_video' },
        { stage: 'sustain', platform: 'youtube', social_account_id: accounts.yt.id, planned_count: 2, content_format: 'long_video' },
        { stage: 'conversion', platform: 'meta_instagram', social_account_id: accounts.ig.id, market_id: markets.TW.id, locale: 'zh-TW', planned_count: 2 },
      ],
    } });
    return { id: row.id };
  });
  const flash = await step('plan-flash', async key => {
    const row = await agent.data('campaign_create_draft', { key, body: {
      brand_id: brand.id, name: '雙12 維C亮白快閃 12.12 Vitamin C Flash Sale', kind: 'promotion', timezone: TZ,
      starts_at: at(day(19), '00:00'), ends_at: at(day(24), '23:59'),
      objective_summary: '12.12 限時優惠，維C精華搭防曬組合，三個市場同步。',
      markets: MARKETS.map(market => ({ market_id: markets[market.key].id, locales: [market.primary_language] })),
      products: [{ product_id: products['GL-VC'], role: 'hero' }, { product_id: products['GL-SPF'], role: 'bundle' }],
      goals: [
        { metric_key: 'norm.post.views', unit: 'count', baseline_value: 60000, baseline_source: '2025 雙12 快閃實績', target_value: 120000, due_at: at(day(24), '23:59') },
        { metric_key: 'conversions', unit: 'count', baseline_value: 420, baseline_source: '2025 雙12 快閃實績', target_value: 800, due_at: at(day(24), '23:59') },
      ],
      plan_slots: [
        { stage: 'teaser', platform: 'meta_instagram', social_account_id: accounts.ig.id, market_id: markets.TW.id, locale: 'zh-TW', planned_count: 3 },
        { stage: 'launch', platform: 'tiktok', social_account_id: accounts.tt.id, planned_count: 3, content_format: 'short_video' },
        { stage: 'conversion', platform: 'meta_instagram', social_account_id: accounts.ig.id, market_id: markets.US.id, locale: 'en-US', planned_count: 1 },
      ],
    } });
    return { id: row.id };
  });
  // Budgets and production milestones, then move the plans out of draft (a draft is only an idea).
  for (const [plan, lines] of [[winter, [['ads', 6_000_000], ['creator', 3_000_000]]], [flash, [['ads', 4_500_000]]]]) {
    for (const [category, amount] of lines) {
      await step(`budget-${plan.id}-${category}`, key => agent.data('campaign_budget_line_create', { key, params: { id: plan.id },
        body: { category, amount_minor: amount, currency: 'TWD', fx_date: anchor } }).then(row => ({ id: row.id })));
    }
  }
  await step('milestones', async key => {
    await agent.data('campaign_milestone_create', { key: `${key}:kol`, params: { id: winter.id }, body: { title: 'KOL 開箱影片交付', due_at: at(day(2), '18:00') } });
    await agent.data('campaign_milestone_create', { key: `${key}:assets`, params: { id: flash.id }, body: { title: '雙12 主視覺與短影音素材定稿', due_at: at(day(9), '18:00') } });
    return { count: 2 };
  });
  for (const [plan, path] of [[winter, ['planned', 'active']], [flash, ['planned']]]) {
    for (const to of path) {
      await step(`transition-${plan.id}-${to}`, async key => {
        const current = await agent.data('campaign_get_context', { params: { id: plan.id } });
        const row = current.campaign ?? current;
        if (row.status === to) return { status: to };
        return agent.data('campaign_transition', { key, params: { id: plan.id }, version: row.version, body: { to, reason: '示範資料：計劃已確認' } })
          .then(changed => ({ status: changed.status }));
      });
    }
  }
  log('✓ Agent：建立 2 個推廣計劃（進行中的冬季保濕季、即將開始的雙12 快閃），含目標、商品、內容矩陣、預算與里程碑');
  return { winter, flash };
}

async function phaseContent(brand, accounts, plans) {
  const { markets } = brand;
  const IG = { account: 'ig', platform: 'instagram', format: 'text' }; // caption-led: the Agent cannot attach media yet (see report)
  const items = [
    { key: 'launch', plan: 'winter', title: '冬季保濕季開跑｜滿額送面膜', variants: [
      { ...IG, key: 'tw', caption: CAPTIONS.launch, locale: 'zh-TW', market: 'TW' }, { ...IG, key: 'hk', caption: CAPTIONS.launchHK, locale: 'zh-HK', market: 'HK' }] },
    { key: 'hydra', plan: 'winter', title: '玻尿酸精華｜乾燥肌急救三步驟', variants: [
      { ...IG, key: 'ig', caption: CAPTIONS.hydra, revise: CAPTIONS.hydra2, locale: 'zh-TW', market: 'TW' },
      { key: 'tt', account: 'tt', platform: 'tiktok', format: 'short_video', caption: CAPTIONS.tiktok, locale: 'zh-TW' }] },
    { key: 'ceramide', plan: 'winter', title: '神經醯胺修護霜｜換季泛紅怎麼辦', variants: [
      { ...IG, key: 'ig', caption: CAPTIONS.ceramide, locale: 'zh-TW', market: 'TW' },
      { key: 'yt', account: 'yt', platform: 'youtube', format: 'long_video', caption: CAPTIONS.youtube, locale: 'zh-TW' }] },
    { key: 'cica', plan: 'winter', title: '積雪草面膜｜睡前 15 分鐘舒緩儀式', variants: [
      { ...IG, key: 'ig', caption: CAPTIONS.cica, locale: 'zh-TW', market: 'TW' },
      { key: 'tt', account: 'tt', platform: 'tiktok', format: 'short_video', caption: CAPTIONS.cica, locale: 'zh-TW' }] },
    { key: 'review', plan: 'winter', title: '保濕精華 50ml 真實回饋整理', variants: [{ ...IG, key: 'ig', caption: CAPTIONS.review, locale: 'zh-TW', market: 'TW' }] },
    { key: 'teaser', plan: 'flash', title: '雙12 預告｜維C亮白精華限時優惠', variants: [
      { ...IG, key: 'ig', caption: CAPTIONS.teaser, locale: 'zh-TW', market: 'TW' },
      { key: 'tt', account: 'tt', platform: 'tiktok', format: 'short_video', caption: CAPTIONS.teaser, locale: 'zh-TW' }] },
    { key: 'vc', plan: 'flash', title: '維C精華怎麼搭防曬？早晨保養順序', variants: [
      { ...IG, key: 'ig', caption: CAPTIONS.vcRoutine, locale: 'zh-TW', market: 'TW' },
      { key: 'yt', account: 'yt', platform: 'youtube', format: 'long_video', caption: CAPTIONS.vcRoutine, locale: 'zh-TW' }] },
    { key: 'story', plan: null, title: '品牌故事｜光研實驗室的一天', variants: [{ ...IG, key: 'ig', caption: CAPTIONS.story, locale: 'zh-TW', market: 'TW' }] },
  ];

  // Probe: can the Agent attach an image? (Reserving works; finishing the upload is the open question.)
  await step('media-probe', async stepKey => {
    // A reservation from an earlier, failed run has expired by now, so each run reserves afresh.
    const key = `${stepKey}:${randomUUID().slice(0, 8)}`;
    const bytes = png([226, 238, 247]);
    const upload = await attempt('上傳商品圖（媒體）', () => agent.data('asset_begin_upload', { key: `${key}:begin`, body: { mime_type: 'image/png', size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), original_filename: 'glow-lab-hydra-serum.png' } }));
    if (!upload) return { uploaded: false };
    const done = await attempt('完成媒體上傳', () => agent.data('file_complete_upload', { key: `${key}:complete`, params: { id: upload.upload_id ?? upload.id }, body: { base64: bytes.toString('base64') } }));
    return { uploaded: Boolean(done) };
  });

  const content = {};
  for (const item of items) {
    const created = await step(`content-${item.key}`, async key => {
      const result = await agent.data('content_create_item', { key, body: { brand_id: brand.id, title: item.title, ...(item.plan && { campaign_id: plans[item.plan].id }) } });
      return { id: (result.item ?? result).id };
    });
    const variants = {};
    for (const variant of item.variants) {
      variants[variant.key] = await step(`variant-${item.key}-${variant.key}`, async key => {
        const made = await agent.data('content_create_variant', { key: `${key}:create`, params: { id: created.id }, body: { platform: variant.platform, format: variant.format,
          locale: variant.locale, ...(variant.market && { market_id: markets[variant.market].id }), social_account_id: accounts[variant.account].id } });
        const row = made.variant ?? made;
        const saved = await agent.data('content_autosave_variant', { key: `${key}:draft`, params: { id: row.id }, version: row.version, body: { body: variant.caption } });
        const revisionOf = result => result.revision?.id ?? result.variant?.current_revision_id ?? result.current_revision_id;
        let revisionId = revisionOf(await agent.data('content_commit_revision', { key: `${key}:commit`, params: { id: row.id }, body: { base_revision_id: null } }));
        if (variant.revise) { // a second saved revision, so the history shows an edit
          const current = await agent.data('content_get_variant', { params: { id: row.id } });
          const variantRow = current.variant ?? current;
          await agent.data('content_autosave_variant', { key: `${key}:draft-2`, params: { id: row.id }, version: variantRow.version, body: { body: variant.revise } });
          revisionId = revisionOf(await agent.data('content_commit_revision', { key: `${key}:commit-2`, params: { id: row.id }, body: { base_revision_id: revisionId } }));
        }
        if (!revisionId) throw new CallError('agent', 'content_commit_revision', 0, 'NO_REVISION', 'commit returned no revision id');
        return { id: row.id, revision: revisionId, account: variant.account, saved: saved.version };
      });
    }
    content[item.key] = { ...created, variants };
  }

  // Publication schedule: the next 14 days, plus the posts that already went out in the past 14 days.
  const schedule = [
    ['launch', 'tw', -7, '12:00', true], ['hydra', 'ig', -5, '19:30', true], ['cica', 'ig', -3, '20:00', true], ['review', 'ig', -1, '12:00', true],
    ['launch', 'tw', 1, '12:00', true], ['hydra', 'ig', 2, '19:30', true], ['hydra', 'tt', 2, '21:00', true], ['launch', 'hk', 3, '12:30', true],
    ['cica', 'ig', 4, '20:00', true], ['ceramide', 'ig', 5, '19:00', true], ['ceramide', 'yt', 6, '18:00', true], ['cica', 'tt', 7, '21:30', true],
    ['review', 'ig', 8, '12:00', false], ['teaser', 'ig', 11, '20:00', true], ['teaser', 'tt', 12, '21:00', false], ['vc', 'ig', 13, '19:30', true], ['vc', 'yt', 14, '18:00', false],
  ];
  const targets = [];
  for (const [item, variantKey, offset, time, submit] of schedule) {
    const variant = content[item].variants[variantKey];
    const name = `target-${item}-${variantKey}-${offset}`;
    const target = await step(name, async key => {
      const row = await agent.data('publishing_create_target', { key, body: { social_account_id: accounts[variant.account].id, content_variant_id: variant.id,
        revision_id: variant.revision, scheduled_at: at(day(offset), time), schedule_tz: TZ } });
      return { id: row.id };
    });
    const submitted = submit ? await step(`${name}-submit`, async key => {
      const row = await agent.data('publishing_request_approval', { key, params: { id: target.id } });
      const blockers = row.precheck?.items?.filter(check => check.severity === 'blocker').map(check => check.check_key) ?? [];
      return { status: row.submission_status ?? row.plan_status, blockers };
    }) : { status: 'draft', blockers: [] };
    targets.push({ ...target, item, variant: variantKey, account: variant.account, offset, scheduled_at: at(day(offset), time), ...submitted });
  }
  const blocked = targets.filter(target => target.status === 'blocked');
  if (blocked.length) {
    const reasons = [...new Set(blocked.flatMap(target => target.blockers))].join(', ');
    notes.push(`${blocked.length} 則排期送審被預檢擋下（${reasons}）：TikTok 的隱私等設定只能由人選；影片／圖片格式要先附上媒體（Agent 經 MCP 只能直接傳 512 KB 內的檔案，影片請在 Web 上傳）。`);
  }
  log(`✓ Agent：寫了 ${items.length} 則內容、${Object.values(content).reduce((n, row) => n + Object.keys(row.variants).length, 0)} 個平台版本（皆已存成修訂），排了 ${targets.length} 則發布，送審 ${targets.filter(t => t.status === 'awaiting_approval').length} 則`);
  return { items: content, targets };
}

async function phaseHumanDecisions(brand, content, plans) {
  const decisions = await human.view('decisions', { brand_id: brand.id, kind: 'publish_approval' });
  const pending = new Map((decisions.data ?? []).map(item => [item.resource.id, item]));
  const approve = content.targets.filter(target => target.status === 'awaiting_approval' && (target.offset < 0 || target.offset === 1 || target.offset === 2) && target.account === 'ig');
  let approved = 0;
  for (const target of approve) {
    const result = await step(`approve-${target.id}`, async key => {
      const item = pending.get(target.id);
      const action = item?.actions.find(entry => entry.key === 'approve');
      if (!action) return { skipped: item ? 'no approve action' : 'not in 待你決定' };
      const row = await human.call(action.method, action.path, { key, version: action.version, body: action.body });
      return { status: row.plan_status ?? row.status };
    });
    if (!result?.skipped) approved++;
    else notes.push(`核准 ${target.item}/${target.variant}（${target.scheduled_at.slice(0, 10)}）略過：${result.skipped}`);
  }
  log(`✓ 人：在「待你決定」核准了 ${approved} 則發布`);

  // The posts that already went out: a person records the publication with a screenshot as evidence
  // (an Agent may not mark anything published, and only a person can upload the evidence).
  let recorded = 0;
  for (const [index, target] of content.targets.filter(row => row.offset < 0 && row.status === 'awaiting_approval').entries()) {
    const post = await step(`published-${target.id}`, key => attempt(`登記已發布貼文 ${target.item}`, async () => {
      const bytes = png([236 - index * 9, 228, 214 + index * 8]);
      const upload = await human.call('POST', '/files/uploads', { key: `${key}:upload`, body: { purpose: 'evidence', mime_type: 'image/png', size_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), original_filename: `instagram-${target.scheduled_at.slice(0, 10)}.png` } });
      const file = await human.call('POST', `/files/uploads/${upload.id}/complete`, { key: `${key}:complete`, body: { base64: bytes.toString('base64') } });
      const row = await human.call('POST', `/publish-targets/${target.id}/register-post`, { key, body: {
        permalink: `https://www.instagram.com/p/GL${createHash('sha1').update(target.id).digest('hex').slice(0, 9)}/`,
        external_post_id: `ig-${target.id.slice(0, 8)}`, published_at: target.scheduled_at, evidence_file_ids: [file.id] } });
      return { id: row.id, external_post_id: row.external_post_id };
    }));
    if (post?.id) { target.post = post; recorded++; }
  }
  log(`✓ 人：登記了 ${recorded} 則已發布的排期貼文`);

  await step('job-review', key => human.call('POST', '/agent-jobs', { key, body: {
    title: '整理冬季保濕季上線第一週的社群成效：前三名貼文、未採集的日期', kind: 'custom', expected_output: { type: 'note' },
    input_scope: { brand_ids: [brand.id], campaign_id: plans.winter.id } } }).then(job => ({ id: job.id })));
  log('✓ 人：交辦一件「整理成效」任務給 Agent');
}

async function phaseResults(brand, accounts, content) {
  const random = prng(`${slug}:${anchor}`);
  const lastDay = day(-1);
  // About twenty earlier posts that were published outside SmartSell.
  const plan = [
    ['ig', [-30, -27, -24, -21, -18, -15, -12, -9, -2]], ['tt', [-29, -25, -20, -16, -11, -6, -4]], ['yt', [-28, -19, -10, -3]],
  ];
  const posts = [];
  for (const [account, offsets] of plan) {
    for (const [index, offset] of offsets.entries()) {
      const code = createHash('sha1').update(`${slug}:${account}:${offset}`).digest('hex');
      const external = account === 'yt' ? code.slice(0, 11) : account === 'tt' ? String(BigInt(`0x${code.slice(0, 15)}`)).padStart(19, '7').slice(0, 19) : `GL${code.slice(0, 9)}`;
      const permalink = account === 'ig' ? `https://www.instagram.com/p/${external}/` : account === 'tt'
        ? `https://www.tiktok.com/@${accounts.tt.handle}/video/${external}` : `https://www.youtube.com/watch?v=${external}`;
      const time = account === 'yt' ? '18:00' : index % 2 ? '12:30' : '20:00';
      const publishedAt = at(day(offset), time);
      const post = await step(`post-${account}${offset}`, key => agent.data('posts_register_manual', { key, body: {
        social_account_id: accounts[account].id, external_post_id: external, permalink, published_at: publishedAt } }).then(row => ({ id: row.id })));
      posts.push({ ...post, account, external, offset, evening: time >= '17:00' });
    }
  }
  for (const target of content.targets.filter(row => row.post?.external_post_id)) {
    posts.push({ id: target.post.id, account: 'ig', external: target.post.external_post_id, offset: target.offset, evening: target.scheduled_at >= at(day(target.offset), '17:00'), scheduled: true });
  }
  log(`✓ Agent：登記 ${posts.length - content.targets.filter(row => row.post).length} 則平台上既有的貼文（過去 30 天）`);

  // Daily results. Instagram missed two days of collection; one TikTok video has no report at all.
  const gap = new Set([day(-6), day(-5)]);
  const peaks = { ig: [1800, 6500], tt: [3500, 26000], yt: [900, 4200] };
  const silent = posts.find(post => post.account === 'tt' && post.offset === -6);
  const daily = new Map(); // account:date -> views summed across posts
  const postRows = { ig: [], tt: [], yt: [], scheduled: [] };
  for (const post of posts) {
    if (post === silent) continue;
    const [low, high] = peaks[post.account];
    const span = Math.round((Date.parse(lastDay) - Date.parse(day(post.offset))) / 86_400_000) + 1;
    const views = viewCurve(low + random() * (high - low), span, random, post.evening);
    views.forEach((value, index) => {
      const date = day(post.offset + index);
      const accountId = accounts[post.account].id;
      // The post report covers each post's first seven days, where nearly all of its views happen; later days only
      // count toward the account totals. (Kept small on purpose: the local dev store rescans its records per imported row.)
      const rows = index < 7 ? postRows[post.scheduled ? 'scheduled' : post.account] : [];
      if (post.account === 'ig' && gap.has(date)) {
        for (const metric of ['views', 'likes', 'comments', 'shares']) rows.push([accountId, post.external, date, metric, '', 'not_collected', 'day']);
        return;
      }
      daily.set(`${post.account}:${date}`, (daily.get(`${post.account}:${date}`) ?? 0) + value);
      const likes = Math.round(value * (0.035 + random() * 0.035)), comments = Math.round(value * (0.002 + random() * 0.006)), shares = Math.round(value * (0.004 + random() * 0.01));
      rows.push([accountId, post.external, date, 'views', value, 'observed', 'day'], [accountId, post.external, date, 'likes', likes, 'observed', 'day'],
        [accountId, post.external, date, 'comments', comments, 'observed', 'day'], [accountId, post.external, date, 'shares', shares, 'observed', 'day']);
    });
  }
  const header = ['social_account_id', 'external_post_id', 'report_date', 'metric_key', 'value', 'availability', 'period_kind'];
  let imported = 0;
  for (const account of ['ig', 'tt', 'yt', 'scheduled']) {
    // One export per account, sent in files of at most 120 rows so the server never works on one request for long.
    for (let part = 0; part * 120 < postRows[account].length; part++) {
      const name = `import-posts-${account}-${part + 1}`;
      const batch = await step(name, key => settle().then(() => agent.data('import_create', { key, body: { template_key: 'social_post_report',
        csv_text: csv([header, ...postRows[account].slice(part * 120, (part + 1) * 120)]), options: { timezone: TZ } } })).then(row => ({ id: row.id })));
      imported += (await confirmImport(name, batch.id)).merged ?? 0;
    }
  }
  // Account level: followers as a running total (lifetime snapshot per day), views per day. YouTube followers missed two days.
  const accountRows = [];
  const base = { ig: [12480, 34], tt: [8920, 71], yt: [2150, 9] };
  for (const account of ['ig', 'tt', 'yt']) {
    let followers = base[account][0];
    for (let offset = -30; offset <= -1; offset++) {
      const date = day(offset);
      followers += Math.round(base[account][1] * (0.4 + random() * 1.2));
      const accountId = accounts[account].id;
      if (!(account === 'yt' && (offset === -12 || offset === -11))) accountRows.push([accountId, date, 'followers', followers, 'observed', 'lifetime']);
      if (account === 'ig' && gap.has(date)) { accountRows.push([accountId, date, 'views', '', 'not_collected', 'day']); continue; }
      if (account !== 'yt') accountRows.push([accountId, date, 'views', Math.round((daily.get(`${account}:${date}`) ?? 0) * 1.18 + 300 + random() * 400), 'observed', 'day']);
    }
  }
  let accountMerged = 0;
  for (let part = 0; part * 120 < accountRows.length; part++) {
    const name = `import-accounts-${part + 1}`;
    const batch = await step(name, key => settle().then(() => agent.data('import_create', { key, body: { template_key: 'social_account_report',
      csv_text: csv([['social_account_id', 'report_date', 'metric_key', 'value', 'availability', 'period_kind'], ...accountRows.slice(part * 120, (part + 1) * 120)]),
      options: { timezone: TZ } } })).then(row => ({ id: row.id })));
    accountMerged += (await confirmImport(name, batch.id)).merged ?? 0;
  }
  log(`✓ Agent：匯入每日成效 ${imported} 列貼文指標、${accountMerged} 列帳號指標（IG ${day(-6)}、${day(-5)} 刻意標成未採集）`);
  return posts;
}

async function phaseAds(brand, plans) {
  const account = await step('ad-account', () => attempt('登記投放帳戶', async () => {
    const existing = (await agent.list('ads_list_accounts')).find(row => row.brand_id === brand.id);
    if (existing) return { id: existing.id };
    const row = await agent.data('ads_register_account', { key: keyOf('ad-account'), body: { provider: 'meta_ads', brand_id: brand.id,
      external_account_id: `act_${Number.parseInt(createHash('sha1').update(slug).digest('hex').slice(0, 10), 16)}`, currency: 'TWD', timezone: TZ, spend_cap_snapshot: 50_000_000 } });
    return { id: row.id };
  }));
  if (!account?.id) return log('… 投放：Agent 無法登記投放帳戶，略過（見報告）');
  const random = prng(`${slug}:ads`);
  const entities = [
    { key: 'always-on', name: 'GL｜常態再行銷 Always-on Retargeting', from: -20, missing: [-12, -11], spend: [900, 1400], campaign: null },
    { key: 'winter', name: 'GL｜冬季保濕｜轉換 Winter Conversions', from: -8, missing: [-4], spend: [2200, 3600], campaign: plans.winter.id },
  ];
  const imported = {};
  for (const entity of entities) {
    imported[entity.key] = await step(`ads-import-${entity.key}`, key => attempt(`匯入投放成效 ${entity.key}`, async () => {
      const observations = [];
      for (let offset = entity.from; offset <= -1; offset++) {
        const date = day(offset);
        if (entity.missing.includes(offset)) {
          for (const metric of ['spend', 'impressions', 'clicks', 'conversions']) observations.push({ metric_key: metric, date, availability: 'not_collected', definition: 'Meta Ads Manager daily export' });
          continue;
        }
        const spend = Math.round(entity.spend[0] + random() * (entity.spend[1] - entity.spend[0]));
        const impressions = Math.round(spend * (14 + random() * 6)), clicks = Math.round(impressions * (0.011 + random() * 0.009));
        observations.push({ metric_key: 'spend', value: spend * 100, date, availability: 'observed', definition: 'Meta Ads Manager daily export' },
          { metric_key: 'impressions', value: impressions, date, availability: 'observed', definition: 'Meta Ads Manager daily export' },
          { metric_key: 'clicks', value: clicks, date, availability: 'observed', definition: 'Meta Ads Manager daily export' },
          { metric_key: 'conversions', value: Math.round(clicks * (0.018 + random() * 0.03)), date, availability: 'observed', definition: 'Meta Ads Manager daily export (7-day click)' });
      }
      const result = await agent.data('ads_import_report', { key, params: { id: account.id }, body: { source_ref: `meta-export-${anchor}-${entity.key}`,
        entity: { level: 'campaign', external_id: `238${createHash('sha1').update(entity.key + slug).digest('hex').replace(/\D/g, '').slice(0, 12)}`,
          name: entity.name, objective: 'OUTCOME_SALES', status_snapshot: 'ACTIVE', observed_at: new Date().toISOString(), ...(entity.campaign && { campaign_id: entity.campaign }) },
        observations } });
      return { id: result.entity.id, observations: result.observations.length };
    }));
  }
  const proposal = imported['always-on']?.id && await step('ad-proposal', key => attempt('建立投放方案', async () => {
    const row = await agent.data('ads_create_proposal', { key: `${key}:create`, body: { ad_account_id: account.id, campaign_id: plans.winter.id,
      name: '檔期內暫停常態再行銷，避免與冬季保濕轉換廣告搶量', revision: {
        objective: 'OUTCOME_SALES', placements: [], market_ids: [brand.markets.TW.id], audience_spec: { description: '近 30 天造訪未購者', languages: ['zh-TW'], countries: ['TW'] },
        schedule: { starts_at: at(day(1), '00:00'), ends_at: at(day(10), '23:59'), tz: TZ },
        budget: { type: 'daily', amount_minor: 120_000, currency: 'TWD', cap_minor: 1_200_000 },
        change: { kind: 'pause', target_entity_id: imported['always-on'].id },
        estimates: [{ metric: 'spend_saved_minor', value: 1_100_000, source: '近 7 日平均日花費 × 檔期剩餘 10 天（估算，非實際）' },
          { metric: 'cpa_change_ratio', value: 0.12, source: '2026 夏季檔期同類暫停的觀察（估算）' }] } } });
    const proposalRow = row.proposal ?? row;
    const proposalId = proposalRow.proposal_id ?? proposalRow.id;
    const current = (await agent.list('ads_list_proposals', { query: { ad_account_id: account.id } })).find(entry => entry.id === proposalId);
    const submitted = await agent.data('ads_submit_proposal', { key: `${key}:submit`, params: { id: proposalId }, version: current?.version ?? proposalRow.version });
    return { id: proposalId, status: submitted.status };
  }));
  log(`✓ Agent：登記 Meta 投放帳戶、匯入近 20 天投放成效（含未採集日）${proposal?.id ? '、送審 1 個投放方案' : ''}`);
}

async function phaseAgentJob(brand, plans) {
  const done = await step('job-submit', () => attempt('Agent 接手任務', async () => {
    const jobs = await agent.list('agent_jobs_list', { query: { status: 'open' } });
    const job = jobs.find(row => row.id === state.steps['job-review']?.id) ?? jobs.find(row => String(row.title).startsWith('整理冬季保濕季'));
    if (!job) return { skipped: true };
    const claimed = await agent.data('agent_jobs_claim', { key: keyOf('job-claim'), params: { id: job.id }, version: job.version });
    const beat = await agent.data('agent_jobs_heartbeat', { key: keyOf('job-heartbeat'), params: { id: job.id }, version: claimed.version,
      body: { fencing_token: claimed.fencing_token, progress_note: '讀取社群成效與推廣計劃中' } });
    const social = await agent.data('views_social', { query: { brand_id: brand.id } }).catch(() => null);
    const top = (social?.top_posts ?? []).slice(0, 3).map(post => `${post.platform} ${post.published_at?.slice(0, 10)}：${post.metrics?.views?.value ?? '未採集'} 次瀏覽`);
    const result = await agent.data('agent_jobs_submit_result', { key: keyOf('job-result'), params: { id: job.id }, version: beat.version, body: {
      fencing_token: beat.fencing_token, result_ref: { note: [`冬季保濕季（${plans.winter.id}）第一週摘要：`, ...top,
        `Instagram ${day(-6)}、${day(-5)} 沒有採集到數字，排名未計入；1 則 TikTok 影片沒有報表。`].join('\n') } } });
    return { id: job.id, status: result.status };
  }));
  log(`✓ Agent：接手交辦任務並提交結果${done?.status ? `（${done.status}，等你驗收）` : ''}`);
}

// ───────────────────────────── verification and summary ─────────────────────────────
async function verify(brandId) {
  const query = { brand_id: brandId };
  const read = async (path, extra = {}) => {
    try { return (await human.view(path, { ...query, ...extra })).data; } catch (error) { return { error: `${error.code} ${error.message}` }; }
  };
  const [home, products, plans, calendar, social, decisions, ads, activity] = await Promise.all([
    read('home'), read('products'), read('plans'), read('calendar', { from: day(-14), to: day(14), tz: TZ }), read('social', { tz: TZ }),
    read('decisions'), read('ads'), read('activity', { actor: 'agent', limit: 200, brand_id: undefined }),
  ]);
  const count = (list, predicate = () => true) => Array.isArray(list) ? list.filter(predicate).length : '—';
  const byKind = Array.isArray(decisions) ? Object.entries(decisions.reduce((acc, row) => ({ ...acc, [row.kind]: (acc[row.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join('、') : decisions?.error;
  const events = calendar?.events ?? [];
  const eventKinds = Object.entries(events.reduce((acc, row) => ({ ...acc, [row.kind]: (acc[row.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join('、');
  const unknownDays = (social?.series?.total ?? []).filter(point => point.value === null).length;
  const stock = Array.isArray(products) ? products.flatMap(row => row.markets ?? []).reduce((acc, market) => ({ ...acc, [market.stock?.status]: (acc[market.stock?.status] ?? 0) + 1 }), {}) : {};
  const fmt = value => value == null ? '未採集' : Number(value).toLocaleString('zh-TW');

  log('\n── 檢視端點核對 (views, filtered to this brand) ──');
  log(`總覽 home      待你決定 ${home?.needs_you?.total ?? '—'}、本週排程 ${home?.this_week?.scheduled ?? '—'}、進行中計劃 ${count(home?.live_plans)}、KPI ${(home?.kpis ?? []).map(k => `${k.key}=${fmt(k.value)}`).join(' ')}`);
  log(`商品 products  ${count(products)} 個；市場庫存 ${Object.entries(stock).map(([k, n]) => `${k} ${n}`).join('、')}`);
  log(`計劃 plans     ${count(plans)} 個：${Array.isArray(plans) ? plans.map(p => `${p.name.split(' ')[0]}（${p.status}，${p.matrix?.filled ?? 0}/${p.matrix?.planned ?? 0}）`).join('、') : plans?.error}`);
  log(`日曆 calendar  ${events.length} 個事件（${day(-14)} ~ ${day(14)}）：${eventKinds}；需你處理 ${count(events, e => e.needs_human)}`);
  log(`社媒 social    ${count(social?.accounts)} 個帳號、瀏覽 ${fmt(social?.totals?.views?.value)}、互動 ${fmt(social?.totals?.engagements?.value)}、Top ${count(social?.top_posts)}、未排名 ${social?.unranked_count ?? '—'}、未採集日 ${unknownDays}`);
  log(`待你決定       ${count(decisions)} 項（${byKind}）`);
  log(`投放 ads       帳戶 ${count(ads?.accounts)}、花費 ${fmt(ads?.metrics?.spend?.value)}（${ads?.metrics?.spend?.availability ?? '—'}）、方案 ${count(ads?.proposals)}`);
  log(`Agent 活動     ${count(activity)} 筆（合併後）`);

  log('\n── 摘要 ──');
  log(`品牌 ${BRAND.name}  id ${brandId}`);
  log(`Agent 連線「${AGENT_LABEL}」  id ${state.steps['agent-connection']?.id}  權杖 ${mask(state.steps['agent-connection']?.token)}`);
  log(`Agent 呼叫 ${agent.calls} 次 MCP 工具（本次執行）；續跑狀態 ${stateFile.replace(`${ROOT}/`, '')}`);
  if (state.refused.length) {
    log('\nAgent 被拒的操作 (refused for the Agent):');
    for (const row of state.refused) log(`  • ${row.operation} → ${row.code}：${row.message}`);
  }
  if (state.notes.length) { log('\n注意 (notes):'); for (const note of state.notes) log(`  • ${note}`); }
  log(`\n打開看板：${origin}/app/${human.ws}?brand=${brandId}`);
}

main().catch(error => {
  if (error instanceof CallError) {
    console.error(`\n✖ ${error.who === 'agent' ? 'Agent' : '人'} 執行 ${error.operation} 失敗：${error.code} ${error.reason}`);
    if (error.details) console.error(`  details: ${JSON.stringify(error.details).slice(0, 800)}`);
    console.error(`  已完成的步驟記在 ${stateFile.replace(`${ROOT}/`, '')}，修正後重跑會從這裡接續。`);
  } else console.error(error);
  if (state.refused.length) console.error(`  被拒：${state.refused.map(row => `${row.operation} ${row.code}`).join('、')}`);
  process.exit(1);
});
