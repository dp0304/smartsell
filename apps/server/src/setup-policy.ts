import type { FastifyRequest } from 'fastify';

export type SetupPolicy = { setupToken?: string; localSetupOrigins?: ReadonlySet<string> };

export function loopbackHost(host: string) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
}

export type LoginIdentifier = { email: string; username?: never } | { username: string; email?: never };

export function loginIdentifier(value: unknown, allowUsername: boolean): LoginIdentifier | undefined {
  if (typeof value !== 'string') return;
  const email = value.trim().toLowerCase();
  if (email.length <= 254 && !email.includes('\0') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { email };
  if (!allowUsername) return;
  const username = value.trim().normalize('NFKC').toLowerCase();
  if (username.length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u.test(username)) return { username };
}

export const LOCAL_SETUP_PASSWORD_MIN = 6;
export const DEFAULT_PASSWORD_MIN = 12;

function localSetupRequest(request: FastifyRequest, policy: SetupPolicy) {
  if (!policy.localSetupOrigins?.size) return false;
  const peer = request.raw.socket.remoteAddress;
  if (!peer || (!loopbackHost(peer) && peer !== '::ffff:127.0.0.1')) return false;
  const { host, origin, forwarded } = request.headers;
  if (!host || forwarded !== undefined || Object.keys(request.headers).some(name => name.startsWith('x-forwarded-')) ||
    request.headers['sec-fetch-site'] === 'cross-site') return false;
  const expected = `http://${host}`;
  if (!policy.localSetupOrigins.has(expected)) return false;
  return request.method === 'POST' ? origin === expected : origin === undefined || origin === expected;
}

export function setupRequirements(request: FastifyRequest, policy: SetupPolicy) {
  const local = localSetupRequest(request, policy);
  return {
    token_required: !local || !!policy.setupToken,
    password_min_length: local ? LOCAL_SETUP_PASSWORD_MIN : DEFAULT_PASSWORD_MIN,
  };
}

export function setupStatus(request: FastifyRequest, policy: SetupPolicy, initialized: boolean) {
  const requirements = setupRequirements(request, policy);
  return { data: { initialized, ...requirements, registration_enabled: !initialized && (!requirements.token_required || !!policy.setupToken) } };
}
