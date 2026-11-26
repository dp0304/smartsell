#!/usr/bin/env node
// Manual MCP client check: the §10.3 sentences typed by the owner into a GUI client (WorkBuddy, or any MCP client without a
// CLI) against a fresh fixture stack (§10.2: hub, headless Workers Mac-B with X fixture_x and Win-C with TikTok fixture_tt,
// fixture platforms, ffmpeg clip). The client talks to the hub through a local counting proxy, so every tool call is
// recorded without a client transcript; the verdict comes from those calls and from the hub's own post records.
//
//   pnpm manual-client-check                      # relay form: the client launches the SmartSell relay over stdio
//   pnpm manual-client-check -- --mode direct     # HTTP form: the client reaches the hub directly (media_upload direct form, E47)
//   pnpm manual-client-check -- --prompt P2       # which sentence to score (P1 asks before posting without text; P2 posts;
//                                                 # P3: remote control (E50), change a stock value in a fixture store backend
//                                                 # in Mac-B's own Chrome and read it back)
//   pnpm manual-client-check -- --client claude   # no GUI: run a headless agent CLI (claude, or any CLI with the same
//                                                 # -p/--mcp-config/--strict-mcp-config/--allowedTools flags) instead of waiting for Enter
//
// Nothing leaves this computer: every origin is loopback and the client only sees the fixture stack. The script never edits
// the client's own settings; it prints the MCP entry (and copies it to the clipboard on macOS) for the owner to paste.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relayBundle = join(repoRoot, 'packages/agent-relay/dist/smartsell-relay.mjs');
const SERVER = 'smartsell-test';
const CALL_LIMIT = 6;
const PROMPTS = {
  P1: { text: '把 video.mp4 明天 9:00 發到 Mac-B 的 X 和 Win-C 的 TikTok', caption: null },
  P2: { text: '把 video.mp4 明天早上 9:00 發到 Mac-B 的 X 和 Win-C 的 TikTok，文案：「新路亞實測 🎣」，加上 #fishing #lure。', caption: '新路亞實測 🎣 #fishing #lure' },
  // E50: {store} is replaced with the fixture store's URL; the owner asked for exactly this change, so no extra question.
  P3: { text: '到 Mac-B 的商店後台 {store} 把「Lure 7cm」的庫存改成 42，改完確認一下。', caption: null, stock: 42 },
};
/** P3 may take more steps than posting: open, focus, clear, type, save, plus a look. */
const CALL_LIMITS = { P1: CALL_LIMIT, P2: CALL_LIMIT, P3: 12 };

function options(argv) {
  const args = argv.filter(arg => arg !== '--');
  const result = { mode: 'relay', prompt: 'P2', workDir: join(homedir(), 'SmartSell-MCP-Test'), client: null };
  for (let index = 0; index < args.length; index++) {
    const value = () => args[++index];
    if (args[index] === '--mode') result.mode = value();
    else if (args[index] === '--prompt') result.prompt = value().toUpperCase();
    else if (args[index] === '--work-dir') result.workDir = resolve(value());
    else if (args[index] === '--client') result.client = value();
    else throw new Error(`Unknown option ${args[index]}. Use --mode relay|direct, --prompt P1|P2|P3, --work-dir <folder>, --client <cli>.`);
  }
  if (!['relay', 'direct'].includes(result.mode)) throw new Error('--mode must be relay or direct');
  if (!PROMPTS[result.prompt]) throw new Error('--prompt must be P1, P2 or P3');
  return result;
}

/** A fixture store backend for P3: one product, a stock field and Save (plain http on loopback, test mode only). */
function fixtureStore() {
  const state = { stock: 7, saves: 0 };
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { state.stock = Number(new URLSearchParams(body).get('stock')); state.saves++; res.writeHead(303, { location: '/products/lure-7cm' }); res.end(); });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Lure Lab 商店後台</title><h1>商品：Lure 7cm</h1><p>目前庫存：${state.stock}</p>
      <form method="post" action="/products/lure-7cm"><label>庫存 <input name="stock" value="${state.stock}"></label> <button type="submit">儲存</button></form>`);
  });
  return new Promise(resolveServer => server.listen(0, '127.0.0.1', () => resolveServer({ server, state, origin: `http://127.0.0.1:${server.address().port}` })));
}

/** Forwards every request to the hub unchanged and records each JSON-RPC tools/call with whether its answer was an error. */
function countingProxy(hubOrigin) {
  const hub = new URL(hubOrigin);
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let call;
      if (req.method === 'POST' && req.url?.startsWith('/mcp')) {
        try {
          const message = JSON.parse(body.toString('utf8'));
          if (message?.method === 'tools/call') {
            call = { id: message.id, tool: message.params?.name, args: message.params?.arguments ?? {}, at: new Date().toISOString(), error: null };
            calls.push(call);
          }
        } catch { /* not JSON-RPC */ }
      }
      const upstream = httpRequest({ host: hub.hostname, port: hub.port, method: req.method, path: req.url,
        headers: { ...req.headers, host: hub.host } }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        let seen = '';
        response.on('data', chunk => {
          if (call && seen.length < 200_000) seen += chunk.toString('utf8');
          res.write(chunk);
        });
        response.on('end', () => {
          if (call) {
            // JSON or an SSE stream: find this call's answer and read isError and the error code.
            const texts = seen.split('\n').map(line => line.startsWith('data:') ? line.slice(5).trim() : line.trim()).filter(Boolean);
            for (const text of texts) {
              try {
                const message = JSON.parse(text);
                if (message.id !== call.id) continue;
                const result = message.result;
                if (message.error) call.error = { code: String(message.error.code), message: message.error.message };
                else if (result?.isError) call.error = { code: result.structuredContent?.error?.code ?? 'TOOL_ERROR', message: result.structuredContent?.error?.message ?? '' };
              } catch { /* partial line */ }
            }
          }
          res.end();
        });
      });
      upstream.on('error', error => { res.writeHead(502).end(String(error)); });
      upstream.end(body);
    });
  });
  return new Promise(resolveServer => server.listen(0, '127.0.0.1', () => resolveServer({ server, calls, origin: `http://127.0.0.1:${server.address().port}` })));
}

/**
 * Runs a headless agent CLI on the sentence, with only this MCP server and the few shell commands the direct form needs
 * (hash, size, curl). Resolves with the agent's final reply.
 */
function runClient(command, { configFile, workDir, prompt }) {
  const tools = [`mcp__${SERVER}`, 'Bash(shasum:*)', 'Bash(sha256sum:*)', 'Bash(openssl:*)', 'Bash(stat:*)', 'Bash(wc:*)', 'Bash(ls:*)', 'Bash(curl:*)', 'Read'];
  const args = ['-p', prompt, '--mcp-config', configFile, '--strict-mcp-config', '--output-format', 'json', '--allowedTools', ...tools];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
    child.on('error', rejectRun);
    child.on('close', code => {
      clearTimeout(timer);
      try { resolveRun(JSON.parse(out).result ?? out); } catch { resolveRun(out || `(client exited ${code} without output)`); }
    });
  });
}

/** GUI clients: print the entry and the steps, then wait for the owner to press Enter. */
async function ownerRun({ config, opts, video, prompt }) {
  if (process.platform === 'darwin') spawnSync('pbcopy', { input: config });
  console.log(`
=== Manual MCP client check (${opts.mode} form, ${opts.prompt}) ===
1. In WorkBuddy: Connectors → Custom connectors → Configure MCP. Merge this entry into mcpServers and save
   (it is already on the clipboard on macOS):

${config}

2. Back in the MCP list, click Trust for "${SERVER}" and make sure it is green and enabled.
3. Open a new task with this folder as the workspace: ${opts.workDir}
   (it contains video.mp4, ${video.bytes} bytes)
4. Type exactly:

   ${prompt.text}

5. When the agent has finished its reply, come back here and press Enter.
   Afterwards remove "${SERVER}" from WorkBuddy's MCP list; the token stops working when this script ends.
`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter when WorkBuddy has finished… ');
  rl.close();
}

function zoneDate(ms, zone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

async function main() {
  const opts = options(process.argv.slice(2));
  const prompt = PROMPTS[opts.prompt];
  const { startStack } = await import('../tests/e2e-phase1/stack.ts');
  const { e2eClip } = await import('../tests/e2e-phase1/video.ts');
  const base = mkdtempSync(join(tmpdir(), 'ss-manual-client-'));
  mkdirSync(opts.workDir, { recursive: true, mode: 0o700 });
  console.log('Starting the fixture stack (hub, Mac-B with X, Win-C with TikTok)…');
  const remote = opts.prompt === 'P3';
  const stack = await startStack({ name: 'manual-client', clip: false, ownChrome: remote });
  const proxy = await countingProxy(stack.origin);
  const store = remote ? await fixtureStore() : null;
  if (store) {
    // The owner turns remote control on for Mac-B with this one site (person-only REST), as on the machine page.
    await stack.rest('PUT', `/hub/machines/${stack.machines['Mac-B'].deviceId}/remote-control`, { browser: { enabled: true, sites: [new URL(store.origin).host] } });
    prompt.text = prompt.text.replace('{store}', `${store.origin}/products/lure-7cm`);
    const { until } = await import('../tests/e2e-phase1/stack.ts');
    await until(async () => (await stack.mcp('machines_list', {})).data.machines
      .find(machine => machine.machine_id === stack.machines['Mac-B'].deviceId)?.remote?.browser?.ready, 90_000, 'Mac-B ready for remote control', 2000);
  }
  let exitCode = 1;
  try {
    const video = await e2eClip(opts.workDir);
    const tokenFile = join(base, 'token');
    writeFileSync(tokenFile, stack.agentToken, { mode: 0o600 });
    const entry = opts.mode === 'relay'
      ? { command: process.execPath, args: [relayBundle, '--hub', proxy.origin, '--token-file', tokenFile] }
      : { type: 'http', url: `${proxy.origin}/mcp`, headers: { Authorization: `Bearer ${stack.agentToken}` } };
    const config = JSON.stringify({ mcpServers: { [SERVER]: entry } }, null, 2);
    let reply = null;
    if (opts.client) {
      const configFile = join(base, 'mcp.json');
      writeFileSync(configFile, config, { mode: 0o600 });
      console.log(`Running ${opts.client} (${opts.mode} form, ${opts.prompt}) in ${opts.workDir}:\n  ${prompt.text}`);
      reply = await runClient(opts.client, { configFile, workDir: opts.workDir, prompt: prompt.text });
    } else {
      await ownerRun({ config, opts, video, prompt });
    }

    const list = await stack.view('/views/posts?from=2000-01-01&to=2100-12-31&limit=200');
    const posts = [];
    for (const summary of list.posts ?? []) {
      const detail = await stack.view(`/views/posts/${summary.post_id}`);
      posts.push({ provider: detail.post.channel.provider, channel_id: detail.post.channel.id, machine: detail.post.machine?.name ?? null,
        status: detail.post.status, scheduled_at: detail.post.scheduled_at, local_time: detail.post.local_time,
        caption: detail.content?.caption ?? null, media_sha256: (detail.media ?? []).map(media => media.sha256), web_url: detail.post.web_url });
    }
    const calls = proxy.calls;
    const failures = [];
    const limit = CALL_LIMITS[opts.prompt];
    if (calls.length > limit) failures.push(`${calls.length} tool calls (limit ${limit})`);
    // RELAY_REQUIRED is the hub's designed answer when a direct-HTTP client first sends a path (it then sends the direct form).
    const errors = calls.filter(call => call.error && call.error.code !== 'RELAY_REQUIRED');
    if (opts.prompt === 'P3') {
      if (store.state.stock !== prompt.stock) failures.push(`P3: the store's stock is ${store.state.stock}, not ${prompt.stock}`);
      if (store.state.saves !== 1) failures.push(`P3: Save was pressed ${store.state.saves} times (want exactly once)`);
      if (!calls.some(call => call.tool === 'browser_open')) failures.push('P3: no browser_open');
      if (posts.length) failures.push(`P3 should not schedule posts (${posts.length})`);
    } else if (opts.prompt === 'P1') {
      if (posts.length) failures.push(`P1 should ask before posting without text, but ${posts.length} post(s) were scheduled`);
    } else {
      const tomorrow = zoneDate(Date.now() + 86_400_000, 'Asia/Shanghai');
      const want = { x: stack.channels.x.id, tiktok: stack.channels.tiktok.id };
      for (const provider of ['x', 'tiktok']) {
        const post = posts.find(item => item.channel_id === want[provider]);
        if (!post) { failures.push(`no ${provider} post`); continue; }
        if (zoneDate(Date.parse(post.scheduled_at), 'Asia/Shanghai') !== tomorrow || !String(post.local_time).includes('09:00')) failures.push(`${provider} at ${post.local_time}, not tomorrow 09:00`);
        if (post.caption !== prompt.caption) failures.push(`${provider} caption ${JSON.stringify(post.caption)}`);
        if (!post.media_sha256.includes(video.sha256)) failures.push(`${provider} media is not video.mp4`);
      }
      if (posts.length !== 2) failures.push(`${posts.length} posts (want exactly 2)`);
    }
    console.log('\nTool calls seen by the hub:');
    for (const call of calls) console.log(`  ${call.at.slice(11, 19)} ${call.tool}${call.error ? `  → ${call.error.code}${call.error.code === 'RELAY_REQUIRED' ? ' (expected for a direct client)' : ` ${call.error.message.slice(0, 120)}`}` : ''}`);
    console.log(`\nPosts on the hub: ${posts.length}`);
    for (const post of posts) console.log(`  ${post.provider} on ${post.machine}: ${post.status} ${post.local_time} caption=${JSON.stringify(post.caption)}`);
    console.log(`Unexpected errors: ${errors.length}`);
    if (errors.length) failures.push(`${errors.length} unexpected tool error(s)`);
    if (reply !== null) console.log(`\nAgent's reply:\n${String(reply).trim()}`);
    console.log(failures.length ? `\nFAIL\n- ${failures.join('\n- ')}` : '\nPASS');
    console.log('Also check the agent\'s last reply: for P2 it must name both posts with local time, machine, status and web_url.');
    exitCode = failures.length ? 1 : 0;
  } finally {
    store?.server.close();
    proxy.server.close();
    await stack.close().catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main().catch(error => { console.error(error); process.exit(2); });
