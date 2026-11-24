// Usage: node tests/connector-desktop/package-smoke.mjs '/path/to/SmartSell Worker.app' [--unsigned]
// (Launches the App with a window; a manual check on a desktop session. The headless check of a built package is
// `"<App>" --smoke --smartsell-user-data=<tmp> --smoke-out=<tmp>/report.json` (exit 0 when every check passes).)
// --unsigned: packages from `pnpm worker:release` are ad-hoc signed at most, so the Developer ID signature check is skipped.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const bundle = resolve(process.argv[2] ?? '');
const unsigned = process.argv.includes('--unsigned');
assert(process.platform === 'darwin' && bundle.endsWith('.app'), 'Pass a local macOS .app bundle');
const contents = join(bundle, 'Contents');
const archive = join(contents, 'Resources', 'app.asar');
const asar = resolve(import.meta.dirname, '../../apps/connector-desktop/node_modules/.bin/asar');
const temp = await mkdtemp(join(tmpdir(), 'smartsell-native-smoke-'));
let child;
try {
  if (!unsigned) execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const files = execFileSync(asar, ['list', archive], { encoding: 'utf8' }).trim().split('\n');
  for (const name of ['main.cjs', 'preload.cjs', 'ui/index.html', 'ui/renderer.js', 'ui/styles.css', 'smartsell-install-skills.mjs']) {
    assert(files.includes(`/dist/${name}`), `Missing app.asar resource: ${name}`);
  }
  const installer = join(`${archive}.unpacked`, 'dist', 'smartsell-install-skills.mjs');
  const project = join(temp, 'operations project');
  await mkdir(project);
  const install = () => execFileSync(process.execPath, [installer, project], { encoding: 'utf8' });
  assert.equal(install().match(/已安装：/g)?.length, 6);
  for (const client of ['.claude', '.agents']) for (const name of ['smartsell-video-publish', 'smartsell-product-listing', 'smartsell-data-collection']) {
    const installed = await readFile(join(project, client, 'skills', name, 'SKILL.md'));
    assert.deepEqual(installed, await readFile(new URL(`../../apps/connector-desktop/skills/${name}/SKILL.md`, import.meta.url)));
  }
  assert.equal(install().match(/已存在，保留：/g)?.length, 6);
  console.log('Native package signature, six app.asar resources, canonical Skills bytes and non-overwriting reinstall verified');

  const windowProbe = join(temp, 'window.swift');
  await writeFile(windowProbe, `
import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let deadline = Date().addingTimeInterval(20)
while Date() < deadline {
  let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  if let window = all.first(where: { entry in
    guard entry[kCGWindowOwnerPID as String] as? Int == pid,
          entry[kCGWindowLayer as String] as? Int == 0,
          let bounds = entry[kCGWindowBounds as String] as? [String: Double] else { return false }
    return (bounds["Width"] ?? 0) >= 640 && (bounds["Height"] ?? 0) >= 520
  }) {
    let bounds = window[kCGWindowBounds as String] as! [String: Double]
    print("On-screen native window for launched PID: \\(bounds["Width"]!) x \\(bounds["Height"]!)")
    exit(0)
  }
  Thread.sleep(forTimeInterval: 0.2)
}
exit(1)
`);
  const executable = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(contents, 'Info.plist')], { encoding: 'utf8' }).trim();
  assert(executable && basename(executable) === executable);
  const profile = join(temp, 'user-data');
  await mkdir(profile);
  child = spawn(join(contents, 'MacOS', executable), [
    `--user-data-dir=${profile}`, '--use-mock-keychain', '--disable-background-networking', '--no-proxy-server',
  ], { stdio: 'ignore' });
  await once(child, 'spawn');
  const result = execFileSync('/usr/bin/swift', [windowProbe, String(child.pid)], { encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' });
  assert.match(result, /On-screen native window/);
  await assert.rejects(readFile(join(profile, 'pairing.enc')), { code: 'ENOENT' });
  console.log(result.trim());
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  await rm(temp, { recursive: true, force: true });
}
