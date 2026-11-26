import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { DomainError, type Fields } from './modules/types';
import { SESSION_SECONDS, unauthenticated, type Store } from './store';
import type { commandIdentity } from './integration/command-identity.js';
import { DEFAULT_PASSWORD_MIN, loginIdentifier, setupRequirements, setupStatus, type SetupPolicy } from './setup-policy.js';

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

function credentials(input: Fields, allowUsername = false) {
  const useUsername = allowUsername && input.username !== undefined;
  const identifier = loginIdentifier(useUsername ? input.username : input.email, useUsername);
  const password = input.password;
  if (!identifier || typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) {
    throw invalid(useUsername ? 'A valid username and password are required' : 'A valid email and password are required');
  }
  return { identifier, password };
}

function name(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || value.includes('\0')) throw invalid('Invalid name');
  return value.trim();
}

async function newPasswordHash(password: string, minimum = DEFAULT_PASSWORD_MIN) {
  if (password.length < minimum) throw invalid(`Password must be at least ${minimum} characters`);
  return passwordSlot(() => argonHash(password, argonOptions));
}

export type AuthOptions = SetupPolicy & {
  secureCookie: boolean; origins: ReadonlySet<string>;
  /** Test seam for the sign-in slowdown (S3); defaults to a real timer. */
  loginDelay?: (ms: number) => Promise<void>;
};

const rateLimited = () => new DomainError('rate_limited', 'Try again later', 429);

/** Attempts per client address per minute (login, setup, invitations; `mfa:` keys for the second factor). */
export const CLIENT_ATTEMPTS_PER_MINUTE = 10;
/**
 * S3 (was SEC-2): failed sign-ins per sign-in name and client address per 15 minutes. Past it that address gets 429 for that
 * name; other addresses do not, so failing 20 times no longer locks the owner out everywhere.
 */
export const ACCOUNT_FAILURES_PER_WINDOW = 20;
export const ACCOUNT_FAILURE_WINDOW_MS = 15 * 60_000;
/**
 * S3: once a sign-in name has this many failures in the window from all addresses together (rotating X-Forwarded-For, many
 * clients), every further attempt for it waits before any password work: 1 s, doubling per failure, at most 10 s. Waiting
 * comes before the check, so the answer time tells nothing about the password, and the right password still signs in.
 */
export const ACCOUNT_SLOWDOWN_AFTER = 20;
export const ACCOUNT_SLOWDOWN_BASE_MS = 1_000;
export const ACCOUNT_SLOWDOWN_MAX_MS = 10_000;
/** S3: slowed attempts one sign-in name may have open at once; more answer 429. Bounds guesses at about 4 per 10 s per name. */
export const ACCOUNT_SLOWED_CONCURRENCY = 4;

/** Wait before checking a password for a name with `failures` failed sign-ins in the window (S3). */
export function signInDelayMs(failures: number) {
  if (failures < ACCOUNT_SLOWDOWN_AFTER) return 0;
  return Math.min(ACCOUNT_SLOWDOWN_MAX_MS, ACCOUNT_SLOWDOWN_BASE_MS * 2 ** Math.min(16, failures - ACCOUNT_SLOWDOWN_AFTER));
}

/**
 * SEC-2: a fixed-window counter that never locks everyone out when it is full. Expired entries go first, then the oldest
 * ones, so flooding it with made-up keys only ages out other made-up keys instead of refusing every newcomer.
 */
export function createThrottle(options: { limit: number; windowMs: number; capacity?: number; now?: () => number }) {
  const entries = new Map<string, { count: number; until: number }>();
  const capacity = options.capacity ?? 10_000;
  const clock = options.now ?? Date.now;
  let nextSweep = 0;
  const sweep = (now: number) => {
    for (const [key, value] of entries) if (value.until <= now) entries.delete(key);
    nextSweep = now + 60_000;
  };
  function entry(key: string, now: number) {
    if (now >= nextSweep) sweep(now);
    let value = entries.get(key);
    if (!value || value.until <= now) {
      entries.delete(key);
      if (entries.size >= capacity) sweep(now);
      // Map order is insertion order: the first key is the oldest window.
      while (entries.size >= capacity) entries.delete(entries.keys().next().value!);
      value = { count: 0, until: now + options.windowMs };
      entries.set(key, value);
    }
    return value;
  }
  return {
    /** Counts one attempt and throws 429 once `key` went over its limit in the current window. */
    hit(key: string) {
      if (++entry(key, clock()).count > options.limit) throw rateLimited();
    },
    /** Counts one failure without throwing (the caller is already answering). */
    record(key: string) { entry(key, clock()).count++; },
    /** True when `key` has used its whole budget in the current window; counts nothing. */
    exhausted(key: string) {
      const value = entries.get(key);
      return !!value && value.until > clock() && value.count >= options.limit;
    },
    /** Attempts counted for `key` in its current window (0 when none). */
    count(key: string) {
      const value = entries.get(key);
      return value && value.until > clock() ? value.count : 0;
    },
    clear(key: string) { entries.delete(key); },
    get size() { return entries.size; },
  };
}

export function auth(store: Store, options: AuthOptions, identity?: ReturnType<typeof commandIdentity>,
  csrfToken?: (hash: string) => string | undefined) {
  const cookieName = options.secureCookie ? '__Host-smartsell_session' : 'smartsell_session';
  // Keyed by request.ip. On the hub that is the X-Forwarded-For client of `tailscale serve` (trustProxy 127.0.0.1, config.ts),
  // which a process on the hub machine itself can set freely; the per-name slowdown below is what no header can bypass.
  // Behind the SaaS proxy request.ip is the real client only when TRUST_PROXY names that proxy (config.ts, S2).
  const clients = createThrottle({ limit: CLIENT_ATTEMPTS_PER_MINUTE, windowMs: 60_000 });
  // Existing accounts and made-up names are counted apart: the same answers for both (no enumeration), and flooding the
  // maps with made-up names can never age out the owner's counters.
  // S3: the hard limit is per (sign-in name, client address); the per-name count only slows attempts down.
  const pairs = createThrottle({ limit: ACCOUNT_FAILURES_PER_WINDOW, windowMs: ACCOUNT_FAILURE_WINDOW_MS });
  const unknownPairs = createThrottle({ limit: ACCOUNT_FAILURES_PER_WINDOW, windowMs: ACCOUNT_FAILURE_WINDOW_MS });
  const accounts = createThrottle({ limit: ACCOUNT_SLOWDOWN_AFTER, windowMs: ACCOUNT_FAILURE_WINDOW_MS });
  const unknownAccounts = createThrottle({ limit: ACCOUNT_SLOWDOWN_AFTER, windowMs: ACCOUNT_FAILURE_WINDOW_MS });
  /** Slowed attempts in progress per sign-in name. */
  const slowed = new Map<string, number>();
  const wait = options.loginDelay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const throttle = (ip: string) => clients.hit(ip);

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
      const { identifier, password } = credentials(requestObject(request.body), true);
      const account = identifier.username !== undefined ? `username:${identifier.username}` : `email:${identifier.email}`;
      const pair = `${account}\n${request.ip}`;
      // S3: this address failed too often for this name: 429 before any password work. Other addresses are not affected.
      if (pairs.exhausted(pair) || unknownPairs.exhausted(pair)) throw rateLimited();
      // S3: a name failing from many addresses is slowed down for everyone, never refused outright (up to a few at once).
      const delay = signInDelayMs(Math.max(accounts.count(account), unknownAccounts.count(account)));
      const verify = async () => {
        const found = await store.credentials(identifier);
        const matches = await passwordMatches(found?.passwordHash, password);
        if (!found || !matches) {
          (found ? pairs : unknownPairs).record(pair);
          (found ? accounts : unknownAccounts).record(account);
          throw new DomainError('invalid_credentials', 'Invalid sign-in credentials', 401);
        }
        return found;
      };
      let user: Awaited<ReturnType<typeof verify>>;
      if (!delay) user = await verify();
      else {
        const open = slowed.get(account) ?? 0;
        if (open >= ACCOUNT_SLOWED_CONCURRENCY) throw rateLimited();
        slowed.set(account, open + 1);
        try {
          await wait(delay);
          user = await verify();
        } finally {
          const left = (slowed.get(account) ?? 1) - 1;
          if (left > 0) slowed.set(account, left); else slowed.delete(account);
        }
      }
      // The per-name count is left to expire: someone else may still be guessing; the owner's own address starts over.
      pairs.clear(pair);
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
    async setupStatus(request: FastifyRequest) {
      return setupStatus(request, options, await store.initialized());
    },
    async setup(request: FastifyRequest, reply: FastifyReply) {
      throttle(request.ip);
      const supplied = header(request, 'x-setup-token');
      const requirements = setupRequirements(request, options);
      if (requirements.token_required &&
        (!options.setupToken || !supplied || !timingSafeEqual(digest(supplied), digest(options.setupToken)))) throw forbidden();
      const input = requestObject(request.body);
      const { identifier, password } = credentials(input, true);
      const workspaceName = name(input.workspaceName ?? (input.username === undefined ? undefined : 'SmartSell'));
      const displayName = name(input.name ?? (input.username === undefined ? undefined : identifier.username ?? identifier.email.split('@')[0].slice(0, 120)));
      const alreadyConfigured = () => new DomainError('already_configured', 'Setup has already completed', 409);
      if (await store.initialized()) throw alreadyConfigured();
      const passwordHash = await newPasswordHash(password, requirements.password_min_length);
      const token = opaque();
      const hash = digest(token).toString('hex');
      if (!await store.setup({ ...identifier, name: displayName, passwordHash, workspaceName }, hash, tokenHash(request))) {
        throw alreadyConfigured();
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
      const { identifier, password } = credentials(input);
      const { email } = identifier;
      if (!email) throw invalid('A valid email is required');
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
