import { createHash } from 'node:crypto';
import { ADMIN, Problem, type Context, type Data, type Operation, type Role, type Row } from '@smartsell/contracts';
import { csvCell, importTable, maxImportRows, parseCsv } from './csv';
import { readXlsx, XlsxError } from './xlsx';
import { asData, day, integer, invalid, iso, object, text, timezone } from './ingest-input';
import { AMAZON, amazonPrivateColumn } from './amazon-privacy';
import { type Classification, prepare, storeTemplates } from './import-sinks';
import { checkUse } from './source-policy';
import { builtinMapping, forbiddenColumn, identity, normalize, privateValue, templateKey, templates, type Template } from './templates';

const importRoles: readonly Role[] = ['owner', 'admin', 'manager', 'editor', 'analyst'];
const batchKind = 'import_batch';
const rowKind = 'import_row';
const mappingVersion = 1;
const transactional = new Set(['order_list', 'refund_list', 'logistics', 'commission']);
export function importAccess(ctx: Pick<Context, 'role'>, template: string) {
  if ((transactional.has(template) || template === 'ad_report') && !ADMIN.includes(ctx.role)) {
    throw new Problem(403, 'FORBIDDEN', 'This report requires workspace administration');
  }
  if (template === 'unit_cost' && ctx.role === 'editor') throw new Problem(403, 'FORBIDDEN', 'Unit cost reports require financial access');
}
const marketProvider = (store: Row | undefined, source: Row | undefined) => String(store?.provider ?? source?.provider ?? 'file_import');

function optionsOf(input: unknown): Data {
  if (input === undefined) return {};
  const values = object(input, 'options');
  const options: Data = {};
  if (values.timezone !== undefined) options.timezone = timezone(values.timezone);
  for (const field of ['currency', 'watch_target_id', 'social_account_id']) {
    if (values[field] !== undefined) options[field] = text(values[field], field);
  }
  return options;
}

function importOptions(ctx: Context, input: unknown, adAccountId?: string) {
  const options = optionsOf(input);
  if (adAccountId) {
    const accountZone = timezone(ctx.get('ad_account', adAccountId).timezone);
    const canonicalZone = (zone: string) => new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
    if (typeof options.timezone === 'string' && canonicalZone(options.timezone) !== canonicalZone(accountZone)) {
      invalid('Report timezone must match the ad account timezone');
    }
    options.timezone = accountZone;
  }
  return options;
}

function providerTemplate(template: Template, provider: string) {
  if (template === 'inventory_list' && provider !== 'shopify') invalid('This inventory template is for Shopify');
  if (['order_list', 'refund_list'].includes(template) && ['shopify', 'tiktok_shop'].includes(provider)) {
    invalid('This provider requires the order/refund API', 'IMPORT_TEMPLATE_UNAVAILABLE');
  }
}

function mappingOf(template: Template, header: string[], raw: unknown): Record<string, string> {
  const entries = Object.entries(object(raw, 'mapping'));
  const targets = new Set<string>();
  for (const [column, target] of entries) {
    if (!header.includes(column) || forbiddenColumn(column) || typeof target !== 'string' || !templates[template].columns.includes(target) || targets.has(target)) {
      invalid('Mapping requires available source columns and unique template fields', 'INVALID_MAPPING');
    }
    targets.add(target);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function batchRows(ctx: Context, id: string) {
  return ctx.list(rowKind).filter(row => row.batch_id === id).sort((a, b) => Number(a.row_no) - Number(b.row_no));
}

function assertPreview(ctx: Context, batch: Row) {
  if (batch.status !== 'awaiting_confirmation') throw new Problem(409, 'IMPORT_NOT_EDITABLE', 'The batch is no longer awaiting confirmation');
  if (String(batch.expires_at) <= ctx.now) throw new Problem(410, 'IMPORT_EXPIRED', 'The import preview has expired');
}

function rowError(error: unknown) {
  if (!(error instanceof Problem) || ![400, 403, 404, 409, 422].includes(error.status)) throw error;
  return { code: error.code, message: error.message };
}

function quality(ctx: Context, batch: Row, check: string, count: number) {
  const fingerprint = JSON.stringify([batch.id, check]);
  const existing = ctx.list('quality_issue').find(row => row.fingerprint === fingerprint);
  if (!count && !existing) return;
  const status = count ? 'open' : 'resolved';
  const patch = { count, status };
  if (existing?.count === count && existing.status === status) return;
  const issue = existing ? ctx.update('quality_issue', existing.id, patch) : ctx.create('quality_issue', {
    ...patch, fingerprint, check_type: check, severity: 'warning', import_batch_id: batch.id, data_source_id: batch.data_source_id,
  });
  if (existing?.status !== status) ctx.emit(`ingest.quality_issue.${status === 'open' ? 'opened' : 'resolved'}`, { quality_issue_id: issue.id, import_batch_id: batch.id });
}

function preview(ctx: Context, batch: Row, sourceRows: Row[]) {
  const template = templateKey(batch.template_key);
  const mapping = asData(batch.mapping) as Record<string, string>;
  const options = asData(batch.options);
  const store = batch.store_id ? ctx.get('store', String(batch.store_id)) : undefined;
  const catalogTitles = new Map<string, string>();
  const seen = new Set<string>();
  const stats = { rows: sourceRows.length, valid: 0, invalid: 0, dup_in_file: 0, new: 0, changed: 0, unchanged: 0 };
  for (const row of sourceRows) {
    let values: Data | null = null, key: string | null = null;
    let status: Classification | 'invalid' | 'dup_in_file' = 'invalid';
    const issues: Data[] = [];
    try {
      if (row.column_count !== batch.column_count) invalid('Column count does not match header', 'INVALID_COLUMN_COUNT');
      const raw = asData(row.raw);
      const scopedOptions = template === 'product_list' && store?.provider === 'shopify' && typeof store.default_currency === 'string'
        ? { currency: store.default_currency, ...options } : options;
      values = normalize(template, raw, mapping, scopedOptions);
      const productKey = template === 'product_list' ? values.external_product_id ?? values.handle : undefined;
      if (typeof productKey === 'string' && !values.title && catalogTitles.has(productKey)) values.title = catalogTitles.get(productKey);
      key = identity(template, values);
      if (seen.has(key)) {
        status = 'dup_in_file';
        issues.push({ code: 'DUP_IN_FILE', message: 'An earlier valid row has the same identity' });
      } else {
        status = prepare(ctx, batch, template, values, key, row.id).status;
        if (typeof productKey === 'string' && typeof values.title === 'string') catalogTitles.set(productKey, values.title);
        seen.add(key);
        stats.valid++;
      }
    } catch (error) { issues.push(rowError(error)); }
    stats[status]++;
    ctx.update(rowKind, row.id, { normalized: values, dedupe_key: key, status, issues });
  }
  const result = ctx.update(batchKind, batch.id, { stats, status: 'awaiting_confirmation' });
  quality(ctx, batch, 'duplicate', stats.dup_in_file);
  quality(ctx, batch, 'completeness', stats.invalid);
  ctx.emit('ingest.import_batch.awaiting_confirmation', { import_batch_id: batch.id, stats });
  return result;
}

export function createImportBatch(ctx: Context, body: Data, idempotencyKey?: string) {
  const template = templateKey(body.template_key);
  const source = body.data_source_id ? ctx.get('data_source', text(body.data_source_id, 'data_source_id')) : undefined;
  if (source) checkUse(ctx, [source.id], 'display');
  const storeId = body.store_id ?? source?.store_id;
  const needsStore = (storeTemplates as readonly string[]).includes(template);
  importAccess(ctx, template);
  const store = storeId ? ctx.get('store', text(storeId, 'store_id')) : undefined;
  if (needsStore && !store) invalid('Select a store to import its report');
  if (source?.store_id && store?.id !== source.store_id) invalid('Store differs from the source store');
  const provider = marketProvider(store, source);
  providerTemplate(template, provider);
  const amazonPrivacy = provider === AMAZON || source?.provider === AMAZON;
  const protectedInput = amazonPrivacy || transactional.has(template) || ['douyin', 'xiaohongshu'].includes(provider);
  if (protectedInput && body.file_object_id) invalid('Upload report content directly so unfiltered data is never written to file storage', 'INLINE_PROTECTED_IMPORT_REQUIRED');
  const xlsx = body.xlsx_base64 !== undefined;
  const inlineCsv = body.csv_text !== undefined || body.csv !== undefined;
  if ((body.file_object_id && (inlineCsv || xlsx)) || (inlineCsv && xlsx)) invalid('Provide one report input: a file object, CSV/TSV text, or an XLSX workbook');
  const file = body.file_object_id ? ctx.get('file_object', text(body.file_object_id, 'file_object_id')) : undefined;
  const accountId = template === 'ad_report' ? text(body.ad_account_id ?? source?.ad_account_id, 'ad_account_id') : undefined;
  if (accountId && source?.ad_account_id && source.ad_account_id !== accountId) invalid('Ad account differs from the source ad account');
  const scope = { template, source, store, accountId, provider, protectedInput, file, idempotencyKey };
  if (xlsx) {
    return readXlsx(body.xlsx_base64, maxImportRows).then(rows => stageImport(ctx, body, scope, importTable(rows)), error => {
      if (error instanceof XlsxError) {
        const code = error.code === 'xlsx_too_large' ? 'IMPORT_TOO_LARGE' : error.code.toUpperCase();
        throw new Problem(error.status, code, error.message);
      }
      throw error;
    });
  }
  const input = file?.csv_text ?? file?.content ?? body.csv_text ?? body.csv;
  if (typeof input !== 'string' || !input.trim()) invalid('Supply UTF-8 CSV/TSV text or xlsx_base64', 'IMPORT_FILE_REQUIRED');
  return stageImport(ctx, body, scope, parseCsv(input));
}

function stageImport(ctx: Context, body: Data, scope: {
  template: Template; source?: Row; store?: Row; accountId?: string; provider: string; protectedInput: boolean; file?: Row; idempotencyKey?: string;
}, { header, records }: ReturnType<typeof importTable>) {
  const { template, source, store, accountId, provider, protectedInput, file, idempotencyKey } = scope;
  const suggested = builtinMapping(template, provider, header);
  const amazonPrivacy = provider === AMAZON || source?.provider === AMAZON;
  const allowed = header.filter(column => !forbiddenColumn(column) && (!protectedInput || Object.hasOwn(suggested, column))
    && !privateValue(column) && (!amazonPrivacy || !amazonPrivateColumn(column)));
  const defaultMapping = Object.fromEntries(Object.entries(suggested).filter(([column]) => allowed.includes(column)));
  const saved = body.mapping_preset_id ? ctx.get('import_mapping_preset', text(body.mapping_preset_id, 'mapping_preset_id')) : undefined;
  if (saved && (saved.template_key !== template || saved.provider !== provider)) invalid('Mapping preset has a different template or provider');
  const mapping = body.mapping !== undefined || saved ? mappingOf(template, allowed, body.mapping ?? saved?.mapping) : defaultMapping;
  const options = importOptions(ctx, body.options ?? saved?.options, accountId);
  const supersedes = body.supersedes_batch_id ? accessibleBatch(ctx, text(body.supersedes_batch_id, 'supersedes_batch_id')) : undefined;
  if (supersedes && (supersedes.template_key !== template || supersedes.store_id !== (store?.id ?? null) || supersedes.data_source_id !== (source?.id ?? null) || (supersedes.ad_account_id ?? undefined) !== accountId)) {
    invalid('The previous batch has a different source, template, or store');
  }
  const digest = createHash('sha256');
  const allowedIndexes = header.flatMap((column, index) => allowed.includes(column) ? [[column, index] as const] : []);
  const filtered = records.map(({ cells, line }) => {
    const raw = Object.fromEntries(allowedIndexes.map(([column, index]) => {
      const value = cells[index] ?? '';
      return [column, privateValue(value) ? '' : value];
    }));
    digest.update(JSON.stringify([line, cells.length, raw]));
    return { raw, row_no: line, column_count: cells.length };
  });
  const fileDigest = digest.digest('hex');
  const fingerprint = JSON.stringify([template, store?.id, source?.id, fileDigest, mapping, options, supersedes?.id, ...(accountId ? [accountId] : [])]);
  const prior = idempotencyKey && ctx.list(batchKind).find(row => row.idempotency_key === idempotencyKey && row.actor_id === ctx.actorId);
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'This key already names a different import');
    return prior;
  }
  const attachment = file ?? ctx.create('file_object', {
    name: body.xlsx_base64 === undefined ? 'import.csv' : 'import.xlsx',
    media_type: body.xlsx_base64 === undefined ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    classification: 'import_redacted', sha256: fileDigest, row_count: filtered.length,
  });
  const retention = Number(asData(source?.allowed_uses).cache_days ?? 90);
  if (retention === 0) throw new Problem(403, 'EGRESS_BLOCKED', 'This source contract does not allow storing import previews');
  const batch = ctx.create(batchKind, {
    file_object_id: attachment.id, file_sha256: fileDigest, data_source_id: source?.id ?? null, store_id: store?.id ?? null,
    ...(accountId ? { ad_account_id: accountId } : {}),
    provider, template_key: template, mapping, mapping_version: mappingVersion, options, header: allowed,
    column_count: header.length, status: 'validating', supersedes_batch_id: supersedes?.id ?? null, actor_id: ctx.actorId,
    idempotency_key: idempotencyKey ?? null, request_fingerprint: fingerprint,
    expires_at: iso(Date.parse(ctx.now) + Math.min(retention, 7) * day),
  });
  return preview(ctx, batch, filtered.map(row => ctx.create(rowKind, { ...row, batch_id: batch.id, status: 'validating' })));
}

function confirm(ctx: Context, id: string, body: Data) {
  const batch = accessibleBatch(ctx, id);
  if (['merged', 'partially_merged'].includes(String(batch.status))) return batch;
  if (batch.status !== 'merging') assertPreview(ctx, batch);
  const limit = integer(body.limit ?? 500, 'limit', 1, 1000);
  const rows = batchRows(ctx, id);
  const cursor = Number(batch.checkpoint_row ?? 0);
  const remaining = rows.filter(row => Number(row.row_no) > cursor);
  const chunk = remaining.slice(0, limit);
  const template = templateKey(batch.template_key);
  let merged = Number(batch.merged_rows ?? 0), failed = Number(batch.failed_rows ?? 0), skipped = Number(batch.skipped_rows ?? 0);
  for (const row of chunk) {
    if (row.status === 'invalid' || row.status === 'dup_in_file') { failed++; continue; }
    let entry: ReturnType<typeof prepare>;
    try { entry = prepare(ctx, batch, template, asData(row.normalized), String(row.dedupe_key), row.id); }
    catch (error) {
      failed++;
      ctx.update(rowKind, row.id, { status: 'merge_failed', issues: [rowError(error)] });
      continue;
    }
    // A sink write failure rolls back this chunk instead of risking half a row.
    const ref = entry.apply();
    if (entry.status === 'unchanged') skipped++;
    else merged++;
    ctx.update(rowKind, row.id, { target_ref: ref, status: entry.status === 'unchanged' ? 'skipped' : 'merged', merged_at: ctx.now });
  }
  const done = remaining.length <= limit;
  const status = !done ? 'merging' : failed > 0 ? 'partially_merged' : 'merged';
  const counts = { merged_rows: merged, failed_rows: failed, skipped_rows: skipped };
  const updated = ctx.update(batchKind, id, { ...counts, status, checkpoint_row: chunk.at(-1)?.row_no ?? cursor,
    confirmed_at: batch.confirmed_at ?? ctx.now, confirmed_by: batch.confirmed_by ?? ctx.actorId, merged_at: done ? ctx.now : null });
  if (done) ctx.emit('ingest.import_batch.merged', { import_batch_id: id, status, ...counts });
  return updated;
}

function assertEvidenceAvailable(ctx: Context, batch: Row) {
  if (batch.evidence_expired_at || (String(batch.expires_at) <= ctx.now && batch.status !== 'merging')) {
    throw new Problem(410, 'EVIDENCE_EXPIRED', 'Import row evidence has expired');
  }
}

export function accessibleBatch(ctx: Context, id: string, use: 'display' | 'export' = 'display') {
  const batch = ctx.get(batchKind, id);
  importAccess(ctx, String(batch.template_key));
  if (batch.data_source_id) checkUse(ctx, [String(batch.data_source_id)], use);
  return batch;
}

export const importOperations: Operation[] = [
  { path: '/import-templates', method: 'GET', name: 'import_template_list', roles: importRoles, summary: 'List supported CSV, TSV, and XLSX import schemas', run: () => Object.entries(templates).map(([key, value]) => ({ key, ...value })) },
  { path: '/imports', method: 'GET', name: 'import_list', roles: importRoles, summary: 'List permitted import batches', run: ctx => ctx.list(batchKind).filter(batch => {
    try { accessibleBatch(ctx, batch.id); return true; } catch (error) { if (error instanceof Problem && error.status === 403) return false; throw error; }
  }) },
  { path: '/imports', method: 'POST', name: 'import_create', roles: importRoles, summary: 'Parse a report and preview each row before applying it', run: (ctx, input) => createImportBatch(ctx, input.body, input.idempotencyKey) },
  { path: '/imports/:id', method: 'GET', name: 'import_get', roles: importRoles, summary: 'Read import batch and checkpoint', run: (ctx, { params }) => accessibleBatch(ctx, params.id) },
  { path: '/imports/:id', method: 'PATCH', name: 'import_preview', roles: importRoles, versionKind: batchKind, summary: 'Remap report columns and regenerate preview', run(ctx, { params, body }) {
    const batch = accessibleBatch(ctx, params.id);
    assertPreview(ctx, batch);
    const mapping = body.mapping !== undefined ? mappingOf(templateKey(batch.template_key), batch.header as string[], body.mapping) : batch.mapping;
    const accountId = batch.template_key === 'ad_report' && typeof batch.ad_account_id === 'string' ? batch.ad_account_id : undefined;
    const options = body.options !== undefined ? importOptions(ctx, { ...asData(batch.options), ...object(body.options, 'options') }, accountId) : batch.options;
    const next = ctx.update(batchKind, batch.id, { mapping, options });
    return preview(ctx, next, batchRows(ctx, batch.id));
  } },
  { path: '/imports/:id/rows', method: 'GET', name: 'import_rows', roles: importRoles, summary: 'Read paged row preview and errors', run(ctx, { params, query }) {
    assertEvidenceAvailable(ctx, accessibleBatch(ctx, params.id));
    const offset = integer(query.offset ?? 0, 'offset'), limit = integer(query.limit ?? 100, 'limit', 1, 1000);
    return batchRows(ctx, params.id).filter(row => !query.status || row.status === query.status).slice(offset, offset + limit);
  } },
  { path: '/imports/:id/error-file', method: 'GET', name: 'import_error_file', roles: importRoles, summary: 'Export sanitized CSV errors and row numbers', run(ctx, { params }) {
    const batch = accessibleBatch(ctx, params.id, 'export');
    assertEvidenceAvailable(ctx, batch);
    const header = batch.header as string[];
    const rows = batchRows(ctx, batch.id).filter(row => ['invalid', 'dup_in_file', 'merge_failed'].includes(String(row.status)));
    return { filename: 'import-errors.csv', content_type: 'text/csv', csv: [[...header, 'row_no', 'issue'], ...rows.map(row => [...header.map(column => asData(row.raw)[column]), row.row_no, JSON.stringify(row.issues)])].map(row => row.map(csvCell).join(',')).join('\r\n') };
  } },
  { path: '/imports/:id/confirm', method: 'POST', name: 'import_confirm', roles: importRoles, summary: 'Merge one transactional chunk and save its checkpoint', run: (ctx, { params, body }) => confirm(ctx, params.id, body) },
  { path: '/imports/:id/cancel', method: 'POST', name: 'import_cancel', roles: importRoles, summary: 'Cancel an unconfirmed import batch', run(ctx, { params }) {
    const batch = accessibleBatch(ctx, params.id);
    if (batch.status === 'cancelled') return batch;
    assertPreview(ctx, batch);
    return ctx.update(batchKind, batch.id, { status: 'cancelled', cancelled_by: ctx.actorId });
  } },
  { path: '/import-mapping-presets', method: 'GET', name: 'import_mapping_preset_list', roles: importRoles, summary: 'List reusable header mappings', run: ctx => ctx.list('import_mapping_preset') },
  { path: '/import-mapping-presets', method: 'POST', name: 'import_mapping_preset_create', roles: importRoles, summary: 'Save a validated batch mapping for later reuse', run(ctx, { body }) {
    const batch = accessibleBatch(ctx, text(body.import_batch_id, 'import_batch_id'));
    const { timezone: zone, currency: code } = asData(batch.options);
    return ctx.create('import_mapping_preset', { name: text(body.name, 'name'), template_key: batch.template_key, provider: batch.provider,
      mapping: batch.mapping, options: Object.fromEntries(Object.entries({ timezone: zone, currency: code }).filter(([, value]) => value !== undefined)), owner: ctx.actorId });
  } },
];
