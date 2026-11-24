import { basename } from 'node:path';
import { driveUpload, type RunOutcome, type RunPhase } from './continue-upload.ts';
import { ToolError, toolError, toolResult, type ToolResult } from './errors.ts';
import { hashFile } from './hash.ts';
import { toolErrorFromHub, type HubApi, type UploadConfig, type UploadMedia, type UploadSessionView } from './hub-api.ts';
import type { HandoffClient } from './handoff.ts';
import type { RpcMessage } from './jsonrpc.ts';
import { detectFileType } from './media-type.ts';
import { resolveMediaPath, type PathPolicy, type ResolvedPath } from './paths.ts';
import { BACKGROUND_RETRY_MS, FOREGROUND_RETRY_MS, sleep, type UploadTuning } from './uploader.ts';

/** §7.2.5 input schema, enforced locally (additionalProperties: false). */
const FIELDS = ['path', 'title', 'wait_seconds'] as const;
export const DEFAULT_WAIT_SECONDS = 45;
export const MAX_WAIT_SECONDS = 50;
const ASSUMED_RATE = 2_000_000;
const HANDOFF_RECHECK_MS = 10_000;

export interface MediaUploadOutput {
  media_id: string; status: 'ready' | 'processing' | 'uploading'; filename: string; kind: 'video' | 'image'; mime: string; bytes: number;
  sha256: string; uploaded_bytes: number; eta_seconds: number; continues_in_background: boolean;
  duration_ms: number | null; width: number | null; height: number | null; deduplicated: boolean; web_url: null;
}

export interface MediaUploadEnvironment {
  api: HubApi;
  policy?: PathPolicy;
  /** The resident laptop App; absent or unreachable means this process keeps uploading itself. */
  handoff?: HandoffClient;
  tuning?: Partial<UploadTuning>;
  pollMs?: number;
  /** While only watching an upload the App took, ask the App again after this long without new bytes (default 10 s, MCP-2). */
  handoffRecheckMs?: number;
  /** Wall clock in ms (the wait_seconds deadline). */
  now?: () => number;
  /** Called with every upload that outlives its tool call, so the process stays up until it settles. */
  onBackground?: (work: Promise<unknown>) => void;
  log?: (line: string) => void;
}

export interface CallContext { progressToken?: string | number; notify(message: RpcMessage): void }

function invalid(message: string, issues: Record<string, unknown>[]) {
  return new ToolError('INVALID_ARGUMENTS', message, undefined, issues);
}

export function parseMediaUploadArgs(args: unknown) {
  const value = args === undefined ? {} : args;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('media_upload takes an object: {"path": "/absolute/path/video.mp4"}.', [{ path: '', code: 'invalid_type' }]);
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length) {
    throw invalid(`media_upload has an unknown field '${unknown[0]}'. Allowed: ${FIELDS.join(', ')}.`,
      unknown.map(path => ({ path, code: 'unrecognized_keys', allowed: [...FIELDS] })));
  }
  const { path, title, wait_seconds } = input;
  if (typeof path !== 'string' || path.length < 2 || path.length > 4096) throw invalid('path is required: the absolute path (or ~/…) of the video or image.', [{ path: 'path', code: 'invalid_type' }]);
  if (title !== undefined && (typeof title !== 'string' || title.length < 1 || title.length > 200)) throw invalid('title must be 1 to 200 characters.', [{ path: 'title', code: 'invalid_string' }]);
  if (wait_seconds !== undefined && (typeof wait_seconds !== 'number' || !Number.isInteger(wait_seconds) || wait_seconds < 0 || wait_seconds > MAX_WAIT_SECONDS)) {
    throw invalid(`wait_seconds must be an integer from 0 to ${MAX_WAIT_SECONDS}.`, [{ path: 'wait_seconds', code: 'too_big' }]);
  }
  return { path, title: title as string | undefined, wait_seconds: (wait_seconds as number | undefined) ?? DEFAULT_WAIT_SECONDS };
}

function safeFilename(path: string) {
  let name = basename(path).replace(/[\p{Cc}\p{Cf}\\/]/gu, '_') || 'media';
  while (Buffer.byteLength(name) > 255) name = name.slice(0, -1);
  return name;
}

interface Run {
  uploadId: string; promise: Promise<RunOutcome>; phase: RunPhase; uploadedBytes: number; sentBytes: number;
  startedAt: number; controller: AbortController; background: boolean; listeners: Set<(uploaded: number) => void>;
}

/** The relay's local media_upload (§6.3): validate, resolve, sniff, hash, create or resume, upload, wait, hand off. */
export function createMediaUploadHandler(env: MediaUploadEnvironment) {
  const now = env.now ?? Date.now;
  const runs = new Map<string, Run>();
  // Uploads this process handed to the App. Only a hint to ask the App first (even before any chunk arrived); never proof that
  // the App is still uploading: it may have quit, restarted for an update or given up since (MCP-2).
  const handedOff = new Set<string>();
  const hashes = new Map<string, string>();
  let config: UploadConfig | undefined;

  async function uploadConfig() {
    config ??= await env.api.config();
    return config;
  }

  async function sha256Of(resolved: ResolvedPath) {
    const key = `${resolved.real}\0${resolved.stat.size}\0${resolved.stat.mtimeMs}`;
    let value = hashes.get(key);
    if (!value) { value = await hashFile(resolved.real, { size: resolved.stat.size, mtimeMs: resolved.stat.mtimeMs }); hashes.set(key, value); }
    return value;
  }

  function startRun(session: UploadSessionView, resolved: ResolvedPath, sha256: string) {
    const id = String(session.upload_id);
    const controller = new AbortController();
    const run: Run = { uploadId: id, phase: 'uploading', uploadedBytes: session.bytes_received ?? 0, sentBytes: 0, startedAt: now(), controller,
      background: false, listeners: new Set(), promise: undefined as unknown as Promise<RunOutcome> };
    const tuning: Partial<UploadTuning> = { ...env.tuning, retryDelaysMs: () => run.background ? BACKGROUND_RETRY_MS : (env.tuning?.retryDelaysMs?.() ?? FOREGROUND_RETRY_MS) };
    // A run that gave up after its call returned has no one to tell but the hub, which fails the media and alerts the owner (MCP-3).
    run.promise = driveUpload({ api: env.api, session, signal: controller.signal, tuning, pollMs: env.pollMs, abortOnGiveUp: () => run.background,
      target: { uploadId: id, path: resolved.real, bytes: resolved.stat.size, mtimeMs: resolved.stat.mtimeMs, sha256 },
      onPhase: phase => { run.phase = phase; },
      onProgress: progress => {
        run.uploadedBytes = progress.uploadedBytes;
        run.sentBytes = progress.sentBytes;
        for (const listener of run.listeners) listener(progress.uploadedBytes);
      } });
    run.promise.then(outcome => { if (outcome.status === 'processing') run.phase = 'processing'; }, () => undefined)
      .finally(() => { if (runs.get(id) === run) runs.delete(id); });
    runs.set(id, run);
    return run;
  }

  function eta(bytes: number, uploaded: number, rate: number | undefined) {
    const processing = Math.ceil(bytes / 200_000_000) + 2;
    const remaining = Math.max(0, bytes - uploaded);
    return Math.ceil(remaining / (rate && rate > 0 ? rate : ASSUMED_RATE)) + processing;
  }

  function readyOutput(media: UploadMedia | null | undefined, fallback: { media_id: string; filename: string; mime: string; bytes: number; sha256: string },
    deduplicated: boolean): MediaUploadOutput {
    const mime = media?.mime ?? fallback.mime;
    return { media_id: media?.media_id ?? fallback.media_id, status: 'ready', filename: fallback.filename, kind: mime.startsWith('video/') ? 'video' : 'image',
      mime, bytes: fallback.bytes, sha256: fallback.sha256, uploaded_bytes: fallback.bytes, eta_seconds: 0, continues_in_background: false,
      duration_ms: media?.duration_ms ?? null, width: media?.width ?? null, height: media?.height ?? null, deduplicated, web_url: null };
  }

  async function handle(args: unknown, call: CallContext): Promise<ToolResult> {
    try {
      const input = parseMediaUploadArgs(args);
      const deadline = now() + input.wait_seconds * 1000;
      const resolved = await resolveMediaPath(input.path, env.policy);
      const type = await detectFileType(resolved.real);
      const settings = await uploadConfig();
      if (!type || !settings.accepted_mime.includes(type.mime)) {
        throw new ToolError('UPLOAD_TYPE_UNSUPPORTED', 'Only mp4, mov, webm, jpeg, png, webp and gif files can be uploaded (detected from the file content).',
          { accepted_mime: settings.accepted_mime, owner_message: '只支援 mp4、mov、webm、jpeg、png、webp、gif（依檔案內容判斷，不看副檔名）。' });
      }
      const bytes = resolved.stat.size;
      if (bytes < 1 || bytes > settings.max_upload_bytes) {
        throw new ToolError('UPLOAD_TOO_LARGE', `The file is ${bytes} bytes; this hub accepts 1 to ${settings.max_upload_bytes}.`,
          { max_upload_bytes: settings.max_upload_bytes, owner_message: `這個檔案超過中樞的上傳上限（${Math.floor(settings.max_upload_bytes / 1024 ** 3 * 10) / 10} GB）。` });
      }
      const sha256 = await sha256Of(resolved);
      const filename = safeFilename(resolved.lexical);
      const fallback = { filename, mime: type.mime, bytes, sha256 };
      const session = await env.api.create({ filename, bytes, sha256, mime: type.mime, ...(input.title !== undefined && { title: input.title }) });
      if (session.status === 'ready') return toolResult({ ...readyOutput(session.media, { ...fallback, media_id: session.media_id }, session.deduplicated === true) });
      if (session.status === 'failed') throw new ToolError(session.error?.code ?? 'MEDIA_FAILED', session.error?.message ?? 'The upload failed on the hub.');
      const id = String(session.upload_id);
      const base = { media_id: session.media_id, filename, kind: type.kind, mime: type.mime, bytes, sha256, duration_ms: null, width: null, height: null,
        deduplicated: false, web_url: null };

      // Progress notifications every 5 % while this call is open (§6.3 step 7).
      let step = -1;
      const progress = (uploaded: number) => {
        if (call.progressToken === undefined) return;
        const next = Math.floor(uploaded / bytes * 20);
        if (next <= step) return;
        step = next;
        call.notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: call.progressToken, progress: uploaded, total: bytes,
          message: `Uploading ${filename}: ${Math.floor(uploaded / bytes * 100)}%` } });
      };

      const message = { type: 'handoff' as const, upload_id: id, path: resolved.real, sha256, bytes, mtime_ms: resolved.stat.mtimeMs };
      // Asks the App whether it is uploading this session. It says yes without a second upload while its run is alive, and starts
      // the run again when it stopped (§6.3 step 9). No, or no App listening: this process uploads the rest itself.
      const appUploads = async () => {
        if (!env.handoff) return false;
        const yes = await env.handoff.handoff(message);
        if (yes) handedOff.add(id); else handedOff.delete(id);
        return yes;
      };

      // A resumed upload may already be running in the App; ask it every time (never trust an earlier answer) so the two do
      // not race and nothing is left waiting for an App that is gone (§6.3 step 9, MCP-2).
      let run = runs.get(id);
      const askApp = !run && session.status === 'receiving' && (session.received.length > 0 || handedOff.has(id));
      if (!run && !(askApp && await appUploads())) run = startRun(session, resolved, sha256);

      if (!run) {
        // The App is uploading: watch the hub until the deadline. When no bytes arrive for a while, ask the App again and take
        // the upload over if it no longer has it.
        let last = session;
        let lastAt = now();
        let rate: number | undefined;
        let movedAt = now();
        while (now() < deadline && !run) {
          await sleep(Math.min(env.pollMs ?? 1000, Math.max(0, deadline - now())));
          const current = await env.api.status(id);
          const elapsed = (now() - lastAt) / 1000;
          if (elapsed > 0 && current.bytes_received !== undefined && last.bytes_received !== undefined) rate = (current.bytes_received - last.bytes_received) / elapsed || rate;
          if ((current.bytes_received ?? 0) !== (last.bytes_received ?? 0) || current.status !== last.status) movedAt = now();
          last = current;
          lastAt = now();
          progress(current.bytes_received ?? 0);
          if (current.status === 'ready') { handedOff.delete(id); return toolResult({ ...readyOutput(current.media, { ...fallback, media_id: current.media_id }, false) }); }
          if (current.status === 'failed') { handedOff.delete(id); throw new ToolError(current.error?.code ?? 'MEDIA_FAILED', current.error?.message ?? 'The upload failed on the hub.'); }
          if (current.status === 'receiving' && now() - movedAt >= (env.handoffRecheckMs ?? HANDOFF_RECHECK_MS)) {
            movedAt = now();
            if (!(await appUploads())) run = startRun(current, resolved, sha256);
          }
        }
        if (!run) {
          const processing = last.status === 'assembling' || last.status === 'processing';
          return toolResult({ ...base, status: processing ? 'processing' : 'uploading', uploaded_bytes: last.bytes_received ?? 0,
            eta_seconds: eta(bytes, last.bytes_received ?? 0, rate), continues_in_background: true } satisfies MediaUploadOutput,
          'The SmartSell app continues this upload in the background. Tell the owner to keep this computer awake. post_schedule accepts this media_id now.');
        }
      }

      const active = run;
      active.listeners.add(progress);
      progress(active.uploadedBytes);
      let outcome: RunOutcome | undefined;
      try {
        const stop = new AbortController();
        const timeout = sleep(Math.max(0, deadline - now()), stop.signal).then(() => undefined, () => undefined);
        outcome = await Promise.race([active.promise, timeout]);
        stop.abort();
      } finally { active.listeners.delete(progress); }
      if (outcome?.status === 'ready') return toolResult({ ...readyOutput(outcome.session?.media, { ...fallback, media_id: session.media_id }, false) });
      if (outcome?.status === 'failed') throw new ToolError(outcome.error ?? 'MEDIA_FAILED', outcome.message ?? 'The upload failed.');

      // Deadline: hand the rest to the resident App when there is one, otherwise keep uploading in this process.
      let handed = false;
      if (active.phase === 'uploading' && env.handoff) {
        handed = await appUploads();
        if (handed) {
          // The App has it now; a call that arrives before this run has unwound must ask the App, not join a stopped run.
          if (runs.get(id) === active) runs.delete(id);
          active.controller.abort(new Error('handed off to the SmartSell app'));
        }
      }
      active.background = true;
      if (!handed) env.onBackground?.(active.promise.catch(error => env.log?.(`SmartSell relay: background upload stopped: ${(error as Error).message}`)));
      const processing = active.phase === 'processing';
      const rate = active.sentBytes > 0 ? active.sentBytes / Math.max(0.001, (now() - active.startedAt) / 1000) : undefined;
      const output: MediaUploadOutput = { ...base, status: processing ? 'processing' : 'uploading', uploaded_bytes: processing ? bytes : active.uploadedBytes,
        eta_seconds: eta(bytes, processing ? bytes : active.uploadedBytes, rate), continues_in_background: handed || processing };
      const note = processing ? 'All bytes reached the hub; it is still processing. post_schedule accepts this media_id now.'
        : handed ? 'The SmartSell app continues this upload in the background. Tell the owner to keep this computer awake. post_schedule accepts this media_id now.'
          : 'The upload continues only while this conversation stays open. Tell the owner not to close it and to keep the computer awake until it finishes. post_schedule accepts this media_id now.';
      return toolResult({ ...output }, note);
    } catch (error) {
      return toolError(toolErrorFromHub(error));
    }
  }

  return { handle, runs, idle: async () => { while (runs.size) await Promise.allSettled([...runs.values()].map(run => run.promise)); } };
}
