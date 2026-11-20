import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createFetchTransport } from '../src/fetch-transport.ts';
import { client } from '../src/provider-http.ts';

const origin = 'https://provider-fixture.invalid';
const input = { url: `${origin}/resource`, method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: '{}' } as const;

describe('allowlisted platform fetch transport', () => {
  it('blocks other origins before fetch and keeps redirects at the original response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }));
    const transport = createFetchTransport({ origins: [origin], fetch: request });
    await expect(transport({ ...input, url: 'https://elsewhere.invalid/' })).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(request).not.toHaveBeenCalled();
    await expect(transport(input)).resolves.toMatchObject({ status: 302, headers: { location: 'https://elsewhere.invalid/' } });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'manual', method: 'POST' });
  });

  it('reads bounded JSON and does not retry incomplete writes', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'fixture' }))
      .mockResolvedValueOnce(new Response('x'.repeat(80)));
    const transport = createFetchTransport({ origins: [origin], maxResponseBytes: 32, fetch: request });
    await expect(transport(input)).resolves.toMatchObject({ status: 200, body: { id: 'fixture' } });
    await expect(transport(input)).rejects.toMatchObject({ delivery: 'possibly_sent' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves an HTTP rate limit with a malformed error body over a local fixture connection', async () => {
    const requests: Array<{ path?: string; method?: string; auth?: string; body: string }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '12' }).end('{ invalid');
    });
    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const fixtureFetch: typeof fetch = (url, init) => {
        const target = new URL(String(url));
        return fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, init);
      };
      const transport = createFetchTransport({ origins: [origin], fetch: fixtureFetch });
      await expect(client('tiktok', transport)(input, { mutation: true })).rejects.toMatchObject({ errorClass: 'rate_limited', retryAfter: '12' });
      expect(requests).toEqual([{ path: '/resource', method: 'POST', auth: 'Bearer synthetic', body: '{}' }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
