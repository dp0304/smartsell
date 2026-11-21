import { admins, readers, type Commands } from '../types.js';
import { bad, conflict, get, guard, id, insert, instant, list, live, one, stableId, store, update } from './model.js';

const settlementResources = { order_list: 'orders', refund_list: 'refunds' } as const;
const coverageStates = ['complete', 'partial'] as const;

export const coverageCommands: Commands = {
  attest_import_coverage: { roles: admins, async run(ctx, input) {
    const import_batch_id = id(input.batch_id, 'batch_id');
    const window_start = instant(input.window_start, 'window_start');
    const window_end = instant(input.window_end, 'window_end');
    const as_of = instant(input.as_of, 'as_of');
    const status = one(input.status, 'status', coverageStates);
    if (window_start >= window_end || window_end > as_of || as_of > instant(ctx.now, 'now')) bad('coverage window');
    const initial = await live(ctx, 'import_batch', import_batch_id);
    const store_id = id(initial.data.store_id, 'store_id');
    await guard(ctx, store_id);
    const batch = await live(ctx, 'import_batch', import_batch_id);
    await store(ctx, store_id);
    const template = one(batch.data.template_key, 'template_key', ['order_list', 'refund_list'] as const);
    if (batch.data.status !== 'committed') conflict('invalid_state', 'Commit the source report before attesting coverage');
    if (status === 'complete' && batch.data.counts?.invalid !== 0) {
      conflict('incomplete_batch', 'A report with rejected rows can only establish partial coverage');
    }
    const resource = settlementResources[template];
    const facts = { store_id, resource, import_batch_id, import_batch_version: batch.version, window_start, window_end, as_of, status };
    const key = stableId(ctx.workspaceId, 'coverage_segment', facts);
    const existing = await get(ctx, 'coverage_segment', key);
    if (existing) return existing;
    const current = (await list(ctx, 'coverage_segment')).filter(prior => prior.data.active === true
      && prior.data.store_id === store_id && prior.data.resource === resource
      && prior.data.window_start === window_start && prior.data.window_end === window_end);
    if (current.some(prior => prior.data.as_of > as_of)) {
      conflict('stale_coverage', 'A newer reconciliation already covers this window');
    }
    for (const prior of current) {
      await update(ctx, prior, { active: false, superseded_at: ctx.now, superseded_by: key });
    }
    const row = await insert(ctx, 'coverage_segment', { ...facts, active: true, attested_by: ctx.actorId }, key);
    await ctx.emit('commerce.coverage.attested', { coverage_segment_id: row.id, ...facts });
    return row;
  } },
  import_coverage_list: { roles: readers, async run(ctx, input) {
    const store_id = id(input.store_id, 'store_id');
    await store(ctx, store_id, false);
    const batches = await list(ctx, 'import_batch');
    const committed = new Set(batches.filter(row => row.data.status === 'committed').map(row => row.id));
    return { items: (await list(ctx, 'coverage_segment')).filter(row => row.data.store_id === store_id)
      .map(row => ({ ...row, data: { ...row.data, effective: row.data.active === true && committed.has(row.data.import_batch_id) } })) };
  } },
};
