import { envelope, MAX_MESSAGE, parseJson, type RpcMessage } from './jsonrpc.ts';

/** A forwarding failure. `message` is English for the model; `ownerMessage` is zh-Hant for the owner. */
export class RelayError extends Error {
  readonly ownerMessage: string | undefined;
  readonly status: number | undefined;
  constructor(message: string, ownerMessage?: string, status?: number) {
    super(message);
    this.name = 'RelayError';
    this.ownerMessage = ownerMessage;
    this.status = status;
  }
}

const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Accept only an https origin, or http on a loopback host (§6.2); returns the normalized origin. */
export function validateHubOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RelayError(`Invalid SmartSell hub address: ${value}`, 'SmartSell 中樞位址格式錯誤。'); }
  const bare = (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash && !url.username && !url.password;
  if (!bare || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback.has(url.hostname)))) {
    throw new RelayError('The SmartSell hub address must be an https origin (or http on this computer only).',
      'SmartSell 中樞位址必須是 https 網址（只有本機測試可以用 http://127.0.0.1）。');
  }
  return url.origin;
}

export function httpFailure(status: number): RelayError {
  if (status === 401) return new RelayError('SmartSell rejected this connection (401). Ask the owner to reconnect the agent in SmartSell.',
    'SmartSell 拒絕了這個連線（401）：連線可能已到期或被撤銷。請在 SmartSell App 或網頁重新連接 Codex／Claude Code。', status);
  if (status === 403) return new RelayError('SmartSell refused this request (403).', 'SmartSell 拒絕授權（403）。請在網頁確認這個連線的工作區與權限。', status);
  if (status === 404) return new RelayError('The SmartSell MCP endpoint or session was not found (404).', 'SmartSell MCP 位址或工作階段不存在（404）。請確認中樞位址後重開用戶端。', status);
  if (status >= 300 && status < 400) return new RelayError('The SmartSell hub answered with a redirect. Use the final https hub address.', 'SmartSell 中樞回傳了重新導向。請使用最終的 https 中樞位址。', status);
  return new RelayError(`SmartSell returned HTTP ${status}. Check that the hub is running and retry.`, `SmartSell 中樞回傳 HTTP ${status}。請確認中樞正在執行後再試。`, status);
}

export const unreachable = () => new RelayError('The SmartSell hub is not reachable. Check the hub, Tailscale and the network, then retry.',
  '目前連不上 SmartSell 中樞。請確認中樞電腦開著、Tailscale 已連線，然後再試一次。');

/** Read a response body as text, refusing more than `max` bytes. */
export async function boundedText(response: Response, max = MAX_MESSAGE) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new RelayError('The SmartSell response is too large.', 'SmartSell 回應過大。'); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Parse a text/event-stream body into JSON messages as events complete. */
async function* sseMessages(response: Response): AsyncGenerator<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let size = 0;
  const flush = function* () {
    if (data.length) {
      const text = data.join('\n');
      data = [];
      size = 0;
      const value = parseJson(text);
      if (value === undefined) throw new RelayError('SmartSell sent an invalid event.', 'SmartSell 回傳無效的事件。');
      yield value;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_MESSAGE) throw new RelayError('The SmartSell event stream line is too large.', 'SmartSell 事件串流過大。');
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line) { yield* flush(); continue; }
        if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          size += value.length + 1;
          if (size > MAX_MESSAGE) throw new RelayError('The SmartSell event is too large.', 'SmartSell 事件過大。');
          data.push(value);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
    yield* flush();
  } finally {
    // Stop reading once the matching response arrived (or on error) so the connection is released.
    await reader.cancel().catch(() => undefined);
  }
}

export interface HubConnectionOptions { hubOrigin: string; token: string; fetch?: typeof fetch; timeoutMs?: number }
export type Emit = (message: RpcMessage) => void;

/** Streamable-HTTP MCP client for one stdio session: JSON and SSE responses, Mcp-Session-Id, protocol version. */
export function createHubConnection({ hubOrigin, token, fetch: request = fetch, timeoutMs = 180_000 }: HubConnectionOptions) {
  const url = new URL('/mcp', validateHubOrigin(hubOrigin)).href;
  let session: string | undefined;
  let version: string | undefined;
  let initialize: RpcMessage | undefined;
  let initialized: RpcMessage | undefined;

  async function post(message: RpcMessage) {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (message.method !== 'initialize') {
      if (session) headers['mcp-session-id'] = session;
      if (version) headers['mcp-protocol-version'] = version;
    }
    try {
      return await request(url, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError') throw new RelayError('The SmartSell hub did not answer in time.', 'SmartSell 中樞沒有在時間內回應。');
      throw unreachable();
    }
  }

  function checkInitialize(item: RpcMessage, response: Response) {
    const result = item.result as { serverInfo?: { name?: unknown }; protocolVersion?: unknown } | undefined;
    if (!result || typeof result !== 'object' || result.serverInfo?.name !== 'smartsell' ||
      typeof result.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion)) {
      throw new RelayError('This address did not return a valid SmartSell MCP initialization.', '這個位址沒有回傳有效的 SmartSell MCP 初始化結果。請核對中樞位址。');
    }
    const id = response.headers.get('mcp-session-id');
    if (id !== null && !/^[!-~]{1,512}$/.test(id)) throw new RelayError('SmartSell returned an invalid MCP session.', 'SmartSell 回傳無效的 MCP 工作階段。');
    session = id ?? undefined;
    version = result.protocolVersion;
  }

  /** Forward one message. Server-initiated messages and the matching response go to `emit`. */
  async function send(message: RpcMessage, emit: Emit, retried = false): Promise<void> {
    const call = typeof message.method === 'string' && message.id !== undefined;
    if (message.method === 'initialize') initialize = message;
    if (message.method === 'notifications/initialized') initialized = message;
    const response = await post(message);
    if (!call) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) return;
      throw httpFailure(response.status);
    }
    // The hub forgot the session (for example after a restart): initialize again once, then retry (§5.1 downtime).
    if (response.status === 404 && session && !retried && initialize && message.method !== 'initialize') {
      await response.body?.cancel().catch(() => undefined);
      session = undefined;
      await send(initialize, () => undefined, true);
      if (initialized) await send(initialized, () => undefined, true);
      return send(message, emit, true);
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => undefined); throw httpFailure(response.status); }
    const deliver = (value: unknown): boolean => {
      if (!envelope(value)) throw new RelayError('SmartSell returned an invalid JSON-RPC message.', 'SmartSell 回傳無效的 JSON-RPC 訊息。');
      if (typeof value.method === 'string') { emit(value); return false; }
      if (typeof value.id !== typeof message.id || value.id !== message.id) throw new RelayError('SmartSell answered with a different JSON-RPC id.', 'SmartSell 回應的 JSON-RPC ID 不符。');
      if (message.method === 'initialize' && value.result !== undefined) checkInitialize(value, response);
      emit(value);
      return true;
    };
    if (type === 'application/json') {
      const text = await boundedText(response);
      const value = parseJson(text);
      // A JSON-RPC error with an HTTP 4xx (for example invalid params) still belongs to the client.
      if (response.status >= 400 && !(envelope(value) && value.id === message.id && value.error)) throw httpFailure(response.status);
      if (value === undefined) throw new RelayError('SmartSell returned unreadable JSON.', 'SmartSell 回傳無法讀取的 JSON。');
      if (deliver(value)) return;
      throw new RelayError('SmartSell did not return a result for this request.', 'SmartSell 沒有回傳這個請求的結果。');
    }
    if (response.status >= 400) { await response.body?.cancel().catch(() => undefined); throw httpFailure(response.status); }
    if (type === 'text/event-stream') {
      for await (const value of sseMessages(response)) if (deliver(value)) return;
      throw new RelayError('SmartSell closed the stream without a result.', 'SmartSell 在回傳結果前關閉了串流。');
    }
    await response.body?.cancel().catch(() => undefined);
    throw new RelayError('SmartSell answered with an unexpected Content-Type. Check the MCP address and any proxy.', 'SmartSell 回應的 Content-Type 不符。請核對 MCP 位址與反向代理。');
  }

  return { send, get session() { return session; }, get protocolVersion() { return version; } };
}
