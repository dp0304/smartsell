// Local log file (`<userData>/logs/worker.log`, JSON lines, 5 MB × 2) for the
// 「進階 → 日誌」 button. Detail objects come from the runtime and the shell,
// which never put tokens, keys or captions in them; values that look like a
// SmartSell token are masked anyway.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 5 * 1024 * 1024;
const SECRET = /ss_(?:command|device)_[A-Za-z0-9_-]{8,}/g;

export function createLog(dir: string, options: { stderr?: boolean; now?: () => number } = {}) {
  const file = join(dir, 'worker.log');
  let ready = false;
  return {
    file, dir,
    write(message: string, detail?: object) {
      const line = `${JSON.stringify({ at: new Date((options.now ?? Date.now)()).toISOString(), message, ...detail }).replace(SECRET, 'ss_***')}\n`;
      try {
        if (!ready) { mkdirSync(dir, { recursive: true, mode: 0o700 }); ready = true; }
        try { if (statSync(file).size > LIMIT) renameSync(file, `${file}.1`); } catch { /* no file yet */ }
        appendFileSync(file, line, { mode: 0o600 });
      } catch { /* logging must never break the Worker */ }
      if (options.stderr) process.stderr.write(line);
    },
  };
}
