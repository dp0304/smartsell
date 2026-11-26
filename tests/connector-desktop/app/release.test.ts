// §10.1 S9: `package.mjs --unsigned` configuration (no signing requirement, no update feed); §8.18 worker:release
// manifests exactly as S1 serves them; E8: hub:init / hub:update / install-hub build the relay bundle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { builderConfig, EXTRA_RESOURCES, hostTarget } from '../../../apps/connector-desktop/scripts/package-config.mjs';
import { releasePublicKey as configReleaseKey } from '../../../apps/connector-desktop/scripts/config.mjs';
import { encodeReleasePublicKey, releaseSignaturePayload, signRelease, verifyReleaseSignature } from '../../../apps/connector-desktop/src/release-signature.ts';
import { choosePackage, defaultOutDir, defaultSigningKeyPath, loadSigningKey, manifestFor, MANIFEST_KEYS, parseReleaseArgs, publishRelease, releasePlatforms } from '../../../scripts/worker-release.mjs';
import { inspectWorkerRelease } from '../../../apps/server/src/worker-downloads.ts';
import { hubInit } from '../../../apps/server/src/hub/init.ts';
import { updateMain } from '../../../apps/server/src/hub/update.ts';
import type { Exec } from '../../../apps/server/src/hub/exec.ts';

const repoRoot = join(import.meta.dirname, '../../..');

test('unsigned macOS config: ad-hoc signature only, no forced signing, no notarization, no publish/update feed, dmg+zip per arch', () => {
  const config = builderConfig({ target: 'mac', unsigned: true, arch: 'arm64', output: '/out', release: {} });
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.publish, null);
  assert.equal(config.mac.identity, '-', 'ad-hoc: arm64 binaries must carry a signature to launch; no Developer ID');
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.mac.notarize, false);
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }]);
  assert.equal(config.dmg.sign, false);
  assert.equal(config.productName, 'SmartSell Worker');
  assert.equal(config.appId, 'com.smartsell.worker');
  assert.deepEqual(config.extraMetadata, { smartsell: { unsigned: true, release_packaged: true } });
  assert.deepEqual(config.extraResources, EXTRA_RESOURCES);
  assert.ok(EXTRA_RESOURCES.some(item => item.filter.includes('test-clip.mp4')));
  assert.equal(config.electronFuses.runAsNode, false, 'relay mode must go through --mcp-relay, never ELECTRON_RUN_AS_NODE');
  assert.equal(JSON.stringify(config).includes('feed'), false);
  assert.deepEqual(builderConfig({ target: 'mac', unsigned: true, output: '/o' }).mac.target[0].arch, ['arm64', 'x64']);
  assert.throws(() => builderConfig({ target: 'mac', unsigned: true, output: '/o', release: { update: { feed: 'https://u.example/feed' } } }), /update feed/);
});

test('unsigned Windows NSIS config (validated here; built only on Windows)', () => {
  const config = builderConfig({ target: 'win', unsigned: true, output: 'C:\\out' });
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.win.verifyUpdateCodeSignature, false);
  assert.equal(config.win.signtoolOptions, undefined);
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.publish, null);
  assert.deepEqual(config.nsis, {
    oneClick: true, perMachine: false, allowElevation: false, runAfterFinish: true, deleteAppDataOnUninstall: false, differentialPackage: false,
    artifactName: 'SmartSell-Worker-${version}-win-x64.${ext}', shortcutName: 'SmartSell Worker', uninstallDisplayName: 'SmartSell Worker',
  });
  assert.equal(hostTarget('win32'), 'win');
  assert.equal(hostTarget('linux'), null);
  const signed = builderConfig({ target: 'win', unsigned: false, output: 'o', release: { update: { feed: 'https://u.example/f', publisher: 'CN=x, O=y' } }, winPublisher: 'CN=x, O=y' });
  assert.equal(signed.forceCodeSigning, true, 'the Phase 7 signed path keeps requiring a signature');
});

test('build.mjs --packaged refuses an update feed (unsigned builds have none)', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'apps/connector-desktop/scripts/build.mjs'), '--packaged'],
    { cwd: join(repoRoot, 'apps/connector-desktop'), env: { ...process.env, SMARTSELL_UPDATE_FEED: 'https://updates.example.test/feed.json' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no update feed/);
});

test('worker:release arguments, host platforms and the default output directory', () => {
  assert.deepEqual(parseReleaseArgs(['--out', '/tmp/x', '--arch', 'arm64']).arch, 'arm64');
  assert.throws(() => parseReleaseArgs(['--arch', 'ia32']), /arm64 or x64/);
  assert.throws(() => parseReleaseArgs(['--nope']), /Unknown option/);
  assert.deepEqual(releasePlatforms('darwin', { win: false, arch: null }), ['mac-arm64', 'mac-x64']);
  assert.deepEqual(releasePlatforms('win32', { win: true, arch: null }), ['win-x64']);
  assert.throws(() => releasePlatforms('darwin', { win: true, arch: null }), /只能在 Windows 機器上建置/);
  assert.deepEqual(defaultOutDir({ env: { SMARTSELL_HUB_DIR: '/hub' }, exists: path => path === '/hub/hub.env', repoRoot: '/repo' }), { dir: '/hub/worker-downloads', onHub: true });
  assert.deepEqual(defaultOutDir({ env: { SMARTSELL_HUB_DIR: '/hub' }, exists: () => false, repoRoot: '/repo' }), { dir: '/repo/dist/worker-release', onHub: false });
});

test('worker:release writes latest-<platform>.json with exactly {version, platform, file, sha256, bytes, built_at, signature}, accepted by the hub', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'staging'));
  const dmg = join(dir, 'staging', 'SmartSell-Worker-0.2.0-mac-arm64.dmg');
  const zip = join(dir, 'staging', 'SmartSell-Worker-0.2.0-mac-arm64.zip');
  writeFileSync(dmg, 'dmg bytes');
  writeFileSync(zip, 'zip bytes!');
  const artifacts = [{ path: zip, arch: 'arm64', platform: 'mac-arm64' }, { path: dmg, arch: 'arm64', platform: 'mac-arm64' }];
  assert.equal(choosePackage(artifacts, 'mac-arm64')?.path, dmg, 'the manifest names the dmg on macOS');
  const out = join(dir, 'out');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await assert.rejects(publishRelease({ outDir: out, artifacts, platforms: ['mac-arm64'], version: '0.2.0' } as never), /signing key/, 'S1: never unsigned');
  const [written] = await publishRelease({ outDir: out, artifacts, platforms: ['mac-arm64'], version: '0.2.0', signingKey: privateKey, now: () => new Date('2026-11-24T08:00:00Z') });
  const manifest = JSON.parse(readFileSync(join(out, 'latest-mac-arm64.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest), MANIFEST_KEYS);
  const sha256 = createHash('sha256').update('dmg bytes').digest('hex');
  assert.deepEqual(manifest, { version: '0.2.0', platform: 'mac-arm64', file: 'SmartSell-Worker-0.2.0-mac-arm64.dmg',
    sha256, bytes: 9, built_at: '2026-11-24T08:00:00.000Z', signature: manifest.signature });
  assert.deepEqual(verifyReleaseSignature({ version: '0.2.0', platform: 'mac-arm64', sha256 }, manifest.signature, encodeReleasePublicKey(publicKey)), { ok: true });
  assert.equal(written.manifest.sha256, manifest.sha256);
  assert.deepEqual(readdirSync(out).sort(), ['SmartSell-Worker-0.2.0-mac-arm64.dmg', 'SmartSell-Worker-0.2.0-mac-arm64.zip', 'latest-mac-arm64.json']);
  const inspected = await inspectWorkerRelease(out, 'mac-arm64');
  assert.equal(inspected.status, 'ok', JSON.stringify(inspected));
  assert.equal(inspected.status === 'ok' && inspected.release.signature, manifest.signature, 'the hub passes the signature through');
  assert.throws(() => manifestFor({ version: 'v1', platform: 'mac-arm64', file: 'a.dmg', sha256: 'a'.repeat(64), bytes: 1, builtAt: 'x' }), /major\.minor\.patch/);
  assert.throws(() => manifestFor({ version: '0.2.0', platform: 'mac-arm64', file: '../a.dmg', sha256: 'a'.repeat(64), bytes: 1, builtAt: 'x' }), /without a path/);
  await assert.rejects(publishRelease({ outDir: out, artifacts: [], platforms: ['mac-x64'], version: '0.2.0', signingKey: privateKey }), /沒有產生 mac-x64/);
});

// ---------- S1: Ed25519 release signature ----------

test('release signature: canonical bytes, round trip, and every tampered field is rejected', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = encodeReleasePublicKey(publicKey);
  const fields = { version: '0.2.1', platform: 'mac-arm64', sha256: 'a'.repeat(64) };
  assert.equal(releaseSignaturePayload(fields).toString('utf8'), `{"platform":"mac-arm64","sha256":"${'a'.repeat(64)}","version":"0.2.1"}`,
    'RFC 8785 form: sorted keys, no whitespace');
  assert.equal(releaseSignaturePayload({ sha256: 'a'.repeat(64), version: '0.2.1', platform: 'mac-arm64' }).equals(releaseSignaturePayload(fields)), true,
    'the input key order does not matter');
  const signature = signRelease(fields, privateKey);
  assert.match(signature, /^[A-Za-z0-9+/]{86}==$/);
  assert.deepEqual(verifyReleaseSignature(fields, signature, key), { ok: true });
  assert.deepEqual(verifyReleaseSignature(fields, signature, publicKey.export({ format: 'pem', type: 'spki' }).toString()), { ok: true }, 'PEM works too');
  assert.deepEqual(verifyReleaseSignature({ ...fields, sha256: 'b'.repeat(64) }, signature, key), { ok: false, reason: 'invalid' }, 'tampered sha256');
  assert.deepEqual(verifyReleaseSignature({ ...fields, version: '9.9.9' }, signature, key), { ok: false, reason: 'invalid' }, 'tampered version');
  assert.deepEqual(verifyReleaseSignature({ ...fields, platform: 'mac-x64' }, signature, key), { ok: false, reason: 'invalid' }, 'another platform');
  assert.deepEqual(verifyReleaseSignature(fields, undefined, key), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyReleaseSignature(fields, null, key), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyReleaseSignature(fields, 'not base64', key), { ok: false, reason: 'malformed' });
  const flipped = Buffer.from(signature, 'base64');
  flipped[10] ^= 1;
  assert.deepEqual(verifyReleaseSignature(fields, flipped.toString('base64'), key), { ok: false, reason: 'invalid' });
  const other = encodeReleasePublicKey(generateKeyPairSync('ed25519').publicKey);
  assert.deepEqual(verifyReleaseSignature(fields, signature, other), { ok: false, reason: 'invalid' }, 'signed by another key');
  assert.deepEqual(verifyReleaseSignature(fields, signature, 'garbage!'), { ok: false, reason: 'bad_key' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.deepEqual(verifyReleaseSignature(fields, signature, rsa), { ok: false, reason: 'bad_key' }, 'only Ed25519');
  assert.deepEqual(verifyReleaseSignature({ ...fields, platform: 'linux' }, signature, key), { ok: false, reason: 'bad_fields' });
  assert.throws(() => signRelease({ ...fields, sha256: 'XYZ' }, privateKey), /sha256/);
  assert.throws(() => signRelease(fields, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), /Ed25519/);
});

test('release signing key: created once under ~/.smartsell with mode 0600 and reused; never inside the repo', t => {
  const home = mkdtempSync(join(tmpdir(), 'smartsell-release-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = defaultSigningKeyPath(home);
  assert.equal(path, join(home, '.smartsell', 'worker-release-key.pem'));
  const first = loadSigningKey({ env: {}, home });
  assert.equal(first.path, path);
  assert.equal(first.created, true);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
  const again = loadSigningKey({ env: {}, home });
  assert.equal(again.created, false);
  assert.equal(again.publicKey, first.publicKey, 'the same key is reused next time');
  const fields = { version: '0.2.1', platform: 'win-x64', sha256: 'c'.repeat(64) };
  assert.deepEqual(verifyReleaseSignature(fields, signRelease(fields, again.privateKey), first.publicKey), { ok: true });

  const explicit = join(home, 'elsewhere.pem');
  writeFileSync(explicit, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const fromEnv = loadSigningKey({ env: { SMARTSELL_RELEASE_SIGNING_KEY: explicit }, home });
  assert.equal(fromEnv.path, explicit);
  assert.notEqual(fromEnv.publicKey, first.publicKey);
  assert.throws(() => loadSigningKey({ env: { SMARTSELL_RELEASE_SIGNING_KEY: join(home, 'missing.pem') }, home }), /不存在/);
  assert.equal(existsSync(join(home, 'missing.pem')), false, 'a configured path is never created');
  if (process.platform !== 'win32') {
    chmodSync(explicit, 0o644);
    assert.throws(() => loadSigningKey({ env: { SMARTSELL_RELEASE_SIGNING_KEY: explicit }, home }), /chmod 600/);
  }
  assert.throws(() => loadSigningKey({ env: { SMARTSELL_RELEASE_SIGNING_KEY: join(repoRoot, 'key.pem') }, home }), /不可放在原始碼資料夾內/);
  assert.throws(() => loadSigningKey({ env: {}, home: join(repoRoot, 'tmp-home') }), /不可放在原始碼資料夾內/);
  assert.equal(existsSync(join(repoRoot, 'tmp-home')), false);
  const rsa = join(home, 'rsa.pem');
  writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  assert.throws(() => loadSigningKey({ env: { SMARTSELL_RELEASE_SIGNING_KEY: rsa }, home }), /Ed25519/);
});

test('build config: SMARTSELL_RELEASE_PUBLIC_KEY becomes RELEASE.releasePublicKey (base64 SPKI); anything but Ed25519 is refused', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = encodeReleasePublicKey(publicKey);
  assert.equal(configReleaseKey(der), der);
  assert.equal(configReleaseKey(publicKey.export({ format: 'pem', type: 'spki' }).toString()), der, 'PEM is normalised');
  assert.equal(configReleaseKey(undefined), undefined);
  assert.equal(configReleaseKey('  '), undefined);
  assert.throws(() => configReleaseKey('not a key'), /Ed25519/);
  assert.throws(() => configReleaseKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64')), /Ed25519/);
});

// ---------- E8: relay bundle in hub:init, hub:update and install-hub ----------

function scripted(rules: [string, number][]) {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    const rule = rules.find(([fragment]) => line.includes(fragment));
    // E45: hub:update records the current commit (git rev-parse HEAD) so a failed update can return to it.
    return { code: rule ? rule[1] : 0, stdout: line.endsWith('rev-parse HEAD') ? 'a'.repeat(40) : line.includes('serve status') ? JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'hub.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3401' } } } } })
      : line.endsWith('status --json') ? JSON.stringify({ BackendState: 'Running', CertDomains: ['hub.tail1234.ts.net'], Self: { DNSName: 'hub.tail1234.ts.net.', HostName: 'hub' } }) : '', stderr: '' };
  };
  return { exec, calls };
}

test('hub:init builds the relay bundle; a failure is a warning (GET /agent/relay.mjs answers 503 until fixed)', async t => {
  const hubDir = mkdtempSync(join(tmpdir(), 'smartsell-hubinit-'));
  t.after(() => rmSync(hubDir, { recursive: true, force: true }));
  const { exec, calls } = scripted([['@smartsell/agent-relay build', 1]]);
  const lines: string[] = [];
  const result = await hubInit({ hubDir, skipWebBuild: true, workerRelease: false, service: false },
    { env: { SMARTSELL_TAILSCALE_CLI: '/fake/ts' }, platform: 'darwin', exec, exists: path => path === '/fake/ts', log: line => lines.push(line), repoRoot: hubDir });
  assert.equal(result.ok, true, lines.join('\n'));
  assert.ok(calls.includes('pnpm --filter @smartsell/agent-relay build'));
  assert.match(lines.join('\n'), /relay 建置失敗.*RELAY_BUNDLE_MISSING/);
});

test('hub:update builds the relay after install and never restarts when that build fails', async t => {
  const hubDir = mkdtempSync(join(tmpdir(), 'smartsell-hubupd-'));
  t.after(() => rmSync(hubDir, { recursive: true, force: true }));
  const { exec, calls } = scripted([['@smartsell/agent-relay build', 1]]);
  const lines: string[] = [];
  const code = await updateMain(['--hub-dir', hubDir, '--skip-pull'], { exec, platform: 'darwin', repo: hubDir, home: hubDir, uid: 501, daemonInstalled: () => false, log: line => lines.push(line) });
  assert.equal(code, 1);
  assert.ok(calls.indexOf('pnpm install --frozen-lockfile') < calls.indexOf('pnpm --filter @smartsell/agent-relay build'));
  assert.ok(!calls.some(line => line.includes('kickstart') || line.includes('vite build')), calls.join('\n'));
  assert.match(lines.join('\n'), /中樞服務沒有重新啟動，舊版本繼續執行/);
});

test('install-hub.sh and install-hub.ps1 build the relay bundle (ps1 keeps its UTF-8 BOM)', () => {
  const sh = readFileSync(join(repoRoot, 'scripts/install-hub.sh'), 'utf8');
  assert.match(sh, /-- pnpm --filter @smartsell\/agent-relay build/);
  assert.equal(spawnSync('bash', ['-n', join(repoRoot, 'scripts/install-hub.sh')]).status, 0);
  const ps1 = readFileSync(join(repoRoot, 'scripts/install-hub.ps1'));
  assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(ps1.toString('utf8').includes("'pnpm' @('--filter', '@smartsell/agent-relay', 'build')"));
});
