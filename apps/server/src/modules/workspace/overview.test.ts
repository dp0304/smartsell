import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Input, type Row } from '@smartsell/contracts';
import { today, type WorkspaceOverviewContext } from './overview.js';

function fixture() {
  const rows = new Map<string, Row[]>();
  let seq = 0;
  const ctx: WorkspaceOverviewContext = {
    workspaceId: 'w1', tenantId: 't1', actorId: 'me', role: 'owner', now: '2026-11-19T08:00:00.000Z',
    list: kind => rows.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Missing row');
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: `r${++seq}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, patch) {
      const previous = ctx.get(kind, id);
      const row = { ...previous, ...patch, id, version: previous.version + 1, updated_at: ctx.now };
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? row : item));
      return row;
    },
    remove(kind, id) { rows.set(kind, ctx.list(kind).filter(item => item.id !== id)); },
    emit() {},
  };
  const due = async (query: Input['query'] = {}) => (await today(ctx, { body: {}, params: {}, query }))
    .items.filter(item => item.provider === 'creator.due');
  return { ctx, due };
}

test('creator deliverables owed by the creator are due on the overview and inherit the collaboration brand', async () => {
  const { ctx, due } = fixture();
  const brand = ctx.create('brand', { name: 'Selected' });
  const other = ctx.create('brand', { name: 'Other' });
  const active = ctx.create('collaboration', { brand_id: brand.id, status: 'active' });
  const elsewhere = ctx.create('collaboration', { brand_id: other.id, status: 'active' });
  const cancelled = ctx.create('collaboration', { brand_id: brand.id, status: 'cancelled' });
  const deliverable = (collaboration: Row, status: string, due_at: string) => ctx.create('deliverable', { collaboration_id: collaboration.id, status, due_at });
  const late = deliverable(active, 'requested', '2026-11-18T08:00:00.000Z');
  const dueToday = deliverable(active, 'changes_requested', '2026-11-19T20:00:00.000Z');
  const working = deliverable(elsewhere, 'in_progress', '2026-11-19T09:00:00.000Z');
  deliverable(active, 'requested', '2026-12-01T00:00:00.000Z');
  deliverable(active, 'submitted', '2026-11-18T08:00:00.000Z');
  deliverable(active, 'accepted', '2026-11-18T08:00:00.000Z');
  deliverable(cancelled, 'requested', '2026-11-18T08:00:00.000Z');
  const all = await due();
  assert.deepEqual(all.map(item => [item.resource.id, item.severity, item.brand_id]),
    [[late.id, 'high', brand.id], [working.id, 'normal', other.id], [dueToday.id, 'normal', brand.id]]);
  assert.deepEqual((await due({ brand_id: brand.id })).map(item => item.resource.id), [late.id, dueToday.id]);
});
