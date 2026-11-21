import { hash } from '@node-rs/argon2';
import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { localStore } from './src/local.js';

const lifetime = 5 * 60_000;
class RecoveryError extends Error {}

function busy(error: unknown) {
  const code = (error as { errcode?: number } | undefined)?.errcode ?? 0;
  return (code & 255) === 5 || (code & 255) === 6;
}

function recoveryPage(nonce: string, loginOrigin: string) {
  return `<!doctype html>
<html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SmartSell 本机账号恢复</title>
<main>
  <h1>SmartSell 本机账号恢复</h1>
  <p id="status" role="status">正在验证恢复链接。</p>
  <p id="account" hidden>登录账号 <strong id="username"></strong></p>
  <form id="recovery" hidden>
    <p><label>新密码 <input id="password" type="password" autocomplete="new-password" minlength="6" maxlength="1024" required></label></p>
    <p><label>确认密码 <input id="confirm" type="password" autocomplete="new-password" minlength="6" maxlength="1024" required></label></p>
    <button>重设密码</button>
  </form>
  <a id="login" href="${loginOrigin}/" hidden>返回 SmartSell 登录</a>
</main>
<script nonce="${nonce}">
const token = location.hash.slice(1);
history.replaceState(null, '', '/');
const status = document.getElementById('status');
const form = document.getElementById('recovery');
const send = (path, body) => fetch(path, { method: 'POST', credentials: 'omit', headers: {
  authorization: 'Bearer ' + token, 'content-type': 'application/json'
}, body: JSON.stringify(body) });
(async () => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
  const response = await send('/owner', {});
  if (!response.ok) throw new Error();
  document.getElementById('username').textContent = (await response.json()).username;
  document.getElementById('account').hidden = false;
  status.textContent = '请输入至少 6 个字符的新密码。';
  form.hidden = false;
})().catch(() => { status.textContent = '恢复链接无效或已过期。'; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await send('/reset', { password: document.getElementById('password').value,
      confirm: document.getElementById('confirm').value });
    const result = await response.json();
    status.textContent = result.message;
    if (response.ok) {
      form.reset();
      form.hidden = true;
      document.getElementById('login').hidden = false;
    }
  } catch { status.textContent = '恢复服务已断开。请尝试使用新密码登录，或重新启动恢复。'; }
  finally { button.disabled = false; }
});
</script></html>`;
}

async function startRecovery(dataFile: string, loginOrigin: string, launchFile: string) {
  const store = localStore(dataFile, { existing: true });
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 15_000,
    exposeHeadRoutes: false, forceCloseConnections: true });
  const capability = randomBytes(32).toString('base64url');
  const expectedAuthorization = Buffer.from(`Bearer ${capability}`);
  let launchStat: Stats | undefined;
  let origin: string;
  let deadline = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let consumed = false;
  let closing: Promise<void> | undefined;
  const stop = () => closing ??= (async () => {
    if (timer) clearTimeout(timer);
    try { await app.close(); } finally {
      try { await store.close(); } finally {
        const current = launchStat && await lstat(launchFile).catch(() => undefined);
        if (current && current.dev === launchStat?.dev && current.ino === launchStat.ino) await unlink(launchFile);
      }
    }
  })();
  const shutdown = () => void stop().catch(() => { process.exitCode = 1; });
  const denied = { message: '恢复链接无效或已过期。' };

  try {
    const owner = await store.readRecoveryOwner();
    if (!owner) throw new RecoveryError('找不到与本机工作区配对的所有者账号。');
    app.addHook('onRequest', async (request, reply) => {
      reply.headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
      if (!origin || `http://${request.headers.host}` !== origin || consumed || Date.now() >= deadline) {
        return reply.code(403).send(denied);
      }
      if (request.method === 'GET') return;
      const { authorization, origin: source, 'sec-fetch-site': site, 'content-type': contentType } = request.headers;
      const provided = typeof authorization === 'string' ? Buffer.from(authorization) : Buffer.alloc(0);
      if (source !== origin || (site && site !== 'same-origin') || provided.length !== expectedAuthorization.length ||
        !timingSafeEqual(provided, expectedAuthorization)) return reply.code(403).send(denied);
      if (contentType?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return reply.code(415).send({ message: '请通过本机恢复页面提交。' });
      }
    });
    app.setErrorHandler((error, _request, reply) => {
      if (busy(error)) return reply.code(503).send({ message: '本机数据库忙，请稍后重试。' });
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status >= 400 && status < 500 ? status : 500).send({ message: '无法处理恢复请求。' });
    });
    app.get('/', (_request, reply) => {
      const nonce = randomBytes(16).toString('base64url');
      return reply.header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`)
        .type('text/html; charset=utf-8').send(recoveryPage(nonce, loginOrigin));
    });
    app.post('/owner', () => ({ username: owner.username }));
    app.post<{ Body: { password?: unknown; confirm?: unknown } }>('/reset', async (request, reply) => {
      const { password, confirm } = request.body ?? {};
      if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password) > 1024 || password !== confirm) {
        return reply.code(422).send({ message: '两次密码必须一致，且至少 6 个字符、最多 1024 字节。' });
      }
      if (inFlight || consumed) return reply.code(409).send({ message: '恢复请求已在处理。' });
      inFlight = true;
      try {
        const passwordHash = await hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
        if (Date.now() >= deadline) return reply.code(403).send(denied);
        if (!await store.resetRecoveryOwner(owner, passwordHash)) {
          return reply.code(409).send({ message: '本机账号或工作区已变更。请重新启动恢复。' });
        }
        consumed = true;
        if (reply.raw.destroyed) shutdown();
        else {
          reply.raw.once('finish', shutdown);
          reply.raw.once('close', shutdown);
        }
        return reply.send({ message: '密码已重设。请使用上方账号和新密码登录。' });
      } finally { inFlight = false; }
    });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const file = await open(launchFile, 'wx', 0o600);
    try {
      launchStat = await file.stat();
      await file.chmod(0o600);
      deadline = Date.now() + lifetime;
      await file.writeFile(`${origin}/#${capability}\n`, 'utf8');
    } finally { await file.close(); }
    timer = setTimeout(shutdown, Math.max(0, deadline - Date.now()));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: { 'data-file': { type: 'string' }, 'login-origin': { type: 'string' }, 'launch-file': { type: 'string' } } });
  const dataFile = values['data-file'];
  const launchFile = values['launch-file'];
  const loginOrigin = values['login-origin'] && URL.parse(values['login-origin']);
  if (!dataFile || !launchFile || !isAbsolute(dataFile) || !isAbsolute(launchFile) || !loginOrigin ||
    !['http:', 'https:'].includes(loginOrigin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(loginOrigin.hostname) ||
    loginOrigin.href !== `${loginOrigin.origin}/`) {
    throw new RecoveryError('用法：--data-file ABS --login-origin http://localhost:PORT --launch-file ABS');
  }
  const { NODE_ENV, DATABASE_URL, BACKGROUND_DATABASE_URL, SMARTSELL_STORE, SMARTSELL_IDENTITY_DEPLOYMENT } = process.env;
  if (NODE_ENV === 'production' || DATABASE_URL || BACKGROUND_DATABASE_URL || (SMARTSELL_STORE && SMARTSELL_STORE !== 'local') ||
    SMARTSELL_IDENTITY_DEPLOYMENT === 'saas') throw new RecoveryError('恢复命令只适用于私有的本机 SQLite 预览。');
  await startRecovery(dataFile, loginOrigin.origin, launchFile);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) {
    console.error(error instanceof RecoveryError ? error.message : busy(error) ? '本机数据库被占用，请稍后再试。' :
      '无法启动本机恢复。请确认 SQLite 文件已存在、由当前用户独占访问，且启动文件路径尚未使用。');
    process.exitCode = 1;
  }
}
