import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { availableWorkerDownloads, compareWorkerVersions, workerReleases, type WorkerPlatform } from '../worker-downloads.js';
import type { TailscaleSnapshot } from './tailscale.js';

export const HUB_INFO_ROUTE = '/api/v1/hub/info';

/** Response of `GET /api/v1/hub/info` (§2.7). Read by the setup wizard (S7). */
export interface HubInfo {
  mode: 'hub' | 'dev' | 'production';
  public_origin: string;
  version: string;
  request_origin_ok: boolean;
  /**
   * `funnel_on` (E46, SEC-3): true when Tailscale Funnel exposes the hub to the internet, false when the last check saw no
   * Funnel, null before the first check. `funnel_warning` is the owner sentence with the command that turns it off.
   */
  tailscale: { serve_ok: boolean | null; key_expiry: string | null; checked_at: string | null; funnel_on: boolean | null; funnel_warning: string | null };
  latest_worker: { version: string; platforms: WorkerPlatform[] } | null;
  worker_downloads: { platform: WorkerPlatform; url: string; version: string | null; sha256: string | null }[];
}

export function hubVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

/** Whether this request's Origin (or Host, for same-origin GETs without Origin) is PUBLIC_ORIGIN. */
export function requestOriginOk(request: FastifyRequest, publicOrigin: string) {
  const origin = request.headers.origin;
  if (typeof origin === 'string') return origin === publicOrigin;
  const host = request.headers.host;
  return typeof host === 'string' && host.toLowerCase() === new URL(publicOrigin).host;
}

export async function latestWorker(directory: string | undefined): Promise<HubInfo['latest_worker']> {
  const releases = await workerReleases(directory);
  if (!releases.length) return null;
  const version = releases.map(release => release.version).sort(compareWorkerVersions).at(-1)!;
  return { version, platforms: releases.filter(release => release.version === version).map(release => release.platform) };
}

export function registerHubInfo(app: FastifyInstance, deps: {
  config: { mode: HubInfo['mode']; origin: string; workerDownloadDirectory: string | undefined };
  requireSession(request: FastifyRequest): Promise<unknown>;
  /** `refresh` lets the first request after startup wait (up to 5 s) for the first check instead of reporting null. */
  tailscale: { snapshot(): TailscaleSnapshot; refresh?(): Promise<TailscaleSnapshot> };
  version?: string;
}) {
  const version = deps.version ?? hubVersion();
  // Read-only: no CSRF; unauthenticated requests get 401 from requireSession (§2.12).
  app.get(HUB_INFO_ROUTE, async request => {
    await deps.requireSession(request);
    const directory = deps.config.workerDownloadDirectory;
    if (deps.tailscale.snapshot().checked_at === null && deps.tailscale.refresh) {
      await Promise.race([deps.tailscale.refresh(), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    }
    const { serve_ok, key_expiry, checked_at, funnel_on, funnel_warning } = deps.tailscale.snapshot();
    const [latest, downloads] = await Promise.all([latestWorker(directory), availableWorkerDownloads(directory)]);
    const info: HubInfo = {
      mode: deps.config.mode, public_origin: deps.config.origin, version,
      request_origin_ok: requestOriginOk(request, deps.config.origin),
      tailscale: { serve_ok, key_expiry, checked_at, funnel_on: funnel_on === true ? true : checked_at === null ? null : false,
        funnel_warning: funnel_on === true ? funnel_warning ?? null : null },
      latest_worker: latest,
      worker_downloads: downloads.map(({ platform, url, version: itemVersion, sha256 }) => ({ platform, url, version: itemVersion, sha256 })),
    };
    // Top-level fields as in §2.7, mirrored under `data` like the session endpoint for SDK callers.
    return { ...info, data: info };
  });
}
