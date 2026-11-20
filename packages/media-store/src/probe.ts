import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

export class InvalidMedia extends Error {}
export class MediaUnavailable extends Error {}

const formats: Record<string, { demuxer: string; codec?: string; mov?: boolean }> = {
  'image/png': { demuxer: 'png_pipe', codec: 'png' }, 'image/jpeg': { demuxer: 'jpeg_pipe', codec: 'mjpeg' },
  'image/webp': { demuxer: 'webp_pipe', codec: 'webp' }, 'image/gif': { demuxer: 'gif', codec: 'gif' },
  'video/mp4': { demuxer: 'mov', mov: true }, 'audio/mp4': { demuxer: 'mov', mov: true },
  'video/webm': { demuxer: 'matroska' }, 'audio/webm': { demuxer: 'matroska' },
  'audio/mpeg': { demuxer: 'mp3', codec: 'mp3' }, 'audio/wav': { demuxer: 'wav' },
};
const texts = ['text/plain', 'text/csv', 'text/vtt', 'application/x-subrip', 'application/json'];
export const mediaTypes = [...Object.keys(formats), ...texts, 'application/pdf'];
export const canPreview = (mime: string) => mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');

function magic(prefix: Buffer, mime: string) {
  const at = (offset: number, value: string) => prefix.subarray(offset, offset + value.length).equals(Buffer.from(value, 'latin1'));
  switch (mime) {
    case 'image/png': return at(0, '\x89PNG\r\n\x1a\n');
    case 'image/jpeg': return at(0, '\xff\xd8\xff');
    case 'image/webp': return at(0, 'RIFF') && at(8, 'WEBP');
    case 'image/gif': return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'video/mp4': case 'audio/mp4': return at(4, 'ftyp') && !at(8, 'qt  ');
    case 'video/webm': case 'audio/webm': return at(0, '\x1a\x45\xdf\xa3') && prefix.subarray(4, 64).includes(Buffer.from('\x42\x82\x84webm', 'latin1'));
    case 'audio/mpeg': return at(0, 'ID3') || (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0);
    case 'audio/wav': return (at(0, 'RIFF') || at(0, 'RF64')) && at(8, 'WAVE');
    case 'application/pdf': return at(0, '%PDF-');
    default: return false;
  }
}

function inputArgs(mime: string) {
  const format = formats[mime];
  return ['-protocol_whitelist', 'fd', '-format_whitelist', format.demuxer, '-f', format.demuxer,
    ...(format.mov ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    '-probesize', '4194304', '-analyzeduration', '5000000', '-i', 'fd:'];
}

let processes = 0;
async function runMedia(binary: 'ffprobe' | 'ffmpeg', path: string, args: string[], outputLimit: number) {
  if (processes >= 4) throw new MediaUnavailable('Media workers are busy');
  processes++;
  try {
    const input = await open(path, 'r');
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(binary, args, { stdio: [input.fd, 'pipe', 'ignore'], shell: false, windowsHide: true });
        const chunks: Buffer[] = [];
        let size = 0;
        let exceeded = false;
        const stop = () => { exceeded = true; child.kill('SIGKILL'); };
        const timer = setTimeout(stop, 15_000);
        child.stdout?.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > outputLimit) stop();
          if (!exceeded) chunks.push(chunk);
        });
        child.on('error', () => reject(new MediaUnavailable('Media executable is unavailable')));
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0 || exceeded) reject(new InvalidMedia('Media could not be processed within limits'));
          else resolve(Buffer.concat(chunks, size));
        });
      });
    } finally { await input.close(); }
  } finally { processes--; }
}

export type MediaMetadata = { width?: number; height?: number; duration_seconds?: number; video_codec?: string; audio_codec?: string };
export type Probe = (path: string, mime: string) => Promise<MediaMetadata>;

async function verifyText(path: string, mime: string) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let lead = '';
  let json = '';
  try {
    for await (const bytes of createReadStream(path)) {
      const chunk = decoder.decode(bytes, { stream: true });
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(chunk)) throw new InvalidMedia('Invalid text control character');
      if (lead.length < 256) lead += chunk.slice(0, 256 - lead.length);
      if (mime === 'application/json') {
        if (json.length + chunk.length > 1024 * 1024) throw new InvalidMedia('JSON media exceeds the validation limit');
        json += chunk;
      }
    }
    decoder.decode();
    if (mime === 'application/json') JSON.parse(json);
    if (mime === 'text/vtt' && !/^WEBVTT(?:[\r\n\t ]|$)/.test(lead)) throw new InvalidMedia('Missing WebVTT header');
    if (mime === 'application/x-subrip' && !/^\s*\d+\s+\d\d:\d\d:\d\d[,.]\d{3}\s+-->/.test(lead)) throw new InvalidMedia('Invalid SRT caption');
  } catch (error) {
    if (error instanceof InvalidMedia) throw error;
    if (error instanceof TypeError || error instanceof SyntaxError) throw new InvalidMedia('Invalid UTF-8 or JSON media');
    throw error;
  }
}

export const probeMedia: Probe = async (path, mime) => {
  if (texts.includes(mime)) { await verifyText(path, mime); return {}; }
  const file = await open(path, 'r');
  const prefix = Buffer.alloc(64);
  try {
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    if (!magic(prefix.subarray(0, bytesRead), mime)) throw new InvalidMedia('File signature does not match MIME type');
  } finally { await file.close(); }
  if (mime === 'application/pdf') return {};
  const format = formats[mime];
  if (!format) throw new InvalidMedia('Unsupported media type');
  const output = await runMedia('ffprobe', path, ['-v', 'error', '-max_alloc', '67108864', ...inputArgs(mime), '-show_entries',
    'stream=codec_type,codec_name,width,height:stream_disposition=attached_pic:format=duration', '-of', 'json'], 32_768);
  const result = JSON.parse(output.toString()) as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[];
    format?: { duration?: string };
  };
  const video = result.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = result.streams?.find(stream => stream.codec_type === 'audio');
  const audioOnly = mime.startsWith('audio/');
  const expected = audioOnly ? audio : video;
  if (!expected?.codec_name || (format.codec && expected.codec_name !== format.codec) || (audioOnly && video)) {
    throw new InvalidMedia('Streams do not match MIME type');
  }
  const duration = Number(result.format?.duration);
  const meta: MediaMetadata = {};
  if (video) {
    const { width = 0, height = 0 } = video;
    if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 40_000_000) throw new InvalidMedia('Invalid or oversized frame dimensions');
    Object.assign(meta, { width, height, video_codec: video.codec_name });
  }
  if (audio) meta.audio_codec = audio.codec_name;
  if (Number.isFinite(duration) && duration >= 0) meta.duration_seconds = duration;
  return meta;
};

/** A worker-only primitive. Accepts a private local snapshot and a verified MIME type. */
export async function makeThumbnail(path: string, mime: string) {
  if (!Object.hasOwn(formats, mime) || !/^(image|video)\//.test(mime)) throw new InvalidMedia('A visual source is required');
  return runMedia('ffmpeg', path, ['-nostdin', '-v', 'error', '-max_alloc', '67108864', '-filter_threads', '1',
    '-threads', '1', ...inputArgs(mime), '-map', '0:V:0', '-frames:v', '1', '-vf',
    'scale=320:320:force_original_aspect_ratio=decrease', '-threads', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], 1024 * 1024);
}
