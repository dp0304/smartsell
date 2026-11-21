import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const launcher = fileURLToPath(new URL('./dev-host.mjs', import.meta.url));
const secret = () => randomBytes(32).toString('hex');

async function ready(url, check, child, signal) {
  const deadline = Date.now() + 20_000;
  let status;
  const launcherExit = () => child.exitCode ?? child.signalCode ?? (child.pid ? null : 'failed to spawn');
  while (!signal.aborted && Date.now() < deadline && launcherExit() === null) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      status = response.status;
      const body = await response.text();
      if (check(response, body) && launcherExit() === null) return;
    } catch {
      // A connection failure or incomplete response can be transient during startup.
    }
    await delay(150, undefined, { signal });
  }
  const exit = launcherExit();
  const detail = exit !== null ? `launcher exit ${exit}` : status ? `last HTTP status ${status}` : 'no HTTP response';
  throw new Error(`SmartSell did not become ready at ${url} (${detail})`);
}

function updateFixtureSnapshot(file, update) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    const row = db.prepare('SELECT payload FROM snapshot WHERE id = 1').get();
    const state = JSON.parse(row.payload);
    update(state);
    db.prepare('UPDATE snapshot SET payload = ? WHERE id = 1').run(JSON.stringify(state));
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

export async function localDev({}, use) {
  return launchLocalDev(use);
}

export async function localRegistration({}, use) {
  return launchLocalDev(use, { registration: true });
}

export async function localTokenRegistration({}, use) {
  return launchLocalDev(use, { registration: true, requireToken: true });
}

export async function localWithoutWorker({}, use) {
  return launchLocalDev(use, { worker: false });
}

export async function localOperations({}, use) {
  return launchLocalDev(use, { operations: true });
}

export async function localWorkspaceAccount({}, use) {
  return launchLocalDev(use, { operations: true, workspaceAccount: true });
}

export async function localCommerceStore({}, use) {
  return launchLocalDev(use, { operations: true, commerceStore: 'catalog' });
}

export async function localCommercePromotions({}, use) {
  return launchLocalDev(use, { operations: true, commerceStore: 'promotions' });
}

async function launchLocalDev(use, { operations = false, workspaceAccount = false, commerceStore = false, worker = true, registration = false, requireToken = !registration } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-web-e2e-'));
  const readiness = new AbortController();
  let child;
  let exited;
  let startupLog = '';
  try {
    const setupToken = secret();
    const stateFile = join(directory, 'state.sqlite');
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME, TMPDIR: directory,
      NODE_ENV: 'development', ROLE: 'all', HOST: '127.0.0.1',
      APP_SECRET: secret(),
      ...(registration && { SMARTSELL_LOCAL_SETUP: '1' }),
      ...(requireToken && { SETUP_TOKEN: setupToken }),
      SMARTSELL_DATA_FILE: stateFile, MEDIA_DIRECTORY: join(directory, 'media'),
      SMARTSELL_VITE_CACHE_DIR: join(directory, 'vite-cache'),
      SMARTSELL_E2E_PAUSE_WORKER: worker ? undefined : '1',
      SMARTSELL_E2E_PREVIEW: process.env.SMARTSELL_E2E_PREVIEW,
      SMARTSELL_E2E_OPERATIONS: operations ? '1' : '0',
      SMARTSELL_E2E_WORKSPACE_ACCOUNT: workspaceAccount ? '1' : undefined,
      SMARTSELL_E2E_COMMERCE_STORE: commerceStore || undefined,
    };
    child = fork(launcher, { cwd: root, env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const capture = chunk => { startupLog = (startupLog + chunk).slice(-4000); };
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', capture);
    exited = new Promise(resolve => child.once('close', () => resolve(true)));
    let origin;
    let browserFixture;
    try {
      const [addresses] = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(45_000) }),
        exited.then(() => { throw new Error(`Launcher exited (${child.exitCode ?? child.signalCode})`); }),
      ]);
      ({ origin, browserFixture } = addresses);
      await Promise.all([
        ready(`${addresses.apiOrigin}/readyz`, (response, body) => response.ok && JSON.parse(body)?.status === 'ok', child, readiness.signal),
        ready(`${origin}/index.html`, response => response.ok && /^text\/html\s*(?:;|$)/i.test(response.headers.get('content-type') ?? ''), child, readiness.signal),
        ready(`${origin}/api/v1/session`, response => response.status === 401, child, readiness.signal),
      ]);
    } catch (error) {
      throw new Error(`${error.message}${startupLog ? `\n${startupLog}` : ''}`, { cause: error });
    }
    for (const stream of [child.stdout, child.stderr]) stream.off('data', capture).resume();
    await use({ origin, setupToken, password: secret, ...(commerceStore && { browserFixture }),
      async setTime(testTime) {
        const reply = once(child, 'message', { signal: AbortSignal.timeout(5000) });
        child.send({ testTime });
        const [clock] = await reply;
        if (clock.testTime !== testTime) throw new Error('Browser fixture clock was not updated');
      },
      ...(workspaceAccount && { async workspaceAccountFixture(input) {
        const reply = once(child, 'message', { signal: AbortSignal.timeout(5000) });
        child.send({ workspaceAccount: input });
        const [result] = await reply;
        if (result.fixtureError) throw new Error(result.fixtureError);
        return result.workspaceAccount;
      } }),
      updateSnapshot: update => updateFixtureSnapshot(stateFile, update),
      // The local store supports one identity at a time. Preserve records and audit when switching.
      switchIdentity: ({ id = randomUUID(), email, name, role }) => updateFixtureSnapshot(stateFile, state => {
        state.user = { id, email, name, passwordHash: state.user.passwordHash };
        state.scope = { ...state.scope, actorId: id, role };
        state.workspaceInfo = { ...state.workspaceInfo, role };
        state.sessions = [];
      }),
      seedNativeScheduleReceipt: (taskId, attemptId) => updateFixtureSnapshot(stateFile, state => {
        const records = new Map(state.records);
        for (const [kind, id, patch] of [
          ['execution_task', taskId, { status: 'accepted', sub_status: 'scheduled_on_platform' }],
          ['execution_attempt', attemptId, { executor: 'api', status: 'accepted', receipt: `local-receipt-${attemptId}` }],
        ]) {
          const key = JSON.stringify(['operation_runtime', 'record', `row/${kind}/${encodeURIComponent(id)}`]);
          const record = records.get(key);
          if (!record) throw new Error(`Missing ${kind} fixture ${id}`);
          record.data.value = JSON.stringify({ ...JSON.parse(record.data.value), ...patch });
        }
        state.records = [...records];
      }),
    });
  } finally {
    readiness.abort();
    try {
      if (child) {
        child.kill('SIGTERM');
        if (!await Promise.race([exited, delay(4000, false, { ref: false })])) {
          child.kill('SIGKILL');
          await Promise.race([exited, delay(1000, false, { ref: false })]);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
