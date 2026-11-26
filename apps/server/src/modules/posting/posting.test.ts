import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_NOTICE_VERSION, Problem, RISK_TERMS_VERSION, type Context, type Data, type Row, type WorkerJobRecord,
} from '@smartsell/contracts';
import '../planning/index.js';
import { CHANNEL_SETTINGS, ensureChannelSettings, setWorkerEngineHooks } from '../account/channel-settings.js';
import { handleContentEvent } from '../content/revisions.js';
import { commandContext } from '../content/operations.js';
import { operations } from './index.js';
import { checkChannel } from './check.js';
import { agentPost } from './posts.js';
import { pausePublishing } from './pause.js';
import { schedulePosts } from './schedule.js';
import { HUB_TOOL_NAMES, TOOL_EXAMPLES, UUID_PATTERN, parseToolArgs, toolInputSchema } from './schemas.js';
import { applyUnblock } from './unblock.js';
import { updatePost } from './update.js';
import { channelsList, overview } from './views.js';
import { calendarEvents, viewPeriod } from '../workspace/views/calendar.js';

type Loose = Row & Record<string, any>;
const NOW = '2026-11-24T12:00:00.000Z';   // 20:00 in Asia/Shanghai
const TOMORROW_9 = '2026-11-25T01:00:00.000Z';

function memory(now = NOW) {
  const rows = new Map<string, Row[]>();
  const events: { type: string; payload: Data }[] = [];
  let serial = 0;
  const id = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const ctx: Context & { agentCredentialId?: string } = {
    actorId: 'owner', role: 'owner', tenantId: 'tenant', workspaceId: 'd4a7c9e1-6f5b-4d8c-9e0a-9b8c7f6e5d43', now,
    agentCredentialId: 'credential-a',
    list: (kind: string) => rows.get(kind) ?? [],
    get(kind: string, key: string) {
      const row = ctx.list(kind).find(item => item.id === key);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${key}`);
      return row;
    },
    create(kind: string, data: Data) {
      const row = { ...structuredClone(data), id: id(), version: 1, created_at: ctx.now, updated_at: ctx.now } as Row;
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind: string, key: string, data: Data) {
      const row = ctx.get(kind, key);
      const updated = { ...row, ...structuredClone(data), id: key, version: row.version + 1, updated_at: ctx.now } as Row;
      rows.set(kind, ctx.list(kind).map(item => item.id === key ? updated : item));
      return updated;
    },
    remove(kind: string, key: string) { rows.set(kind, ctx.list(kind).filter(row => row.id !== key)); },
    emit(type: string, payload: Data) { events.push({ type, payload }); },
  };
  return { ctx, events, rows };
}

const hoursAgo = (now: string, hours: number) => new Date(Date.parse(now) - hours * 3_600_000).toISOString();
const tiktokDefaults = { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false };

/** The §7.6 world: Mac-B with X (direct, risk acknowledged), Win-C with TikTok (needs_approval, assist), one ready video. */
function world(now = NOW) {
  const { ctx, events, rows } = memory(now);
  ctx.create('workspace', { default_timezone: 'Asia/Shanghai', name: 'MakeMyLure' });
  const brand = ctx.create('brand', { name: 'MakeMyLure', slug: 'makemylure', status: 'active' });
  const channel = (provider: 'x' | 'tiktok', handle: string, machine: string, checkedHoursAgo: number) => {
    const device = ctx.create('connector_device', { name: `${machine.toLowerCase()}.local`, display_name: machine, status: 'active', last_seen_at: now, platform: 'darwin' });
    const account = ctx.create('social_account', { provider, status: 'active', brand_id: brand.id, external_account_id: handle, handle, display_name: handle, default_timezone: 'Asia/Shanghai' });
    const binding = ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: device.id, connector_mode: 'assist', paused: false });
    ctx.create('browser_session', { social_account_id: account.id, binding_id: binding.id, device_id: device.id, status: 'verified', verified_at: hoursAgo(now, checkedHoursAgo), checked_at: hoursAgo(now, checkedHoursAgo) });
    const settings = ensureChannelSettings(ctx, account.id);
    return { device, account, settings };
  };
  const x = channel('x', 'makemylure', 'Mac-B', 3);
  const tiktok = channel('tiktok', 'lurelab', 'Win-C', 13);
  ctx.update(CHANNEL_SETTINGS, x.settings.id, { approval_mode: 'direct', automation_notice_ack: { at: now, via: 'web', by: 'owner', version: AUTOMATION_NOTICE_VERSION },
    risk_ack: { at: now, by_user_id: 'owner', terms_version: RISK_TERMS_VERSION, text_sha256: 'a'.repeat(64) } });
  ctx.update(CHANNEL_SETTINGS, tiktok.settings.id, { approval_mode: 'needs_approval', automation_notice_ack: { at: now, via: 'web', by: 'owner', version: AUTOMATION_NOTICE_VERSION },
    platform_defaults: { tiktok: tiktokDefaults } });
  const media = (kind: 'video' | 'image' = 'video', fields: Data = {}) => {
    const mime = kind === 'video' ? 'video/mp4' : 'image/jpeg';
    const sha = `${kind === 'video' ? 'b' : 'c'}${String(serialOf(rows)).padStart(63, '0')}`;
    const file = ctx.create('file_object', { purpose: 'asset', sha256: sha, scan_status: 'skipped', mime_type: mime, size_bytes: 31_457_280, original_filename: `${kind}.mp4` });
    const asset = ctx.create('asset', { kind, brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'ready', title: `${kind}.mp4`, ...fields });
    const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, sha256: sha, mime_type: mime, version_no: 1 });
    ctx.update('asset', asset.id, { current_version_id: version.id });
    return ctx.get('asset', asset.id);
  };
  const video = media();
  const checks: string[] = [];
  const restore = setWorkerEngineHooks({
    createCheckLoginJob(scope, accountId) {
      checks.push(accountId);
      const device = scope.list('account_execution_binding').find(row => row.social_account_id === accountId)!.device_id;
      return scope.create('worker_job', { kind: 'check_login', status: 'queued', social_account_id: accountId, device_id: device, publish_target_id: null,
        not_before: scope.now, not_after: new Date(Date.parse(scope.now) + 600_000).toISOString(), dry_run: false, revoke: null, blocker: null, result: null }) as unknown as WorkerJobRecord;
    },
    bumpSyncGeneration: () => 0,
  });
  return { ctx, events, x, tiktok, video, media, checks, restore, brand };
}
const serialOf = (rows: Map<string, Row[]>) => [...rows.values()].reduce((sum, list) => sum + list.length, 0);

const code = async (promise: Promise<unknown> | (() => unknown)) => {
  try { await (typeof promise === 'function' ? promise() : promise); return 'ok'; } catch (error) { return (error as Problem).code; }
};
const problemOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Problem; }
  return assert.fail('expected a Problem');
};

// ---------- Schemas (§7.2) ----------

function walk(schema: unknown, path: string, visit: (node: Data, path: string) => void) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) { schema.forEach((item, index) => walk(item, `${path}[${index}]`, visit)); return; }
  visit(schema as Data, path);
  for (const [key, value] of Object.entries(schema)) walk(value, `${path}.${key}`, visit);
}

test('every hub tool schema is strict all the way down, under 4 KB, without $ref, $defs or \\p{', () => {
  assert.deepEqual(HUB_TOOL_NAMES, ['smartsell_overview', 'machines_list', 'channels_list', 'channel_check', 'media_upload', 'post_schedule',
    'post_update', 'posts_list', 'post_get', 'task_get', 'publishing_pause', 'browser_open', 'browser_act', 'phone_act']);
  for (const name of HUB_TOOL_NAMES) {
    const schema = toolInputSchema(name);
    const text = JSON.stringify(schema);
    assert.ok(Buffer.byteLength(text, 'utf8') < 4096, `${name} is ${Buffer.byteLength(text)} bytes`);
    assert.ok(!text.includes('"$ref"') && !text.includes('"$defs"') && !text.includes('definitions'), name);
    assert.ok(!text.includes('\\p{') && !text.includes('\\\\p{'), name);
    assert.equal(schema.type, 'object');
    walk(schema, name, (node, path) => {
      if (node.type === 'object') assert.equal(node.additionalProperties, false, `${path} must be additionalProperties:false`);
      if (typeof node.pattern === 'string') assert.ok(/^[\x20-\x7e]*$/.test(node.pattern), `${path} pattern is ASCII`);
    });
  }
  const schedule = toolInputSchema('post_schedule') as Loose;
  assert.deepEqual(schedule.required, ['media_ids', 'channel_ids', 'when']);
  assert.equal(schedule.properties.channel_ids.uniqueItems, true);
  assert.equal(schedule.properties.captions.minProperties, 1);
  assert.deepEqual(Object.keys(schedule.properties.captions.properties), ['default', 'x', 'tiktok', 'youtube', 'instagram', 'facebook']);
  assert.equal(schedule.properties.when.pattern, '^(now|\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})$');
  assert.ok(!('product_ids' in schedule.properties), 'phase 1 takes no product_ids');
});

test('every example parses with its schema and every example ID is a real lowercase UUID', () => {
  for (const name of HUB_TOOL_NAMES) {
    parseToolArgs(name, TOOL_EXAMPLES[name]);
    const text = JSON.stringify(TOOL_EXAMPLES[name]);
    for (const match of text.matchAll(/"(?:[a-z_]+_ids?|id)":\s*(\[[^\]]*\]|"[^"]*")/g)) {
      for (const value of match[1]!.match(/"([^"]+)"/g) ?? []) assert.match(value.slice(1, -1), UUID_PATTERN, `${name}: ${value}`);
    }
  }
});

test('unknown and malformed fields return INVALID_ARGUMENTS with issue paths and the allowed list', () => {
  const issues = (name: Parameters<typeof parseToolArgs>[0], args: unknown) => {
    try { parseToolArgs(name, args); } catch (error) {
      assert.equal((error as Problem).code, 'INVALID_ARGUMENTS');
      assert.equal((error as Problem).status, 422);
      return { message: (error as Problem).message, issues: (error as Problem).details!.issues as Loose[] };
    }
    return assert.fail('expected INVALID_ARGUMENTS');
  };
  const unknown = issues('post_schedule', { ...TOOL_EXAMPLES.post_schedule, captions: { tiktok: { text: 'x', desc: 'y' } } });
  assert.equal(unknown.message, "captions.tiktok has an unknown field 'desc'. Allowed: text, title, tags.");
  assert.deepEqual(unknown.issues[0], { path: 'captions.tiktok.desc', code: 'unrecognized_keys', allowed: ['text', 'title', 'tags'], message: unknown.message });
  assert.deepEqual(issues('post_schedule', { ...TOOL_EXAMPLES.post_schedule, workspace_id: 'x', product_ids: [] }).issues.map(issue => issue.path), ['workspace_id', 'product_ids']);
  assert.deepEqual(issues('post_schedule', { media_ids: [], channel_ids: ['A'], when: 'tomorrow 9am' }).issues.map(issue => issue.path), ['media_ids', 'channel_ids[0]', 'when']);
  const repeated = '5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
  assert.deepEqual(issues('post_schedule', { ...TOOL_EXAMPLES.post_schedule, channel_ids: [repeated, repeated] }).issues.map(issue => issue.code), ['not_unique']);
  assert.deepEqual(issues('post_schedule', { ...TOOL_EXAMPLES.post_schedule, captions: {} }).issues.map(issue => issue.path), ['captions']);
  // Unicode tags are checked on the server (no \p{ in the schema): letters in any script pass, punctuation does not.
  parseToolArgs('post_schedule', { ...TOOL_EXAMPLES.post_schedule, captions: { default: { text: '新路亞實測', tags: ['釣魚', 'lure_2'] } } });
  assert.deepEqual(issues('post_schedule', { ...TOOL_EXAMPLES.post_schedule, captions: { x: { text: 'a', tags: ['ok', 'no!'] } } }).issues.map(issue => issue.path), ['captions.x.tags[1]']);
  assert.deepEqual(issues('post_update', { post_id: repeated, action: 'reschedule', caption: { text: 'a' } }).issues.map(issue => issue.path), ['when', 'caption']);
  assert.deepEqual(issues('post_update', { post_id: repeated, action: 'cancel', when: 'now' }).issues.map(issue => issue.path), ['when']);
  assert.deepEqual(issues('post_update', { post_id: repeated, action: 'edit_caption' }).issues.map(issue => issue.path), ['caption']);
  assert.deepEqual(issues('publishing_pause', { scope: 'channel', reason: 'stop' }).issues.map(issue => issue.path), ['id']);
  assert.deepEqual(issues('publishing_pause', { scope: 'all', id: repeated, reason: 'stop' }).issues.map(issue => issue.path), ['id']);
  assert.deepEqual(issues('posts_list', { status: ['live'] }).issues.map(issue => issue.path), ['status[0]']);
  assert.deepEqual(issues('channel_check', { channel_id: repeated, wait_seconds: 41 }).issues.map(issue => issue.path), ['wait_seconds']);
  assert.equal(parseToolArgs('channel_check', { channel_id: repeated }).wait_seconds, 30);
  assert.equal(parseToolArgs('media_upload', { path: '/tmp/a.mp4' }).wait_seconds, 45);
});

test('operations use their full hub_* names, are Agent-callable writes and sit outside HUMAN_ONLY', async () => {
  const { HUMAN_ONLY, agentCallable } = await import('../../operations.js');
  assert.deepEqual(operations.map(op => [op.method, op.path, op.name]), [
    ['POST', '/hub/posts/schedule', 'hub_posts_schedule'], ['POST', '/hub/posts/:id/update', 'hub_posts_update'],
    ['POST', '/hub/channels/:id/check', 'hub_channels_check'], ['POST', '/hub/pause', 'hub_publishing_pause']]);
  for (const op of operations) {
    assert.ok(!HUMAN_ONLY.has(op.name) && agentCallable({ ...op, module: 'posting' }), op.name);
    assert.ok(op.roles.includes('agent') && !op.roles.includes('viewer'), op.name);
  }
});

// ---------- post_schedule (§7.2.6) ----------

const schedule = (w: ReturnType<typeof world>, extra: Data = {}) => schedulePosts(w.ctx, {
  media_ids: [w.video.id], channel_ids: [w.x.account.id, w.tiktok.account.id], when: '2026-11-25 09:00', ...extra,
});

test('one call schedules both channels in the workspace time zone without inventing a caption (§7.6)', async t => {
  const w = world();
  t.after(w.restore);
  const result = await schedule(w);
  assert.equal(result.replayed, false);
  assert.equal(result.posts.length, 2);
  const [x, tiktok] = result.posts;
  const targets = w.ctx.list('publish_target') as Loose[];
  assert.equal(targets.length, 2);
  for (const target of targets) {
    assert.equal(target.scheduled_at, TOMORROW_9);
    assert.equal(target.schedule_tz, 'Asia/Shanghai', 'timezone omitted → workspace time zone');
    assert.deepEqual([target.origin, target.created_by_tool, target.auto_submit_on_unblock, target.late_policy], ['agent_tool', 'post_schedule', true, 'skip']);
    // variant fields sit at the top level, so the committed revision carries the (empty) text and the media.
    const revision = w.ctx.get('content_revision', target.variant_revision_id) as Loose;
    assert.equal(revision.rendered.text, '');
    assert.deepEqual(revision.media.map((item: Loose) => [item.asset_id, item.asset_version_id]), [[w.video.id, w.video.current_version_id]]);
  }
  const tiktokRevision = w.ctx.get('content_revision', targets[1]!.variant_revision_id) as Loose;
  assert.deepEqual(tiktokRevision.settings.platform_options.tiktok, tiktokDefaults, 'channel defaults applied to the bound revision');
  assert.equal(w.ctx.list('content_item').length, 1, 'one brand → one content item');
  assert.equal(result.content_id, w.ctx.list('content_item')[0]!.id);
  // X: direct → approved by channel policy, scheduled on Mac-B in auto mode, login fresh.
  assert.deepEqual([x.provider, x.handle, x.status, x.approval, x.approval_deadline_local, x.owner_action], ['x', '@makemylure', 'scheduled', 'approved_by_channel_policy', null, null]);
  assert.deepEqual(x.route, { kind: 'machine', machine_id: w.x.device.id, machine_name: 'Mac-B', mode: 'auto' });
  assert.deepEqual([x.local_time, x.latest_local_time, x.login.check_task_id], ['2026-11-25 09:00 Asia/Shanghai', '2026-11-25 09:30', null]);
  const xRequest = w.ctx.get('approval_request', targets[0]!.approval_request_id) as Loose;
  assert.deepEqual([xRequest.status, xRequest.approved_via, targets[0]!.plan_status], ['approved', 'channel_policy', 'ready']);
  // TikTok: needs_approval → pending request with the lateness deadline; no risk ack → the owner clicks Post on Win-C.
  assert.deepEqual([tiktok.status, tiktok.approval, tiktok.approval_deadline_local], ['awaiting_approval', 'awaiting_owner', '2026-11-25 09:30']);
  assert.deepEqual(tiktok.owner_action, { kind: 'click_post', machine: 'Win-C', from_local: '2026-11-25 09:00', until_local: '2026-11-25 09:30', remote_url: null });
  const pending = w.ctx.get('approval_request', targets[1]!.approval_request_id) as Loose;
  assert.deepEqual([pending.status, pending.due_at], ['pending', '2026-11-25T01:30:00.000Z']);
  // TikTok's login was checked 13 h ago → one check_login through the job engine hook; X's (3 h) is fresh.
  assert.deepEqual(w.checks, [w.tiktok.account.id]);
  assert.equal(tiktok.login.check_task_id, w.ctx.list('worker_job').find(job => job.kind === 'check_login')!.id);
  for (const post of result.posts) assert.ok(post.warnings.some(warning => warning.code === 'caption_empty'), 'caption_empty warning');
  assert.equal(result.web_url, `http://127.0.0.1:3401/app/${w.ctx.workspaceId}/calendar?view=week&week=2026-11-23&event=publish:${x.post_id}`);
  assert.equal(x.web_url, `http://127.0.0.1:3401/app/${w.ctx.workspaceId}/posts/${x.post_id}`);
});

test('captions.default plus a platform override, rendered with hashtags; title is ignored outside YouTube with a warning', async t => {
  const w = world();
  t.after(w.restore);
  const result = await schedule(w, { captions: { default: { text: '新路亞實測 🎣', tags: ['fishing', 'lure'] }, tiktok: { text: 'TikTok only', title: 'Ignored' } } });
  const [x, tiktok] = result.posts;
  assert.equal(x.caption_preview, '新路亞實測 🎣 #fishing #lure');
  assert.equal(tiktok.caption_preview, 'TikTok only');
  assert.ok(tiktok.warnings.some(warning => warning.code === 'caption_title_ignored'));
  assert.ok(!x.warnings.some(warning => warning.code === 'caption_empty'));
  assert.equal((w.ctx.list('content_item')[0] as Loose).title, '新路亞實測 🎣');
});

test('request_id and the argument hash deduplicate within 15 minutes; a changed body under the same request_id is refused', async t => {
  const w = world();
  t.after(w.restore);
  const first = await schedule(w, { request_id: 'lure-launch-1' });
  const again = await schedule(w, { request_id: 'lure-launch-1' });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.posts.map(post => post.post_id), first.posts.map(post => post.post_id));
  assert.equal(w.ctx.list('publish_target').length, 2);
  assert.equal(await code(schedule(w, { request_id: 'lure-launch-1', plan_tag: 'other' })), 'IDEMPOTENCY_MISMATCH');
  // Without request_id the same arguments replay too (a client retry), while a different time is a new request.
  const plain = await schedule(w, { when: '2026-11-25 10:00' });
  assert.equal((await schedule(w, { when: '2026-11-25 10:00' })).replayed, true);
  assert.equal(w.ctx.list('publish_target').length, 4);
  // After 15 minutes the same arguments schedule again.
  (w.ctx as { now: string }).now = new Date(Date.parse(NOW) + 16 * 60_000).toISOString();
  const later = await schedule(w, { when: '2026-11-25 10:00' });
  assert.equal(later.replayed, false);
  assert.notDeepEqual(later.posts.map(post => post.post_id), plain.posts.map(post => post.post_id));
});

test('time rules: workspace zone by default, explicit zones, now + 30 s, past, DST gap and fold, unknown zone', async t => {
  const w = world();
  t.after(w.restore);
  const tokyo = await schedule(w, { timezone: 'Asia/Tokyo', channel_ids: [w.x.account.id] });
  assert.equal(tokyo.posts[0]!.scheduled_at, '2026-11-25T00:00:00.000Z');
  assert.equal(tokyo.posts[0]!.local_time, '2026-11-25 09:00 Asia/Tokyo');
  const now = await schedule(w, { when: 'now', channel_ids: [w.x.account.id] });
  assert.equal(now.posts[0]!.scheduled_at, new Date(Date.parse(NOW) + 30_000).toISOString());
  assert.equal(await code(schedule(w, { when: '2026-11-24 08:00' })), 'TIME_IN_PAST');
  // Within 60 s of now is still accepted (the minute just started).
  assert.equal(await code(schedule(w, { when: '2026-11-24 20:00', channel_ids: [w.x.account.id] })), 'ok');
  const gap = await problemOf(schedule(w, { when: '2027-03-14 02:30', timezone: 'America/New_York' }));
  assert.deepEqual([gap.code, gap.details!.dst_choice], ['TIME_NONEXISTENT', ['shift_forward']]);
  const fold = await problemOf(schedule(w, { when: '2027-11-07 01:30', timezone: 'America/New_York' }));
  assert.deepEqual([fold.code, fold.details!.dst_choice], ['TIME_AMBIGUOUS', ['earlier_occurrence', 'later_occurrence']]);
  const later = await schedule(w, { when: '2027-11-07 01:30', timezone: 'America/New_York', dst_choice: 'later_occurrence', channel_ids: [w.x.account.id] });
  assert.equal(later.posts[0]!.scheduled_at, '2027-11-07T06:30:00.000Z');
  assert.equal(await code(schedule(w, { timezone: 'Mars/Olympus' })), 'TIMEZONE_INVALID');
  assert.equal(await code(schedule(w, { when: '2026-02-30 09:00' })), 'INVALID_ARGUMENTS');
});

test('MEDIA_NOT_SUPPORTED for every platform rule, MEDIA_FAILED, MEDIA_NOT_FOUND and CHANNEL_NOT_FOUND', async t => {
  const w = world();
  t.after(w.restore);
  const images = [w.media('image'), w.media('image'), w.media('image'), w.media('image'), w.media('image')];
  const reasons = async (extra: Data) => {
    const error = await problemOf(schedule(w, extra));
    assert.equal(error.code, 'MEDIA_NOT_SUPPORTED');
    return (error.details!.channels as Loose[]).map(row => [row.provider, row.channel_id]);
  };
  // TikTok: exactly one video.
  assert.deepEqual(await reasons({ media_ids: [images[0]!.id] }), [['tiktok', w.tiktok.account.id]]);
  assert.deepEqual(await reasons({ media_ids: [w.video.id, w.media('video').id] }), [['x', w.x.account.id], ['tiktok', w.tiktok.account.id]]);
  // X: one video or 1–4 images, never mixed; five images are too many.
  assert.deepEqual(await reasons({ media_ids: images.map(image => image.id), channel_ids: [w.x.account.id] }), [['x', w.x.account.id]]);
  assert.deepEqual(await reasons({ media_ids: [w.video.id, images[0]!.id], channel_ids: [w.x.account.id] }), [['x', w.x.account.id]]);
  const four = await schedule(w, { media_ids: images.slice(0, 4).map(image => image.id), channel_ids: [w.x.account.id] });
  const target = w.ctx.get('publish_target', four.posts[0]!.post_id) as Loose;
  assert.equal(target.content_format, 'image', 'all images → feed_image');
  const failed = w.media('video', { status: 'failed', failure: { code: 'UPLOAD_HASH_MISMATCH' } });
  assert.equal(await code(schedule(w, { media_ids: [failed.id] })), 'MEDIA_FAILED');
  assert.equal(await code(schedule(w, { media_ids: ['0b8e6c2a-1f7d-4c39-9a51-6f0c2d7e8a11'] })), 'MEDIA_NOT_FOUND');
  const missing = await problemOf(schedule(w, { channel_ids: [w.x.account.id, '7c2f3a4b-5d6e-4f70-9a8b-0c1d2e3f4a5b'] }));
  assert.deepEqual([missing.code, missing.details!.hint, missing.details!.channel_ids], ['CHANNEL_NOT_FOUND', 'call channels_list', ['7c2f3a4b-5d6e-4f70-9a8b-0c1d2e3f4a5b']]);
  // An upload still in flight can be scheduled (risk at schedule time, §4.4).
  const uploading = w.media('video', { status: 'uploading' });
  const pending = await schedule(w, { media_ids: [uploading.id], channel_ids: [w.x.account.id], when: '2026-11-25 11:00' });
  assert.ok(pending.posts[0]!.warnings.some(warning => warning.code === 'media_spec'), JSON.stringify(pending.posts[0]!.warnings));
});

test('a blocked channel does not stop the others; its post is blocked with the precheck blockers', async t => {
  const w = world();
  t.after(w.restore);
  w.ctx.update(CHANNEL_SETTINGS, w.tiktok.settings.id, { automation_notice_ack: null });
  const result = await schedule(w);
  const [x, tiktok] = result.posts;
  assert.equal(x.status, 'scheduled');
  assert.deepEqual([tiktok.status, tiktok.approval], ['blocked', 'not_submitted']);
  assert.ok(tiktok.blockers.some(blocker => blocker.code === 'automation_notice'), JSON.stringify(tiktok.blockers));
  assert.match(tiktok.blockers[0]!.web_url, /\/channels\//);
  // The calendar counts the blocked post as needing the owner, as Today does.
  const events = calendarEvents(w.ctx, { period: viewPeriod(w.ctx, { from: NOW.slice(0, 10), to: '2026-11-26', tz: 'UTC' }, 2), kinds: ['publish'] });
  assert.deepEqual(events.filter(event => event.post_id).map(event => [event.post_id, event.needs_human]).sort(),
    [[x.post_id, null], [tiktok.post_id, 'needs_owner']].sort());
  // posting.unblock: the owner acknowledges the notice, the post is submitted again (needs_approval → pending request).
  w.ctx.update(CHANNEL_SETTINGS, w.tiktok.settings.id, { automation_notice_ack: { at: NOW, via: 'web', by: 'owner', version: AUTOMATION_NOTICE_VERSION } });
  const moved = await applyUnblock(w.ctx, { type: 'account.automation_notice.acked', payload: { social_account_id: w.tiktok.account.id } });
  assert.equal(moved.resubmitted, 1);
  const after = agentPost(w.ctx, w.ctx.get('publish_target', tiktok.post_id));
  assert.deepEqual([after.status, after.approval], ['awaiting_approval', 'awaiting_owner']);
});

test('posting.unblock applies new channel defaults to a new revision before resubmitting a TikTok post', async t => {
  const w = world();
  t.after(w.restore);
  w.ctx.update(CHANNEL_SETTINGS, w.tiktok.settings.id, { platform_defaults: {}, approval_mode: 'direct' });
  const [, tiktok] = (await schedule(w)).posts;
  assert.equal(tiktok.status, 'blocked');
  assert.ok(tiktok.blockers.some(blocker => blocker.code === 'channel_defaults'), JSON.stringify(tiktok.blockers));
  const before = (w.ctx.get('publish_target', tiktok.post_id) as Loose).variant_revision_id;
  w.ctx.update(CHANNEL_SETTINGS, w.tiktok.settings.id, { platform_defaults: { tiktok: tiktokDefaults } });
  await applyUnblock(w.ctx, { type: 'account.channel_settings.changed', payload: { social_account_id: w.tiktok.account.id } });
  const target = w.ctx.get('publish_target', tiktok.post_id) as Loose;
  assert.notEqual(target.variant_revision_id, before, 'pointed at the revision with the defaults');
  assert.deepEqual((w.ctx.get('content_revision', target.variant_revision_id) as Loose).settings.platform_options.tiktok, tiktokDefaults);
  assert.equal(target.plan_status, 'ready', 'direct channel approves on resubmission');
  assert.equal(agentPost(w.ctx, target).approval, 'approved_by_channel_policy');
});

test('without the job engine the login check is reported as unavailable, never faked; the post is still scheduled', async t => {
  const w = world();
  t.after(w.restore);
  const restore = setWorkerEngineHooks({ createCheckLoginJob() { throw new Problem(503, 'WORKER_ENGINE_UNAVAILABLE', 'Worker 工作引擎尚未啟用'); } });
  t.after(restore);
  const [, tiktok] = (await schedule(w)).posts;
  assert.equal(tiktok.login.check_task_id, null);
  assert.ok(tiktok.warnings.some(warning => warning.code === 'login_check_unavailable'));
  // A login check already open is reused instead of creating another.
  restore();
  const job = w.ctx.create('worker_job', { kind: 'check_login', status: 'claimed', social_account_id: w.x.account.id, device_id: w.x.device.id });
  w.ctx.update('browser_session', w.ctx.list('browser_session')[0]!.id, { checked_at: hoursAgo(NOW, 20), verified_at: hoursAgo(NOW, 20) });
  const [x] = (await schedule(w, { when: '2026-11-25 12:00', channel_ids: [w.x.account.id] })).posts;
  assert.equal(x.login.check_task_id, job.id);
});

// ---------- post_update (§7.2.7) ----------

test('post_update reschedules outside the tolerance and resubmits (direct approves, needs_approval gets a pending request)', async t => {
  const w = world();
  t.after(w.restore);
  const [x, tiktok] = (await schedule(w)).posts;
  const within = await updatePost(w.ctx, x.post_id, { action: 'reschedule', when: '2026-11-25 09:30' });
  assert.deepEqual([within.approval_retained, within.changes, within.post.status], [true, ['scheduled_at'], 'scheduled']);
  const moved = await updatePost(w.ctx, x.post_id, { action: 'reschedule', when: '2026-11-26 15:00', timezone: 'Asia/Shanghai' });
  assert.equal(moved.approval_retained, false);
  assert.deepEqual([moved.post.status, moved.post.approval, moved.post.local_time], ['scheduled', 'approved_by_channel_policy', '2026-11-26 15:00 Asia/Shanghai']);
  const firstRequest = (w.ctx.get('publish_target', tiktok.post_id) as Loose).approval_request_id;
  const waiting = await updatePost(w.ctx, tiktok.post_id, { action: 'reschedule', when: '2026-11-26 15:00' });
  assert.equal(waiting.approval_retained, false);
  const target = w.ctx.get('publish_target', tiktok.post_id) as Loose;
  assert.notEqual(target.approval_request_id, firstRequest);
  assert.deepEqual([(w.ctx.get('approval_request', target.approval_request_id) as Loose).status, waiting.post.approval_deadline_local], ['pending', '2026-11-26 15:30']);
  assert.equal(await code(updatePost(w.ctx, x.post_id, { action: 'reschedule', when: '2026-11-24 19:00' })), 'TIME_IN_PAST');
});

test('post_update edit_caption commits a revision and resubmits; cancel ends the post; final and unknown posts are refused', async t => {
  const w = world();
  t.after(w.restore);
  const [x, tiktok] = (await schedule(w)).posts;
  const edited = await updatePost(w.ctx, tiktok.post_id, { action: 'edit_caption', caption: { text: '新路亞', tags: ['lure'] } });
  assert.deepEqual([edited.changes, edited.approval_retained, edited.post.caption_preview, edited.post.status], [['caption'], false, '新路亞 #lure', 'awaiting_approval']);
  const revision = w.ctx.get('content_revision', (w.ctx.get('publish_target', tiktok.post_id) as Loose).variant_revision_id) as Loose;
  assert.deepEqual(revision.settings.platform_options.tiktok, tiktokDefaults, 'options survive a caption edit');
  const cancelled = await updatePost(w.ctx, tiktok.post_id, { action: 'cancel', reason: 'owner changed plans' });
  assert.deepEqual([cancelled.changes, cancelled.post.status], [['cancelled'], 'cancelled']);
  assert.equal(await code(updatePost(w.ctx, tiktok.post_id, { action: 'cancel' })), 'POST_FINAL');
  // A job that may have posted: the result must be confirmed by the owner first; a click in progress locks the post.
  const job = w.ctx.create('worker_job', { kind: 'publish_post', status: 'outcome_unknown', publish_target_id: x.post_id, social_account_id: w.x.account.id, device_id: w.x.device.id });
  w.ctx.update('publish_target', x.post_id, { worker_job_id: job.id });
  const unknown = await problemOf(updatePost(w.ctx, x.post_id, { action: 'reschedule', when: '2026-11-26 10:00' }));
  assert.deepEqual([unknown.code, unknown.status, typeof unknown.details!.web_url], ['POST_RESULT_UNKNOWN', 409, 'string']);
  w.ctx.update('worker_job', job.id, { status: 'submitting' });
  assert.equal(await code(updatePost(w.ctx, x.post_id, { action: 'cancel' })), 'POST_LOCKED');
  w.ctx.update('worker_job', job.id, { status: 'succeeded' });
  assert.equal(await code(updatePost(w.ctx, x.post_id, { action: 'edit_caption', caption: { text: 'late' } })), 'POST_FINAL');
  assert.equal(await code(updatePost(w.ctx, '0b8e6c2a-1f7d-4c39-9a51-6f0c2d7e8a11', { action: 'cancel' })), 'POST_NOT_FOUND');
});

// ---------- channel_check, publishing_pause, read models ----------

test('hub_channels_check creates one login check and reuses an open one; offline machines report machine_offline', async t => {
  const w = world();
  t.after(w.restore);
  const first = checkChannel(w.ctx, w.x.account.id, {});
  // The open check shows as login 'checking' (channelLoginState) until the Worker reports.
  assert.deepEqual([first.status, first.login, first.machine?.name], ['pending', 'checking', 'Mac-B']);
  assert.equal(checkChannel(w.ctx, w.x.account.id, {}).task_id, first.task_id);
  assert.deepEqual(w.checks, [w.x.account.id]);
  w.ctx.update('connector_device', w.tiktok.device.id, { last_seen_at: hoursAgo(NOW, 1) });
  assert.equal(checkChannel(w.ctx, w.tiktok.account.id, {}).status, 'machine_offline');
  assert.equal(await code(() => checkChannel(w.ctx, w.x.account.id, { wait_seconds: 5 })), 'INVALID_ARGUMENTS');
  assert.equal(await code(() => checkChannel(w.ctx, '7c2f3a4b-5d6e-4f70-9a8b-0c1d2e3f4a5b', {})), 'CHANNEL_NOT_FOUND');
});

test('publishing_pause stops a channel, a machine or everything, and never resumes', async t => {
  const w = world();
  t.after(w.restore);
  const [x] = (await schedule(w)).posts;
  const channel = await pausePublishing(w.ctx, { scope: 'channel', id: w.x.account.id, reason: 'check the caption' });
  assert.deepEqual([channel.scope, channel.affected_posts, channel.resume], ['channel', 1, 'Only the owner can resume in the web app.']);
  assert.equal((w.ctx.get('publish_target', x.post_id) as Loose).plan_status, 'paused');
  assert.equal((w.ctx.get('pause_switch', channel.pause_id) as Loose).scope_type, 'social_account');
  const machine = await pausePublishing(w.ctx, { scope: 'machine', id: w.tiktok.device.id, reason: 'Win-C is being repaired' });
  assert.deepEqual([machine.scope, machine.pause_id, (w.ctx.get('connector_device', w.tiktok.device.id) as Loose).paused], ['machine', w.tiktok.device.id, true]);
  const all = await pausePublishing(w.ctx, { scope: 'all', reason: 'stop everything' });
  assert.equal((w.ctx.get('pause_switch', all.pause_id) as Loose).scope_type, 'workspace');
  assert.equal(await code(pausePublishing(w.ctx, { scope: 'machine', id: '2c9a7e14-5b3d-4f6a-8e21-7d0c4b9a3f55', reason: 'x' })), 'MACHINE_NOT_FOUND');
});

test('overview and channels_list show channel_ids, machines, the workspace zone and what blocks scheduling', async t => {
  const w = world();
  t.after(w.restore);
  w.ctx.update('connector_device', w.tiktok.device.id, { posture: { sleep_idle_min: 30 } });
  const view = overview(w.ctx) as unknown as Loose;
  assert.deepEqual(view.workspace, { name: 'MakeMyLure', timezone: 'Asia/Shanghai', now_local: '2026-11-24 20:00' });
  assert.deepEqual(view.channels.map((row: Loose) => [row.channel_id, row.provider, row.handle, row.machine, row.mode, row.approval, row.can_schedule]), [
    [w.tiktok.account.id, 'tiktok', '@lurelab', 'Win-C', 'assist', 'needs_approval', true], [w.x.account.id, 'x', '@makemylure', 'Mac-B', 'auto', 'direct', true]]);
  assert.deepEqual(view.machines.find((row: Loose) => row.name === 'Win-C').warnings, [{ code: 'sleep_enabled', message: 'Win-C sleeps after 30 min idle.' }]);
  w.ctx.update(CHANNEL_SETTINGS, w.tiktok.settings.id, { platform_defaults: {}, automation_notice_ack: null });
  const [tiktok] = channelsList(w.ctx, { provider: 'tiktok' }).channels;
  assert.deepEqual(tiktok!.blockers.map(blocker => blocker.code), ['automation_notice_missing', 'channel_defaults_missing']);
  assert.equal(tiktok!.can_schedule, false);
  assert.equal(channelsList(w.ctx, { machine_id: w.x.device.id }).channels.length, 1);
  // E30 (additive): every needs_owner item says whether it stops scheduling; only the channel's blockers do.
  const needs = (overview(w.ctx) as unknown as Loose).needs_owner as Loose[];
  assert.ok(needs.length > 0);
  for (const item of needs) assert.equal(typeof item.blocks_scheduling, 'boolean', item.title);
  const setup = needs.filter(item => item.kind === 'channel_setup' && item.channel_id === w.tiktok.account.id);
  assert.deepEqual(setup.map(item => item.blocks_scheduling), [true, false]);
  assert.match(setup[0].message, /自動化告知/);
  assert.doesNotMatch(setup[1].message, /自動化告知|預設選項/);
  assert.deepEqual(needs.filter(item => item.blocks_scheduling).map(item => item.channel_id), [w.tiktok.account.id]);
});

test('an agent upload finishing does not mark posts scheduled during the upload stale (S5 ledger 11)', async t => {
  const w = world();
  t.after(w.restore);
  const uploading = w.media('video', { status: 'uploading' });
  const [x] = (await schedule(w, { media_ids: [uploading.id], channel_ids: [w.x.account.id] })).posts;
  const target = w.ctx.get('publish_target', x.post_id) as Loose;
  const variantId = target.content_variant_id;
  w.ctx.update('asset', uploading.id, { status: 'ready' });
  const notices = () => ((w.ctx.get('content_variant', variantId) as Loose).notices ?? []) as Loose[];
  // Without a version id the existing rule would add an asset_updated notice; the agent upload's first version is skipped.
  await handleContentEvent(commandContext(w.ctx), 'asset.version.created', { asset_id: uploading.id, version_no: 1, source: 'agent_upload' });
  assert.deepEqual([(w.ctx.get('content_variant', variantId) as Loose).readiness, notices()], ['draft', []]);
  // A person's new version of an asset still raises the existing asset_updated notice.
  await handleContentEvent(commandContext(w.ctx), 'asset.version.created', { asset_id: uploading.id, version_no: 2 });
  assert.deepEqual(notices().map(notice => notice.kind), ['asset_updated']);
});

// ---------- Wave 6 (G2): F1/E37, F2/MCP-1/E35, F5, F9/E39, F12/E44 ----------

/** The owner in the web app: the same store, no Agent credential (human-only operations refuse an Agent). */
const asOwner = (ctx: Context) => Object.assign(Object.create(ctx), { agentCredentialId: undefined }) as Context;
const opNamed = async (name: string) => {
  const { operations: planning } = await import('../planning/index.js');
  const { channelOperations } = await import('../account/channel-ops.js');
  const { machineOperations } = await import('../account/machine-ops.js');
  return [...planning, ...channelOperations, ...machineOperations].find(op => op.name === name) ?? assert.fail(`missing ${name}`);
};
const ownerRun = async (w: ReturnType<typeof world>, name: string, id: string, body: Data = {}, expectedVersion?: number) =>
  (await opNamed(name)).run(asOwner(w.ctx), { params: { id }, query: {}, body, expectedVersion }) as Loose;
/** Runs posting.unblock for every event emitted since `from`, as the subscriber does after the transaction. */
const deliver = async (w: ReturnType<typeof world>, from: number) => {
  for (const event of w.events.slice(from)) await applyUnblock(w.ctx, { type: event.type, payload: event.payload });
};

test('F1/E37: a post the owner rejected is never resubmitted by a settings change or a switch to direct; post_update sends it again', async t => {
  const w = world();
  t.after(w.restore);
  const [tiktok] = (await schedule(w, { channel_ids: [w.tiktok.account.id] })).posts;
  const target = () => w.ctx.get('publish_target', tiktok.post_id) as Loose;
  await ownerRun(w, 'publishing_reject', tiktok.post_id, { reason: 'Wrong video' }, target().version);
  const rejectedId = target().approval_request_id;
  assert.deepEqual([target().plan_status, (w.ctx.get('approval_request', rejectedId) as Loose).status], ['changes_requested', 'rejected']);
  const requests = () => w.ctx.list('approval_request').filter(row => row.resource_id === tiktok.post_id).map(row => row.status);
  // An unrelated setting changes later the same day; posting.unblock receives the event.
  let mark = w.events.length;
  const settings = () => w.ctx.get(CHANNEL_SETTINGS, w.tiktok.settings.id) as Loose;
  await ownerRun(w, 'hub_channels_update_settings', w.tiktok.account.id, { daily_cap: 4 }, settings().version);
  await deliver(w, mark);
  assert.deepEqual([target().plan_status, requests()], ['changes_requested', ['rejected']]);
  // Switching the channel to direct must not approve and dispatch it either.
  mark = w.events.length;
  await ownerRun(w, 'hub_channels_update_settings', w.tiktok.account.id, { approval_mode: 'direct' }, settings().version);
  await deliver(w, mark);
  assert.deepEqual([target().plan_status, requests()], ['changes_requested', ['rejected']]);
  assert.equal(agentPost(w.ctx, target()).approval, 'rejected');
  // The Agent changes the caption with post_update: that is an explicit resubmission, approved by the (now direct) channel.
  const edited = await updatePost(w.ctx, tiktok.post_id, { action: 'edit_caption', caption: { text: '換一支影片的說明' } });
  assert.deepEqual([edited.post.status, edited.post.approval], ['scheduled', 'approved_by_channel_policy']);
  assert.deepEqual(requests(), ['rejected', 'approved']);
});

test('F2/MCP-1/E35: posts scheduled or rescheduled during a pause go out after the owner releases it; a direct post is never awaiting_owner', async t => {
  const w = world();
  t.after(w.restore);
  const [x] = (await schedule(w, { channel_ids: [w.x.account.id] })).posts;
  const paused = await pausePublishing(w.ctx, { scope: 'channel', id: w.x.account.id, reason: 'Owner on holiday' });
  // (a) A new post while paused: blocked, and the overview tells the Agent the channel is paused.
  const [fresh] = (await schedule(w, { channel_ids: [w.x.account.id], when: '2026-11-26 09:00' })).posts;
  assert.deepEqual([fresh.status, fresh.approval, fresh.blockers.map(item => item.code)], ['blocked', 'not_submitted', ['pause_switch']]);
  assert.equal(fresh.blockers[0]!.message, '已暫停：恢復前不會發出');
  const channel = (overview(w.ctx) as unknown as Loose).channels.find((row: Loose) => row.channel_id === w.x.account.id);
  assert.deepEqual([channel.can_schedule, channel.pause], [true, { scope: 'channel', reason: 'Owner on holiday', at: NOW }]);
  // (b) The Agent moves the paused direct post by a day: blocked, not a direct post that waits for the owner.
  const moved = await updatePost(w.ctx, x.post_id, { action: 'reschedule', when: '2026-11-26 15:00' });
  assert.deepEqual([moved.approval_retained, moved.post.status, moved.post.approval, moved.post.approval_deadline_local], [false, 'blocked', 'not_submitted', null]);
  await ownerRun(w, 'publishing_release_pause', paused.pause_id, {});
  for (const id of [x.post_id, fresh.post_id]) {
    const post = agentPost(w.ctx, w.ctx.get('publish_target', id));
    assert.deepEqual([post.status, post.approval, post.blockers], ['scheduled', 'approved_by_channel_policy', []], id);
  }
});

test('MCP-1/E35: a post scheduled while its machine is paused is submitted when the owner resumes the machine', async t => {
  const w = world();
  t.after(w.restore);
  await pausePublishing(w.ctx, { scope: 'machine', id: w.tiktok.device.id, reason: 'Win-C is being repaired' });
  const [tiktok] = (await schedule(w, { channel_ids: [w.tiktok.account.id] })).posts;
  assert.deepEqual([tiktok.status, tiktok.blockers.map(item => item.code)], ['blocked', ['machine_paused']]);
  await ownerRun(w, 'hub_machines_resume', w.tiktok.device.id, {});
  const after = agentPost(w.ctx, w.ctx.get('publish_target', tiktok.post_id));
  assert.deepEqual([after.status, after.approval, after.approval_deadline_local, after.blockers], ['awaiting_approval', 'awaiting_owner', '2026-11-25 09:30', []]);
});

test('F5: a replayed post_schedule reports each post as it is now; when every post was cancelled the same call schedules anew', async t => {
  const w = world();
  t.after(w.restore);
  const first = await schedule(w, { channel_ids: [w.x.account.id] });
  await updatePost(w.ctx, first.posts[0]!.post_id, { action: 'cancel', reason: 'owner changed plans' });
  const again = await schedule(w, { channel_ids: [w.x.account.id] });
  assert.equal(again.replayed, false, 'the cancelled post is not reported as scheduled');
  assert.notEqual(again.posts[0]!.post_id, first.posts[0]!.post_id);
  assert.deepEqual([again.posts[0]!.status, w.ctx.list('publish_target').length], ['scheduled', 2]);
  // A replay of a post that is still live returns it, never a second one, with its current state.
  const replay = await schedule(w, { channel_ids: [w.x.account.id] });
  assert.deepEqual([replay.replayed, replay.posts[0]!.post_id, w.ctx.list('publish_target').length], [true, again.posts[0]!.post_id, 2]);
  // Mixed: one post blocked at scheduling and then unblocked, one cancelled → each reported as it is now, nothing new.
  w.ctx.update(CHANNEL_SETTINGS, w.tiktok.settings.id, { automation_notice_ack: null });
  const both = await schedule(w, { when: '2026-11-25 11:00' });
  assert.deepEqual(both.posts.map(post => post.status), ['scheduled', 'blocked']);
  w.ctx.update(CHANNEL_SETTINGS, w.tiktok.settings.id, { automation_notice_ack: { at: NOW, via: 'web', by: 'owner', version: AUTOMATION_NOTICE_VERSION } });
  await applyUnblock(w.ctx, { type: 'account.automation_notice.acked', payload: { social_account_id: w.tiktok.account.id } });
  await updatePost(w.ctx, both.posts[0]!.post_id, { action: 'cancel' });
  const current = await schedule(w, { when: '2026-11-25 11:00' });
  assert.deepEqual([current.replayed, current.posts.map(post => post.status), current.posts.map(post => post.post_id)],
    [true, ['cancelled', 'awaiting_approval'], both.posts.map(post => post.post_id)]);
  assert.ok(current.posts[0]!.warnings.some(warning => warning.code === 'caption_empty'), 'warnings of the scheduling call are kept');
  assert.equal(w.ctx.list('publish_target').length, 4);
});

test('F9/E39: post_update reschedule without timezone reads the time in the workspace zone, as its schema says', async t => {
  const w = world();
  t.after(w.restore);
  const [x] = (await schedule(w, { channel_ids: [w.x.account.id], when: '2027-01-05 09:00', timezone: 'America/New_York' })).posts;
  assert.equal(x.local_time, '2027-01-05 09:00 America/New_York');
  const moved = await updatePost(w.ctx, x.post_id, { action: 'reschedule', when: '2027-01-06 10:00' });
  assert.deepEqual([moved.post.scheduled_at, moved.post.local_time], ['2027-01-06T02:00:00.000Z', '2027-01-06 10:00 Asia/Shanghai']);
});

test('F12/E44: an oversized video for a standard X account is blocked at post_schedule, with the reason the owner can act on', async t => {
  const w = world();
  t.after(w.restore);
  const long = w.media('video');
  w.ctx.update('asset_version', long.current_version_id as string, { meta: { duration_ms: 900_000, width: 1080, height: 1920 } });
  const [x, tiktok] = (await schedule(w, { media_ids: [long.id] })).posts;
  assert.deepEqual([x.status, x.approval, x.blockers.map(item => item.code)], ['blocked', 'not_submitted', ['media_spec']]);
  assert.match(x.blockers[0]!.message, /超過 X 非 Premium 帳號的 2 分 20 秒上限/);
  assert.equal(tiktok.status, 'awaiting_approval', '15 minutes fits TikTok web upload');
  // Without a probed length the post is scheduled with the E3 risk.
  const [unknown] = (await schedule(w, { channel_ids: [w.x.account.id], when: '2026-11-25 12:00' })).posts;
  assert.equal(unknown.status, 'scheduled');
  assert.ok(unknown.warnings.some(warning => warning.code === 'media_spec' && warning.message.startsWith('未取得影片長度與尺寸')), JSON.stringify(unknown.warnings));
});
