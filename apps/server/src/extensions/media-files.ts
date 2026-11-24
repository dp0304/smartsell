import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { ADMIN, Problem, READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { open as openFile } from 'node:fs/promises';
import { canPreview, INLINE_BYTES, InvalidMedia, localStorage, MAX_BYTES, MAX_UPLOAD_LIMIT, mediaTypes, MediaToolBusy, MediaToolMissing,
  MediaUnavailable, ObjectMissing, probeMedia, probeTimeoutMs, s3Storage, sniffMime, withSnapshot,
  type ByteRange, type MediaMetadata, type Probe, type Storage } from '../../../../packages/media-store/src/index.js';
import type { Config } from '../config.js';

const FILE = 'file_object';
const reportExportPurpose = 'report_export';
const UPLOAD = 'file_upload';
const purposes = ['asset', 'evidence', 'import', 'export', 'attachment', 'avatar'] as const;
const uploadSeconds = 15 * 60;
const cleanupGrace = 5 * 60_000;
const downloadSeconds = 120;
const day = 86_400_000;
const fileId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const scopeId = /^[A-Za-z0-9_-]{1,128}$/;
const invalid = (message: string) => new Problem(422, 'INVALID_FILE', message);
const missing = () => new Problem(404, 'FILE_NOT_FOUND', 'File unavailable');
const denied = () => new Problem(403, 'FILE_FORBIDDEN', 'File operation is forbidden');
const unavailable = () => new Problem(503, 'MEDIA_UNAVAILABLE', 'Media storage or processing is temporarily unavailable');
const clock = (ctx: Context) => Date.parse(ctx.now);
const find = (ctx: Pick<Context, 'list'>, kind: string, id: unknown) => ctx.list(kind).find(row => row.id === id);
const scoped = (ctx: Pick<Context, 'tenantId' | 'workspaceId'>, row: Data) => row.tenant_id === ctx.tenantId && row.workspace_id === ctx.workspaceId;
const prefix = (ctx: Context) => {
  if (!scopeId.test(ctx.tenantId) || !scopeId.test(ctx.workspaceId)) throw denied();
  return `t/${ctx.tenantId}/w/${ctx.workspaceId}`;
};

function publicFile(row: Row) {
  const { storage_key: _key, bucket: _bucket, ...result } = row;
  return result;
}

export function requireMediaFile(ctx: Pick<Context, 'tenantId' | 'workspaceId' | 'actorId' | 'role' | 'list'>, id: string, allowedPurposes?: readonly string[]) {
  const row = fileId.test(id) && find(ctx, FILE, id);
  if (!row || !scoped(ctx, row) || row.purpose === reportExportPurpose || row.deleted_at || !['clean', 'skipped'].includes(String(row.scan_status)) ||
    (allowedPurposes && !allowedPurposes.includes(String(row.purpose)))) throw missing();
  if (!READ.includes(ctx.role)) throw denied();
  if (['evidence', 'import', 'export', 'attachment'].includes(String(row.purpose)) &&
    row.created_by_id !== ctx.actorId && !ADMIN.includes(ctx.role)) throw missing();
  return row;
}

function usage(ctx: Context, row: Row, direction: 1 | -1) {
  ctx.create('usage_event', { tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, meter_key: 'storage_bytes',
    quantity: direction * Number(row.size_bytes), occurred_at: ctx.now,
    source_ref: { resource_type: FILE, resource_id: row.id, event_id: direction === 1 ? 'created' : 'deleted' } });
}

const fileRefs = ['asset_version', 'asset_rendition', 'brand', 'comment', 'message', 'inbox_message', 'import_batch', 'raw_record',
  'webhook_delivery', 'proof_package', 'rights_grant', 'case', 'publish_target', 'platform_post', 'execution_attempt', 'report_run',
  'diagnostic_bundle', 'submission', 'operation', 'operation_item', 'rival_post', 'post_operation', 'execution_attempt_step',
  'content_reference', 'publish_target_ref'] as const;
const refFields = ['file_object_id', 'thumbnail_file_id', 'thumbnail_file_object_id', 'logo_file_id', 'avatar_file_object_id', 'payload_file_object_id',
  'error_file_object_id', 'file_object_ids', 'asset_file_id', 'asset_file_ids', 'attachments', 'rendered_files', 'evidence_id', 'evidence_ids',
  'evidence_file_id', 'evidence_file_ids', 'evidence_file_object_id', 'evidence_ref', 'evidence_refs', 'source_ref', 'result_ref', 'terms', 'detail'] as const;
function mentions(value: unknown, ids: Set<string>): boolean {
  if (typeof value === 'string') return ids.has(value);
  if (Array.isArray(value)) return value.some(item => mentions(item, ids));
  return Boolean(value && typeof value === 'object' && Object.values(value).some(item => mentions(item, ids)));
}

export interface MediaPolicies {
  /** Include inherited policy and holds if the host stores tenant defaults separately. */
  retention?(ctx: Context, dataClass: string): Data | undefined;
  references?(ctx: Context, file: Row): readonly string[];
  /** Extend the known linked evidence types when wiring a new owning module. */
  evidenceResourceExists?(ctx: Context, kind: string, id: string): boolean | undefined;
}
const evidenceParents = ['execution_attempt', 'platform_post', 'publish_target', 'content_item', 'work', 'case', 'post_operation'];
const evidenceRows = (ctx: Context, row: Row) => ctx.list('evidence').filter(item => item.file_object_id === row.id && !item.deleted_at);

async function removeObject(storage: Storage, key: string) {
  try { await storage.remove(key); }
  catch (error) { if (!(error instanceof ObjectMissing)) throw error; }
}

/** Domain callers must authorize access to the parent before linking evidence. */
export function attachMediaEvidence(ctx: Context, id: string, parent: { kind: string; id: string }, options: {
  kind?: 'file' | 'screenshot' | 'screen_recording' | 'api_response' | 'ui_hierarchy' | 'webhook_payload'; masked?: boolean;
} = {}) {
  if (!WRITE.includes(ctx.role)) throw denied();
  const file = requireMediaFile(ctx, id, ['evidence']);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(parent.kind) || !scopeId.test(parent.id) || !find(ctx, parent.kind, parent.id)) throw missing();
  const kind = options.kind ?? 'file';
  if ((kind === 'screenshot' && !String(file.mime_type).startsWith('image/')) ||
    (kind === 'screen_recording' && !String(file.mime_type).startsWith('video/'))) throw invalid('Evidence MIME does not match its kind');
  return evidenceRows(ctx, file).find(row => row.linked_resource_type === parent.kind && row.linked_resource_id === parent.id && row.kind === kind) ??
    ctx.create('evidence', { tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, kind, file_object_id: file.id,
      content_hash: file.sha256, captured_at: ctx.now, captured_by: ctx.actorId, masked: options.masked ?? false,
      linked_resource_type: parent.kind, linked_resource_id: parent.id, retention_until: file.retention_until });
}

const retentionClass = (row: Row) => ({ asset: 'asset_file', evidence: 'evidence', export: 'export_file', report_export: 'export_file' })[String(row.purpose)] ?? String(row.purpose);

export function createMediaFiles({ storage, signingKey, probe = probeMedia, scan, policies = {}, workspacePath = '/api/v1/workspaces', maxBytes = MAX_BYTES }:
{ storage: Storage; signingKey: string | Buffer; probe?: Probe; scan?: (path: string) => Promise<'clean' | 'infected'>;
  policies?: MediaPolicies; workspacePath?: string;
  /** Upload ceiling for this host (config.maxUploadBytes, §6.5); at most MAX_UPLOAD_LIMIT. */
  maxBytes?: number }) {
  if (Buffer.byteLength(signingKey) < 32) throw new Error('Media signing key must be at least 32 bytes');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_UPLOAD_LIMIT) throw new Error('Invalid media upload limit');
  const workspaceUrl = (ctx: Context) => `${workspacePath}/${encodeURIComponent(ctx.workspaceId)}/files`;
  const policyFor = (ctx: Context, row: Row) => policies.retention?.(ctx, retentionClass(row)) ??
    ctx.list('retention_policy').find(item => item.data_class === retentionClass(row));
  const parentExists = (ctx: Context, kind: unknown, id: unknown) => typeof kind === 'string' && typeof id === 'string' &&
    (policies.evidenceResourceExists?.(ctx, kind, id) ?? (!evidenceParents.includes(kind) || !!find(ctx, kind, id)));
  const refsFor = (ctx: Context, row: Row, expiredEvidence: ReadonlySet<string> = new Set()) => {
    const evidence = evidenceRows(ctx, row);
    const ids = new Set([row.id, ...evidence.map(item => item.id)]);
    const refs = fileRefs.filter(kind => ctx.list(kind).some(item =>
      refFields.some(field => mentions(item[field], ids)))).map(String);
    if (evidence.some(item => !expiredEvidence.has(item.id))) refs.push('evidence');
    if (row.legal_hold === true || evidence.some(item => item.legal_hold === true) || policyFor(ctx, row)?.legal_hold === true) refs.push('legal_hold');
    refs.push(...(policies.references?.(ctx, row) ?? []));
    return [...new Set(refs)];
  };
  function upload(ctx: Context, id: string, includeCompleted = false) {
    if (!WRITE.includes(ctx.role)) throw denied();
    const row = fileId.test(id) && find(ctx, UPLOAD, id);
    if (!row || !scoped(ctx, row) || row.created_by_id !== ctx.actorId || row.bucket !== storage.bucket) throw missing();
    if (includeCompleted && row.file_object_id) return row;
    if (row.file_object_id || Date.parse(String(row.expires_at)) <= clock(ctx)) throw missing();
    return row;
  }
  function key(ctx: Context, row: Data, stage = false) {
    if (!scoped(ctx, row) || !fileId.test(String(row.object_nonce)) || row.bucket !== storage.bucket) throw missing();
    const expected = `${prefix(ctx)}/${stage ? 'staging' : 'objects'}/${row.object_nonce}`;
    if (row[stage ? 'staging_key' : 'storage_key'] !== expected) throw missing();
    return expected;
  }
  function begin(ctx: Context, input: Data) {
    if (!WRITE.includes(ctx.role)) throw denied();
    const { purpose = 'asset', mime_type, size_bytes, sha256, original_filename, retention_until } = input;
    if (!(purposes as readonly unknown[]).includes(purpose) || typeof mime_type !== 'string' || !mediaTypes.includes(mime_type)) throw invalid('Unsupported purpose or MIME type');
    if (typeof size_bytes !== 'number' || !Number.isSafeInteger(size_bytes) || size_bytes < 1 || size_bytes > maxBytes) throw invalid(`size_bytes must be between 1 and ${maxBytes}`);
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) throw invalid('A hex SHA-256 is required');
    if (original_filename !== undefined && (typeof original_filename !== 'string' || !original_filename.trim() ||
      Buffer.byteLength(original_filename) > 255 || /[\p{Cc}\p{Cf}\\/]/u.test(original_filename) || Buffer.from(original_filename).toString() !== original_filename)) throw invalid('Invalid filename');
    if (retention_until !== undefined && (!ADMIN.includes(ctx.role) || typeof retention_until !== 'string' ||
      retention_until.length > 40 || !Number.isFinite(Date.parse(retention_until)) || Date.parse(retention_until) <= clock(ctx))) throw invalid('Invalid retention deadline');
    if (ctx.list(UPLOAD).filter(row => !row.file_object_id && Date.parse(String(row.expires_at)) > clock(ctx)).length >= 32) {
      throw new Problem(429, 'UPLOAD_LIMIT', 'Too many pending uploads');
    }
    const nonce = randomUUID();
    const owner = prefix(ctx);
    const expires_at = new Date(clock(ctx) + uploadSeconds * 1000).toISOString();
    const row = ctx.create(UPLOAD, { tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, created_by_id: ctx.actorId,
      purpose, size_bytes, sha256: sha256.toLowerCase(), mime_type,
      original_filename: original_filename ?? null, retention_until: typeof retention_until === 'string' ? new Date(retention_until).toISOString() : null,
      object_nonce: nonce, bucket: storage.bucket, staging_key: `${owner}/staging/${nonce}`, storage_key: `${owner}/objects/${nonce}`, expires_at });
    return { id: row.id, expires_at, max_inline_bytes: INLINE_BYTES, direct_upload: Boolean(storage.presignUpload) };
  }
  function direct(ctx: Context, id: string) {
    const row = upload(ctx, id);
    if (!storage.presignUpload) throw new Problem(409, 'DIRECT_UPLOAD_UNAVAILABLE', 'Use the workspace byte upload');
    const seconds = Math.floor((Date.parse(String(row.expires_at)) - Math.max(clock(ctx), Date.now())) / 1000);
    if (seconds < 1) throw missing();
    return { ...storage.presignUpload(key(ctx, row, true), Number(row.size_bytes), seconds), expires_at: row.expires_at };
  }
  async function storageCall<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); }
    catch (error) {
      if (error instanceof Problem) throw error;
      if (error instanceof ObjectMissing) throw missing();
      if (error instanceof InvalidMedia) throw invalid(error.message);
      if (error instanceof MediaUnavailable) throw unavailable();
      throw unavailable();
    }
  }
  function snapshot<T>(source: Readable, row: Row, use: (path: string) => Promise<T>) {
    return storageCall(() => withSnapshot(source, Number(row.size_bytes), String(row.sha256), use, { maxBytes }));
  }
  async function stage(ctx: Context, id: string, source: Readable, length?: number) {
    const row = upload(ctx, id);
    const size = Number(row.size_bytes);
    if (length !== undefined && length !== size) throw invalid('Content-Length does not match the reservation');
    const stagingKey = key(ctx, row, true);
    await snapshot(source, row, path => storage.write(stagingKey, { path, size, sha256: String(row.sha256), mime: 'application/octet-stream' }));
    return { id, size_bytes: size };
  }
  async function complete(ctx: Context, id: string, encoded?: unknown) {
    const ticket = upload(ctx, id, true);
    if (ticket.file_object_id) return publicFile(requireMediaFile(ctx, String(ticket.file_object_id)));
    const size = Number(ticket.size_bytes);
    const mime = String(ticket.mime_type);
    let source: Readable;
    if (encoded !== undefined) {
      if (size > INLINE_BYTES) throw new Problem(413, 'INLINE_LIMIT', 'Use the streamed or direct upload');
      if (typeof encoded !== 'string' || encoded.length !== Math.ceil(size / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalid('Invalid base64');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length !== size || bytes.toString('base64') !== encoded) throw invalid('Invalid base64');
      source = Readable.from([bytes]);
    } else {
      const stored = await storageCall(() => storage.read(key(ctx, ticket, true)));
      if (stored.size !== size) { stored.stream.destroy(); throw invalid('Staged object has the wrong size'); }
      source = stored.stream;
    }
    const storage_key = key(ctx, ticket);
    const { meta, scan_status } = await snapshot(source, ticket, async path => {
      const scan_status = scan ? await scan(path) : 'skipped';
      if (scan_status !== 'clean' && scan_status !== 'skipped') throw invalid('File did not clear scanning');
      const meta = await probe(path, mime);
      await storage.write(storage_key, { path, size, sha256: String(ticket.sha256), mime });
      return { meta, scan_status };
    });
    const row = ctx.create(FILE, { tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, created_by_id: ctx.actorId,
      storage_key, object_nonce: ticket.object_nonce, bucket: storage.bucket, mime_type: mime, size_bytes: size, sha256: ticket.sha256,
      original_filename: ticket.original_filename, scan_status, purpose: ticket.purpose, retention_until: ticket.retention_until,
      deleted_at: null, meta });
    usage(ctx, row, 1);
    ctx.update(UPLOAD, ticket.id, { file_object_id: row.id });
    ctx.emit('core.file_object.created', { file_object_id: row.id, purpose: row.purpose });
    return publicFile(row);
  }
  function markDeleted(ctx: Context, row: Row) {
    ctx.update(FILE, row.id, { deleted_at: ctx.now });
    usage(ctx, row, -1);
    ctx.emit('core.file_object.deleted', { file_object_id: row.id });
  }
  function retentionDeadline(row: Row, policy: Data | undefined) {
    const explicit = typeof row.retention_until === 'string' ? Date.parse(row.retention_until) : NaN;
    const fixed = policy?.retain_mode !== 'follow_resource' && typeof policy?.retain_days === 'number' && policy.retain_days >= 0
      ? Date.parse(String(row.captured_at ?? row.created_at)) + policy.retain_days * day : NaN;
    return Math.max(Number.isFinite(explicit) ? explicit : -Infinity, Number.isFinite(fixed) ? fixed : -Infinity);
  }
  function remove(ctx: Context, id: string) {
    if (!ADMIN.includes(ctx.role)) throw denied();
    const row = find(ctx, FILE, id);
    if (!row || !scoped(ctx, row)) throw missing();
    if (!row.deleted_at) {
      const blocked_by = refsFor(ctx, row);
      if (retentionDeadline(row, policyFor(ctx, row)) > clock(ctx)) blocked_by.push('retention_period');
      if (blocked_by.length) throw new Problem(409, 'FILE_REFERENCED', 'File is still referenced', { blocked_by });
      markDeleted(ctx, row);
    }
    return { id, deleted: true };
  }
  function retentionCandidates(ctx: Context, dataClass?: string) {
    if (!ADMIN.includes(ctx.role)) throw denied();
    return ctx.list(FILE).flatMap(row => {
      if (!scoped(ctx, row) || row.deleted_at || (dataClass && retentionClass(row) !== dataClass)) return [];
      const policy = policyFor(ctx, row);
      if (policy?.action && policy.action !== 'delete') return [];
      const evidence = evidenceRows(ctx, row);
      const expires = (item: Row) => {
        const deadline = retentionDeadline(item, policy);
        return deadline !== -Infinity && deadline <= clock(ctx);
      };
      const expiredEvidence = new Set(evidence.filter(item => expires(item) ||
        retentionDeadline(item, policy) === -Infinity && (!policy || policy.retain_mode === 'follow_resource') &&
        typeof item.linked_resource_id === 'string' && !parentExists(ctx, item.linked_resource_type, item.linked_resource_id)).map(item => item.id));
      if (retentionDeadline(row, policy) > clock(ctx) || (!expires(row) && (!evidence.length || expiredEvidence.size !== evidence.length))) return [];
      return [{ id: row.id, version: row.version, blocked_by: refsFor(ctx, row, expiredEvidence), evidence: [...expiredEvidence] }];
    });
  }
  function purge(ctx: Context, requested: unknown) {
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 100) throw invalid('Supply 1 to 100 file previews');
    return purgeReviewed(ctx, requested);
  }
  function purgeReviewed(ctx: Context, requested: readonly { id: string; version: number }[], dataClass?: string) {
    const candidates = new Map(retentionCandidates(ctx, dataClass).map(item => [item.id, item]));
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const item of requested) {
      if (!item || typeof item.id !== 'string' || !fileId.test(item.id) || !Number.isSafeInteger(item.version)) throw invalid('Invalid file preview');
      const current = candidates.get(item.id);
      candidates.delete(item.id);
      if (!current || current.blocked_by.length || current.version !== item.version) { skipped.push(item.id); continue; }
      for (const id of current.evidence) ctx.update('evidence', id, { deleted_at: ctx.now });
      markDeleted(ctx, ctx.get(FILE, item.id));
      deleted.push(item.id);
    }
    return { deleted, skipped };
  }
  /** Call only in a later transaction than complete/remove/purge. Failed object deletes remain retryable. */
  async function cleanup(ctx: Context) {
    if (!ADMIN.includes(ctx.role)) throw denied();
    const pending: { kind: string; row: Row }[] = [
      ...ctx.list(UPLOAD).filter(row => scoped(ctx, row) && Date.parse(String(row.expires_at)) + cleanupGrace <= clock(ctx)).map(row => ({ kind: UPLOAD, row })),
      ...ctx.list(FILE).filter(row => scoped(ctx, row) && row.deleted_at && !row.storage_deleted_at).map(row => ({ kind: FILE, row })),
    ].sort((a, b) => String(a.row.cleanup_attempted_at ?? '').localeCompare(String(b.row.cleanup_attempted_at ?? ''))).slice(0, 20);
    let cleaned = 0;
    let failed = 0;
    for (const { kind, row } of pending) {
      try {
        if (kind === UPLOAD) {
          await removeObject(storage, key(ctx, row, true));
          if (!row.file_object_id) await removeObject(storage, key(ctx, row));
        } else await removeObject(storage, key(ctx, row));
      } catch {
        ctx.update(kind, row.id, { cleanup_attempted_at: ctx.now });
        failed++;
        continue;
      }
      if (kind === UPLOAD) ctx.remove(UPLOAD, row.id);
      else ctx.update(FILE, row.id, { storage_deleted_at: ctx.now });
      cleaned++;
    }
    return { cleaned, failed };
  }
  function mac(ctx: Context, id: string, deadline: string, inline: boolean) {
    return createHmac('sha256', signingKey).update(JSON.stringify(['media-download-v1', ctx.tenantId, ctx.workspaceId, ctx.actorId, id, deadline, inline])).digest('base64url');
  }
  async function storeReportExport(ctx: Context, operationId: string, bytes: Buffer, mime: string, filename: string) {
    const row = { tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, created_by_id: ctx.actorId,
      purpose: reportExportPurpose, report_export_operation_id: operationId, object_nonce: operationId,
      bucket: storage.bucket, storage_key: `${prefix(ctx)}/objects/${operationId}`, mime_type: mime,
      original_filename: filename, scan_status: 'skipped', size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    const objectKey = key(ctx, row);
    // Recover a completed object write if the surrounding transaction rolled back.
    await storageCall(async () => {
      let stored;
      try { stored = await storage.read(objectKey); }
      catch (error) { if (!(error instanceof ObjectMissing)) throw error; }
      if (stored) await withSnapshot(stored.stream, bytes.length, row.sha256, async () => undefined, { maxBytes });
      else await withSnapshot(Readable.from([bytes]), bytes.length, row.sha256,
        path => storage.write(objectKey, { path, size: bytes.length, sha256: row.sha256, mime }), { maxBytes });
    });
    const file = ctx.create(FILE, row);
    usage(ctx, file, 1);
    ctx.emit('core.file_object.created', { file_object_id: file.id, purpose: file.purpose });
    return file;
  }

  async function discardReportExport(ctx: Context, operationId: string) {
    if (!fileId.test(operationId)) throw missing();
    await storageCall(() => removeObject(storage, `${prefix(ctx)}/objects/${operationId}`));
  }

  async function readReportExport(ctx: Context, id: string, operationId: string) {
    const row = find(ctx, FILE, id);
    if (!row || row.deleted_at || row.purpose !== reportExportPurpose || row.report_export_operation_id !== operationId ||
      row.object_nonce !== operationId) throw missing();
    const stored = await storageCall(() => storage.read(key(ctx, row)));
    return { ...stored, mime: String(row.mime_type), filename: String(row.original_filename) };
  }

  function download(ctx: Context, id: string, preview = false) {
    const row = requireMediaFile(ctx, id);
    key(ctx, row);
    const inline = preview && canPreview(String(row.mime_type));
    const deadline = String(Math.floor(clock(ctx) / 1000) + downloadSeconds);
    const token = `${deadline}.${inline ? '1' : '0'}.${mac(ctx, id, deadline, inline)}`;
    return { url: `${workspaceUrl(ctx)}/${id}/bytes?token=${token}`, expires_at: new Date(Number(deadline) * 1000).toISOString() };
  }
  async function read(ctx: Context, id: string, token: unknown, rangeHeader?: string, ifRange?: string) {
    const match = typeof token === 'string' && token.length <= 64 && /^(\d{1,12})\.([01])\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match || Number(match[1]) * 1000 <= clock(ctx) || !timingSafeEqual(Buffer.from(mac(ctx, id, match[1], match[2] === '1')), Buffer.from(match[3]))) throw missing();
    const row = requireMediaFile(ctx, id);
    const etag = `"${row.sha256}"`;
    const range = ifRange && ifRange !== etag ? undefined : parseRange(rangeHeader, Number(row.size_bytes));
    const stored = await storageCall(() => storage.read(key(ctx, row), range));
    if (stored.size !== row.size_bytes) { stored.stream.destroy(); throw unavailable(); }
    return { ...stored, etag, range, mime: String(row.mime_type), filename: String(row.original_filename ?? 'download'), inline: match[2] === '1' };
  }
  async function withMediaSource<T>(ctx: Context, id: string, use: (path: string, mime: string) => Promise<T>) {
    const row = requireMediaFile(ctx, id);
    const stored = await storageCall(() => storage.read(key(ctx, row)));
    if (stored.size !== row.size_bytes) { stored.stream.destroy(); throw unavailable(); }
    return snapshot(stored.stream, row, path => use(path, String(row.mime_type)));
  }
  const operation = (method: Operation['method'], path: string, name: string, roles: Operation['roles'], summary: string, run: Operation['run']): Operation =>
    ({ method, path, name, roles, summary, run });
  const operations = [
    operation('POST', '/files/uploads', 'file_begin_upload', WRITE, 'Reserve a file upload', (ctx, { body }) => begin(ctx, body)),
    operation('GET', '/files/uploads/:id/direct', 'file_direct_upload', WRITE, 'Issue a short-lived S3 staging PUT', (ctx, { params }) => direct(ctx, params.id)),
    operation('POST', '/files/uploads/:id/complete', 'file_complete_upload', WRITE, 'Verify and publish uploaded bytes', (ctx, { params, body }) => complete(ctx, params.id, body.base64)),
    operation('GET', '/files/:id', 'file_get', READ, 'Get verified file metadata', (ctx, { params }) => publicFile(requireMediaFile(ctx, params.id))),
    operation('GET', '/files/:id/download', 'file_download', READ, 'Issue an actor-bound short-lived download URL', (ctx, { params, query }) => download(ctx, params.id, query.inline === 'true')),
    operation('DELETE', '/files/:id', 'file_delete', ADMIN, 'Tombstone and meter an unreferenced file', (ctx, { params }) => remove(ctx, params.id)),
    operation('GET', '/files/retention/preview', 'file_retention_preview', ADMIN, 'Preview eligible and blocked files', ctx => ({ candidates: retentionCandidates(ctx) })),
    operation('POST', '/files/retention/purge', 'file_retention_purge', ADMIN, 'Tombstone reviewed files after rechecking retention and references', (ctx, { body }) => purge(ctx, body.files)),
    operation('POST', '/files/cleanup', 'file_cleanup', ADMIN, 'Retry expired staging and tombstone cleanup', ctx => cleanup(ctx)),
  ];
  return { operations, begin, stage, complete, retentionCandidates, purge, purgeReviewed, cleanup, download, read, withMediaSource, workspacePath,
    storeReportExport, discardReportExport, readReportExport, storage, maxBytes };
}

/** Parse a single `Range: bytes=…` header against an object size; throws 416 when unsatisfiable. */
export function parseByteRange(header: string | undefined, size: number): ByteRange | undefined { return parseRange(header, size); }

function parseRange(header: string | undefined, size: number): ByteRange | undefined {
  if (header === undefined) return;
  const reject = () => new Problem(416, 'RANGE_NOT_SATISFIABLE', 'A single satisfiable byte range is required', { size });
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw reject();
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start > end || start >= size) throw reject();
  return { start, end };
}

export type MediaFiles = ReturnType<typeof createMediaFiles>;
export interface MediaHttpServices {
  /** Authenticate and resolve workspace membership on every request. For write=true enforce CSRF and serialize writes. */
  workspace<T>(request: FastifyRequest, workspaceId: string, write: boolean, run: (ctx: Context) => Promise<T>): Promise<T>;
}

export function registerMediaFiles(app: FastifyInstance, media: MediaFiles, services: MediaHttpServices, { mountOperations = false } = {}) {
  const protect = (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer').header('cross-origin-resource-policy', 'same-origin');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw denied();
  };
  app.register(async router => {
    router.setErrorHandler((error, _request, reply) => {
      if (error instanceof Problem) {
        if (error.status === 416) reply.header('content-range', `bytes */${error.details?.size}`);
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      }
      const status = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status ?? 500;
      return reply.code(status).send({ error: { code: 'FILE_REQUEST_FAILED', message: 'File request failed' } });
    });
    router.addHook('onRequest', async (request, reply) => protect(request, reply));
    router.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));
    type Params = { ws: string; id: string };
    if (mountOperations) for (const operation of media.operations) {
      router.route<{ Params: Params; Querystring: Record<string, string> }>({
        method: operation.method, url: `${media.workspacePath}/:ws${operation.path}`, bodyLimit: 1024 * 1024,
        async handler(request) {
          const { ws, ...params } = request.params;
          const write = operation.method !== 'GET';
          if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
            request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')) throw invalid('Expected a JSON object');
          return { data: await services.workspace(request, ws, write, async ctx => {
            if (!operation.roles.includes(ctx.role)) throw denied();
            return operation.run(ctx, { params, query: request.query, body: (request.body ?? {}) as Data });
          }) };
        },
      });
    }
    router.put<{ Params: Params; Body: Readable }>(`${media.workspacePath}/:ws/files/uploads/:id/bytes`, async request => {
      const length = request.headers['content-length'];
      if (typeof length !== 'string' || !/^\d{1,10}$/.test(length)) throw new Problem(411, 'LENGTH_REQUIRED', 'Content-Length is required');
      if (Number(length) > media.maxBytes) throw new Problem(413, 'FILE_TOO_LARGE', 'File exceeds upload limit');
      const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/octet-stream' || !(request.body instanceof Readable) || request.headers['content-encoding']) {
        throw new Problem(415, 'BINARY_REQUIRED', 'Expected unencoded application/octet-stream');
      }
      return { data: await services.workspace(request, request.params.ws, true, ctx => media.stage(ctx, request.params.id, request.body, Number(length))) };
    });
    router.get<{ Params: Params; Querystring: { token?: string } }>(`${media.workspacePath}/:ws/files/:id/bytes`, { exposeHeadRoute: false }, async (request, reply) => {
      const ifRange = request.headers['if-range'];
      const data = await services.workspace(request, request.params.ws, false, ctx => media.read(ctx, request.params.id, request.query.token, request.headers.range, typeof ifRange === 'string' ? ifRange : undefined));
      try {
        reply.type(data.mime).header('content-disposition', `${data.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(data.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`)
          .header('accept-ranges', 'bytes').header('etag', data.etag).header('content-security-policy', "default-src 'none'; sandbox");
        if (data.range) reply.code(206).header('content-range', `bytes ${data.range.start}-${data.range.end}/${data.size}`);
        reply.header('content-length', data.range ? data.range.end - data.range.start + 1 : data.size);
        return reply.send(data.stream);
      } catch (error) {
        data.stream.destroy();
        throw error;
      }
    });
  });
}

/**
 * @deprecated Hosts call mediaStorageFromConfig(config) (§6.7): the directory follows the data file in every mode.
 * Kept only for the unmounted modules/files entry; it no longer branches on the Node environment (hub audit, §2.2).
 */
export function mediaStorageFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return mediaStorageFromConfig({ mediaDirectory: env.MEDIA_DIRECTORY ?? '.local/media' }, env);
}

/** Local directory or S3 bucket for media objects; the directory follows the data file (§6.7), never process.cwd(). */
export function mediaStorageFromConfig(config: Pick<Config, 'mediaDirectory'>, env: NodeJS.ProcessEnv = process.env): Storage {
  if (env.MEDIA_S3_ENDPOINT) return s3Storage({ endpoint: env.MEDIA_S3_ENDPOINT, publicEndpoint: env.MEDIA_S3_PUBLIC_ENDPOINT,
    bucket: env.MEDIA_S3_BUCKET ?? '', region: env.MEDIA_S3_REGION, accessKey: env.MEDIA_S3_ACCESS_KEY ?? '', secretKey: env.MEDIA_S3_SECRET_KEY ?? '' });
  if (!config.mediaDirectory) throw new Error('Media storage must be configured');
  return localStorage(config.mediaDirectory);
}

// ---------- Assembled agent uploads (§6.4 step 3, C5): IO outside the transaction, a short write inside ----------

/** Normalized video/image metadata stored on asset_version.meta and file_object.meta (§3.8). */
export interface MediaMeta { duration_ms: number | null; width: number | null; height: number | null; codec: string | null; has_audio: boolean | null }
/** What prepareAssembledObject wrote to storage; recordAssembledObject links it in one short transaction. */
export interface PreparedObject {
  tenant_id: string; workspace_id: string; bucket: string; storage_key: string; object_nonce: string;
  byte_size: number; sha256: string; filename: string;
  /** MIME detected from the stored bytes; replaces the declared value on asset_version (§3.8). */
  mime: string; declared_mime: string;
  meta: MediaMeta | null;
  /** ok: ffprobe read the streams; unavailable: no ffprobe on the hub (§6.5); invalid: ffprobe could not read the container. */
  probe: 'ok' | 'unavailable' | 'invalid';
}
export interface PrepareOptions {
  probe?: Probe;
  /** How long to wait for a free media process slot before recording the object without metadata. */
  busyRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function mediaMeta(source: MediaMetadata): MediaMeta {
  const duration = typeof source.duration_seconds === 'number' ? Math.round(source.duration_seconds * 1000) : null;
  return { duration_ms: duration, width: source.width ?? null, height: source.height ?? null,
    codec: source.video_codec ?? source.audio_codec ?? null,
    has_audio: source.video_codec || source.audio_codec ? typeof source.audio_codec === 'string' : null };
}

/**
 * Probe an assembled, hash-verified upload and hand it to storage. Needs no Context and must run outside every store
 * transaction: a 1 GB copy or a 60 s ffprobe inside one would stall all Worker heartbeats (§0 rule 8, §12.1 risk 6).
 */
export async function prepareAssembledObject(storage: Storage, input: { path: string; sha256: string; size: number; mime: string; filename: string;
  workspaceId: string; tenantId: string }, options: PrepareOptions = {}): Promise<PreparedObject> {
  const { path, sha256, size, mime: declared, filename, workspaceId, tenantId } = input;
  if (!scopeId.test(tenantId) || !scopeId.test(workspaceId)) throw denied();
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 1) throw invalid('Invalid assembled object');
  const file = await openFile(path, 'r');
  const prefix = Buffer.alloc(64);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== size) throw new Problem(422, 'UPLOAD_HASH_MISMATCH', 'Assembled size does not match the upload');
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    prefix.fill(0, bytesRead);
  } finally { await file.close(); }
  const mime = sniffMime(prefix);
  if (!mime) throw new Problem(422, 'UPLOAD_TYPE_UNSUPPORTED', 'The uploaded bytes are not an accepted video or image');
  const probe = options.probe ?? probeMedia;
  const sleep = options.sleep ?? delay;
  let meta: MediaMeta | null = null;
  let status: PreparedObject['probe'] = 'unavailable';
  for (let waited = 0; ; waited += 1000) {
    try {
      meta = mediaMeta(await probe(path, mime, { timeoutMs: probeTimeoutMs(size) }));
      status = 'ok';
    } catch (error) {
      if (error instanceof MediaToolBusy && waited < (options.busyRetryMs ?? 30_000)) { await sleep(1000); continue; }
      if (error instanceof InvalidMedia) status = 'invalid';
      else if (!(error instanceof MediaToolMissing || error instanceof MediaUnavailable)) throw error;
    }
    break;
  }
  const object_nonce = randomUUID();
  const storage_key = `t/${tenantId}/w/${workspaceId}/objects/${object_nonce}`;
  const object = { path, size, sha256, mime };
  if (storage.move) await storage.move(storage_key, object);
  else await storage.write(storage_key, object);
  return { tenant_id: tenantId, workspace_id: workspaceId, bucket: storage.bucket, storage_key, object_nonce, byte_size: size, sha256,
    filename, mime, declared_mime: declared, meta, probe: status };
}

/** Remove an object prepared for a link that did not commit. */
export async function discardPreparedObject(storage: Storage, prepared: Pick<PreparedObject, 'storage_key'>) {
  await removeObject(storage, prepared.storage_key);
}

/**
 * Short write: create the file_object, attach it to the asset_version, mark the asset ready and emit
 * asset.version.created so prechecks re-evaluate jobs waiting on media (§6.4 step 3.4). Does no IO.
 */
export function recordAssembledObject(ctx: Context, prepared: PreparedObject, link: { asset_id: string; asset_version_id: string; createdBy: string }):
{ file_object_id: string; meta: MediaMeta | null; reused?: true } {
  if (prepared.tenant_id !== ctx.tenantId || prepared.workspace_id !== ctx.workspaceId) throw denied();
  if (prepared.storage_key !== `${prefix(ctx)}/objects/${prepared.object_nonce}` || !fileId.test(prepared.object_nonce)) throw denied();
  const asset = ctx.get('asset', link.asset_id);
  const version = ctx.get('asset_version', link.asset_version_id);
  if (version.asset_id !== asset.id) throw missing();
  if (version.sha256 !== prepared.sha256) throw new Problem(409, 'UPLOAD_HASH_MISMATCH', 'The stored object does not match this asset version');
  if (typeof version.file_object_id === 'string') {
    const existing = find(ctx, FILE, version.file_object_id);
    if (existing && existing.sha256 === prepared.sha256 && !existing.deleted_at) return { file_object_id: existing.id, meta: (version.meta ?? null) as MediaMeta | null, reused: true };
  }
  const row = ctx.create(FILE, { tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, created_by_id: link.createdBy,
    storage_key: prepared.storage_key, object_nonce: prepared.object_nonce, bucket: prepared.bucket, mime_type: prepared.mime,
    size_bytes: prepared.byte_size, sha256: prepared.sha256, original_filename: prepared.filename, scan_status: 'skipped', purpose: 'asset',
    retention_until: null, deleted_at: null, meta: prepared.meta, probe_status: prepared.probe });
  usage(ctx, row, 1);
  ctx.update('asset_version', version.id, { file_object_id: row.id, mime_type: prepared.mime, meta: prepared.meta });
  ctx.update('asset', asset.id, { status: 'ready', current_version_id: version.id,
    kind: prepared.mime.startsWith('video/') ? 'video' : 'image' });
  ctx.emit('core.file_object.created', { file_object_id: row.id, purpose: 'asset' });
  ctx.emit('asset.version.created', { asset_id: asset.id, asset_version_id: version.id, version_no: Number(version.version_no ?? 1), source: 'agent_upload' });
  ctx.emit('asset.asset.ready', { asset_id: asset.id, asset_version_id: version.id });
  return { file_object_id: row.id, meta: prepared.meta };
}

/**
 * Open a stored object for streaming, optionally one inclusive byte range. Needs no Context, so the signed device
 * download route (§6.6, S3) authorizes in a short transaction and streams after it ends.
 */
export async function openMediaRange(storage: Storage, object: { storage_key: string; byte_size: number }, range?: { start: number; end: number }):
Promise<{ stream: Readable; size: number; start: number; end: number }> {
  const size = object.byte_size;
  if (!Number.isSafeInteger(size) || size < 1) throw unavailable();
  if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.start >= size)) {
    throw new Problem(416, 'RANGE_NOT_SATISFIABLE', 'A single satisfiable byte range is required', { size });
  }
  const window = range ? { start: range.start, end: Math.min(range.end, size - 1) } : { start: 0, end: size - 1 };
  let stored;
  try { stored = await storage.read(object.storage_key, range ? window : undefined); }
  catch (error) {
    if (error instanceof ObjectMissing) throw missing();
    throw unavailable();
  }
  if (stored.size !== size) { stored.stream.destroy(); throw unavailable(); }
  return { stream: stored.stream, size, ...window };
}
