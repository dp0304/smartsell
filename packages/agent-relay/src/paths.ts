import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { Stats } from 'node:fs';
import { ToolError } from './errors.ts';

export const PATH_NOT_ABSOLUTE_MESSAGE = 'Pass an absolute path. Build it from your working directory; the relay does not know it.';

export interface PathPolicy {
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Extra directories never read (the relay's own data directory). */
  denyDirs?: string[];
}

export interface ResolvedPath { lexical: string; real: string; stat: Stats }

const notAllowed = () => new ToolError('PATH_NOT_ALLOWED',
  'This location is not allowed for media (hidden, system or credential directories). Pass the path of the video or image itself.',
  { owner_message: '這個位置（隱藏資料夾、系統或憑證資料夾）不允許上傳。請把影片放在一般資料夾，例如「影片」或「桌面」。' });

/** True when `target` is inside a denied location (§6.3 step 2). */
export function deniedPath(target: string, policy: Required<Pick<PathPolicy, 'homeDir' | 'platform'>> & { denyDirs?: string[] }) {
  const windows = policy.platform === 'win32';
  const path = windows ? win32 : posix;
  // macOS and Windows file systems are case-insensitive by default; compare folded.
  const fold = (value: string) => windows || policy.platform === 'darwin' ? value.toLowerCase() : value;
  const normal = fold(path.resolve(target));
  const home = path.resolve(policy.homeDir);
  const roots = [
    ...['.ssh', '.aws', '.gnupg', '.config', path.join('Library', 'Keychains')].map(dir => path.join(home, dir)),
    ...(windows ? ['C:\\Windows'] : ['/etc', '/private/etc']),
    ...(policy.denyDirs ?? []),
  ].map(dir => fold(path.resolve(dir)));
  if (roots.some(root => normal === root || normal.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) return true;
  // Any directory component that starts with '.' (the file name itself is not a directory).
  const parts = normal.split(path.sep).filter(Boolean);
  return parts.slice(0, -1).some(part => part.startsWith('.'));
}

/** Resolve a media_upload path: absolute or ~/, realpath'd to a regular file outside denied locations. */
export async function resolveMediaPath(input: string, policy: PathPolicy = {}): Promise<ResolvedPath> {
  const platform = policy.platform ?? process.platform;
  const homeDir = policy.homeDir ?? homedir();
  const path = platform === 'win32' ? win32 : posix;
  let expanded: string;
  if (input.startsWith('~/') || (platform === 'win32' && input.startsWith('~\\'))) expanded = path.join(homeDir, input.slice(2));
  else if (path.isAbsolute(input) && !(platform === 'win32' && /^[\\/](?![\\/])/.test(input))) expanded = input;
  else throw new ToolError('PATH_NOT_ABSOLUTE', PATH_NOT_ABSOLUTE_MESSAGE);
  const lexical = path.resolve(expanded);
  const rule = { homeDir, platform, denyDirs: policy.denyDirs };
  if (deniedPath(lexical, rule)) throw notAllowed();
  let real: string;
  try { real = await realpath(lexical); }
  catch {
    throw new ToolError('MEDIA_NOT_FOUND', `No file at ${lexical}. Check the path (build it from your working directory).`);
  }
  // A symbolic link must not lead into a denied location.
  if (deniedPath(real, rule)) throw notAllowed();
  const info = await stat(real);
  if (!info.isFile()) throw new ToolError('MEDIA_NOT_FOUND', `${lexical} is not a regular file. Pass the path of the video or image itself.`);
  return { lexical, real, stat: info };
}
