import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createPortalHandler, type PortalHost } from './portal.js';

/** Mount on the isolated portal service, before its static fallback route. */
export function registerTeamPortal(app: FastifyInstance, host: PortalHost, resolve?: (request: FastifyRequest) => Promise<PortalHost>): void {
  const origin = new URL(host.origin);
  if (origin.origin !== host.origin || !['http:', 'https:'].includes(origin.protocol)) {
    throw new Error('Portal origin must be an exact HTTP(S) origin');
  }
  const handle = createPortalHandler(host);
  app.route({
    url: '/api/v1/portal/*', method: ['GET', 'POST'], exposeHeadRoute: false, bodyLimit: 24_000,
    async onRequest(_request, reply) {
      reply.headers({
        'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      });
    },
    async handler(request, reply) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else value?.forEach(entry => headers.append(name, entry));
      }
      const scoped = resolve ? await resolve(request) : host;
      const url = new URL(request.url, scoped.origin);
      if (url.origin !== scoped.origin) return reply.code(404).send({ error: { code: 'not_found', message: 'Resource not found' } });
      const body = request.method === 'POST' && request.body !== undefined ? JSON.stringify(request.body) : undefined;
      const response = await (resolve ? createPortalHandler(scoped) : handle)(new Request(url, { method: request.method, headers, body }));
      for (const [name, value] of response.headers) reply.header(name, value);
      return reply.code(response.status).send(await response.text());
    },
  });
}