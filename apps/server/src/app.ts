import { Problem } from '@smartsell/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { auth, forbidden, header, invalid, requestObject, type AuthOptions } from './auth';
import { admins, DomainError } from './modules/types';
import { mcpCallAuditWithCommits, operationWriteAuditPrefix, workerSocialStatusAuditRows, type McpWriteReceipt } from './integration/mcp-call-audit.js';
import { operationRecords } from './integration/operation-records.js';
import { readProjection } from './read-policy';
import { activeAccountGrant } from './modules/ads/domain.js';
import { operationName, type Extension, type Registry } from './registry';
import type { CollaborationServices, registerCollaboration } from './extensions/collaboration';
import type { Context } from './modules/types';
import { missingWorkspace, type Store, type Unit } from './store';
import { createOperationCsrf } from './operation-auth.js';
import type { registerOperationRoutes } from './operation-server.js';
import { registerCommandMcp, type OperationHost } from './integration/command-mcp.js';
import { commandTraffic, type TrafficHostConfig } from './integration/traffic-host.js';
import { registerWorkerDownloads } from './worker-downloads.js';
import { commandIdentity } from './integration/command-identity.js';

const notFound = () => new DomainError('not_found', 'Resource not found', 404);
const notFoundBody = { error: { code: 'not_found', message: 'Resource not found' } };

/**
 * Route options for a POST route that receives a non-JSON body (raw bytes, multipart, form posts).
 *
 * The root onRequest guard rejects every POST whose Content-Type is not `application/json` with 415. PUT, PATCH and
 * DELETE are not content-type checked, so raw-byte uploads should prefer PUT (§2.4: upload parts, evidence). When a
 * POST really must accept another type, register it with this config:
 *
 *   app.post('/api/v1/example/raw', { ...RAW_BODY_ROUTE, bodyLimit: 4 * 1024 * 1024 }, handler);
 *
 * and add its own content-type parser in an encapsulated plugin. The origin and Sec-Fetch-Site checks still apply;
 * only the content-type check is skipped. List every such route in `docs/hub-setup.md` (developer notes).
 */
export const RAW_BODY_ROUTE = { config: { smartsellRawBody: true } } as const;
// Read without augmenting FastifyContextConfig: an all-optional augmentation turns it into a weak type for every route.
const acceptsRawBody = (request: FastifyRequest) => (request.routeOptions.config as { smartsellRawBody?: unknown } | undefined)?.smartsellRawBody === true;

/** Paths whose unmatched requests always get the JSON 404, never the SPA (§2.6). */
export function isReservedApiPath(url: string) {
  let path = url.split(/[?#]/, 1)[0].replace(/\/+/g, '/');
  try { path = decodeURIComponent(path); } catch { return true; }
  return path === '/api' || path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/') ||
    path === '/agent' || path.startsWith('/agent/');
}

/**
 * Receives unmatched GET/HEAD requests outside the reserved API paths. Send the response and resolve to true, or resolve
 * to false to fall back to the JSON 404. Resolve to a boolean, not the reply: FastifyReply is a thenable.
 */
export type NotFoundDelegate = (request: FastifyRequest, reply: FastifyReply) => boolean | Promise<boolean>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

type Options = AuthOptions & {
  store: Store; registry: Registry; logger?: boolean; secret?: string; extensions?: Map<string, Extension>;
  operationApi?: Omit<Parameters<typeof registerOperationRoutes>[1], 'workspace' | 'csrf' | 'patRead'> & { register: typeof registerOperationRoutes };
  traffic?: TrafficHostConfig;
  roles?: ReadonlySet<string>;
  commandIdentityKey?: Uint8Array;
  origin?: string;
  workerDownloadDirectory?: string;
  /** Fastify trustProxy; the hub trusts only the local `tailscale serve` (§2.2). */
  trustProxy?: string | false;
  requestTimeoutMs?: number;
  notFound?: NotFoundDelegate;
};

/**
 * Shutdown must not wait on sockets that never sent a byte. HTTP clients (undici's fetch after a cancelled SSE body, for
 * example) may open a spare connection without a request; Node counts it as a request in progress, so `server.close()`
 * waits for `headersTimeout` (~70 s with the connection check interval) although nothing will ever arrive on it. Idle
 * keep-alive sockets are closed by Fastify and requests in flight still finish; only these empty sockets are destroyed.
 */
function closeUnusedSocketsOnShutdown(app: FastifyInstance) {
  const sockets = new Set<Socket>();
  let closing = false;
  app.server.on('connection', (socket: Socket) => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  app.addHook('preClose', async () => {
    closing = true;
    for (const socket of sockets) if (socket.bytesRead === 0) socket.destroy();
  });
}

export function buildApp({ store, registry, extensions, secret, operationApi, traffic, roles, commandIdentityKey, origin, workerDownloadDirectory,
  trustProxy = false, requestTimeoutMs = 30_000, notFound: delegateNotFound, logger = false, ...options }: Options) {
  const app = Fastify({ logger, disableRequestLogging: true, bodyLimit: 1024 * 1024, requestTimeout: requestTimeoutMs, requestIdHeader: false,
    trustProxy, genReqId: () => randomUUID() });
  const identity = commandIdentityKey && commandIdentity(store, commandIdentityKey);
  const csrfSecret = operationApi?.config.secret ?? secret;
  const csrf = csrfSecret ? createOperationCsrf(csrfSecret) : undefined;
  if (identity && !csrf) throw new Error('Commands identity requires a CSRF secret');
  const sessions = auth(store, options, identity, identity ? csrf?.token : undefined);
  const workspace = <T>(request: FastifyRequest, wid: string, run: (unit: Unit) => Promise<T>) => {
    if (!uuid.test(wid)) throw missingWorkspace();
    return store.workspace(sessions.tokenHash(request), wid.toLowerCase(), run);
  };
  const legacyWorkspace: typeof workspace = (request, wid, run) => workspace(request, wid, unit => {
    if (unit.brandScopes?.length) throw forbidden();
    return run(unit);
  });
  const publicTraffic = traffic && commandTraffic(traffic, store, roles?.has('public') ?? true);
  closeUnusedSocketsOnShutdown(app);
  app.addHook('onClose', () => store.close());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('x-request-id', request.id);
    if (options.secureCookie) reply.header('strict-transport-security', 'max-age=31536000');
    await publicTraffic?.(request, reply);
    if (reply.sent) return;
    sessions.guard(request, request.routeOptions.url !== '/api/v1/logout' && !acceptsRawBody(request));
  });
  // Fastify allows one not-found handler per root, so the SPA fallback is a delegate of this handler (§2.4).
  app.setNotFoundHandler(async (request, reply) => {
    if (delegateNotFound && (request.method === 'GET' || request.method === 'HEAD') && !isReservedApiPath(request.url)) {
      if (await delegateNotFound(request, reply)) return reply;
    }
    return reply.code(404).send(notFoundBody);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError || error instanceof Problem) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    const code = (error as { code?: string }).code;
    if (code === '55P03' || code === '40001' || code === '40P01') {
      return reply.header('retry-after', '1').code(503).send({ error: { code: 'transaction_retry', message: 'Retry the request' } });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'invalid_request', message: 'Invalid request' } });
    }
    request.log.error({ requestId: request.id, errorCode: (error as { code?: string }).code }, 'Request failed');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try { await store.ready(); return { status: 'ok' }; }
    catch { return reply.code(503).send({ error: { code: 'unavailable', message: 'Storage unavailable' } }); }
  });
  app.get('/api/v1/setup/status', sessions.setupStatus);
  app.post('/api/v1/setup', { bodyLimit: 8192 }, sessions.setup);
  app.post('/api/v1/member-invitations/accept', { bodyLimit: 8192 }, sessions.acceptMemberInvitation);
  app.post('/api/v1/session', { bodyLimit: 4096 }, sessions.login);
  app.get('/api/v1/session', sessions.read);
  registerWorkerDownloads(app, workerDownloadDirectory, sessions.read);
  app.delete('/api/v1/session', sessions.logout);
  app.post('/api/v1/login', { bodyLimit: 4096 }, sessions.login);
  app.post('/api/v1/logout', sessions.logout);
  if (identity && csrf) {
    identity.register(app, sessions.tokenHash, csrf.check);
    app.post('/api/v1/auth/totp/challenge', { bodyLimit: 4096 }, sessions.finishLogin);
  }
  if (csrf && (identity || operationApi)) app.get('/api/v1/session/csrf', async request => {
    await sessions.read(request);
    return { csrf_token: csrf.token(sessions.tokenHash(request)) };
  });

  let sharedCommands: NonNullable<ReturnType<typeof registerOperationRoutes>>['commands'] | undefined;
  app.get<{ Params: { wid: string } }>('/api/v1/workspaces/:wid/commands', request => legacyWorkspace(request, request.params.wid, async ({ context }) => {
    const items = [...registry].flatMap(([module, group]) => [...group]
      .filter(([, command]) => command.roles.includes(context.role)).map(([action]) => ({ module, action })));
    const aliases = (sharedCommands ?? []).filter(command => command.roles.includes(context.role))
      .map(({ module, action }) => ({ module, action }));
    return { items: [...items, ...aliases] };
  }));
  app.get<{ Params: { wid: string } }>('/api/v1/workspaces/:wid/mcp-tool-calls', request =>
    legacyWorkspace(request, request.params.wid, async ({ context }) => {
      if (!admins.includes(context.role)) throw forbidden();
      const { records } = await operationRecords(context, true);
      const calls = [...await context.list('agent', 'tool_call'), ...workerSocialStatusAuditRows(records)];
      return mcpCallAuditWithCommits(calls, request.query, () => records.list<McpWriteReceipt>(operationWriteAuditPrefix));
    }));
  app.get<{ Params: { wid: string; module: string; kind: string } }>('/api/v1/workspaces/:wid/records/:module/:kind', request => {
    const { wid, module, kind } = request.params;
    return legacyWorkspace(request, wid, async ({ context }) => {
      const project = readProjection(module, kind, context.role);
      if (!project) throw notFound();
      let rows = await context.list(module, kind);
      if (module === 'ads' && context.role !== 'owner' && context.role !== 'admin') {
        const accounts = kind === 'ad_account' ? rows : await context.list('ads', 'ad_account');
        const visible = new Set(accounts.filter(row => activeAccountGrant(row.data.permissions, context.actorId, context.now)?.actions.includes('read')).map(row => row.id));
        rows = rows.filter(row => visible.has(kind === 'ad_account' ? row.id : row.data.ad_account_id));
      }
      return { items: rows.map(project) };
    });
  });
  app.post<{ Params: { wid: string; module: string; action: string } }>('/api/v1/workspaces/:wid/commands/:module/:action', (request, reply) => {
    const { wid, module, action } = request.params;
    return legacyWorkspace(request, wid, async unit => {
      const command = operationName.test(action) && registry.get(module)?.get(action);
      if (!command) throw notFound();
      if (!command.roles.includes(unit.context.role)) throw forbidden();
      const key = header(request, 'idempotency-key');
      if (!key || !/^[a-zA-Z0-9._:-]{1,200}$/.test(key)) throw invalid('A valid Idempotency-Key is required');
      const input = requestObject(request.body);
      if (module === 'asset') await unit.context.lockOperationRecords?.();
      const fingerprint = createHash('sha256').update(canonical([module, action, unit.context.role, input])).digest('hex');
      const data = await unit.command({ module, action, key, fingerprint }, () => command.run(unit.context, input));
      if (command.accepted) reply.code(202);
      return { data };
    });
  });
  const collaboration = extensions?.get('collaboration')?.registerCollaboration;
  if (typeof collaboration === 'function' && secret && store.publicWork) {
    const membership = new WeakMap<Context, NonNullable<Unit['changeMembership']>>();
    const services: CollaborationServices = {
      signingKey: Buffer.from(secret, 'hex'),
      async workspace<T>(request: FastifyRequest, wid: string, run: (context: Context) => Promise<T>) {
        return legacyWorkspace(request, wid, async unit => {
          if (unit.changeMembership) membership.set(unit.context, unit.changeMembership);
          return await unit.command({ module: 'team', action: 'portal', key: `internal/${randomUUID()}`, fingerprint: '' },
            () => run(unit.context)) as T;
        });
      },
      async publicWork(locator, id, run) {
        const [module] = locator.split('.');
        return store.publicWork!(locator, id, async unit => await unit.command({ module, action: 'public_link',
          key: `internal/${randomUUID()}`, fingerprint: '' }, () => run(unit.context)) as Awaited<ReturnType<typeof run>>);
      },
      async changeMembership(context, change) {
        const modify = membership.get(context);
        if (!modify) throw new DomainError('not_configured', 'Membership changes are unavailable', 503);
        await modify(change);
      },
    };
    (collaboration as typeof registerCollaboration)(app, services);
  }
  // MCP tools run through the Operation executor, which exists only after the REST routes are registered.
  const operationHost: OperationHost = {};
  const csrfCheck = csrf && ((request: FastifyRequest) => csrf.check(request, sessions.tokenHash(request)));
  const patRead = secret && (roles?.has('mcp') ?? true)
    ? registerCommandMcp(app, store, registry, secret, options.origins, sessions.tokenHash, operationApi,
      { host: operationHost, csrf: csrfCheck, origin: operationApi?.config.origin ?? origin }) : undefined;
  if (operationApi && csrfCheck) {
    const routes = operationApi.register(app, { ...operationApi, workspace, patRead, csrf: csrfCheck });
    sharedCommands = routes?.commands;
    if (routes) Object.assign(operationHost, { mounted: routes.mounted, execute: routes.execute });
    for (const { module, action } of sharedCommands ?? []) {
      if (registry.get(module)?.has(action)) throw new Error(`Duplicate command: ${module}.${action}`);
    }
  }
  return { app, workspace, requireSession: sessions.read as (request: FastifyRequest) => Promise<unknown> };
}
