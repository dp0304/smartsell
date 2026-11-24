import { stat } from 'node:fs/promises';
import { createHubApi, HubApiError, NETWORK_ERROR, transientHubError, type HubApi, type UploadSessionView } from './hub-api.ts';
import { BACKGROUND_RETRY_MS, defaultTuning, uploadMissing, UploadStopped, type PartRecord, type UploadProgress, type UploadTuning } from './uploader.ts';

export type RunPhase = 'uploading' | 'processing' | 'ready' | 'failed';
export interface RunOutcome { status: 'ready' | 'processing' | 'failed'; error?: string; message?: string; session?: UploadSessionView }

export interface DriveOptions {
  api: HubApi;
  target: { uploadId: string; path: string; bytes: number; mtimeMs: number; sha256: string };
  /** Session as the hub last reported it; fetched when absent. */
  session?: UploadSessionView;
  tuning?: Partial<UploadTuning>;
  signal?: AbortSignal;
  pollMs?: number;
  onProgress?: (progress: UploadProgress & { phase: RunPhase }) => void;
  onPhase?: (phase: RunPhase) => void;
  parts?: PartRecord[];
  /**
   * Asked when the run fails on its own (not through `signal`) before the hub accepted complete. True: this is a background
   * run nobody else will report, so tell the hub to abort ('error'); the hub marks the media failed and alerts the owner
   * (§6.3 step 9, MCP-3). A foreground failure goes to the model instead, which can call media_upload again to resume.
   */
  abortOnGiveUp?: () => boolean;
}

const terminal = (session: UploadSessionView) => session.status === 'ready' || session.status === 'failed';

async function retryStatus(api: HubApi, id: string, tuning: UploadTuning, signal?: AbortSignal) {
  const delays = tuning.retryDelaysMs();
  for (let attempt = 0; ; attempt++) {
    try { return await api.status(id, signal); }
    catch (error) {
      if (signal?.aborted || !(error instanceof HubApiError) || (error.code !== NETWORK_ERROR && error.status < 500) || attempt >= delays.length) throw error;
      await tuning.sleep(delays[attempt], signal);
    }
  }
}

/**
 * complete is idempotent on the hub (a session that is no longer receiving answers with its status), so a lost answer or a
 * hub restart is retried on the same schedule as parts: 1–16 s in the foreground, then every 30 s for 30 minutes in the
 * background (MCP-3). The delays are read on every failure, so a run that moves to the background keeps trying longer.
 */
async function retryComplete(api: HubApi, id: string, tuning: UploadTuning, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try { return await api.complete(id, signal); }
    catch (error) {
      const delays = tuning.retryDelaysMs();
      if (signal?.aborted || !transientHubError(error) || attempt >= delays.length) throw error;
      await tuning.sleep(delays[attempt], signal);
    }
  }
}

/**
 * Finish one upload session: send the missing chunks, complete it, then poll until the hub reports ready or failed.
 * Shared by media_upload (foreground, then in-process background) and continueUpload (the laptop App, §6.3 step 9).
 */
export async function driveUpload(options: DriveOptions): Promise<RunOutcome> {
  const { api, target, signal } = options;
  const tuning = { ...defaultTuning(), ...options.tuning };
  // True from the first upload round until the hub accepts complete; only then can a failure leave the session stranded.
  const state = { receiving: false };
  try {
    return await receiveAndFinish(options, tuning, state);
  } catch (error) {
    // Once complete is accepted the hub assembles and reports by itself; before that nobody else finishes or reports it.
    if (state.receiving && !signal?.aborted && options.abortOnGiveUp?.()) await api.abort(target.uploadId, 'error').catch(() => undefined);
    throw error;
  }
}

async function receiveAndFinish(options: DriveOptions, tuning: UploadTuning, state: { receiving: boolean }): Promise<RunOutcome> {
  const { api, target, signal } = options;
  const pollMs = options.pollMs ?? 1000;
  let session = options.session ?? await retryStatus(api, target.uploadId, tuning, signal);
  const fail = (code: string, message: string): RunOutcome => { options.onPhase?.('failed'); return { status: 'failed', error: code, message, session }; };
  for (let round = 0; session.status === 'receiving'; round++) {
    state.receiving = true;
    if (round > 5) throw new Error('The hub keeps rejecting parts for this upload.');
    if ((session.bytes !== undefined && session.bytes !== target.bytes) || (session.sha256 !== undefined && session.sha256 !== target.sha256)) {
      return fail('UPLOAD_SESSION_MISMATCH', 'The hub session does not match this file.');
    }
    options.onPhase?.('uploading');
    try {
      await uploadMissing(api, { uploadId: target.uploadId, path: target.path, bytes: target.bytes, mtimeMs: target.mtimeMs,
        chunkBytes: session.chunk_bytes, chunks: session.chunks }, session.received, {
        tuning, signal, parts: options.parts, onProgress: progress => options.onProgress?.({ ...progress, phase: 'uploading' }) });
    } catch (error) {
      if (error instanceof UploadStopped) { session = await retryStatus(api, target.uploadId, tuning, signal); continue; }
      if ((error as { code?: string }).code === 'FILE_CHANGED') {
        // Tell the hub, which marks the media failed and notifies the owner (§6.3 step 9).
        await api.abort(target.uploadId, 'file_changed').catch(() => undefined);
        return fail('FILE_CHANGED', 'The file changed while it was uploading.');
      }
      throw error;
    }
    try {
      await retryComplete(api, target.uploadId, tuning, signal);
      state.receiving = false;
    } catch (error) {
      // A chunk went missing (for example a lost response): refresh and send the rest. Give up after a few rounds.
      if (!(error instanceof HubApiError) || error.code !== 'UPLOAD_INCOMPLETE' || round >= 3) {
        if (error instanceof HubApiError && error.status === 409) { session = await retryStatus(api, target.uploadId, tuning, signal); if (terminal(session)) break; }
        throw error;
      }
    }
    session = await retryStatus(api, target.uploadId, tuning, signal);
  }
  state.receiving = false;
  if (session.status !== 'ready' && session.status !== 'failed') options.onPhase?.('processing');
  while (!terminal(session)) {
    try { await tuning.sleep(pollMs, signal); }
    catch { return { status: 'processing', session }; }
    session = await retryStatus(api, target.uploadId, tuning, signal);
  }
  if (session.status === 'failed') return fail(session.error?.code ?? 'MEDIA_FAILED', session.error?.message ?? 'The hub could not process the upload.');
  options.onPhase?.('ready');
  return { status: 'ready', session };
}

export interface ContinueUploadOptions {
  hubOrigin: string; token: string; uploadId: string; path: string; sha256: string; bytes: number; mtimeMs: number;
  /** Aborting it stops the upload without failing the hub session (the App quitting or updating); the next hand-off resumes it. */
  signal?: AbortSignal;
  onProgress?(received: number): void; fetch?: typeof fetch;
  /** Test seam: part sizing, retries and clocks. */
  tuning?: Partial<UploadTuning>;
  pollMs?: number;
}

/**
 * C5: resume an upload that the relay handed off (the laptop App calls this, §6.3 step 9 and C12). Accepts only a
 * session whose SHA-256 and size match, and a file whose size and mtime still match; otherwise nothing is sent.
 * It is always a background run: when it gives up on its own while the session is still receiving, it aborts the session
 * ('error') so the hub marks the media failed and alerts the owner, then rethrows (MCP-3).
 */
export async function continueUpload(options: ContinueUploadOptions): Promise<{ status: 'ready' | 'processing' | 'failed'; error?: string }> {
  const api = createHubApi({ hubOrigin: options.hubOrigin, token: options.token, fetch: options.fetch });
  const tuning = { retryDelaysMs: () => BACKGROUND_RETRY_MS, ...options.tuning };
  const session = await api.status(options.uploadId, options.signal);
  // The App accepts a handoff only for the session the relay created for this very file (§6.8).
  if (session.sha256 !== options.sha256 || session.bytes !== options.bytes) throw new Error('UPLOAD_SESSION_MISMATCH');
  if (session.status === 'receiving') {
    const info = await stat(options.path).catch(() => undefined);
    if (!info || info.size !== options.bytes || info.mtimeMs !== options.mtimeMs) {
      await api.abort(options.uploadId, 'file_changed').catch(() => undefined);
      return { status: 'failed', error: 'FILE_CHANGED' };
    }
  }
  const outcome = await driveUpload({ api, session, signal: options.signal, tuning, pollMs: options.pollMs, abortOnGiveUp: () => true,
    target: { uploadId: options.uploadId, path: options.path, bytes: options.bytes, mtimeMs: options.mtimeMs, sha256: options.sha256 },
    onProgress: progress => options.onProgress?.(progress.uploadedBytes) });
  return outcome.error ? { status: outcome.status, error: outcome.error } : { status: outcome.status };
}
