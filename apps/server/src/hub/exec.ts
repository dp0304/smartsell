import { execFile, spawn } from 'node:child_process';

export interface ExecResult {
  /** Process exit code; -1 when the program could not be started or was killed. */
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started (for example `ENOENT`) or timed out (`ETIMEDOUT`). */
  error?: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Inherit the terminal (interactive commands such as builds, sudo, schtasks /RP *). Output is not captured. */
  inherit?: boolean;
}

/** Every external program the hub tooling runs goes through this, so tests inject a fake and never touch real binaries. */
export type Exec = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

export const nodeExec: Exec = (file, args, options = {}) => new Promise(resolve => {
  if (options.inherit) {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: 'inherit', windowsHide: true,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file) });
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: '', error: (error as NodeJS.ErrnoException).code ?? error.message });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: '', stderr: '', ...(signal ? { error: signal } : {}) });
    });
    return;
  }
  execFile(file, args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (!error) return resolve({ code: 0, stdout, stderr });
    const failure = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
    if (typeof failure.code === 'number') return resolve({ code: failure.code, stdout, stderr, ...(failure.killed ? { error: 'ETIMEDOUT' } : {}) });
    resolve({ code: -1, stdout, stderr, error: failure.killed ? 'ETIMEDOUT' : String(failure.code ?? failure.message) });
  });
});

/** pnpm's executable name on this platform. */
export const pnpmCommand = (platform: NodeJS.Platform = process.platform) => platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
