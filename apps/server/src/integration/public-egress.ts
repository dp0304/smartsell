import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { publicAddress } from '../modules/traffic/probe.js';

/**
 * The customer egress guard (customer-egress.ts), shared with phone push (S6): resolve the host once, require every address
 * to be public, and connect to that pinned address so a second DNS answer cannot point the request inside the network.
 * Errors never carry the URL, which may hold a secret (a Bark key, an ntfy topic).
 */
export class EgressDenied extends Error {
  constructor() { super('Destination is not a public address'); this.name = 'EgressDenied'; }
}

/** The one public IPv4 address to connect to for `hostname`, or EgressDenied. */
export async function publicAddressFor(hostname: string) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (!publicAddress(bare)) throw new EgressDenied();
    return bare;
  }
  const addresses = await new Resolver({ timeout: 1000, tries: 1 }).resolve4(`${bare}.`).catch(() => [] as string[]);
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new EgressDenied();
  return addresses[0]!;
}

export interface PublicPostOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }

/** One POST to a public http(s) address, never following redirects. Resolves with the status and the (bounded) body. */
export async function publicPost(url: URL, headers: Record<string, string>, body: string, options: PublicPostOptions = {}) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressDenied();
  const address = await publicAddressFor(url.hostname);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = send(url, { method: 'POST', headers, agent: false, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 5000),
      family: 4, lookup: (_host, _options, callback) => callback(null, address, 4) }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) res.destroy(new Error('Response exceeds limit'));
        else chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

/**
 * A fetch for POSTs that goes through publicPost (S6: phone push outside the hub). Only what sendPush uses: method, headers,
 * body and signal; redirects are never followed.
 */
export const publicFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if ((init.method ?? 'GET').toUpperCase() !== 'POST' || (init.body !== undefined && typeof init.body !== 'string')) {
    throw new TypeError('publicFetch sends string POST bodies only');
  }
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const result = await publicPost(url, headers, init.body ?? '', { signal: init.signal ?? undefined, maxBytes: 64 * 1024 });
  const empty = result.status === 204 || result.status === 205 || result.status === 304;
  return new Response(empty ? null : result.body, { status: result.status < 200 || result.status > 599 ? 502 : result.status });
};
