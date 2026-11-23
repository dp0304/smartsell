import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { opaqueId } from '../../../packages/connector-tasks/src/tasks.ts';
import { apiOrigin } from '../../connector/src/device-client.ts';

const callbackPath = '/smartsell-worker';
const codePattern = /^[A-Za-z0-9_-]{32}$/;
const workspaceUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const windowMs = 5 * 60_000;
const addressError = () => new Error('请输入可信工作台的主页、工作区网址或 Worker 配对网址。');

type Grant = { workspace: string; code: string };
export type WorkbenchAddress = { origin: string; workspace?: string; code?: string };

export function parseWorkbenchAddress(input: unknown): WorkbenchAddress {
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000- \u007f\\]/.test(input.trim())) throw addressError();
  const url = URL.parse(input.trim());
  if (!url || url.username || url.password) throw addressError();
  try {
    const origin = apiOrigin(url.origin);
    if (url.protocol !== new URL(origin).protocol) throw addressError();
    const match = /^\/app\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
    const workspace = match ? opaqueId(decodeURIComponent(match[1]), 'workspace_id') : undefined;
    if (url.hash.startsWith('#worker-pair')) {
      const code = url.hash.slice('#worker-pair='.length);
      if (!workspace || !url.hash.startsWith('#worker-pair=') || !codePattern.test(code) ||
        url.pathname !== `/app/${encodeURIComponent(workspace)}/get-started` || url.search !== '?step=worker') throw addressError();
      return { origin, workspace, code };
    }
    return { origin, ...(workspace && { workspace: workspaceUuid.test(workspace) ? workspace.toLowerCase() : workspace }) };
  } catch { throw addressError(); }
}

function callbackPage(nonce: string) {
  return `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><title>SmartSell Worker</title>
<p id="status" role="status">正在向本机 Worker 返回授权…</p>
<script nonce="${nonce}">
const fragment = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const status = document.getElementById('status');
(async () => {
  try {
    const response = await fetch(location.pathname, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fragment, credentials:'omit'});
    if (!response.ok) throw new Error();
    status.textContent = '已将授权交给本机 Worker。请返回 Worker 查看连接结果。';
  } catch { status.textContent = '未能返回授权。请返回本机 Worker 重试。'; }
})();
</script></html>`;
}

export function requestWorkbenchGrant({ origin, workspace }: WorkbenchAddress, name: string,
  openExternal: (url: string) => Promise<void>, signal: AbortSignal): Promise<Grant> {
  signal.throwIfAborted();
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(18).toString('base64');
  const expiresAt = Date.now() + windowMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let callbackOrigin = '';
    let callbackHost = '';
    const abort = () => finish(undefined, new Error('已取消浏览器授权。'));
    const timeout = setTimeout(() => finish(undefined, new Error('浏览器授权已过期，请重试。')), windowMs);
    const finish = (grant?: Grant, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      server.close();
      if (grant) resolve(grant);
      else {
        server.closeAllConnections();
        reject(error);
      }
    };
    const reply = (res: ServerResponse, status: number, body = '') => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Connection: 'close' });
      res.end(body);
    };
    const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, async (req, res) => {
      if (settled || Date.now() >= expiresAt || req.headers.host !== callbackHost || req.url !== callbackPath ||
        req.socket.remoteAddress !== '127.0.0.1' || req.socket.localPort !== Number(callbackHost.split(':')[1])) return reply(res, 404);
      if (req.method === 'GET') return reply(res, 200, callbackPage(nonce));
      if (req.method !== 'POST' || req.headers.origin !== callbackOrigin || req.headers['content-type'] !== 'application/x-www-form-urlencoded') return reply(res, 403);
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024) return reply(res, 413);
          chunks.push(chunk);
        }
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const returnedState = Buffer.from(params.get('state') ?? '');
        const expectedState = Buffer.from(state);
        const returnedWorkspace = opaqueId(params.get('workspace'), 'workspace_id');
        const code = params.get('code');
        if (settled || Date.now() >= expiresAt || params.size !== 3 || returnedState.length !== expectedState.length ||
          !timingSafeEqual(returnedState, expectedState) || (workspace && returnedWorkspace !== workspace) || !code || !codePattern.test(code)) return reply(res, 400);
        res.once('finish', () => server.closeAllConnections());
        reply(res, 200);
        finish({ workspace: returnedWorkspace, code });
      } catch { if (!res.destroyed) reply(res, 400); }
    });
    server.setTimeout(5000, socket => socket.destroy());
    server.on('error', () => finish(undefined, new Error('无法启动本机浏览器授权，请重试。')));
    signal.addEventListener('abort', abort, { once: true });
    server.listen(0, '127.0.0.1', () => {
      if (settled) { server.close(); return; }
      const address = server.address();
      if (!address || typeof address === 'string') return finish(undefined, addressError());
      callbackHost = `127.0.0.1:${address.port}`;
      callbackOrigin = `http://${callbackHost}`;
      const url = new URL('/worker-connect', origin);
      url.search = new URLSearchParams({ port: String(address.port), state, ...(workspace && { workspace }), name }).toString();
      void Promise.resolve().then(() => {
        signal.throwIfAborted();
        return openExternal(url.href);
      }).catch(() => finish(undefined, new Error('无法打开系统浏览器，请重试。')));
    });
  });
}
