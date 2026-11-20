import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { Context, Data, Row } from '@smartsell/contracts';
import { audit, fail, find, iso, matches, one, text, time } from './input.ts';
import { digest } from './oauth.ts';
import { stopAuto } from './auto-control.ts';

export interface SignedDeviceRequest { device_id: string; timestamp: string; nonce: string; signature: string }
export const severeBlocks = ['captcha', 'platform_restriction', 'identity_mismatch'] as const;
export const blockReasons = [...severeBlocks, 'login_expired', 'mobile_offline', 'setup_invalid', 'app_dialog', 'auto_failure_streak'] as const;

export const deviceRequestBytes = (workspaceId: string, deviceId: string, action: string, timestamp: string, nonce: string, rawBody: Uint8Array) =>
  Buffer.from(JSON.stringify(['smartsell.device.v1', workspaceId, deviceId, action, timestamp, nonce, digest(rawBody)]));

const publicKey = (encoded: string) => {
  try {
    const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.from(encoded, 'base64url') });
    if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== encoded) fail('INVALID_DEVICE_KEY', 422);
    return key;
  } catch {
    return fail('INVALID_DEVICE_KEY', 422);
  }
};

export function issuePairingCode(ctx: Context, body: Data) {
  if (body.owned_device_confirmed !== true) fail('DEVICE_OWNERSHIP_REQUIRED', 422);
  const code = randomBytes(24).toString('base64url');
  const expiresAt = iso(time(ctx) + 5 * 60_000);
  const row = ctx.create('device_pairing_code', { code_hash: digest(code), expires_at: expiresAt, created_by: ctx.actorId, used_at: null });
  audit(ctx, 'account.device.pairing_code_issued', { pairing_id: row.id });
  return { pairing_code: code, expires_at: expiresAt };
}

/** Ingress rate-limits pair requests and serializes pairing code consumption. */
export function pairDevice(ctx: Context, body: Data) {
  const code = find(ctx, 'device_pairing_code', { code_hash: digest(text(body.pairing_code)) });
  if (!code || code.used_at || Date.parse(String(code.expires_at)) <= time(ctx)) fail('PAIRING_CODE_INVALID', 401);
  const encoded = text(body.public_key, 100);
  const platform = one(body.platform, ['darwin', 'win32'] as const);
  const name = text(body.name, 100);
  const proof = matches(body.proof, /^[A-Za-z0-9_-]{86}$/, 86);
  const bytes = Buffer.from(JSON.stringify(['smartsell.pair.v1', ctx.workspaceId, body.pairing_code, encoded, platform, name]));
  if (!verify(null, bytes, publicKey(encoded), Buffer.from(proof, 'base64url'))) fail('INVALID_DEVICE_PROOF', 401);
  if (find(ctx, 'connector_device', { public_key: encoded })) fail('DEVICE_ALREADY_PAIRED');
  const device = ctx.create('connector_device', { name, platform, public_key: encoded, owner_id: code.created_by, status: 'active', last_seen_at: ctx.now });
  ctx.update('device_pairing_code', code.id, { used_at: ctx.now });
  audit(ctx, 'account.device.paired', { device_id: device.id, approved_by: code.created_by });
  return { device_id: device.id };
}

export function authenticateDevice(ctx: Context, action: string, rawBody: Uint8Array, signed: SignedDeviceRequest) {
  if (rawBody.byteLength > 128_000) fail('DEVICE_BODY_TOO_LARGE', 413);
  const nonce = matches(signed.nonce, /^[A-Za-z0-9_-]{22,64}$/, 64);
  const timestamp = text(signed.timestamp);
  const issuedAt = Date.parse(timestamp);
  if (!Number.isFinite(issuedAt) || Math.abs(time(ctx) - issuedAt) > 60_000) fail('DEVICE_PROOF_EXPIRED', 401);
  const device = ctx.get('connector_device', text(signed.device_id));
  if (device.status !== 'active') fail('DEVICE_INACTIVE', 401);
  const signature = matches(signed.signature, /^[A-Za-z0-9_-]{86}$/, 86);
  if (!verify(null, deviceRequestBytes(ctx.workspaceId, device.id, action, timestamp, nonce, rawBody), publicKey(String(device.public_key)), Buffer.from(signature, 'base64url'))) fail('INVALID_DEVICE_PROOF', 401);
  if (find(ctx, 'device_nonce', { device_id: device.id, nonce })) fail('DEVICE_PROOF_REPLAYED', 401);
  ctx.create('device_nonce', { device_id: device.id, nonce, expires_at: iso(issuedAt + 61_000) });
  return device;
}

export const online = (ctx: Context, row: Row) => row.status === 'active' && time(ctx) - Date.parse(String(row.last_seen_at)) < 90_000;

export function bindingFor(ctx: Context, accountId: string) {
  return find(ctx, 'account_execution_binding', { social_account_id: accountId });
}

export function sessionFor(ctx: Context, binding: Row) {
  if (binding.connector_channel === 'mobile') return ctx.list('mobile_app_binding').find(row =>
    row.mobile_device_id === binding.mobile_device_id && row.social_account_id === binding.social_account_id &&
    row.device_id === binding.device_id && row.app === binding.mobile_app && row.status !== 'revoked');
  return ctx.list('browser_session').find(row => row.binding_id === binding.id && row.device_id === binding.device_id && row.status !== 'revoked');
}

export function connectorReady(ctx: Context, binding: Row) {
  if (!binding.device_id || binding.paused || !['connector', 'hybrid'].includes(String(binding.mode))) return false;
  if (!online(ctx, ctx.get('connector_device', String(binding.device_id)))) return false;
  if (sessionFor(ctx, binding)?.status !== 'verified') return false;
  if (binding.connector_channel !== 'mobile') return true;
  const phone = ctx.get('mobile_device', String(binding.mobile_device_id));
  return phone.status === 'ready' && phone.device_id === binding.device_id && time(ctx) - Date.parse(String(phone.last_seen_at)) < 90_000 &&
    (phone.platform !== 'ios' || Date.parse(String(phone.signing_expires_at)) > time(ctx));
}

export function openBlock(ctx: Context, accountId: string, reason: string, binding?: Row) {
  const existing = ctx.list('account_block').find(row => row.social_account_id === accountId && row.kind === reason && row.status !== 'resolved');
  const block = existing ?? ctx.create('account_block', {
    social_account_id: accountId, binding_id: binding?.id, kind: reason, severity: 'blocking', status: 'open', opened_at: ctx.now,
  });
  if (!existing) ctx.emit('account.block.opened', { block_id: block.id, social_account_id: accountId, reason });
  if (binding && (severeBlocks.some(item => item === reason) || reason === 'auto_failure_streak')) stopAuto(ctx, binding, reason, block.id);
  return block;
}

export const blocked = (ctx: Context, accountId: string) => ctx.list('account_block').some(row => row.social_account_id === accountId && row.severity === 'blocking' && row.status !== 'resolved');

export function reportIdentity(ctx: Context, device: Row, body: Data, channel: 'browser' | 'mobile') {
  const kind = channel === 'mobile' ? 'mobile_app_binding' : 'browser_session';
  const session = ctx.get(kind, text(body.session_id));
  if (session.device_id !== device.id || session.status === 'revoked') fail('DEVICE_SCOPE_MISMATCH', 403);
  if (channel === 'mobile') {
    const phone = ctx.get('mobile_device', String(session.mobile_device_id));
    if (phone.device_id !== device.id || phone.status !== 'ready') fail('MOBILE_NOT_READY');
  }
  const account = ctx.get('social_account', String(session.social_account_id));
  const binding = bindingFor(ctx, account.id);
  const same = text(body.observed_platform_identity) === account.external_account_id;
  ctx.update(kind, session.id, { status: same ? 'verified' : 'identity_mismatch', verified_at: same ? ctx.now : null });
  if (!same) openBlock(ctx, account.id, 'identity_mismatch', binding);
  return { status: same ? 'verified' : 'blocked' };
}

export function reportPhone(ctx: Context, device: Row, body: Data, iosEnabled: boolean) {
  const platform = one(body.platform, ['android', 'ios'] as const);
  if (platform === 'ios' && (!iosEnabled || device.platform !== 'darwin')) fail('IOS_NOT_CONFIGURED');
  if (body.physical !== true || body.emulator !== false || body.cloud !== false) fail('PHYSICAL_DEVICE_REQUIRED', 422);
  const fingerprint = matches(body.hardware_id_hash, /^[0-9a-f]{64}$/);
  const prior = find(ctx, 'mobile_device', { hardware_id_hash: fingerprint });
  if (prior && prior.status !== 'removed' && prior.device_id !== device.id) fail('MOBILE_ALREADY_PAIRED');
  if (prior && prior.status !== 'removed' && prior.platform !== platform) fail('MOBILE_IDENTITY_MISMATCH');
  const signing = platform === 'ios' ? text(body.signing_expires_at) : null;
  const connection = one(body.connection, ['usb', 'lan'] as const);
  const osVersion = text(body.os_version, 80);
  const major = Number(/^(\d{1,3})(?:\.\d+){0,3}$/.exec(osVersion)?.[1]);
  const minimum = platform === 'ios' ? 18 : connection === 'lan' ? 11 : 8;
  const prerequisites = major >= minimum && body.prerequisites_ready === true && (signing == null || Date.parse(signing) > time(ctx));
  const status = !prior || prior.status === 'removed' ? 'detected' : prior.status === 'disabled' ? 'disabled'
    : prior.approved_at ? (body.connected !== true ? 'offline' : prerequisites ? 'ready' : 'pending_setup') : 'detected';
  const values = {
    platform, device_id: device.id, hardware_id_hash: fingerprint, model: text(body.model, 80), serial_suffix: matches(body.serial_suffix, /^[A-Za-z0-9]{4}$/),
    os_version: osVersion, connection, driver_version: text(body.driver_version, 80),
    status, prerequisites_ready: prerequisites, signing_expires_at: signing, last_seen_at: body.connected === true ? ctx.now : null,
    ...(prior?.status === 'removed' ? { approved_at: null } : {}),
  };
  const phone = prior ? ctx.update('mobile_device', prior.id, values) : ctx.create('mobile_device', values);
  return { mobile_device_id: phone.id, status };
}
