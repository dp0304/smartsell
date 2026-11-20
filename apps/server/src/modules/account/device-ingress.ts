import { createHash, verify } from 'node:crypto';
import { importDevicePublicKey } from '../../../../../packages/connector-tasks/src/index.js';
import type { Context, Fields } from '../types.js';
import { ensure, get, idFor, insert, millis, update } from './model.js';

export const deviceCommandActions = ['heartbeat', 'report_identity', 'report_block', 'claim_lease', 'use_lease', 'request_submit_permit', 'consume_submit_permit'] as const;
export type DeviceCommandAction = typeof deviceCommandActions[number];
export interface SignedDeviceCommand {
  deviceId: string;
  action: DeviceCommandAction;
  timestamp: string;
  nonce: string;
  signature: string;
}

const freshness = 30_000;

export function deviceCommandBytes(tenantId: string, workspaceId: string, request: Omit<SignedDeviceCommand, 'signature'>, body: Uint8Array) {
  return Buffer.from(JSON.stringify(['smartsell-account-device-v1', tenantId, workspaceId, request.deviceId, request.action,
    request.timestamp, request.nonce, createHash('sha256').update(body).digest('hex')]));
}

export async function authenticateDeviceCommand(ctx: Context, request: SignedDeviceCommand, body: Uint8Array): Promise<Fields> {
  ensure(deviceCommandActions.includes(request.action) && /^[\w-]{1,160}$/.test(request.deviceId) &&
    /^[A-Za-z0-9_-]{22,80}$/.test(request.nonce) && /^[A-Za-z0-9_-]{86}$/.test(request.signature) &&
    body.byteLength <= 8192, 'invalid_device_request', 403);
  const now = millis(ctx);
  const signedAt = Date.parse(request.timestamp);
  ensure(Math.abs(now - signedAt) <= freshness && new Date(signedAt).toISOString() === request.timestamp, 'stale_device_request', 403);
  const device = await get(ctx, 'device', request.deviceId);
  ensure(device.data.status === 'paired' && verify(null, deviceCommandBytes(ctx.tenantId, ctx.workspaceId, request, body),
    importDevicePublicKey(device.data.public_key), Buffer.from(request.signature, 'base64url')), 'invalid_device_proof', 403);
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { ensure(false, 'invalid_device_body', 422); }
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'invalid_device_body', 422);

  // Replace expired nonces in place so pruning is optional. The host serializes this with the action.
  const id = idFor(device.id, request.nonce);
  const seen = await ctx.get('account', 'device_request_nonce', id);
  ensure(!seen || seen.data.expires_at < now, 'device_request_replayed', 409);
  const data = { expires_at: signedAt + freshness };
  if (seen) await update(ctx, seen, data);
  else await insert(ctx, 'device_request_nonce', data, id);
  return input as Fields;
}
