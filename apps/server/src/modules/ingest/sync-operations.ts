import { ADMIN, Problem, READ, type Context, type Data, type Operation, type Role, type Row } from '@smartsell/contracts';
import { applyCatalogPage, currentTiktokCatalogRun, reconcileStoreCatalog, tiktokCatalogBinding } from '../commerce/catalog-sync';
import { requirePhase } from '../commerce/domain';
import { prepareImport } from '../commerce/imports';
import { applyStoreSyncResult } from '../commerce/store-operations';
import { asData, currency, day, integer, invalid, iso, listed, text, windowOf } from './ingest-input';
import { callbackFallback, markIpDenied, permitSourceResource, resolveProbe } from './source-policy';

const syncRoles: readonly Role[] = ['owner', 'admin', 'manager', 'editor', 'analyst'];
const qualityRoles: readonly Role[] = ['owner', 'admin', 'manager', 'analyst'];
const activeRuns = ['queued', 'running', 'rate_limited'];
const bounds = (row: Row) => ({ from: String(row.window_from), to: String(row.window_to) });
function available(source: Row, ctx: Context) {
  if (source.status !== 'active' || source.status_reason === 'ip_not_allowed' || source.kind === 'file_import') return false;
  if (source.kind === 'vendor') return typeof source.contract_ref === 'string' && source.contract_ref.length > 0;
  const connection = ctx.list('connection').find(row => row.id === source.connection_id);
  if (!connection || !['active', 'authorized'].includes(String(connection.status)) || (connection.expires_at && String(connection.expires_at) <= ctx.now)) return false;
  if (!source.store_id) return true;
  const store = ctx.list('store').find(row => row.id === source.store_id);
  return Boolean(store && store.connection_id === source.connection_id && ['connecting', 'active', 'degraded'].includes(String(store.status)));
}
function staleTiktokCatalog(ctx: Context, run: Row, source: Row) {
  if (source.kind !== 'store' || source.provider !== 'tiktok_shop' || typeof source.store_id !== 'string' || run.resource !== 'products' || run.run_type === 'probe') return false;
  const store = ctx.list('store').find(row => row.id === source.store_id);
  const connection = ctx.list('connection').find(row => row.id === source.connection_id);
  return !store || !connection || store.connection_id !== connection.id || !currentTiktokCatalogRun(run, store, connection);
}
const scheduleFor = (ctx: Context, id: string, resource: string) => ctx.list('sync_schedule').find(row => row.data_source_id === id && row.resource === resource);
const cursorFor = (ctx: Context, id: string, resource: string) => ctx.list('sync_cursor').find(row => row.data_source_id === id && row.resource === resource);
const budgetFor = (ctx: Context, id: string) => ctx.list('collection_budget').filter(row => row.data_source_id === null || row.data_source_id === id);

function intervalWindow(ctx: Context, source: Row, resource: string) {
  const schedule = scheduleFor(ctx, source.id, resource);
  const cursor = cursorFor(ctx, source.id, resource);
  const minimumSettle = source.provider === 'amazon_sp' && resource === 'refunds' ? 48 * 3600 + 60 : 0;
  const end = Date.parse(ctx.now) - Math.max(minimumSettle, Number(schedule?.settle_seconds ?? 300)) * 1_000;
  const start = typeof cursor?.high_watermark === 'string' ? Date.parse(cursor.high_watermark) - Number(schedule?.overlap_seconds ?? 3600) * 1_000 : end - day;
  if (start >= end) throw new Problem(409, 'WINDOW_NOT_DUE', 'No new collection window is due');
  return { from: iso(start), to: iso(end) };
}

function usage(ctx: Context, budget: Row) {
  const period = ctx.now.slice(0, 7);
  const rows = ctx.list('vendor_usage').filter(row => (budget.data_source_id === null || row.data_source_id === budget.data_source_id) && String(row.period) === period);
  const units = rows.reduce((total, row) => total + Number(row.units), 0);
  const cost = rows.filter(row => row.currency === budget.currency).reduce((total, row) => total + Number(row.cost_minor), 0);
  return { units, cost_minor: cost, ratio: Math.max(budget.cap_units ? units / Number(budget.cap_units) : 0, budget.cap_minor ? cost / Number(budget.cap_minor) : 0) };
}

export function budgetInterval(ctx: Context, id: string) {
  let minimum = 0;
  for (const budget of budgetFor(ctx, id)) {
    if (usage(ctx, budget).ratio < 1) continue;
    if (budget.on_exceed === 'pause') throw new Problem(402, 'COLLECTION_BUDGET_EXCEEDED', 'Source collection is paused by budget policy');
    if (budget.on_exceed === 'reduce_frequency') minimum = Math.max(minimum, Number(budget.fallback_interval_seconds));
  }
  return minimum;
}

export function collectionBudgetState(ctx: Context, id: string) {
  let interval: number;
  try { interval = budgetInterval(ctx, id); }
  catch (error) {
    if (!(error instanceof Problem) || error.code !== 'COLLECTION_BUDGET_EXCEEDED') throw error;
    return { policy: 'pause', next_request_at: null, blocked: true };
  }
  if (!interval) return { policy: null, next_request_at: null, blocked: false };
  const last = ctx.list('vendor_usage').filter(row => row.data_source_id === id && Number(row.requests) > 0)
    .map(row => row.created_at).sort().at(-1);
  const next = last ? iso(Date.parse(last) + interval * 1000) : null;
  return { policy: 'reduce_frequency', next_request_at: next, blocked: next !== null && next > ctx.now };
}

function queue(ctx: Context, source: Row, resource: string, runType: string, period: { from: string; to: string }, extra: Data = {}) {
  permitSourceResource(source, resource);
  if (!available(source, ctx)) throw new Problem(409, 'SOURCE_UNAVAILABLE', 'Source needs an active collection path');
  const store = source.kind === 'store' && source.provider === 'tiktok_shop' && resource === 'products' && typeof source.store_id === 'string'
    ? ctx.get('store', source.store_id) : undefined;
  const catalogBinding = store && tiktokCatalogBinding(store, ctx.get('connection', String(source.connection_id)));
  const snapshot = store && runType === 'catalog_snapshot';
  const deduped = ctx.list('sync_run').find(run => run.data_source_id === source.id && run.resource === resource && run.run_type === runType &&
    (!store || (run.catalog_binding === catalogBinding && (!snapshot || store.catalog_snapshot_run_id === run.id))) &&
    (extra.idempotency_key ? run.idempotency_key === extra.idempotency_key && run.requested_by === ctx.actorId :
      activeRuns.includes(String(run.status)) && (snapshot || (run.window_from === period.from && run.window_to === period.to)) && run.external_id === extra.external_id));
  if (deduped) return deduped;
  const interval = Math.max(Number(source.min_sync_interval_min ?? 0) * 60, budgetInterval(ctx, source.id));
  if (interval && ['refresh', 'scheduled'].includes(runType)) {
    const last = ctx.list('sync_run').filter(run => run.data_source_id === source.id && run.resource === resource && ['refresh', 'scheduled'].includes(String(run.run_type)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (last && Date.parse(ctx.now) - Date.parse(last.created_at) < interval * 1000) {
      throw new Problem(402, 'LICENSE_LIMIT', 'Collection interval is below the allowed minimum');
    }
  }
  const run = ctx.create('sync_run', { ...extra, data_source_id: source.id, resource, run_type: runType, window_from: period.from, window_to: period.to,
    status: 'queued', executor_status: 'awaiting_adapter', requested_by: ctx.actorId, request_count: 0, checkpoint_index: 0, attempt: 1,
    ...(store && { catalog_binding: catalogBinding }) });
  if (snapshot) ctx.update('store', store.id, { catalog_snapshot_run_id: run.id });
  ctx.emit('ingest.sync_run.queued', { sync_run_id: run.id, data_source_id: source.id, run_type: runType });
  return run;
}

function explicitPeriod(ctx: Context, body: Data, maxDays = 366) {
  const period = windowOf(body.from, body.to);
  const span = Date.parse(period.to) - Date.parse(period.from);
  if (period.to > ctx.now || span > maxDays * day) invalid(`Window must end by now and span no more than ${maxDays} days`);
  return period;
}

function refresh(ctx: Context, source: Row, body: Data, mode: 'refresh' | 'reconcile', key?: string) {
  const resource = text(body.resource ?? (listed(source.resources).length === 1 ? listed(source.resources)[0] : undefined), 'resource');
  const period = mode === 'reconcile' && (body.from !== undefined || body.to !== undefined) ? explicitPeriod(ctx, body) : intervalWindow(ctx, source, resource);
  const run = queue(ctx, source, resource, mode, period, { idempotency_key: key });
  return trackSyncRun(ctx, run);
}

function syncRunProgress(run: Row) {
  return { sync_run_id: run.id, executor_status: run.executor_status, checkpoint_index: run.checkpoint_index,
    error_class: run.error_class ?? null, error_reason: run.error_reason ?? null };
}

function trackSyncRun(ctx: Context, run: Row) {
  const operationId = typeof run.operation_id === 'string' ? run.operation_id : ctx.create('operation', { kind: 'ingest.sync_run', resource_id: run.id,
    status: run.status, progress: syncRunProgress(run) }).id;
  if (!run.operation_id) ctx.update('sync_run', run.id, { operation_id: operationId });
  return { operation_id: operationId, sync_run_id: run.id, status: run.status, executor_status: run.executor_status };
}

// Keep the operation view in the same transaction as each visible worker transition.
export function updateSyncRun(ctx: Context, id: string, patch: Data) {
  const run = ctx.update('sync_run', id, patch);
  if (typeof run.operation_id === 'string') {
    ctx.update('operation', run.operation_id, { status: run.status, progress: syncRunProgress(run),
      ...(typeof run.cancel_requested_at === 'string' && { cancel_requested_at: run.cancel_requested_at }) });
  }
  if (run.run_type === 'backfill') {
    for (const batch of ctx.list('sync_backfill')) {
      if (batch.status !== 'cancelled' && batch.operation_id && listed(batch.sync_run_ids).includes(id)) updateBackfillOperation(ctx, batch);
    }
  }
  return run;
}

export function requestStoreSync(ctx: Context, store: Row, mode: 'refresh' | 'reconcile', body?: Data) {
  const source = ctx.list('data_source').find(row => row.store_id === store.id && row.kind === 'store' && row.connection_id === store.connection_id && row.status !== 'disabled');
  if (!source || !source.connection_id) throw new Problem(409, 'SOURCE_UNAVAILABLE', 'Register the authorized store data source before requesting collection');
  requirePhase(ctx, store.provider === 'shopify' || store.provider === 'tiktok_shop' ? 'p0b' : store.provider === 'lazada' ? 'p2' : 'p1');
  const connection = ctx.get('connection', String(source.connection_id));
  if (!['active', 'authorized'].includes(String(connection.status)) || (connection.expires_at && Date.parse(String(connection.expires_at)) <= Date.parse(ctx.now))) {
    throw new Problem(409, 'SOURCE_UNAVAILABLE', 'Store authorization is no longer current');
  }
  if (mode === 'reconcile') {
    if (body?.from !== undefined || body?.to !== undefined || (body?.resource !== undefined && body.resource !== 'products')) invalid('Full store sync only supports an unwindowed product catalog snapshot');
    const period = intervalWindow(ctx, source, 'products');
    const run = queue(ctx, source, 'products', 'catalog_snapshot', period);
    return trackSyncRun(ctx, run);
  }
  return refresh(ctx, source, { resource: 'products', ...body }, mode);
}

function writeGap(ctx: Context, source: Row, resource: string, period: { from: string; to: string }, gapType: string, unrecoverable = false) {
  const existing = ctx.list('data_gap').find(row => row.data_source_id === source.id && row.resource === resource && row.from === period.from && row.to === period.to && row.gap_type === gapType && row.status !== 'resolved');
  if (existing) return existing;
  const gap = ctx.create('data_gap', { ...period, data_source_id: source.id, resource, gap_type: gapType,
    severity: 'warning', status: unrecoverable ? 'unrecoverable' : 'open', detected_by: 'coverage_scan' });
  ctx.emit('ingest.data_gap.detected', { data_gap_id: gap.id, gap_type: gapType });
  return gap;
}

function segment(ctx: Context, id: string, resource: string, period: { from: string; to: string }, status: string, runId?: string) {
  return ctx.create('coverage_segment', { ...period, data_source_id: id, resource, status, sync_run_id: runId });
}

function splitRetention(ctx: Context, source: Row, resource: string, { from, to }: { from: string; to: string }) {
  const history = String(asData(source.history_limit)[resource] ?? 'P30D');
  const days = Number(history.slice(1, -1)) * ({ D: 1, M: 30, Y: 365 }[history.at(-1) ?? ''] ?? 1);
  const cutoff = iso(Date.parse(ctx.now) - days * day);
  if (from >= cutoff) return { remaining: { from, to } };
  const unavailable = { from, to: to < cutoff ? to : cutoff };
  const gap = writeGap(ctx, source, resource, unavailable, 'out_of_retention', true);
  if (!ctx.list('coverage_segment').some(row => row.gap_id === gap.id)) {
    ctx.create('coverage_segment', { ...unavailable, data_source_id: source.id, resource, status: 'unavailable_retention', gap_id: gap.id });
  }
  return { remaining: to > cutoff ? { from: cutoff, to } : null, gap };
}

function backfill(ctx: Context, source: Row, resources: string[], period: { from: string; to: string }, key?: string) {
  if (!resources.length || resources.length > 10) invalid('Select one to ten resources');
  if (!available(source, ctx)) throw new Problem(409, 'SOURCE_UNAVAILABLE', 'Source cannot run a backfill');
  const requestKey = JSON.stringify([source.id, [...resources].sort(), period]);
  const prior = ctx.list('sync_backfill').find(row => row.request_key === requestKey &&
    ((key && row.idempotency_key === key) || ['queued', 'interrupted'].includes(backfillProgress(ctx, row).status)));
  if (prior) return prior;
  const batch = ctx.create('sync_backfill', { ...period, data_source_id: source.id, resources, status: 'queued', request_key: requestKey, idempotency_key: key });
  const runIds: string[] = [], gapIds: string[] = [];
  for (const resource of resources) {
    permitSourceResource(source, resource);
    for (const missing of coverage(ctx, source.id, resource, period)) {
      if (missing.status === 'complete') continue;
      const { remaining, gap } = splitRetention(ctx, source, resource, missing);
      if (gap) gapIds.push(gap.id);
      if (!remaining) continue;
      const end = Date.parse(remaining.to);
      for (let cursor = Date.parse(remaining.from); cursor < end; cursor += 7 * day) {
        const portion = { from: iso(cursor), to: iso(Math.min(cursor + 7 * day, end)) };
        runIds.push(queue(ctx, source, resource, 'backfill', portion, { backfill_id: batch.id }).id);
      }
    }
  }
  return ctx.update('sync_backfill', batch.id, { sync_run_ids: runIds, gap_ids: gapIds, status: runIds.length ? 'queued' : gapIds.length ? 'unavailable' : 'complete' });
}

function coverage(ctx: Context, id: string, resource: string, period: { from: string; to: string }) {
  const rows = ctx.list('coverage_segment').filter(row => row.data_source_id === id && row.resource === resource && String(row.from) < period.to && String(row.to) > period.from);
  const points = [...new Set([period.from, period.to, ...rows.flatMap(row => [String(row.from), String(row.to)]).filter(value => value > period.from && value < period.to)])].sort();
  return points.slice(0, -1).map((from, index) => {
    const to = points[index + 1];
    const matching = rows.filter(row => String(row.from) <= from && String(row.to) >= to);
    return { from, to, status: matching.find(row => row.status === 'complete')?.status ?? matching.at(-1)?.status ?? 'not_collected' };
  });
}

function reportGap(ctx: Context, source: Row, resource: string, period: { from: string; to: string }, result: string, reason?: string) {
  segment(ctx, source.id, resource, period, result === 'succeeded' ? 'complete' : result === 'partially_succeeded' ? 'partial' : 'failed');
  if (result !== 'succeeded') {
    writeGap(ctx, source, resource, period, reason === 'ip_not_allowed' ? reason : 'sync_failed');
  } else {
    for (const gap of ctx.list('data_gap').filter(row => row.data_source_id === source.id && row.resource === resource && ['open', 'backfill_scheduled'].includes(String(row.status)))) {
      if (coverage(ctx, source.id, resource, { from: String(gap.from), to: String(gap.to) }).every(item => item.status === 'complete')) {
        ctx.update('data_gap', gap.id, { status: 'resolved', resolved_at: ctx.now });
        ctx.emit('ingest.data_gap.resolved', { data_gap_id: gap.id });
      }
    }
  }
}

/** Trusted worker boundary. Invoke in the same transaction as a validated sink page. */
export function recordSyncPage(ctx: Context, runId: string, page: {
  index: number; attempt: number; cursor?: string; requests: number; units?: number; cost_minor?: number; currency?: string;
  result: 'more' | 'succeeded' | 'partially_succeeded' | 'failed' | 'rate_limited'; error_class?: string; error_reason?: string; retry_at?: string;
}) {
  const run = ctx.get('sync_run', runId);
  const index = integer(page.index, 'index', 1);
  if (page.attempt !== run.attempt) throw new Problem(409, 'STALE_SYNC_ATTEMPT', 'Worker attempt has been superseded');
  if (index <= Number(run.checkpoint_index)) return run;
  if (!activeRuns.includes(String(run.status)) || index !== Number(run.checkpoint_index) + 1) throw new Problem(409, 'BAD_CHECKPOINT', 'Unexpected page checkpoint');
  if (run.status === 'rate_limited' && String(run.retry_at) > ctx.now) throw new Problem(409, 'SYNC_RATE_LIMITED', 'Wait until the retry time');
  if (page.result === 'more' && !page.cursor) invalid('Incomplete page sequence requires a cursor');
  if (page.result === 'rate_limited' && (!page.retry_at || page.retry_at <= ctx.now)) invalid('A future retry time is required');
  const source = ctx.get('data_source', String(run.data_source_id));
  const staleCatalog = staleTiktokCatalog(ctx, run, source);
  if (run.run_type !== 'probe' && page.result !== 'failed' && (staleCatalog || !available(source, ctx))) {
    throw new Problem(409, 'SOURCE_UNAVAILABLE', 'Collection authorization is no longer current');
  }
  const requests = integer(page.requests, 'requests'), units = integer(page.units ?? requests, 'units'), cost = integer(page.cost_minor ?? 0, 'cost_minor');
  const code = page.currency === undefined ? null : currency(page.currency);
  if (cost && !code) invalid('A currency is required for cost accounting');
  const terminal = ['succeeded', 'failed', 'partially_succeeded'].includes(page.result);
  const requestCount = Number(run.request_count ?? 0) + requests;
  const updated = updateSyncRun(ctx, run.id, {
    status: page.result === 'more' ? 'running' : page.result, executor_status: terminal ? 'finished' : 'running',
    checkpoint_index: index, cursor_after: page.cursor ?? (['failed', 'rate_limited', 'partially_succeeded'].includes(page.result) ? run.cursor_after : null), request_count: requestCount,
    started_at: run.started_at ?? ctx.now, finished_at: terminal ? ctx.now : null, retry_at: page.retry_at ?? null,
    error_class: page.error_class ?? null, error_reason: page.error_reason ?? null,
  });
  if (requests || units || cost) {
    ctx.create('vendor_usage', { data_source_id: source.id, provider: source.provider, sync_run_id: run.id, period: ctx.now.slice(0, 7), requests, units, cost_minor: cost, currency: code });
    for (const budget of budgetFor(ctx, source.id)) {
      const totals = usage(ctx, budget);
      const tier = totals.ratio >= 1 ? 100 : totals.ratio >= .8 ? 80 : 0;
      if (tier && (budget.alert_period !== ctx.now.slice(0, 7) || Number(budget.alert_tier) < tier)) {
        ctx.update('collection_budget', budget.id, { alert_period: ctx.now.slice(0, 7), alert_tier: tier });
        ctx.emit('ingest.budget.threshold_reached', { collection_budget_id: budget.id, data_source_id: source.id, percent: tier });
      }
    }
  }
  if (!terminal) return updated;
  ctx.create('usage_event', { meter_key: 'sync_calls', quantity: requestCount, source_ref: { resource_type: 'sync_run', resource_id: run.id, attempt: run.attempt } });
  if (run.run_type === 'probe') {
    const recovered = resolveProbe(ctx, source.id, page.result === 'succeeded');
    if (source.status_reason === 'ip_not_allowed' && recovered.status === 'active') {
      for (const gap of ctx.list('data_gap').filter(row => row.data_source_id === source.id && row.gap_type === 'ip_not_allowed' && row.status === 'open')) {
        const resource = String(gap.resource);
        if (!listed(source.resources).includes(resource)) continue;
        try {
          const plan = backfill(ctx, recovered, [resource], { from: String(gap.from), to: String(gap.to) });
          ctx.update('data_gap', gap.id, { backfill_id: plan.id, status: plan.status === 'unavailable' ? 'unrecoverable' : plan.status === 'complete' ? 'resolved' : 'backfill_scheduled' });
        } catch (error) { if (!(error instanceof Problem) || error.status !== 402) throw error; }
      }
    }
  } else if (!staleCatalog) {
    const resource = String(run.resource);
    // Reading one targeted order cannot prove coverage for the entire store window.
    if (!(source.kind === 'store' && ['orders', 'refunds'].includes(resource) && run.external_id)) {
      reportGap(ctx, source, resource, bounds(run), page.result, page.error_reason);
    }
    if (page.result === 'succeeded') {
      if (['refresh', 'scheduled'].includes(String(run.run_type))) {
        const cursor = cursorFor(ctx, source.id, resource);
        if (!cursor || String(cursor.high_watermark) < String(run.window_to)) {
          const fields = { data_source_id: source.id, resource, high_watermark: run.window_to, cursor: page.cursor ?? null };
          if (cursor) ctx.update('sync_cursor', cursor.id, fields);
          else ctx.create('sync_cursor', fields);
        }
      }
      ctx.update('data_source', source.id, { last_success_at: ctx.now });
      if (source.store_id && resource === 'products' && run.run_type !== 'catalog_snapshot') {
        applyStoreSyncResult(ctx, String(source.store_id), { state: 'incremental' });
      }
    } else if (page.error_reason === 'ip_not_allowed') {
      markIpDenied(ctx, source);
      if (source.store_id) applyStoreSyncResult(ctx, String(source.store_id), { state: 'degraded', reason: 'ip_not_allowed' });
    }
  }
  ctx.emit(`ingest.sync_run.${page.result === 'failed' ? 'failed' : 'completed'}`, { sync_run_id: runId, data_source_id: source.id, resource: run.resource,
    status: page.result, error_class: page.error_class, error_reason: page.error_reason });
  return updated;
}

/** Authenticated catalog adapter results, persisted atomically with the run checkpoint. */
export function recordCatalogPage(ctx: Context, runId: string, input: {
  index: number; attempt: number; requests: number; page: Parameters<typeof applyCatalogPage>[2];
  completesSnapshot?: boolean; authoritative?: boolean;
}) {
  const run = ctx.get('sync_run', runId);
  if (input.attempt !== run.attempt) throw new Problem(409, 'STALE_SYNC_ATTEMPT', 'Worker attempt has been superseded');
  if (input.index <= Number(run.checkpoint_index)) return run;
  const source = ctx.get('data_source', String(run.data_source_id));
  if (source.kind !== 'store' || !source.store_id || run.resource !== 'products' || !available(source, ctx)) invalid('Run is not collecting a store catalog');
  const storeId = String(source.store_id);
  const store = ctx.get('store', storeId);
  if (store.connection_id !== source.connection_id) throw new Problem(409, 'SOURCE_UNAVAILABLE', 'Store connection changed');
  const final = input.page.nextCursor === null;
  const full = run.run_type === 'catalog_snapshot';
  const partial = run.catalog_partial === true || input.page.items.some(item => item.variantsComplete === false);
  const incomplete = partial || (full && input.completesSnapshot !== true && input.authoritative !== true);
  const checkpoint = recordSyncPage(ctx, runId, {
    index: input.index, attempt: input.attempt, requests: input.requests, cursor: input.page.nextCursor ?? undefined,
    result: final ? incomplete ? 'partially_succeeded' : 'succeeded' : 'more',
  });
  applyCatalogPage(ctx, storeId, input.page, run.id);
  const seenProductIds = full ? [...new Set([...listed(run.seen_product_ids), ...input.page.items.map(item => item.externalId)])] : [];
  if (full && final && !incomplete) {
    if (input.authoritative === true) reconcileStoreCatalog(ctx, storeId, seenProductIds);
    applyStoreSyncResult(ctx, storeId, { state: 'full' });
  }
  return ctx.update('sync_run', checkpoint.id, { catalog_partial: final ? false : partial, seen_product_ids: final ? [] : seenProductIds });
}

/** Store order and refund pages can only use the read-only, privacy-filtering commerce sink. */
export function recordStoreTradePage(ctx: Context, runId: string, input: {
  index: number; attempt: number; requests: number; cursor: string | null; rows: Data[];
}) {
  const run = ctx.get('sync_run', runId);
  if (input.attempt !== run.attempt) throw new Problem(409, 'STALE_SYNC_ATTEMPT', 'Worker attempt has been superseded');
  if (input.index <= Number(run.checkpoint_index)) return run;
  const source = ctx.get('data_source', String(run.data_source_id));
  if (source.kind !== 'store' || !source.store_id || !available(source, ctx) || !['orders', 'refunds'].includes(String(run.resource))) invalid('Run is not collecting store transactions');
  const store = ctx.get('store', String(source.store_id));
  if (store.connection_id !== source.connection_id) throw new Problem(409, 'SOURCE_UNAVAILABLE', 'Store connection changed');
  const checkpoint = recordSyncPage(ctx, runId, {
    index: input.index, attempt: input.attempt, requests: input.requests, cursor: input.cursor ?? undefined,
    result: input.cursor === null ? 'succeeded' : 'more',
  });
  const metadata = { mode: 'api', batchId: run.id } as const;
  for (const row of input.rows) {
    if (run.resource === 'refunds' && row.order !== undefined) {
      const parent = asData(row.order);
      if (typeof row.external_order_id !== 'string' || parent.external_order_id !== row.external_order_id) invalid('Refund parent order does not match the refund');
      if (!ctx.list('order').some(order => order.store_id === store.id && order.external_order_id === row.external_order_id)) {
        // Refunds may arrive in an update window long after the original order was placed.
        prepareImport(ctx, 'order_list', store.id, parent, metadata)();
      }
    }
    prepareImport(ctx, run.resource === 'orders' ? 'order_list' : 'refund_list', store.id, row, metadata)();
  }
  return checkpoint;
}

/** Only called by ingress after platform verification. No event body is persisted. */
export function receiveVerifiedDelivery(ctx: Context, input: { sourceId: string; resource: string; eventId: string; externalId: string; transport: 'https' | 'sqs' | 'eventbridge' }) {
  const source = ctx.get('data_source', input.sourceId);
  permitSourceResource(source, input.resource);
  if ((source.provider === 'amazon_sp') !== (input.transport !== 'https')) invalid('Provider does not use this notification transport');
  const eventId = text(input.eventId, 'eventId');
  const prior = ctx.list('webhook_delivery').find(row => row.data_source_id === source.id && row.external_event_id === eventId);
  if (prior) return { delivery: prior, duplicate: true };
  const delivery = ctx.create('webhook_delivery', { data_source_id: source.id, provider: source.provider, resource: input.resource,
    external_event_id: eventId, transport: input.transport, signature_status: input.transport === 'https' ? 'verified' : 'not_applicable', status: 'received' });
  if (!available(source, ctx) || callbackFallback(ctx, source)) return { delivery, duplicate: false };
  let run: Row;
  try {
    run = queue(ctx, source, input.resource, 'webhook_triggered', { from: iso(Date.parse(ctx.now) - day), to: ctx.now }, { external_id: text(input.externalId, 'externalId') });
  } catch (error) {
    if (error instanceof Problem && error.status === 402) return { delivery, duplicate: false };
    throw error;
  }
  return { delivery: ctx.update('webhook_delivery', delivery.id, { status: 'routed', sync_run_id: run.id }), duplicate: false };
}

export function dispatchDueSyncs(ctx: Context) {
  const runs: Row[] = [];
  for (const schedule of ctx.list('sync_schedule')) {
    if (schedule.mode === 'manual_only') continue;
    const source = ctx.get('data_source', String(schedule.data_source_id));
    const resource = String(schedule.resource);
    const fallback = callbackFallback(ctx, source);
    const defaultSeconds = 86_400;
    if (schedule.mode !== 'interval' && schedule.mode !== 'on_event') continue;
    if (!available(source, ctx) || !listed(source.resources).includes(resource)) continue;
    const requests = ctx.list('sync_run').filter(run => run.data_source_id === source.id && run.resource === resource && run.run_type === 'scheduled');
    if (requests.some(run => activeRuns.includes(String(run.status)))) continue;
    try {
      const normal = schedule.mode === 'interval' ? Number(schedule.interval_seconds) : defaultSeconds;
      const seconds = Math.max(fallback ? Math.min(normal, 900) : normal,
        Number(source.min_sync_interval_min ?? 0) * 60, budgetInterval(ctx, source.id));
      const last = requests.map(run => run.created_at).sort().at(-1);
      const next = fallback || schedule.mode === 'on_event'
        ? iso(Date.parse(last ?? schedule.created_at) + seconds * 1_000)
        : schedule.next_due_at;
      if (typeof next === 'string' && next > ctx.now) continue;
      const run = queue(ctx, source, resource, 'scheduled', intervalWindow(ctx, source, resource));
      ctx.update('sync_schedule', schedule.id, { next_due_at: iso(Date.parse(ctx.now) + (fallback ? normal : seconds) * 1_000) });
      runs.push(run);
    } catch (error) { if (!(error instanceof Problem) || ![402, 409].includes(error.status)) throw error; }
  }
  return runs;
}

function saveSchedule(ctx: Context, body: Data, existing?: Row) {
  const source = ctx.get('data_source', text(existing?.data_source_id ?? body.data_source_id, 'data_source_id'));
  const resource = text(existing?.resource ?? body.resource, 'resource');
  permitSourceResource(source, resource);
  if (!existing && scheduleFor(ctx, source.id, resource)) throw new Problem(409, 'SCHEDULE_EXISTS', 'Update the existing resource schedule');
  const mode = body.mode ?? existing?.mode ?? 'manual_only';
  if (!['manual_only', 'interval', 'on_event'].includes(String(mode))) invalid('Schedule mode must be manual_only, interval or on_event');
  const interval = mode === 'interval' ? integer(body.interval_seconds ?? existing?.interval_seconds, 'interval_seconds', 60, 604_800) : null;
  if (interval !== null && interval < Number(source.min_sync_interval_min ?? 0) * 60) throw new Problem(402, 'LICENSE_LIMIT', 'Schedule interval is below the allowed minimum');
  const values = { mode, interval_seconds: interval, overlap_seconds: integer(body.overlap_seconds ?? existing?.overlap_seconds ?? 3600, 'overlap_seconds', 0, 604_800),
    settle_seconds: integer(body.settle_seconds ?? existing?.settle_seconds ?? 300, 'settle_seconds', 0, 604_800),
    next_due_at: interval === null ? null : iso(Date.parse(ctx.now) + interval * 1_000) };
  return existing ? ctx.update('sync_schedule', existing.id, values) : ctx.create('sync_schedule', { ...values, data_source_id: source.id, resource });
}

function retryRun(ctx: Context, run: Row, patch: Data = {}) {
  const next = updateSyncRun(ctx, run.id, { status: 'queued', executor_status: 'awaiting_adapter', finished_at: null,
    error_reason: null, error_class: null, request_count: 0, page_failures: 0, attempt: Number(run.attempt) + 1, retry_at: null, ...patch });
  ctx.emit('ingest.sync_run.queued', { sync_run_id: run.id, data_source_id: run.data_source_id });
  return next;
}

export function syncCancellationInFlight(ctx: Context, run: Row) {
  const source = ctx.get('data_source', String(run.data_source_id));
  if (source.kind !== 'store' || typeof source.connection_id !== 'string') return false;
  return ctx.list('commerce_sync_lease').some(lease => lease.connection_id === source.connection_id &&
    (lease.sync_run_id == null || lease.sync_run_id === run.id) && Number(lease.expires_at_ms) > Date.parse(ctx.now));
}

export function finishSyncCancellation(ctx: Context, run: Row) {
  updateSyncRun(ctx, run.id, { status: 'cancelled', executor_status: 'finished', finished_at: ctx.now,
    cancel_requested_at: run.cancel_requested_at ?? ctx.now, retry_at: null });
  ctx.emit('ingest.sync_run.cancelled', { sync_run_id: run.id, data_source_id: run.data_source_id });
}

export function cancelIngestOperation(ctx: Context, operation: Row): Row {
  if (['cancel_requested', 'cancelled'].includes(String(operation.status))) return operation;
  const batch = operation.kind === 'ingest.backfill' ? ctx.get('sync_backfill', String(operation.resource_id)) : undefined;
  const runs = batch ? backfillProgress(ctx, batch).runs : [ctx.get('sync_run', String(operation.resource_id))];
  const active = runs.filter(run => activeRuns.includes(String(run.status)));
  if (!active.length) throw new Problem(409, 'INVALID_STATE', 'Collection has no unfinished runs');
  // Overlapping backfills may reuse the same active slice. Cancelling one releases only its interest in that slice.
  const shared = batch ? new Set(ctx.list('sync_backfill').filter(other => other.id !== batch.id && !['cancel_requested', 'cancelled'].includes(String(other.status)))
    .flatMap(other => listed(other.sync_run_ids))) : new Set<string>();
  const detached = active.filter(run => shared.has(run.id)).map(run => run.id);
  const cancelled = batch && ctx.update('sync_backfill', batch.id, { status: 'cancel_requested', detached_sync_run_ids: detached });
  for (const run of active) {
    if (shared.has(run.id)) continue;
    if (run.status === 'running' && syncCancellationInFlight(ctx, run)) {
      updateSyncRun(ctx, run.id, { status: 'cancel_requested', cancel_requested_at: ctx.now });
    } else finishSyncCancellation(ctx, run);
  }
  if (!cancelled) return ctx.get('operation', operation.id);
  const next = backfillOperationState(ctx, cancelled);
  if (next.status === 'cancelled' && ctx.get('sync_backfill', cancelled.id).status !== 'cancelled') {
    ctx.update('sync_backfill', cancelled.id, { status: 'cancelled' });
  }
  return ctx.update('operation', operation.id, { ...next, cancel_requested_at: ctx.now });
}

function backfillProgress(ctx: Context, batch: Row) {
  const detached = new Set(listed(batch.detached_sync_run_ids));
  const runs = listed(batch.sync_run_ids).map(id => {
    const run = ctx.get('sync_run', id);
    return detached.has(id) ? { ...run, status: 'cancelled', executor_status: 'detached' } : run;
  });
  const gaps = listed(batch.gap_ids).map(id => ctx.get('data_gap', id));
  const complete = runs.filter(run => run.status === 'succeeded').length;
  const failed = runs.filter(run => ['failed', 'partially_succeeded'].includes(String(run.status))).length;
  const unavailable = runs.filter(run => run.status === 'unavailable').length;
  const cancelled = runs.filter(run => run.status === 'cancelled').length;
  const pending = runs.length - complete - failed - unavailable - cancelled;
  const status = ['cancel_requested', 'cancelled'].includes(String(batch.status))
    ? pending ? 'cancel_requested' : 'cancelled'
    : pending ? 'queued' : failed ? 'interrupted' : gaps.length ? complete ? 'partial' : 'unavailable' : 'complete';
  return { ...batch, status, progress: { complete, failed, pending, total: runs.length, ...(cancelled > 0 && { cancelled }) }, runs, gaps };
}

function backfillOperationState(ctx: Context, batch: Row) {
  const { status, progress, runs, gaps } = backfillProgress(ctx, batch);
  const operationStatus = status === 'queued' ? (runs.some(run => run.status === 'running') ? 'running' : 'queued')
    : status === 'complete' ? 'succeeded' : status === 'partial' ? 'partially_succeeded'
      : status === 'cancelled' || status === 'cancel_requested' ? status : 'failed';
  return { status: operationStatus, progress: { backfill_id: batch.id, ...progress, gaps: gaps.length } };
}

function updateBackfillOperation(ctx: Context, batch: Row) {
  if (typeof batch.operation_id !== 'string') return;
  const current = ctx.get('operation', batch.operation_id);
  const next = backfillOperationState(ctx, batch);
  if (batch.status === 'cancel_requested' && next.status === 'cancelled') ctx.update('sync_backfill', batch.id, { status: 'cancelled' });
  if (current.status !== next.status || Object.entries(next.progress).some(([key, value]) => asData(current.progress)[key] !== value)) {
    ctx.update('operation', current.id, next);
  }
}

function resumeBackfill(ctx: Context, batch: Row) {
  if (['cancelled', 'cancel_requested'].includes(String(batch.status))) throw new Problem(409, 'INVALID_STATE', 'Cancelled backfills cannot resume');
  const source = ctx.get('data_source', String(batch.data_source_id));
  if (!available(source, ctx)) throw new Problem(409, 'SOURCE_UNAVAILABLE', 'Source cannot resume a backfill');
  const gapIds = new Set(listed(batch.gap_ids));
  for (const run of backfillProgress(ctx, batch).runs) {
    if (!['failed', 'partially_succeeded'].includes(String(run.status))) continue;
    const resource = String(run.resource);
    permitSourceResource(source, resource);
    const { remaining, gap } = splitRetention(ctx, source, resource, bounds(run));
    if (gap) gapIds.add(gap.id);
    if (!remaining) {
      updateSyncRun(ctx, run.id, { status: 'unavailable', error_reason: 'out_of_retention' });
      continue;
    }
    budgetInterval(ctx, source.id);
    // Provider cursors belong to the original time window. Keep them only for unchanged shards.
    const resetCursor = gap || run.status === 'partially_succeeded';
    retryRun(ctx, run, resetCursor ? { window_from: remaining.from, cursor_after: null, checkpoint_index: 0, cursor_hashes: [], catalog_partial: false } : {});
  }
  const gapList = [...gapIds];
  const next = gapList.length === listed(batch.gap_ids).length ? batch : ctx.update('sync_backfill', batch.id, { gap_ids: gapList });
  updateBackfillOperation(ctx, next);
  return backfillProgress(ctx, next);
}

export const syncOperations: Operation[] = [
  { path: '/data-sources/:id/refresh', method: 'POST', name: 'sync_refresh', accepted: true, roles: syncRoles, summary: 'Queue collection for an authorized source', run: (ctx, input) => refresh(ctx, ctx.get('data_source', input.params.id), input.body, 'refresh', input.idempotencyKey) },
  { path: '/data-sources/:id/reconcile', method: 'POST', name: 'sync_reconcile', accepted: true, roles: syncRoles, summary: 'Queue read-only reconciliation of a source window', run: (ctx, input) => refresh(ctx, ctx.get('data_source', input.params.id), input.body, 'reconcile', input.idempotencyKey) },
  { path: '/data-sources/:id/coverage', method: 'GET', name: 'data_source_coverage', roles: READ, summary: 'Read complete, incomplete, and unknown source windows', run(ctx, { params, query }) {
    const source = ctx.get('data_source', params.id);
    const resource = text(query.resource, 'resource');
    permitSourceResource(source, resource);
    return coverage(ctx, source.id, resource, explicitPeriod(ctx, query));
  } },
  { path: '/sync-runs', method: 'GET', name: 'sync_run_list', roles: READ, summary: 'List collection requests and actual results', run: (ctx, { query }) => ctx.list('sync_run').filter(row => !query.data_source_id || row.data_source_id === query.data_source_id) },
  { path: '/sync-runs/:id', method: 'GET', name: 'sync_run_get', roles: READ, summary: 'Read collection run and page checkpoint', run: (ctx, { params }) => ctx.get('sync_run', params.id) },
  { path: '/sync-runs/:id/retry', method: 'POST', name: 'sync_run_retry', roles: syncRoles, summary: 'Queue a failed run from its last durable page', run(ctx, { params }) {
    const run = ctx.get('sync_run', params.id);
    const source = ctx.get('data_source', String(run.data_source_id));
    if (!['failed', 'partially_succeeded'].includes(String(run.status)) || !available(source, ctx)) throw new Problem(409, 'SYNC_NOT_RETRYABLE', 'Run or source is unavailable for retry');
    budgetInterval(ctx, source.id);
    const tiktokCatalog = source.kind === 'store' && source.provider === 'tiktok_shop' && run.resource === 'products' && typeof source.store_id === 'string';
    if (tiktokCatalog && staleTiktokCatalog(ctx, run, source)) {
      throw new Problem(409, 'SYNC_NOT_RETRYABLE', 'Start a new catalog sync for the current authorization and scope');
    }
    if (run.backfill_id) return resumeBackfill(ctx, ctx.get('sync_backfill', String(run.backfill_id))).runs.find(row => row.id === run.id);
    const restart = tiktokCatalog && run.run_type === 'catalog_snapshot' && run.status === 'partially_succeeded';
    return retryRun(ctx, run, restart ? { cursor_after: null, checkpoint_index: 0, cursor_hashes: [], catalog_partial: false,
      seen_product_ids: [], catalog_total_count: null } : {});
  } },
  { path: '/sync-schedules', method: 'GET', name: 'sync_schedule_list', roles: READ, summary: 'List collection frequency and next due times', run: ctx => ctx.list('sync_schedule') },
  { path: '/sync-schedules', method: 'POST', name: 'sync_schedule_create', roles: syncRoles, summary: 'Set collection cadence for a resource', run: (ctx, { body }) => saveSchedule(ctx, body) },
  { path: '/sync-schedules/:id', method: 'PATCH', name: 'sync_schedule_update', roles: syncRoles, versionKind: 'sync_schedule', summary: 'Update collection frequency and window overlap', run: (ctx, { params, body }) => saveSchedule(ctx, body, ctx.get('sync_schedule', params.id)) },
  { path: '/backfills', method: 'POST', name: 'backfill_plan', accepted: true, roles: syncRoles, summary: 'Plan bounded historical collection slices', run(ctx, input) {
    const source = ctx.get('data_source', text(input.body.data_source_id, 'data_source_id'));
    const batch = backfill(ctx, source, [...new Set(listed(input.body.resources))], explicitPeriod(ctx, input.body), input.idempotencyKey);
    if (batch.operation_id) return batch;
    const operation = ctx.create('operation', { kind: 'ingest.backfill', resource_id: batch.id, ...backfillOperationState(ctx, batch) });
    return ctx.update('sync_backfill', batch.id, { operation_id: operation.id });
  } },
  { path: '/backfills', method: 'GET', name: 'backfill_list', roles: READ, summary: 'List historical collection progress', run: ctx => ctx.list('sync_backfill').map(batch => backfillProgress(ctx, batch)) },
  { path: '/backfills/:id', method: 'GET', name: 'backfill_get', roles: READ, summary: 'Read actual progress of all backfill slices', run: (ctx, { params }) => backfillProgress(ctx, ctx.get('sync_backfill', params.id)) },
  { path: '/backfills/:id/resume', method: 'POST', name: 'backfill_resume', roles: syncRoles, summary: 'Resume unfinished historical collection slices', run: (ctx, { params }) => resumeBackfill(ctx, ctx.get('sync_backfill', params.id)) },
  { path: '/data-gaps', method: 'GET', name: 'data_gap_list', roles: READ, summary: 'List missing source windows', run: (ctx, { query }) => ctx.list('data_gap').filter(row => !query.status || row.status === query.status) },
  { path: '/data-gaps/:id/accept', method: 'POST', name: 'data_gap_accept', roles: qualityRoles, summary: 'Accept a data gap with a reason', run(ctx, { params, body }) {
    const gap = ctx.get('data_gap', params.id);
    if (gap.status !== 'open') throw new Problem(409, 'GAP_NOT_OPEN', 'Only open gaps can be accepted');
    return ctx.update('data_gap', gap.id, { status: 'accepted', resolution_note: text(body.reason, 'reason') });
  } },
  { path: '/data-gaps/:id/backfill', method: 'POST', name: 'data_gap_backfill', roles: syncRoles, summary: 'Schedule a backfill for an open gap', run(ctx, { params, idempotencyKey }) {
    const gap = ctx.get('data_gap', params.id);
    if (gap.status === 'backfill_scheduled') return gap;
    if (gap.status !== 'open') throw new Problem(409, 'GAP_NOT_OPEN', 'Only open gaps can be backfilled');
    const source = ctx.get('data_source', String(gap.data_source_id));
    const batch = backfill(ctx, source, [String(gap.resource)], { from: String(gap.from), to: String(gap.to) }, idempotencyKey);
    const status = batch.status === 'unavailable' ? 'unrecoverable' : batch.status === 'complete' ? 'resolved' : 'backfill_scheduled';
    return ctx.update('data_gap', gap.id, { status, backfill_id: batch.id });
  } },
  { path: '/webhook-deliveries', method: 'GET', name: 'webhook_delivery_list', roles: ADMIN, summary: 'Read verified event delivery and routing metadata', run: ctx => ctx.list('webhook_delivery') },
];

export function scanCollectionQuality(ctx: Context) {
  const sources = new Map(ctx.list('data_source').map(source => [source.id, source]));
  const runs = ctx.list('sync_run');
  const issues = new Map(ctx.list('quality_issue').map(issue => [issue.fingerprint, issue]));
  let opened = 0, resolved = 0;
  for (const schedule of ctx.list('sync_schedule').filter(row => row.mode === 'interval')) {
    const source = sources.get(String(schedule.data_source_id));
    if (!source || !available(source, ctx) || !listed(source.resources).includes(String(schedule.resource))) continue;
    const finished = runs.filter(run => run.data_source_id === source.id && run.resource === schedule.resource && run.status === 'succeeded');
    const last = finished.map(run => String(run.finished_at)).sort().at(-1) ?? schedule.created_at;
    const age = (Date.parse(ctx.now) - Date.parse(last)) / 1000;
    const fingerprint = JSON.stringify([source.id, schedule.resource, 'freshness']);
    const existing = issues.get(fingerprint);
    if (age > 2 * Number(schedule.interval_seconds)) {
      if (existing && ['open', 'accepted'].includes(String(existing.status))) continue;
      const values = { fingerprint, data_source_id: source.id, resource: schedule.resource, check_type: 'freshness', status: 'open', severity: 'warning', observed_age_seconds: age, resolved_at: null };
      const issue = existing ? ctx.update('quality_issue', existing.id, values) : ctx.create('quality_issue', values);
      ctx.emit('ingest.quality_issue.opened', { quality_issue_id: issue.id, data_source_id: source.id });
      opened++;
    } else if (existing?.status === 'open') {
      ctx.update('quality_issue', existing.id, { status: 'resolved', resolved_at: ctx.now });
      ctx.emit('ingest.quality_issue.resolved', { quality_issue_id: existing.id, data_source_id: source.id });
      resolved++;
    }
  }
  return { opened, resolved };
}

export const qualityOperations: Operation[] = [
  { path: '/data-health', method: 'GET', name: 'data_health_get', roles: READ, summary: 'Read source freshness, observed coverage and run results', run(ctx) {
    const runs = ctx.list('sync_run'), issues = ctx.list('quality_issue'), gaps = ctx.list('data_gap');
    return ctx.list('data_source').map(source => {
      const finished = runs.filter(run => run.data_source_id === source.id && run.run_type !== 'probe' && run.finished_at);
      const age = source.last_success_at ? Math.max(0, (Date.parse(ctx.now) - Date.parse(String(source.last_success_at))) / 1000) : null;
      const resources = listed(source.resources);
      const schedules = ctx.list('sync_schedule').filter(row => row.data_source_id === source.id && row.mode === 'interval');
      const interval = schedules.length ? Math.min(...schedules.map(row => Number(row.interval_seconds))) : null;
      return { data_source_id: source.id, status: source.status, status_reason: source.status_reason, freshness_seconds: age,
        freshness: age === null ? 'not_collected' : interval !== null && age > interval * 2 ? 'stale' : 'observed',
        success_rate: finished.length ? finished.filter(run => run.status === 'succeeded').length / finished.length : null,
        collection_budget: collectionBudgetState(ctx, source.id),
        pending_runs: runs.filter(run => run.data_source_id === source.id && activeRuns.includes(String(run.status))).length,
        open_issues: issues.filter(row => row.data_source_id === source.id && row.status === 'open').length,
        open_gaps: gaps.filter(row => row.data_source_id === source.id && row.status === 'open').length,
        field_coverage: Object.fromEntries(resources.map(resource => [resource, asData(source.field_coverage)[resource]])) };
    });
  } },
  { path: '/data-quality/issues', method: 'GET', name: 'data_quality_issue_list', roles: qualityRoles, summary: 'List quality findings without altering observations', run: (ctx, { query }) => ctx.list('quality_issue').filter(row => !query.status || row.status === query.status) },
  { path: '/data-quality/issues/:id', method: 'PATCH', name: 'data_quality_issue_update', roles: qualityRoles, versionKind: 'quality_issue', summary: 'Record disposition of a quality issue', run(ctx, { params, body }) {
    const issue = ctx.get('quality_issue', params.id);
    const status = text(body.status, 'status');
    if (!['open', 'resolved', 'accepted'].includes(status)) invalid('Invalid issue status');
    const updated = ctx.update('quality_issue', issue.id, { status, resolution_note: text(body.reason, 'reason'), resolved_at: status === 'open' ? null : ctx.now });
    if (issue.status !== status) ctx.emit(`ingest.quality_issue.${status === 'open' ? 'opened' : 'resolved'}`, { quality_issue_id: issue.id, status });
    return updated;
  } },
  { path: '/vendor-usage', method: 'GET', name: 'vendor_usage_list', roles: qualityRoles, summary: 'Read metered provider requests, units, and original costs', run: (ctx, { query }) => ctx.list('vendor_usage').filter(row => !query.data_source_id || row.data_source_id === query.data_source_id) },
  { path: '/collection-budgets', method: 'GET', name: 'collection_budget_list', roles: ADMIN, summary: 'Read thresholds and current period usage', run: ctx => ctx.list('collection_budget').map(row => ({ ...row, usage: usage(ctx, row) })) },
  { path: '/collection-budgets', method: 'PUT', name: 'collection_budget_set', roles: ADMIN, summary: 'Set a monthly source or workspace collection cap', run(ctx, { body }) {
    const sourceId = body.data_source_id == null ? null : ctx.get('data_source', text(body.data_source_id, 'data_source_id')).id;
    const capUnits = body.cap_units == null ? null : integer(body.cap_units, 'cap_units', 1);
    const capMinor = body.cap_minor == null ? null : integer(body.cap_minor, 'cap_minor', 1);
    if (capUnits === null && capMinor === null) invalid('At least one cap is required');
    const onExceed = text(body.on_exceed ?? 'alert_only', 'on_exceed');
    if (!['alert_only', 'reduce_frequency', 'pause'].includes(onExceed)) invalid('Invalid on_exceed policy');
    const values = { data_source_id: sourceId, cap_units: capUnits, cap_minor: capMinor, currency: capMinor === null ? null : currency(body.currency),
      on_exceed: onExceed, fallback_interval_seconds: onExceed === 'reduce_frequency' ? integer(body.fallback_interval_seconds, 'fallback_interval_seconds', 60, 604800) : null };
    const prior = ctx.list('collection_budget').find(row => row.data_source_id === sourceId);
    return prior ? ctx.update('collection_budget', prior.id, values) : ctx.create('collection_budget', values);
  } },
];
