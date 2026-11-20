import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { SaxesParser } from 'saxes';
import { publicAddress } from '../traffic/probe.js';
import { webUrl } from './model.js';

type Response = { status: number; location?: string; etag?: string; last_modified?: string; body?: string };
export type FeedTransport = (url: URL, headers: Record<string, string>) => Promise<Response>;
const maxBytes = 1_048_576;
const maxRedirects = 3;

async function pinnedRequest(url: URL, validators: Record<string, string>): Promise<Response> {
  const addresses = await new Resolver({ timeout: 1200, tries: 1 }).resolve4(url.hostname);
  const address = addresses[0];
  if (!address || addresses.some(ip => !publicAddress(ip))) throw new Error('The feed address is unavailable');
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, {
      method: 'GET', agent: false, family: 4, signal: AbortSignal.timeout(5000),
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { ...validators, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'Accept-Encoding': 'identity' },
    }, res => {
      const response = { status: res.statusCode ?? 0, location: res.headers.location, etag: res.headers.etag, last_modified: res.headers['last-modified'] };
      if (response.status !== 200) { resolve(response); res.destroy(); return; }
      if ((res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length']) > maxBytes) {
        reject(new Error('Unsupported feed response size or encoding')); res.destroy(); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { reject(new Error('Feed response is too large')); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.once('end', () => resolve({ ...response, body: Buffer.concat(chunks).toString('utf8') }));
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('Feed download was interrupted')));
    });
    req.once('error', reject);
    req.end();
  });
}

function feedUrl(value: string): URL {
  const url = new URL(webUrl(value));
  if (isIP(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.') || url.port) throw new Error('Feed requires a public hostname with a standard port');
  return url;
}

export async function fetchFeed(urlValue: string, validators: Record<string, string>, send: FeedTransport = pinnedRequest) {
  let url = feedUrl(urlValue);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await send(url, hop === 0 ? validators : {});
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location && hop < maxRedirects) {
      const next = feedUrl(new URL(response.location, url).href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Feed redirects to an insecure URL');
      url = next;
      continue;
    }
    if (response.status === 304) return { response, url };
    if (response.status !== 200 || typeof response.body !== 'string' || Buffer.byteLength(response.body) > maxBytes) throw new Error('Feed response is unavailable');
    return { response, url };
  }
  throw new Error('Feed exceeded the redirect limit');
}

export function parseFeed(body: string, base: URL, kind: 'rss' | 'atom' | 'sitemap') {
  const parser = new SaxesParser({ xmlns: true });
  const root = { rss: ['rss', 'RDF'], atom: ['feed'], sitemap: ['urlset'] }[kind];
  const entryTag = { rss: 'item', atom: 'entry', sitemap: 'url' }[kind];
  const fields: Record<string, string> = { title: 'title', description: 'summary', summary: 'summary', content: 'summary', encoded: 'summary',
    creator: 'author', author: 'author', guid: 'guid', id: 'guid', link: 'url', loc: 'url', pubDate: 'published_at', published: 'published_at', updated: 'published_at', lastmod: 'published_at' };
  const entries: Record<string, string>[] = [];
  let depth = 0;
  let entryDepth = 0;
  let entry: Record<string, string> | undefined;
  let field: string | undefined;
  let buffer = '';
  parser.on('doctype', () => { throw new Error('Feed document type declarations are unsupported'); });
  parser.on('opentag', tag => {
    depth++;
    if (depth > 32 || (depth === 1 && !root.includes(tag.local))) throw new Error('Unsupported feed structure');
    if (!entry && tag.local === entryTag && depth <= 3 && entries.length < 500) { entry = {}; entryDepth = depth; return; }
    if (!entry || depth !== entryDepth + 1) return;
    field = Object.hasOwn(fields, tag.local) ? fields[tag.local] : undefined;
    buffer = '';
    if (kind === 'atom' && tag.local === 'link') {
      const rel = tag.attributes.rel?.value;
      if (!rel || rel === 'alternate') buffer = tag.attributes.href?.value ?? '';
    }
  });
  const capture = (value: string) => { if (field && buffer.length < 16_000) buffer += value.slice(0, 16_000 - buffer.length); };
  parser.on('text', capture);
  parser.on('cdata', capture);
  parser.on('closetag', () => {
    if (entry && depth === entryDepth + 1) {
      if (field && buffer.trim() && !entry[field]) entry[field] = buffer.trim();
      field = undefined;
    }
    if (entry && depth === entryDepth) {
      try {
        const url = new URL(webUrl(new URL(entry.url ?? '', base).href));
        if (entry.url) {
          const published = Date.parse(entry.published_at ?? '');
          entries.push({ url: url.href, title: (entry.title || url.pathname || url.hostname).slice(0, 240),
            ...(entry.guid ? { guid: entry.guid.slice(0, 2048) } : {}), ...(entry.summary ? { summary: entry.summary } : {}),
            ...(entry.author ? { author: entry.author.slice(0, 300) } : {}),
            ...(Number.isFinite(published) ? { published_at: new Date(published).toISOString() } : {}) });
        }
      } catch { /* Skip entries with unusable links. */ }
      entry = undefined;
    }
    depth--;
  });
  parser.write(body).close();
  return entries;
}
