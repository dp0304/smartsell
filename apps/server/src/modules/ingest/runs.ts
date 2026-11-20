import { admins, readers, writers, type Commands, type Context, type Entity, type Fields, type Role } from '../types.js';
import { bounds, completeWindows, forResource, overlap, recordGap, uncovered, windowData, writeCoverage, type Window } from './coverage.js';
import { DAY, at, choice, emit, get, hash, identifier, insert, integer, iso, list, requireThat, roleAllowed, shape, update, windowFrom } from './model.js';
import { assertCollectable, authorization, historyStart, scheduleId, sourceResource } from './sources.js';

const activeStatuses = ['queued', 'running', 'rate_limited'];
const outcomes = ['succeeded', 'partially_succeeded', 'failed', 'cancelled'] as const;
const errors = ['permission_denied', 'source_outage', 'invalid_response', 'unknown', 'ip_not_allowed'] as const;
const LEASE_MS = 15 * 60 * 1_000;
const cursorId = (source: string, resource: string) => hash('cursor', source, resource);

export const runInput = async (ctx: Context, input: Fields) => get(ctx, 'sync_run', identifier(input, 'sync_run_id'));
export const runSource = async (ctx: Context, run: Entity) => get(ctx, 'data_source', run.data.data_source_id);
export const collectionRoles = (source: Entity): Role[] => source.data.method === 'official_api' ? admins : writers;

export async function workingRun(ctx: Context, input: Fields) {
  const run = await runInput(ctx, input);
  const source = await runSource(ctx, run);
  roleAllowed(ctx, collectionRoles(source));
  requireThat(run.data.status === 'running' && run.data.lease_owner_id === ctx.actorId && at(run.data.lease_expires_at) > at(ctx.now) &&
    run.data.fencing_token === integer(input.fencing_token, 1, Number.MAX_SAFE_INTEGER, 'fencing_token'),
  'lease_lost', 'The run is not held by this lease', 409);
  return { run, source };
}

async function enqueue(ctx: Context, source: Entity, resource: string, window: Window, runType: string, operationId?: string) {
  const existing = (await forResource(ctx, 'sync_run', source.id, resource)).find(row =>
    activeStatuses.includes(row.data.status) && overlap(bounds(row), window));
  requireThat(!existing, 'run_in_progress', 'An active sync run already overlaps this window', 409);
  const run = await insert(ctx, 'sync_run', {
    data_source_id: source.id, resource, ...windowData(window), run_type: runType, method: source.data.method,
    status: 'queued', attempt: 1, fencing_token: 0, cursor_in: null, cursor_out: null, page_index: 0, pages_complete: false,
    counts: { pages: 0, seen: 0, new: 0, unchanged: 0 }, request_count: 0, operation_id: operationId ?? null,
    trigger_ref: { kind: runType === 'incremental' ? 'schedule' : 'user', id: ctx.actorId },
  });
  await emit(ctx, 'sync_run.queued', { sync_run_id: run.id, data_source_id: source.id, resource, run_type: runType });
  return run;
}

async function sourceWindow(ctx: Context, source: Entity, resource: string, input: Fields): Promise<Window> {
  if (input.from !== undefined || input.to !== undefined) return windowFrom(input, at(ctx.now));
  const schedule = await get(ctx, 'sync_schedule', scheduleId(source.id, resource));
  const cursor = await ctx.get('ingest', 'sync_cursor', cursorId(source.id, resource));
  const end = at(ctx.now) - (source.data.method === 'official_api' ? schedule.data.settle_seconds * 1000 : 0);
  const start = Math.max(historyStart(ctx, source), cursor?.data.high_watermark ? at(cursor.data.high_watermark) - schedule.data.overlap_seconds * 1000 : end - 7 * DAY);
  requireThat(start < end, 'invalid_window', 'No settled time is available yet', 409);
  return [start, end];
}

async function startBackfill(ctx: Context, source: Entity, selected: string[], window: Window) {
  const operation = await insert(ctx, 'backfill_operation', { data_source_id: source.id, resources: selected, ...windowData(window), requested_at: ctx.now });
  const runs = [];
  const unavailable = [];
  const denied = await authorization(ctx, source.data);
  requireThat(['active', 'needs_authorization'].includes(source.data.status), 'source_inactive', 'Data source is not available for backfill', 409);
  const cutoff = historyStart(ctx, source);
  for (const resource of selected) {
    const [start, end] = window;
    if (start < cutoff) {
      const old: Window = [start, Math.min(end, cutoff)];
      await writeCoverage(ctx, source.id, resource, old, 'unavailable_out_of_retention', 'out_of_retention', null);
      await recordGap(ctx, source.id, resource, old, 'out_of_retention', true);
    }
    const startAllowed = Math.max(start, cutoff);
    const allowed: Window = [startAllowed, end];
    const noPermission = Boolean(denied) || source.data.field_coverage[resource].status === 'no_permission';
    if (startAllowed < end && noPermission) {
      await writeCoverage(ctx, source.id, resource, allowed, 'unavailable_no_permission', 'no_permission', null);
      await recordGap(ctx, source.id, resource, allowed, 'no_permission', true);
    }
    const gaps = await forResource(ctx, 'data_gap', source.id, resource);
    const unavailableForResource = gaps.filter(gap => ['accepted', 'unrecoverable'].includes(gap.data.status) && overlap(window, bounds(gap)));
    unavailable.push(...unavailableForResource);
    if (startAllowed >= end || noPermission) continue;
    const coverage = await forResource(ctx, 'coverage_segment', source.id, resource);
    const excluded = [...completeWindows(coverage), ...unavailableForResource.map(bounds)];
    for (const [missingStart, missingEnd] of uncovered(allowed, excluded)) {
      for (let shardStart = missingStart; shardStart < missingEnd; shardStart += 7 * DAY) {
        runs.push(await enqueue(ctx, source, resource, [shardStart, Math.min(missingEnd, shardStart + 7 * DAY)], 'backfill', operation.id));
      }
    }
  }
  const row = await update(ctx, operation, { total_shards: runs.length, unavailable_count: unavailable.length });
  await emit(ctx, 'backfill.started', { operation_id: row.id, data_source_id: source.id, total_shards: runs.length, unavailable_count: unavailable.length });
  return { operation_id: row.id, runs, unavailable };
}

async function writeUsage(ctx: Context, run: Entity, requestCount: number) {
  await ctx.insert('ops', 'usage_event', { meter_key: 'sync_calls', quantity: requestCount,
    source_ref: { resource_type: 'sync_run', resource_id: run.id }, attempt: run.data.attempt, occurred_at: ctx.now }, hash('sync_calls', run.id, run.data.attempt));
}

export const runCommands: Commands = {
  configure_schedule: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['data_source_id', 'resource', 'mode', 'interval_seconds', 'overlap_seconds', 'settle_seconds']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    const resource = sourceResource(source, input.resource);
    const mode = choice(input.mode, ['interval', 'manual_only'] as const, 'mode');
    requireThat(mode !== 'interval' || source.data.method === 'official_api', 'capability_unavailable', 'Only official API sources can be scheduled', 409);
    const schedule = await get(ctx, 'sync_schedule', scheduleId(source.id, resource));
    const interval_seconds = integer(input.interval_seconds ?? schedule.data.interval_seconds, 300, 604_800, 'interval_seconds');
    const overlap_seconds = integer(input.overlap_seconds ?? schedule.data.overlap_seconds, 0, 604_800, 'overlap_seconds');
    const settle_seconds = integer(input.settle_seconds ?? schedule.data.settle_seconds, 0, 604_800, 'settle_seconds');
    const row = await update(ctx, schedule, { mode, interval_seconds, overlap_seconds, settle_seconds,
      next_due_at: mode === 'interval' ? iso(at(ctx.now) + interval_seconds * 1000) : null });
    await emit(ctx, 'sync_schedule.updated', { sync_schedule_id: row.id, data_source_id: source.id, resource, mode });
    return row;
  } },
  dispatch_due_syncs: { roles: admins, async run(ctx, input) {
    roleAllowed(ctx, admins);
    shape(input, []);
    const now = at(ctx.now);
    const runs = [];
    for (const schedule of await list(ctx, 'sync_schedule')) {
      if (schedule.data.mode !== 'interval' || at(schedule.data.next_due_at) > now) continue;
      const source = await get(ctx, 'data_source', schedule.data.data_source_id);
      const resource = schedule.data.resource;
      if (source.data.status !== 'active' || await authorization(ctx, source.data) || source.data.field_coverage[resource].status === 'no_permission') continue;
      const window = await sourceWindow(ctx, source, resource, {});
      if ((await forResource(ctx, 'sync_run', source.id, resource)).some(row => activeStatuses.includes(row.data.status) && overlap(bounds(row), window))) continue;
      runs.push(await enqueue(ctx, source, resource, window, 'incremental'));
      await update(ctx, schedule, { next_due_at: iso(now + schedule.data.interval_seconds * 1_000) });
      if (runs.length >= 100) break;
    }
    return { runs };
  } },
  sync_refresh: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['data_source_id', 'resource', 'from', 'to']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    await assertCollectable(ctx, source);
    const resource = sourceResource(source, input.resource);
    requireThat(source.data.field_coverage[resource].status !== 'no_permission', 'no_permission', 'No authorized fields for this resource', 403);
    const window = await sourceWindow(ctx, source, resource, input);
    requireThat(window[0] >= historyStart(ctx, source), 'out_of_retention', 'Use backfill to inspect windows beyond source retention', 409);
    return enqueue(ctx, source, resource, window, 'manual_refresh');
  } },
  reconcile: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['data_source_id', 'resource', 'from', 'to']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    await assertCollectable(ctx, source);
    const resource = sourceResource(source, input.resource);
    requireThat(source.data.field_coverage[resource].status !== 'no_permission', 'no_permission', 'No authorized fields for this resource', 403);
    const window = windowFrom(input, at(ctx.now));
    requireThat(window[0] >= historyStart(ctx, source), 'out_of_retention', 'Use backfill to inspect windows beyond source retention', 409);
    return enqueue(ctx, source, resource, window, 'reconcile');
  } },
  claim_run: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['sync_run_id']);
    const run = await runInput(ctx, input);
    const source = await runSource(ctx, run);
    roleAllowed(ctx, collectionRoles(source));
    await assertCollectable(ctx, source);
    const now = at(ctx.now);
    const leaseExpired = run.data.status === 'running' && at(run.data.lease_expires_at) <= now;
    const waitEnded = run.data.status === 'rate_limited' && at(run.data.retry_at) <= now;
    requireThat(run.data.status === 'queued' || leaseExpired || waitEnded, 'run_not_claimable', 'The run is active, terminal, or waiting for Retry-After', 409);
    const row = await update(ctx, run, { status: 'running', lease_owner_id: ctx.actorId, lease_expires_at: iso(now + LEASE_MS),
      fencing_token: run.data.fencing_token + 1, started_at: run.data.started_at ?? ctx.now, retry_at: null });
    await emit(ctx, 'sync_run.started', { sync_run_id: row.id, attempt: row.data.attempt, fencing_token: row.data.fencing_token });
    return row;
  } },
  defer_run: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['sync_run_id', 'fencing_token', 'retry_after_seconds', 'request_count']);
    const { run, source } = await workingRun(ctx, input);
    const wait = integer(input.retry_after_seconds, 1, 86_400, 'retry_after_seconds');
    requireThat(source.data.method === 'official_api' || input.request_count === undefined, 'invalid_input', 'Only API collection records provider requests');
    const requests = integer(input.request_count ?? 0, 0, 10_000, 'request_count');
    const row = await update(ctx, run, { status: 'rate_limited', retry_at: iso(at(ctx.now) + wait * 1_000),
      request_count: run.data.request_count + requests, lease_owner_id: null, lease_expires_at: null });
    await emit(ctx, 'sync_run.rate_limited', { sync_run_id: row.id, retry_at: row.data.retry_at });
    return row;
  } },
  finish_run: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['sync_run_id', 'fencing_token', 'status', 'error_reason', 'request_count']);
    const { run, source } = await workingRun(ctx, input);
    const status = choice(input.status, outcomes, 'status');
    const error = input.error_reason === undefined ? null : choice(input.error_reason, errors, 'error_reason');
    requireThat(status === 'failed' || status === 'partially_succeeded' || error === null, 'invalid_input', 'Error reason is only allowed for a failure');
    requireThat(error !== 'ip_not_allowed' || source.data.method === 'official_api' && status === 'failed', 'invalid_input', 'IP denial is only valid for an API failure');
    const resource = run.data.resource;
    const window = bounds(run);
    if (status === 'succeeded' || status === 'partially_succeeded') {
      await assertCollectable(ctx, source);
      requireThat(status !== 'succeeded' || run.data.pages_complete, 'incomplete_run', 'Complete all pages before finishing the run', 409);
      await update(ctx, source, { last_success_at: status === 'succeeded' ? ctx.now : source.data.last_success_at });
    }
    if (status === 'succeeded') {
      await writeCoverage(ctx, source.id, resource, window, 'complete', null, run.id);
      const id = cursorId(source.id, resource);
      const cursor = await ctx.get('ingest', 'sync_cursor', id);
      const coverage = completeWindows(await forResource(ctx, 'coverage_segment', source.id, resource));
      const isComplete = uncovered(window, coverage).length === 0;
      const prior = cursor?.data.high_watermark;
      let endpoint = prior ? at(prior) : isComplete ? window[1] : null;
      if (endpoint !== null) {
        for (const [start, end] of coverage.sort((a, b) => a[0] - b[0])) {
          if (start > endpoint) break;
          endpoint = Math.max(endpoint, end);
        }
      }
      const watermark = endpoint === null ? null : iso(endpoint);
      const patch = { data_source_id: source.id, resource, last_run_id: run.id, last_success_at: ctx.now,
        cursor: endpoint === window[1] && watermark !== prior ? run.data.cursor_out : cursor?.data.cursor ?? null, high_watermark: watermark };
      if (cursor) await update(ctx, cursor, patch);
      else await insert(ctx, 'sync_cursor', patch, id);
    } else if (status !== 'cancelled' || run.data.counts.pages > 0) {
      const reason = error ?? (status === 'cancelled' ? 'cancelled' : 'sync_failed');
      const denied = error === 'permission_denied';
      await writeCoverage(ctx, source.id, resource, window, denied ? 'unavailable_no_permission' : status === 'failed' ? 'failed' : 'partial', reason, run.id);
      await recordGap(ctx, source.id, resource, window, denied ? 'no_permission' : error === 'ip_not_allowed' || error === 'source_outage' ? error : 'sync_failed');
    }
    if (error === 'ip_not_allowed' || error === 'permission_denied') {
      const nextStatus = error === 'ip_not_allowed' ? 'degraded' : 'needs_authorization';
      if (source.data.status === 'active') {
        await update(ctx, source, { status: nextStatus, status_reason: error });
        await emit(ctx, 'data_source.status_changed', { data_source_id: source.id, status: nextStatus, status_reason: error });
      }
    }
    requireThat(source.data.method === 'official_api' || input.request_count === undefined, 'invalid_input', 'Only API collection records provider requests');
    const request_count = run.data.request_count + integer(input.request_count ?? 0, 0, 10_000, 'request_count');
    const row = await update(ctx, run, { status, error_class: error === 'ip_not_allowed' ? 'permission_denied' : error, error_reason: error,
      finished_at: ctx.now, request_count, lease_owner_id: null, lease_expires_at: null });
    await writeUsage(ctx, row, request_count);
    const event = status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed';
    await emit(ctx, `sync_run.${event}`, { sync_run_id: row.id, data_source_id: source.id, resource, ...windowData(window), status,
      counts: row.data.counts, error_class: row.data.error_class, error_reason: error });
    return row;
  } },
  retry_run: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['sync_run_id']);
    const run = await runInput(ctx, input);
    const source = await runSource(ctx, run);
    roleAllowed(ctx, collectionRoles(source));
    await assertCollectable(ctx, source);
    requireThat(['failed', 'partially_succeeded'].includes(run.data.status), 'invalid_transition', 'Only failed or partial runs can be retried', 409);
    requireThat(bounds(run)[0] >= historyStart(ctx, source), 'out_of_retention', 'Run window is outside source retention', 409);
    requireThat(!(await forResource(ctx, 'sync_run', source.id, run.data.resource)).some(row => row.id !== run.id && activeStatuses.includes(row.data.status) && overlap(bounds(row), bounds(run))),
      'run_in_progress', 'An active sync run already overlaps this window', 409);
    const row = await update(ctx, run, { status: 'queued', attempt: run.data.attempt + 1, request_count: 0,
      error_class: null, error_reason: null, finished_at: null, retry_at: null });
    await emit(ctx, 'sync_run.retried', { sync_run_id: row.id, attempt: row.data.attempt });
    return row;
  } },
  cancel_run: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['sync_run_id']);
    const run = await runInput(ctx, input);
    requireThat(['queued', 'rate_limited'].includes(run.data.status), 'invalid_transition', 'Only queued or waiting runs can be cancelled outside the current lease', 409);
    const source = await runSource(ctx, run);
    roleAllowed(ctx, collectionRoles(source));
    const row = await update(ctx, run, { status: 'cancelled', finished_at: ctx.now, retry_at: null });
    if (row.data.request_count) await writeUsage(ctx, row, row.data.request_count);
    if (row.data.counts.pages) {
      await writeCoverage(ctx, source.id, row.data.resource, bounds(row), 'partial', 'cancelled', row.id);
      await recordGap(ctx, source.id, row.data.resource, bounds(row), 'sync_failed');
    }
    await emit(ctx, 'sync_run.cancelled', { sync_run_id: row.id, data_source_id: source.id, resource: row.data.resource });
    return row;
  } },
  start_backfill: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['data_source_id', 'resources', 'from', 'to']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    requireThat(Array.isArray(input.resources) && input.resources.length > 0 && input.resources.length <= 5, 'invalid_input', 'Select the resources to backfill');
    const selected = [...new Set<string>(input.resources.map((value: unknown) => sourceResource(source, value)))];
    return startBackfill(ctx, source, selected, windowFrom(input, at(ctx.now)));
  } },
  backfill_gap: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['data_gap_id']);
    const gap = await get(ctx, 'data_gap', identifier(input, 'data_gap_id'));
    requireThat(gap.data.status === 'open', 'invalid_transition', 'Only an open gap can be scheduled', 409);
    const source = await get(ctx, 'data_source', gap.data.data_source_id);
    const result = await startBackfill(ctx, source, [gap.data.resource], bounds(gap));
    const current = await get(ctx, 'data_gap', gap.id);
    if (result.runs.length && current.data.status === 'open') await update(ctx, current, { status: 'backfill_scheduled', operation_id: result.operation_id });
    return result;
  } },
  backfill_status: { roles: readers, async run(ctx, input) {
    roleAllowed(ctx, readers);
    shape(input, ['operation_id']);
    const operation = await get(ctx, 'backfill_operation', identifier(input, 'operation_id'));
    const runs = (await list(ctx, 'sync_run')).filter(row => row.data.operation_id === operation.id);
    const succeeded = runs.filter(row => row.data.status === 'succeeded').length;
    const inProgress = runs.filter(row => activeStatuses.includes(row.data.status)).length;
    const unavailable = operation.data.unavailable_count;
    return { operation, runs, succeeded, in_progress: inProgress,
      status: inProgress ? 'in_progress' : succeeded === runs.length && !unavailable ? 'succeeded' : succeeded ? 'partially_succeeded' : 'incomplete' };
  } },
};
