import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Problem, type Data, type Role } from '@smartsell/contracts';
import type { Records, Store } from '@smartsell/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { loginIdentifier, setupRequirements, setupStatus, type LoginIdentifier } from './setup-policy.js';
import { publicUser, type SessionUser } from './session-user.js';

const sessionTtl = 7 * 86400;
const passwordOptions = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
export const opaque = () => randomBytes(32).toString('base64url');
export const nowSeconds = () => Math.floor(Date.now() / 1000);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const denied = () => new Problem(403, 'PERMISSION_DENIED', 'Permission denied');
const unauthorized = () => new Problem(401, 'UNAUTHENTICATED', 'Authentication required');
export const missing = () => new Problem(404, 'NOT_FOUND', 'Resource not found');
export const invalid = (message: string) => new Problem(422, 'VALIDATION_FAILED', message);
export const isObject = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
export function bodyObject(value: unknown): Data {
  if (value === undefined) return {};
  if (!isObject(value)) throw invalid('Expected a JSON object');
  function validate(field: unknown, depth: number) {
    if (depth > 48) throw invalid('JSON nesting limit exceeded');
    if (typeof field === 'number' && !Number.isFinite(field)) throw invalid('Invalid JSON number');
    if (field && typeof field === 'object') {
      for (const child of Object.values(field)) validate(child, depth + 1);
    }
  }
  validate(value, 0);
  return value;
}

export interface User extends SessionUser { passwordHash: string }
export interface Workspace { id: string; name: string; tenantId: string }
export interface Membership { userId: string; workspaceId: string; role: Role; scopes?: string[] }
export interface Session { userId: string; csrf: string; expires: number; tenantId?: string; excludedTenants?: string[] }
export function sessionAllowsTenant(session: Session | undefined, tenantId: string) {
  return (!session?.tenantId || session.tenantId === tenantId) && !session?.excludedTenants?.includes(tenantId);
}
export interface Grant {
  userId: string; workspaceId: string; access: 'read' | 'write'; tools?: string[];
  expires: number; id: string; kind: 'pat' | 'oauth'; clientId?: string; workspaceRemoved?: boolean;
}
export interface Principal { user: User; session?: Session; grant?: Grant }
const safeEqual = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));

export function header(req: FastifyRequest, name: string) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function originGuard(req: FastifyRequest, config: Config) {
  const origin = header(req, 'origin');
  if ((origin !== undefined && !config.origins.has(origin)) || header(req, 'sec-fetch-site') === 'cross-site') throw denied();
}

function credentials(body: Data) {
  const useUsername = body.username !== undefined;
  const identifier = loginIdentifier(useUsername ? body.username : body.email, useUsername);
  const password = body.password;
  if (!identifier || typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) {
    throw invalid(useUsername ? 'A valid username and password are required' : 'A valid email and password are required');
  }
  return { identifier, password };
}

function loginKey(identifier: LoginIdentifier) {
  return identifier.email === undefined ? `username/${identifier.username}` : `email/${identifier.email}`;
}

function initialized(identity: Records) {
  return !!identity.get('setup') || identity.list('user/').length > 0 || identity.list('workspace/').length > 0;
}

export function membership(identity: Records, principal: Principal, id: string) {
  if (!uuid.test(id) || (principal.grant && id !== principal.grant.workspaceId)) throw missing();
  if (principal.grant?.workspaceRemoved) throw denied();
  const ws = identity.get<Workspace>(`workspace/${id}`);
  const member = identity.get<Membership>(`member/${principal.user.id}/${id}`);
  if (!ws || !member || !sessionAllowsTenant(principal.session, ws.tenantId) || identity.get<{ status: string }>(`tenant/${ws.tenantId}`)?.status !== 'active') throw missing();
  return { ...ws, role: member.role, scopes: member.scopes };
}

export function registerGrant(identity: Records, payload: Omit<Grant, 'id'>) {
  const token = `${payload.kind === 'pat' ? 'ss_pat' : 'ss_oauth'}_${opaque()}`;
  const key = digest(token);
  const grant = { ...payload, id: randomUUID() };
  identity.put(`grant/${key}`, grant);
  identity.put(`grant-index/${grant.userId}/${grant.id}`, key);
  return { token, grant };
}

export function auth(store: Store, config: Config, afterPassword?: (identity: Records, user: User) => Promise<{ required: true; challenge: string } | { required: false }>) {
  const cookieName = config.secureCookie ? '__Host-smartsell_session' : 'smartsell_session';
  function cookie(req: FastifyRequest) {
    const values = header(req, 'cookie')?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    return values?.length === 1 ? values[0].slice(cookieName.length + 1) : undefined;
  }
  const cookieHeader = (value: string, maxAge: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookie ? '; Secure' : ''}`;
  let dummyHash: Promise<string> | undefined;

  function authenticate(identity: Records, req: FastifyRequest, mode: 'both' | 'bearer' | 'session' = 'both'): Principal {
    const authorization = header(req, 'authorization');
    if (mode !== 'session' && authorization !== undefined) {
      const token = /^Bearer (ss_(?:pat|oauth)_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
      const grant = token && identity.get<Grant>(`grant/${digest(token)}`);
      const user = grant && identity.get<User>(`user/${grant.userId}`);
      if (!grant || grant.expires <= nowSeconds() || !user) throw unauthorized();
      return { user, grant };
    }
    if (mode === 'bearer') throw unauthorized();
    const token = cookie(req);
    const session = token && /^[A-Za-z0-9_-]{43}$/.test(token) && identity.get<Session>(`session/${digest(token)}`);
    const user = session && identity.get<User>(`user/${session.userId}`);
    if (!session || session.expires <= nowSeconds() || !user) throw unauthorized();
    return { user, session };
  }

  function csrf(req: FastifyRequest, principal: Principal, formToken?: unknown) {
    if (principal.grant) return;
    originGuard(req, config);
    const token = formToken ?? header(req, 'x-csrf-token');
    if (!principal.session || typeof token !== 'string' || token.length !== 43 || !safeEqual(token, principal.session.csrf)) {
      throw new Problem(403, 'CSRF_FAILED', 'Invalid CSRF token');
    }
  }

  function sessionData(identity: Records, principal: Principal) {
    const workspaces = identity.list<Membership>(`member/${principal.user.id}/`).flatMap(({ workspaceId, role }) => {
      const ws = identity.get<Workspace>(`workspace/${workspaceId}`);
      if (!ws || !sessionAllowsTenant(principal.session, ws.tenantId) || (principal.grant && (principal.grant.workspaceId !== ws.id || principal.grant.workspaceRemoved)) ||
        identity.get<{ status: string }>(`tenant/${ws.tenantId}`)?.status !== 'active') return [];
      return [{ id: ws.id, name: ws.name, role }];
    }).sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { user: publicUser(principal.user), workspaces, ...(principal.session && { csrf_token: principal.session.csrf }) };
  }

  function openSession(identity: Records, req: FastifyRequest, user: User, tenantId?: string) {
    const previous = cookie(req);
    if (previous) identity.delete(`session/${digest(previous)}`);
    const token = opaque();
    const session: Session = { userId: user.id, csrf: opaque(), expires: nowSeconds() + sessionTtl, tenantId };
    identity.put(`session/${digest(token)}`, session);
    return { data: sessionData(identity, { user, session }), cookie: cookieHeader(token, sessionTtl) };
  }

  async function login(req: FastifyRequest, data: Data) {
    originGuard(req, config);
    const { identifier, password } = credentials(data);
    const key = loginKey(identifier);
    const user = await store.transaction({ readOnly: true }, ({ identity }) => {
      const id = identity.get<string>(key);
      return id ? identity.get<User>(`user/${id}`) : undefined;
    });
    const hashed = user?.passwordHash || await (dummyHash ??= hash(opaque(), passwordOptions));
    const invalidCredentials = () => new Problem(401, 'INVALID_CREDENTIALS', 'Invalid sign-in credentials');
    if (!await verify(hashed, password) || !user?.passwordHash) throw invalidCredentials();
    return store.transaction({ identityWrite: true }, async ({ identity }) => {
      const current = identity.get<User>(`user/${user.id}`);
      if (!current || current.passwordHash !== user.passwordHash) throw invalidCredentials();
      const challenge = await afterPassword?.(identity, current);
      return challenge?.required ? { data: challenge } : openSession(identity, req, current);
    });
  }

  async function readSetupStatus(req: FastifyRequest) {
    return store.transaction({ readOnly: true }, ({ identity }) => setupStatus(req, config, initialized(identity)));
  }

  async function setup(req: FastifyRequest, data: Data) {
    originGuard(req, config);
    const supplied = header(req, 'x-setup-token');
    const requirements = setupRequirements(req, config);
    if (requirements.token_required && (!config.setupToken || !supplied || !safeEqual(supplied, config.setupToken))) throw denied();
    const { identifier, password } = credentials(data);
    const { email, username } = identifier;
    const rawName = data.workspace_name ?? data.workspaceName ?? (data.username === undefined ? '' : 'SmartSell');
    const workspaceName = typeof rawName === 'string' ? rawName.trim() : '';
    const name = typeof data.name === 'string' ? data.name.trim() : username ?? email?.split('@')[0].slice(0, 120);
    const minimum = requirements.password_min_length;
    if (password.length < minimum || !workspaceName || workspaceName.length > 120 || !name || name.length > 120 ||
      workspaceName.includes('\0') || name.includes('\0')) {
      throw invalid(`Workspace name and a password of at least ${minimum} characters are required`);
    }
    const key = loginKey(identifier);
    const check = (identity: Records) => {
      if (initialized(identity) || identity.get(key)) throw new Problem(409, 'ALREADY_CONFIGURED', 'Setup has already completed');
    };
    await store.transaction({ readOnly: true }, ({ identity }) => check(identity));
    const passwordHash = await hash(password, passwordOptions);
    return store.transaction({ identityWrite: true }, async tx => {
      const { identity } = tx;
      check(identity);
      const userId = randomUUID();
      const user: User = { id: userId, email: email ?? `username:${userId}`, username, name, passwordHash };
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      identity.put('setup', true);
      identity.put(`tenant/${tenantId}`, { id: tenantId, name: workspaceName, status: 'active', ownerId: user.id });
      identity.put(`tenant-member/${tenantId}/${user.id}`, { role: 'owner' });
      identity.put(`workspace/${workspaceId}`, { id: workspaceId, name: workspaceName, tenantId } satisfies Workspace);
      identity.put(`user/${user.id}`, user);
      identity.put(key, user.id);
      identity.put(`member/${user.id}/${workspaceId}`, { userId: user.id, workspaceId, role: 'owner' } satisfies Membership);
      const scoped = await tx.workspace({ tenantId, workspaceId, actorId: user.id });
      const at = new Date().toISOString();
      const id = randomUUID();
      scoped.put(`row/workspace/${workspaceId}`, { id: workspaceId, name: workspaceName, version: 1, created_at: at, updated_at: at });
      scoped.put(`audit/${id}`, { id, action: 'iam.setup', actor_id: user.id, occurred_at: at });
      return openSession(identity, req, user);
    });
  }

  async function logout(req: FastifyRequest, reply: FastifyReply) {
    const token = cookie(req);
    await store.transaction({ identityWrite: true }, ({ identity }) => {
      const principal = authenticate(identity, req, 'session');
      csrf(req, principal);
      identity.delete(`session/${digest(token!)}`);
    });
    return reply.header('set-cookie', cookieHeader('', 0)).code(204).send();
  }
  return { authenticate, csrf, sessionData, login, setup, readSetupStatus, logout, openSession,
    verifyPassword: (user: User, password: string) => user.passwordHash ? verify(user.passwordHash, password) : Promise.resolve(false) };
}
export type Auth = ReturnType<typeof auth>;
