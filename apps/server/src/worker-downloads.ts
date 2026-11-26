import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const route = '/api/v1/worker-downloads';
export const WORKER_PLATFORMS = ['mac-arm64', 'mac-x64', 'win-x64'] as const;
export type WorkerPlatform = typeof WORKER_PLATFORMS[number];
/** Fixed package names in SMARTSELL_WORKER_DOWNLOAD_DIR, used when no `latest-<platform>.json` (`pnpm worker:release`) exists. */
const legacyPackages: Record<WorkerPlatform, string> = {
  'mac-arm64': 'SmartSell-Worker-mac-arm64.zip',
  'mac-x64': 'SmartSell-Worker-mac-x64.zip',
  'win-x64': 'SmartSell-Worker-win-x64.exe',
};
const mimeTypes: Record<string, string> = {
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/octet-stream',
};

/**
 * `latest-<platform>.json` written by `pnpm worker:release` (§8.18). `signature` (security review S1) is the base64 Ed25519
 * release signature over {platform, sha256, version}; the hub only checks its shape and passes it through to the Worker,
 * which verifies it with the public key built into the App. Manifests from before S1 have none.
 */
export interface WorkerRelease {
  version: string; platform: WorkerPlatform; file: string; sha256: string; bytes: number; built_at: string; signature?: string;
}
export type WorkerReleaseInspection =
  | { status: 'ok'; release: WorkerRelease }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

export const isWorkerPlatform = (value: string): value is WorkerPlatform => (WORKER_PLATFORMS as readonly string[]).includes(value);
/** Signed device action for a Worker downloading its own update (Appendix B.2). */
export const workerDownloadAction = (platform: WorkerPlatform) => `worker_download.read:${platform}`;
export const workerDownloadUrl = (platform: WorkerPlatform) => `${route}/${platform}`;

const versionPattern = /^(\d{1,5})\.(\d{1,5})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/;
const packageFile = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;
/** An Ed25519 signature (64 bytes) in standard base64. */
const releaseSignature = /^[A-Za-z0-9+/]{86}==$/;

/** Orders `major.minor.patch[-pre]`; a pre-release sorts before its release. */
export function compareWorkerVersions(a: string, b: string) {
  const left = versionPattern.exec(a);
  const right = versionPattern.exec(b);
  if (!left || !right) return a.localeCompare(b);
  for (let index = 1; index <= 3; index++) {
    const delta = Number(left[index]) - Number(right[index]);
    if (delta) return delta;
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  return left[4].localeCompare(right[4]);
}

export async function inspectWorkerRelease(directory: string | undefined, platform: WorkerPlatform): Promise<WorkerReleaseInspection> {
  if (!directory) return { status: 'missing' };
  let text: string;
  try {
    const file = await open(join(directory, `latest-${platform}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024) return { status: 'invalid', reason: 'not a regular file under 64 KiB' };
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (['ENOENT', 'ENOTDIR'].includes(code)) return { status: 'missing' };
    if (['ELOOP', 'EACCES', 'EPERM'].includes(code)) return { status: 'invalid', reason: `unreadable (${code})` };
    throw error;
  }
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { return { status: 'invalid', reason: 'not JSON' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid', reason: 'not a JSON object' };
  const { version, file, sha256, bytes, built_at: builtAt, signature } = value;
  if (value.platform !== platform) return { status: 'invalid', reason: `platform is not ${platform}` };
  if (typeof version !== 'string' || !versionPattern.test(version)) return { status: 'invalid', reason: 'version is not major.minor.patch' };
  if (typeof file !== 'string' || !packageFile.test(file) || file.includes('..') || !mimeTypes[extname(file).toLowerCase()]) {
    return { status: 'invalid', reason: 'file must be a .zip, .dmg or .exe name in the same directory' };
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return { status: 'invalid', reason: 'sha256 must be 64 lowercase hex digits' };
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) return { status: 'invalid', reason: 'bytes must be a positive integer' };
  if (typeof builtAt !== 'string' || Number.isNaN(Date.parse(builtAt))) return { status: 'invalid', reason: 'built_at must be an ISO time' };
  if (signature !== undefined && (typeof signature !== 'string' || !releaseSignature.test(signature))) {
    return { status: 'invalid', reason: 'signature must be a base64 Ed25519 signature' };
  }
  return { status: 'ok', release: { version, platform, file, sha256, bytes, built_at: builtAt, ...(signature !== undefined && { signature }) } };
}

export async function workerReleases(directory: string | undefined) {
  const found = await Promise.all(WORKER_PLATFORMS.map(platform => inspectWorkerRelease(directory, platform)));
  return found.flatMap(item => item.status === 'ok' ? [item.release] : []);
}

async function openPackage(directory: string | undefined, filename: string) {
  if (!directory) return;
  const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code ?? '')) throw error;
    });
  if (!file) return;
  try {
    const stat = await file.stat();
    if (stat.isFile() && stat.size > 0) return { file, size: stat.size };
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
}

/** The package a platform serves: the release named by `latest-<platform>.json`, else the development package. */
async function packageFor(directory: string | undefined, platform: WorkerPlatform) {
  const inspected = await inspectWorkerRelease(directory, platform);
  const release = inspected.status === 'ok' ? inspected.release : undefined;
  const filename = release?.file ?? legacyPackages[platform];
  const opened = await openPackage(directory, filename);
  if (!opened) return;
  if (release && opened.size !== release.bytes) {
    // A copy in progress or a stale manifest; never serve bytes that do not match the advertised release.
    await opened.file.close();
    return { incomplete: true as const };
  }
  return { ...opened, filename, release, type: mimeTypes[extname(filename).toLowerCase()] ?? 'application/octet-stream' };
}

export interface WorkerDownloadItem {
  platform: WorkerPlatform; filename: string; url: string; version: string | null; sha256: string | null; bytes: number;
}

export async function availableWorkerDownloads(directory: string | undefined): Promise<WorkerDownloadItem[]> {
  const available = await Promise.all(WORKER_PLATFORMS.map(async platform => {
    const pkg = await packageFor(directory, platform);
    if (!pkg || 'incomplete' in pkg) return;
    await pkg.file.close();
    return { platform, filename: pkg.filename, url: workerDownloadUrl(platform), version: pkg.release?.version ?? null,
      sha256: pkg.release?.sha256 ?? null, bytes: pkg.size };
  }));
  return available.filter(item => item !== undefined);
}

/**
 * Verifies a device-signed request (headers `x-smartsell-device`, `-timestamp`, `-nonce`, `-signature`, `-workspace`;
 * empty body) for `action`, throwing the protocol's Problem on failure. Provided by the device stream (S3).
 */
export type WorkerDownloadDeviceAuth = (request: FastifyRequest, action: string) => Promise<unknown>;
const deviceAuthenticators = new WeakMap<FastifyInstance, WorkerDownloadDeviceAuth>();

/** Lets Workers download their own updates with a device signature (§8.18). Call with the root app. */
export function provideWorkerDownloadDeviceAuth(app: FastifyInstance, authenticate: WorkerDownloadDeviceAuth) {
  deviceAuthenticators.set(app, authenticate);
}

export function registerWorkerDownloads(app: FastifyInstance, directory: string | undefined,
  requireSession: (request: FastifyRequest) => Promise<unknown>) {
  app.get(route, async request => {
    await requireSession(request);
    return { data: await availableWorkerDownloads(directory) };
  });
  app.get<{ Params: { platform: string } }>(`${route}/:platform`, async (request, reply) => {
    const platform = request.params.platform;
    if (request.headers['x-smartsell-device'] !== undefined) {
      const authenticate = deviceAuthenticators.get(app);
      if (!authenticate) {
        return reply.code(503).send({ error: { code: 'DEVICE_AUTH_UNAVAILABLE', message: 'Signed Worker downloads are not available on this server' } });
      }
      if (!isWorkerPlatform(platform)) return reply.callNotFound();
      await authenticate(request, workerDownloadAction(platform));
    } else {
      await requireSession(request);
    }
    const pkg = isWorkerPlatform(platform) ? await packageFor(directory, platform) : undefined;
    if (!pkg) return reply.callNotFound();
    if ('incomplete' in pkg) {
      return reply.code(503).header('retry-after', '30')
        .send({ error: { code: 'WORKER_PACKAGE_INCOMPLETE', message: 'The Worker package does not match latest.json yet' } });
    }
    reply.type(pkg.type)
      .header('content-disposition', `attachment; filename="${pkg.filename}"`)
      .header('content-length', pkg.size);
    if (pkg.release) reply.header('x-smartsell-sha256', pkg.release.sha256).header('x-smartsell-version', pkg.release.version);
    if (pkg.release?.signature) reply.header('x-smartsell-release-signature', pkg.release.signature);
    return reply.send(pkg.file.createReadStream());
  });
}
