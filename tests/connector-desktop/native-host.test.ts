// Native messaging host registration and the bridge framing (core-automation-proposal §3.2). The host is a byte relay,
// so Chrome's framing (32-bit little-endian length + JSON) is what the bridge speaks; Windows registration is checked
// with a recorded `reg` call because this suite also runs on macOS and Linux.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bridgeSocketPath, encodeFrame, FrameReader } from '../../apps/connector-desktop/src/browser-bridge/bridge.ts';
import { chromeHostDirs, EXTENSION_IDS, NATIVE_HOST_NAME, posixWrapper, registerNativeHost, unregisterNativeHost, windowsRelay } from '../../apps/connector-desktop/src/browser-bridge/native-host.ts';

const extensionManifest = JSON.parse(readFileSync(new URL('../../apps/connector-desktop/extension/manifest.json', import.meta.url), 'utf8'));

test('the allowed extension id is the one fixed by the manifest key', async () => {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(Buffer.from(extensionManifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...digest].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
  assert.deepEqual(EXTENSION_IDS, [id]);
  assert.deepEqual(extensionManifest.permissions.sort(), ['alarms', 'debugger', 'nativeMessaging', 'storage', 'tabs'], 'no host permissions, no scripting');
});

test('POSIX: wrapper execs nc -U on the bridge socket (quoted), manifest allows only the SmartSell extension', async t => {
  const dir = mkdtempSync(join(tmpdir(), "ss-host-'quote'-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = bridgeSocketPath(dir, 'darwin');
  const hostDir = join(dir, 'Chrome', 'NativeMessagingHosts');
  const result = await registerNativeHost({ dataDir: dir, socketPath, platform: 'darwin', hostDirs: [hostDir] });
  const manifest = JSON.parse(readFileSync(join(hostDir, `${NATIVE_HOST_NAME}.json`), 'utf8'));
  assert.deepEqual(manifest, { name: 'com.smartsell.worker', description: manifest.description, path: result.wrapper, type: 'stdio',
    allowed_origins: ['chrome-extension://ghfcogpklmadimibmifjhfhlcncpcncp/'] });
  const wrapper = readFileSync(result.wrapper, 'utf8');
  assert.equal(wrapper, posixWrapper(socketPath));
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.ok(wrapper.includes(`'${socketPath.replaceAll("'", `'\\''`)}'`), 'the socket path is single-quoted with quotes escaped');
  assert.equal(statSync(result.wrapper).mode & 0o777, 0o700);
  await unregisterNativeHost({ dataDir: dir, platform: 'darwin', hostDirs: [hostDir] });
  assert.throws(() => statSync(join(hostDir, `${NATIVE_HOST_NAME}.json`)));
});

test('a long data dir falls back to a short socket path (macOS sun_path is 104 bytes); Windows uses a named pipe', () => {
  const long = join(tmpdir(), 'x'.repeat(120));
  assert.ok(Buffer.byteLength(bridgeSocketPath(long, 'darwin')) <= 100);
  assert.equal(bridgeSocketPath('/short', 'darwin'), '/short/browser.sock');
  assert.match(bridgeSocketPath('C:\\Users\\me\\AppData\\Roaming\\SmartSell Worker', 'win32'), /^\\\\\.\\pipe\\smartsell-worker-[0-9a-f]{16}$/);
});

test('Windows: a .cmd wrapper runs the PowerShell pipe relay; HKCU keys for Chrome and Chromium point at the manifest', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-host-win-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: string[][] = [];
  const pipe = bridgeSocketPath(dir, 'win32');
  const result = await registerNativeHost({ dataDir: dir, socketPath: pipe, platform: 'win32', reg: async args => { calls.push(args); } });
  assert.match(result.wrapper, /smartsell-native-host\.cmd$/);
  assert.match(readFileSync(result.wrapper, 'utf8'), /powershell\.exe .*-File "%~dp0smartsell-native-host\.ps1"/);
  const relay = readFileSync(join(dir, 'native-host', 'smartsell-native-host.ps1'), 'utf8');
  assert.equal(relay, windowsRelay(pipe));
  assert.ok(relay.includes(`'${pipe.replace(/^\\\\\.\\pipe\\/, '')}'`));
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['add', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.smartsell.worker'],
    ['add', 'HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.smartsell.worker']]);
  assert.deepEqual(calls[0].slice(2), ["/ve", "/t", "REG_SZ", "/d", result.manifests[0], "/f"]);
});

test('Chrome host folders per platform', () => {
  assert.equal(chromeHostDirs('darwin', '/Users/me')[0], '/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts');
  assert.equal(chromeHostDirs('linux', '/home/me', {})[0], '/home/me/.config/google-chrome/NativeMessagingHosts');
  assert.deepEqual(chromeHostDirs('win32', 'C:\\Users\\me'), []);
});

test('framing: split chunks, several frames per chunk, and an oversized frame closes the reader', () => {
  const reader = new FrameReader(1024);
  const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: '中文' })]);
  assert.deepEqual([...reader.push(bytes.subarray(0, 3)), ...reader.push(bytes.subarray(3, 9)), ...reader.push(bytes.subarray(9))], [{ a: 1 }, { b: '中文' }]);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(4096, 0);
  assert.throws(() => new FrameReader(1024).push(header), /above the limit/);
});
