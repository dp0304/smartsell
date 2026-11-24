import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Problem, type Context, type Row } from '@smartsell/contracts';
import type { Storage } from '../../../../../packages/media-store/src/storage.js';
import { openMediaRange, parseByteRange } from '../../extensions/media-files.js';
import { provideWorkerDownloadDeviceAuth } from '../../worker-downloads.js';
import type { SignedDeviceRequest } from '../account/device-control.js';
import { hostCaches, refreshHostCaches } from './host-cache.js';
import { EVIDENCE_MAX_BYTES, authorizeEvidence, authorizeMediaRead, recordEvidence } from './media.js';
import { sha256, workerHost } from './model.js';

/** The two signed calls of the account gateway the file routes need (account/gateway.ts). */
export interface SignedGateway {
  signed<T>(action: string, rawBody: Uint8Array, signed: SignedDeviceRequest, workspaceHint: string | undefined, bodyLimit: number,
    run: (ctx: Context, device: Row) => T | Promise<T>): Promise<T>;
  continued<T>(deviceId: string, workspaceHint: string | undefined, run: (ctx: Context, device: Row) => T | Promise<T>): Promise<T>;
}
export interface WorkerDeviceFiles { storage?: Storage }

const EMPTY = new Uint8Array(0);
const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};
const required = (request: FastifyRequest, name: string) => {
  const value = header(request, name);
  if (!value || value.length > 512) throw new Problem(401, 'INVALID_DEVICE_PROOF', `Missing ${name}`);
  return value;
};
function signedFrom(request: FastifyRequest): SignedDeviceRequest {
  return { device_id: required(request, 'x-smartsell-device'), timestamp: required(request, 'x-smartsell-timestamp'),
    nonce: required(request, 'x-smartsell-nonce'), signature: required(request, 'x-smartsell-signature') };
}
const workspaceOf = (request: FastifyRequest) => header(request, 'x-smartsell-workspace');
const opaque = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Problem(422, 'INVALID_DEVICE_REQUEST', `Invalid ${name}`);
  return value;
};
const fenceOf = (request: FastifyRequest) => {
  const value = Number(header(request, 'x-smartsell-fence'));
  if (!Number.isSafeInteger(value) || value < 0) throw new Problem(422, 'INVALID_DEVICE_REQUEST', 'Invalid x-smartsell-fence');
  return value;
};
const storageOf = (files: WorkerDeviceFiles) => {
  const storage = files.storage ?? workerHost().storage;
  if (!storage) throw new Problem(503, 'MEDIA_UNAVAILABLE', 'Media storage is not configured on this hub');
  return storage;
};

/** §8.18: Workers download their own updates with a device signature (worker_download.read:<platform>, empty body). */
export function provideSignedWorkerDownloads(app: FastifyInstance, gateway: SignedGateway) {
  provideWorkerDownloadDeviceAuth(app, (request, action) => gateway.signed(action, EMPTY, signedFrom(request), workspaceOf(request), 0, () => true));
}

/**
 * Signed GET/PUT device routes (§5.4, Appendix B.2) inside the account ingress plugin, which keeps raw bodies as Buffers.
 * Each verifies the signature and authorization in one short transaction and does its IO after it (§0 rule 8).
 */
export function mountWorkerDeviceFiles(ingress: FastifyInstance, gateway: SignedGateway, files: WorkerDeviceFiles) {
  ingress.get<{ Params: { file_id: string } }>('/api/v1/device/media/:file_id', { exposeHeadRoute: false }, async (request, reply: FastifyReply) => {
    const fileId = opaque(request.params.file_id, 'file_id');
    const jobId = opaque(header(request, 'x-smartsell-job'), 'x-smartsell-job');
    const fence = fenceOf(request);
    const object = await gateway.signed(`media.read:${fileId}:${jobId}:${fence}`, EMPTY, signedFrom(request), workspaceOf(request), 0,
      (ctx, device) => authorizeMediaRead(ctx, device, { fileId, jobId, fence }));
    const etag = `"${object.sha256}"`;
    const ifRange = header(request, 'if-range');
    const wanted = ifRange && ifRange !== etag ? undefined : header(request, 'range');
    const range = parseByteRange(wanted, object.byte_size);
    const opened = await openMediaRange(storageOf(files), object, range);
    reply.header('content-type', object.mime).header('etag', etag).header('cache-control', 'no-store').header('accept-ranges', 'bytes')
      .header('content-length', String(opened.end - opened.start + 1));
    if (range) reply.code(206).header('content-range', `bytes ${opened.start}-${opened.end}/${opened.size}`);
    return reply.send(opened.stream);
  });

  ingress.put<{ Params: { job_id: string } }>('/api/v1/device/evidence/:job_id', { bodyLimit: EVIDENCE_MAX_BYTES + 1024 }, async request => {
    const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const jobId = opaque(request.params.job_id, 'job_id');
    const fence = fenceOf(request);
    const mime = (header(request, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
    const hash = sha256(bytes);
    const upload = { jobId, fence, sha256: hash, mime, size: bytes.byteLength };
    const first = await gateway.signed(`evidence.upload:${jobId}:${fence}`, bytes, signedFrom(request), workspaceOf(request), EVIDENCE_MAX_BYTES,
      (ctx, device) => ({ device_id: device.id, duplicate: authorizeEvidence(ctx, device, upload).duplicate?.id, tenant: ctx.tenantId, workspace: ctx.workspaceId }));
    if (first.duplicate) return { data: { sha256: hash, file_object_id: first.duplicate, duplicate: true } };
    const storage = storageOf(files);
    const nonce = randomUUID();
    const key = `t/${first.tenant}/w/${first.workspace}/objects/${nonce}`;
    const temp = join(tmpdir(), `smartsell-evidence-${nonce}`);
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      await storage.write(key, { path: temp, size: bytes.byteLength, sha256: hash, mime });
    } finally { await rm(temp, { force: true }); }
    const recorded = await gateway.continued(first.device_id, workspaceOf(request),
      (ctx, device) => recordEvidence(ctx, device, { ...upload, storage_key: key, object_nonce: nonce, bucket: storage.bucket }));
    if ('orphan' in recorded) await storage.remove(key).catch(() => {});
    return { data: { sha256: hash, file_object_id: recorded.file_object_id, ...('duplicate' in recorded && { duplicate: true }) } };
  });

  ingress.get('/api/v1/device/driver-config', { exposeHeadRoute: false }, async (request, reply) => {
    await refreshHostCaches();
    await gateway.signed('driver_config.read', EMPTY, signedFrom(request), workspaceOf(request), 0, () => true);
    const bytes = hostCaches().driverConfigBytes();
    // Never an empty table: a hub without a selector file says so (S1 ledger 3).
    if (!bytes) throw new Problem(404, 'DRIVER_CONFIG_NOT_FOUND', 'No driver selector file is installed on this hub (run pnpm hub:update)');
    return reply.type('application/json').header('etag', `"${sha256(bytes)}"`).send(bytes);
  });
}
