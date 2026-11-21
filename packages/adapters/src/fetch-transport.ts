import type { Transport } from './adapter-types.ts';
import { TransportError } from './provider-http.ts';

export interface FetchTransportOptions {
  /** Set by deployment, never by a task or provider response. Use exact HTTPS origins. */
  origins: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export function createFetchTransport({ origins, timeoutMs = 30_000, maxResponseBytes = 8_388_608, fetch: request = globalThis.fetch }: FetchTransportOptions): Transport {
  if (!origins.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 67_108_864) throw new TypeError('Invalid platform transport configuration');
  const allowed = new Set(origins.map(origin => {
    const url = URL.parse(origin);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.href !== `${url.origin}/`) throw new TypeError('Expected an exact HTTPS platform origin');
    return url.origin;
  }));
  return async input => {
    const url = URL.parse(input.url);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash || !allowed.has(url.origin)) throw new TransportError('not_sent');
    try {
      const response = await request(url, { method: input.method, headers: input.headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        body: input.body instanceof Uint8Array ? Uint8Array.from(input.body) : input.body });
      const headers = Object.fromEntries(response.headers);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { status: response.status, headers };
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxResponseBytes) {
              await reader.cancel();
              throw new Error('Platform response limit exceeded');
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      // Error pages can be HTML. Keep only parsed provider data and the HTTP status.
      const raw = Buffer.concat(chunks, bytes).toString('utf8').trim();
      let body: unknown;
      if (raw && (raw.startsWith('{') || raw.startsWith('[') || /\bjson\b/i.test(headers['content-type'] ?? ''))) {
        try { body = JSON.parse(raw); }
        catch (error) {
          if (response.ok) throw error;
          // An invalid error body does not erase a received HTTP rejection or Retry-After.
        }
      }
      return { status: response.status, headers, body };
    } catch {
      // Fetch cannot prove absence of delivery once called.
      throw new TransportError('possibly_sent');
    }
  };
}
