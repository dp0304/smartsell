import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  createDeviceChallenge, exportDevicePublicKey, importDevicePublicKey,
  signDeviceProof, signLease, verifyDeviceProof, verifyLease,
  type DeviceChallengeScope, type LeaseClaims, type LeaseScope,
} from '@smartsell/connector-tasks';
import { checkLocalHandoff, createPairingProof, type LocalContext } from '../src/index.js';

const issuer = generateKeyPairSync('ed25519');
const device = generateKeyPairSync('ed25519');
const at = 1_800_000_000;
const scope: LeaseScope = {
  tenantId: 'tenant-1', workspaceId: 'workspace-1', bindingId: 'binding-1', deviceId: 'device-1',
  platform: 'tiktok', workflow: 'manual_handoff', jobId: 'job-1', channel: 'browser',
};
const claims: LeaseClaims = { ...scope, jti: 'claim-1', iat: at, exp: at + 10 };
const local: LocalContext = {
  issuerPublicKey: exportDevicePublicKey(issuer.publicKey), scope,
  consentConfirmed: true, deviceActive: true, deviceOwned: true, bindingActive: true, halted: false, platformStatus: 'clear',
  expectedAccountId: 'test-account', observedAccountId: 'test-account',
};

const pairingScope: DeviceChallengeScope = {
  tenantId: scope.tenantId, workspaceId: scope.workspaceId, deviceId: scope.deviceId, purpose: 'pairing',
};

const edited = (value: string) => (value[0] === 'A' ? 'B' : 'A') + value.slice(1);

test('lease verifies against the pinned key, expected scope and time window', () => {
  const token = signLease(claims, issuer.privateKey);
  assert.deepEqual(verifyLease(token, issuer.publicKey, scope, at), claims);
  assert.throws(() => verifyLease(token, device.publicKey, scope, at), /invalid_signature/);
  assert.throws(() => verifyLease(token, issuer.publicKey, scope, at - 1), /not_yet_valid/);
  assert.throws(() => verifyLease(token, issuer.publicKey, scope, claims.exp), /expired/);
  const alternate: LeaseScope = {
    tenantId: 'tenant-2', workspaceId: 'workspace-2', bindingId: 'binding-2', deviceId: 'device-2',
    platform: 'douyin', workflow: 'official_auth', jobId: 'job-2', channel: 'mobile',
  };
  for (const key of Object.keys(scope) as (keyof LeaseScope)[]) {
    assert.throws(() => verifyLease(token, issuer.publicKey, { ...scope, [key]: alternate[key] }, at), /scope_mismatch/);
  }
  const [version, payload, signature] = token.split('.');
  assert.throws(() => verifyLease(`${version}.${edited(payload)}.${signature}`, issuer.publicKey, scope, at));
  assert.throws(() => verifyLease(`${version}.${payload}.${edited(signature)}`, issuer.publicKey, scope, at));
  assert.throws(() => verifyLease(`${token}.extra`, issuer.publicKey, scope, at));
});

test('lease schema rejects auto mode, unsupported routes, free-form fields and invalid lifetimes', () => {
  for (const invalid of [
    { ...claims, mode: 'auto' }, { ...claims, args: ['script'] }, { ...claims, workflow: 'post' },
    { ...claims, workflow: 'app_share', channel: 'browser' }, { ...claims, workflow: 'app_share', channel: 'mobile', platform: 'douyin' },
    { ...claims, platform: 'lazada' }, { ...claims, exp: at + 301 }, { ...claims, exp: at },
  ]) {
    assert.throws(() => signLease(invalid as LeaseClaims, issuer.privateKey));
  }
  assert.throws(() => signLease(claims, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey), /invalid_key/);
  assert.throws(() => importDevicePublicKey(`${local.issuerPublicKey}=`), /invalid_encoding/);
});

test('pairing requires local ownership confirmation and verifies only for the issued challenge scope and device key', () => {
  const challenge = createDeviceChallenge(pairingScope, at);
  const second = createDeviceChallenge(pairingScope, at);
  assert.notEqual(challenge.nonce, second.nonce);
  const { tenantId, workspaceId, deviceId } = pairingScope;
  const deviceScope = { tenantId, workspaceId, deviceId };
  const confirmation = { userInitiated: true, ownsDevice: true };
  assert.throws(() => createPairingProof(challenge, deviceScope, device.privateKey, { ...confirmation, userInitiated: false }, at), /confirmation_required/);
  assert.throws(() => createPairingProof(challenge, deviceScope, device.privateKey, { ...confirmation, ownsDevice: false }, at), /confirmation_required/);
  const proof = createPairingProof(challenge, deviceScope, device.privateKey, confirmation, at);
  verifyDeviceProof(challenge, proof.signature, importDevicePublicKey(proof.publicKey), pairingScope, at);
  assert.throws(() => verifyDeviceProof(second, proof.signature, device.publicKey, pairingScope, at), /invalid_signature/);
  assert.throws(() => verifyDeviceProof(challenge, proof.signature, issuer.publicKey, pairingScope, at), /invalid_signature/);
  assert.throws(() => verifyDeviceProof(challenge, proof.signature, device.publicKey, pairingScope, challenge.exp), /expired/);
  assert.throws(() => verifyDeviceProof(challenge, proof.signature, device.publicKey, { ...pairingScope, tenantId: 'tenant-2' }, at), /scope_mismatch/);
  const sessionScope = { ...pairingScope, purpose: 'session' as const };
  const session = { ...challenge, purpose: 'session' as const };
  assert.throws(() => createPairingProof(session, deviceScope, device.privateKey, confirmation, at), /scope_mismatch/);
  assert.throws(() => verifyDeviceProof(session, proof.signature, device.publicKey, sessionScope, at), /invalid_signature/);
  verifyDeviceProof(session, signDeviceProof(session, device.privateKey), device.publicKey, sessionScope, at);
});

test('local checker fails closed on invalid scope, revoked state, identity, challenge or lack of consent', () => {
  const token = signLease(claims, issuer.privateKey);
  const cases = [
    [{ issuerPublicKey: exportDevicePublicKey(device.publicKey) }, 'invalid_lease'],
    [{ scope: { ...scope, deviceId: 'device-2' } }, 'invalid_lease'],
    [{ consentConfirmed: 'true' }, 'invalid_local_context'],
    [{ script: 'arbitrary' }, 'invalid_local_context'],
    [{ deviceActive: false }, 'device_inactive'],
    [{ deviceOwned: false }, 'device_not_owned'],
    [{ deviceOwned: undefined }, 'invalid_local_context'],
    [{ bindingActive: false }, 'binding_inactive'],
    [{ halted: true }, 'halted'],
    [{ platformStatus: 'captcha' }, 'captcha'],
    [{ platformStatus: 'platform_restriction' }, 'platform_restriction'],
    [{ platformStatus: 'login_required' }, 'login_required'],
    [{ observedAccountId: null }, 'identity_unverified'],
    [{ observedAccountId: 'other' }, 'identity_mismatch'],
    [{ consentConfirmed: false }, 'consent_required'],
  ] as const;
  for (const [patch, reason] of cases) {
    assert.deepEqual(checkLocalHandoff(token, { ...local, ...patch }, at), { status: 'blocked', reason }, reason);
  }
});

const mobileDevice = { expectedId: 'phone-1', observedId: 'phone-1', owned: true, physical: true, paired: true, authorized: true };

test('mobile handoff requires the locally confirmed owned and paired phone', () => {
  const route = { ...scope, workflow: 'app_share', channel: 'mobile' } as const;
  const token = signLease({ ...claims, ...route }, issuer.privateKey);
  const ctx = { ...local, scope: route };
  assert.deepEqual(checkLocalHandoff(token, ctx, at), { status: 'blocked', reason: 'mobile_device_unverified' });
  for (const patch of [{ observedId: null }, { observedId: 'phone-2' }, { owned: false }, { physical: false }, { paired: false }, { authorized: false }]) {
    assert.deepEqual(checkLocalHandoff(token, { ...ctx, mobileDevice: { ...mobileDevice, ...patch } }, at), {
      status: 'blocked', reason: 'mobile_device_unverified',
    });
  }
  assert.deepEqual(checkLocalHandoff(token, { ...ctx, mobileDevice: { ...mobileDevice, url: 'https://example.invalid' } }, at), {
    status: 'blocked', reason: 'invalid_local_context',
  });
});

test('allowed workflow decisions require a manual step', () => {
  const routes: LeaseScope[] = [scope, { ...scope, workflow: 'official_auth' }, { ...scope, workflow: 'app_share', channel: 'mobile' }];
  for (const route of routes) {
    const token = signLease({ ...claims, ...route }, issuer.privateKey);
    const result = checkLocalHandoff(token, { ...local, scope: route, ...(route.channel === 'mobile' && { mobileDevice }) }, at);
    assert.equal(result.status, 'manual_step_required');
    assert.equal(result.workflow, route.workflow);
    assert.equal(result.channel, route.channel);
    assert.equal(result.platform, route.platform);
    assert.ok(result.instruction);
  }
});

test('CLI handles signed handoff and blocked inputs through its process entry point', t => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-connector-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'trusted.json');
  const leasePath = join(dir, 'lease.txt');
  writeFileSync(configPath, JSON.stringify(local));
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(leasePath, signLease({ ...claims, iat: now, exp: now + 60 }, issuer.privateKey));
  const script = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
  });
  const result = run('check', configPath, leasePath);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'manual_step_required');
    writeFileSync(leasePath, 'invalid');
    const blocked = run('check', configPath, leasePath);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.deepEqual(JSON.parse(blocked.stdout), { status: 'blocked', reason: 'invalid_lease' });
  } else {
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'blocked', reason: 'unsupported_desktop' });
  }
  assert.equal(run('scan', configPath, leasePath).status, 2);
});

test('standalone CLI generates a private Ed25519 key and requires a terminal before claiming', t => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-connector-key-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'device.pem');
  const script = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-transform-types', script, ...args], { encoding: 'utf8' });
  const generated = run('keygen', keyPath);
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    assert.deepEqual(JSON.parse(generated.stdout), { status: 'blocked', reason: 'unsupported_desktop' });
    return;
  }
  assert.equal(generated.status, 0, generated.stderr);
  const originalKey = readFileSync(keyPath);
  assert.equal(createPrivateKey(originalKey).asymmetricKeyType, 'ed25519');
  if (process.platform === 'darwin') assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(run('keygen', keyPath).status, 1);
  assert.deepEqual(readFileSync(keyPath), originalKey);
  const nonInteractive = run('run', join(dir, 'missing.json'), keyPath);
  assert.equal(nonInteractive.status, 1);
  assert.deepEqual(JSON.parse(nonInteractive.stdout), { status: 'blocked', reason: 'interactive_operator_required' });
});

test('offline CLI replay recovers and verifies evidence after a single synthetic submit', () => {
  const script = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const replay = (target: string) => spawnSync(process.execPath, ['--import', 'tsx', script, 'replay', target], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
  });
  for (const target of ['android', 'tiktok']) {
    const result = replay(target);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'replay_verified');
    assert.equal(report.original.kind, 'outcome_unknown');
    assert.equal(report.recovered.kind, 'result_captured');
    assert.equal(report.evidence_verified, true);
    assert.equal(report.submissions, 1);
    assert.equal(report.visibility, target === 'android' ? 'visible' : 'official_publish_id_required');
  }
  assert.equal(replay('custom-app').status, 2);
});
