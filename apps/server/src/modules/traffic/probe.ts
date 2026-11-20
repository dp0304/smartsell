import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { isIPv4 } from 'node:net';
import type { Context, Data } from '@smartsell/contracts';
import { safeUrl } from './operation-policy.js';

type ProbeResponse = { status: number; location?: string; language?: string };
type ProbeTransport = (url: URL, method: 'HEAD' | 'GET') => Promise<ProbeResponse>;

export function publicAddress(address: string) {
  if (!isIPv4(address)) return false;
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 100 && b >= 64 && b < 128) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b < 32) && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
}
async function transport(url: URL, method: 'HEAD' | 'GET'): Promise<ProbeResponse> {
  const addresses = await new Resolver({ timeout: 1200, tries: 1 }).resolve4(url.hostname);
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error('Destination addresses are unavailable');
  const address = addresses[0]!;
  // Pin the validated address while keeping the original hostname for TLS verification and Host.
  return new Promise((resolve, reject) => {
    const req = request(url, { method, family: 4, agent: false, lookup: (_hostname, _options, callback) => callback(null, address, 4),
      signal: AbortSignal.timeout(3000), headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' } }, res => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      const value: ProbeResponse = { status, ...(location ? { location } : {}) };
      const language = res.headers['content-language'];
      if (typeof language === 'string') value.language = language.split(',')[0]?.trim() ?? '';
      if (method === 'HEAD' || status < 200 || status >= 300 || value.language || !res.headers['content-type']?.includes('text/html')) {
        resolve(value);
        res.destroy();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += String(chunk).slice(0, 16384 - body.length);
        const match = /<html\b[^>]*\blang\s*=\s*["']?([a-z0-9-]+)/i.exec(body);
        if (match?.[1]) value.language = match[1];
        if (value.language || body.length >= 16384 || /<\/head>/i.test(body)) {
          resolve(value);
          res.destroy();
        }
      });
      res.once('end', () => resolve(value));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

export async function probeDestination(ctx: Context, input: string, expectedLanguage?: string, send: ProbeTransport = transport): Promise<Data[]> {
  let url = safeUrl(ctx, input);
  try {
    for (let hops = 0; hops <= 5; hops++) {
      let response = await send(url, 'HEAD');
      if (response.status === 405 || response.status === 501 || (expectedLanguage && response.status >= 200 && response.status < 300 && !response.language)) {
        response = await send(url, 'GET');
      }
      if ([301,302,303,307,308].includes(response.status)) {
        if (!response.location || hops === 5) return [{ check: 'http_status', result: 'fail', detail: 'Invalid or excessive redirects' }];
        try { url = safeUrl(ctx, new URL(response.location, url).href); }
        catch { return [{ check: 'http_status', result: 'fail', detail: 'Redirect leaves the allowed destinations' }]; }
        continue;
      }
      const result = response.status >= 200 && response.status < 300 ? 'pass' : response.status === 404 || response.status === 410 ? 'fail' : 'unknown';
      const checks: Data[] = [{ check: 'http_status', result, status_code: response.status, source: 'http_probe' }];
      if (expectedLanguage && result === 'pass') {
        const observed = response.language?.toLowerCase();
        const expected = expectedLanguage.toLowerCase();
        checks.push({ check: 'language', result: observed == null || !observed ? 'unknown' : observed === expected || observed.startsWith(`${expected}-`) ? 'pass' : 'warn', observed: observed ?? null, expected });
      }
      return checks;
    }
  } catch {
    return [{ check: 'http_status', result: 'unknown', detail: 'No reliable HTTP observation was obtained' }];
  }
  return [{ check: 'http_status', result: 'unknown' }];
}
