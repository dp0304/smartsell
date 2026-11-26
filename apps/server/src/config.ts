import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trafficHostConfig } from './integration/traffic-host.js';
import { productionSemantics } from './production.js';
import { loopbackHost } from './setup-policy.js';

const roles = ['api', 'mcp', 'worker', 'media', 'scheduler', 'ingress', 'public'] as const;
export type ProcessRole = typeof roles[number];
export type HubMode = 'dev' | 'hub' | 'production';
const root = fileURLToPath(new URL('../../../', import.meta.url));

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
export const HUB_DEFAULT_PORT = 3401;
export const HUB_MAX_UPLOAD_LIMIT = 4 * GiB;

/** Raised for hub-mode configuration problems; `message` is owner-facing zh-Hant copy with the next step. */
export class HubConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HubConfigError';
  }
}

/** Per-user data directory of the hub (§2.3). */
export function defaultHubDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'SmartSell Hub');
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'SmartSell Hub');
  return join(home, '.local', 'share', 'smartsell-hub');
}

export type TestTiming = { offlineStalenessSec?: number; readbackScheduleSec?: number[]; unreportedGraceSec?: number; prepareLeadSec?: number };

const positiveSeconds = (name: string, value: string | undefined) => {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 86_400) throw new Error(`${name} must be a whole number of seconds between 1 and 86400`);
  return number;
};

/** Shortened schedules for E2E only (§2.3, §10.2). Other modules read these from config, never from env. */
function testTiming(env: NodeJS.ProcessEnv): TestTiming | undefined {
  if (env.NODE_ENV !== 'test') return undefined;
  const readback = env.SMARTSELL_TEST_READBACK_SCHEDULE_SEC;
  const timing: TestTiming = {
    offlineStalenessSec: positiveSeconds('SMARTSELL_TEST_OFFLINE_STALENESS_SEC', env.SMARTSELL_TEST_OFFLINE_STALENESS_SEC),
    readbackScheduleSec: readback === undefined || readback === '' ? undefined
      : readback.split(',').map(item => positiveSeconds('SMARTSELL_TEST_READBACK_SCHEDULE_SEC', item.trim()) as number),
    unreportedGraceSec: positiveSeconds('SMARTSELL_TEST_UNREPORTED_GRACE_SEC', env.SMARTSELL_TEST_UNREPORTED_GRACE_SEC),
    prepareLeadSec: positiveSeconds('SMARTSELL_TEST_PREPARE_LEAD_SEC', env.SMARTSELL_TEST_PREPARE_LEAD_SEC),
  };
  if (timing.readbackScheduleSec?.some(value => value === undefined)) throw new Error('SMARTSELL_TEST_READBACK_SCHEDULE_SEC must list whole seconds');
  for (const key of Object.keys(timing) as (keyof TestTiming)[]) if (timing[key] === undefined) delete timing[key];
  return Object.keys(timing).length ? timing : undefined;
}

/**
 * Development switches whose modules read NODE_ENV directly instead of config.production. A hub refuses them so that
 * a hub started with NODE_ENV=test (E2E) still never takes those development branches (§2.2 audit, hub.test.ts).
 */
export const HUB_FORBIDDEN_SWITCHES: readonly (readonly [string, string])[] = [
  ['SMARTSELL_WEBHOOK_LOOPBACK', '1'],       // integration/customer-egress.ts
  ['SMARTSELL_AGENT_MODEL_LOOPBACK', '1'],   // integration/agent-model-runtime.ts
  ['SMARTSELL_LOCAL_SETUP', '1'],            // config.ts localSetupOrigins (already off because production is true)
  ['SMARTSELL_OPERATION_API', '0'],          // bootstrap.ts: a hub always mounts the Operation API
];

const randomHex = (value: string | undefined) => !!value && /^[0-9a-f]{64}$/i.test(value) && new Set(value.toLowerCase()).size >= 8;

function maxUploadBytes(env: NodeJS.ProcessEnv, hub: boolean) {
  const raw = env.SMARTSELL_MAX_UPLOAD_BYTES;
  if (raw === undefined || raw === '') return hub ? 2 * GiB : 512 * MiB;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MiB || value > HUB_MAX_UPLOAD_LIMIT) {
    throw new Error('SMARTSELL_MAX_UPLOAD_BYTES must be a whole number of bytes between 1 MiB and 4 GiB');
  }
  return value;
}

/** Optional byte-count setting (S4): a whole number of bytes between `min` and `max`, or the default when unset. */
function byteSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number of bytes between ${min} and ${max}`);
  return value;
}

/** Hub-mode validation (§2.3). Messages are owner-facing; they are printed and written to status.json. */
function validateHub(env: NodeJS.ProcessEnv, publicUrl: URL, host: string, selected: string, secret: string, setupToken: string | undefined) {
  const testHttp = env.NODE_ENV === 'test' && env.SMARTSELL_HUB_TEST_HTTP === '1';
  if (!env.PUBLIC_ORIGIN) {
    throw new HubConfigError('HUB_PUBLIC_ORIGIN_MISSING', '中樞設定錯誤：缺少 PUBLIC_ORIGIN。請執行 pnpm hub:init，它會從 Tailscale 讀出 https://<機器>.<tailnet>.ts.net 並寫入 hub.env。');
  }
  const testOrigin = testHttp && publicUrl.protocol === 'http:' && publicUrl.hostname === '127.0.0.1' && !!publicUrl.port;
  if (!testOrigin) {
    if (publicUrl.protocol !== 'https:') {
      throw new HubConfigError('HUB_PUBLIC_ORIGIN_NOT_HTTPS', `中樞設定錯誤：PUBLIC_ORIGIN 必須是 https 網址（目前是 ${publicUrl.origin}）。請重跑 pnpm hub:init。`);
    }
    if (!publicUrl.hostname.endsWith('.ts.net') && env.SMARTSELL_HUB_ANY_ORIGIN !== '1') {
      throw new HubConfigError('HUB_PUBLIC_ORIGIN_NOT_TAILNET', `中樞設定錯誤：PUBLIC_ORIGIN 必須是 Tailscale 的 .ts.net 網址（目前是 ${publicUrl.hostname}）。若使用自己的網域，請在 hub.env 以外另設 SMARTSELL_HUB_ANY_ORIGIN=1。`);
    }
  }
  if (!loopbackHost(host)) {
    throw new HubConfigError('HUB_HOST_NOT_LOOPBACK', `中樞設定錯誤：HOST 必須是 127.0.0.1（目前是 ${host}）。對外連線一律經由 tailscale serve，請移除 HOST 設定。`);
  }
  if (selected !== 'all') throw new HubConfigError('HUB_ROLE_NOT_ALL', '中樞設定錯誤：中樞只能以 ROLE=all 執行，請移除 ROLE 設定。');
  if (env.DATABASE_URL) throw new HubConfigError('HUB_DATABASE_URL_SET', '中樞設定錯誤：中樞使用本機 SQLite，不能設定 DATABASE_URL，請移除它。');
  if (env.SMARTSELL_STORE && env.SMARTSELL_STORE !== 'local') {
    throw new HubConfigError('HUB_STORE_NOT_LOCAL', '中樞設定錯誤：中樞只能使用本機 SQLite（SMARTSELL_STORE=local），請移除 SMARTSELL_STORE 設定。');
  }
  if (!env.APP_SECRET || !randomHex(secret)) {
    throw new HubConfigError('HUB_APP_SECRET_INVALID', '中樞設定錯誤：APP_SECRET 必須是 64 位的隨機十六進位字串。請執行 pnpm hub:init 產生（已存在的值不會被覆蓋）。');
  }
  if (setupToken !== undefined && (!randomHex(setupToken) || setupToken.toLowerCase() === secret.toLowerCase())) {
    throw new HubConfigError('HUB_SETUP_TOKEN_INVALID', '中樞設定錯誤：SETUP_TOKEN 必須是另外產生的 64 位隨機十六進位字串。請刪除 hub.env 中的 SETUP_TOKEN 後重跑 pnpm hub:init。');
  }
  // Development-only switches read NODE_ENV directly in their modules; a hub never honours them (hub.test.ts audit).
  for (const [name, value] of HUB_FORBIDDEN_SWITCHES) {
    if (env[name] === value) throw new HubConfigError('HUB_DEV_SWITCH_SET', `中樞設定錯誤：${name}=${value} 是開發用的開關，中樞不能使用，請移除它。`);
  }
}

export function configuration(env: NodeJS.ProcessEnv = process.env) {
  if (env.SMARTSELL_MODE !== undefined && env.SMARTSELL_MODE !== '' && env.SMARTSELL_MODE !== 'hub') throw new Error('SMARTSELL_MODE must be hub or unset');
  const hub = env.SMARTSELL_MODE === 'hub';
  const mode: HubMode = hub ? 'hub' : env.NODE_ENV === 'production' ? 'production' : 'dev';
  // A hub always runs with production semantics, even when E2E starts it with NODE_ENV=test (§2.2).
  const production = productionSemantics(env);
  const host = env.HOST ?? '127.0.0.1';
  const port = Number(env.PORT ?? HUB_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const selected = env.ROLE ?? 'all';
  const enabled = selected === 'all' ? roles : selected.split(',');
  if (enabled.some(role => !(roles as readonly string[]).includes(role))) throw new Error('Invalid ROLE');
  const databaseUrl = env.DATABASE_URL;
  const backgroundDatabaseUrl = env.BACKGROUND_DATABASE_URL || undefined;
  let publicUrl: URL;
  try { publicUrl = new URL(env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`); }
  catch { throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin'); }
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
  if (hub) validateHub(env, publicUrl, host, selected, secret, setupToken);
  else if (mode === 'production' && (!databaseUrl || !env.PUBLIC_ORIGIN || publicUrl.protocol !== 'https:' ||
    !env.APP_SECRET || !randomHex(secret) ||
    (setupToken !== undefined && (!randomHex(setupToken) || setupToken === secret)))) {
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
  // Production and hub accept only PUBLIC_ORIGIN; development adds the local Web ports and DEV_ORIGINS.
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
  const hubDirectory = hub ? resolve(env.SMARTSELL_HUB_DIR || defaultHubDir()) : undefined;
  const uploadLimit = maxUploadBytes(env, hub);
  const statePath = resolve(env.SMARTSELL_DATA_FILE ?? (hubDirectory ? join(hubDirectory, 'smartsell.sqlite') : resolve(root, '.local/smartsell.sqlite')));
  return {
    mode, hub,
    production, port, host, databaseUrl, backgroundDatabaseUrl, setupToken, secret, generatedSecret: !env.APP_SECRET, portalOrigin, portalCustomOrigins, portalAssertionKey, origins, origin: publicUrl.origin, identityDeployment: identityDeployment as 'private' | 'saas', identityKey,
    localSetupOrigins,
    hubDirectory,
    workerDownloadDirectory: env.SMARTSELL_WORKER_DOWNLOAD_DIR ? resolve(env.SMARTSELL_WORKER_DOWNLOAD_DIR)
      : hubDirectory ? join(hubDirectory, 'worker-downloads')
      : privateLoopback ? resolve(root, '.local/worker-downloads') : undefined,
    /** Selector data served to Workers by `GET /api/v1/device/driver-config` and placed by `pnpm hub:update` (§8.11, §2.13). */
    driverConfigDirectory: hubDirectory ? join(hubDirectory, 'driver-config') : undefined,
    statePath,
    kernelStatePath: resolve(env.SMARTSELL_DATA_FILE ?? (hubDirectory ? join(hubDirectory, 'smartsell.json') : resolve(root, '.local/smartsell.json'))),
    /** Media follows the data file in every mode, independent of the working directory (§6.7). */
    mediaDirectory: resolve(env.MEDIA_DIRECTORY ?? join(dirname(statePath), 'media')),
    maxUploadBytes: uploadLimit,
    /**
     * Agent uploads (§6.4, S4): the declared bytes of one workspace's unfinished uploads may not exceed this, and the hub
     * stops taking new uploads and parts while the media disk has less than `uploadMinFreeBytes` left after them.
     */
    uploadStagingQuotaBytes: byteSetting(env, 'SMARTSELL_UPLOAD_STAGING_QUOTA_BYTES', 4 * uploadLimit, uploadLimit, 1024 * GiB),
    uploadMinFreeBytes: byteSetting(env, 'SMARTSELL_UPLOAD_MIN_FREE_BYTES', GiB, 0, 1024 * GiB),
    webDistDirectory: hub ? resolve(env.SMARTSELL_WEB_DIST ?? resolve(root, 'apps/web/dist')) : undefined,
    // Hub: trust only the loopback hop (`tailscale serve`), so request.ip is the tailnet client serve put last in
    // X-Forwarded-For; a tailnet peer cannot spoof it. A process on the hub machine connecting to 127.0.0.1 directly can
    // claim any address, so per-address limits are a courtesy there; auth.ts also limits failures per sign-in name (SEC-2).
    trustProxy: (hub ? '127.0.0.1' : false) as string | false,
    // Hub: 15 minutes, so media_upload's one-PUT direct upload (E47) of a large video can finish; headers still time out at
    // Node's 60 s default, and the hub is reachable only on the tailnet.
    requestTimeoutMs: hub ? 900_000 : 30_000,
    testTiming: testTiming(env),
    secureCookie: publicUrl.protocol === 'https:',
    roles: new Set(enabled as readonly ProcessRole[]),
    allowLoopbackWebhook: !production && env.SMARTSELL_WEBHOOK_LOOPBACK === '1',
    // traffic-host.ts reads NODE_ENV itself; a hub always validates traffic origins with production rules.
    traffic: trafficHostConfig(hub ? { ...env, NODE_ENV: 'production' } : env, [publicUrl.origin, ...(portalOrigin ? [portalOrigin] : [])]),
  };
}

export type Config = ReturnType<typeof configuration>;
