import { AMAZON, amazonRawEvidence, evidenceHash, purgeMisstoredAmazonPii } from './amazon-privacy';
import { Problem, READ, type Context, type Data, type Operation, type Role, type Row } from '@smartsell/contracts';
import { recordObservations } from '../analytics/metrics.ts';
import { getRetentionPolicy } from '../ops/retention.ts';
import { asData, day, iso, listed, text } from './ingest-input';
import { accessibleBatch, importAccess } from './import-operations';
import { makeContext } from '../../context.js';
import { operationRecords, operationRow } from '../../integration/operation-records.js';
import { DomainError, type Context as CommandContext, type Entity } from '../types.js';
import { checkUse as checkCommandUse, get as getIngest } from './model.js';
import { checkUse, permitSourceResource } from './source-policy';
import { forbiddenColumn, privateValue } from './templates';

const rawReaders: readonly Role[] = ['owner', 'admin', 'analyst'];
const allowedSensitive = new Set(['id', 'external_id', 'external_post_id', 'external_product_id', 'external_variant_id', 'external_order_id', 'external_refund_id', 'external_updated_at', 'published_at', 'observed_at', 'placed_at', 'status', 'currency', 'total_minor', 'amount_minor', 'price_minor', 'views', 'likes', 'comments', 'shares', 'impressions', 'reach', 'followers']);

function redact(input: Data, restricted: boolean): Data {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(input)) {
    if (forbiddenColumn(key) || privateValue(key) || (restricted && !allowedSensitive.has(key))) continue;
    if (typeof value === 'string' && !privateValue(value)) entries.push([key, value]);
    else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) entries.push([key, value]);
    else if (!restricted && !Array.isArray(value) && typeof value === 'object') entries.push([key, redact(asData(value), false)]);
  }
  return Object.fromEntries(entries);
}

/** Trusted adapter boundary. The source rules are reapplied before writing evidence. */
export function captureRawRecord(ctx: Context, input: { sourceId: string; resource: string; externalId: string; runId: string; payload: Data }) {
  const source = ctx.get('data_source', input.sourceId);
  const run = ctx.get('sync_run', input.runId);
  if (run.data_source_id !== source.id || run.resource !== input.resource) throw new Problem(422, 'SOURCE_MISMATCH', 'Run is outside this source resource');
  permitSourceResource(source, input.resource);
  const days = Math.min(Number(getRetentionPolicy(ctx, 'raw_record')?.retain_days ?? 90), Number(asData(source.allowed_uses).cache_days ?? 0));
  if (days <= 0) return null;
  const restricted = ['douyin', 'xiaohongshu'].includes(String(source.provider)) || ['orders', 'refunds', 'comments', 'messages'].includes(input.resource);
  const raw = source.provider === AMAZON ? amazonRawEvidence(input.payload, allowedSensitive) : redact(input.payload, restricted);
  const payloadHash = evidenceHash(raw);
  const externalId = text(input.externalId, 'externalId');
  if (privateValue(externalId)) throw new Problem(422, 'INVALID_EXTERNAL_ID', 'External reference contains private data');
  const existing = ctx.list('raw_record').findLast(row => row.data_source_id === source.id && row.sync_run_id === run.id && row.resource === input.resource && row.external_id === externalId && String(row.retention_until) > ctx.now);
  if (existing?.payload_hash === payloadHash) return existing;
  return ctx.create('raw_record', { data_source_id: source.id, resource: input.resource, external_id: externalId, sync_run_id: run.id,
    payload: raw, payload_hash: payloadHash, observed_at: ctx.now, retention_until: iso(Date.parse(ctx.now) + days * day) });
}

/** Trusted worker sink for normalized metric observations and their corresponding provider evidence. */
export function recordMetricEvidence(ctx: Context, input: Parameters<typeof captureRawRecord>[1] & { observation: Data }) {
  const source = ctx.get('data_source', input.sourceId);
  const run = ctx.get('sync_run', input.runId);
  const subjectType = { post_metrics: 'platform_post', account_metrics: 'social_account', ad_metrics: 'ad' }[input.resource as 'post_metrics' | 'account_metrics' | 'ad_metrics'];
  if (!subjectType || input.observation.subject_type !== subjectType || run.data_source_id !== source.id || run.resource !== input.resource) {
    throw new Problem(422, 'SOURCE_MISMATCH', 'Metric observation is outside this source resource');
  }
  const subject = ctx.get(subjectType, text(input.observation.subject_id, 'subject_id'));
  if (source.social_account_id && (subjectType === 'social_account' ? subject.id : subject.social_account_id ?? subject.account_id) !== source.social_account_id) {
    throw new Problem(422, 'SOURCE_MISMATCH', 'Metric subject is outside this source account');
  }
  permitSourceResource(source, input.resource);
  const { ids, inserted_count } = recordObservations(ctx, { observations: [{ ...input.observation,
    source: { method: source.method ?? (source.kind === 'file_import' ? 'report_import' : 'official_api'), batch_id: run.id, data_source_id: source.id } }] });
  if (!inserted_count) return ctx.get('metric_observation', ids[0]!);
  const raw = captureRawRecord(ctx, input);
  return ctx.update('metric_observation', ids[0]!, { ingest_evidence: { data_source_id: source.id, sync_run_id: run.id,
    raw_record_id: raw?.id, mapping_version: run.mapping_version ?? 1 } });
}

export function purgeExpiredIngestData(ctx: Context, commandDays = 30) {
  const expiringBatches = ctx.list('import_batch').filter(batch =>
    String(batch.expires_at) <= ctx.now && !batch.evidence_expired_at && batch.status !== 'merging');
  const expiringBatchIds = new Set(expiringBatches.map(batch => batch.id));
  const expiringRaw = ctx.list('raw_record').filter(row => String(row.retention_until) <= ctx.now);
  if (expiringRaw.length || expiringBatches.length) {
    const expiringRawIds = new Set(expiringRaw.map(raw => raw.id));
    // The general expiry task can run before the compliance worker drains its daily job.
    purgeMisstoredAmazonPii(ctx, commandDays, (kind, row) => kind === 'raw_record' ? expiringRawIds.has(row.id)
      : kind === 'import_row' && expiringBatchIds.has(String(row.batch_id)));
  }
  for (const raw of expiringRaw) {
    ctx.create('raw_record_tombstone', { raw_record_id: raw.id, data_source_id: raw.data_source_id, sync_run_id: raw.sync_run_id,
      retention_until: raw.retention_until, deleted_at: ctx.now });
    ctx.remove('raw_record', raw.id);
  }
  for (const batch of expiringBatches) {
    for (const row of ctx.list('import_row').filter(row => row.batch_id === batch.id)) {
      ctx.update('import_row', row.id, { raw: null, normalized: null, dedupe_key: null, evidence_expired_at: ctx.now });
    }
    ctx.update('import_batch', batch.id, { evidence_expired_at: ctx.now, status: batch.status === 'awaiting_confirmation' ? 'expired' : batch.status });
  }
  if (expiringRaw.length) ctx.emit('ingest.raw_record.purged', { count: expiringRaw.length });
  return { raw_records_removed: expiringRaw.length };
}

function readIfPresent(ctx: Context, kind: string, id: string) {
  try { return ctx.get(kind, id); }
  catch (error) { if (!(error instanceof Problem) || error.status !== 404) throw error; }
}

type EvidenceRow = Data & { id: string };
type SyncEvidenceRef = { kind: 'sync'; data_source_id: string; sync_run_id: string; raw_record_id?: string; mapping_version?: number };
type ImportEvidenceRef = { kind: 'import'; data_source_id?: string; import_batch_id: string; import_row_id: string; template_key?: string; source_row?: number; mapping_version?: number };
export type MetricEvidenceRefs = Record<string, SyncEvidenceRef | ImportEvidenceRef | null>;
const evidenceId = (value: unknown) => typeof value === 'string' && value.length ? value : undefined;
const revision = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const evidenceRow = (row: Entity): EvidenceRow => ({ ...row.data, id: row.id });

function mappingRevision(row: Data) {
  return revision(row.mapping_version) ?? revision(row.mapping_revision);
}

function freezeMetricEvidence(observations: EvidenceRow[], runs: EvidenceRow[], batches: EvidenceRow[], rows: EvidenceRow[], command = false): MetricEvidenceRefs {
  const byRun = new Map(runs.map(run => [run.id, run]));
  const byBatch = new Map(batches.map(batch => [batch.id, batch]));
  const byObservation = new Map<string, EvidenceRow>();
  const byRow = new Map<string, EvidenceRow>();
  const importKey = (batch: unknown, observation: unknown) => JSON.stringify([batch, observation]);
  for (const row of rows) {
    const target = asData(row.target_ref);
    if ((target.module !== undefined && target.module !== 'analytics') || target.resource_type !== 'metric_observation' ||
      (row.status !== undefined && row.status !== 'merged')) continue;
    byRow.set(row.id, row);
    const key = importKey(row.batch_id, target.resource_id);
    if (!byObservation.has(key)) byObservation.set(key, row);
  }
  const freeze = (observation: EvidenceRow): MetricEvidenceRefs[string] => {
    const link = asData(observation.ingest_evidence);
    const source = asData(observation.source);
    const sourceId = evidenceId(link.data_source_id ?? observation.data_source_id ?? source.data_source_id);
    const batchId = evidenceId(source.batch_id);
    const runId = evidenceId(link.sync_run_id ?? source.sync_run_id) ?? batchId;
    const run = runId && byRun.get(runId);
    if (run && sourceId && run.data_source_id === sourceId) {
      return { kind: 'sync', data_source_id: sourceId, sync_run_id: run.id,
        raw_record_id: evidenceId(link.raw_record_id) ?? (command ? evidenceId(source.raw_record_id) : undefined),
        mapping_version: mappingRevision(link) ?? mappingRevision(source) ?? mappingRevision(run) };
    }
    const batch = batchId && byBatch.get(batchId);
    if (!batch || (sourceId && batch.data_source_id !== sourceId)) return null;
    const rowId = evidenceId(source.row_id);
    const row = rowId ? byRow.get(rowId) : byObservation.get(importKey(batch.id, observation.id));
    if (row?.batch_id !== batch.id || asData(row.target_ref).resource_id !== observation.id) return null;
    return { kind: 'import', data_source_id: evidenceId(batch.data_source_id), import_batch_id: batch.id, import_row_id: row.id,
      template_key: evidenceId(batch.template_key), source_row: revision(row.row_no), mapping_version: mappingRevision(batch) };
  };
  return Object.fromEntries(observations.map(observation => [observation.id, freeze(observation)]));
}

export function freezeReportMetricEvidence(ctx: Context, observations: Row[]) {
  if (!observations.length) return {};
  const frozen = freezeMetricEvidence(observations, ctx.list('sync_run'), ctx.list('import_batch'), ctx.list('import_row'));
  let tombstones: Row[] | undefined;
  for (const ref of Object.values(frozen)) {
    if (ref?.kind !== 'sync' || !ref.raw_record_id) continue;
    const raw = readIfPresent(ctx, 'raw_record', ref.raw_record_id);
    const verified = raw ? matchesRaw(ref, raw)
      : (tombstones ??= ctx.list('raw_record_tombstone')).some(row => matchesTombstone(ref, row));
    if (!verified) delete ref.raw_record_id;
  }
  return frozen;
}

export async function freezeCommandMetricEvidence(ctx: CommandContext, observations: Entity[]) {
  if (!observations.length) return {};
  const [runs, batches, rows] = await Promise.all([
    ctx.list('ingest', 'sync_run'), ctx.list('ingest', 'import_batch'), ctx.list('ingest', 'import_row'),
  ]);
  const frozen = freezeMetricEvidence(observations.map(evidenceRow), runs.map(evidenceRow), batches.map(evidenceRow), rows.map(evidenceRow), true);
  await Promise.all(Object.values(frozen).map(async ref => {
    if (ref?.kind !== 'sync' || !ref.raw_record_id) return;
    const { raw, deletedAt } = await readCommandRawEvidence(ctx, ref);
    if (!raw && !deletedAt) delete ref.raw_record_id;
  }));
  return frozen;
}

function describeSyncEvidence(ctx: Pick<Context, 'role' | 'now'>, ref: SyncEvidenceRef, run: EvidenceRow | undefined, raw: EvidenceRow | undefined, deletedAt: string | undefined) {
  const canRead = rawReaders.includes(ctx.role);
  const raw_evidence = deletedAt ? { status: 'deleted', deleted_at: deletedAt }
    : !raw ? { status: 'not_retained' }
    : Date.parse(String(raw.retention_until)) <= Date.parse(ctx.now) ? { status: 'expired' }
    : !canRead ? { status: 'restricted' }
    : { status: 'available', raw_record_id: raw.id, retention_until: raw.retention_until };
  return { sync_run_id: ref.sync_run_id, run_status: run?.status, raw_evidence,
    ...(canRead && (raw || deletedAt) ? { raw_record_id: ref.raw_record_id } : {}) };
}

const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const matchesRun = (ref: SyncEvidenceRef, row: Data) => row.data_source_id === ref.data_source_id && row.sync_run_id === ref.sync_run_id;
const matchesRaw = (ref: SyncEvidenceRef, row: EvidenceRow) => row.id === ref.raw_record_id && matchesRun(ref, row) && isTimestamp(row.retention_until);
const matchesTombstone = <T extends Data>(ref: SyncEvidenceRef, row: T): row is T & { deleted_at: string } =>
  row.raw_record_id === ref.raw_record_id && matchesRun(ref, row) && isTimestamp(row.deleted_at);

// Purge runs record raw IDs. The report must already have verified the source and run for that ID.
function approvedRawDeletion(ctx: Context, rawId: string) {
  const run = ctx.list('purge_run').find((row): row is Row & { completed_at: string } =>
    row.status === 'completed' && row.data_class === 'raw_record' && asData(asData(row.preview).policy).action === 'delete' &&
    Array.isArray(row.purged) && row.purged.includes(rawId) && isTimestamp(row.completed_at));
  return run?.completed_at;
}

async function readCommandRawEvidence(ctx: CommandContext, ref: SyncEvidenceRef, includeApprovedPurge = false): Promise<{ raw?: EvidenceRow; deletedAt?: string }> {
  if (!ref.raw_record_id) return {};
  const raw = await operationRow<EvidenceRow>(ctx, 'raw_record', ref.raw_record_id);
  if (raw) return matchesRaw(ref, raw) ? { raw } : {};

  const { records } = await operationRecords(ctx, true);
  const operations = makeContext(records, ctx, ctx.role);
  const tombstone = operations.list('raw_record_tombstone').find(row => matchesTombstone(ref, row));
  if (tombstone) return { deletedAt: tombstone.deleted_at };
  if (includeApprovedPurge) {
    const deletedAt = approvedRawDeletion(operations, ref.raw_record_id);
    if (deletedAt) return { deletedAt };
  }

  const legacy = await ctx.get('ingest', 'raw_record', ref.raw_record_id);
  const legacyRaw = legacy && evidenceRow(legacy);
  if (legacyRaw && matchesRaw(ref, legacyRaw)) return { raw: legacyRaw };
  const legacyTombstone = (await ctx.list('ingest', 'raw_record_tombstone')).map(evidenceRow).find(row => matchesTombstone(ref, row));
  return { deletedAt: legacyTombstone?.deleted_at };
}

const sourceDetails = (id: string, ref: NonNullable<MetricEvidenceRefs[string]>, source: EvidenceRow | undefined) => ({
  observation_id: id, data_source_id: ref.data_source_id, source_name: source?.name, provider: source?.provider, mapping_version: ref.mapping_version,
});

export function reportMetricIngestProvenance(ctx: Context, id: string, ref: MetricEvidenceRefs[string]) {
  if (!ref) return { observation_id: id, raw_evidence: { status: 'not_retained' } };
  const source = ref.data_source_id ? ctx.get('data_source', ref.data_source_id) : undefined;
  if (source) checkUse(ctx, [source.id], 'display');
  const details = sourceDetails(id, ref, source);
  if (ref.kind === 'sync') {
    const run = readIfPresent(ctx, 'sync_run', ref.sync_run_id);
    const candidate = ref.raw_record_id ? readIfPresent(ctx, 'raw_record', ref.raw_record_id) : undefined;
    const raw = candidate && matchesRaw(ref, candidate) ? candidate : undefined;
    let deletedAt: string | undefined;
    if (ref.raw_record_id && !candidate) {
      const tombstone = ctx.list('raw_record_tombstone').find(row => matchesTombstone(ref, row));
      deletedAt = tombstone?.deleted_at ?? approvedRawDeletion(ctx, ref.raw_record_id);
    }
    return { ...details, ...describeSyncEvidence(ctx, ref, run, raw, deletedAt) };
  }
  const batch = readIfPresent(ctx, 'import_batch', ref.import_batch_id);
  if (batch) importAccess(ctx, ref.template_key ?? String(batch.template_key));
  const row = batch && readIfPresent(ctx, 'import_row', ref.import_row_id);
  return { ...details, import_batch_id: ref.import_batch_id, source_row: ref.source_row, raw_evidence: importRowEvidence(ctx, batch, row) };
}

export async function commandMetricIngestProvenance(ctx: CommandContext, id: string, ref: MetricEvidenceRefs[string]) {
  if (!ref) return { observation_id: id, raw_evidence: { status: 'not_retained' } };
  const source = ref.data_source_id ? await getIngest(ctx, 'data_source', ref.data_source_id) : undefined;
  if (source) await checkCommandUse(ctx, [source.id], 'display');
  const details = sourceDetails(id, ref, source && evidenceRow(source));
  const get = async (kind: string, id: string) => {
    const row = await ctx.get('ingest', kind, id);
    return row && evidenceRow(row);
  };
  if (ref.kind === 'sync') {
    const run = await get('sync_run', ref.sync_run_id);
    const { raw, deletedAt } = await readCommandRawEvidence(ctx, ref, true);
    return { ...details, ...describeSyncEvidence(ctx, ref, run, raw, deletedAt) };
  }
  const batch = await get('import_batch', ref.import_batch_id);
  if (batch) {
    try { importAccess(ctx, ref.template_key ?? String(batch.template_key)); }
    catch (error) {
      if (error instanceof Problem) throw new DomainError(error.code, error.message, error.status);
      throw error;
    }
  }
  const row = batch && await get('import_row', ref.import_row_id);
  // Command responses can be replayed from the idempotency store. Keep raw payloads in ingest.
  return { ...details, import_batch_id: ref.import_batch_id, source_row: ref.source_row, raw_evidence: importRowEvidence(ctx, batch, row, false) };
}

export function importRowEvidence(ctx: Pick<Context, 'role' | 'now'>, batch: EvidenceRow | undefined, row: EvidenceRow | undefined, includePayload = true) {
  if (!batch) return { status: 'not_retained' };
  const deletedAt = batch.evidence_expired_at ?? (row?.batch_id === batch.id ? row.evidence_expired_at : undefined);
  if (deletedAt && row?.batch_id === batch.id) return { status: 'deleted', deleted_at: deletedAt };
  if (!row || row.batch_id !== batch.id) return { status: 'not_retained' };
  if (Date.parse(String(batch.expires_at)) <= Date.parse(ctx.now)) return { status: 'expired' };
  if (!row.raw) return { status: 'not_retained' };
  if (!rawReaders.includes(ctx.role)) return { status: 'restricted' };
  return { status: 'available', ...(includePayload ? { payload: redact(asData(row.raw), false) } : {}), retention_until: batch.expires_at };
}

export const evidenceOperations: Operation[] = [
  { path: '/provenance', method: 'GET', name: 'data_provenance_get', roles: READ, summary: 'Trace an imported entity to its sanitized report batch and mapping', run(ctx, { query }) {
    const kind = text(query.resource_type, 'resource_type'), id = text(query.resource_id, 'resource_id');
    return ctx.list('import_row').filter(row => asData(row.target_ref).resource_type === kind && asData(row.target_ref).resource_id === id).flatMap(row => {
      let batch;
      try { batch = accessibleBatch(ctx, String(row.batch_id)); }
      catch (error) { if (error instanceof Problem && error.status === 403) return []; throw error; }
      return [{ import_batch_id: batch.id, target_ref: row.target_ref, source_row: row.row_no, template_key: batch.template_key,
        data_source_id: batch.data_source_id, file_object_id: batch.file_object_id, mapping_version: batch.mapping_version,
        evidence: batch.evidence_expired_at ? 'expired' : 'available' }];
    });
  } },
  { path: '/raw-records/:id', method: 'GET', name: 'raw_record_get', roles: rawReaders, summary: 'Read privacy-filtered raw evidence within retention', run(ctx, { params }) {
    const row = ctx.get('raw_record', params.id);
    if (String(row.retention_until) <= ctx.now) throw new Problem(410, 'EVIDENCE_EXPIRED', 'Evidence retention expired');
    checkUse(ctx, listed([row.data_source_id]), 'display');
    return row;
  } },
];
