import { createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fields } from './tasks.ts';

export * from './tasks.ts';

export const PUBLISH_ASSIST_WAIT_SECONDS = 30 * 60;
export const PUBLISH_RESULT_REPORT_SECONDS = 15;

export const LEASE_MAX_SECONDS = 300;
export const DEVICE_CHALLENGE_MAX_SECONDS = 300;
const LEASE_DOMAIN = 'smartsell.connector.lease.v1.';
const DEVICE_DOMAIN = 'smartsell.connector.device.v1.';

export type ConnectorPlatform = 'meta_instagram' | 'meta_facebook' | 'tiktok' | 'youtube' | 'douyin' | 'xiaohongshu';
export type ConnectorChannel = 'browser' | 'mobile';
export type ConnectorWorkflow = 'official_auth' | 'app_share' | 'manual_handoff';

export interface LeaseScope {
  tenantId: string;
  workspaceId: string;
  bindingId: string;
  platform: ConnectorPlatform;
  deviceId: string;
  workflow: ConnectorWorkflow;
  jobId: string;
  channel: ConnectorChannel;
}

export interface LeaseClaims extends LeaseScope {
  /** Server-generated unique claim identifier. Consume it atomically before accepting a result. */
  jti: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
}

export interface DeviceChallengeScope {
  tenantId: string;
  workspaceId: string;
  deviceId: string;
  purpose: 'pairing' | 'session';
}

export interface DeviceChallenge extends DeviceChallengeScope {
  nonce: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
}

const socialPlatforms: readonly string[] = ['meta_instagram', 'meta_facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu'];
const scopeKeys = ['tenantId', 'workspaceId', 'bindingId', 'platform', 'deviceId', 'workflow', 'jobId', 'channel'] as const;
const challengeScopeKeys = ['tenantId', 'workspaceId', 'deviceId', 'purpose'] as const;

/** Allowlisted handoff types. Availability on an individual account is a separate server decision. */
export function isSupportedWorkflow(platform: string, channel: string, workflow: string): boolean {
  if (!socialPlatforms.includes(platform) || (channel !== 'browser' && channel !== 'mobile')) return false;
  switch (workflow) {
    case 'official_auth': return channel === 'browser' && platform !== 'xiaohongshu';
    case 'app_share': return channel === 'mobile' && platform === 'tiktok';
    case 'manual_handoff': return channel === 'browser' || platform !== 'youtube';
    default: return false;
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    return fields(value, keys);
  } catch {
    throw new Error('invalid_fields');
  }
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new Error('invalid_identifier');
  }
  return value;
}

function parseScopeFields(obj: Record<string, unknown>): LeaseScope {
  const platform = identifier(obj.platform);
  const channel = identifier(obj.channel);
  const workflow = identifier(obj.workflow);
  if (!isSupportedWorkflow(platform, channel, workflow)) throw new Error('unsupported_workflow');
  return {
    tenantId: identifier(obj.tenantId), workspaceId: identifier(obj.workspaceId), bindingId: identifier(obj.bindingId),
    platform: platform as ConnectorPlatform, deviceId: identifier(obj.deviceId), workflow: workflow as ConnectorWorkflow,
    jobId: identifier(obj.jobId), channel: channel as ConnectorChannel,
  };
}

export function parseLeaseScope(value: unknown): LeaseScope {
  return parseScopeFields(exactObject(value, scopeKeys));
}

function unixTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_time');
  return value;
}

function parseWindow(obj: Record<string, unknown>, limit: number) {
  const iat = unixTime(obj.iat);
  const exp = unixTime(obj.exp);
  if (exp <= iat || exp - iat > limit) throw new Error('invalid_lifetime');
  return { iat, exp };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function checkWindow(window: { iat: number; exp: number }, now: number): void {
  unixTime(now);
  if (now < window.iat) throw new Error('not_yet_valid');
  if (now >= window.exp) throw new Error('expired');
}

function decodeBase64url(value: string, byteLimit: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(byteLimit * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid_encoding');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('invalid_encoding');
  return decoded;
}

function assertEd25519(key: KeyObject, type: 'public' | 'private'): void {
  if (key?.type !== type || key.asymmetricKeyType !== 'ed25519') throw new Error('invalid_key');
}

/** Public key wire representation is unpadded base64url of DER SPKI. */
export function exportDevicePublicKey(key: KeyObject): string {
  assertEd25519(key, 'public');
  return key.export({ type: 'spki', format: 'der' }).toString('base64url');
}

export function importDevicePublicKey(encoded: string): KeyObject {
  const key = createPublicKey({ key: decodeBase64url(encoded, 44), type: 'spki', format: 'der' });
  if (exportDevicePublicKey(key) !== encoded) throw new Error('invalid_key');
  return key;
}

function signMessage(domain: string, payload: string, privateKey: KeyObject): string {
  assertEd25519(privateKey, 'private');
  return sign(null, Buffer.from(domain + payload), privateKey).toString('base64url');
}

function verifyMessage(domain: string, payload: string, signature: string, publicKey: KeyObject): void {
  assertEd25519(publicKey, 'public');
  const bytes = decodeBase64url(signature, 64);
  if (bytes.length !== 64 || !verify(null, Buffer.from(domain + payload), publicKey, bytes)) {
    throw new Error('invalid_signature');
  }
}

function parseClaims(value: unknown): LeaseClaims {
  const obj = exactObject(value, [...scopeKeys, 'jti', 'iat', 'exp']);
  return { ...parseScopeFields(obj), jti: identifier(obj.jti), ...parseWindow(obj, LEASE_MAX_SECONDS) };
}

function leasePayload(claims: LeaseClaims): string {
  return Buffer.from(JSON.stringify(claims)).toString('base64url');
}

/** Sign only after checking the account binding, paired device, consent and job on the server. */
export function signLease(claims: LeaseClaims, privateKey: KeyObject): string {
  const payload = leasePayload(parseClaims(claims));
  return `v1.${payload}.${signMessage(LEASE_DOMAIN, payload, privateKey)}`;
}

/** Supply a pinned issuer key and independently established scope. This check is stateless. */
export function verifyLease(token: string, publicKey: KeyObject, expected: LeaseScope, now = nowSeconds()): LeaseClaims {
  if (typeof token !== 'string' || token.length > 2048) throw new Error('invalid_lease');
  const [version, payload, signature, ...extra] = token.split('.');
  if (version !== 'v1' || !payload || !signature || extra.length) throw new Error('invalid_lease');
  verifyMessage(LEASE_DOMAIN, payload, signature, publicKey);
  const claims = parseClaims(JSON.parse(decodeBase64url(payload, 1440).toString('utf8')));
  if (leasePayload(claims) !== payload) throw new Error('invalid_encoding');
  const scope = parseLeaseScope(expected);
  if (scopeKeys.some(key => claims[key] !== scope[key])) throw new Error('lease_scope_mismatch');
  checkWindow(claims, now);
  return claims;
}

function parseChallengeScopeFields(obj: Record<string, unknown>): DeviceChallengeScope {
  if (obj.purpose !== 'pairing' && obj.purpose !== 'session') throw new Error('invalid_purpose');
  return {
    tenantId: identifier(obj.tenantId), workspaceId: identifier(obj.workspaceId),
    deviceId: identifier(obj.deviceId), purpose: obj.purpose,
  };
}

export function createDeviceChallenge(scope: DeviceChallengeScope, now = nowSeconds()): DeviceChallenge {
  const challenge = {
    ...parseChallengeScopeFields(exactObject(scope, challengeScopeKeys)),
    nonce: randomBytes(32).toString('base64url'), iat: now, exp: now + DEVICE_CHALLENGE_MAX_SECONDS,
  };
  return parseChallenge(challenge);
}

function parseChallenge(challenge: unknown): DeviceChallenge {
  const obj = exactObject(challenge, [...challengeScopeKeys, 'nonce', 'iat', 'exp']);
  if (typeof obj.nonce !== 'string' || decodeBase64url(obj.nonce, 32).length !== 32) throw new Error('invalid_nonce');
  return {
    ...parseChallengeScopeFields(obj), nonce: obj.nonce,
    ...parseWindow(obj, DEVICE_CHALLENGE_MAX_SECONDS),
  };
}

export function assertDeviceChallengeScope(challenge: unknown, expected: DeviceChallengeScope, now = nowSeconds()): DeviceChallenge {
  const parsed = parseChallenge(challenge);
  const scope = parseChallengeScopeFields(exactObject(expected, challengeScopeKeys));
  if (challengeScopeKeys.some(key => parsed[key] !== scope[key])) throw new Error('challenge_scope_mismatch');
  checkWindow(parsed, now);
  return parsed;
}

export function signDeviceProof(challenge: DeviceChallenge, privateKey: KeyObject): string {
  return signMessage(DEVICE_DOMAIN, JSON.stringify(parseChallenge(challenge)), privateKey);
}

/** Verify against the exact server-issued challenge, then consume its nonce atomically on the server. */
export function verifyDeviceProof(
  challenge: DeviceChallenge, signature: string, publicKey: KeyObject, expected: DeviceChallengeScope, now = nowSeconds(),
): void {
  const current = assertDeviceChallengeScope(challenge, expected, now);
  verifyMessage(DEVICE_DOMAIN, JSON.stringify(current), signature, publicKey);
}
