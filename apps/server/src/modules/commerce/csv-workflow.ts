import { admins, readers, writers, type Commands, type Fields, type Entity, type Context, DomainError } from '../types';
import { allowedTemplate, readImport, readXlsxImport, template, templateKeys, type TemplateKey } from './csv-import';
import { plan } from './csv-planner';
import { active, conflict, get, guard, hash, id, insert, list, live, obj, one, providers, stableId, store, update, version } from './model';
import type { Journal } from './mutation';

const financial = (key: TemplateKey) => key === 'order_list' || key === 'refund_list';
function access(ctx: Context, key: TemplateKey) {
  if (financial(key) && !admins.includes(ctx.role)) throw new DomainError('forbidden', 'Financial imports require store administration', 403);
}
function summary(batch: Entity) {
  const { status, provider, store_id, template_key, counts, rows, issues, committed_at, rolled_back_at, row_count } = batch.data;
  return { batch_id: batch.id, version: batch.version, status, provider, store_id, template_key, counts, rows, issues, committed_at, rolled_back_at, row_count };
}
async function batchFor(ctx: Context, input: Fields) {
  const batch = await live(ctx, 'import_batch', id(input.batch_id, 'batch_id'));
  access(ctx, batch.data.template_key);
  return batch;
}
async function check(ctx: Context, batch: Entity, s: Entity) {
  return plan(ctx, s, batch.id, batch.data.template_key, batch.data.staged_rows, batch.data.parse_issues);
}
const resultFields = (p: Awaited<ReturnType<typeof check>>) => ({ counts: p.counts, rows: p.rows, issues: p.issues, signature: p.signature });
const dependencies: Record<string, [string, string][]> = {
  product: [['product_variant', 'product_id'], ['product_fact', 'product_id'], ['product_localization', 'product_id']],
  product_variant: [['inventory_location', 'variant_id'], ['listing_snapshot', 'variant_id'], ['product_fact', 'variant_id'], ['variant_group_member', 'variant_id'], ['order_line', 'variant_id']],
  order: [['refund', 'order_id'], ['order_line', 'order_id'], ['payment_transaction', 'order_id'], ['discount_usage', 'order_id']],
};

export const importCommands: Commands = {
  import_template: { roles: readers, async run(_ctx, input) {
    return template(one(input.provider, 'provider', providers), one(input.template_key, 'template_key', templateKeys));
  } },
  preview_import: { roles: writers, async run(ctx, input) {
    const key = one(input.template_key, 'template_key', templateKeys);
    access(ctx, key);
    const s = await store(ctx, id(input.store_id, 'store_id'));
    allowedTemplate(s.data.provider, key);
    const options = input.options === undefined ? {} : obj(input.options, 'options');
    if (input.xlsx_base64 !== undefined && input.csv !== undefined) throw new DomainError('invalid_input', 'Provide either CSV text or an XLSX workbook');
    const args = [key, s.data.provider, s.data.default_currency, options.timezone] as const;
    const parsed = input.xlsx_base64 === undefined ? readImport(input.csv, ...args) : await readXlsxImport(input.xlsx_base64, ...args);
    // Hash only normalized rows and safe diagnostics. Original files and unknown columns never enter storage.
    const digest = hash(parsed);
    const batchId = stableId(ctx.workspaceId, 'import_batch', s.id, key, digest);
    await guard(ctx, s.id);
    const existing = await get(ctx, 'import_batch', batchId);
    if (existing && existing.data.status !== 'rolled_back') return summary(existing);
    const currentStore = await store(ctx, s.id);
    const p = await plan(ctx, currentStore, batchId, key, parsed.rows, parsed.issues);
    const data = { ...resultFields(p), store_id: s.id, provider: s.data.provider, template_key: key, status: 'previewed', row_count: parsed.row_count, staged_rows: parsed.rows, parse_issues: parsed.issues, committed_at: null, rolled_back_at: null, journal: [] };
    const batch = existing ? await update(ctx, existing, data) : await insert(ctx, 'import_batch', data, batchId);
    await ctx.emit('commerce.import.previewed', { batch_id: batch.id, store_id: s.id, template_key: key, counts: p.counts });
    return summary(batch);
  } },
  import_error_file: { roles: writers, async run(ctx, input) {
    const batch = await batchFor(ctx, input);
    const cell = (value: unknown) => {
      const normalized = String(value);
      const safe = /^[\s]*[=+@-]/.test(normalized) ? `'${normalized}` : normalized;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const csv = ['line,code,severity,message', ...batch.data.issues.map((issue: Fields) =>
      [issue.line, issue.code, issue.severity, issue.message].map(cell).join(','))].join('\r\n') + '\r\n';
    return { batch_id: batch.id, filename: 'import-errors.csv', mime_type: 'text/csv; charset=utf-8', csv };
  } },
  preflight_import: { roles: writers, async run(ctx, input) {
    const initial = await batchFor(ctx, input);
    await guard(ctx, initial.data.store_id);
    const batch = await batchFor(ctx, input);
    if (batch.data.status !== 'previewed') return summary(batch);
    if (input.expected_version !== undefined) version(input, batch);
    const p = await check(ctx, batch, await store(ctx, batch.data.store_id));
    return p.signature === batch.data.signature ? summary(batch) : summary(await update(ctx, batch, resultFields(p)));
  } },
  commit_import: { roles: writers, async run(ctx, input) {
    const initial = await batchFor(ctx, input);
    await guard(ctx, initial.data.store_id);
    const batch = await batchFor(ctx, input);
    if (batch.data.status === 'committed') return summary(batch);
    version(input, batch);
    if (batch.data.status !== 'previewed') return conflict('invalid_state', 'Batch is not previewed');
    const s = await store(ctx, batch.data.store_id);
    const p = await check(ctx, batch, s);
    if (p.counts.invalid) throw new DomainError('import_invalid', 'Resolve all row errors before committing');
    if (p.signature !== batch.data.signature) return conflict('preflight_changed', 'Store records changed since preview. Run preflight again');
    const journal = await p.view.persist();
    if (batch.data.template_key === 'inventory_list' && s.data.sync_scope?.inventory_source !== 'inventory_list') {
      const next = await update(ctx, s, { sync_scope: { ...s.data.sync_scope, inventory_source: 'inventory_list' } });
      journal.push({ kind: 'store', id: s.id, committed_version: next.version, before: { sync_scope: s.data.sync_scope ?? {} } });
    }
    const result = await update(ctx, batch, { ...resultFields(p), status: 'committed', committed_at: ctx.now, journal });
    await ctx.emit('commerce.import.committed', { batch_id: batch.id, store_id: s.id, template_key: batch.data.template_key, counts: p.counts });
    await ctx.emit('ingest.import_batch.merged', { batch_id: batch.id, store_id: s.id, template_key: batch.data.template_key, owner_module: 'commerce' });
    return summary(result);
  } },
  rollback_import: { roles: admins, async run(ctx, input) {
    const initial = await batchFor(ctx, input);
    await guard(ctx, initial.data.store_id);
    const batch = await batchFor(ctx, input);
    if (batch.data.status === 'rolled_back') return summary(batch);
    version(input, batch);
    if (batch.data.status !== 'committed') return conflict('invalid_state', 'Batch is not committed');
    const journal: Journal[] = batch.data.journal;
    const affected = new Set(journal.map(entry => `${entry.kind}:${entry.id}`));
    const records: [Journal, Entity][] = [];
    for (const entry of journal) {
      const record = await get(ctx, entry.kind, entry.id);
      if (!record || record.version !== entry.committed_version) return conflict('rollback_conflict', 'One or more affected records changed after this import');
      records.push([entry, record]);
    }
    const dependencyRows = new Map<string, Entity[]>();
    for (const [entry] of records) {
      if (entry.before) continue;
      for (const [kind, field] of dependencies[entry.kind] ?? []) {
        const candidates = dependencyRows.get(kind) ?? await list(ctx, kind);
        dependencyRows.set(kind, candidates);
        if (candidates.some(row => active(row) && row.data[field] === entry.id && !affected.has(`${kind}:${row.id}`))) {
          return conflict('rollback_conflict', 'Later commerce records reference this import');
        }
      }
    }
    for (const [entry, record] of records.reverse()) {
      await update(ctx, record, entry.before ?? {
        rolled_back: true,
        ...(['product', 'product_variant'].includes(entry.kind) ? { status: 'rolled_back' } : {}),
        ...(entry.kind === 'listing_snapshot' ? { is_current: false } : {}),
      });
    }
    for (const coverage of (await list(ctx, 'coverage_segment')).filter(row => row.data.import_batch_id === batch.id && row.data.active === true)) {
      await update(ctx, coverage, { active: false, revoked_at: ctx.now, revocation_reason: 'import_rolled_back' });
    }
    const result = await update(ctx, batch, { status: 'rolled_back', rolled_back_at: ctx.now });
    await ctx.emit('commerce.import.rolled_back', { batch_id: batch.id, store_id: batch.data.store_id, template_key: batch.data.template_key, records: journal.map(({ kind, id }) => ({ kind, id })) });
    return summary(result);
  } },
};
