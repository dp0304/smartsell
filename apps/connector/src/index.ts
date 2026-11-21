import { createPublicKey, type KeyObject } from 'node:crypto';

export * from './device-client.ts';
export * from './fixture.ts';
export * from './permit.ts';
export * from './preflight.ts';
export * from './workflow.ts';
import {
  assertDeviceChallengeScope, exportDevicePublicKey, fields, importDevicePublicKey, opaqueId, parseLeaseScope,
  signDeviceProof, verifyLease,
  type DeviceChallengeScope, type ConnectorWorkflow, type LeaseScope,
} from '../../../packages/connector-tasks/src/index.ts';

export interface PairingConfirmation {
  userInitiated: boolean;
  ownsDevice: boolean;
}

/** Call after confirmation on this desktop using its locally held key. Ownership is user-attested. */
export function createPairingProof(
  challenge: unknown,
  expected: Omit<DeviceChallengeScope, 'purpose'>,
  privateKey: KeyObject,
  confirmation: PairingConfirmation,
  now?: number,
): { publicKey: string; signature: string } {
  if (confirmation?.userInitiated !== true || confirmation?.ownsDevice !== true) {
    throw new Error('pairing_confirmation_required');
  }
  const current = assertDeviceChallengeScope(challenge, { ...expected, purpose: 'pairing' }, now);
  const signature = signDeviceProof(current, privateKey);
  return { publicKey: exportDevicePublicKey(createPublicKey(privateKey)), signature };
}

type PlatformStatus = 'clear' | 'captcha' | 'platform_restriction' | 'login_required';

export interface LocalContext {
  /** Locally pinned server public key in base64url DER SPKI format. */
  issuerPublicKey: string;
  scope: LeaseScope;
  consentConfirmed: boolean;
  /** Active pairing for scope.deviceId on this desktop. */
  deviceActive: boolean;
  deviceOwned: boolean;
  bindingActive: boolean;
  /** Required for mobile. Expected ID comes from the local binding, observed ID from local confirmation. */
  mobileDevice?: { expectedId: string; observedId: string | null; owned: boolean; physical: boolean; paired: boolean; authorized: boolean };
  halted: boolean;
  platformStatus: PlatformStatus;
  expectedAccountId: string;
  observedAccountId: string | null;
}

type BlockReason = 'invalid_local_context' | 'invalid_lease' | 'device_inactive' | 'device_not_owned' | 'mobile_device_unverified'
  | 'binding_inactive' | 'halted' | 'consent_required' | 'captcha' | 'platform_restriction' | 'login_required'
  | 'identity_unverified' | 'identity_mismatch';

export type LocalDecision =
  | { status: 'blocked'; reason: BlockReason }
  | ({ status: 'manual_step_required'; instruction: string } & Pick<LeaseScope, 'platform' | 'channel' | 'workflow'>);

const instructions: Readonly<Record<ConnectorWorkflow, string>> = Object.freeze({
  official_auth: 'Continue in the platform’s official authorization flow yourself.',
  app_share: 'Use the platform app’s official share flow yourself and review the intended account and content.',
  manual_handoff: 'Continue manually in the official platform interface using the verified account.',
});

const contextKeys = [
  'issuerPublicKey', 'scope', 'consentConfirmed', 'deviceActive', 'deviceOwned', 'bindingActive', 'halted',
  'platformStatus', 'expectedAccountId', 'observedAccountId',
] as const;

function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

export function parseLocalContext(value: unknown): LocalContext {
  const obj = fields(value, contextKeys, ['mobileDevice']);
  const {
    issuerPublicKey, consentConfirmed, deviceActive, deviceOwned, bindingActive, halted,
    platformStatus, expectedAccountId, observedAccountId,
  } = obj;
  if (typeof issuerPublicKey !== 'string' || typeof consentConfirmed !== 'boolean'
    || typeof deviceActive !== 'boolean' || typeof deviceOwned !== 'boolean' || typeof bindingActive !== 'boolean' || typeof halted !== 'boolean'
    || (platformStatus !== 'clear' && platformStatus !== 'captcha' && platformStatus !== 'platform_restriction'
      && platformStatus !== 'login_required')
    || !isAccountId(expectedAccountId) || (observedAccountId !== null && !isAccountId(observedAccountId))) {
    throw new Error('invalid_local_context');
  }
  const scope = parseLeaseScope(obj.scope);
  let mobileDevice: LocalContext['mobileDevice'];
  if (Object.hasOwn(obj, 'mobileDevice')) {
    if (scope.channel !== 'mobile') throw new Error('invalid_local_context');
    const { expectedId, observedId, owned, physical, paired, authorized } = fields(obj.mobileDevice,
      ['expectedId', 'observedId', 'owned', 'physical', 'paired', 'authorized']);
    if (typeof owned !== 'boolean' || typeof physical !== 'boolean' || typeof paired !== 'boolean' || typeof authorized !== 'boolean') {
      throw new Error('invalid_local_context');
    }
    mobileDevice = { expectedId: opaqueId(expectedId, 'expectedId'), observedId: observedId === null ? null : opaqueId(observedId, 'observedId'),
      owned, physical, paired, authorized };
  }
  return { issuerPublicKey, scope, consentConfirmed, deviceActive, deviceOwned, bindingActive, halted, platformStatus,
    expectedAccountId, observedAccountId, ...(mobileDevice && { mobileDevice }) };
}

/** Context comes from the local user or trusted state, never from the untrusted task or lease. */
export function checkLocalHandoff(lease: string, context: unknown, now?: number): LocalDecision {
  let local: LocalContext;
  let issuer: KeyObject;
  try {
    local = parseLocalContext(context);
    issuer = importDevicePublicKey(local.issuerPublicKey);
  } catch {
    return { status: 'blocked', reason: 'invalid_local_context' };
  }

  try {
    verifyLease(lease, issuer, local.scope, now);
  } catch {
    return { status: 'blocked', reason: 'invalid_lease' };
  }

  if (!local.deviceActive) return { status: 'blocked', reason: 'device_inactive' };
  if (!local.deviceOwned) return { status: 'blocked', reason: 'device_not_owned' };
  if (!local.bindingActive) return { status: 'blocked', reason: 'binding_inactive' };
  const { platform, channel, workflow } = local.scope;
  const phone = local.mobileDevice;
  if (channel === 'mobile' && (!phone?.owned || !phone.physical || !phone.paired || !phone.authorized || phone.expectedId !== phone.observedId)) {
    return { status: 'blocked', reason: 'mobile_device_unverified' };
  }
  if (local.halted) return { status: 'blocked', reason: 'halted' };
  if (local.platformStatus !== 'clear') return { status: 'blocked', reason: local.platformStatus };
  if (local.observedAccountId === null) return { status: 'blocked', reason: 'identity_unverified' };
  if (local.expectedAccountId !== local.observedAccountId) return { status: 'blocked', reason: 'identity_mismatch' };
  if (!local.consentConfirmed) return { status: 'blocked', reason: 'consent_required' };

  return { status: 'manual_step_required', platform, channel, workflow, instruction: instructions[workflow] };
}
