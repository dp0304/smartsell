import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Records, Store } from '@smartsell/db';
import { Problem } from '@smartsell/contracts';
import { z } from 'zod';
import {
  IdentityError, IdentitySecrets, httpsUrl, opaque,
  type ConnectionScope, type EnterpriseConnection, type IdentityState, type OidcTransport, type ScimMember, type ScimMembers,
} from '../../../../packages/identity/src/index.ts';
import type { Config } from '../config.js';
import { registerEnterpriseIdentity } from '../extensions/enterprise-identity.js';
import { digest, sessionAllowsTenant, type Auth, type Grant, type Membership, type Session, type User, type Workspace } from '../identity.js';
import { publicAddress } from '../modules/traffic/probe.js';

export async function loadIdentityKey(config: Config) {
  if (config.identityKey || config.production) return Buffer.from(config.identityKey ?? config.secret, 'hex');
  if (config.databaseUrl) throw new Error('Set IDENTITY_ENCRYPTION_KEY for the development PostgreSQL database');
  const path = `${config.statePath}.identity-key`;
  let key: Buffer;
  try { key = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = randomBytes(32);
    await writeFile(path, key, { flag: 'wx', mode: 0o600 });
  }
  if (key.length !== 32) throw new Error('Invalid development identity key');
  return key;
}

// Reuse the core write lock when session issuance or reauthentication already owns it.
class RecordsIdentityState implements IdentityState {
  private readonly current = new AsyncLocalStorage<Records>();
  constructor(private readonly store: Store) {}

  within<T>(identity: Records, run: () => Promise<T>) { return this.current.run(identity, run); }

  private run<T>(write: boolean, read: (identity: Records) => T) {
    const identity = this.current.getStore();
    return identity ? Promise.resolve(read(identity)) : this.store.transaction(write ? { identityWrite: true } : { readOnly: true }, tx => read(tx.identity));
  }

  read<T>(key: string) {
    return this.run(false, identity => identity.get<{ version: string; value: T }>(`enterprise/state/${key}`) ?? null);
  }

  compareAndSwap<T>(key: string, version: string | null, value: T) {
    return this.run(true, identity => {
      const path = `enterprise/state/${key}`;
      if ((identity.get<{ version: string }>(path)?.version ?? null) !== version) return false;
      identity.put(path, { version: opaque(), value });
      return true;
    });
  }

  putFlow<T>(key: string, binding: string, expiresAt: number, value: T) {
    return this.run(true, identity => {
      for (const [path, flow] of identity.entries<{ expiresAt: number }>('enterprise/flow/')) {
        if (flow.expiresAt <= Date.now()) identity.delete(path);
      }
      const path = `enterprise/flow/${key}`;
      if (identity.get(path)) throw new Error('Duplicate identity flow');
      identity.put(path, { binding, expiresAt, value });
    });
  }

  takeFlow<T>(key: string, binding: string) {
    return this.run(true, identity => {
      const path = `enterprise/flow/${key}`;
      const flow = identity.get<{ binding: string; expiresAt: number; value: T }>(path);
      if (!flow || flow.binding !== binding) return null;
      identity.delete(path);
      return flow.expiresAt > Date.now() ? flow.value : null;
    });
  }
}

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const https = z.string().max(2048).refine(value => { try { httpsUrl(value); return true; } catch { return false; } });
const scopeFields = { tenantId: identifier, connectionId: identifier };
const connectionFields = { ...scopeFields, workspaceId: identifier, seatLimit: z.number().int().positive(),
  scimTokenHash: z.string().regex(/^[0-9a-f]{64}$/).optional() };
const connectionInput = z.discriminatedUnion('protocol', [
  z.strictObject({ ...connectionFields, protocol: z.literal('oidc'), issuer: https.refine(url => !new URL(url).search),
    authorizationEndpoint: https, tokenEndpoint: https, jwksUri: https, clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(), signingAlgorithm: z.enum(['RS256', 'PS256', 'ES256']) }),
  z.strictObject({ ...connectionFields, protocol: z.literal('saml'), issuer: z.string().min(1), entryPoint: https,
    entityId: z.string().min(1), idpCert: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    nameIdFormat: z.string().min(1), requestSigningKey: z.string().min(1).optional() }),
  z.strictObject({ ...scopeFields, protocol: z.literal('disabled') }),
]);
const connectionKey = (scope: ConnectionScope) => `enterprise/connection/${scope.tenantId}/${scope.connectionId}`;
const memberPrefix = (scope: ConnectionScope) => `enterprise/member/${scope.tenantId}/${scope.connectionId}/`;
const subjectKey = (scope: ConnectionScope, subject: string) => `enterprise/subject/${scope.tenantId}/${scope.connectionId}/${digest(subject)}`;
type StoredConnection = { revision: string; sealed: string; workspaceId: string };
type ManagedMember = ScimMember & { removed?: boolean };

// Called by the operator command. Persist a new revision so all replicas see a change immediately.
export async function configureEnterpriseConnection(store: Store, key: Uint8Array, raw: unknown) {
  const input = connectionInput.safeParse(raw);
  if (!input.success) throw new Error(`Invalid connection configuration: ${input.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  const value = input.data;
  const path = connectionKey(value);
  await store.transaction({ identityWrite: true }, ({ identity }) => {
    const previous = identity.get<StoredConnection>(path);
    if (value.protocol === 'disabled') {
      if (previous) identity.put(path, { ...previous, revision: '', sealed: '' });
      return;
    }
    if (identity.get<Workspace>(`workspace/${value.workspaceId}`)?.tenantId !== value.tenantId) {
      throw new Error('Connection workspace does not belong to the tenant');
    }
    if (previous && previous.workspaceId !== value.workspaceId) throw new Error('Use a new connection ID to choose another workspace');
    const { workspaceId, seatLimit, ...connection } = value;
    const revision = randomUUID();
    const sealed = new IdentitySecrets(key).seal(JSON.stringify({ ...connection, revision }), `${path}/${revision}`);
    identity.put(path, { revision, sealed, workspaceId } satisfies StoredConnection);
    identity.put(`enterprise/seat-limit/${value.tenantId}`, seatLimit);
  });
}

function tenantMemberships(identity: Records, userId: string, tenantId: string) {
  return identity.entries<Membership>(`member/${userId}/`).filter(([, member]) =>
    identity.get<Workspace>(`workspace/${member.workspaceId}`)?.tenantId === tenantId);
}

function revokeTenantAccess(identity: Records, userId: string, tenantId: string) {
  const belongsToTenant = (workspaceId: string) => identity.get<Workspace>(`workspace/${workspaceId}`)?.tenantId === tenantId;
  for (const [key] of tenantMemberships(identity, userId, tenantId)) identity.delete(key);
  identity.delete(`tenant-member/${tenantId}/${userId}`);
  for (const [key, invite] of identity.entries<{ userId: string; workspaceId: string }>('workspace-invite/')) {
    if (invite.userId === userId && belongsToTenant(invite.workspaceId)) identity.delete(key);
  }
  for (const [key, session] of identity.entries<Session>('session/')) {
    if (session.userId !== userId || !sessionAllowsTenant(session, tenantId)) continue;
    const remaining = identity.list<Membership>(`member/${userId}/`).some(({ workspaceId }) => {
      const workspace = identity.get<Workspace>(`workspace/${workspaceId}`);
      return workspace && sessionAllowsTenant(session, workspace.tenantId);
    });
    if (!remaining) identity.delete(key);
    else identity.put(key, { ...session, excludedTenants: [...session.excludedTenants ?? [], tenantId] });
  }
  for (const [key, grant] of identity.entries<Grant>('grant/')) {
    if (grant.userId !== userId || !belongsToTenant(grant.workspaceId)) continue;
    identity.delete(key);
    identity.delete(`grant-index/${userId}/${grant.id}`);
  }
  for (const [key, code] of identity.entries<{ userId: string; workspaceId: string }>('oauth-code/')) {
    if (code.userId === userId && belongsToTenant(code.workspaceId)) identity.delete(key);
  }
}

function activate(identity: Records, id: string, scope: ConnectionScope, workspaceId: string) {
  const occupied = new Set(identity.list<Membership>('member/').flatMap(member =>
    identity.get<Workspace>(`workspace/${member.workspaceId}`)?.tenantId === scope.tenantId ? [member.userId] : []));
  const limit = identity.get<number>(`enterprise/seat-limit/${scope.tenantId}`) ?? 0;
  if (!occupied.has(id) && occupied.size >= limit) throw new IdentityError(409, 'Tenant seat limit reached');
  identity.put(`member/${id}/${workspaceId}`, { userId: id, workspaceId, role: 'viewer' } satisfies Membership);
  if (!identity.get(`tenant-member/${scope.tenantId}/${id}`)) {
    identity.put(`tenant-member/${scope.tenantId}/${id}`, { role: 'viewer' });
  }
}

const outbound: OidcTransport = async (_scope, raw, options) => {
  const url = httpsUrl(raw);
  // Resolve approved DNS names once and connect directly to a validated address, with normal TLS hostname verification.
  if (!/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) throw new IdentityError();
  const addresses = await new Resolver({ timeout: 1000, tries: 1 }).resolve4(`${url.hostname}.`);
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new IdentityError();
  const signal = options.signal;
  const body = options.body;
  if (body != null && typeof body !== 'string' && !(body instanceof URLSearchParams)) throw new IdentityError();
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method, headers: { ...options.headers, 'accept-encoding': 'identity' },
      agent: false, family: 4, signal, lookup: (_hostname, _options, callback) => callback(null, addresses[0], 4) }, res => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        for (const part of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, part);
      }
      const status = res.statusCode ?? 502;
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) res.destroy(new IdentityError());
        else chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => {
        const hasBody = ![204, 205, 304].includes(status);
        resolve(new Response(hasBody ? Buffer.concat(chunks) : null, { status, headers }));
      });
    });
    req.once('error', reject);
    req.end(body?.toString());
  });
};

export function enterpriseHost(app: FastifyInstance, store: Store, config: Config, key: Uint8Array, auth: () => Auth,
  testTransport?: OidcTransport) {
  const state = new RecordsIdentityState(store);
  const secrets = new IdentitySecrets(key);
  const getConnection = (identity: Records, scope: ConnectionScope, revision?: string) => {
    const stored = identity.get<StoredConnection>(connectionKey(scope));
    if (!stored?.revision || (revision !== undefined && stored.revision !== revision) ||
      identity.get<{ status: string }>(`tenant/${scope.tenantId}`)?.status !== 'active' ||
      identity.get<Workspace>(`workspace/${stored.workspaceId}`)?.tenantId !== scope.tenantId) return null;
    return stored;
  };
  const connection = (scope: ConnectionScope) => store.transaction({ readOnly: true }, ({ identity }) => {
    const stored = getConnection(identity, scope);
    if (!stored) return null;
    return JSON.parse(secrets.open(stored.sealed, `${connectionKey(scope)}/${stored.revision}`)) as EnterpriseConnection;
  });
  const inConnection = <T>(scope: ConnectionScope & { revision: string }, write: boolean,
    run: (identity: Records, workspaceId: string) => T) => store.transaction(write ? { identityWrite: true } : { readOnly: true }, ({ identity }) => {
    const stored = getConnection(identity, scope, scope.revision);
    if (!stored) throw new IdentityError(401, 'Connection unavailable');
    return run(identity, stored.workspaceId);
  });
  const readMember = (identity: Records, scope: ConnectionScope, id: string) => {
    const member = identity.get<ManagedMember>(`${memberPrefix(scope)}${id}`);
    return member && !member.removed ? member : null;
  };
  const members: ScimMembers = {
    create: (scope, input) => inConnection(scope, true, (identity, workspaceId) => {
      const subject = subjectKey(scope, input.externalId);
      if (identity.get(subject)) throw new IdentityError(409, 'External identity already exists');
      const id = randomUUID();
      const member = { id, ...input };
      if (input.active) activate(identity, id, scope, workspaceId);
      identity.put(`user/${id}`, { id, email: input.userName, name: input.displayName ?? input.userName, passwordHash: '' } satisfies User);
      identity.put(subject, id);
      identity.put(`${memberPrefix(scope)}${id}`, member);
      return member;
    }),
    get: (scope, id) => inConnection(scope, false, identity => readMember(identity, scope, id)),
    list: (scope, { startIndex, count, filter }) => inConnection(scope, false, identity => {
      const visible = identity.list<ManagedMember>(memberPrefix(scope)).filter(member => !member.removed &&
        (!filter || member[filter.field] === filter.value)).sort((a, b) => a.id.localeCompare(b.id));
      return { total: visible.length, members: visible.slice(startIndex - 1, startIndex - 1 + count) };
    }),
    update: (scope, id, update, expectedExternalId) => inConnection(scope, true, (identity, workspaceId) => {
      const member = readMember(identity, scope, id);
      if (!member) return null;
      if (expectedExternalId !== undefined && expectedExternalId !== member.externalId) throw new IdentityError(400, 'externalId is immutable');
      const next = { ...member, ...update };
      if (next.active && !member.active) activate(identity, id, scope, workspaceId);
      if (!next.active && member.active) revokeTenantAccess(identity, id, scope.tenantId);
      const user = identity.get<User>(`user/${id}`)!;
      identity.put(`user/${id}`, { ...user, email: next.userName, name: next.displayName ?? next.userName });
      identity.put(`${memberPrefix(scope)}${id}`, next);
      return next;
    }),
    remove: (scope, id) => inConnection(scope, true, identity => {
      const member = readMember(identity, scope, id);
      if (!member) return false;
      revokeTenantAccess(identity, id, scope.tenantId);
      identity.put(`${memberPrefix(scope)}${id}`, { ...member, active: false, removed: true });
      return true;
    }),
  };

  const write = <T>(run: (identity: Records) => Promise<T>) => store.transaction({ identityWrite: true }, ({ identity }) => state.within(identity, () => run(identity)));
  const issue = (reply: FastifyReply, result: ReturnType<Auth['openSession']>) =>
    reply.header('set-cookie', result.cookie).send({ data: result.data, ...result.data });
  const account = (identity: Records, request: FastifyRequest) => {
    try {
      const principal = auth().authenticate(identity, request, 'session');
      auth().csrf(request, principal);
      return principal;
    } catch (error) {
      if (error instanceof Problem) throw new IdentityError(error.status, error.message);
      throw error;
    }
  };
  const core = {
    async withReauthenticatedAccount<T>(request: FastifyRequest, password: string, run: (input: { accountId: string; label: string }) => Promise<T>) {
      if (Buffer.byteLength(password) > 1024) throw new IdentityError(400, 'Invalid password');
      const user = await write(async identity => {
        const { user } = account(identity, request);
        const key = `enterprise/password-attempt/${user.id}`;
        const now = Date.now();
        const current = identity.get<{ until: number; count: number }>(key);
        const window = current && current.until > now ? current : { until: now + 60_000, count: 0 };
        if (window.count >= 10) throw new IdentityError(429, 'Try again later');
        identity.put(key, { ...window, count: window.count + 1 });
        return user;
      });
      if (!await auth().verifyPassword(user, password)) throw new IdentityError();
      const result = await write(async identity => {
        const principal = account(identity, request);
        if (principal.user.id !== user.id || principal.user.passwordHash !== user.passwordHash) throw new IdentityError();
        const before = await hooks.factorId(user.id);
        try {
          const data = await run({ accountId: user.id, label: user.username ?? user.email });
          if (before !== await hooks.factorId(user.id)) {
            for (const [key, session] of identity.entries<Session>('session/')) {
              if (session.userId === user.id && session.csrf !== principal.session?.csrf) identity.delete(key);
            }
          }
          return { data };
        } catch (error) {
          // Commit a failed factor attempt so its throttling survives the response.
          if (error instanceof IdentityError) return { error };
          throw error;
        }
      });
      if (result.error) throw result.error;
      return result.data as T;
    },
    async issueMfaSession(request: FastifyRequest, reply: FastifyReply, verify: () => Promise<{ accountId: string; credentialVersion: string; factorId: string }>) {
      const result = await write(async identity => {
        try {
          const proof = await verify();
          const user = identity.get<User>(`user/${proof.accountId}`);
          if (!user?.passwordHash || digest(user.passwordHash) !== proof.credentialVersion ||
            await hooks.factorId(user.id) !== proof.factorId) throw new IdentityError();
          return { session: auth().openSession(identity, request, user) };
        } catch (error) {
          // Consume the challenge and any factor attempt even when sign-in is rejected.
          if (error instanceof IdentityError) return { error };
          throw error;
        }
      });
      if (result.error) throw result.error;
      return issue(reply, result.session);
    },
  };
  const hooks = registerEnterpriseIdentity(app, { origin: config.origin, totpOrigins: config.origins, encryptionKey: key, state, core,
    ...(config.identityDeployment === 'saas' ? { deployment: 'saas' as const, enterprise: {
      connection, members,
      transport: testTransport && !config.production ? testTransport : async (scope, url, options) => {
        const current = await connection(scope);
        if (current?.protocol !== 'oidc' || (options.method === 'POST' ? httpsUrl(current.tokenEndpoint).href : httpsUrl(current.jwksUri).href) !== url) {
          throw new IdentityError();
        }
        return outbound(scope, url, options);
      },
      async issueFederatedSession(request, reply, proof) {
        const result = await inConnection(proof, true, (identity, workspaceId) => {
          const id = identity.get<string>(subjectKey(proof, proof.subject));
          const user = id && identity.get<User>(`user/${id}`);
          if (!user || !readMember(identity, proof, user.id)?.active || !identity.get(`member/${user.id}/${workspaceId}`)) throw new IdentityError();
          return auth().openSession(identity, request, user, proof.tenantId);
        });
        return reply.header('set-cookie', result.cookie).redirect('/', 303);
      },
    } } : { deployment: 'private' as const }),
  });
  app.get('/api/v1/auth/totp', request => store.transaction({ readOnly: true }, ({ identity }) => state.within(identity, async () => {
    const { user } = auth().authenticate(identity, request, 'session');
    return { data: { enabled: !!await hooks.factorId(user.id), canManage: !!user.passwordHash } };
  })));
  return { afterPassword: (identity: Records, user: User) => state.within(identity,
    () => hooks.afterPassword({ accountId: user.id, credentialVersion: digest(user.passwordHash) })) };
}
