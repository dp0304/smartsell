// Hand-back from a hub web page to this App without CORS or a cross-origin
// fetch (§6.2 step 2, same pattern as worker-connect.tsx and
// worker-pairing.ts): the App listens on 127.0.0.1:<random port> for one
// path; the hub page navigates the top window to
// http://127.0.0.1:<p>/<path>#k=v&…; our page reads the fragment and POSTs it
// back to the same origin. `state` is checked in constant time; one use only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

export interface LoopbackGrantOptions {
  path: string;
  /** Builds the hub URL to open in the system browser. */
  url(port: number, state: string): string;
  /** Returns the accepted parameters (without `state`) or undefined to answer 400. */
  validate(params: URLSearchParams): Record<string, string> | undefined;
  openExternal(url: string): Promise<void>;
  signal: AbortSignal;
  timeoutMs?: number;
}

function page(nonce: string) {
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>SmartSell</title>
<p id="status" role="status">正在把授權交給這台電腦的 SmartSell…</p>
<script nonce="${nonce}">
const fragment = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const status = document.getElementById('status');
(async () => {
  try {
    const response = await fetch(location.pathname, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fragment, credentials:'omit'});
    if (!response.ok) throw new Error();
    status.textContent = '已交給 SmartSell。可以關閉這個分頁，回到 SmartSell 查看結果。';
  } catch { status.textContent = '沒有交給 SmartSell。請回到 SmartSell 重試。'; }
})();
</script></html>`;
}

export function loopbackGrant(options: LoopbackGrantOptions): Promise<Record<string, string>> {
  options.signal.throwIfAborted();
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(18).toString('base64');
  const windowMs = options.timeoutMs ?? 10 * 60_000;
  const expiresAt = Date.now() + windowMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let host = '';
    let origin = '';
    const abort = () => finish(undefined, new Error('已取消瀏覽器授權。'));
    const timeout = setTimeout(() => finish(undefined, new Error('瀏覽器授權已逾時，請重試。')), windowMs);
    const finish = (grant?: Record<string, string>, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
      server.close();
      if (grant) resolve(grant);
      else { server.closeAllConnections(); reject(error); }
    };
    const reply = (res: ServerResponse, status: number, body = '') => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Connection: 'close' });
      res.end(body);
    };
    const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, async (req, res) => {
      if (settled || Date.now() >= expiresAt || req.headers.host !== host || req.url !== options.path || req.socket.remoteAddress !== '127.0.0.1') return reply(res, 404);
      if (req.method === 'GET') return reply(res, 200, page(nonce));
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/x-www-form-urlencoded') return reply(res, 403);
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) return reply(res, 413);
          chunks.push(chunk as Buffer);
        }
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const returned = Buffer.from(params.get('state') ?? '');
        const expected = Buffer.from(state);
        if (returned.length !== expected.length || !timingSafeEqual(returned, expected)) return reply(res, 400);
        params.delete('state');
        const grant = options.validate(params);
        if (!grant || settled) return reply(res, 400);
        res.once('finish', () => server.closeAllConnections());
        reply(res, 200);
        finish(grant);
      } catch { if (!res.destroyed) reply(res, 400); }
    });
    server.setTimeout(5000, socket => socket.destroy());
    server.on('error', () => finish(undefined, new Error('無法啟動本機授權頁，請重試。')));
    options.signal.addEventListener('abort', abort, { once: true });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (settled || !address || typeof address === 'string') return finish(undefined, new Error('無法啟動本機授權頁，請重試。'));
      host = `127.0.0.1:${address.port}`;
      origin = `http://${host}`;
      void Promise.resolve().then(() => {
        options.signal.throwIfAborted();
        return options.openExternal(options.url(address.port, state));
      }).catch(() => finish(undefined, new Error('無法開啟系統瀏覽器，請重試。')));
    });
  });
}
