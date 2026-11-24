import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Problem } from '@smartsell/contracts';
import { fail, one, text } from './input.ts';
import { providers } from './oauth.ts';
import type { DeviceAction } from './connector-service.ts';
import { createAccountGateway, type AccountGatewayDependencies } from './gateway.ts';
import { workerCatalogUploadBodyLimit } from '../commerce/worker-catalog.js';
import { mountWorkerDeviceFiles, provideSignedWorkerDownloads, type WorkerDeviceFiles } from '../worker/device-http.ts';

const deviceRoutes = [
  ['/api/v1/device/heartbeat', 'heartbeat'],
  ['/api/v1/device/claim', 'claim'],
  ['/api/v1/device/channels/register', 'channels.register'],
  // Phase 1 job protocol (§5.4, Appendix B.2).
  ['/api/v1/device/jobs/claim', 'jobs.claim'],
  ['/api/v1/device/jobs/report', 'jobs.report'],
  ['/api/v1/device/jobs/go', 'jobs.go'],
  ['/api/v1/device/catalog/claim', 'catalog.claim'],
  ['/api/v1/device/catalog/upload', 'catalog.upload'],
  ['/api/v1/device/zhihu-stats/claim', 'zhihu.stats.claim'],
  ['/api/v1/device/zhihu-stats/report', 'zhihu.stats.report'],
  ['/api/v1/device/social-status/claim', 'social.status.claim'],
  ['/api/v1/device/social-status/report', 'social.status.report'],
  ['/api/v1/device/browser-identity', 'browser.identity'],
  ['/api/v1/device/mobile-identity', 'mobile.identity'],
  ['/api/v1/device/mobile-devices/report', 'mobile.report'],
  ['/api/v1/attempts/:id/ready', 'attempt.ready'],
  ['/api/v1/attempts/:id/submit-permit', 'attempt.permit'],
  ['/api/v1/attempts/:id/submit-permit/consume', 'attempt.consume'],
  ['/api/v1/attempts/:id/device-report', 'attempt.report'],
] as const satisfies readonly (readonly [string, DeviceAction])[];

type Params = { id?: string; provider?: string; endpoint?: string };

/** Encapsulated parsers preserve raw bytes for the device and platform signature boundaries. */
export function mountAccountIngress(app: FastifyInstance, dependencies: AccountGatewayDependencies, options: { deviceOnly?: boolean; files?: WorkerDeviceFiles } = {}) {
  const gateway = createAccountGateway(dependencies);
  // §8.18: Workers download their own updates with a device signature; the download route lives on the root app (S1).
  provideSignedWorkerDownloads(app, gateway);
  app.register(async ingress => {
    ingress.removeAllContentTypeParsers();
    ingress.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 128_000 }, (_request, body, done) => done(null, body));
    ingress.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    });
    ingress.setErrorHandler((error, _request, reply) => {
      if (error instanceof Problem) {
        // SEQ_GAP carries `expected` (S6 ledger 1); DEVICE_BUSY tells the Worker when to retry (§2.10).
        if (error.code === 'DEVICE_BUSY') reply.header('retry-after', '1');
        const details = error.details && typeof error.details === 'object' ? error.details : undefined;
        return reply.code(error.status).send({ error: { code: error.code, ...(details && { ...details, details }) } });
      }
      const candidate = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
      const status = typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
      return reply.code(status).send({ error: { code: status === 500 ? 'ACCOUNT_INGRESS_FAILURE' : 'ACCOUNT_REQUEST_INVALID' } });
    });
    const workspace = (request: FastifyRequest) => typeof request.headers['x-smartsell-workspace'] === 'string' ? request.headers['x-smartsell-workspace'] : undefined;
    const buffer = (request: FastifyRequest) => Buffer.isBuffer(request.body) ? request.body : fail('RAW_BODY_REQUIRED', 400);
    if (!options.deviceOnly) {
      ingress.get<{ Params: Params }>('/api/v1/oauth/callback/:provider', { exposeHeadRoute: false }, async request => {
        const start = request.url.indexOf('?');
        if (start < 0 || request.url.length - start > 8192) fail('OAUTH_STATE_INVALID', 400);
        const query: Record<string, string> = Object.create(null);
        for (const [name, value] of new URLSearchParams(request.url.slice(start + 1))) {
          if (Object.hasOwn(query, name)) fail('OAUTH_STATE_INVALID', 400);
          query[name] = value;
        }
        return { data: await gateway.oauthCallback(one(request.params.provider, providers), query) };
      });
    }
    ingress.post('/api/v1/device/pair', async request => {
      let input: unknown;
      try { input = JSON.parse(buffer(request).toString('utf8')); } catch { fail('INVALID_DEVICE_BODY', 422); }
      return { data: await gateway.pair(input, workspace(request)) };
    });
    if (!options.deviceOnly) {
      ingress.get<{ Params: Params; Querystring: Record<string, string> }>('/api/v1/webhooks/:provider/:endpoint', async (request, reply) => {
        const challenge = await gateway.webhookChallenge(one(request.params.provider, providers), text(request.params.endpoint), request.query);
        return reply.type('text/plain; charset=utf-8').send(challenge);
      });
      ingress.post<{ Params: Params }>('/api/v1/webhooks/:provider/:endpoint', async request => ({
        data: await gateway.webhook(one(request.params.provider, providers), text(request.params.endpoint), {
          rawBody: buffer(request), headers: Object.fromEntries(Object.entries(request.headers).filter((pair): pair is [string, string] => typeof pair[1] === 'string')),
        }),
      }));
    }
    mountWorkerDeviceFiles(ingress, gateway, options.files ?? {});
    for (const [path, action] of deviceRoutes) {
      const limits = action === 'catalog.upload' ? { bodyLimit: workerCatalogUploadBodyLimit } : {};
      ingress.post<{ Params: Params }>(path, limits, async (request, reply) => {
        const data = await gateway.device(action, buffer(request), {
          device_id: text(request.headers['x-smartsell-device']), timestamp: text(request.headers['x-smartsell-timestamp']),
          nonce: text(request.headers['x-smartsell-nonce']), signature: text(request.headers['x-smartsell-signature']),
        }, request.params.id, workspace(request), request.id);
        if (data && typeof data === 'object' && 'decision' in data && data.decision === 'late') reply.code(409);
        return { data };
      });
    }
  });
}
