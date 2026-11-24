import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { ToolError } from './errors.ts';

const MIB = 1024 * 1024;

export const fileChanged = () => new ToolError('FILE_CHANGED', 'The file changed while it was being read. Wait until it is saved, then call media_upload again.',
  { owner_message: '檔案在讀取或上傳期間被修改了。請等檔案存好後，再請 Agent 上傳一次。' });

/** Stream SHA-256 in 1 MiB reads; fail with FILE_CHANGED when size or mtime moved during the read (§6.3 step 5). */
export async function hashFile(path: string, expected: { size: number; mtimeMs: number }): Promise<string> {
  const hash = createHash('sha256');
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) throw fileChanged();
    const buffer = Buffer.allocUnsafe(MIB);
    for (let position = 0; position < before.size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(MIB, before.size - position), position);
      if (!bytesRead) throw fileChanged();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally { await file.close(); }
  const after = await stat(path);
  if (after.size !== expected.size || after.mtimeMs !== expected.mtimeMs) throw fileChanged();
  return hash.digest('hex');
}
