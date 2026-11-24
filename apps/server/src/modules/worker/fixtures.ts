// Shared in-memory hub fixture for the job engine's unit tests (not a test file itself).
import { randomUUID } from 'node:crypto';
import { AUTOMATION_NOTICE_VERSION, Problem, RISK_TERMS_VERSION, type Context, type Data, type JobReportEvent, type Operation, type Role, type Row } from '@smartsell/contracts';
import { channelOperations } from '../account/channel-ops.js';
import { ensureChannelSettings } from '../account/channel-settings.js';
import { operations as contentOperations } from '../content/index.js';
import { operations as planningOperations } from '../planning/index.js';
import { claimJobs, goJob, heartbeatV2, reportJob } from './device-jobs.js';
import { operations as workerOperations } from './index.js';
import { workerLifecycle } from './lifecycle.js';
import { JOB } from './model.js';

export interface HubFixtureOptions { provider?: 'x' | 'tiktok'; approval?: 'direct' | 'needs_approval'; riskAck?: boolean; now?: string }

export function hubFixture(options: HubFixtureOptions = {}) {
  const rows = new Map<string, Row[]>();
  const events: { type: string; payload: Data }[] = [];
  const ctx = {
    actorId: 'owner', role: 'owner' as Role, tenantId: 'tenant', workspaceId: `ws-${randomUUID()}`, now: options.now ?? '2027-01-01T10:00:00.000Z',
    list: (kind: string) => rows.get(kind) ?? [],
    get(kind: string, id: string) {
      const row = (rows.get(kind) ?? []).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${id}`);
      return row;
    },
    create(kind: string, data: Data) {
      const row = { ...structuredClone(data), id: randomUUID(), version: 1, created_at: ctx.now, updated_at: ctx.now } as Row;
      rows.set(kind, [...(rows.get(kind) ?? []), row]);
      return row;
    },
    update(kind: string, id: string, data: Data) {
      const row = ctx.get(kind, id);
      const updated = { ...row, ...structuredClone(data), id, version: row.version + 1, updated_at: ctx.now } as Row;
      rows.set(kind, (rows.get(kind) ?? []).map(item => item.id === id ? updated : item));
      return updated;
    },
    remove(kind: string, id: string) { rows.set(kind, (rows.get(kind) ?? []).filter(row => row.id !== id)); },
    emit(type: string, payload: Data) { events.push({ type, payload }); },
  } satisfies Context;
  const ops: Operation[] = [...planningOperations, ...contentOperations, ...channelOperations, ...workerOperations];
  function run(name: string, body: Data = {}, params: Record<string, string> = {}, as: Partial<Context> & { agentCredentialId?: string } = {}) {
    const operation = ops.find(item => item.name === name);
    if (!operation) throw new Error(`missing operation ${name}`);
    const scoped = Object.assign(Object.create(ctx), as) as Context;
    if (!operation.roles.includes(scoped.role)) throw new Problem(403, 'PERMISSION_DENIED', name);
    return operation.run(scoped, { body, params, query: {}, expectedVersion: undefined });
  }
  const provider = options.provider ?? 'x';
  ctx.create('workspace', { name: 'Fixture', default_timezone: 'UTC' });
  const device = ctx.create('connector_device', { name: 'mac-b.local', display_name: 'Mac-B', platform: 'darwin', status: 'active', last_seen_at: ctx.now });
  const other = ctx.create('connector_device', { name: 'win-c', display_name: 'Win-C', platform: 'win32', status: 'active', last_seen_at: ctx.now });
  const account = ctx.create('social_account', { provider, status: 'active', brand_id: 'brand', default_timezone: 'UTC', display_name: 'Lure Lab',
    handle: 'lurelab', external_account_id: provider === 'x' ? 'lurelab' : '7000000001' });
  const binding = ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: device.id, connector_mode: 'assist', paused: false });
  ctx.create('browser_session', { binding_id: binding.id, device_id: device.id, social_account_id: account.id, status: 'verified' });
  const created = ensureChannelSettings(ctx, account.id);
  ctx.update('channel_settings', created.id, {
    approval_mode: options.approval ?? 'direct', automation_notice_ack: { at: ctx.now, via: 'worker_app', by: `device:${device.id}`, version: AUTOMATION_NOTICE_VERSION },
    risk_ack: options.riskAck === false ? null : { at: ctx.now, by_user_id: 'owner', terms_version: RISK_TERMS_VERSION, text_sha256: 'f'.repeat(64) },
    ...(provider === 'tiktok' && { platform_defaults: { tiktok: { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false } } }),
  });
  const file = ctx.create('file_object', { purpose: 'asset', sha256: 'b'.repeat(64), scan_status: 'skipped', mime_type: 'video/mp4', size_bytes: 30_000_000,
    storage_key: `t/tenant/w/${ctx.workspaceId}/objects/${randomUUID()}`, original_filename: 'video.mp4' });
  const asset = ctx.create('asset', { kind: 'video', brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'ready', title: 'video.mp4' });
  const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, sha256: 'b'.repeat(64), mime_type: 'video/mp4', meta: { duration_ms: 12_000, width: 1080, height: 1920 } });
  ctx.update('asset', asset.id, { current_version_id: version.id });

  const settings = () => ctx.list('channel_settings').find(row => row.social_account_id === account.id)!;
  async function variant(text = 'New lure test', media = [{ asset_id: asset.id, asset_version_id: version.id, role: 'primary' }]) {
    const draft = await run('content_create_draft', { brand_id: 'brand', title: text, variants: [{ platform: provider, format: 'short_video', social_account_id: account.id,
      body: text, media }] }) as { variants: Row[] };
    if (provider === 'tiktok') {
      const { applyChannelDefaults } = await import('../content/index.js');
      await applyChannelDefaults(ctx, draft.variants[0].id, settings().platform_defaults as never);
    }
    return draft.variants[0];
  }
  /** Schedules and submits a post; a direct channel is approved at once, which dispatches the job (§5.2). */
  async function schedule(at: string | number, text?: string) {
    const clip = await variant(text);
    const scheduled_at = typeof at === 'number' ? new Date(Date.parse(ctx.now) + at).toISOString() : at;
    const target = run('publishing_create_target', { social_account_id: account.id, content_variant_id: clip.id, scheduled_at, late_policy: 'skip', grace_minutes: 30 }) as Row;
    run('publishing_request_approval', {}, { id: target.id });
    return ctx.get('publish_target', target.id);
  }
  const job = (id: string) => ctx.get(JOB, id);
  const jobOf = (targetId: string) => ctx.get(JOB, String(ctx.get('publish_target', targetId).worker_job_id));
  const jobsOf = (targetId: string) => ctx.list(JOB).filter(row => row.publish_target_id === targetId);
  const task = (targetId: string) => ctx.list('execution_task').find(row => row.publish_target_id === targetId)!;
  const timeline = (jobId: string) => ctx.list('worker_job_event').filter(row => row.job_id === jobId).map(row => String(row.event));

  // ---------- Device protocol (handlers called directly; the signature layer has its own tests) ----------
  const seq = new Map<string, number>();
  function heartbeat(held: string[] = [], body: Data = {}, machine: Row = device) {
    return heartbeatV2(ctx, ctx.get('connector_device', machine.id), { client_version: '0.2.0', protocol: 2, drivers: [], outbox_depth: 0, worker_time: ctx.now,
      applied_sync_generation: 0, jobs: held.map(id => ({ job_id: id, local_state: 'claimed', fencing_token: Number(job(id).fencing_token) })), ...body });
  }
  function claim(held: string[] = [], body: Data = {}, machine: Row = device) {
    return claimJobs(ctx, ctx.get('connector_device', machine.id), { kinds: ['publish_post', 'check_login'], horizon_minutes: 1440, max: 10, held_job_ids: held, ...body });
  }
  function report(jobId: string, event: JobReportEvent, data: Data = {}, opts: { fence?: number; seq?: number; event_id?: string; machine?: Row } = {}) {
    const fence = opts.fence ?? Number(job(jobId).fencing_token);
    const key = `${jobId}:${fence}`;
    const next = opts.seq ?? (seq.get(key) ?? 0) + 1;
    const result = reportJob(ctx, ctx.get('connector_device', (opts.machine ?? device).id), {
      job_id: jobId, fencing_token: fence, seq: next, event_id: opts.event_id ?? randomUUID(), event, worker_time: ctx.now, data: { event, ...data },
    });
    if (opts.seq === undefined || next === (seq.get(key) ?? 0) + 1) seq.set(key, Math.max(seq.get(key) ?? 0, next));
    return result;
  }
  function go(jobId: string, opts: { fence?: number; machine?: Row } = {}) {
    return goJob(ctx, ctx.get('connector_device', (opts.machine ?? device).id), { job_id: jobId, fencing_token: opts.fence ?? Number(job(jobId).fencing_token) });
  }
  function advance(ms: number) { ctx.now = new Date(Date.parse(ctx.now) + ms).toISOString(); }
  function at(iso: string) { ctx.now = iso; }
  /** The happy path up to `ready` (claim, preflight, final prepare). */
  function prepare(jobId: string) {
    claim();
    report(jobId, 'prepared', { stage: 'preflight', login: 'verified', identity: account.external_account_id, handle: 'lurelab', media_ok: true, driver: { provider, version: `${provider}@2026.11.1` } });
    report(jobId, 'prepared', { stage: 'final', login: 'verified', identity: account.external_account_id, handle: 'lurelab', media_ok: true, driver: { provider, version: `${provider}@2026.11.1` } });
  }
  const resultData = (id = '1861234567890123456') => ({ url: provider === 'x' ? `https://x.com/lurelab/status/${id}` : `https://www.tiktok.com/@lurelab/video/${id}`,
    external_post_id: id, published_at: ctx.now, evidence_sha256: [], submitted_by: 'auto', go: 'hub' });
  /** prepare → go → started → submitting → submitted → result. */
  function publishNow(jobId: string, id?: string) {
    prepare(jobId);
    if (Date.parse(ctx.now) < Date.parse(String(job(jobId).not_before))) at(String(job(jobId).not_before));
    const answer = go(jobId);
    if (!answer.go) throw new Error(`go denied: ${answer.reason}`);
    report(jobId, 'started', { go: 'hub', mode: answer.mode });
    report(jobId, 'submitting');
    report(jobId, 'submitted', {});
    return report(jobId, 'result', resultData(id));
  }
  const lifecycle = () => workerLifecycle(ctx);
  return { ctx, rows, events, run, device, other, account, binding, settings, asset, version, file, variant, schedule, job, jobOf, jobsOf, task, timeline,
    heartbeat, claim, report, go, advance, at, prepare, publishNow, resultData, lifecycle, seq };
}
export type HubFixture = ReturnType<typeof hubFixture>;
