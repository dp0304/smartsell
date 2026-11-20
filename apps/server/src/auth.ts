import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { DomainError, type Fields } from './modules/types';
import { SESSION_SECONDS, unauthenticated, type Store } from './store';
import type { commandIdentity } from './integration/command-identity.js';

const digest = (text: string) => createHash('sha256').update(text).digest();
const opaque = () => randomBytes(32).toString('base64url');
const argonOptions = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const phcPart = (bytes: number) => randomBytes(bytes).toString('base64').replace(/=+$/, '');
// Use the same verification cost for unknown accounts, with no sign-in target.
const missingAccountHash = `$argon2id$v=19$m=19456,t=2,p=1$${phcPart(16)}$${phcPart(32)}`;
let hashing = 0;

async function passwordSlot<T>(work: () => Promise<T>): Promise<T> {
  if (hashing >= 4) throw new DomainError('busy', 'Try again shortly', 429);
  hashing++;
  try { return await work(); } finally { hashing--; }
}

export async function passwordMatches(encoded: string | undefined, password: string) {
  const legacy = encoded?.match(/^([a-f0-9]{32}):([a-f0-9]{128})$/);
  if (legacy) {
    // Accounts initialized by the earlier preview still use its fixed scrypt parameters.
    const key = await passwordSlot(() => new Promise<Buffer>((resolve, reject) => {
      scrypt(password, legacy[1], 64, { N: 32768, r: 8, p: 3, maxmem: 65 * 1024 * 1024 },
        (error, result) => error ? reject(error) : resolve(result));
    }));
    return timingSafeEqual(key, Buffer.from(legacy[2], 'hex'));
  }
  const value = encoded?.startsWith('$argon2id$') ? encoded : missingAccountHash;
  return passwordSlot(() => argonVerify(value, password).catch(() => false));
}

export const invalid = (message: string) => new DomainError('invalid_input', message);
export const forbidden = () => new DomainError('forbidden', 'Access denied', 403);
export const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

export function requestObject(body: unknown): Fields {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected a JSON object');
  // Bound depth before hashing canonical JSON or passing it to module code.
  const visit = (value: unknown, depth: number) => {
    if (depth > 48) throw invalid('JSON nesting limit exceeded');
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalid('Invalid JSON number');
    if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(body, 0);
  return body as Fields;
}

function credentials(input: Fields) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = input.password;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.includes('\0') ||
    typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) throw invalid('A valid email and password are required');
  return { email, password };
}

function name(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || value.includes('\0')) throw invalid('Invalid name');
  return value.trim();
}

async function newPasswordHash(password: string) {
  if (password.length < 12) throw invalid('Password must be at least 12 characters');
  return passwordSlot(() => argonHash(password, argonOptions));
}

export type AuthOptions = { secureCookie: boolean; setupToken?: string; origins: ReadonlySet<string> };

export function auth(store: Store, options: AuthOptions, identity?: ReturnType<typeof commandIdentity>,
  csrfToken?: (hash: string) => string | undefined) {
  const cookieName = options.secureCookie ? '__Host-smartsell_session' : 'smartsell_session';
  const attempts = new Map<string, { count: number; until: number }>();
  let nextSweep = 0;

  function throttle(ip: string) {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      nextSweep = now + 60_000;
    }
    let value = attempts.get(ip);
    if (!value || value.until <= now) {
      if (attempts.size >= 10_000) throw new DomainError('rate_limited', 'Try again later', 429);
      value = { count: 0, until: now + 60_000 };
      attempts.set(ip, value);
    }
    if (++value.count > 10) throw new DomainError('rate_limited', 'Try again later', 429);
  }

  function tokenHash(request: FastifyRequest) {
    const matches = header(request, 'cookie')?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    const token = matches?.length === 1 ? matches[0].slice(cookieName.length + 1) : '';
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token).toString('hex') : undefined;
  }

  function setCookie(reply: FastifyReply, value: string, maxAge = SESSION_SECONDS) {
    reply.header('set-cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${options.secureCookie ? '; Secure' : ''}`);
  }

  async function session(hash: string | undefined) {
    const data = hash && await store.session(hash);
    if (!data) throw unauthenticated();
    return { ...data, ...(csrfToken && hash ? { csrf_token: csrfToken(hash) } : {}) };
  }

  async function openSession(reply: FastifyReply, token: string, hash: string) {
    const data = await session(hash);
    setCookie(reply, token);
    return { ...data, data };
  }

  return {
    tokenHash,
    guard(request: FastifyRequest, requiresJson = true) {
      if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
      const origin = header(request, 'origin');
      if (header(request, 'sec-fetch-site') === 'cross-site' || (origin !== undefined && !options.origins.has(origin))) throw forbidden();
      if (requiresJson && request.method === 'POST' && header(request, 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new DomainError('unsupported_media_type', 'Expected application/json', 415);
      }
    },
    async login(request: FastifyRequest, reply: FastifyReply) {
      throttle(request.ip);
      const { email, password } = credentials(requestObject(request.body));
      const user = await store.credentials(email);
      const matches = await passwordMatches(user?.passwordHash, password);
      if (!user || !matches) {
        throw new DomainError('invalid_credentials', 'Invalid email or password', 401);
      }
      const token = opaque();
      const hash = digest(token).toString('hex');
      if (identity) {
        const gate = await identity.login(user, hash, tokenHash(request));
        if (gate.required) return { data: gate };
      } else {
        await store.issueSession(user.id, hash, tokenHash(request));
      }
      return openSession(reply, token, hash);
    },
    async finishLogin(request: FastifyRequest, reply: FastifyReply) {
      if (!identity) throw unauthenticated();
      throttle(`mfa:${request.ip}`);
      const token = opaque();
      const hash = digest(token).toString('hex');
      await identity.finish(requestObject(request.body), hash, tokenHash(request));
      return openSession(reply, token, hash);
    },
    async setup(request: FastifyRequest, reply: FastifyReply) {
      throttle(request.ip);
      const supplied = header(request, 'x-setup-token');
      if (!options.setupToken || !supplied || !timingSafeEqual(digest(supplied), digest(options.setupToken))) throw forbidden();
      const input = requestObject(request.body);
      const { email, password } = credentials(input);
      const workspaceName = name(input.workspaceName);
      const displayName = name(input.name);
      const passwordHash = await newPasswordHash(password);
      const token = opaque();
      const hash = digest(token).toString('hex');
      if (!await store.setup({ email, name: displayName, passwordHash, workspaceName }, hash, tokenHash(request))) {
        throw new DomainError('already_configured', 'Setup has already completed', 409);
      }
      const data = await session(hash);
      setCookie(reply, token);
      return reply.code(201).send({ ...data, data });
    },
    async acceptMemberInvitation(request: FastifyRequest, reply: FastifyReply) {
      throttle(request.ip);
      const accept = store.acceptMemberInvitation?.bind(store);
      if (!accept) throw new DomainError('not_configured', 'Member invitations are unavailable', 503);
      const input = requestObject(request.body);
      const { email, password } = credentials(input);
      if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw invalid('Invalid invitation token');
      const displayName = name(input.name);
      const passwordHash = await newPasswordHash(password);
      if (!await accept({ tokenHash: digest(input.token).toString('hex'), email, name: displayName, passwordHash })) {
        throw new DomainError('invalid_invitation', 'Invitation is unavailable', 403);
      }
      return reply.code(204).send();
    },
    async read(request: FastifyRequest) {
      const data = await session(tokenHash(request));
      return { ...data, data };
    },
    async logout(request: FastifyRequest, reply: FastifyReply) {
      const hash = tokenHash(request);
      if (hash) await store.revokeSession(hash);
      setCookie(reply, '', 0);
      return reply.code(204).send();
    },
  };
}
