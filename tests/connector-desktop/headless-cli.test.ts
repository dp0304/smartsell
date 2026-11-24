// The headless runner command line (§8.14, interface C10) as S8 spawns it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FileVault } from '../../apps/connector-desktop/src/headless/file-vault.ts';
import { parseArgs } from '../../apps/connector-desktop/src/headless/runner.ts';
import { startFakeHub } from './fakes/fake-hub.ts';

const runner = resolve('apps/connector-desktop/src/headless/runner.ts');

test('arguments follow §8.14', () => {
  assert.deepEqual(parseArgs(['--data-dir', '/tmp/w1', '--name', 'Mac-B', 'pair', '--hub', 'http://127.0.0.1:4401', '--workspace', 'ws', '--code', 'c']),
    { dataDir: '/tmp/w1', name: 'Mac-B', command: 'pair', options: { 'data-dir': '/tmp/w1', name: 'Mac-B', hub: 'http://127.0.0.1:4401', workspace: 'ws', code: 'c' } });
  assert.equal(parseArgs(['--data-dir', '/tmp/w1', 'run', '--dry-run']).options['dry-run'], true);
  assert.throws(() => parseArgs(['--data-dir', '/tmp/w1', 'publish']));
});

test('the runner refuses outside test mode and without local fixture origins', () => {
  const base = { ...process.env, SMARTSELL_TEST_MODE: '', SMARTSELL_TEST_PLATFORM_ORIGINS: '' };
  const outside = spawnSync(process.execPath, ['--import', 'tsx', runner, '--data-dir', '/tmp/none', 'run'], { env: base, encoding: 'utf8' });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stdout, /SMARTSELL_TEST_MODE=1/);
  const noOrigins = spawnSync(process.execPath, ['--import', 'tsx', runner, '--data-dir', '/tmp/none', 'run'], { env: { ...base, SMARTSELL_TEST_MODE: '1' }, encoding: 'utf8' });
  assert.match(noOrigins.stdout, /SMARTSELL_TEST_PLATFORM_ORIGINS/);
  assert.throws(() => new FileVault('/tmp/none', { SMARTSELL_TEST_MODE: '' }), /test-only/);
});

test('run connects with heartbeat v2, logs JSON lines and stops cleanly on SIGTERM', async () => {
  const hub = await startFakeHub();
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-cli-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    hub.addDevice('dev-cli', publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), 'Win-C');
    new FileVault(dir, { SMARTSELL_TEST_MODE: '1' }).save({ origin: hub.origin, workspace_id: hub.workspaceId, device_id: 'dev-cli',
      private_key_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), machine_name: 'Win-C', paired_at: new Date().toISOString() });
    const child = spawn(process.execPath, ['--import', 'tsx', runner, '--data-dir', dir, 'run'], {
      env: { ...process.env, SMARTSELL_TEST_MODE: '1', SMARTSELL_TEST_PLATFORM_ORIGINS: JSON.stringify({ x: 'http://127.0.0.1:9/x', tiktok: 'http://127.0.0.1:9/tiktok' }) },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !hub.log.some(entry => entry.action === 'heartbeat' && entry.status === 200)) await new Promise(done => setTimeout(done, 100));
    assert.ok(hub.log.some(entry => entry.action === 'heartbeat' && entry.status === 200), output);
    child.kill('SIGTERM');
    await new Promise(done => child.once('exit', done));
    const lines = output.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(lines.some(line => line.event === 'started'));
    assert.ok(lines.some(line => line.event === 'connection' && line.detail.state === 'online'));
    assert.equal(lines.at(-1).event, 'stopped');
  } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }); }
});
