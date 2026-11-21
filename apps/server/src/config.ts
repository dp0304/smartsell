import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trafficHostConfig } from './integration/traffic-host.js';
import { loopbackHost } from './setup-policy.js';

const roles = ['api', 'mcp', 'worker', 'media', 'scheduler', 'ingress', 'public'] as const;
export type ProcessRole = typeof roles[number];
const root = fileURLToPath(new URL('../../../', import.meta.url));

export function configuration(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST ?? '127.0.0.1';
  const port = Number(env.PORT ?? 3401);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const selected = env.ROLE ?? 'all';
  const enabled = selected === 'all' ? roles : selected.split(',');
  if (enabled.some(role => !(roles as readonly string[]).includes(role))) throw new Error('Invalid ROLE');
  const databaseUrl = env.DATABASE_URL;
  const backgroundDatabaseUrl = env.BACKGROUND_DATABASE_URL || undefined;
  const publicUrl = new URL(env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`);
  if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.href !== `${publicUrl.origin}/` || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin');
  }
  const secret = env.APP_SECRET ?? randomBytes(32).toString('hex');
  const setupToken = env.SETUP_TOKEN || undefined;
  const identityDeployment = env.SMARTSELL_IDENTITY_DEPLOYMENT ?? 'private';
  const identityKey = env.IDENTITY_ENCRYPTION_KEY;
  if (identityDeployment !== 'private' && identityDeployment !== 'saas') throw new Error('Invalid SMARTSELL_IDENTITY_DEPLOYMENT');
  if (identityDeployment === 'saas' && publicUrl.protocol !== 'https:') throw new Error('SaaS identity requires HTTPS PUBLIC_ORIGIN');
  if (identityKey !== undefined && !/^[a-f0-9]{64}$/i.test(identityKey)) throw new Error('IDENTITY_ENCRYPTION_KEY must be a 32-byte hex key');
  if (production && (!databaseUrl || !env.PUBLIC_ORIGIN || publicUrl.protocol !== 'https:' ||
    !env.APP_SECRET || !/^[0-9a-f]{64}$/i.test(secret) || new Set(secret.toLowerCase()).size < 8 ||
    (setupToken !== undefined && (!/^[0-9a-f]{64}$/i.test(setupToken) || new Set(setupToken.toLowerCase()).size < 8 || setupToken === secret)))) {
    throw new Error('Production requires DATABASE_URL, HTTPS PUBLIC_ORIGIN, and a random 32-byte hex APP_SECRET. SETUP_TOKEN, if set, must be independently generated');
  }
  if (!databaseUrl && (!['127.0.0.1', 'localhost', '::1'].includes(host) || selected !== 'all')) {
    throw new Error('Development file storage requires a loopback HOST and ROLE=all');
  }
  const portalOrigin = env.PORTAL_ORIGIN;
  if (portalOrigin) {
    const url = new URL(portalOrigin);
    if (url.origin !== portalOrigin || !['http:', 'https:'].includes(url.protocol) ||
      (production && (url.protocol !== 'https:' || url.hostname === publicUrl.hostname))) throw new Error('Invalid isolated PORTAL_ORIGIN');
  }
  const portalCustomOrigins = new Map<string, string>();
  for (const origin of (env.PORTAL_CUSTOM_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
    const url = new URL(origin);
    if (!portalOrigin || url.origin !== origin || url.protocol !== 'https:' || url.hostname === publicUrl.hostname ||
      url.hostname === new URL(portalOrigin).hostname || [...portalCustomOrigins.keys()].some(host => new URL(`https://${host}`).hostname === url.hostname)) {
      throw new Error('PORTAL_CUSTOM_ORIGINS must contain distinct isolated HTTPS origins');
    }
    portalCustomOrigins.set(url.host, origin);
  }
  const portalAssertionKey = env.PORTAL_ASSERTION_KEY;
  if (portalAssertionKey && (!/^[a-f0-9]{64}$/i.test(portalAssertionKey) || portalAssertionKey === secret || (production && !portalOrigin))) {
    throw new Error('Invalid PORTAL_ASSERTION_KEY');
  }
  const origins = new Set([publicUrl.origin]);
  if (!production) {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      for (const localPort of [port, 5173, 4173]) origins.add(`http://${hostname}:${localPort}`);
    }
    for (const origin of (env.DEV_ORIGINS ?? '').split(',').filter(Boolean)) origins.add(new URL(origin).origin);
  }
  const privateLoopback = !production && identityDeployment === 'private' && loopbackHost(host) &&
    publicUrl.protocol === 'http:' && loopbackHost(publicUrl.hostname);
  const localSetupOrigins = privateLoopback && env.SMARTSELL_LOCAL_SETUP === '1' ? new Set([publicUrl.origin]) : undefined;
  return {
    production, port, host, databaseUrl, backgroundDatabaseUrl, setupToken, secret, generatedSecret: !env.APP_SECRET, portalOrigin, portalCustomOrigins, portalAssertionKey, origins, origin: publicUrl.origin, identityDeployment: identityDeployment as 'private' | 'saas', identityKey,
    localSetupOrigins,
    statePath: resolve(env.SMARTSELL_DATA_FILE ?? resolve(root, '.local/smartsell.sqlite')),
    kernelStatePath: resolve(env.SMARTSELL_DATA_FILE ?? resolve(root, '.local/smartsell.json')),
    secureCookie: publicUrl.protocol === 'https:',
    roles: new Set(enabled as readonly ProcessRole[]),
    allowLoopbackWebhook: !production && env.SMARTSELL_WEBHOOK_LOOPBACK === '1',
    traffic: trafficHostConfig(env, [publicUrl.origin, ...(portalOrigin ? [portalOrigin] : [])]),
  };
}

export type Config = ReturnType<typeof configuration>;
