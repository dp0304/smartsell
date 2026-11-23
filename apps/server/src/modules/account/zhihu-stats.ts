import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { fail, integer, iso, matches, object, one, time } from './input.ts';

type ZhihuStatsResult = { status: 'completed'; profile_slug: string; followers_text: string; upvotes_text: string }
  | { status: 'completed' }
  | { status: 'blocked'; reason: 'identity_mismatch' | 'unavailable' | 'login_required' };
type ZhihuStatsClaim = {
  id: string;
  workspace_id: string;
  device_id: string;
  fencing_token: number;
  lease_expires_at: string;
} & ({ profile_slug: string } | { mode: 'login_check' });

const kind = 'zhihu_stats_task';
const leaseMs = 10 * 60_000;
const slugPattern = /^[A-Za-z0-9_-]{1,100}$/;
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const count = '[0-9０-９](?:[0-9０-９,.，．\\s]*[0-9０-９])?\\s*[万萬亿億千]?';
const followersPattern = new RegExp(`^\\s*${count}\\s*$`);
const upvotesPattern = new RegExp(`^\\s*(?:${count}|(?:获得|獲得)\\s*${count}\\s*次[赞贊]同)\\s*$`);

// Only bounded visible count text crosses the device boundary, with display spacing intact.
function countText(value: unknown, pattern: RegExp) {
  if (typeof value !== 'string' || value.length > 128 || !pattern.test(value)) fail('INVALID_INPUT', 422);
  return value;
}

function exactFields(body: Data, fields: readonly string[]) {
  if (Object.keys(body).length !== fields.length || !fields.every(field => Object.hasOwn(body, field))) fail('INVALID_INPUT', 422);
}

function parseResult(value: unknown, row: Row): ZhihuStatsResult {
  const result = object(value);
  const status = one(result.status, ['completed', 'blocked'] as const);
  const loginCheck = row.mode === 'login_check';
  if (status === 'blocked') {
    exactFields(result, ['status', 'reason']);
    const reasons = ['login_required', 'unavailable'] as const;
    return { status, reason: one(result.reason, loginCheck ? reasons : [...reasons, 'identity_mismatch']) };
  }
  if (loginCheck) {
    exactFields(result, ['status']);
    return { status };
  }
  exactFields(result, ['status', 'profile_slug', 'followers_text', 'upvotes_text']);
  const profile_slug = matches(result.profile_slug, slugPattern, 100);
  const followers_text = countText(result.followers_text, followersPattern);
  const upvotes_text = countText(result.upvotes_text, upvotesPattern);
  if (profile_slug !== row.profile_slug) fail('ZHIHU_STATS_IDENTITY_MISMATCH', 422);
  return { status, profile_slug, followers_text, upvotes_text };
}

function liveLease(ctx: Context, row: Row) {
  return Date.parse(String(row.lease_expires_at)) > time(ctx);
}

function requireDeviceOwner(ctx: Context, device: Row) {
  const { isActiveWorkspaceMember } = ctx as Context & { isActiveWorkspaceMember?(id: string): boolean };
  if (typeof device.owner_id !== 'string' || isActiveWorkspaceMember?.(device.owner_id) === false) fail('DEVICE_INACTIVE', 401);
}

function taskMode(row: Row): { mode: 'login_check' } | { profile_slug: string } {
  return row.mode === 'login_check' ? { mode: 'login_check' } : { profile_slug: String(row.profile_slug) };
}

function taskView(ctx: Context, row: Row) {
  const status = row.status === 'claimed' && !liveLease(ctx, row) ? 'expired' : row.status;
  return {
    id: row.id, workspace_id: ctx.workspaceId, device_id: row.device_id, ...taskMode(row), status,
    ...(row.lease_expires_at !== undefined && { lease_expires_at: row.lease_expires_at }),
    ...(row.result !== undefined && { result: row.result }),
    ...(row.reported_at !== undefined && { reported_at: row.reported_at }),
  };
}

const loginIncidentResult = { status: 'blocked', reason: 'login_required' } as const;

export const zhihuStatsOperations: readonly (Operation & { mcp?: boolean })[] = [
  {
    method: 'POST', path: '/zhihu-stats', name: 'zhihu_stats_create', roles: WRITE, accepted: true,
    summary: 'Queue read-only Zhihu profile stats or a login check for a paired Worker you own',
    contract: { bodyRequired: true, body: {
      type: 'object', additionalProperties: false, required: ['device_id'], properties: {
        device_id: { type: 'string', format: 'uuid' },
        profile_slug: { type: 'string', pattern: slugPattern.source, description: 'Public slug of your own Zhihu profile' },
        mode: { type: 'string', const: 'login_check', description: 'Check login without collecting stats or providing a profile slug' },
      },
      oneOf: [
        { required: ['profile_slug'], not: { required: ['mode'] } },
        { required: ['mode'], not: { required: ['profile_slug'] } },
      ],
    } },
    run(ctx, { body }) {
      const loginCheck = body.mode === 'login_check';
      exactFields(body, loginCheck ? ['device_id', 'mode'] : ['device_id', 'profile_slug']);
      const deviceId = matches(body.device_id, idPattern, 36);
      const task = loginCheck ? { mode: 'login_check' } : { profile_slug: matches(body.profile_slug, slugPattern, 100) };
      const device = ctx.get('connector_device', deviceId);
      if (device.owner_id !== ctx.actorId) fail('DEVICE_NOT_FOUND', 404);
      if (device.status !== 'active') fail('DEVICE_INACTIVE');
      return taskView(ctx, ctx.create(kind, {
        device_id: device.id, ...task, owner_id: ctx.actorId, status: 'queued',
      }));
    },
  },
  {
    method: 'GET', path: '/zhihu-stats/incidents', name: 'zhihu_stats_incidents_list', roles: READ.filter(role => role !== 'agent'), mcp: false,
    summary: 'List your Worker’s Zhihu login-required incidents in this workspace',
    run(ctx) {
      return ctx.list(kind)
        .filter(row => row.owner_id === ctx.actorId && row.status === 'blocked' && typeof row.reported_at === 'string' &&
          isDeepStrictEqual(row.result, loginIncidentResult))
        .sort((a, b) => String(b.reported_at).localeCompare(String(a.reported_at)) || a.id.localeCompare(b.id))
        .map(row => ({
          id: row.id, workspace_id: ctx.workspaceId, device_id: row.device_id,
          ...(row.mode === 'login_check' && { mode: row.mode }),
          status: 'blocked', result: loginIncidentResult, reported_at: row.reported_at,
        }));
    },
  },
  {
    method: 'GET', path: '/zhihu-stats/:id', name: 'zhihu_stats_get', roles: READ,
    summary: 'Read the status and visible counts from your Zhihu profile stats task',
    run(ctx, { params }) {
      const row = ctx.get(kind, matches(params.id, idPattern, 36));
      if (row.owner_id !== ctx.actorId) fail('ZHIHU_STATS_TASK_NOT_FOUND', 404);
      return taskView(ctx, row);
    },
  },
];

export function hasLiveZhihuStatsClaim(ctx: Context, deviceId: string) {
  return ctx.list(kind).some(row => row.device_id === deviceId && row.status === 'claimed' && liveLease(ctx, row));
}

export function claimZhihuStats(ctx: Context, device: Row, body: Data, publishingBusy: boolean): { claim: ZhihuStatsClaim | null } {
  exactFields(body, []);
  requireDeviceOwner(ctx, device);
  if (publishingBusy || hasLiveZhihuStatsClaim(ctx, device.id)) return { claim: null };
  const tasks = ctx.list(kind).filter(row => row.device_id === device.id && row.owner_id === device.owner_id);
  const next = tasks.filter(row => row.status === 'queued')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
  if (!next) return { claim: null };
  const fencing_token = randomInt(1, 2 ** 48 - 1);
  const lease_expires_at = iso(time(ctx) + leaseMs);
  ctx.update(kind, next.id, { status: 'claimed', fencing_token, lease_expires_at });
  return { claim: {
    id: next.id, workspace_id: ctx.workspaceId, device_id: device.id, ...taskMode(next), fencing_token, lease_expires_at,
  } };
}

export function reportZhihuStats(ctx: Context, device: Row, body: Data): { id: string; status: ZhihuStatsResult['status'] } {
  exactFields(body, ['id', 'fencing_token', 'result']);
  requireDeviceOwner(ctx, device);
  const row = ctx.get(kind, matches(body.id, idPattern, 36));
  if (row.device_id !== device.id || row.owner_id !== device.owner_id) fail('DEVICE_SCOPE_MISMATCH', 403);
  const fence = integer(body.fencing_token, 1, Number.MAX_SAFE_INTEGER);
  if (row.fencing_token !== fence) fail('ZHIHU_STATS_FENCE_MISMATCH');
  const result = parseResult(body.result, row);
  if (row.status === 'completed' || row.status === 'blocked') {
    if (!isDeepStrictEqual(row.result, result)) fail('ZHIHU_STATS_RESULT_CONFLICT');
    return { id: row.id, status: result.status };
  }
  if (row.status !== 'claimed' || !liveLease(ctx, row)) fail('ZHIHU_STATS_LEASE_EXPIRED');
  ctx.update(kind, row.id, { status: result.status, result, reported_at: ctx.now });
  return { id: row.id, status: result.status };
}
