import assert from 'node:assert/strict';
import test from 'node:test';
import { Problem, type Context, type Data, type Input, type Row } from '@smartsell/contracts';
import { operations } from './index';

function workspace() {
  const rows = new Map<string, Row[]>();
  let id = 0;
  const events: { type: string; payload: Data }[] = [];
  const ctx: Context = {
    workspaceId: 'workspace', tenantId: 'tenant', actorId: 'operator', role: 'owner', now: '2026-11-19T12:00:00.000Z',
    list(kind) { return rows.get(kind) ?? []; },
    get(kind, rowId) {
      const row = ctx.list(kind).find(item => item.id === rowId);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Record not found');
      return row;
    },
    create(kind, body) {
      const row = { ...body, id: `row-${++id}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, rowId, body) {
      const previous = ctx.get(kind, rowId);
      const row = { ...previous, ...body, version: previous.version + 1, updated_at: ctx.now };
      rows.set(kind, ctx.list(kind).map(item => item.id === rowId ? row : item));
      return row;
    },
    remove(kind, rowId) { rows.set(kind, ctx.list(kind).filter(item => item.id !== rowId)); },
    emit(type, payload) { events.push({ type, payload }); },
  };
  const run = <T = Row>(name: string, input: Partial<Input> = {}): T =>
    operations.find(candidate => candidate.name === name)!.run(ctx, { params: {}, body: {}, query: {}, ...input }) as T;
  return { ctx, run, events };
}

test('chunk observation summaries count distinct subjects, not rows', () => {
  const { ctx, run, events } = workspace();
  const account = ctx.create('social_account', { platform: 'youtube' });
  for (const external of ['v1', 'v2']) ctx.create('platform_post', { external_post_id: external, social_account_id: account.id, platform: 'youtube' });
  const days = Array.from({ length: 30 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`);
  const csv = ['external_post_id,report_date,metric_key,value', ...days.map((date, index) => `v1,${date},yt.video.views,${index * 10}`),
    'v2,2026-10-01,likes,3', 'v2,2026-10-02,likes,4'].join('\n');
  const body = { template_key: 'social_post_report', options: { timezone: 'UTC', social_account_id: account.id }, csv };
  const batch = run('import_create', { body });
  assert.equal((batch.stats as Data).new, 32);
  const summaries = () => events.filter(event => event.type === 'analytics.observations.recorded').map(({ payload }) =>
    ({ ...payload, metric_keys: [...payload.metric_keys as string[]].sort() }));

  run('import_confirm', { params: { id: batch.id }, body: { limit: 20 } });
  run('import_confirm', { params: { id: batch.id }, body: { limit: 20 } });
  assert.equal(ctx.list('metric_observation').length, 32);
  assert.deepEqual(summaries(), [
    { count: 20, subjects: 1, metric_keys: ['yt.video.views'], import_batch_id: batch.id },
    { count: 12, subjects: 2, metric_keys: ['likes', 'yt.video.views'], import_batch_id: batch.id },
  ]);

  // Unchanged rows insert nothing, so a rerun adds no summary.
  const rerun = run('import_create', { body });
  assert.equal((rerun.stats as Data).unchanged, 32);
  run('import_confirm', { params: { id: rerun.id } });
  assert.equal(summaries().length, 2);
});
