import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fields, opaqueId, parseChoice, sha256 } from '../../../packages/connector-tasks/src/index.ts';
import { createSignedHttpTransport, pairOverHttp, SignedDeviceClient } from './device-client.ts';
import { clientVersion, matchesAndroidHardware, observeManualIdentity, parseManualTarget, runManualGatewayOnce, type ManualIO } from './manual-gateway.ts';
import { Buffer } from 'node:buffer';
import { checkLocalHandoff } from './index.ts';

import { stdin, stdout } from 'node:process';
import { createFixture, FixturePermitClient } from './fixture.ts';
import { ConnectorRun } from './workflow.ts';

const usage = `Usage: connector fixture <browser|android|ios|tiktok> <assist|auto>
       connector replay <browser|android|ios|tiktok>
       connector check <trusted-local-context.json> <signed-lease.txt>
       connector keygen <private-key.pem>
       connector pair <api-origin> <workspace-id> <desktop-name> <private-key.pem>
       connector identity <local-target.json> <private-key.pem>
       connector phone <local-phone.json> <private-key.pem> <model> <serial-suffix> <android-version>
       connector run <local-target.json> <private-key.pem>`;

function isFixtureApp(app: string): app is Parameters<typeof createFixture>[0] {
  return app === 'browser' || app === 'android' || app === 'ios' || app === 'tiktok';
}

async function replay(args: string[]): Promise<number> {
  const [, app] = args;
  if (args.length !== 2 || !isFixtureApp(app)) {
    console.error(usage);
    return 2;
  }
  // Use a recorded synthetic host and clock so the same replay runs offline on any host.
  const now = () => Date.UTC(2026, 0, 1);
  const { claim, task, driver } = createFixture(app, 'auto', now, 'darwin');
  const permits = new FixturePermitClient(now);
  driver.failAfterSubmit = true;
  const original = new ConnectorRun(claim, driver, permits, now);
  const first = await original.advance();
  const repeated = await original.advance();
  if (first.kind !== 'outcome_unknown' || repeated.kind !== 'outcome_unknown' || driver.submissions !== 1 || permits.consumeCount !== 1) return 1;

  const capture = new ConnectorRun({ ...claim, task: { ...task, kind: 'post.capture_result', attempt_id: 'fixture-recovery',
    payload: { source_attempt_id: task.attempt_id } } }, driver, permits, now);
  const recovered = await capture.advance();
  if (recovered.kind !== 'result_captured' || recovered.evidence.length !== (task.target.channel === 'mobile' ? 2 : 1)) return 1;
  const evidenceVerified = recovered.evidence.every(ref => {
    const stored = driver.evidence.get(ref.object_id);
    return stored?.capture_context.attempt_id === task.attempt_id
      && createHash('sha256').update(stored.content).digest('hex') === ref.sha256;
  });
  if (!evidenceVerified) return 1;

  let visibility: 'visible' | 'official_publish_id_required' = 'official_publish_id_required';
  if (app !== 'tiktok') {
    const verification = new ConnectorRun({ ...claim, task: { ...task, kind: 'post.verify_visible', attempt_id: 'fixture-verify',
      payload: { source_attempt_id: task.attempt_id, platform_post_id: recovered.platform_post_id } } }, driver, permits, now);
    const verified = await verification.advance();
    if (verified.kind !== 'visibility_checked' || !verified.visible) return 1;
    visibility = 'visible';
  }
  console.log(JSON.stringify({ status: 'replay_verified', fixture: app, original: original.report(), recovered: capture.report(),
    evidence_verified: true, visibility, submissions: driver.submissions }));
  return 0;
}

async function fixture(args: string[]): Promise<number> {
  const [, app, mode] = args;
  if (args.length !== 3 || !isFixtureApp(app) || (mode !== 'assist' && mode !== 'auto')) {
    console.error(usage);
    return 2;
  }
  const { task, claim, driver } = createFixture(app, mode);
  const run = new ConnectorRun(claim, driver, new FixturePermitClient());
  const initial = await run.advance();
  console.log(JSON.stringify(initial));
  if (initial.kind === 'awaiting_user_click' && stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question('Type publish to confirm the local fixture submission: ', { signal: AbortSignal.timeout(Math.max(1, Date.parse(initial.expires_at) - Date.now())) });
      if (answer === 'publish') driver.simulateHumanClick(task);
      else driver.closeAssist(task);
    } catch {
      driver.closeAssist(task);
    } finally {
      rl.close();
    }
    console.log(JSON.stringify(await run.advance()));
  }
  const report = run.report();
  return report && report.kind !== 'accepted' ? 1 : 0;
}

function readSmallFile(path: string, byteLimit: number, privateFile = false): string {
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | (privateFile ? constants.O_NOFOLLOW : 0)));
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > byteLimit || (privateFile && process.platform !== 'win32' && ((file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()))) throw new Error('invalid_input_file');
    const buffer = Buffer.alloc(byteLimit + 1);
    let size = 0;
    while (size <= byteLimit) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      size += read;
    }
    throw new Error('invalid_input_file');
  } finally {
    closeSync(fd);
  }
}

async function gateway(args: string[]): Promise<number> {
  const [action, first, second, third, fourth, fifth] = args;
  const counts: Record<string, number> = { keygen: 2, pair: 5, identity: 3, phone: 6, run: 3 };
  if (args.length !== counts[action]) { console.error(usage); return 2; }
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'win32') {
    console.log(JSON.stringify({ status: 'blocked', reason: 'unsupported_desktop' }));
    return 1;
  }
  if (action === 'keygen') {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(first, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    return 0;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    console.log(JSON.stringify({ status: 'blocked', reason: 'interactive_operator_required' }));
    return 1;
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  const interrupted = new AbortController();
  terminal.on('SIGINT', () => interrupted.abort());
  terminal.on('close', () => interrupted.abort());
  const display = (value: object) => console.log(JSON.stringify(value).replace(/[\u007f-\u009f‪-‮⁦-⁩]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`));
  const ask: ManualIO['ask'] = async (prompt, deadline) => {
    if (Date.now() >= deadline) return;
    try {
      const input = await terminal.question(prompt, { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
      if (input.length <= 16_384 && Date.now() < deadline) return input.trim();
    } catch { /* Closed or expired. */ }
  };
  const io: ManualIO = { ask, display, async verifyMedia(asset, deadline) {
    const path = await ask(`Enter the local file path for asset ${asset.id}: `, deadline);
    if (!path || Date.now() >= deadline) return false;
    try {
      const file = await open(path, constants.O_RDONLY | (platform === 'win32' ? 0 : constants.O_NONBLOCK));
      try {
        if (!(await file.stat()).isFile()) return false;
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          if (Date.now() >= deadline || interrupted.signal.aborted) return false;
          hash.update(chunk);
        }
        return hash.digest('hex') === asset.sha256;
      } finally { await file.close(); }
    } catch { return false; }
  } };
  const deadline = Date.now() + 5 * 60_000;
  try {
    if (action === 'pair') {
      const key = createPrivateKey(readSmallFile(fourth, 8192, true));
      if (await ask('Pair this client-owned desktop with the configured workspace. Type owned-desktop to confirm: ', deadline) !== 'owned-desktop') return 1;
      const code = await ask('Enter the one-time AC pairing code in this private terminal: ', deadline);
      if (!code) return 1;
      const id = await pairOverHttp(first, second, code, platform, third, key, { userInitiated: true, ownsDevice: true });
      display({ status: 'paired', device_id: id });
      return 0;
    }
    const key = createPrivateKey(readSmallFile(second, 8192, true));
    const raw: unknown = JSON.parse(readSmallFile(first, 8192));
    if (action === 'phone') {
      const local = fields(raw, ['origin', 'workspace_id', 'connector_device_id', 'hardware_id_hash', 'connection']);
      const connection = parseChoice(local.connection, ['usb', 'lan'], 'connection');
      const hardware_id_hash = sha256(local.hardware_id_hash, 'hardware_id_hash');
      if (typeof local.origin !== 'string' || !third.trim() || third.length > 80 || !/^[A-Za-z0-9]{4}$/.test(fourth) || !/^\d{1,2}(?:\.\d{1,3}){0,2}$/.test(fifth) || Number(fifth.split('.')[0]) < (connection === 'lan' ? 11 : 8)) return 2;
      const client = new SignedDeviceClient(opaqueId(local.workspace_id, 'workspace_id'), opaqueId(local.connector_device_id, 'connector_device_id'), key, createSignedHttpTransport(local.origin));
      const observed = await ask(`Confirm the pre-approved physical, unmodified client-owned Android is paired, unlocked and authorized over ${connection} with compatible App setup. For LAN confirm the explicitly approved same-LAN connection. Enter its observed hardware ID: `, deadline);
      if (!observed || !matchesAndroidHardware(observed, hardware_id_hash)) return 1;
      await client.heartbeat(clientVersion);
      const report = await client.reportAndroid({ hardware_id_hash, connection, model: third, serial_suffix: fourth, os_version: fifth, driver_version: clientVersion });
      display(report);
      return ['detected', 'ready'].includes(report.status) ? 0 : 1;
    }
    const local = parseManualTarget(raw);
    const client = new SignedDeviceClient(local.workspace_id, local.connector_device_id, key, createSignedHttpTransport(local.origin));
    if (action === 'identity') {
      const observed = await observeManualIdentity(local, io, deadline);
      if ('reason' in observed) { display({ status: 'blocked', reason: observed.reason }); return 1; }
      await client.heartbeat(clientVersion);
      const status = await client.reportIdentity(local.target.channel, local.session_id, observed.identity);
      display({ status });
      return status === 'verified' ? 0 : 1;
    }
    const result = await runManualGatewayOnce(client, local, io);
    if (result.status === 'idle') { display(result); return 0; }
    display({ status: result.status, attempt_id: result.attempt_id, outcome: result.result.kind, ...('reason' in result.result && { reason: result.result.reason }) });
    return result.status === 'reconcile' || result.result.kind === 'blocked' || result.result.kind === 'outcome_unknown' ? 1 : 0;
  } finally { terminal.close(); }
}

async function main(args: string[]): Promise<number> {
  if (args[0] === 'fixture') return fixture(args);
  if (args[0] === 'replay') return replay(args);
  if (['keygen', 'pair', 'phone', 'identity', 'run'].includes(args[0])) return gateway(args);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  if (args.length !== 3 || args[0] !== 'check') {
    console.error(usage);
    return 2;
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    console.log(JSON.stringify({ status: 'blocked', reason: 'unsupported_desktop' }));
    return 1;
  }

  try {
    // The local context is operator-controlled and maintained separately from the received lease.
    const context: unknown = JSON.parse(readSmallFile(args[1], 8192));
    const lease = readSmallFile(args[2], 2050).replace(/\r?\n$/, '');
    const decision = checkLocalHandoff(lease, context);
    console.log(JSON.stringify(decision));
    return decision.status === 'blocked' ? 1 : 0;
  } catch {
    console.log(JSON.stringify({ status: 'blocked', reason: 'invalid_input_file' }));
    return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  console.error('Connector operation could not complete. For a signed gateway session, check the attempt in AC/EX before retrying.');
  process.exitCode = 1;
}
