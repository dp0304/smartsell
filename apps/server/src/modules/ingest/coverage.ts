import { readers, text, writers, type Commands, type Context, type Entity } from '../types.js';
import { at, emit, get, identifier, insert, iso, list, requireThat, roleAllowed, shape, update, windowFrom } from './model.js';
import { sourceResource } from './sources.js';

export type Window = [number, number];
type Coverage = 'complete' | 'partial' | 'failed' | 'unavailable_out_of_retention' | 'unavailable_no_permission';
export const bounds = (row: Entity): Window => [at(row.data.window_start), at(row.data.window_end)];
export const windowData = ([start, end]: Window) => ({ window_start: iso(start), window_end: iso(end) });
export const overlap = ([start, end]: Window, [lo, hi]: Window) => start < hi && lo < end;
const contains = ([start, end]: Window, [lo, hi]: Window) => lo >= start && hi <= end;
export const forResource = async (ctx: Context, kind: string, source: string, resource: string) =>
  (await list(ctx, kind)).filter(row => row.data.data_source_id === source && row.data.resource === resource);

export function uncovered(window: Window, covered: Window[]): Window[] {
  let remaining = [window];
  for (const [lo, hi] of covered) remaining = remaining.flatMap(([start, end]): Window[] => {
    if (start >= hi || end <= lo) return [[start, end]];
    const result: Window[] = [];
    if (start < lo) result.push([start, lo]);
    if (end > hi) result.push([hi, end]);
    return result;
  });
  return remaining;
}

export const completeWindows = (rows: Entity[]) => rows.filter(row => row.data.active !== false && row.data.status === 'complete').map(bounds);

export async function writeCoverage(ctx: Context, source: string, resource: string, window: Window, status: Coverage, reason: string | null, runId: string | null) {
  const prior = (await forResource(ctx, 'coverage_segment', source, resource)).filter(row => row.data.active !== false && overlap(bounds(row), window));
  const gaps = await forResource(ctx, 'data_gap', source, resource);
  const protectedWindows = status === 'complete' ? gaps.filter(row => ['accepted', 'unrecoverable'].includes(row.data.status)).map(bounds) : [];
  if (status !== 'complete') protectedWindows.push(...completeWindows(prior));
  const patches = uncovered(window, protectedWindows);
  for (const row of prior) {
    if (!patches.some(patch => overlap(patch, bounds(row)))) continue;
    await update(ctx, row, { active: false });
    for (const remainder of uncovered(bounds(row), patches)) {
      await insert(ctx, 'coverage_segment', { ...row.data, ...windowData(remainder) });
    }
  }
  for (const patch of patches) await insert(ctx, 'coverage_segment', {
    data_source_id: source, resource, ...windowData(patch), status, reason, sync_run_id: runId, active: true,
  });
  if (status !== 'complete') return;
  const confirmed = completeWindows(await forResource(ctx, 'coverage_segment', source, resource));
  for (const gap of gaps) {
    if (!['open', 'backfill_scheduled'].includes(gap.data.status)) continue;
    if (!patches.some(patch => overlap(patch, bounds(gap)))) continue;
    if (uncovered(bounds(gap), confirmed).length === 0) {
      await update(ctx, gap, { status: 'resolved', resolved_at: ctx.now });
      await emit(ctx, 'data_gap.resolved', { data_gap_id: gap.id, data_source_id: source, resource });
    }
  }
}

export async function recordGap(ctx: Context, source: string, resource: string, window: Window, gapType: string, terminal = false) {
  const current = await forResource(ctx, 'data_gap', source, resource);
  const covered = completeWindows(await forResource(ctx, 'coverage_segment', source, resource));
  for (const gap of current) {
    if (gap.data.status === 'resolved') continue;
    if (gap.data.status === 'accepted' || gap.data.status === 'unrecoverable' || (!terminal && ['open', 'backfill_scheduled'].includes(gap.data.status))) {
      covered.push(bounds(gap));
    } else if (terminal && contains(window, bounds(gap))) {
      await update(ctx, gap, { status: 'unrecoverable', gap_type: gapType });
      covered.push(bounds(gap));
    }
  }
  const result = [];
  for (const missing of uncovered(window, covered)) {
    const gap = await insert(ctx, 'data_gap', { data_source_id: source, resource, ...windowData(missing), gap_type: gapType,
      reason: gapType, severity: 'warning', status: terminal ? 'unrecoverable' : 'open' });
    await emit(ctx, 'data_gap.detected', { data_gap_id: gap.id, data_source_id: source, resource, gap_type: gapType });
    result.push(gap);
  }
  return result;
}

export const coverageCommands: Commands = {
  get_coverage: { roles: readers, async run(ctx, input) {
    roleAllowed(ctx, readers);
    shape(input, ['data_source_id', 'resource', 'from', 'to']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    const resource = sourceResource(source, input.resource);
    const window = windowFrom(input, at(ctx.now));
    const select = (rows: Entity[]) => rows.filter(row => overlap(bounds(row), window)).sort((a, b) => bounds(a)[0] - bounds(b)[0]);
    const segments = select((await forResource(ctx, 'coverage_segment', source.id, resource)).filter(row => row.data.active !== false));
    const gaps = select(await forResource(ctx, 'data_gap', source.id, resource));
    const missing = uncovered(window, completeWindows(segments));
    return { segments, gaps, missing: missing.map(windowData), coverage_ratio: 1 - missing.reduce((total, [start, end]) => total + end - start, 0) / (window[1] - window[0]) };
  } },
  accept_gap: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['data_gap_id', 'reason']);
    const gap = await get(ctx, 'data_gap', identifier(input, 'data_gap_id'));
    requireThat(gap.data.status === 'open', 'invalid_transition', 'Only open gaps can be accepted', 409);
    const resolution_note = text(input, 'reason', 400);
    const row = await update(ctx, gap, { status: 'accepted', resolution_note, resolved_by: ctx.actorId, resolved_at: ctx.now });
    await emit(ctx, 'data_gap.accepted', { data_gap_id: row.id, data_source_id: row.data.data_source_id, resource: row.data.resource });
    return row;
  } },
  scan_coverage: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['data_source_id', 'resource', 'from', 'to']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    const resource = sourceResource(source, input.resource);
    const window = windowFrom(input, at(ctx.now));
    return { gaps: await recordGap(ctx, source.id, resource, window, 'missing_window') };
  } },
};
