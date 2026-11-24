// AO-2 (E45, wave 6 G5-ops): the Windows service's supervisor. Fakes for the restart policy; a tiny real child for the
// process plumbing. No service is installed and Task Scheduler is never touched.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hubChildSpawner, RESTART_MAX_MS, RESTART_MIN_MS, STABLE_RUN_MS, superviseHub, type SupervisedChild } from './supervisor.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Children that exit with the scripted codes; `null` stays running until stopped. */
function script(codes: (number | null)[], clock: { now: number }, runMs = 1_000) {
  const spawned: { stopped: boolean }[] = [];
  const spawnChild = (): SupervisedChild => {
    const code = codes.shift();
    const state = { stopped: false };
    spawned.push(state);
    let exit!: (value: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { exit = resolve; });
    if (code !== null && code !== undefined) { clock.now += runMs; queueMicrotask(() => exit({ code, signal: null })); }
    return { exited, stop() { state.stopped = true; exit({ code: 0, signal: null }); }, kill() { exit({ code: null, signal: 'SIGKILL' }); } };
  };
  return { spawnChild, spawned };
}

test('AO-2: a hub that exits non-zero after starting is restarted with backoff; exit 0 (config error, normal stop) ends it', async () => {
  const clock = { now: 0 };
  const { spawnChild, spawned } = script([1, 1, 1, 1, 1, 1, 1, 0], clock);
  const waits: number[] = [];
  const lines: string[] = [];
  const code = await superviseHub({ spawnChild, now: () => clock.now, log: line => lines.push(line),
    sleep: async ms => { waits.push(ms); clock.now += ms; } });
  assert.equal(code, 0);
  assert.equal(spawned.length, 8, 'restarted after every crash, not left down until the next boot');
  assert.deepEqual(waits, [RESTART_MIN_MS, 20_000, 40_000, 80_000, 160_000, RESTART_MAX_MS, RESTART_MAX_MS]);
  assert.match(lines[0]!, /^SmartSell 中樞意外結束（結束碼 1），10 秒後重新啟動。$/);
  assert.match(lines.at(-1)!, /結束碼 0：設定錯誤或正常停止.*不再重新啟動/);
});

test('AO-2: a run that lasted 10 minutes resets the backoff; a signal exit restarts too', async () => {
  const clock = { now: 0 };
  const codes = [1, 1, 1, 0];
  const { spawnChild } = script(codes, clock);
  const waits: number[] = [];
  let runs = 0;
  const code = await superviseHub({
    spawnChild: () => { runs++; if (runs === 3) clock.now += STABLE_RUN_MS; return spawnChild(); },
    now: () => clock.now, log: () => {}, sleep: async ms => { waits.push(ms); },
  });
  assert.equal(code, 0);
  assert.deepEqual(waits, [RESTART_MIN_MS, 20_000, RESTART_MIN_MS]);
  const signalled = { now: 0 };
  const lines: string[] = [];
  let first = true;
  await superviseHub({
    spawnChild: () => {
      const exited = Promise.resolve(first ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null });
      first = false;
      return { exited, stop() {}, kill() {} };
    },
    now: () => signalled.now, log: line => lines.push(line), sleep: async () => {},
  });
  assert.match(lines[0]!, /訊號 SIGKILL/);
});

test('AO-2: stopping the supervisor stops the hub gracefully and never restarts it, even mid-backoff', async () => {
  const clock = { now: 0 };
  const { spawnChild, spawned } = script([null], clock);
  let stop!: () => void;
  const running = superviseHub({ spawnChild, now: () => clock.now, log: () => {}, onStopSignal: handler => { stop = handler; } });
  await new Promise(resolve => setImmediate(resolve));
  stop();
  assert.equal(await running, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.stopped, true, 'the child was asked to stop (IPC disconnect), not killed');
  // Stopped while waiting to restart: the wait ends at once and nothing respawns.
  const again = script([1, 1], clock);
  let stopAgain!: () => void;
  const waiting = superviseHub({ spawnChild: again.spawnChild, now: () => clock.now, log: () => {}, onStopSignal: handler => { stopAgain = handler; } });
  await new Promise(resolve => setImmediate(resolve));
  stopAgain();
  assert.equal(await waiting, 0);
  assert.equal(again.spawned.length, 1);
});

function temp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-supervisor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('AO-2: the real child plumbing: exit codes come back, and disconnecting the IPC channel stops the child', async t => {
  const dir = temp(t);
  const counter = join(dir, 'runs');
  writeFileSync(counter, '0');
  const crashOnce = join(dir, 'crash-once.mjs');
  writeFileSync(crashOnce, `import { readFileSync, writeFileSync } from 'node:fs';
const runs = Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1;
writeFileSync(${JSON.stringify(counter)}, String(runs));
process.exitCode = runs === 1 ? 3 : 0;
process.channel?.unref();
`);
  const code = await superviseHub({ spawnChild: hubChildSpawner(crashOnce, [], { cwd: repoRoot }), log: () => {}, sleep: async () => {} });
  assert.equal(code, 0);
  assert.equal(readFileSync(counter, 'utf8'), '2', 'crashed once, restarted once, then ended with 0');

  const stays = join(dir, 'stays.mjs');
  writeFileSync(stays, `process.channel?.unref();
const keepAlive = setInterval(() => {}, 1000);
process.once('disconnect', () => { clearInterval(keepAlive); process.exitCode = 0; });
`);
  const child = hubChildSpawner(stays, [], { cwd: repoRoot })();
  await new Promise(resolve => setTimeout(resolve, 300));
  child.stop();
  assert.deepEqual(await child.exited, { code: 0, signal: null });
});
