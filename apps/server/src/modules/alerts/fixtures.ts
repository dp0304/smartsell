import { Problem, type Context, type Data, type Input, type Row } from '@smartsell/contracts';
import { operations } from './index.js';

/** In-memory workspace context for alerts tests (no store, no IO). */
export function alertFixture(now = '2026-11-25T00:00:00.000Z') {
  const rows = new Map<string, Row[]>();
  let seq = 0;
  const events: { type: string; data: Data }[] = [];
  const ctx = {
    workspaceId: 'ws-1', tenantId: 'tenant-1', actorId: 'owner-1', role: 'owner' as Context['role'], now,
    activeWorkspaceMembers: [{ userId: 'owner-1', role: 'owner' }, { userId: 'viewer-1', role: 'viewer' }],
    list: (kind: string) => [...(rows.get(kind) ?? [])],
    get(kind: string, id: string) {
      const row = (rows.get(kind) ?? []).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Missing row');
      return row;
    },
    create(kind: string, values: Data) {
      const row = { ...values, id: `${kind}-${++seq}`, version: 1, created_at: ctx.now, updated_at: ctx.now } as Row;
      rows.set(kind, [...(rows.get(kind) ?? []), row]);
      return row;
    },
    update(kind: string, id: string, patch: Data) {
      const previous = ctx.get(kind, id);
      const row = { ...previous, ...patch, id, version: previous.version + 1, updated_at: ctx.now } as Row;
      rows.set(kind, (rows.get(kind) ?? []).map(item => item.id === id ? row : item));
      return row;
    },
    remove(kind: string, id: string) { rows.set(kind, (rows.get(kind) ?? []).filter(item => item.id !== id)); },
    emit(type: string, data: Data) { events.push({ type, data }); },
  } satisfies Context & Record<string, unknown>;
  const at = (iso: string) => { ctx.now = iso; };
  const plus = (minutes: number, from = ctx.now) => new Date(Date.parse(from) + minutes * 60_000).toISOString();
  function run<T = unknown>(name: string, input: Partial<Input> = {}) {
    const op = operations.find(item => item.name === name);
    if (!op) throw new Error(`No operation ${name}`);
    if (!op.roles.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'role');
    return op.run(ctx, { body: {}, params: {}, query: {}, ...input }) as T;
  }
  const alerts = () => ctx.list('owner_alert').sort((a, b) => Number(a.seq) - Number(b.seq));
  return { ctx, rows, events, at, plus, run, alerts };
}
export type AlertFixture = ReturnType<typeof alertFixture>;

/** Two machines and two hub channels (E2E names): Mac-B → X @fixture_x, Win-C → TikTok @fixture_tt, workspace in Asia/Shanghai. */
export function seedHub(f: AlertFixture) {
  const { ctx } = f;
  ctx.create('workspace', { default_timezone: 'Asia/Shanghai' });
  const macB = ctx.create('connector_device', { name: 'mac-b.local', display_name: 'Mac-B', status: 'active', platform: 'darwin', last_seen_at: ctx.now });
  const winC = ctx.create('connector_device', { name: 'WIN-C', display_name: 'Win-C', status: 'active', platform: 'win32', last_seen_at: ctx.now });
  const x = ctx.create('social_account', { provider: 'x', handle: 'fixture_x', display_name: 'Fixture X', status: 'active' });
  const tt = ctx.create('social_account', { provider: 'tiktok', handle: 'fixture_tt', display_name: 'Fixture TT', status: 'active' });
  for (const [account, device] of [[x, macB], [tt, winC]] as const) {
    ctx.create('channel_settings', { social_account_id: account.id, approval_mode: 'needs_approval', lateness_limit_min: 30, execution_mode: 'browser_auto' });
    ctx.create('account_execution_binding', { social_account_id: account.id, device_id: device.id, mode: 'connector', connector_channel: 'browser', status: 'active' });
  }
  return { macB, winC, x, tt };
}

export function post(f: AlertFixture, account: Row, scheduledAt: string, values: Data = {}) {
  return f.ctx.create('publish_target', { social_account_id: account.id, scheduled_at: scheduledAt, plan_status: 'ready', ...values });
}

export function job(f: AlertFixture, values: { device: Row; account: Row; target?: Row | null; notBefore: string } & Data) {
  const { device, account, target, notBefore, ...rest } = values;
  return f.ctx.create('worker_job', {
    kind: 'publish_post', status: 'queued', device_id: device.id, device_history: [device.id], social_account_id: account.id,
    publish_target_id: target?.id ?? null, dry_run: false, mode: 'auto', not_before: notBefore, not_after: f.plus(30, notBefore),
    prepare_lead_min: 30, resume_token: 0, blocker: null, result: null, waits_for_job_id: null, media_pending: false, ...rest,
  });
}
