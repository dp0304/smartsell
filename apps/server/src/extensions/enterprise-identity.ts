import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FederationIdentity, IdentityError, IdentitySecrets, ScimIdentity, TotpIdentity, scimBase, scimError,
  type ConnectionLookup, type ConnectionScope, type FederationProof, type IdentityState, type MfaAnswer,
  type OidcTransport, type PasswordProof, type ScimMembers,
} from '../../../../packages/identity/src/index.ts';

type MfaProof = Awaited<ReturnType<TotpIdentity['finish']>>;
type Account = { accountId: string; label: string };
type Core = {
  // Require a cookie session and a fresh password check for that same account.
  withReauthenticatedAccount<T>(request: FastifyRequest, password: string, run: (account: Account) => Promise<T>): Promise<T>;
  // The issuer must serialize with factor changes and recheck account, password version and factor ID.
  issueMfaSession(request: FastifyRequest, reply: FastifyReply, verify: () => Promise<MfaProof>): Promise<unknown>;
};

type Enterprise = {
  connection: ConnectionLookup;
  transport: OidcTransport;
  members: ScimMembers;
  // Resolve the verified subject in this connection and issue in the same transaction as the
  // active membership and connection revision checks. Never link accounts by email.
  issueFederatedSession(request: FastifyRequest, reply: FastifyReply, proof: FederationProof): Promise<unknown>;
};

export type IdentityExtensionOptions = {
  origin: string;
  totpOrigins?: ReadonlySet<string>;
  encryptionKey: Uint8Array;
  state: IdentityState;
  core: Core;
} & ({ deployment: 'private' } | { deployment: 'saas'; enterprise?: Enterprise });

const mfaPath = '/api/v1/auth/totp';
const ssoPath = '/api/v1/auth/sso/:tenantId/:connectionId';
const scimPath = scimBase({ tenantId: ':tenantId', connectionId: ':connectionId' });
const browserCookie = '__Host-smartsell_sso';
const enterpriseGuard = { enterpriseIdentityGuard: true };

export function enterpriseIdentityOwnsRequestGuard(request: FastifyRequest) {
  const config = request.routeOptions.config;
  return !!config && 'enterpriseIdentityGuard' in config && config.enterpriseIdentityGuard === true;
}

function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IdentityError(400, 'Expected a request object');
  return value as Record<string, unknown>;
}

function field(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new IdentityError(400, 'Invalid identity request');
  return value;
}

function answer(body: Record<string, unknown>): MfaAnswer {
  if ((body.totp === undefined) === (body.recoveryCode === undefined)) throw new IdentityError(400, 'Provide one second factor');
  return body.totp !== undefined ? { totp: field(body.totp, 6) } : { recoveryCode: field(body.recoveryCode, 32) };
}

function once(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length !== 1) throw new IdentityError();
  return values[0];
}

function noStore(reply: FastifyReply) {
  reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
}

function route(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    try { return await handler(request, reply); }
    catch (error) {
      const status = error instanceof IdentityError ? error.statusCode : 500;
      return reply.code(status).send({ error: error instanceof IdentityError ? error.message : 'Identity operation failed' });
    }
  };
}

function sameOrigin(request: FastifyRequest, origin: string) {
  if (request.headers.origin !== origin) throw new IdentityError(403, 'Origin not allowed');
}

export function registerEnterpriseIdentity(app: FastifyInstance, options: IdentityExtensionOptions) {
  const secrets = new IdentitySecrets(options.encryptionKey);
  const totp = new TotpIdentity(options.state, secrets);
  function totpOrigin(request: FastifyRequest) {
    if (!request.headers.origin || !options.totpOrigins?.has(request.headers.origin)) sameOrigin(request, options.origin);
  }
  const manage = (action: (account: Account, body: Record<string, unknown>) => Promise<unknown>) => route(async request => {
    totpOrigin(request);
    const body = object(request.body);
    const data = await options.core.withReauthenticatedAccount(request, field(body.password, 1024), account => action(account, body));
    return { data, ...data as object };
  });
  app.post(`${mfaPath}/enroll`, manage(account => totp.enroll(account.accountId, account.label)));
  app.post(`${mfaPath}/confirm`, manage((account, body) => totp.confirm(account.accountId, field(body.enrollmentId, 43), field(body.totp, 6))));
  app.post(`${mfaPath}/revoke`, manage(async (account, body) => {
    await totp.revoke(account.accountId, answer(body), 'factor');
    return { revoked: true };
  }));
  app.post(`${mfaPath}/recovery/revoke`, manage(async (account, body) => {
    await totp.revoke(account.accountId, answer(body), 'recovery');
    return { revoked: true };
  }));
  app.post(`${mfaPath}/challenge`, route(async (request, reply) => {
    totpOrigin(request);
    const body = object(request.body);
    const challenge = field(body.challenge, 43);
    const factor = answer(body);
    return options.core.issueMfaSession(request, reply, () => totp.finish(challenge, factor));
  }));

  if (options.deployment === 'saas' && options.enterprise) {
    // Encapsulation keeps SCIM/form parsers and enterprise routes out of other modules.
    const enterprise = options.enterprise;
    app.register(async scoped => registerSaas(scoped, options.origin, options.state, secrets, enterprise));
  }

  return {
    afterPassword: (proof: PasswordProof) => totp.afterPassword(proof),
    factorId: (accountId: string) => totp.factorId(accountId),
  };
}

function registerSaas(app: FastifyInstance, origin: string, state: IdentityState, secrets: IdentitySecrets, core: Enterprise) {
  const federation = new FederationIdentity(state, secrets, core.connection, core.transport, origin);
  const scim = new ScimIdentity(core.connection, core.members, origin);
  app.removeContentTypeParser('application/x-www-form-urlencoded');
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, new URLSearchParams(body as string));
  });
  app.addContentTypeParser('application/scim+json', { parseAs: 'string' }, app.getDefaultJsonParser('error', 'error'));

  function scope(request: FastifyRequest): ConnectionScope & { id?: string } {
    return request.params as ConnectionScope & { id?: string };
  }

  for (const protocol of ['oidc', 'saml'] as const) {
    app.post(`${ssoPath}/${protocol}/start`, { config: enterpriseGuard, bodyLimit: 8 * 1024 }, route(async (request, reply) => {
      sameOrigin(request, origin);
      const started = await federation.begin(scope(request), protocol);
      reply.header('set-cookie', `${browserCookie}=${started.browser}; Path=/; HttpOnly; Secure; SameSite=${protocol === 'saml' ? 'None' : 'Lax'}; Max-Age=300`);
      return reply.redirect(started.redirect, 303);
    }));
    app.route({ method: protocol === 'oidc' ? 'GET' : 'POST', url: `${ssoPath}/${protocol}/callback`, bodyLimit: 256 * 1024,
      config: protocol === 'saml' ? enterpriseGuard : undefined,
      handler: route(async (request, reply) => {
        const cookies = (request.headers.cookie ?? '').split(';').map(part => part.trim())
          .filter(part => part.startsWith(`${browserCookie}=`));
        if (cookies.length !== 1) throw new IdentityError();
        const browser = cookies[0].slice(browserCookie.length + 1);
        const params = protocol === 'oidc' ? new URL(request.url, origin).searchParams : request.body;
        if (!(params instanceof URLSearchParams)) throw new IdentityError(400, 'Invalid callback');
        const state = once(params, protocol === 'oidc' ? 'state' : 'RelayState');
        const proof = await federation.finish(scope(request), protocol, state, browser,
          protocol === 'oidc' ? params : once(params, 'SAMLResponse'));
        return core.issueFederatedSession(request, reply, proof);
      }),
    });
  }

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const variants = method === 'GET' ? ['', '/:id'] : [method === 'POST' ? '' : '/:id'];
    for (const suffix of variants) {
      app.route({ method, url: `${scimPath}/Users${suffix}`, config: enterpriseGuard, bodyLimit: 64 * 1024, async handler(request, reply) {
        noStore(reply);
        reply.type('application/scim+json');
        try {
          const auth = await scim.authorize(scope(request), request.headers.authorization);
          const id = scope(request).id;
          if (id !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new IdentityError(404, 'Resource not found');
          if (method === 'GET') return id ? await scim.get(auth, id) : await scim.list(auth, new URL(request.url, origin).searchParams);
          if (method === 'POST') {
            const member = await scim.create(auth, request.body);
            return reply.code(201).header('location', member.meta.location).send(member);
          }
          if (method === 'DELETE') {
            await scim.remove(auth, id!);
            return reply.code(204).send();
          }
          return await scim.update(auth, id!, request.body, method);
        } catch (error) {
          const { status, body } = scimError(error);
          if (status === 401) reply.header('www-authenticate', 'Bearer');
          return reply.code(status).send(body);
        }
      } });
    }
  }
}
