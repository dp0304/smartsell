import { sendReportExport } from './modules/analytics/report-export.js';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Problem, READ } from '@smartsell/contracts';
import type { Store } from '@smartsell/db';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { auth, bodyObject, header, membership, missing, originGuard } from './identity.js';
import { mcpRoutes } from './mcp.js';
import { oauthRoutes, tokenRoutes } from './oauth.js';
import { allowed, metadata, operationRunner, restInput, type Registered, type Schedule, type Subscriber } from './operations.js';
import { kernelBackgroundStore, runBackground, runOperationsHeartbeat } from './runtime.js';
import { streamRoutes } from './stream.js';
import { workspaceOpenApi, workspaceOpenApiRoute } from './workspace-openapi.js';
import { customerEgress } from './integration/customer-egress.js';
import { createSignedWebhookHost } from './integration/signed-webhook-host.js';
import { createPortalHost } from './integration/portal-host.js';
import { makeContext } from './context.js';
import { registerMediaFiles } from './extensions/media-files.js';
import { createPublishHost } from './integration/publish-host.js';
import { createMediaHost } from './integration/media-host.js';
import { enterpriseIdentityOwnsRequestGuard } from './extensions/enterprise-identity.js';
import { enterpriseHost } from './integration/enterprise-host.js';
import { kernelTraffic } from './integration/traffic-host.js';
import { commerceDrain, commerceSubscribers } from './integration/commerce-jobs.js';
import { createCommerceProviders, isCommerceOAuthCallback, isShopifyWebhook, type AccountConnectorServices } from './integration/commerce-providers.js';
import type { OpsServices } from './modules/ops/support.js';
import type { Transport } from '../../../packages/adapters/src/adapter-types.ts';
import type { OidcTransport } from '../../../packages/identity/src/index.ts';

const prefix = '/api/v1/workspaces/:ws';
const methods = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'PUT']);
interface Options {
  config: Config; store: Store; operations: Registered[]; subscribers?: Subscriber[]; schedules?: Schedule[]; logger?: boolean;
  opsServices?: Omit<OpsServices, 'deploymentMode'>;
  identityKey?: Uint8Array; testOidcTransport?: OidcTransport; testCommerceTransport?: Transport;
  accountConnectorServices?: AccountConnectorServices;
}

export function createServer({ config, store, operations, subscribers = [], schedules = [], logger = false,
  opsServices, identityKey, testOidcTransport, testCommerceTransport, accountConnectorServices }: Options) {
  const commerce = createCommerceProviders(config, testCommerceTransport, accountConnectorServices);
  const media = createMediaHost(config);
  const publishing = createPublishHost(commerce.account, media.media);
  operations = operations.map(operation => publishing.bindOperation(commerce.bindOperation(operation)));
  const egress = customerEgress();
  Object.assign(egress.ops, opsServices, { deploymentMode: config.identityDeployment });
  const signedWebhook = createSignedWebhookHost(egress, { allowLoopbackHttp: config.allowLoopbackWebhook });
  operations = [...operations, ...signedWebhook.operations];
  if (config.roles.has('api') || config.roles.has('media')) operations = [...operations, ...media.operations];
  operations = operations.map(op => media.bind(op));
  const names = new Set<string>();
  const routes = new Set<string>();
  for (const op of operations) {
    const route = `${op.method} ${op.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':param').replace(/\/$/, '')}`;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(op.name) || typeof op.run !== 'function' ||
      !methods.has(op.method) || !/^\/(?:[A-Za-z0-9_:-]+\/)*[A-Za-z0-9_:-]*$/.test(op.path) ||
      !Array.isArray(op.roles) || !op.roles.length || op.roles.some(role => !READ.includes(role))) {
      throw new Error(`Invalid operation ${op.module}.${op.name}`);
    }
    if (routes.has(route) || names.has(op.name)) throw new Error(`Duplicate workspace operation ${op.module}.${op.name} (${route})`);
    routes.add(route);
    names.add(op.name);
  }
  const app = Fastify({
    logger, logController: new Fastify.LogController({ disableRequestLogging: true }), genReqId: () => randomUUID(), requestIdHeader: false,
    bodyLimit: 1024 * 1024, requestTimeout: 30_000, routerOptions: { ignoreTrailingSlash: true },
  });
  let enterprise: ReturnType<typeof enterpriseHost> | undefined;
  const sessions = auth(store, config, async (identity, user) => enterprise
    ? enterprise.afterPassword(identity, user) : { required: false });
  const portal = createPortalHost(store, config, operations, media.media);
  const invoke = operationRunner(store, sessions, config, operations, portal, egress);
  const publicTraffic = config.traffic && kernelTraffic(config.traffic, store, config.roles.has('public'));
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('x-request-id', req.id)
      .header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    if (config.production) reply.header('strict-transport-security', 'max-age=31536000');
    await publicTraffic?.(req, reply);
    if (reply.sent) return;
    if (req.url.startsWith('/api/v1/portal/')) {
      const origin = req.headers.origin;
      if ((origin && origin !== portal.requestOrigin(req)) || req.headers['sec-fetch-site'] === 'cross-site') throw missing();
    } else if (req.url.startsWith('/api/') && !enterpriseIdentityOwnsRequestGuard(req) && !isCommerceOAuthCallback(req) && !isShopifyWebhook(req)) originGuard(req, config);
  });
  function jsonBody(req: FastifyRequest) {
    if (header(req, 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new Problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json');
    }
    return bodyObject(req.body);
  }
  app.setNotFoundHandler(() => { throw missing(); });
  app.setErrorHandler((error, req, reply) => {
    const cause = error as { statusCode?: number; code?: string };
    const problem = error instanceof Problem ? error
      : ['55P03', '40001', '40P01'].includes(cause.code ?? '') ? new Problem(503, 'TRANSACTION_RETRY', 'The transaction is busy. Retry the request')
      : cause.statusCode && cause.statusCode >= 400 && cause.statusCode < 500
        ? new Problem(cause.statusCode, 'INVALID_REQUEST', 'Invalid HTTP request')
        : new Problem(500, 'INTERNAL_ERROR', 'Internal server error');
    if (problem.status === 429 && typeof problem.details?.retry_after === 'number') {
      reply.header('retry-after', String(problem.details.retry_after));
    }
    if (problem.status >= 500) req.log.error({ requestId: req.id, errorCode: cause.code, errorName: error instanceof Error ? error.name : undefined }, 'Request failed');
    return reply.code(problem.status).type('application/problem+json').send({
      type: 'about:blank', title: problem.code, status: problem.status, code: problem.code, detail: problem.message,
      details: problem.details, request_id: req.id, error: { code: problem.code, message: problem.message },
    });
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try { await store.transaction({ readOnly: true }, () => undefined); return { status: 'ok' }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });

  const attempts = new Map<string, { count: number; until: number }>();
  const throttleLogin = (ip: string) => {
    const time = Date.now();
    if (attempts.size >= 1000) for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    const current = attempts.get(ip);
    const record = current && current.until > time ? current : { count: 0, until: time + 60_000 };
    if (record.count >= 30 || (!current && attempts.size >= 1000)) {
      throw new Problem(429, 'RATE_LIMITED', 'Too many login attempts', { retry_after: Math.max(1, Math.ceil((record.until - time) / 1000)) });
    }
    record.count++;
    attempts.set(ip, record);
  };
  const drainCommerce = commerceDrain(commerce.account);
  const stop = runBackground(store, config, [...subscribers.map(media.bindSubscriber), ...commerceSubscribers, signedWebhook.subscriber],
    [...publishing.schedules(schedules), commerce.accountSchedule, media.schedule], app.log, operations, egress, async transact => {
    await drainCommerce(transact);
    await signedWebhook.drain(transact);
    await publishing.drain(transact);
  });
  const stopHeartbeat = runOperationsHeartbeat(store, config, app.log);
  app.addHook('onClose', async () => { await Promise.all([stop(), stopHeartbeat()]); await store.close(); });
  if (config.roles.has('public') && (!config.production || config.portalOrigin)) portal.register(app);
  if (config.roles.has('api') || config.roles.has('media')) registerMediaFiles(app, media.media, {
    workspace: (request, id, write, run) => store.transaction({ readOnly: !write }, async tx => {
      const principal = sessions.authenticate(tx.identity, request, 'session');
      const ws = membership(tx.identity, principal, id);
      if (write) sessions.csrf(request, principal);
      const scope = { workspaceId: ws.id, tenantId: ws.tenantId, actorId: principal.user.id };
      return run(makeContext(await tx.workspace(scope), scope, ws.role));
    }),
  }, { mountOperations: !config.roles.has('api') });
  if (config.roles.has('ingress') || config.roles.has('api')) {
    const workspaceStore = kernelBackgroundStore(store);
    commerce.mountOAuthCallback(app, workspaceStore);
    commerce.mountShopifyWebhook(app, workspaceStore);
    publishing.mount(app, workspaceStore, egress);
  }
  if (config.roles.has('api')) {
    const key = identityKey ?? (config.identityKey ? Buffer.from(config.identityKey, 'hex') :
      createHash('sha256').update(config.secret).digest());
    enterprise = enterpriseHost(app, store, config, key, () => sessions, testOidcTransport);
    app.get('/api/v1/session', async req => store.transaction({ readOnly: true }, ({ identity }) => {
      const data = sessions.sessionData(identity, sessions.authenticate(identity, req));
      return { data, ...data };
    }));
    app.get('/api/v1/session/csrf', async req => store.transaction({ readOnly: true }, ({ identity }) => {
      const { csrf_token } = sessions.sessionData(identity, sessions.authenticate(identity, req, 'session'));
      return { csrf_token };
    }));
    app.post('/api/v1/setup', { bodyLimit: 8192 }, async (req, reply) => {
      throttleLogin(req.ip);
      const result = await sessions.setup(req, jsonBody(req));
      return reply.code(201).header('set-cookie', result.cookie).send({ data: result.data, ...result.data });
    });
    const login = async (req: Parameters<typeof sessions.login>[0], reply: Parameters<typeof sessions.logout>[1]) => {
      throttleLogin(req.ip);
      const result = await sessions.login(req, jsonBody(req));
      if ('cookie' in result) reply.header('set-cookie', result.cookie);
      return reply.send({ data: result.data, ...result.data });
    };
    app.post('/api/v1/login', { bodyLimit: 4096 }, login);
    app.post('/api/v1/session', { bodyLimit: 4096 }, login);
    app.post('/api/v1/logout', sessions.logout);
    app.delete('/api/v1/session', sessions.logout);
    tokenRoutes(app, store, sessions, operations);
    streamRoutes(app, store, sessions, config);
    app.get<{ Params: { ws: string } }>(`${prefix}/catalog`, async req => store.transaction({ readOnly: true }, ({ identity }) => {
      const principal = sessions.authenticate(identity, req);
      const ws = membership(identity, principal, req.params.ws);
      return { data: operations.filter(operation => allowed(operation, principal, ws, 'rest')).map(metadata) };
    }));
    app.get<{ Params: { ws: string } }>(workspaceOpenApiRoute, req => store.transaction({ readOnly: true }, ({ identity }) => {
      const principal = sessions.authenticate(identity, req);
      const ws = membership(identity, principal, req.params.ws);
      return workspaceOpenApi({ config, surface: 'operations',
        operations: operations.filter(op => allowed(op, principal, ws, 'rest')),
        permitsBearer: op => allowed(op, { ...principal, grant: principal.grant ?? {
          id: '', workspaceId: ws.id, userId: principal.user.id, access: 'write', expires: 0, kind: 'pat',
        } }, ws, 'rest'),
      });
    }));
    for (const operation of operations) {
      app.route<{ Params: { ws: string } }>({ method: operation.method, url: `${prefix}${operation.path}`,
        exposeHeadRoute: false,
        async handler(req, reply) {
          if (operation.method !== 'GET' && req.body !== undefined) jsonBody(req);
          const result = await invoke(req, req.params.ws, operation, restInput(req), 'rest');
          if (result.etag) reply.header('etag', result.etag);
          if (operation.name === 'report_export_download') return sendReportExport(reply, result.body.data);
          return reply.code(result.status).send(result.body);
        },
      });
    }
  }
  if (config.roles.has('mcp')) {
    oauthRoutes(app, store, sessions, config, throttleLogin);
    mcpRoutes(app, store, sessions, config, operations, invoke);
  }
  return app;
}
