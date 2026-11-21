import { randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { createDeviceChallenge, importDevicePublicKey, signLease, verifyDeviceProof, verifyLease, type DeviceChallengeScope, type LeaseScope } from '../../../../../packages/connector-tasks/src/index.js';
import { DomainError, text, type Context, type Entity, type Fields } from '../types.js';
import { approved, choice, emit, ensure, get, identifier, insert, list, millis, sha256, update } from './model.js';

const seconds = (ctx: Context) => Math.floor(millis(ctx) / 1000);
const freshness = 90_000;
export const workflows = ['official_auth', 'app_share', 'manual_handoff'] as const;
export const channels = ['browser', 'mobile'] as const;

function scope(ctx: Context, deviceId: string, purpose: DeviceChallengeScope['purpose']): DeviceChallengeScope {
  return { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, deviceId, purpose };
}

export async function startPairing(ctx: Context, input: Fields) {
  approved(input, 'owned_device_confirmed');
  const label = text(input, 'label', 100);
  const host_os = choice(input, 'host_os', ['macos', 'windows'] as const);
  const deviceId = randomUUID();
  const challenge = createDeviceChallenge(scope(ctx, deviceId, 'pairing'), seconds(ctx));
  const code = randomBytes(24).toString('base64url');
  await insert(ctx, 'pairing', { code_hash: sha256(code), challenge, status: 'pending', label, host_os, confirmed_by: ctx.actorId }, deviceId);
  return { device_id: deviceId, code, challenge };
}

function checkProof(ctx: Context, challenge: Parameters<typeof verifyDeviceProof>[0], input: Fields, publicKey: string, deviceId: string, purpose: DeviceChallengeScope['purpose']) {
  const signature = text(input, 'signature', 200);
  try {
    verifyDeviceProof(challenge, signature, importDevicePublicKey(publicKey), scope(ctx, deviceId, purpose), seconds(ctx));
  } catch { throw new DomainError('invalid_device_proof', 'Invalid or expired device proof', 403); }
}

export async function finishPairing(ctx: Context, input: Fields) {
  const id = identifier(input, 'device_id');
  const row = await get(ctx, 'pairing', id);
  ensure(row.data.status === 'pending' && row.data.code_hash === sha256(text(input, 'code', 100)), 'invalid_pairing', 403);
  const key = text(input, 'public_key', 150);
  checkProof(ctx, row.data.challenge, input, key, id, 'pairing');
  await update(ctx, row, { status: 'consumed', code_hash: null });
  const device = await insert(ctx, 'device', { status: 'paired', label: row.data.label, host_os: row.data.host_os, public_key: key, confirmed_by: row.data.confirmed_by, paired_at: ctx.now, online_at: null }, id);
  await emit(ctx, 'device.paired', { device_id: id });
  return { device_id: device.id, status: device.data.status };
}

export function deviceOnline(ctx: Context, device: Entity) {
  const age = millis(ctx) - Date.parse(device.data.online_at);
  return device.data.status === 'paired' && age >= 0 && age < freshness;
}

export async function startDeviceProof(ctx: Context, input: Fields) {
  const id = identifier(input, 'device_id');
  const device = await get(ctx, 'device', id);
  ensure(device.data.status === 'paired', 'device_unavailable');
  const challenge = createDeviceChallenge(scope(ctx, id, 'session'), seconds(ctx));
  const proof = await insert(ctx, 'device_challenge', { challenge, consumed: false });
  return { challenge_id: proof.id, challenge };
}

export async function heartbeat(ctx: Context, input: Fields) {
  const proof = await get(ctx, 'device_challenge', identifier(input, 'challenge_id'));
  ensure(proof.data.consumed === false, 'proof_consumed');
  const id = proof.data.challenge.deviceId;
  const device = await get(ctx, 'device', id);
  ensure(device.data.status === 'paired', 'device_unavailable');
  checkProof(ctx, proof.data.challenge, input, device.data.public_key, id, 'session');
  await update(ctx, proof, { consumed: true });
  return markDeviceOnline(ctx, device);
}

export async function markDeviceOnline(ctx: Context, device: Entity) {
  const id = device.id;
  await update(ctx, device, { online_at: ctx.now });
  if (!deviceOnline(ctx, device)) await emit(ctx, 'device.online', { device_id: id });
  return { device_id: id, status: 'online', online_at: ctx.now };
}

export async function revokeDevice(ctx: Context, input: Fields) {
  const device = await get(ctx, 'device', identifier(input, 'device_id'));
  if (device.data.status === 'revoked') return device;
  const result = await update(ctx, device, { status: 'revoked', online_at: null, revoked_at: ctx.now });
  await emit(ctx, 'device.revoked', { device_id: device.id });
  return result;
}

export interface LeaseKey { privateKey: KeyObject; publicKey: KeyObject }
export async function issueLease(ctx: Context, leaseScope: LeaseScope, binding: Entity, key: LeaseKey) {
  const iat = seconds(ctx);
  const exp = iat + 90;
  const jti = randomUUID();
  const token = signLease({ ...leaseScope, jti, iat, exp }, key.privateKey);
  await insert(ctx, 'connector_lease', { scope: leaseScope, status: 'issued', exp, binding_revision: binding.data.binding_revision }, jti);
  await emit(ctx, 'lease.issued', { lease_id: jti, binding_id: binding.id, job_id: leaseScope.jobId });
  return { token, lease_id: jti, expires_at: new Date(exp * 1000).toISOString() };
}

export async function checkLease(ctx: Context, token: string, expected: LeaseScope, key: LeaseKey) {
  const verify = () => {
    try { return verifyLease(token, key.publicKey, expected, seconds(ctx)); }
    catch { throw new DomainError('invalid_lease', 'Invalid, expired or mismatched lease', 403); }
  };
  const claims = verify();
  const row = await get(ctx, 'connector_lease', claims.jti);
  ensure(row.data.status === 'issued', 'lease_unavailable');
  return row;
}

export async function revokeLease(ctx: Context, input: Fields) {
  const row = await get(ctx, 'connector_lease', identifier(input, 'lease_id'));
  if (row.data.status !== 'issued') return row;
  const result = await update(ctx, row, { status: 'revoked' });
  await emit(ctx, 'lease.revoked', { lease_id: row.id, binding_id: row.data.scope.bindingId });
  return result;
}

export async function sweepPresence(ctx: Context) {
  let offline = 0;
  for (const device of await list(ctx, 'device')) {
    if (!device.data.online_at || deviceOnline(ctx, device)) continue;
    await update(ctx, device, { online_at: null });
    await emit(ctx, 'device.offline', { device_id: device.id });
    offline++;
  }
  return { offline };
}
