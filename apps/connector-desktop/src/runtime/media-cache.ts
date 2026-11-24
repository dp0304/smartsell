// Worker side of the signed media download (§6.6): resumable download into
// <userData>/media-cache/<sha256>.part, SHA-256 check, one re-fetch on
// mismatch, rename to <sha256> (0600), shared by hash, LRU at 20 GB and kept
// for 7 days after the last job that used it ended.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ClaimedJob, JobMedia } from './contracts.ts';
import { writeAtomic } from './job-store.ts';
import { HubError } from './protocol.ts';

export class MediaHashMismatch extends Error {
  constructor(readonly sha256: string) { super(`Downloaded media does not match ${sha256}`); this.name = 'MediaHashMismatch'; }
}
export class MediaUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'MediaUnavailable'; }
}

export type MediaOpener = (fileId: string, jobId: string, fence: number, options: { start?: number; etag?: string; signal?: AbortSignal }) => Promise<Response>;

interface IndexEntry { bytes: number; last_used: number; jobs: string[]; released_at: number | null }

export interface MediaCacheOptions {
  dir: string;
  open: MediaOpener;
  now?: () => number;
  maxBytes?: number;
  retainMs?: number;
  /** Path of the bundled dry-run clip (resources/test-clip.mp4, provided by S9). */
  bundledClip?: string | null;
}

export async function sha256File(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export class MediaCache {
  readonly dir: string;
  readonly #open: MediaOpener;
  readonly #now: () => number;
  readonly #maxBytes: number;
  readonly #retainMs: number;
  #index: Record<string, IndexEntry>;
  #inflight = new Map<string, Promise<string>>();

  constructor(private readonly options: MediaCacheOptions) {
    this.dir = options.dir;
    this.#open = options.open;
    this.#now = options.now ?? Date.now;
    this.#maxBytes = options.maxBytes ?? 20 * 1024 ** 3;
    this.#retainMs = options.retainMs ?? 7 * 24 * 3600_000;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { this.#index = JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')) as Record<string, IndexEntry>; }
    catch { this.#index = {}; }
  }

  #saveIndex() { writeAtomic(join(this.dir, 'index.json'), JSON.stringify(this.#index)); }

  pathFor(sha256: string) { return join(this.dir, sha256); }

  /** Local paths for every media item of the job, downloading what is missing. */
  async ensureAll(job: ClaimedJob, signal?: AbortSignal): Promise<Record<string, string>> {
    const payload = job.payload;
    if (!('media' in payload)) return {};
    const paths: Record<string, string> = {};
    for (const media of payload.media) {
      const key = media.file_id ?? media.bundled ?? media.sha256;
      paths[key] = await this.ensure(job, media, signal);
    }
    return paths;
  }

  async ensure(job: ClaimedJob, media: JobMedia, signal?: AbortSignal): Promise<string> {
    if (media.bundled) {
      const clip = this.options.bundledClip;
      // Never fake success: without the bundled clip the dry run cannot proceed.
      if (!clip || !existsSync(clip)) throw new MediaUnavailable('內建的試跑影片不存在（resources/test-clip.mp4）。');
      return clip;
    }
    if (!media.file_id) throw new MediaUnavailable('這則的媒體還沒有準備好。');
    if (!/^[0-9a-f]{64}$/.test(media.sha256)) throw new MediaUnavailable('媒體的 SHA-256 格式不正確。');
    const existing = this.#inflight.get(media.sha256);
    if (existing) { const path = await existing; this.#use(media.sha256, job.job_id); return path; }
    const work = this.#download(job, media, signal).finally(() => this.#inflight.delete(media.sha256));
    this.#inflight.set(media.sha256, work);
    const path = await work;
    this.#use(media.sha256, job.job_id);
    await this.#evict(media.sha256);
    return path;
  }

  #use(sha256: string, jobId: string) {
    const entry = this.#index[sha256] ??= { bytes: statSync(this.pathFor(sha256)).size, last_used: 0, jobs: [], released_at: null };
    entry.last_used = this.#now();
    if (!entry.jobs.includes(jobId)) entry.jobs.push(jobId);
    entry.released_at = null;
    this.#saveIndex();
  }

  async #download(job: ClaimedJob, media: JobMedia, signal?: AbortSignal): Promise<string> {
    const final = this.pathFor(media.sha256);
    if (existsSync(final) && statSync(final).size === media.bytes) return final;
    for (let attempt = 0; attempt < 2; attempt++) {
      const part = `${final}.part`;
      await this.#fetchInto(job, media, part, signal);
      const actual = await sha256File(part);
      if (actual === media.sha256) {
        chmodSync(part, 0o600);
        renameSync(part, final);
        return final;
      }
      // §6.6 step 2: delete and fetch once more from the start.
      rmSync(part, { force: true });
    }
    throw new MediaHashMismatch(media.sha256);
  }

  async #fetchInto(job: ClaimedJob, media: JobMedia, part: string, signal?: AbortSignal) {
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have > media.bytes) { rmSync(part, { force: true }); have = 0; }
    if (have === media.bytes && have > 0) return;
    const response = await this.#open(media.file_id!, job.job_id, job.fencing_token, { start: have, etag: `"${media.sha256}"`, signal });
    const resumed = response.status === 206 && have > 0;
    if (!resumed) have = 0;
    if (!response.body) throw new HubError('network', 'Empty media response');
    const out = createWriteStream(part, { flags: resumed ? 'a' : 'w', mode: 0o600 });
    // The stream is never held inside a hub transaction (§0 rule 8); interruptions keep .part for a Range resume.
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), out, { signal });
    const size = statSync(part).size;
    if (size < media.bytes) throw new HubError('network', 'Media download ended early');
  }

  /** Marks the job as finished with its media; files stay for retainMs and are then eligible for removal. */
  release(jobId: string) {
    let changed = false;
    for (const entry of Object.values(this.#index)) {
      if (!entry.jobs.includes(jobId)) continue;
      entry.jobs = entry.jobs.filter(id => id !== jobId);
      if (!entry.jobs.length) entry.released_at = this.#now();
      changed = true;
    }
    if (changed) this.#saveIndex();
  }

  /** Expired files go first, then least recently used unreferenced files until under the cap. */
  async #evict(keep?: string) {
    const now = this.#now();
    for (const [sha, entry] of Object.entries(this.#index)) {
      if (sha !== keep && !entry.jobs.length && entry.released_at !== null && now - entry.released_at > this.#retainMs) this.#drop(sha);
    }
    let total = Object.values(this.#index).reduce((sum, entry) => sum + entry.bytes, 0);
    const candidates = Object.entries(this.#index).filter(([sha, entry]) => sha !== keep && !entry.jobs.length)
      .sort(([, a], [, b]) => a.last_used - b.last_used);
    for (const [sha, entry] of candidates) {
      if (total <= this.#maxBytes) break;
      this.#drop(sha);
      total -= entry.bytes;
    }
    this.#saveIndex();
  }

  #drop(sha: string) {
    rmSync(this.pathFor(sha), { force: true });
    delete this.#index[sha];
  }

  collect() { return this.#evict(); }
  entries() { return structuredClone(this.#index); }
}
