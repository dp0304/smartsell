import { createHash } from 'node:crypto';
import { browserApps, fields, mobileApps, opaqueId, parseChoice, parseConnectorClaim, parsePostResult, sha256, type ConnectorClaim, type ConnectorTask, type MediaRef, type Target } from '../../../packages/connector-tasks/src/index.ts';
import type { SignedDeviceClient } from './device-client.ts';
import type { BlockReason } from './preflight.ts';
import type { PostResult, Result, TerminalResult } from './workflow.ts';

export const clientVersion = '0.1.0';

/** A single target provisioned independently by the local operator and AC administrator. */
export function parseManualTarget(input: unknown) {
  const local = fields(input, ['origin', 'workspace_id', 'connector_device_id', 'binding_id', 'account_id', 'session_id', 'platform_identity', 'target'], ['android']);
  if (typeof local.origin !== 'string') throw new Error('Invalid API origin');
  const target = fields(local.target, ['channel', 'app'], ['profile_id', 'mobile_device_id']);
  let approved: Target;
  let android: { hardware_id_hash: string; connection: 'usb' | 'lan' } | undefined;
  if (target.channel === 'browser' && !Object.hasOwn(target, 'mobile_device_id') && !Object.hasOwn(local, 'android')) {
    approved = { channel: 'browser', app: parseChoice(target.app, browserApps, 'app'), profile_id: opaqueId(target.profile_id, 'profile_id') };
  } else if (target.channel === 'mobile' && !Object.hasOwn(target, 'profile_id')) {
    const phone = fields(local.android, ['hardware_id_hash', 'connection']);
    android = { hardware_id_hash: sha256(phone.hardware_id_hash, 'hardware_id_hash'), connection: parseChoice(phone.connection, ['usb', 'lan'], 'connection') };
    approved = { channel: 'mobile', app: parseChoice(target.app, mobileApps, 'app'), mobile_device_id: opaqueId(target.mobile_device_id, 'mobile_device_id') };
  } else throw new Error('Invalid local target');
  const session_id = opaqueId(local.session_id, 'session_id');
  if (approved.channel === 'browser' && approved.profile_id !== session_id) throw new Error('Browser session/profile mismatch');
  return {
    origin: local.origin, workspace_id: opaqueId(local.workspace_id, 'workspace_id'), connector_device_id: opaqueId(local.connector_device_id, 'connector_device_id'),
    binding_id: opaqueId(local.binding_id, 'binding_id'), account_id: opaqueId(local.account_id, 'account_id'), session_id,
    platform_identity: opaqueId(local.platform_identity, 'platform_identity'), target: approved, android,
  };
}
export type ManualTarget = ReturnType<typeof parseManualTarget>;
export type ManualIO = {
  ask(prompt: string, deadline: number): Promise<string | undefined>;
  display(value: object): void;
  verifyMedia(media: MediaRef, deadline: number): Promise<boolean>;
};

export function matchesAndroidHardware(observed: string, expectedHash: string): boolean {
  return observed.length > 0 && !/^emulator-/i.test(observed) && createHash('sha256').update(observed).digest('hex') === expectedHash;
}

const issues = ['captcha', 'risk_control', 'login_expired', 'app_prompt', 'identity_mismatch'] as const;
function issue(value: string | undefined) { return issues.find(reason => reason === value); }

export async function observeManualIdentity(local: ManualTarget, io: ManualIO, deadline: number): Promise<{ identity: string } | { reason: BlockReason }> {
  const { target } = local;
  const challenge = 'Enter the observed platform account ID or captcha/risk_control/login_expired/app_prompt/cancel. ';
  if (target.channel === 'browser') {
    if (await io.ask(`Confirm this is your assigned dedicated ${target.app} browser profile (${target.profile_id}). Type owned-profile: `, deadline) !== 'owned-profile') return { reason: 'binding_invalid' };
  } else {
    const phone = local.android!;
    const minimum = phone.connection === 'lan' ? 11 : 8;
    const observed = await io.ask(`On the approved ${target.app} phone, verify ownership, pairing, unlocked authorized access over ${phone.connection}, and Android ${minimum}+. For LAN, also verify the explicitly approved same-LAN connection. Type its observed hardware ID: `, deadline);
    if (!observed) return { reason: 'mobile_unavailable' };
    if (!matchesAndroidHardware(observed, phone.hardware_id_hash)) return { reason: 'identity_mismatch' };
  }
  const observed = await io.ask(challenge, deadline);
  const reason = issue(observed);
  if (reason) return { reason };
  try { return { identity: opaqueId(observed === 'cancel' ? undefined : observed, 'observed_platform_identity') }; }
  catch { return { reason: 'assist_closed' }; }
}

const results = {
  douyin: { hosts: ['www.douyin.com', 'douyin.com'], path: /^\/(?:video|note)\/([0-9]+)\/?$/ },
  xhs: { hosts: ['www.xiaohongshu.com', 'xiaohongshu.com'], path: /^\/(?:explore|discovery\/item)\/([a-f0-9]+)\/?$/ },
  tiktok: { hosts: ['www.tiktok.com', 'tiktok.com'], path: /^\/@[A-Za-z0-9_.]+\/video\/([0-9]+)\/?$/ },
  instagram: { hosts: ['www.instagram.com', 'instagram.com'], path: /^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/ },
  facebook: { hosts: ['www.facebook.com', 'facebook.com', 'm.facebook.com'], path: /^\/(?:reel\/|[A-Za-z0-9_.-]+\/(?:posts|videos)\/)([A-Za-z0-9_-]+)\/?$/ },
};

function parseReceipt(input: string | undefined, task: ConnectorTask, expectedPost?: string): PostResult | undefined {
  try {
    const result = parsePostResult(JSON.parse(input ?? ''), expectedPost);
    const url = new URL(result.result_url);
    const policy = results[task.target.app];
    if (!policy.hosts.includes(url.hostname) || url.search || policy.path.exec(url.pathname)?.[1] !== result.platform_post_id) return;
    return result;
  } catch { return undefined; }
}

function sameTarget(task: ConnectorTask, local: ManualTarget) {
  return task.workspace_id === local.workspace_id && task.connector_device_id === local.connector_device_id && task.binding_id === local.binding_id &&
    task.account_id === local.account_id && task.platform_identity === local.platform_identity &&
    task.target.app === local.target.app && (task.target.channel === 'browser' && local.target.channel === 'browser' ? task.target.profile_id === local.target.profile_id :
      task.target.channel === 'mobile' && local.target.channel === 'mobile' && task.target.mobile_device_id === local.target.mobile_device_id);
}

const receiptPrompt = 'Paste the receipt JSON with the canonical post URL and pre-registered masked evidence references. Leave blank if unavailable: ';

async function handoff(client: Pick<SignedDeviceClient, 'heartbeat' | 'ready'>, claim: ConnectorClaim, local: ManualTarget, io: ManualIO, now: () => number): Promise<TerminalResult> {
  const task = claim.task;
  const stop = (reason: BlockReason): TerminalResult => ({ kind: 'blocked', reason, handoff: task.kind === 'tiktok.app.publish' ? 'awaiting_creator_action' : 'manual' });
  if (!sameTarget(task, local)) return stop('binding_invalid');
  // Leave time for the signed report to arrive under the original lease.
  const deadline = Date.parse(claim.lease_expires_at) - 12_000;
  if (now() >= deadline) return stop('lease_expired');
  const revision = 'revision' in task.payload && task.kind !== 'mobile.push_media' ? task.payload.revision : undefined;
  const recovery = task.kind === 'post.capture_result';
  const verification = task.kind === 'post.verify_visible';
  if (!revision && !recovery && !verification && task.kind !== 'session.verify_identity' && task.kind !== 'mobile.verify_app_identity') return stop('unsupported');
  if (await io.ask(`Confirm you own this paired desktop and consent to the manual action for attempt ${task.attempt_id}. Type confirm to proceed: `, deadline) !== 'confirm') {
    return stop('consent_required');
  }
  if (now() >= deadline) return stop('lease_expired');
  const observed = await observeManualIdentity(local, io, deadline);
  if ('reason' in observed) return stop(observed.reason);
  if (observed.identity !== task.platform_identity) return stop('identity_mismatch');
  const ready = async (identity: string): Promise<boolean> => {
    if (now() >= deadline) return false;
    try {
      await client.heartbeat(clientVersion);
      if (now() >= deadline) return false;
      await client.ready(claim, identity);
      return now() < deadline;
    } catch { return false; }
  };
  if (!await ready(observed.identity)) return stop('late_or_stale');
  if (recovery) {
    io.display({ source_attempt_id: task.payload.source_attempt_id, platform_post_id: task.payload.platform_post_id });
    const result = parseReceipt(await io.ask(receiptPrompt, deadline), task, task.payload.platform_post_id);
    if (now() >= deadline) return stop('lease_expired');
    return result ? { kind: 'result_captured', ...result } : stop('result_not_found');
  }
  if (verification) {
    io.display({ source_attempt_id: task.payload.source_attempt_id, platform_post_id: task.payload.platform_post_id });
    const visibility = await io.ask('Check this exact post in the official interface. Type visible, not_visible, or cancel: ', deadline);
    if (now() >= deadline) return stop('lease_expired');
    if (visibility === 'visible' || visibility === 'not_visible') return { kind: 'visibility_checked', visible: visibility === 'visible' };
    return stop(issue(visibility) ?? 'assist_closed');
  }
  if (!revision) return { kind: 'identity_verified' };
  io.display({ attempt_id: task.attempt_id, target: task.target, revision, mode: 'assist' });
  for (const asset of revision.media) {
    if (now() >= deadline || !await io.verifyMedia(asset, deadline)) return stop('media_unverified');
  }
  const staged = await io.ask(`Stage the exact approved content in the official interface with the verified media${revision.draft ? ` and unique inbox draft ${revision.draft.publish_id}` : ''}. Review privacy and settings. Type staged, an observed challenge reason, or cancel before publishing: `, deadline);
  if (staged !== 'staged') return stop(issue(staged) ?? 'assist_closed');
  const beforeSubmit = await observeManualIdentity(local, io, deadline);
  if ('reason' in beforeSubmit) return stop(beforeSubmit.reason);
  if (beforeSubmit.identity !== observed.identity) return stop('identity_mismatch');
  if (!await ready(beforeSubmit.identity)) return stop('late_or_stale');
  const submitDeadline = Math.min(deadline, now() + 60_000);
  const submission = await io.ask(`You may click Publish once in the official interface before ${new Date(submitDeadline).toISOString()}. Type submitted after clicking, unknown if uncertain, or cancel/a challenge reason only if you did not click: `, submitDeadline);
  if (now() >= submitDeadline) return submission === 'submitted' ? { kind: 'outcome_unknown', submitted_by: 'human' } : { kind: 'outcome_unknown' };
  if (submission === 'cancel') return stop('assist_closed');
  const challenge = issue(submission);
  if (challenge) return stop(challenge);
  if (submission !== 'submitted') return { kind: 'outcome_unknown' };
  const receipt = now() < deadline ? parseReceipt(await io.ask(receiptPrompt, deadline), task) : undefined;
  return receipt && now() < deadline ? { kind: 'accepted', submitted_by: 'human', ...receipt } : { kind: 'outcome_unknown', submitted_by: 'human' };
}

/** Process one claim. A lost report acknowledgement always requires reconciliation of that attempt. */
export async function runManualGatewayOnce(client: Pick<SignedDeviceClient, 'heartbeat' | 'claim' | 'ready' | 'report'>,
  local: ManualTarget, io: ManualIO, now = Date.now): Promise<{ status: 'idle' } | { status: 'reported' | 'reconcile'; attempt_id: string; result: Result }> {
  await client.heartbeat(clientVersion);
  const input = await client.claim(local.binding_id);
  if (!input) return { status: 'idle' };
  const claim = parseConnectorClaim(input);
  const { attempt_id } = claim.task;
  let result: TerminalResult;
  try { result = await handoff(client, claim, local, io, now); }
  catch { result = { kind: 'outcome_unknown' }; }
  try {
    const { status } = fields(await client.report({ ...result, attempt_id, fencing_token: claim.fencing_token, write_slot_token: claim.write_slot_token }), ['status']);
    const expected = result.kind === 'accepted' || result.kind === 'outcome_unknown' ? 'outcome_unknown' : 'completed';
    if (status !== expected) throw new Error('Unexpected report status');
    return { status: 'reported', attempt_id, result };
  } catch {
    return { status: 'reconcile', attempt_id, result };
  }
}
