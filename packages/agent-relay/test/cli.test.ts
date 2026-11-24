import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handoffSocketPath, isHandoffMessage } from '../src/handoff.ts';
import { loadRelaySettings, parseRelayArgs, relayMain } from '../src/cli.ts';
import { RELAY_VERSION } from '../src/version.ts';

const token = `ss_command_${'b'.repeat(64)}`;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function relayDir(t: TestContext, config: Record<string, unknown> | undefined, credential = token, mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-relay-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'agent-relay'));
  if (config) await writeFile(join(dir, 'agent-relay', 'config.json'), JSON.stringify(config));
  await writeFile(join(dir, 'agent-relay', 'credential'), `${credential}\n`, { mode });
  await chmod(join(dir, 'agent-relay', 'credential'), mode);
  return join(dir, 'agent-relay');
}

test('the command line accepts --mcp-relay, --config, --hub and --token-file, and nothing else', () => {
  assert.deepEqual(parseRelayArgs(['--mcp-relay', '--config', '/a/config.json']), { config: '/a/config.json' });
  assert.deepEqual(parseRelayArgs(['--hub=https://hub.tail1.ts.net', '--token-file', '/t']), { hub: 'https://hub.tail1.ts.net', tokenFile: '/t' });
  assert.throws(() => parseRelayArgs(['--hub']), /needs a value/);
  assert.throws(() => parseRelayArgs(['--verbose']), /Unknown option/);
});

test('App mode reads config.json and the 0600 credential beside it; refuses non-https hubs and loose permissions', async t => {
  const dir = await relayDir(t, { hub_origin: 'https://hub.tail1234.ts.net', workspace_id: 'w', connection_id: 'c', client: 'codex' });
  const settings = await loadRelaySettings([], { defaultConfigPath: join(dir, 'config.json') });
  assert.deepEqual([settings.hubOrigin, settings.token, settings.dataDir], ['https://hub.tail1234.ts.net', token, dir]);
  const override = await loadRelaySettings(['--config', join(dir, 'config.json'), '--hub', 'http://127.0.0.1:3401']);
  assert.equal(override.hubOrigin, 'http://127.0.0.1:3401');
  const insecure = await relayDir(t, { hub_origin: 'http://hub.tail1234.ts.net' });
  await assert.rejects(loadRelaySettings(['--config', join(insecure, 'config.json')]), /https/);
  if (process.platform !== 'win32') {
    const loose = await relayDir(t, { hub_origin: 'https://hub.tail1234.ts.net' }, token, 0o644);
    await assert.rejects(loadRelaySettings(['--config', join(loose, 'config.json')]), /chmod 600/);
  }
  const garbage = await relayDir(t, { hub_origin: 'https://hub.tail1234.ts.net' }, 'not-a-token');
  await assert.rejects(loadRelaySettings(['--config', join(garbage, 'config.json')]), /agent token/);
  await assert.rejects(loadRelaySettings(['--hub', 'https://hub.tail1234.ts.net']), /--token-file/);
  // Exit code 2 and a zh-Hant hint on stderr, nothing on stdout.
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errors = '';
  stderr.on('data', chunk => { errors += chunk; });
  let out = '';
  stdout.on('data', chunk => { out += chunk; });
  assert.equal(await relayMain({ argv: ['--config', join(insecure, 'config.json')], stdin: new PassThrough(), stdout, stderr }), 2);
  assert.match(errors, /中樞位址必須是 https/);
  assert.equal(out, '');
});

test('handoff socket paths and messages follow C12', () => {
  assert.equal(handoffSocketPath('/Users/me/Library/Application Support/SmartSell Worker/agent-relay', 'darwin'),
    '/Users/me/Library/Application Support/SmartSell Worker/agent-relay/ipc.sock');
  assert.equal(handoffSocketPath('C:\\Users\\me\\AppData', 'win32', 'me'), '\\\\.\\pipe\\smartsell-agent-me');
  const message = { type: 'handoff', upload_id: '0b8e6c2a-1f7d-4c39-9a51-6f0c2d7e8a11', path: '/Users/me/Movies/video.mp4', sha256: 'a'.repeat(64), bytes: 10, mtime_ms: 1 };
  assert.equal(isHandoffMessage(message), true);
  assert.equal(isHandoffMessage({ ...message, extra: 1 }), false);
  assert.equal(isHandoffMessage({ ...message, path: 'relative.mp4' }), false);
  assert.equal(isHandoffMessage({ ...message, sha256: 'xyz' }), false);
});

test('the esbuild bundle is one zero-dependency file that Node runs as the relay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-relay-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = join(dir, 'smartsell-relay.mjs');
  const build = spawnSync(process.execPath, [join(packageRoot, 'scripts', 'build.mjs'), '--outfile', outfile], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const source = await readFile(outfile, 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env node\n'));
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm), ...source.matchAll(/\bimport\("([^"]+)"\)/g)].map(match => match[1]);
  assert.ok(imports.length > 0 && imports.every(name => name.startsWith('node:')), `non-builtin imports: ${imports.filter(name => !name.startsWith('node:'))}`);
  assert.equal(spawnSync(process.execPath, [outfile, '--version'], { encoding: 'utf8' }).stdout.trim(), RELAY_VERSION);
  assert.equal(spawnSync(process.execPath, [join(packageRoot, 'bin', 'smartsell-relay.mjs'), '--version'], { encoding: 'utf8' }).stdout.trim(), RELAY_VERSION);

  // The bundle forwards an initialize to a hub and relays the answer over stdio.
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'smartsell', version: '0.1.0' }, capabilities: {} } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const credential = join(dir, 'token');
  await writeFile(credential, token, { mode: 0o600 });
  const child = spawn(process.execPath, [outfile, '--hub', `http://127.0.0.1:${(server.address() as { port: number }).port}`, '--token-file', credential]);
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'c', version: '1' }, capabilities: {} } })}\n`);
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.trim()).result.serverInfo.name, 'smartsell');
});
