import { workerSocialStatusVersion, type Context, type Data, type Row } from '@smartsell/contracts';
import { claimWorkerSocialStatus, hasLiveWorkerSocialStatusClaim, reportWorkerSocialStatus } from './worker-social-status.js';
import { parseConnectorTask, type ConnectorTask } from '../../../../../packages/connector-tasks/src/tasks.ts';
import { PUBLISH_ASSIST_WAIT_SECONDS, PUBLISH_RESULT_REPORT_SECONDS } from '../../../../../packages/connector-tasks/src/index.ts';
import { evaluatePermit, policy } from './auto-control.ts';
import { authenticateDevice, blocked, connectorReady, online, openBlock, pendingBrowserIdentity, reportIdentity, reportPhone, sessionFor, type SignedDeviceRequest } from './device-control.ts';
import type { Services } from './index.ts';
import { claimWorkerCatalog, hasLiveWorkerCatalogClaim, uploadWorkerCatalog, WorkerCatalogRequestError, workerCatalogBindingCounts, workerCatalogUploadBodyLimit } from '../commerce/worker-catalog.js';
import { audit, fail, find, integer, iso, matches, object, one, sha256Pattern, text, time } from './input.ts';
import { claimZhihuStats, hasLiveZhihuStatsClaim, reportZhihuStats } from './zhihu-stats.ts';
import { registerWorkerChannels } from './channel-registration.js';
import { ownedSocialProviders } from './social-accounts.js';
import { claimJobs, goJob, heartbeatV2, reportJob } from '../worker/device-jobs.js';
import { verifyStoredEvidence } from '../worker/media.js';
import { notePresenceRowWrite, recordHeartbeatPresence } from '../worker/presence.js';

export interface ConnectorServices extends Services {
  iosEnabled?: boolean;
  /** EX/PL supply the frozen authorization and live fencing/slot ownership in this transaction. */
  authorizeTask: (ctx: Context, task: ConnectorTask, fence: number, writeSlot: number) => boolean;
  /** Evidence object must exist in the workspace and match its checksum/type. */
  verifyEvidence?: (ctx: Context, evidence: Data) => boolean;
}

type Slot = { fencing_token: number; write_slot_token: number; lease_expires_at: string; latest_submit_at?: string };
const taskFor = (ctx: Context, attemptId: string) => find(ctx, 'connector_task', { attempt_id: attemptId }) ?? fail('CONNECTOR_TASK_NOT_FOUND', 404);
const rowTask = (row: Row) => parseConnectorTask(row.task);
const isPublish = (task: ConnectorTask) => task.kind.endsWith('.publish');
const expires = (row: Row) => Date.parse(String(row.lease_expires_at));
const blockResults = ['pairing_required', 'binding_invalid', 'host_unsupported', 'mobile_unavailable', 'device_compat_blocked',
  'identity_mismatch', 'login_expired', 'captcha', 'risk_control', 'app_prompt', 'draft_ambiguous', 'media_unverified',
  'approval_invalid', 'unsupported', 'lease_expired', 'permit_unavailable', 'late_or_stale', 'assist_submit_timeout',
  'assist_closed', 'result_not_found', 'consent_required', 'platform_restriction', 'app_dialog', 'mobile_offline', 'setup_invalid'] as const;
const identityFresh = (ctx: Context, row: Row) => {
  const checked = Date.parse(String(row.identity_checked_at));
  return checked <= time(ctx) && checked > time(ctx) - 60_000;
};

const resultHosts = {
  instagram: ['instagram.com', 'www.instagram.com'], facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch'],
  douyin: ['douyin.com', 'www.douyin.com', 'v.douyin.com'], xhs: ['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
};

function resultUrl(value: unknown, app: ConnectorTask['target']['app']) {
  if (value == null) return undefined;
  const input = text(value, 2048);
  const url = URL.parse(input);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || !resultHosts[app].includes(url.hostname)) fail('CONNECTOR_RESULT_URL_INVALID', 422);
  const publicQuery = new URLSearchParams();
  if (app === 'facebook') for (const field of ['id', 'story_fbid', 'v']) {
    const id = url.searchParams.get(field);
    if (id && /^\d{1,32}$/.test(id)) publicQuery.set(field, id);
  }
  url.search = publicQuery.toString();
  url.hash = '';
  return url.href;
}

export function drainConnectorTasks(ctx: Context, match: (row: Row) => boolean, migration = false) {
  if (!migration) expireConnectorTasks(ctx);
  for (const row of ctx.list('connector_task').filter(match)) {
    if (row.status !== 'queued') continue;
    ctx.update('connector_task', row.id, { status: 'abandoned', ...(migration && { abandoned_for_migration: true }) });
    ctx.emit('account.connector_task.abandoned', { attempt_id: row.attempt_id });
  }
}

function target(ctx: Context, task: ConnectorTask) {
  const binding = ctx.get('account_execution_binding', task.binding_id);
  const account = ctx.get('social_account', task.account_id);
  const providers = { instagram: 'meta_instagram', facebook: 'meta_facebook', douyin: 'douyin', xhs: 'xiaohongshu', tiktok: 'tiktok' };
  if (task.workspace_id !== ctx.workspaceId || binding.device_id !== task.connector_device_id || binding.social_account_id !== account.id ||
    account.external_account_id !== task.platform_identity || account.provider !== providers[task.target.app] || binding.connector_channel !== task.target.channel ||
    (task.target.channel === 'browser' ? task.target.profile_id !== sessionFor(ctx, binding)?.id :
      task.target.mobile_device_id !== binding.mobile_device_id || task.target.app !== binding.mobile_app)) fail('CONNECTOR_SCOPE_MISMATCH', 403);
  return { account, binding };
}

function authorize(ctx: Context, services: ConnectorServices, task: ConnectorTask, fence: number, slot: number, drainingClaim = false) {
  const { account, binding } = target(ctx, task);
  if (account.status !== 'active' || blocked(ctx, account.id) || !connectorReady(ctx, drainingClaim ? { ...binding, paused: false } : binding) ||
    !services.connectorConfigured?.(ctx, binding.id, 'assist') || !services.authorizeTask(ctx, task, fence, slot)) fail('CONNECTOR_TASK_NOT_AUTHORIZED', 403);
  return { account, binding };
}

/** Trusted EX dispatch only. Workspace operation callers cannot supply a claim or approval. */
export function enqueueConnectorTask(ctx: Context, input: unknown, slot: Slot, services: ConnectorServices) {
  let task: ConnectorTask;
  try { task = parseConnectorTask(input); } catch { return fail('INVALID_CONNECTOR_TASK', 422); }
  const fence = integer(slot.fencing_token, 1, Number.MAX_SAFE_INTEGER);
  const writeSlot = integer(slot.write_slot_token, 1, Number.MAX_SAFE_INTEGER);
  const lease = Date.parse(slot.lease_expires_at);
  const deadline = slot.latest_submit_at == null ? undefined : Date.parse(slot.latest_submit_at);
  const maxLease = (PUBLISH_ASSIST_WAIT_SECONDS + (isPublish(task) ? PUBLISH_RESULT_REPORT_SECONDS : 0)) * 1000;
  if (!(lease > time(ctx) && lease <= time(ctx) + maxLease) || (deadline !== undefined && !Number.isFinite(deadline))) fail('INVALID_CONNECTOR_LEASE', 422);
  authorize(ctx, services, task, fence, writeSlot);
  if (find(ctx, 'connector_task', { attempt_id: task.attempt_id })) fail('CONNECTOR_ATTEMPT_ALREADY_EXISTS');
  const recovery = 'source_attempt_id' in task.payload ? task.payload.source_attempt_id : undefined;
  if (recovery) {
    const source = taskFor(ctx, recovery);
    const original = rowTask(source);
    const cleanup = task.kind === 'mobile.cleanup_media';
    if (!isPublish(original) || source.status !== (cleanup ? 'completed' : 'outcome_unknown') ||
      (cleanup && source.verification_result !== 'verified') || source.social_account_id !== task.account_id ||
      source.device_id !== task.connector_device_id || source.binding_id !== task.binding_id ||
      JSON.stringify(original.target) !== JSON.stringify(task.target)) fail('CONNECTOR_RECOVERY_SCOPE_MISMATCH');
    const knownPostId = source.verified_post_id ?? (source.result as Data | undefined)?.platform_post_id;
    if (knownPostId && 'platform_post_id' in task.payload && task.payload.platform_post_id !== knownPostId) fail('CONNECTOR_RECOVERY_SCOPE_MISMATCH');
    if (task.kind === 'mobile.cleanup_media') {
      const sourceMedia = 'revision' in original.payload ? original.payload.revision.media : [];
      if (!knownPostId || task.payload.media.some(item => !sourceMedia.some(asset => asset.id === item.id && asset.sha256 === item.sha256))) {
        fail('CONNECTOR_RECOVERY_SCOPE_MISMATCH');
      }
    }
  }
  const retired = new Set(ctx.list('binding_migration').filter(row => row.status === 'completed' && row.source_binding_id === task.binding_id)
    .flatMap(row => Array.isArray(row.affected_connector_task_ids) ? row.affected_connector_task_ids : []));
  if (ctx.list('connector_task').some(row => {
    const samePhone = task.target.channel === 'mobile' && row.mobile_device_id === task.target.mobile_device_id;
    const sameAccount = row.social_account_id === task.account_id;
    if (row.status === 'queued' || row.status === 'claimed') return samePhone || sameAccount;
    return row.status === 'outcome_unknown' && row.attempt_id !== recovery &&
      (samePhone || sameAccount && (!retired.has(row.id) || row.device_id === task.connector_device_id && row.mobile_device_id == null && task.target.channel === 'browser'));
  })) fail('CONNECTOR_EXECUTION_BUSY');
  const row = ctx.create('connector_task', {
    task, fencing_token: fence, write_slot_token: writeSlot, lease_expires_at: iso(lease),
    latest_submit_at: deadline === undefined ? null : iso(deadline), attempt_id: task.attempt_id, social_account_id: task.account_id, binding_id: task.binding_id,
    device_id: task.connector_device_id, mobile_device_id: task.target.channel === 'mobile' ? task.target.mobile_device_id : null, status: 'queued',
  });
  ctx.emit('account.connector_task.queued', { attempt_id: task.attempt_id, device_id: task.connector_device_id });
  return { id: row.id };
}

/** Never requeue a lost claim. EX must evaluate its potential platform side effects. */
export function expireConnectorTasks(ctx: Context) {
  for (const row of ctx.list('connector_task')) {
    if (!['queued', 'claimed'].includes(String(row.status)) || expires(row) > time(ctx)) continue;
    const status = row.status === 'claimed' ? 'outcome_unknown' : 'abandoned';
    ctx.update('connector_task', row.id, { status });
    ctx.emit(`account.connector_task.${status}`, { attempt_id: row.attempt_id });
  }
}

function requestAttempt(ctx: Context, device: Row, body: Data, requireSlot = true) {
  const row = taskFor(ctx, text(body.attempt_id));
  if (row.device_id !== device.id || row.fencing_token !== body.fencing_token || ((requireSlot || body.write_slot_token !== undefined) && row.write_slot_token !== body.write_slot_token) || row.status !== 'claimed' || expires(row) <= time(ctx)) fail('CONNECTOR_FENCE_LOST');
  return row;
}

function report(ctx: Context, row: Row, body: Data, services: ConnectorServices) {
  const task = rowTask(row);
  const kind = one(body.kind, ['blocked', 'accepted', 'outcome_unknown', 'result_captured', 'visibility_checked', 'identity_verified', 'media_pushed', 'media_cleaned'] as const);
  const matching = kind === 'blocked' || kind === 'outcome_unknown' || (isPublish(task) && kind === 'accepted') ||
    ({ 'post.capture_result': 'result_captured', 'post.verify_visible': 'visibility_checked', 'session.verify_identity': 'identity_verified',
      'mobile.verify_app_identity': 'identity_verified', 'mobile.push_media': 'media_pushed', 'mobile.cleanup_media': 'media_cleaned' } as Record<string, string>)[task.kind] === kind;
  if (!matching) fail('CONNECTOR_RESULT_MISMATCH', 422);
  const consumed = find(ctx, 'auto_submit_permit', { attempt_id: task.attempt_id, status: 'consumed' });
  const submittedBy = body.submitted_by == null ? undefined : one(body.submitted_by, ['auto', 'human'] as const);
  if ((submittedBy === 'auto' && !consumed) || (consumed && submittedBy === 'human') ||
    (submittedBy && (!isPublish(task) || !['accepted', 'outcome_unknown'].includes(kind))) ||
    (kind === 'accepted' && !submittedBy)) fail('CONNECTOR_SUBMISSION_MISMATCH', 422);
  if (kind === 'accepted' && submittedBy === 'human' && !row.identity_checked_at) fail('FRESH_IDENTITY_CHECK_REQUIRED');
  const outcome: Data = { attempt_id: task.attempt_id, kind, submitted_by: submittedBy };
  if ('source_attempt_id' in task.payload) outcome.source_attempt_id = task.payload.source_attempt_id;
  if (kind === 'accepted' || kind === 'result_captured') {
    const postId = text(body.platform_post_id);
    if ('platform_post_id' in task.payload && task.payload.platform_post_id && task.payload.platform_post_id !== postId) fail('CONNECTOR_RESULT_MISMATCH', 422);
    outcome.platform_post_id = postId;
    outcome.result_url = resultUrl(body.result_url, task.target.app);
    if (!Array.isArray(body.evidence) || !body.evidence.length || body.evidence.length > 8) fail('INVALID_EVIDENCE', 422);
    outcome.evidence = body.evidence.map(value => {
      const item = object(value);
      const evidence = { kind: one(item.kind, ['masked_screenshot', 'masked_ui_hierarchy'] as const), sha256: matches(item.sha256, sha256Pattern), object_id: text(item.object_id) };
      // §8.13 (C11): without a host verifier, check the stored evidence file and its checksum instead of refusing everything.
      if (!(services.verifyEvidence ?? verifyStoredEvidence)(ctx, evidence)) fail('EVIDENCE_UNVERIFIED', 422);
      ctx.create('connector_evidence', { ...evidence, attempt_id: task.attempt_id });
      return evidence;
    });
  }
  if (kind === 'visibility_checked') {
    if (typeof body.visible !== 'boolean') fail('INVALID_RESULT', 422);
    outcome.visible = body.visible;
  }
  if (kind === 'blocked') {
    const reason = one(body.reason, blockResults);
    const equivalent: Record<string, string> = { risk_control: 'platform_restriction', app_prompt: 'app_dialog', mobile_unavailable: 'mobile_offline', device_compat_blocked: 'setup_invalid' };
    const normalized = Object.hasOwn(equivalent, reason) ? equivalent[reason] : reason;
    const binding = ctx.get('account_execution_binding', task.binding_id);
    if (['captcha', 'platform_restriction', 'identity_mismatch', 'login_expired', 'mobile_offline', 'setup_invalid', 'app_dialog'].includes(normalized)) {
      openBlock(ctx, task.account_id, normalized, binding);
      const session = sessionFor(ctx, binding);
      if (session && ['captcha', 'platform_restriction', 'identity_mismatch', 'login_expired'].includes(normalized)) {
        ctx.update(task.target.channel === 'mobile' ? 'mobile_app_binding' : 'browser_session', session.id, { status: 'pending_identity', verified_at: null });
      }
    }
    outcome.reason = normalized;
    outcome.handoff = task.kind === 'tiktok.app.publish' ? 'awaiting_creator_action' : 'manual';
  }
  // A consumed permit is the last checkpoint before the external write. A later block
  // cannot establish that no write occurred. Reconcile the same attempt.
  if (kind === 'blocked' && consumed) {
    outcome.kind = 'outcome_unknown';
    outcome.submitted_by = 'auto';
  }
  const status = outcome.kind === 'accepted' || outcome.kind === 'outcome_unknown' ? 'outcome_unknown' : 'completed';
  ctx.update('connector_task', row.id, { status, result: outcome });
  ctx.emit('account.connector_task.result', outcome);
  return { status };
}

/** Record independent EX verification. Device reports alone cannot mark a publication as published. */
export function reconcileConnectorTask(ctx: Context, attemptId: string, result: 'verified' | 'failed' | 'unknown', verifiedPostId?: string) {
  const row = taskFor(ctx, attemptId);
  if (row.status !== 'outcome_unknown') fail('CONNECTOR_RECONCILIATION_INVALID');
  if (row.verification_result === 'unknown' && result === 'unknown') return;
  const binding = ctx.get('account_execution_binding', String(row.binding_id));
  const permit = find(ctx, 'auto_submit_permit', { attempt_id: attemptId, status: 'consumed' });
  if (permit && permit.auto_ack_at === binding.auto_ack_at &&
    permit.auto_ack_generation === binding.auto_ack_generation && (result === 'verified' || !row.verification_result)) {
    const streak = result === 'verified' ? 0 : Number(binding.auto_failure_streak ?? 0) + 1;
    const updated = ctx.update('account_execution_binding', binding.id, { auto_failure_streak: streak });
    if (streak >= Number(policy(ctx)?.failure_stop_threshold ?? 3)) openBlock(ctx, String(row.social_account_id), 'auto_failure_streak', updated);
  }
  ctx.update('connector_task', row.id, { verification_result: result, status: result === 'unknown' ? 'outcome_unknown' : 'completed',
    ...(result === 'verified' && verifiedPostId && { verified_post_id: text(verifiedPostId) }) });
  audit(ctx, 'account.connector_task.reconciled', { attempt_id: attemptId, result });
}

export const deviceActions = ['heartbeat', 'claim', 'channels.register', 'catalog.claim', 'catalog.upload', 'browser.identity', 'mobile.identity', 'mobile.report',
  'attempt.ready', 'attempt.permit', 'attempt.consume', 'attempt.report', 'zhihu.stats.claim', 'zhihu.stats.report', 'social.status.claim', 'social.status.report',
  // Phase 1 job protocol (§5.4): handled by modules/worker/device-jobs.ts.
  'jobs.claim', 'jobs.report', 'jobs.go'] as const;
/** §5.4 body limits per signed action (bytes). */
export const deviceBodyLimits: Partial<Record<DeviceAction, number>> = { 'jobs.report': 64_000, 'jobs.claim': 8_192, 'jobs.go': 8_192 };
export type DeviceAction = typeof deviceActions[number];

/** Gateway derives action from the route and uses the same signed bytes for parsing. */
export function handleDeviceRequest(ctx: Context, action: DeviceAction, bytes: Uint8Array, signed: SignedDeviceRequest, services: ConnectorServices, requestId?: string): unknown {
  const device = authenticateDevice(ctx, action, bytes, signed, action === 'catalog.upload' ? workerCatalogUploadBodyLimit : deviceBodyLimits[action]);
  if (action === 'jobs.claim' || action === 'jobs.report' || action === 'jobs.go') {
    let input: Data;
    try { input = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { return fail('INVALID_DEVICE_BODY', 422); }
    if (action === 'jobs.claim') return claimJobs(ctx, device, input);
    if (action === 'jobs.go') return goJob(ctx, device, input);
    return reportJob(ctx, device, input);
  }
  const socialStatus = action === 'social.status.claim' || action === 'social.status.report';
  if (socialStatus || action === 'channels.register' || action === 'catalog.claim' || action === 'catalog.upload' || action === 'zhihu.stats.claim' || action === 'zhihu.stats.report') {
    for (const nonce of ctx.list('device_nonce')) {
      if (nonce.device_id === device.id && String(nonce.expires_at) <= ctx.now) ctx.remove('device_nonce', nonce.id);
    }
  }
  // Signed claim routes share the workspace transaction and a single live lease per device.
  const connectorBusy = () => ctx.list('connector_task').some(row => row.device_id === device.id && row.status === 'claimed' && expires(row) > time(ctx));
  const socialStatusBusy = () => hasLiveWorkerSocialStatusClaim(ctx, device.id);
  if (action === 'catalog.claim' || action === 'catalog.upload') {
    let body: Data;
    try { body = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { throw new WorkerCatalogRequestError(422, 'INVALID_DEVICE_BODY', 'INVALID_DEVICE_BODY'); }
    return action === 'catalog.claim' ? claimWorkerCatalog(ctx, device, body, connectorBusy() || hasLiveZhihuStatsClaim(ctx, device.id) || socialStatusBusy())
      : uploadWorkerCatalog(ctx, device, body, online(ctx, device));
  }
  let body: Data;
  if (action === 'channels.register') {
    try { body = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { return fail('INVALID_DEVICE_BODY', 422); }
    return registerWorkerChannels(ctx, device, body);
  }
  try {
    const json = socialStatus ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : Buffer.from(bytes).toString('utf8');
    body = object(JSON.parse(json));
  } catch { return fail('INVALID_DEVICE_BODY', 422); }
  if (action === 'heartbeat') {
    // Heartbeat v2 (§5.4.1): presence in memory, no snapshot write unless something changed (§2.10).
    if (body.protocol === 2) return heartbeatV2(ctx, device, body);
    recordHeartbeatPresence(ctx, device, { protocol: 1, client_version: typeof body.client_version === 'string' ? body.client_version : '' });
    const supportsSocialStatus = body.social_status_version === workerSocialStatusVersion;
    ctx.update('connector_device', device.id, { last_seen_at: ctx.now, client_version: text(body.client_version, 80),
      social_status_version: supportsSocialStatus ? workerSocialStatusVersion : null });
    notePresenceRowWrite(device.id, ctx.now);
    const heartbeat = { status: 'online', ...(supportsSocialStatus && { social_status_version: workerSocialStatusVersion }) };
    if (body.include_bindings !== true) return heartbeat;
    const accounts = new Map(ctx.list('social_account').map(account => [account.id, account]));
    const social = new Map<string, number>();
    const pendingIdentity: Data[] = [];
    const providers = new Set<string>(ownedSocialProviders);
    for (const binding of ctx.list('account_execution_binding')) {
      if (binding.device_id !== device.id || binding.connector_channel !== 'browser' || !['connector', 'hybrid'].includes(String(binding.mode))) continue;
      const account = accounts.get(String(binding.social_account_id));
      if (account?.status !== 'active') continue;
      const provider = String(account.provider);
      if (!providers.has(provider)) continue;
      social.set(provider, (social.get(provider) ?? 0) + 1);
      if (body.include_browser_work !== true) continue;
      const session = pendingBrowserIdentity(ctx, device, binding, account);
      if (session) pendingIdentity.push({ session_id: session.id, binding_id: binding.id, platform: provider, identity: account.external_account_id });
    }
    return { ...heartbeat, bindings: {
      social: Object.fromEntries(social),
      commerce: workerCatalogBindingCounts(ctx, device),
    }, ...(body.include_browser_work === true && { browser_work: { pending_identity: pendingIdentity } }) };
  }
  if (action === 'zhihu.stats.report') return reportZhihuStats(ctx, device, body);
  if (action === 'zhihu.stats.claim') return claimZhihuStats(ctx, device, body, connectorBusy() || hasLiveWorkerCatalogClaim(ctx, device.id) || socialStatusBusy());
  if (action === 'social.status.report') return reportWorkerSocialStatus(ctx, device, body, requestId);
  if (action === 'social.status.claim') return claimWorkerSocialStatus(ctx, device, body,
    connectorBusy() || hasLiveWorkerCatalogClaim(ctx, device.id) || hasLiveZhihuStatsClaim(ctx, device.id));
  if (action === 'mobile.report') return reportPhone(ctx, device, body, services.iosEnabled === true);
  if (action === 'browser.identity' || action === 'mobile.identity') return reportIdentity(ctx, device, body, action === 'mobile.identity' ? 'mobile' : 'browser');
  if (action === 'claim') {
    const bindingId = body.binding_id === undefined ? undefined : text(body.binding_id, 160);
    if (body.channel !== undefined && body.channel !== 'browser') fail('INVALID_DEVICE_BODY', 422);
    expireConnectorTasks(ctx);
    if (connectorBusy() || hasLiveZhihuStatsClaim(ctx, device.id) || hasLiveWorkerCatalogClaim(ctx, device.id) || socialStatusBusy()) return { claim: null };
    const row = ctx.list('connector_task').find(item => item.device_id === device.id && item.status === 'queued' &&
      (bindingId === undefined || item.binding_id === bindingId) && (body.channel === undefined || rowTask(item).target.channel === 'browser'));
    if (!row) return { claim: null };
    const task = rowTask(row);
    const { binding } = authorize(ctx, services, task, Number(row.fencing_token), Number(row.write_slot_token));
    const effectiveMode = isPublish(task) && binding.connector_mode === 'auto' && services.connectorConfigured?.(ctx, binding.id, 'auto') ? 'auto' : 'assist';
    ctx.update('connector_task', row.id, { status: 'claimed', effective_mode: effectiveMode, auto_ack_generation: binding.auto_ack_generation });
    return { claim: { task, effective_mode: effectiveMode, fencing_token: row.fencing_token, write_slot_token: row.write_slot_token, lease_expires_at: row.lease_expires_at } };
  }
  const row = requestAttempt(ctx, device, body, action !== 'attempt.report');
  if (action === 'attempt.report') return report(ctx, row, body, services);
  const task = rowTask(row);
  const drainingClaim = ctx.list('binding_migration').some(migration => migration.source_binding_id === row.binding_id && migration.status === 'draining');
  const { account, binding } = authorize(ctx, services, task, Number(row.fencing_token), Number(row.write_slot_token), drainingClaim);
  if (action === 'attempt.ready') {
    if (text(body.observed_platform_identity) !== task.platform_identity) {
      openBlock(ctx, account.id, 'identity_mismatch', binding);
      const session = sessionFor(ctx, binding);
      if (session) ctx.update(task.target.channel === 'mobile' ? 'mobile_app_binding' : 'browser_session', session.id, { status: 'identity_mismatch', verified_at: null });
      ctx.update('connector_task', row.id, { status: 'completed' });
      ctx.emit('account.connector_task.result', { attempt_id: task.attempt_id, kind: 'blocked', reason: 'identity_mismatch' });
      return { status: 'blocked' };
    }
    ctx.update('connector_task', row.id, { identity_checked_at: ctx.now });
    return { status: 'verified' };
  }
  if (!isPublish(task) || row.effective_mode !== 'auto' || !services.connectorConfigured?.(ctx, binding.id, 'auto') ||
    !identityFresh(ctx, row) || !('frozen_hash' in task.payload) || body.request_hash !== task.payload.frozen_hash) fail('SUBMISSION_NOT_AUTHORIZED', 403);
  const permit = find(ctx, 'auto_submit_permit', { attempt_id: task.attempt_id });
  if (permit && permit.status !== 'granted') fail('PERMIT_ALREADY_CLOSED');
  const current = evaluatePermit(ctx, binding, account, services.terms?.(), permit?.id);
  const workspaceHaltGeneration = Number(policy(ctx)?.halt_generation ?? 0);
  const accountHaltGeneration = Number(binding.halt_generation ?? 0);
  const haltChanged = permit && (Number(permit.workspace_halt_generation ?? 0) !== workspaceHaltGeneration ||
    Number(permit.account_halt_generation ?? 0) !== accountHaltGeneration);
  const decision = current.decision === 'denied' ? current
    : haltChanged ? { decision: 'denied', deny_reason: 'emergency_halt' } as const
    : row.auto_ack_generation !== binding.auto_ack_generation || (permit && permit.auto_ack_generation !== binding.auto_ack_generation)
      ? { decision: 'denied', deny_reason: 'auto_stopped' } as const : current;
  const wire = { decision: decision.decision, ...('deny_reason' in decision && { deny_reason: decision.deny_reason }), ...('retry_at' in decision && { retry_at: decision.retry_at }) };
  if (decision.decision === 'denied') {
    if (action === 'attempt.consume' && (!permit || permit.id !== body.permit_id)) fail('SUBMIT_PERMIT_INVALID');
    if (permit) ctx.update('auto_submit_permit', permit.id, { status: 'denied' });
    ctx.update('connector_task', row.id, { effective_mode: 'assist', permit_denial: decision.deny_reason });
    return wire;
  }
  if (action === 'attempt.consume') {
    if (!permit || permit.id !== body.permit_id || Date.parse(String(permit.expires_at)) <= time(ctx) ||
      (row.latest_submit_at && time(ctx) > Date.parse(String(row.latest_submit_at)))) fail('SUBMIT_PERMIT_INVALID');
    if (decision.decision !== 'granted') fail('SUBMIT_PERMIT_INVALID');
    ctx.update('auto_submit_permit', permit.id, { status: 'consumed', consumed_at: ctx.now });
    return { decision: 'granted' };
  }
  if (decision.decision !== 'granted') {
    if (decision.decision === 'deferred') {
      if (row.latest_submit_at && Date.parse(decision.retry_at) > Date.parse(String(row.latest_submit_at))) {
        ctx.update('connector_task', row.id, { status: 'abandoned', retry_at: decision.retry_at });
        ctx.emit('execution.late_policy_eval', { attempt_id: task.attempt_id, retry_at: decision.retry_at });
        return { decision: 'late' };
      }
      ctx.emit('account.connector_task.deferred', { attempt_id: task.attempt_id, retry_at: decision.retry_at });
    }
    return wire;
  }
  if (row.latest_submit_at && time(ctx) > Date.parse(String(row.latest_submit_at))) fail('CONNECTOR_LATE_POLICY_REQUIRED');
  if (permit && Date.parse(String(permit.expires_at)) <= time(ctx)) fail('SUBMIT_PERMIT_INVALID');
  const grant = permit ?? ctx.create('auto_submit_permit', { attempt_id: task.attempt_id, social_account_id: account.id, binding_id: binding.id,
    auto_ack_at: binding.auto_ack_at, auto_ack_generation: binding.auto_ack_generation, status: 'granted',
    workspace_halt_generation: workspaceHaltGeneration, account_halt_generation: accountHaltGeneration,
    granted_at: ctx.now, expires_at: iso(Math.min(time(ctx) + 15_000, expires(row), row.latest_submit_at ? Date.parse(String(row.latest_submit_at)) : Infinity)) });
  return { decision: 'granted', permit_id: grant.id, expires_at: grant.expires_at };
}
