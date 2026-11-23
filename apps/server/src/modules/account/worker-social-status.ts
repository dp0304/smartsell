import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  Problem, READ, WRITE, workerSocialChannelStatuses, workerSocialPlatforms, workerSocialStatusLimits,
  workerSocialStatusModes, workerSocialStatusVersion, type Context, type Data, type Operation, type Row,
  type WorkerSocialChannel, type WorkerSocialPlatform, type WorkerSocialPost, type WorkerSocialStatusClaim,
  type WorkerSocialStatusReceipt, type WorkerSocialStatusResult, type WorkerSocialStatusTarget,
} from '@smartsell/contracts';
import { online } from './device-control.js';
import { fail, integer, iso, matches, object, one, text, time } from './input.js';

const kind = 'worker_social_status_task';
export const workerSocialStatusToolNames = new Set(['worker_social_status_request', 'worker_social_status_get']);
export const workerSocialStatusAuditKind = 'worker_social_status_audit';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const handle = /^@?[a-z0-9_]{1,15}$/i;
const postId = /^[1-9][0-9]{0,19}$/;
const queueMs = 10 * 60_000;
const leaseMs = 2 * 60_000;

function fields(value: unknown, allowed: readonly string[]) {
  const row = object(value);
  if (Object.keys(row).some(key => !allowed.includes(key))) fail('INVALID_INPUT', 422);
  return row;
}

function normalizeIdentity(platform: WorkerSocialPlatform, value: string) {
  if (platform === 'x' || platform === 'reddit') return value.replace(/^[@]/, '').toLowerCase();
  return value;
}

function identityValue(platform: WorkerSocialPlatform, value: unknown) {
  const limit = workerSocialStatusLimits.identity;
  const identity = platform === 'x' ? matches(value, handle, 16) : matches(value, /^[\p{L}\p{N}@_.-]+$/u, limit);
  return normalizeIdentity(platform, identity);
}

function providerPlatform(value: unknown) {
  if (value === 'twitter') return 'x';
  if (value === 'meta_facebook') return 'facebook';
  if (value === 'meta_instagram') return 'instagram';
  if (value === 'xiaohongshu') return 'xhs';
  return workerSocialPlatforms.find(platform => platform === value);
}

function accountBindings(ctx: Context) {
  const bindings = ctx.list('account_execution_binding');
  return ctx.list('social_account').flatMap(account => {
    const platform = providerPlatform(account.provider);
    return platform && typeof account.external_account_id === 'string' ? [{
      platform, identity: normalizeIdentity(platform, account.external_account_id), account,
      bindings: bindings.filter(binding => binding.social_account_id === account.id),
    }] : [];
  });
}

type AccountBindings = ReturnType<typeof accountBindings>;

function deviceTargets(accounts: AccountBindings, device: Row, platform: WorkerSocialPlatform) {
  return accounts.filter(entry => entry.platform === platform && entry.bindings.some(binding => binding.device_id === device.id));
}

function ownTarget(entry: AccountBindings[number], device: Row) {
  return entry.account.owner_id === device.owner_id && entry.account.status === 'active' &&
    entry.bindings.every(binding => binding.device_id === device.id) &&
    entry.bindings.some(binding => binding.connector_channel === 'browser' && ['connector', 'hybrid'].includes(String(binding.mode)));
}

function identityAllowed(accounts: AccountBindings, device: Row, platform: WorkerSocialPlatform, identity: string) {
  const targets = deviceTargets(accounts, device, platform);
  return (!targets.length || targets.some(entry => entry.identity === identity && ownTarget(entry, device))) &&
    accounts.filter(entry => entry.platform === platform && entry.identity === identity).every(entry =>
      entry.account.owner_id === device.owner_id && entry.account.status === 'active' && (!entry.bindings.length || ownTarget(entry, device)));
}

function scopedTarget(target: WorkerSocialStatusTarget, accounts: AccountBindings, device: Row): WorkerSocialStatusTarget {
  const { platform, expected_identity } = target;
  if (!platform) return target;
  const targets = deviceTargets(accounts, device, platform);
  const own = targets.filter(entry => ownTarget(entry, device));
  if (expected_identity !== undefined ? !identityAllowed(accounts, device, platform, expected_identity) : targets.length > 0 && !own.length) {
    throw new Problem(409, 'SOCIAL_STATUS_IDENTITY_SCOPE', 'The requested account is outside this Worker’s own account bindings');
  }
  if (expected_identity === undefined && own.length > 1) {
    throw new Problem(409, 'SOCIAL_STATUS_IDENTITY_AMBIGUOUS', 'This Worker has multiple accounts for this platform. Specify expected_identity.');
  }
  return expected_identity === undefined && own.length === 1
    ? { ...target, expected_identity: identityValue(platform, own[0]!.identity) } : target;
}

function selectDevice(ctx: Context, deviceId: string | undefined) {
  const owned = ctx.list('connector_device').filter(device => device.owner_id === ctx.actorId && (!deviceId || device.id === deviceId));
  if (!owned.length) {
    if (deviceId) throw new Problem(404, 'SOCIAL_STATUS_WORKER_NOT_FOUND', 'No Worker with this device_id is paired to you in this workspace');
    throw new Problem(409, 'SOCIAL_STATUS_WORKER_UNPAIRED', 'Pair a Worker you own with this workspace first');
  }
  const active = owned.filter(device => device.status === 'active');
  if (!active.length) throw new Problem(409, 'SOCIAL_STATUS_WORKER_INACTIVE', 'The paired Worker is inactive. Pair an active Worker.');
  const connected = active.filter(device => online(ctx, device));
  if (!connected.length) throw new Problem(409, 'SOCIAL_STATUS_WORKER_OFFLINE', 'No selected Worker is online. Open Worker and wait for a heartbeat.');
  const eligible = connected.filter(device => device.social_status_version === workerSocialStatusVersion);
  if (!eligible.length) throw new Problem(409, 'SOCIAL_STATUS_WORKER_UNSUPPORTED', 'The online Worker does not support social status. Update Worker and wait for its next heartbeat.');
  if (eligible.length > 1) throw new Problem(409, 'SOCIAL_STATUS_WORKER_AMBIGUOUS', 'More than one of your Workers is online and supports social status. Specify device_id.', {
    devices: eligible.map(({ id, name }) => ({ id, name })),
  });
  return eligible[0]!;
}

function targetFor(row: Row): WorkerSocialStatusTarget {
  const { mode, platform, expected_identity } = row as Row & WorkerSocialStatusTarget;
  return { mode, ...(platform !== undefined && { platform }), ...(expected_identity !== undefined && { expected_identity }) };
}

function statusAt(ctx: Context, row: Row) {
  const expires = row.status === 'queued' ? row.queue_expires_at : row.status === 'claimed' ? row.lease_expires_at : undefined;
  return typeof expires === 'string' && Date.parse(expires) <= time(ctx) ? 'expired' : row.status;
}

const taskOutput = { type: 'object', required: ['id', 'workspace_id', 'device_id', 'mode', 'status'], properties: {
  id: { type: 'string', format: 'uuid' }, workspace_id: { type: 'string', format: 'uuid' }, device_id: { type: 'string', format: 'uuid' },
  mode: { type: 'string', enum: workerSocialStatusModes }, platform: { type: 'string', enum: workerSocialPlatforms },
  expected_identity: { type: 'string' }, status: { enum: ['queued', 'claimed', 'completed', 'blocked', 'expired'] },
  lease_expires_at: { type: 'string', format: 'date-time' }, reported_at: { type: 'string', format: 'date-time' },
  result: { type: 'object', required: ['channels'], properties: { channels: { type: 'array', items: {
    type: 'object', required: ['platform', 'status'], properties: {
      platform: { type: 'string', enum: workerSocialPlatforms }, status: { type: 'string', enum: workerSocialChannelStatuses },
      identity: { type: 'string' }, posts: { type: 'array', items: {
        type: 'object', required: ['id', 'url', 'text', 'has_video'], properties: {
          id: { type: 'string' }, url: { type: 'string' }, text: { type: 'string' }, has_video: { type: 'boolean' },
        },
      } },
    },
  } } } },
} };

function taskView(ctx: Context, row: Row) {
  return {
    id: row.id, workspace_id: ctx.workspaceId, device_id: row.device_id, ...targetFor(row), status: statusAt(ctx, row),
    ...(row.lease_expires_at !== undefined && { lease_expires_at: row.lease_expires_at }),
    ...(row.result !== undefined && { result: row.result, reported_at: row.reported_at }),
  };
}

export const workerSocialStatusOperations: Operation[] = [
  {
    method: 'POST', path: '/worker-social-status', name: 'worker_social_status_request', roles: WRITE,
    accepted: true, idempotencyRequired: true,
    summary: 'Request live social login status from your own paired Worker, or recent posts and video indicators from your own X (Twitter) profile',
    contract: { output: taskOutput, body: { type: 'object', additionalProperties: false, properties: {
      mode: { type: 'string', enum: workerSocialStatusModes, default: 'account_status' },
      platform: { type: 'string', enum: workerSocialPlatforms, description: 'Recent posts support X only and default to X.' },
      device_id: { type: 'string', format: 'uuid', description: 'Omit when exactly one of your paired Workers is eligible.' },
      expected_identity: { type: 'string', maxLength: workerSocialStatusLimits.identity, description: 'Your own expected account identity. For X use the handle. When platform is omitted, a unique matching Worker account binding is required.' },
    } } },
    run(ctx, { body, query }) {
      fields(body, ['mode', 'platform', 'device_id', 'expected_identity']);
      fields(query, []);
      const mode = body.mode === undefined ? 'account_status' : one(body.mode, workerSocialStatusModes);
      let platform = body.platform === undefined ? undefined : one(body.platform, workerSocialPlatforms);
      if (mode === 'recent_posts') {
        if (platform && platform !== 'x') throw new Problem(422, 'INVALID_INPUT', 'recent_posts supports only the x platform');
        platform = 'x';
      }
      const device = selectDevice(ctx, body.device_id === undefined ? undefined : matches(body.device_id, uuid, 36));
      const accounts = accountBindings(ctx);
      if (body.expected_identity !== undefined && !platform) {
        const expected = text(body.expected_identity, workerSocialStatusLimits.identity);
        const platforms = new Set(accounts.filter(entry => ownTarget(entry, device) && entry.identity === normalizeIdentity(entry.platform, expected)).map(entry => entry.platform));
        if (platforms.size !== 1) throw new Problem(422, 'INVALID_INPUT', 'Specify platform with expected_identity unless it matches a unique Worker platform binding');
        platform = [...platforms][0]!;
      }
      const target = scopedTarget({ mode, ...(platform && { platform }),
        ...(platform && body.expected_identity !== undefined && { expected_identity: identityValue(platform, body.expected_identity) }),
      }, accounts, device);
      return taskView(ctx, ctx.create(kind, { ...target, device_id: device.id, owner_id: ctx.actorId,
        status: 'queued', queue_expires_at: iso(time(ctx) + queueMs) }));
    },
  },
  {
    method: 'GET', path: '/worker-social-status/:id', name: 'worker_social_status_get', roles: READ,
    summary: 'Get the actual status and signed Worker result for your social status task by ID',
    contract: { output: taskOutput },
    run(ctx, { params, body, query, idempotencyKey }) {
      fields(body, []);
      fields(query, []);
      if (idempotencyKey !== undefined) throw new Problem(422, 'INVALID_INPUT', 'idempotency_key is for requesting a task');
      const row = ctx.get(kind, matches(params.id, uuid, 36));
      if (row.owner_id !== ctx.actorId) throw new Problem(404, 'NOT_FOUND', 'Social status task not found');
      return taskView(ctx, row);
    },
  },
];

export function hasLiveWorkerSocialStatusClaim(ctx: Context, deviceId: string) {
  return ctx.list(kind).some(row => row.device_id === deviceId && statusAt(ctx, row) === 'claimed');
}

function requireDeviceOwner(ctx: Context, device: Row) {
  const { isActiveWorkspaceMember } = ctx as Context & { isActiveWorkspaceMember?(id: string): boolean };
  if (typeof device.owner_id !== 'string' || isActiveWorkspaceMember?.(device.owner_id) === false) fail('DEVICE_INACTIVE', 401);
}

export function claimWorkerSocialStatus(ctx: Context, device: Row, body: Data, busy: boolean): { claim: WorkerSocialStatusClaim | null } {
  fields(body, []);
  requireDeviceOwner(ctx, device);
  if (device.social_status_version !== workerSocialStatusVersion) fail('SOCIAL_STATUS_WORKER_UNSUPPORTED');
  if (busy || !online(ctx, device) || hasLiveWorkerSocialStatusClaim(ctx, device.id)) return { claim: null };
  const next = ctx.list(kind).filter(row => row.device_id === device.id && row.owner_id === device.owner_id && statusAt(ctx, row) === 'queued')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
  if (!next) return { claim: null };
  const accounts = accountBindings(ctx);
  const target = scopedTarget(targetFor(next), accounts, device);
  const boundIdentities = Object.fromEntries(workerSocialPlatforms.flatMap(platform => {
    const entries = deviceTargets(accounts, device, platform);
    return entries.length ? [[platform, entries.filter(entry => ownTarget(entry, device)).map(entry => entry.identity)]] : [];
  }));
  const fencing_token = randomInt(1, 2 ** 48 - 1);
  const lease_expires_at = iso(time(ctx) + leaseMs);
  ctx.update(kind, next.id, { ...target, status: 'claimed', fencing_token, lease_expires_at, bound_identities: boundIdentities });
  return { claim: { id: next.id, workspace_id: ctx.workspaceId, device_id: device.id, ...target, fencing_token, lease_expires_at } };
}

function readPosts(value: unknown, identity: string): WorkerSocialPost[] {
  if (!Array.isArray(value) || value.length > workerSocialStatusLimits.posts) fail('INVALID_INPUT', 422);
  const seen = new Set<string>();
  return value.map(item => {
    const post = fields(item, ['id', 'url', 'text', 'has_video']);
    const id = matches(post.id, postId, 20);
    const url = `https://x.com/${identity}/status/${id}`;
    if (post.url !== url || seen.has(id) ||
        typeof post.has_video !== 'boolean' || typeof post.text !== 'string' || post.text.length > workerSocialStatusLimits.text ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(post.text)) fail('INVALID_SOCIAL_STATUS_POST', 422);
    seen.add(id);
    return { id, url, text: post.text, has_video: post.has_video };
  });
}

function parseResult(raw: unknown, row: Row): WorkerSocialStatusResult {
  const result = fields(raw, ['channels']);
  const { platform: target, mode, expected_identity } = targetFor(row);
  if (!Array.isArray(result.channels) || result.channels.length !== (target ? 1 : workerSocialPlatforms.length)) fail('INVALID_INPUT', 422);
  const seen = new Set<WorkerSocialPlatform>();
  const channels = result.channels.map((value): WorkerSocialChannel => {
    const channel = fields(value, ['platform', 'status', 'identity', 'posts']);
    const platform = one(channel.platform, workerSocialPlatforms);
    if ((target && target !== platform) || seen.has(platform)) fail('SOCIAL_STATUS_CHANNEL_SCOPE', 422);
    seen.add(platform);
    const status = one(channel.status, workerSocialChannelStatuses);
    if (status !== 'verified') {
      if (channel.identity !== undefined || channel.posts !== undefined) fail('INVALID_INPUT', 422);
      return { platform, status };
    }
    const identity = identityValue(platform, channel.identity);
    if (expected_identity !== undefined && identity !== expected_identity) fail('SOCIAL_STATUS_IDENTITY_MISMATCH', 422);
    if (mode === 'recent_posts') return { platform, status, identity, posts: readPosts(channel.posts, identity) };
    if (channel.posts !== undefined) fail('INVALID_SOCIAL_STATUS_POST', 422);
    return { platform, status, identity };
  });
  return { channels };
}

export function reportWorkerSocialStatus(ctx: Context, device: Row, body: Data, requestId?: string): WorkerSocialStatusReceipt {
  fields(body, ['id', 'fencing_token', 'result']);
  requireDeviceOwner(ctx, device);
  const row = ctx.get(kind, matches(body.id, uuid, 36));
  if (row.device_id !== device.id || row.owner_id !== device.owner_id) fail('DEVICE_SCOPE_MISMATCH', 403);
  if (row.fencing_token !== integer(body.fencing_token, 1, Number.MAX_SAFE_INTEGER)) fail('SOCIAL_STATUS_FENCE_MISMATCH');
  const result = parseResult(body.result, row);
  const status = result.channels.every(channel => channel.status === 'verified') ? 'completed' : 'blocked';
  if (row.status === 'completed' || row.status === 'blocked') {
    if (!isDeepStrictEqual(row.result, result)) fail('SOCIAL_STATUS_RESULT_CONFLICT');
    return { id: row.id, status };
  }
  if (statusAt(ctx, row) !== 'claimed') fail('SOCIAL_STATUS_LEASE_EXPIRED');
  const accounts = accountBindings(ctx);
  const bound = row.bound_identities as Partial<Record<WorkerSocialPlatform, string[]>>;
  for (const { platform, status, identity } of result.channels) {
    if (status !== 'verified') continue;
    const allowed = bound[platform];
    if ((allowed && !allowed.includes(identity!)) || !identityAllowed(accounts, device, platform, identity!)) fail('SOCIAL_STATUS_IDENTITY_SCOPE', 422);
  }
  ctx.update(kind, row.id, { status, result, reported_at: ctx.now });
  if (requestId) ctx.create(workerSocialStatusAuditKind, { data: {
    request_id: requestId, actor_id: row.owner_id, tool: 'worker_social_status_report', target: 'POST /api/v1/device/social-status/report',
    outcome: 'success', task_id: row.id, device_id: device.id, status,
  } });
  ctx.emit('account.worker_social_status.reported', { task_id: row.id, device_id: device.id, status });
  return { id: row.id, status };
}
