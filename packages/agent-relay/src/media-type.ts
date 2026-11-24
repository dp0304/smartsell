import { open } from 'node:fs/promises';

export type MediaKind = 'video' | 'image';
export interface DetectedType { mime: string; kind: MediaKind }

/** Detect mp4, mov, webm, jpeg, png, webp and gif from the first 64 bytes; content wins over the extension (§6.3 step 3). */
export function detectType(prefix: Uint8Array): DetectedType | undefined {
  const bytes = Buffer.from(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const at = (offset: number, value: string) => bytes.subarray(offset, offset + value.length).equals(Buffer.from(value, 'latin1'));
  if (at(4, 'ftyp')) return at(8, 'qt  ') ? { mime: 'video/quicktime', kind: 'video' } : { mime: 'video/mp4', kind: 'video' };
  if (at(0, '\x1a\x45\xdf\xa3') && bytes.subarray(4, 64).includes(Buffer.from('\x42\x82\x84webm', 'latin1'))) return { mime: 'video/webm', kind: 'video' };
  if (at(0, '\xff\xd8\xff')) return { mime: 'image/jpeg', kind: 'image' };
  if (at(0, '\x89PNG\r\n\x1a\n')) return { mime: 'image/png', kind: 'image' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { mime: 'image/webp', kind: 'image' };
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { mime: 'image/gif', kind: 'image' };
  return undefined;
}

export async function detectFileType(path: string): Promise<DetectedType | undefined> {
  const file = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(64);
    const { bytesRead } = await file.read(prefix, 0, 64, 0);
    return detectType(prefix.subarray(0, bytesRead));
  } finally { await file.close(); }
}
