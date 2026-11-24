import { Problem, type Context, type Data, type PublishPostPayload, type Row } from '@smartsell/contracts';
import { JOB, isTerminal, locate } from './model.js';

export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const EVIDENCE_PER_JOB = 20;
const EVIDENCE_MIME = ['image/jpeg', 'image/png'] as const;

/**
 * §6.6 authorization for the signed media download, inside a short read transaction: the job is assigned to this machine,
 * its fence matches, it is not terminal and its payload lists the file. A stale fence is 409 JOB_FENCE_LOST (S6 ledger 2).
 */
export function authorizeMediaRead(ctx: Context, device: Row, input: { fileId: string; jobId: string; fence: number }) {
  const job = locate(ctx, JOB, input.jobId);
  if (!job || job.device_id !== device.id) throw new Problem(403, 'MEDIA_FORBIDDEN', 'This machine is not assigned to the job');
  if (Number(job.fencing_token) !== input.fence) throw new Problem(409, 'JOB_FENCE_LOST', 'The lease for this job has moved on');
  if (isTerminal(job)) throw new Problem(403, 'MEDIA_FORBIDDEN', 'The job has ended');
  const media = job.kind === 'publish_post' ? (job.payload as PublishPostPayload).media ?? [] : [];
  const item = media.find(entry => entry.file_id === input.fileId);
  if (!item) throw new Problem(403, 'MEDIA_FORBIDDEN', 'The job does not use this file');
  const file = locate(ctx, 'file_object', input.fileId);
  if (!file || file.deleted_at || typeof file.storage_key !== 'string') throw new Problem(404, 'MEDIA_NOT_FOUND', 'The file is not stored on this hub');
  const size = Number(file.size_bytes ?? file.byte_size);
  return { storage_key: file.storage_key, byte_size: size, sha256: String(file.sha256 ?? item.sha256), mime: String(file.mime_type ?? item.mime ?? 'application/octet-stream') };
}

export interface EvidenceUpload { jobId: string; fence: number; sha256: string; mime: string; size: number }

/**
 * §8.13 checks before any byte is stored: the machine is in the job's device_history (the fence need not match — evidence
 * follows facts), JPEG/PNG, at most 4 MiB, at most 20 per job. A hash already stored for the job is a duplicate.
 */
export function authorizeEvidence(ctx: Context, device: Row, input: EvidenceUpload): { duplicate: Row | undefined; job: Row } {
  const job = locate(ctx, JOB, input.jobId);
  if (!job) throw new Problem(404, 'JOB_NOT_FOUND', 'Unknown job');
  const history = Array.isArray(job.device_history) ? job.device_history as string[] : [];
  if (!history.includes(device.id)) throw new Problem(409, 'JOB_FENCE_LOST', 'This machine never held the job');
  if (!(EVIDENCE_MIME as readonly string[]).includes(input.mime)) throw new Problem(415, 'EVIDENCE_TYPE_UNSUPPORTED', 'Evidence must be JPEG or PNG');
  if (input.size < 1 || input.size > EVIDENCE_MAX_BYTES) throw new Problem(413, 'EVIDENCE_TOO_LARGE', 'Evidence must be at most 4 MiB');
  const stored = ctx.list('file_object').filter(row => row.purpose === 'evidence' && row.worker_job_id === job.id && !row.deleted_at);
  const duplicate = stored.find(row => row.sha256 === input.sha256);
  if (!duplicate && stored.length >= EVIDENCE_PER_JOB) throw new Problem(409, 'EVIDENCE_LIMIT', 'A job keeps at most 20 screenshots');
  return { duplicate, job };
}

/** The short write after the bytes are in storage. Re-checks the duplicate (another upload may have raced). */
export function recordEvidence(ctx: Context, device: Row, input: EvidenceUpload & { storage_key: string; object_nonce: string; bucket: string }) {
  const { duplicate, job } = authorizeEvidence(ctx, device, input);
  if (duplicate) return { file_object_id: duplicate.id, sha256: input.sha256, duplicate: true as const, orphan: input.storage_key };
  const file = ctx.create('file_object', {
    tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, created_by_id: `device:${device.id}`, storage_key: input.storage_key, object_nonce: input.object_nonce,
    bucket: input.bucket, mime_type: input.mime, size_bytes: input.size, sha256: input.sha256, original_filename: `${job.id}-${input.sha256.slice(0, 12)}.${input.mime === 'image/png' ? 'png' : 'jpg'}`,
    scan_status: 'skipped', purpose: 'evidence', retention_until: null, deleted_at: null, worker_job_id: job.id, device_id: device.id,
  });
  const evidence = ctx.create('evidence', {
    kind: 'screenshot', file_object_id: file.id, captured_at: ctx.now, linked_resource_type: 'worker_job', linked_resource_id: job.id,
    captured_by: `device:${device.id}`, sha256: input.sha256,
  } as Data);
  ctx.emit('core.file_object.created', { file_object_id: file.id, purpose: 'evidence' });
  return { file_object_id: file.id, evidence_id: evidence.id, sha256: input.sha256 };
}

/** C11 fix for the legacy connector path (§8.13): an evidence reference must name a stored evidence file with that hash. */
export function verifyStoredEvidence(ctx: Context, evidence: Data): boolean {
  const file = locate(ctx, 'file_object', evidence.object_id);
  return !!file && !file.deleted_at && file.purpose === 'evidence' && file.sha256 === evidence.sha256 && ['clean', 'skipped'].includes(String(file.scan_status));
}
