import { spawn } from 'node:child_process';

/**
 * AO-2 (E45): the Windows service runs `hub.ts --supervise`. Task Scheduler's RestartOnFailure only retries a task that
 * failed to *start*; a hub that started and later exited non-zero (crash, out of memory, EADDRINUSE at boot) counts as
 * completed and would stay down until the next boot or logon. This supervisor restarts it with backoff.
 *
 * - Exit 0 ends supervision: a configuration error (status.json `config_error`, §2.5) or a normal stop. No restart loop.
 * - Any other exit, or a signal, restarts after RESTART_MIN_MS, doubling to RESTART_MAX_MS; a run that lasted
 *   STABLE_RUN_MS resets the delay.
 * - The child gets an IPC channel. When the supervisor is stopped (SIGINT/SIGTERM/SIGBREAK) it disconnects the channel,
 *   which the hub treats like SIGTERM (graceful stop). When the supervisor is killed outright (`schtasks /End`), the
 *   channel closes too, so the hub never outlives it.
 */
export const RESTART_MIN_MS = 10_000;
export const RESTART_MAX_MS = 5 * 60_000;
export const STABLE_RUN_MS = 10 * 60_000;
export const CHILD_STOP_GRACE_MS = 30_000;

export interface SupervisedChild {
  /** Resolves when the child exits. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Ask the child to stop gracefully (close the IPC channel). */
  stop(): void;
  /** Kill the child outright. */
  kill(): void;
}

export interface SupervisorDeps {
  spawnChild(): SupervisedChild;
  log?: (line: string) => void;
  now?: () => number;
  /** Waits `ms`, or less when `stopRequested` resolves first. */
  sleep?: (ms: number, interrupt: Promise<void>) => Promise<void>;
  /** Registers the supervisor's own stop signal; returns nothing. Tests call the handler directly. */
  onStopSignal?: (handler: () => void) => void;
}

const defaultSleep = (ms: number, interrupt: Promise<void>) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  void interrupt.then(() => { clearTimeout(timer); resolve(); });
});

/** Runs the hub until it exits 0 or the supervisor is asked to stop. Returns the supervisor's exit code (always 0). */
export async function superviseHub(deps: SupervisorDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  let stopping = false;
  let requestStop!: () => void;
  const stopRequested = new Promise<void>(resolve => { requestStop = resolve; });
  let current: SupervisedChild | undefined;
  (deps.onStopSignal ?? (() => {}))(() => {
    if (stopping) return;
    stopping = true;
    requestStop();
    if (current) {
      current.stop();
      const timer = setTimeout(() => current?.kill(), CHILD_STOP_GRACE_MS);
      timer.unref?.();
    }
  });
  let delay = RESTART_MIN_MS;
  for (;;) {
    if (stopping) return 0;
    const startedAt = now();
    current = deps.spawnChild();
    const { code, signal } = await current.exited;
    current = undefined;
    if (stopping) {
      log('SmartSell 中樞監督程序：已停止。');
      return 0;
    }
    if (code === 0) {
      log('SmartSell 中樞已結束（結束碼 0：設定錯誤或正常停止），監督程序不再重新啟動；原因見 status.json 或 pnpm hub:doctor。');
      return 0;
    }
    if (now() - startedAt >= STABLE_RUN_MS) delay = RESTART_MIN_MS;
    log(`SmartSell 中樞意外結束（${signal ? `訊號 ${signal}` : `結束碼 ${code}`}），${Math.round(delay / 1000)} 秒後重新啟動。`);
    await sleep(delay, stopRequested);
    delay = Math.min(delay * 2, RESTART_MAX_MS);
  }
}

/**
 * The real child: `node --import tsx <script> <args>` from the repository root (where `tsx` resolves, like the task's
 * WorkingDirectory), sharing the supervisor's stdout/stderr (the service logs) plus an IPC channel.
 */
export function hubChildSpawner(script: string, args: readonly string[], options: { cwd: string; execPath?: string; env?: NodeJS.ProcessEnv }) {
  return (): SupervisedChild => {
    const child = spawn(options.execPath ?? process.execPath, ['--import', 'tsx', script, ...args],
      { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', error => resolve({ code: -1, signal: (error as NodeJS.ErrnoException).code ?? 'spawn_error' }));
    });
    return {
      exited,
      stop() { if (child.connected) child.disconnect(); else child.kill('SIGTERM'); },
      kill() { child.kill('SIGKILL'); },
    };
  };
}

/** Wires the supervisor's own signals. SIGBREAK is Ctrl-Break on Windows. */
export function processStopSignals(handler: () => void) {
  for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] as const : [])] as NodeJS.Signals[]) {
    process.once(signal, handler);
  }
}
