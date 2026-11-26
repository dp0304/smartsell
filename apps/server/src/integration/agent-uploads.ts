import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Problem, WRITE, type Context, type Data, type Row } from '@smartsell/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AGENT_UPLOAD_MIME } from '../../../../packages/media-store/src/index.js';
import type { Config } from '../config.js';
import { discardPreparedObject, prepareAssembledObject, recordAssembledObject, type MediaFiles, type PrepareOptions } from '../extensions/media-files.js';
import { alertUploadFailed } from '../modules/alerts/index.js';
import { DomainError } from '../modules/types.js';

// ---------- Constants (§6.4) ----------
export const AGENT_UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const AGENT_UPLOAD_MAX_CHUNKS_PER_PART = 8;
export const AGENT_UPLOAD_ACCEPTED_MIME: readonly string[] = AGENT_UPLOAD_MIME;
/** Route body limit for one part: 8 chunks plus slack (§6.4). */
export const AGENT_UPLOAD_PART_BODY_LIMIT = AGENT_UPLOAD_MAX_CHUNKS_PER_PART * AGENT_UPLOAD_CHUNK_BYTES + 64 * 1024;
const SESSION_TTL_MS = 24 * 3_600_000;
/** media_upload returns within at most 50 s; a session that becomes ready later finished in the background (§6.3 step 9). */
const BACKGROUND_AFTER_MS = 50_000;
const ACTIVE_SESSION_LIMIT = 32;
/** Defaults when the caller's config has no S4 limits (config.ts sets both for the real hosts). */
const DEFAULT_MIN_FREE_BYTES = 1024 ** 3;
const DEFAULT_QUOTA_UPLOADS = 4;
const SESSION = 'media_upload_session';
/** A direct upload link (no relay, E47) is good for one PUT within an hour; the hub keeps it in memory only. */
const DIRECT_LINK_TTL_MS = 3_600_000;
const DIRECT_PATH = '/api/v1/agent/uploads/direct/';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex64 = /^[a-f0-9]{64}$/;

export type UploadStatus = 'receiving' | 'assembling' | 'processing' | 'ready' | 'failed';
export interface UploadError { code: string; message: string; reason?: string }
/** `media_upload_session` (§6.4). `parts` lists the accepted part files; `received` is the union of their 1 MiB chunks. */
export interface MediaUploadSession extends Row {
  credential_id: string; actor_id: string; filename: string; bytes: number; sha256: string; mime: string; title: string | null;
  chunk_bytes: number; chunks: number; received: number[]; parts: { n: number; k: number }[]; status: UploadStatus;
  media_id: string; asset_version_id: string; file_object_id: string | null; error: UploadError | null;
  expires_at: string; ready_at: string | null; failed_at: string | null; probe: 'ok' | 'unavailable' | 'invalid' | null;
}

/**
 * C4 (S4 owns apps/server/src/integration/agent-credential.ts). Declared structurally here so this stream compiles
 * before that file lands; S4's AgentCredentialService is assignable to it.
 */
export interface UploadPrincipal {
  credentialId: string; actorId: string; workspaceId: string; label?: string;
  /** Runs fn inside one workspace transaction with the role checked. fn must not wait or do IO. */
  run<T>(write: boolean, fn: (ctx: Context) => T | Promise<T>): Promise<T>;
}
export interface UploadCredentialService { authenticate(req: FastifyRequest): Promise<UploadPrincipal | undefined> }

export interface AgentUploadDeps {
  credentials: UploadCredentialService;
  media: Pick<MediaFiles, 'storage'>;
  config: Pick<Config, 'mediaDirectory' | 'maxUploadBytes'> & Partial<Pick<Config, 'uploadStagingQuotaBytes' | 'uploadMinFreeBytes'>>;
  /** Free bytes on the disk holding `path`, or undefined when unknown (tests); defaults to fs.statfs. */
  diskFree?: (path: string) => Promise<number | undefined>;
  /** Probe override for tests (slow or missing ffprobe). */
  prepare?: PrepareOptions;
  /** Path of the built relay bundle served at GET /agent/relay.mjs. */
  relayBundlePath?: string;
  log?: { error(object: unknown, message?: string): void };
}

const defaultBundle = fileURLToPath(new URL('../../../../packages/agent-relay/dist/smartsell-relay.mjs', import.meta.url));
/** Upload ids whose assembly is running in this process; expiry skips them. */
const activeJobs = new Set<string>();

const problem = (status: number, code: string, message: string, details?: Data) => new Problem(status, code, message, details);
const invalidArguments = (message: string, issues: Data[]) => problem(422, 'INVALID_ARGUMENTS', message, { issues });
const notFound = () => problem(404, 'MEDIA_NOT_FOUND', 'Unknown upload_id. Call media_upload again with the file path.');
const sorted = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);
const overlaps = (a: { n: number; k: number }, b: { n: number; k: number }) => a.n < b.n + b.k && b.n < a.n + a.k;
const UNFINISHED: readonly UploadStatus[] = ['receiving', 'assembling', 'processing'];
const storageLow = (free: number) => problem(507, 'UPLOAD_STORAGE_LOW', `The hub is low on disk space (${free} bytes free); it accepts no upload bytes until space is freed.`,
  { free_bytes: free, owner_message: '中樞磁碟空間不足，已暫停接收上傳。請清出空間或刪除已發布的舊媒體後再試。' });

/** Free bytes on the file system that holds `path` (its nearest existing ancestor); undefined when the platform cannot tell. */
export async function diskFreeBytes(path: string): Promise<number | undefined> {
  for (let directory = path; ; directory = dirname(directory)) {
    try {
      const info = await statfs(directory);
      return Number(info.bavail) * Number(info.bsize);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(directory) === directory) return undefined;
    }
  }
}

export function stagingDirectory(mediaDirectory: string, uploadId: string) {
  if (!uuid.test(uploadId)) throw notFound();
  return join(mediaDirectory, 'staging', uploadId);
}

function bytesReceived(session: Pick<MediaUploadSession, 'received' | 'chunks' | 'chunk_bytes' | 'bytes'>) {
  const last = session.bytes - (session.chunks - 1) * session.chunk_bytes;
  return session.received.length * session.chunk_bytes - (session.received.includes(session.chunks - 1) ? session.chunk_bytes - last : 0);
}

function expired(session: MediaUploadSession, now: number) {
  return Date.parse(session.expires_at) <= now;
}

function findSession(ctx: Context, id: string) {
  if (!uuid.test(id)) throw notFound();
  const row = ctx.list(SESSION).find(item => item.id === id) as MediaUploadSession | undefined;
  // Sessions belong to the person behind the connection; other members do not see them.
  if (!row || row.actor_id !== ctx.actorId) throw notFound();
  return row;
}

function mediaView(ctx: Context, session: Pick<MediaUploadSession, 'media_id'>) {
  const asset = ctx.list('asset').find(row => row.id === session.media_id);
  const version = asset && ctx.list('asset_version').find(row => row.id === asset.current_version_id);
  if (!asset || !version) return null;
  const meta = (version.meta ?? {}) as Data;
  const file = typeof version.file_object_id === 'string' ? ctx.list('file_object').find(row => row.id === version.file_object_id) : undefined;
  return { media_id: asset.id, status: String(asset.status), kind: asset.kind === 'image' ? 'image' : 'video', mime: String(version.mime_type),
    bytes: Number(file?.size_bytes ?? 0) || null, sha256: String(version.sha256), filename: String(file?.original_filename ?? asset.title),
    file_id: file?.id ?? null,
    duration_ms: typeof meta.duration_ms === 'number' ? meta.duration_ms : null,
    width: typeof meta.width === 'number' ? meta.width : null, height: typeof meta.height === 'number' ? meta.height : null };
}

function sessionView(ctx: Context, session: MediaUploadSession) {
  return { upload_id: session.id, media_id: session.media_id, status: session.status, chunk_bytes: session.chunk_bytes, chunks: session.chunks,
    received: session.received, bytes_received: bytesReceived(session), bytes: session.bytes, sha256: session.sha256, mime: session.mime,
    filename: session.filename, expires_at: session.expires_at, error: session.error, deduplicated: false,
    media: session.status === 'ready' ? mediaView(ctx, session) : null };
}

// ---------- Owner alerts (C13, S10) ----------
/** S10's alertUploadFailed reasons for each failure code (§5.9 upload_failed). upload_done comes from S10's asset.version.created trigger. */
function alertReason(error: UploadError) {
  switch (error.code) {
    case 'FILE_CHANGED': return 'file_changed';
    case 'UPLOAD_EXPIRED': return 'expired';
    case 'UPLOAD_HASH_MISMATCH': return 'UPLOAD_HASH_MISMATCH';
    default: return error.reason === 'cancelled' ? 'cancelled' : 'error';
  }
}

function markFailed(ctx: Context, session: MediaUploadSession, error: UploadError) {
  if (session.status === 'ready' || session.status === 'failed') return session;
  const row = ctx.update(SESSION, session.id, { status: 'failed', error, failed_at: ctx.now }) as MediaUploadSession;
  const asset = ctx.list('asset').find(item => item.id === session.media_id);
  if (asset && asset.status !== 'ready') ctx.update('asset', asset.id, { status: 'failed', failure: { code: error.code, message: error.message } });
  ctx.emit('media.upload.failed', { upload_id: session.id, media_id: session.media_id, filename: session.filename, code: error.code,
    reason: error.reason ?? null, actor_id: session.actor_id });
  // Same transaction as the failed status, so the owner always hears about it (§0 rule 7).
  alertUploadFailed(ctx, { media_id: session.media_id, filename: session.filename, reason: alertReason(error) });
  return row;
}

function markReady(ctx: Context, session: MediaUploadSession, fileObjectId: string, probe: MediaUploadSession['probe']) {
  const row = ctx.update(SESSION, session.id, { status: 'ready', file_object_id: fileObjectId, ready_at: ctx.now, error: null, probe }) as MediaUploadSession;
  const background = Date.parse(ctx.now) - Date.parse(session.created_at) > BACKGROUND_AFTER_MS;
  // upload_done reaches the owner through S10's trigger on asset.version.created (emitted by recordAssembledObject).
  ctx.emit('media.upload.ready', { upload_id: session.id, media_id: session.media_id, file_object_id: fileObjectId, filename: session.filename,
    bytes: session.bytes, background, actor_id: session.actor_id });
  return row;
}

/** Upload progress for a media_id (post page and MediaRecentItem/JobMedia `uploaded_bytes`, §6.3 step 9). Read-only. */
export function mediaUploadProgress(ctx: Context, mediaId: string) {
  const session = (ctx.list(SESSION) as MediaUploadSession[]).filter(row => row.media_id === mediaId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!session) return undefined;
  return { upload_id: session.id, status: session.status, bytes: session.bytes, bytes_received: bytesReceived(session), error: session.error, expires_at: session.expires_at };
}

/**
 * Fail sessions past their 24 h deadline (§6.4 step 4). Runs inside the scheduler's transaction, so the staging
 * directories are removed only after it returns (no file IO while the store queue is held).
 */
export function expireAgentUploads(ctx: Context, { mediaDirectory }: { mediaDirectory: string }, now = Date.parse(ctx.now)) {
  const stale = (ctx.list(SESSION) as MediaUploadSession[]).filter(row => (row.status === 'receiving' || row.status === 'assembling' || row.status === 'processing') &&
    !activeJobs.has(row.id) && expired(row, now));
  for (const row of stale) markFailed(ctx, row, { code: 'UPLOAD_EXPIRED', message: 'The upload did not finish within 24 hours' });
  const directories = stale.map(row => stagingDirectory(mediaDirectory, row.id));
  if (directories.length) setImmediate(() => { for (const directory of directories) void rm(directory, { recursive: true, force: true }).catch(() => undefined); });
  return { expired: stale.map(row => row.id) };
}

// ---------- Input validation ----------
function strictObject(value: unknown, allowed: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidArguments(`${label} must be a JSON object.`, [{ path: '', code: 'invalid_type' }]);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) {
    throw invalidArguments(`${label} has an unknown field '${unknown[0]}'. Allowed: ${allowed.join(', ') || '(none)'}.`,
      unknown.map(path => ({ path, code: 'unrecognized_keys', allowed: [...allowed] })));
  }
  return value as Data;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};

/** The MIME type for a file name's extension, when the caller did not send one (direct uploads, E47). */
export function mimeFromFilename(filename: unknown) {
  const extension = typeof filename === 'string' ? /\.([A-Za-z0-9]{2,5})$/.exec(filename)?.[1]?.toLowerCase() : undefined;
  return extension ? MIME_BY_EXTENSION[extension] : undefined;
}

function parseCreate(body: unknown, maxBytes: number) {
  const input = strictObject(body, ['filename', 'bytes', 'sha256', 'mime', 'title'], 'The upload');
  const { filename, bytes, sha256, mime, title } = input;
  if (typeof filename !== 'string' || !filename.trim() || Buffer.byteLength(filename) > 255 || /[\p{Cc}\p{Cf}\\/]/u.test(filename)) {
    throw invalidArguments('filename must be 1 to 255 bytes without slashes or control characters.', [{ path: 'filename', code: 'invalid_string' }]);
  }
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) throw invalidArguments('bytes must be a positive integer.', [{ path: 'bytes', code: 'invalid_type' }]);
  if (bytes > maxBytes) throw problem(422, 'UPLOAD_TOO_LARGE', `The file is larger than this hub accepts (${maxBytes} bytes).`, { max_upload_bytes: maxBytes });
  if (typeof sha256 !== 'string' || !hex64.test(sha256)) throw invalidArguments('sha256 must be 64 lowercase hex characters.', [{ path: 'sha256', code: 'invalid_string' }]);
  if (typeof mime !== 'string' || !AGENT_UPLOAD_ACCEPTED_MIME.includes(mime)) {
    throw problem(422, 'UPLOAD_TYPE_UNSUPPORTED', `Unsupported media type. Accepted: ${AGENT_UPLOAD_ACCEPTED_MIME.join(', ')}.`, { accepted_mime: [...AGENT_UPLOAD_ACCEPTED_MIME] });
  }
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || [...title].length > 200)) {
    throw invalidArguments('title must be 1 to 200 characters.', [{ path: 'title', code: 'invalid_string' }]);
  }
  return { filename, bytes, sha256, mime, title: typeof title === 'string' ? title : null };
}

function partPlan(session: MediaUploadSession, n: number, length: number) {
  const { chunk_bytes: size, chunks, bytes } = session;
  if (!Number.isSafeInteger(n) || n < 0 || n >= chunks) throw invalidArguments(`Part index ${n} is outside 0..${chunks - 1}.`, [{ path: 'n', code: 'too_big' }]);
  const k = Math.ceil(length / size);
  if (k < 1 || k > AGENT_UPLOAD_MAX_CHUNKS_PER_PART || n + k > chunks) throw invalidArguments(`A part carries 1 to ${AGENT_UPLOAD_MAX_CHUNKS_PER_PART} chunks inside the file.`, [{ path: 'content-length', code: 'too_big' }]);
  const expected = n + k === chunks ? bytes - n * size : k * size;
  if (length !== expected) throw invalidArguments(`Part ${n} with ${k} chunk(s) must be ${expected} bytes.`, [{ path: 'content-length', code: 'invalid_length' }]);
  return { n, k, length };
}

// ---------- Session writes (each one short; no IO) ----------
interface CreateLimits {
  /** The declared bytes of this workspace's unfinished uploads may not exceed this (S4). */
  quotaBytes: number;
  /** Free disk measured just before the transaction, and the reserve to keep; a new session needs room for its parts and the assembled copy. */
  freeBytes: number | undefined; minFreeBytes: number;
}

function createOrResume(ctx: Context, principal: UploadPrincipal, input: ReturnType<typeof parseCreate>, limits: CreateLimits) {
  const chunks = Math.ceil(input.bytes / AGENT_UPLOAD_CHUNK_BYTES);
  const base = { chunk_bytes: AGENT_UPLOAD_CHUNK_BYTES, chunks };
  // Dedupe only against owned, ready assets in this workspace, so a brand's licensed asset is never handed back (§3.8).
  const versions = new Map(ctx.list('asset_version').map(row => [row.id, row]));
  const files = new Map(ctx.list('file_object').map(row => [row.id, row]));
  for (const asset of ctx.list('asset')) {
    if (asset.ownership !== 'owned' || asset.status !== 'ready' || asset.archived_at) continue;
    const version = versions.get(String(asset.current_version_id));
    const file = version && files.get(String(version.file_object_id));
    if (!version || version.sha256 !== input.sha256 || !file || file.deleted_at || file.sha256 !== input.sha256) continue;
    return { created: false, view: { upload_id: null, media_id: asset.id, status: 'ready' as const, ...base, received: [] as number[], bytes_received: input.bytes,
      expires_at: null, error: null, deduplicated: true, media: mediaView(ctx, { media_id: asset.id }) } };
  }
  const now = Date.parse(ctx.now);
  const sessions = ctx.list(SESSION) as MediaUploadSession[];
  let existing = sessions.find(row => row.actor_id === ctx.actorId && row.sha256 === input.sha256 && row.bytes === input.bytes &&
    (row.status === 'receiving' || row.status === 'assembling' || row.status === 'processing'));
  let expiredId: string | undefined;
  if (existing && existing.status === 'receiving' && expired(existing, now) && !activeJobs.has(existing.id)) {
    markFailed(ctx, existing, { code: 'UPLOAD_EXPIRED', message: 'The upload did not finish within 24 hours' });
    // Its staged parts are removed after the transaction (the caller does the IO).
    expiredId = existing.id;
    existing = undefined;
  }
  if (existing) return { created: false, expiredId, view: sessionView(ctx, existing) };
  const live = sessions.filter(row => UNFINISHED.includes(row.status) && !(row.status === 'receiving' && expired(row, now)));
  if (live.filter(row => row.status === 'receiving').length >= ACTIVE_SESSION_LIMIT) {
    throw problem(429, 'UPLOAD_LIMIT', 'Too many uploads are in progress. Wait for one to finish.');
  }
  // A session never stages more than its declared bytes, so the declared sizes bound this workspace's staging disk (S4).
  const inUse = live.reduce((sum, row) => sum + row.bytes, 0);
  if (inUse + input.bytes > limits.quotaBytes) {
    throw problem(413, 'UPLOAD_QUOTA_EXCEEDED', `Unfinished uploads in this workspace already hold ${inUse} of ${limits.quotaBytes} bytes; this file needs ${input.bytes}. Finish or abort one first.`,
      { quota_bytes: limits.quotaBytes, in_use_bytes: inUse, owner_message: '這個工作區進行中的上傳已用滿暫存空間。請等其他上傳完成，或取消不需要的上傳後再試。' });
  }
  if (limits.freeBytes !== undefined && limits.freeBytes < limits.minFreeBytes + 2 * input.bytes) throw storageLow(limits.freeBytes);
  const kind = input.mime.startsWith('video/') ? 'video' : 'image';
  const by = { created_by_type: 'agent', created_by_id: ctx.actorId };
  // media_id exists from the first moment, so post_schedule can use it while bytes are still arriving (§6.4 step 1).
  const asset = ctx.create('asset', { kind, title: input.title ?? input.filename, description: null, tags: [], locale: null, brand_id: null, folder_id: null,
    ownership: 'owned', origin: 'agent_upload', origin_ref: null, status: 'uploading', current_version_id: null, favorite_count: 0, archived_at: null, ...by });
  const version = ctx.create('asset_version', { asset_id: asset.id, version_no: 1, file_object_id: null, mime_type: input.mime, sha256: input.sha256,
    meta: null, thumbnail_file_id: null, change_note: null, external_version: null, ...by });
  ctx.update('asset', asset.id, { current_version_id: version.id });
  const session = ctx.create(SESSION, { credential_id: principal.credentialId, actor_id: ctx.actorId, filename: input.filename, bytes: input.bytes,
    sha256: input.sha256, mime: input.mime, title: input.title, ...base, received: [], parts: [], status: 'receiving', media_id: asset.id,
    asset_version_id: version.id, file_object_id: null, error: null, expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    ready_at: null, failed_at: null, probe: null }) as MediaUploadSession;
  ctx.emit('asset.asset.created', { asset_id: asset.id, brand_id: null, origin: 'agent_upload' });
  ctx.emit('media.upload.started', { upload_id: session.id, media_id: asset.id, filename: input.filename, bytes: input.bytes, actor_id: ctx.actorId });
  return { created: true, expiredId, view: sessionView(ctx, session) };
}

function receivingSession(ctx: Context, id: string) {
  const session = findSession(ctx, id);
  if (session.status === 'receiving' && expired(session, Date.parse(ctx.now))) throw problem(410, 'UPLOAD_EXPIRED', 'This upload expired. Call media_upload again.');
  if (session.status !== 'receiving') {
    throw problem(409, session.status === 'failed' ? session.error?.code ?? 'MEDIA_FAILED' : 'UPLOAD_NOT_RECEIVING',
      `This upload is ${session.status}; it no longer accepts parts.`, { status: session.status });
  }
  return session;
}

type PartRange = { n: number; k: number };
const sameRange = (a: PartRange, b: PartRange) => a.n === b.n && a.k === b.k;
const partFile = (part: PartRange) => `${part.n}-${part.k}.part`;

/**
 * Where a new part goes among the recorded ones, so recorded parts never overlap and a session stages at most its declared
 * bytes (S4). The same (n, k) again replaces itself (a resend is idempotent); a part inside one already recorded adds
 * nothing; a part that covers recorded parts replaces them (two relays with different part sizes, for example a hand-off).
 * A part that only partly overlaps another is refused: keeping both would let one upload stage many times its size.
 */
function placePart(session: MediaUploadSession, part: PartRange) {
  const others = session.parts.filter(item => !sameRange(item, part) && overlaps(item, part));
  if (others.some(item => item.n <= part.n && item.n + item.k >= part.n + part.k)) return { redundant: true as const, superseded: [] as PartRange[] };
  const partial = others.find(item => item.n < part.n || item.n + item.k > part.n + part.k);
  if (partial) {
    throw problem(409, 'UPLOAD_PART_OVERLAP', `Chunks ${part.n}..${part.n + part.k - 1} partly overlap chunks ${partial.n}..${partial.n + partial.k - 1}, which already arrived. Send only the missing chunks.`,
      { received: session.received });
  }
  return { redundant: false as const, superseded: others };
}

function recordPart(ctx: Context, id: string, part: PartRange) {
  const session = receivingSession(ctx, id);
  const place = placePart(session, part);
  if (place.redundant) return { received: session.received, redundant: true, superseded: [] as PartRange[] };
  const parts = [...session.parts.filter(item => !sameRange(item, part) && !place.superseded.includes(item)), { n: part.n, k: part.k }];
  const received = sorted([...session.received, ...Array.from({ length: part.k }, (_, index) => part.n + index)]);
  ctx.update(SESSION, id, { parts, received });
  return { received, redundant: false, superseded: place.superseded };
}

// ---------- File IO (always outside transactions) ----------
async function writePart(directory: string, plan: { n: number; k: number; length: number }, body: Readable, expected: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const final = join(directory, `${plan.n}-${plan.k}.part`);
  const temp = join(directory, `${plan.n}-${plan.k}.${randomUUID()}.tmp`);
  const hash = createHash('sha256');
  let count = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    count += chunk.length;
    if (count > plan.length) return callback(invalidArguments('The part body is longer than Content-Length.', [{ path: 'body', code: 'too_big' }]));
    hash.update(chunk);
    callback(null, chunk);
  } });
  try {
    await pipeline(body, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (count !== plan.length) throw invalidArguments('The part body is shorter than Content-Length.', [{ path: 'body', code: 'too_small' }]);
    if (hash.digest('hex') !== expected) throw problem(422, 'UPLOAD_PART_HASH_MISMATCH', 'The part SHA-256 does not match x-part-sha256. Resend this part.');
    await rename(temp, final);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Concatenate the recorded parts in chunk order into one file, hashing as it goes. */
async function assemble(directory: string, session: MediaUploadSession) {
  const owner: ({ n: number; k: number } | undefined)[] = new Array(session.chunks);
  for (const part of session.parts) for (let index = part.n; index < part.n + part.k; index++) owner[index] = part;
  if (owner.some(part => !part) || owner.length !== session.chunks) throw problem(409, 'UPLOAD_INCOMPLETE', 'Some chunks are missing.');
  const target = join(directory, 'assembled.bin');
  await rm(target, { force: true });
  const out = createWriteStream(target, { flags: 'wx', mode: 0o600 });
  const hash = createHash('sha256');
  let size = 0;
  try {
    for (let index = 0; index < session.chunks;) {
      const part = owner[index]!;
      let next = index;
      while (next < session.chunks && owner[next] === part) next++;
      const start = (index - part.n) * session.chunk_bytes;
      const end = Math.min((next - part.n) * session.chunk_bytes, (next === session.chunks ? session.bytes - part.n * session.chunk_bytes : Infinity)) - 1;
      for await (const chunk of createReadStream(join(directory, `${part.n}-${part.k}.part`), { start, end, highWaterMark: AGENT_UPLOAD_CHUNK_BYTES })) {
        hash.update(chunk as Buffer);
        size += (chunk as Buffer).length;
        if (!out.write(chunk)) await once(out, 'drain');
      }
      index = next;
    }
    out.end();
    await once(out, 'finish');
  } catch (error) {
    out.destroy();
    await rm(target, { force: true });
    throw error;
  }
  return { path: target, sha256: hash.digest('hex'), size };
}

// ---------- Routes ----------
/**
 * Mount the agent upload API (§6.4, Appendix B.1). command-mcp.ts (S4) calls this after registering /mcp.
 * Returns a handle whose idle() resolves when no assembly is running (tests and graceful shutdown).
 */
export function registerAgentUploads(app: FastifyInstance, deps: AgentUploadDeps) {
  const { credentials, media, config } = deps;
  const storage = media.storage;
  const directoryFor = (id: string) => stagingDirectory(config.mediaDirectory, id);
  const jobs = new Map<string, Promise<void>>();
  let queue: Promise<void> = Promise.resolve();
  let bundle: { mtimeMs: number; bytes: Buffer; etag: string } | undefined;
  /** sha256(link token) → the upload it may fill. In memory: a hub restart voids the links, and media_upload hands out new ones. */
  const directLinks = new Map<string, { uploadId: string; principal: UploadPrincipal; expiresAt: number; inUse?: boolean }>();
  const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');
  const quotaBytes = config.uploadStagingQuotaBytes ?? DEFAULT_QUOTA_UPLOADS * config.maxUploadBytes;
  const minFreeBytes = config.uploadMinFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const diskFree = deps.diskFree ?? diskFreeBytes;
  /**
   * Chunk ranges this process is writing to staging, per upload. A write over chunks another request is still writing waits
   * for it, so two copies of the same chunks are never staged at once and the second one is then placed (or skipped) against
   * what the first recorded (S4).
   */
  const writing = new Map<string, Set<PartRange & { done: Promise<void> }>>();

  const createLimits = async (): Promise<CreateLimits> => ({ quotaBytes, minFreeBytes, freeBytes: await diskFree(config.mediaDirectory) });
  async function ensureRoom(length: number) {
    const free = await diskFree(config.mediaDirectory);
    if (free !== undefined && free < minFreeBytes + length) throw storageLow(free);
  }
  /** Claim chunks n..n+k-1 of an upload for one write, after any overlapping write finishes; the returned function releases them. */
  async function claim(principal: UploadPrincipal, upload: string, part: PartRange) {
    // Keyed by the person as well: someone else's connection cannot hold chunks of an upload it does not own.
    const id = `${principal.workspaceId}/${principal.actorId}/${upload}`;
    for (;;) {
      const parts = writing.get(id) ?? new Set();
      const busy = [...parts].find(item => overlaps(item, part));
      if (busy) { await busy.done; continue; }
      let release!: () => void;
      const entry = { n: part.n, k: part.k, done: new Promise<void>(resolve => { release = resolve; }) };
      parts.add(entry);
      writing.set(id, parts);
      return () => { parts.delete(entry); if (!parts.size && writing.get(id) === parts) writing.delete(id); release(); };
    }
  }
  /** Staging of a session that createOrResume just expired; removed outside the transaction. */
  const dropStaging = (id: string | undefined) => { if (id) void rm(directoryFor(id), { recursive: true, force: true }).catch(() => undefined); };

  async function principalFor(request: FastifyRequest) {
    let principal: UploadPrincipal | undefined;
    try { principal = await credentials.authenticate(request); }
    catch (error) {
      if (error instanceof DomainError && error.status === 401) principal = undefined;
      else throw error;
    }
    if (!principal) throw problem(401, 'UNAUTHENTICATED', 'A valid SmartSell agent connection token is required. Reconnect the agent in SmartSell.',
      { owner_message: 'Agent 連線已失效或被撤銷。請在 SmartSell 重新連接 Codex 或 Claude Code。' });
    return principal;
  }
  function inWorkspace<T>(principal: UploadPrincipal, write: boolean, fn: (ctx: Context) => T) {
    return principal.run(write, ctx => {
      if (!WRITE.includes(ctx.role)) throw problem(403, 'PERMISSION_DENIED', 'This connection cannot upload media.');
      return fn(ctx);
    });
  }
  async function fail(principal: UploadPrincipal, id: string, error: UploadError) {
    await inWorkspace(principal, true, ctx => markFailed(ctx, findSession(ctx, id), error));
  }

  /** Assemble, verify, store and probe in the background (§6.4 step 3). Only steps 1 and 4 touch the store, briefly. */
  async function finish(principal: UploadPrincipal, id: string) {
    const directory = directoryFor(id);
    const snapshot = await inWorkspace(principal, false, ctx => ({ session: findSession(ctx, id), tenantId: ctx.tenantId, workspaceId: ctx.workspaceId }));
    if (snapshot.session.status !== 'assembling' && snapshot.session.status !== 'processing') return;
    const session = snapshot.session;
    let removeStaging = true;
    try {
      const assembled = await assemble(directory, session);
      if (assembled.sha256 !== session.sha256 || assembled.size !== session.bytes) {
        await fail(principal, id, { code: 'UPLOAD_HASH_MISMATCH', message: 'The assembled file does not match the declared SHA-256 and size' });
        return;
      }
      const live = await inWorkspace(principal, true, ctx => {
        const current = findSession(ctx, id);
        if (current.status !== 'assembling' && current.status !== 'processing') return false;
        if (current.status === 'assembling') ctx.update(SESSION, id, { status: 'processing' });
        return true;
      });
      if (!live) return;
      const prepared = await prepareAssembledObject(storage, { path: assembled.path, sha256: session.sha256, size: session.bytes, mime: session.mime,
        filename: session.filename, workspaceId: snapshot.workspaceId, tenantId: snapshot.tenantId }, deps.prepare);
      let linked: { file_object_id: string; reused?: true } | undefined;
      try {
        linked = await inWorkspace(principal, true, ctx => {
          const current = findSession(ctx, id);
          if (current.status !== 'processing') return undefined;
          const result = recordAssembledObject(ctx, prepared, { asset_id: current.media_id, asset_version_id: current.asset_version_id, createdBy: current.actor_id });
          markReady(ctx, current, result.file_object_id, prepared.probe);
          return result;
        });
      } catch (error) {
        await discardPreparedObject(storage, prepared).catch(() => undefined);
        throw error;
      }
      if (!linked || linked.reused) await discardPreparedObject(storage, prepared).catch(() => undefined);
    } catch (error) {
      const code = error instanceof Problem ? error.code : 'MEDIA_FAILED';
      deps.log?.error({ err: error, upload_id: id }, 'Agent upload processing failed');
      try { await fail(principal, id, { code, message: error instanceof Problem ? error.message : 'Upload processing failed on the hub' }); }
      catch (failure) {
        // The store is unreachable (for example the connection was revoked). Keep the parts so a later poll retries.
        removeStaging = false;
        deps.log?.error({ err: failure, upload_id: id }, 'Could not record the agent upload failure');
      }
    } finally {
      if (removeStaging) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  /** One link per upload: a new media_upload call replaces the previous link, and expired links are dropped. */
  function issueLink(principal: UploadPrincipal, uploadId: string, origin: string) {
    const now = Date.now();
    for (const [key, link] of directLinks) if (link.expiresAt <= now || link.uploadId === uploadId) directLinks.delete(key);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + DIRECT_LINK_TTL_MS;
    directLinks.set(tokenKey(token), { uploadId, principal, expiresAt });
    const url = `${origin.replace(/\/+$/, '')}${DIRECT_PATH}${token}`;
    return {
      method: 'PUT' as const, url, expires_at: new Date(expiresAt).toISOString(), headers: { 'content-type': 'application/octet-stream' },
      // Single quotes (S9): the shell expands nothing inside them, so a file name with $(…) or backticks cannot run. The agent
      // writes a ' in the path as '\'' (PowerShell: ''), as the media_upload description says.
      command: `curl --fail --silent --show-error -T '<path>' -H 'Content-Type: application/octet-stream' '${url}'`,
    };
  }

  /**
   * media_upload without the relay (E47): create or resume the session for {filename, bytes, sha256} and hand back a one-use
   * PUT link for the whole file. The same call again reads the status (and replaces the link while bytes are still missing).
   */
  async function direct(principal: UploadPrincipal, body: Data, origin: string) {
    const input = parseCreate({ ...body, ...(body.mime === undefined && { mime: mimeFromFilename(body.filename) }) }, config.maxUploadBytes);
    const limits = await createLimits();
    const result = await inWorkspace(principal, true, ctx => createOrResume(ctx, principal, input, limits));
    dropStaging(result.expiredId);
    const view = result.view;
    if (view.status === 'assembling' || view.status === 'processing') startFinish(principal, String(view.upload_id));
    return { ...view, upload: view.status === 'receiving' && view.upload_id ? issueLink(principal, view.upload_id, origin) : null };
  }

  function startFinish(principal: UploadPrincipal, id: string) {
    if (jobs.has(id)) return;
    activeJobs.add(id);
    // One assembly at a time keeps disk and ffprobe load bounded; the store queue is never held while waiting here.
    const job = queue.then(() => finish(principal, id)).catch(error => deps.log?.error({ err: error, upload_id: id }, 'Agent upload job failed'))
      .finally(() => { jobs.delete(id); activeJobs.delete(id); });
    queue = job;
    jobs.set(id, job);
  }

  app.register(async router => {
    router.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    router.setErrorHandler((error, request, reply: FastifyReply) => {
      if (!(error instanceof Problem)) {
        const status = (error as { statusCode?: number }).statusCode ?? (error instanceof DomainError ? error.status : 500);
        if (status >= 500) { request.log.error({ err: error }, 'Agent upload request failed'); deps.log?.error({ err: error }, 'Agent upload request failed'); }
        const code = status === 401 ? 'UNAUTHENTICATED' : status === 413 ? 'UPLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
        return reply.code(status).send({ error: { code, message: status < 500 ? 'Invalid request' : 'Internal server error' } });
      }
      if (error.status === 401) reply.header('www-authenticate', 'Bearer');
      const { issues, ...details } = error.details ?? {};
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(issues !== undefined && { issues }),
        ...(Object.keys(details).length && { details }) } });
    });

    router.get('/api/v1/agent/uploads/config', async request => {
      await inWorkspace(await principalFor(request), false, () => undefined);
      return { max_upload_bytes: config.maxUploadBytes, chunk_bytes: AGENT_UPLOAD_CHUNK_BYTES, max_chunks_per_part: AGENT_UPLOAD_MAX_CHUNKS_PER_PART,
        accepted_mime: [...AGENT_UPLOAD_ACCEPTED_MIME] };
    });

    router.post('/api/v1/agent/uploads', async (request, reply) => {
      const principal = await principalFor(request);
      const input = parseCreate(request.body, config.maxUploadBytes);
      const limits = await createLimits();
      const result = await inWorkspace(principal, true, ctx => createOrResume(ctx, principal, input, limits));
      dropStaging(result.expiredId);
      if (result.view.status === 'assembling' || result.view.status === 'processing') startFinish(principal, String(result.view.upload_id));
      return reply.code(result.created ? 201 : 200).send(result.view);
    });

    router.put<{ Params: { id: string; n: string } }>('/api/v1/agent/uploads/:id/parts/:n', { bodyLimit: AGENT_UPLOAD_PART_BODY_LIMIT }, async request => {
      const body = request.body as Readable | undefined;
      let consumed = false;
      try {
        const principal = await principalFor(request);
        const { id } = request.params;
        if (!/^\d{1,6}$/.test(request.params.n)) throw invalidArguments('The part index must be a whole number.', [{ path: 'n', code: 'invalid_type' }]);
        const n = Number(request.params.n);
        const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/octet-stream' || !(body instanceof Readable) || request.headers['content-encoding']) {
          throw problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the part as unencoded application/octet-stream.');
        }
        const length = request.headers['content-length'];
        if (typeof length !== 'string' || !/^\d{1,10}$/.test(length)) throw problem(411, 'LENGTH_REQUIRED', 'Content-Length is required.');
        if (Number(length) > AGENT_UPLOAD_MAX_CHUNKS_PER_PART * AGENT_UPLOAD_CHUNK_BYTES) throw problem(413, 'UPLOAD_TOO_LARGE', 'A part carries at most 8 chunks of 1 MiB.');
        const digest = request.headers['x-part-sha256'];
        if (typeof digest !== 'string' || !hex64.test(digest)) throw invalidArguments('x-part-sha256 must be 64 lowercase hex characters.', [{ path: 'x-part-sha256', code: 'invalid_string' }]);
        const directory = directoryFor(id);
        const release = await claim(principal, id, { n, k: Math.max(1, Math.ceil(Number(length) / AGENT_UPLOAD_CHUNK_BYTES)) });
        try {
          // Read after the claim, so a part that waited for an overlapping one sees what that one recorded.
          const { plan, received } = await inWorkspace(principal, false, ctx => {
            const session = receivingSession(ctx, id);
            const part = partPlan(session, n, Number(length));
            return { plan: part, received: placePart(session, part).redundant ? session.received : undefined };
          });
          // Every chunk of this part already arrived in a larger part: nothing to store (the body is drained).
          if (received) return { received };
          await ensureRoom(plan.length);
          consumed = true;
          await writePart(directory, plan, body, digest);
          try {
            const result = await inWorkspace(principal, true, ctx => recordPart(ctx, id, plan));
            for (const part of result.redundant ? [plan] : result.superseded) await rm(join(directory, partFile(part)), { force: true });
            return { received: result.received };
          } catch (error) {
            // Another process recorded an overlapping part meanwhile: this part's file is not referenced, so drop it.
            if (error instanceof Problem && error.code === 'UPLOAD_PART_OVERLAP') await rm(join(directory, partFile(plan)), { force: true });
            // The session stopped receiving (aborted, expired) while this part was in flight: drop its staging files.
            else if (error instanceof Problem && (error.status === 409 || error.status === 410) && !jobs.has(id)) await rm(directory, { recursive: true, force: true });
            throw error;
          }
        } finally { release(); }
      } finally {
        // Drain an unread body so the client receives the error instead of a reset connection.
        if (!consumed && body instanceof Readable && !body.destroyed) body.resume();
      }
    });

    // E47: the whole file in one PUT, authorized by the one-use link from media_upload (no agent token on this route).
    router.put<{ Params: { token: string } }>(`${DIRECT_PATH}:token`, { bodyLimit: config.maxUploadBytes + 64 * 1024 }, async (request, reply) => {
      const body = request.body as Readable | undefined;
      let consumed = false;
      let inUse: { inUse?: boolean } | undefined;
      try {
        const key = tokenKey(request.params.token);
        const link = directLinks.get(key);
        if (!link || link.expiresAt <= Date.now()) {
          if (link) directLinks.delete(key);
          throw problem(410, 'UPLOAD_LINK_EXPIRED', 'This upload link expired or was already used. Call media_upload again with the same filename, bytes and sha256 for a new link.');
        }
        const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/octet-stream' || !(body instanceof Readable) || request.headers['content-encoding']) {
          throw problem(415, 'UNSUPPORTED_MEDIA_TYPE', "Send the file as unencoded application/octet-stream (curl -T '<path>' -H 'Content-Type: application/octet-stream').");
        }
        const length = request.headers['content-length'];
        if (typeof length !== 'string' || !/^\d{1,13}$/.test(length)) throw problem(411, 'LENGTH_REQUIRED', 'Content-Length is required (curl -T sends it).');
        if (link.inUse) throw problem(409, 'UPLOAD_LINK_IN_USE', 'This upload link is already being used by another PUT. Wait for it, or call media_upload again.');
        link.inUse = true;
        inUse = link;
        const { uploadId, principal } = link;
        const plan = await inWorkspace(principal, false, ctx => {
          const session = receivingSession(ctx, uploadId);
          if (Number(length) !== session.bytes) {
            throw invalidArguments(`The body is ${length} bytes; media_upload declared ${session.bytes}. Upload the same file you described.`, [{ path: 'content-length', code: 'invalid_length' }]);
          }
          return { n: 0, k: session.chunks, length: session.bytes, sha256: session.sha256, mediaId: session.media_id };
        });
        // Low disk keeps the link, so the same PUT can be retried later.
        await ensureRoom(plan.length);
        const directory = directoryFor(uploadId);
        const whole = partFile(plan);
        // Parts still arriving through the relay API finish first; the whole file then replaces them.
        const release = await claim(principal, uploadId, plan);
        try {
          await inWorkspace(principal, false, ctx => receivingSession(ctx, uploadId));
          // One use: a second PUT with this link is refused even while the first is still streaming.
          directLinks.delete(key);
          consumed = true;
          try { await writePart(directory, plan, body, plan.sha256); }
          catch (error) {
            if (error instanceof Problem && error.code === 'UPLOAD_PART_HASH_MISMATCH') {
              throw problem(422, 'UPLOAD_HASH_MISMATCH', 'The file does not match the sha256 given to media_upload. Recompute it (shasum -a 256 / certutil -hashfile … SHA256) and call media_upload again.');
            }
            throw error;
          }
          await inWorkspace(principal, true, ctx => {
            const session = receivingSession(ctx, uploadId);
            ctx.update(SESSION, uploadId, { parts: [{ n: 0, k: session.chunks }], received: Array.from({ length: session.chunks }, (_, index) => index), status: 'assembling' });
            ctx.update('asset', session.media_id, { status: 'processing' });
          });
        } finally { release(); }
        // The whole file supersedes any parts sent earlier through the relay API; free their disk now.
        for (const name of await readdir(directory).catch(() => [] as string[])) {
          if (name.endsWith('.part') && name !== whole) await rm(join(directory, name), { force: true });
        }
        startFinish(principal, uploadId);
        return reply.code(202).send({ status: 'processing', media_id: plan.mediaId, upload_id: uploadId });
      } finally {
        if (inUse && !consumed) inUse.inUse = false;
        if (!consumed && body instanceof Readable && !body.destroyed) body.resume();
      }
    });

    router.get<{ Params: { id: string } }>('/api/v1/agent/uploads/:id', async request => {
      const principal = await principalFor(request);
      const view = await inWorkspace(principal, false, ctx => sessionView(ctx, findSession(ctx, request.params.id)));
      // After a hub restart an accepted upload has no job in memory; the next poll restarts it.
      if ((view.status === 'assembling' || view.status === 'processing') && !jobs.has(view.upload_id)) startFinish(principal, view.upload_id);
      return view;
    });

    router.post<{ Params: { id: string } }>('/api/v1/agent/uploads/:id/complete', async (request, reply) => {
      const principal = await principalFor(request);
      strictObject(request.body ?? {}, [], 'complete');
      const status = await inWorkspace(principal, true, ctx => {
        const session = findSession(ctx, request.params.id);
        if (session.status === 'failed') throw problem(409, session.error?.code ?? 'MEDIA_FAILED', session.error?.message ?? 'This upload failed.', { status: 'failed' });
        if (session.status !== 'receiving') return session.status;
        if (expired(session, Date.parse(ctx.now))) {
          markFailed(ctx, session, { code: 'UPLOAD_EXPIRED', message: 'The upload did not finish within 24 hours' });
          return 'expired' as const;
        }
        const have = new Set(session.received);
        const missing = Array.from({ length: session.chunks }, (_, index) => index).filter(index => !have.has(index));
        if (missing.length) {
          throw problem(409, 'UPLOAD_INCOMPLETE', `${missing.length} of ${session.chunks} chunks have not arrived yet.`, { missing: missing.slice(0, 64), missing_count: missing.length });
        }
        ctx.update(SESSION, session.id, { status: 'assembling' });
        ctx.update('asset', session.media_id, { status: 'processing' });
        return 'assembling' as const;
      });
      if (status === 'expired') throw problem(410, 'UPLOAD_EXPIRED', 'This upload expired. Call media_upload again.');
      if (status === 'assembling' || status === 'processing') startFinish(principal, request.params.id);
      return reply.code(status === 'ready' ? 200 : 202).send({ status });
    });

    router.post<{ Params: { id: string } }>('/api/v1/agent/uploads/:id/abort', async request => {
      const principal = await principalFor(request);
      const body = strictObject(request.body, ['reason'], 'abort');
      const reason = body.reason;
      if (reason !== 'file_changed' && reason !== 'cancelled' && reason !== 'error') {
        throw invalidArguments("reason must be 'file_changed', 'cancelled' or 'error'.", [{ path: 'reason', code: 'invalid_enum_value', allowed: ['file_changed', 'cancelled', 'error'] }]);
      }
      const id = request.params.id;
      await inWorkspace(principal, true, ctx => {
        const session = findSession(ctx, id);
        if (session.status === 'ready') throw problem(409, 'UPLOAD_ALREADY_READY', 'This upload already finished; nothing to abort.', { media_id: session.media_id });
        markFailed(ctx, session, reason === 'file_changed'
          ? { code: 'FILE_CHANGED', message: 'The file changed while it was uploading', reason }
          : { code: 'MEDIA_FAILED', message: reason === 'cancelled' ? 'The upload was cancelled' : 'The uploader gave up', reason });
      });
      // A running assembly notices the failed status before linking and cleans up itself.
      if (!jobs.has(id)) await rm(directoryFor(id), { recursive: true, force: true });
      return { status: 'failed' };
    });

    router.get('/agent/relay.mjs', async (request, reply) => {
      const path = deps.relayBundlePath ?? defaultBundle;
      let info;
      try { info = await stat(path); } catch {
        throw problem(503, 'RELAY_BUNDLE_MISSING', 'The relay bundle has not been built on this hub.',
          { owner_message: '中樞上還沒有建置 SmartSell relay。請在中樞執行 pnpm --filter @smartsell/agent-relay build 後再試。' });
      }
      if (!bundle || bundle.mtimeMs !== info.mtimeMs) {
        const bytes = await readFile(path);
        bundle = { mtimeMs: info.mtimeMs, bytes, etag: `"${createHash('sha256').update(bytes).digest('hex')}"` };
      }
      reply.header('etag', bundle.etag);
      if (request.headers['if-none-match'] === bundle.etag) return reply.code(304).send();
      return reply.type('text/javascript; charset=utf-8').send(bundle.bytes);
    });
  });

  return {
    direct,
    /** Resolves when every queued assembly has finished. */
    async idle() { while (jobs.size) await Promise.allSettled([...jobs.values()]); },
  };
}
