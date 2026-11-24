import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HeartbeatV2Response, Row } from '@smartsell/contracts';
import { workerDownloadUrl, workerReleases, type WorkerRelease } from '../../worker-downloads.js';
import { sha256, workerHost } from './model.js';

/**
 * Values the heartbeat carries that come from files (latest_worker §8.18, driver_config §8.11). Files are read outside every
 * store transaction (§0 rule 8): the device gateway refreshes this cache before it opens the transaction.
 */
const REFRESH_MS = 30_000;
let releases: WorkerRelease[] = [];
let driver: { version: string; sha256: string; bytes: Buffer; mtimeMs: number } | null = null;
let refreshedAt = 0;
let refreshing: Promise<void> | undefined;

export const DRIVER_CONFIG_FILE = 'selectors.json';

async function loadDriverConfig(directory: string | undefined) {
  if (!directory) { driver = null; return; }
  const path = join(directory, DRIVER_CONFIG_FILE);
  try {
    const info = await stat(path);
    if (driver && driver.mtimeMs === info.mtimeMs && driver.bytes.length === info.size) return;
    const bytes = await readFile(path);
    const parsed = JSON.parse(bytes.toString('utf8')) as { version?: unknown };
    if (typeof parsed?.version !== 'string' || !parsed.version) { driver = null; return; }
    driver = { version: parsed.version, sha256: sha256(bytes), bytes, mtimeMs: info.mtimeMs };
  } catch { driver = null; }
}

/** Re-reads the release manifests and the selector file at most every 30 s. Never throws. */
export function refreshHostCaches(force = false): Promise<void> {
  if (!force && Date.now() - refreshedAt < REFRESH_MS) return refreshing ?? Promise.resolve();
  refreshing ??= (async () => {
    const host = workerHost();
    try { releases = await workerReleases(host.workerDownloadDirectory); } catch { releases = []; }
    await loadDriverConfig(host.driverConfigDirectory);
    refreshedAt = Date.now();
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}

/** E9: the download platform for a machine; the heartbeat's `arch` wins over the stored one, macOS defaults to arm64. */
export function workerPlatformFor(device: Row, arch?: 'arm64' | 'x64'): 'mac-arm64' | 'mac-x64' | 'win-x64' {
  if (device.platform === 'win32') return 'win-x64';
  const cpu = arch ?? (device.arch === 'x64' || device.arch === 'arm64' ? device.arch : 'arm64');
  return cpu === 'x64' ? 'mac-x64' : 'mac-arm64';
}

export function hostCaches() {
  return {
    /**
     * The release a machine should run (E9): Windows → win-x64; macOS → the package of the CPU the heartbeat reported
     * (`arch`, or the last one stored on the machine), arm64 when it never reported one. Only that package is offered:
     * the Worker App ignores an offer for another package, so a fallback to the other CPU would never update anything.
     */
    latestWorker(device: Row, arch?: 'arm64' | 'x64'): HeartbeatV2Response['latest_worker'] {
      const platform = workerPlatformFor(device, arch);
      const release = releases.find(item => item.platform === platform);
      return release ? { version: release.version, platform: release.platform, url: workerDownloadUrl(release.platform), sha256: release.sha256 } : null;
    },
    driverConfig(): HeartbeatV2Response['driver_config'] {
      return driver ? { version: driver.version, sha256: driver.sha256 } : null;
    },
    /** The exact bytes whose hash the heartbeat advertised, or undefined when no selector file is installed. */
    driverConfigBytes(): Buffer | undefined { return driver?.bytes; },
  };
}

const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/**
 * The Worker's bundled dry-run clip, so a dry-run job names it (§8.12, S9 ledger 3): `resources/test-clip.json` gives the
 * hash, size and probe values; without it the clip itself is hashed. Optional: a hub without the App sources sends zeros.
 */
export async function readBundledClip(resources = new URL('../../../../connector-desktop/resources/', import.meta.url)) {
  try {
    const manifest = JSON.parse(await readFile(fileURLToPath(new URL('test-clip.json', resources)), 'utf8')) as Record<string, unknown>;
    if (typeof manifest.sha256 === 'string' && /^[0-9a-f]{64}$/.test(manifest.sha256) && positive(manifest.bytes)) {
      return { sha256: manifest.sha256, bytes: positive(manifest.bytes)!, width: positive(manifest.width), height: positive(manifest.height),
        duration_ms: positive(manifest.duration_ms) };
    }
  } catch { /* fall back to hashing the clip */ }
  try {
    const bytes = await readFile(fileURLToPath(new URL('test-clip.mp4', resources)));
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  } catch { return undefined; }
}
