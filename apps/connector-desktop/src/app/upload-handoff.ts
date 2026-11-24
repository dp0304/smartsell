// Upload hand-off server (C12, §6.3 step 9, §6.8). The relay that Codex
// started hands its unfinished upload to the resident laptop App over a local
// socket (`<userData>/agent-relay/ipc.sock`, Windows named pipe). The App
// accepts only a message whose path still holds the file the hub session was
// created for (same SHA-256 and size; same name, or the bytes re-hashed) and
// then continues it with continueUpload() while blocking idle sleep. The
// upload survives Codex closing; the hub notifies the owner when it is done.
// When the App gives up on an upload (not when it quits or updates), it aborts
// the hub session so the media fails and the owner is alerted (§6.3 step 9).
// A run that stopped never blocks the relay's next hand-off: accept() starts it
// again, and the relay asks on every media_upload (MCP-2).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { createConnection, type Server } from 'node:net';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  continueUpload as relayContinueUpload, createHandoffServer, createHubApi, resolveMediaPath, type HandoffMessage, type UploadSessionView,
} from '@smartsell/agent-relay';

export interface RelayCredentials { hubOrigin: string; token: string }

export interface HandoffUploadView {
  upload_id: string; filename: string; bytes: number; received: number; status: 'uploading' | 'processing' | 'ready' | 'failed';
  error: string | null; started_at: string; finished_at: string | null;
}

export interface UploadHandoffOptions {
  socketPath: string;
  /** `<userData>/agent-relay`; created 0700 so other local users cannot reach the socket. */
  dataDir: string;
  platform?: NodeJS.Platform;
  /** Reads hub origin and token from config.json + credential (null when this laptop is not connected yet). */
  credentials(): Promise<RelayCredentials | null>;
  continueUpload?: typeof relayContinueUpload;
  /** Session lookup; defaults to GET /api/v1/agent/uploads/:id with the agent token. */
  session?(credentials: RelayCredentials, uploadId: string): Promise<UploadSessionView>;
  /** Tells the hub the App gave up; defaults to POST /api/v1/agent/uploads/:id/abort {reason:'error'} with the agent token. */
  abortUpload?(credentials: RelayCredentials, uploadId: string): Promise<unknown>;
  /** Idle-sleep blocker (power.ts). */
  hold?(reason: string, on: boolean): void;
  onChange?(): void;
  now?(): number;
  homeDir?: string;
  log?(message: string, detail?: object): void;
}

const ACTIVE_SESSION_STATES = new Set(['receiving', 'assembling', 'processing']);

async function sha256File(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function stalePosixSocket(path: string) {
  return new Promise<boolean>(resolve => {
    const socket = createConnection(path);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(['ECONNREFUSED', 'ENOTSOCK', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')));
  });
}

export class UploadHandoff {
  readonly #o: UploadHandoffOptions;
  readonly #runs = new Map<string, { view: HandoffUploadView; abort: AbortController; done: Promise<void> }>();
  #server?: Server;

  constructor(options: UploadHandoffOptions) { this.#o = options; }

  get listening() { return !!this.#server?.listening; }

  async start() {
    if (this.#server) return;
    const platform = this.#o.platform ?? process.platform;
    if (platform !== 'win32') {
      mkdirSync(this.#o.dataDir, { recursive: true, mode: 0o700 });
      try { chmodSync(this.#o.dataDir, 0o700); } catch { /* best effort */ }
      // A socket left by a crashed App refuses connections; the single-instance lock makes us its only owner.
      if (existsSync(this.#o.socketPath) && await stalePosixSocket(this.#o.socketPath)) rmSync(this.#o.socketPath, { force: true });
    }
    this.#server = await createHandoffServer(this.#o.socketPath, message => this.accept(message));
    if (platform !== 'win32') { try { chmodSync(this.#o.socketPath, 0o600); } catch { /* best effort */ } }
  }

  async stop() {
    for (const run of this.#runs.values()) run.abort.abort();
    await new Promise<void>(resolve => { if (!this.#server) resolve(); else this.#server.close(() => resolve()); });
    this.#server = undefined;
    await Promise.allSettled([...this.#runs.values()].map(run => run.done));
  }

  uploads(): HandoffUploadView[] {
    return [...this.#runs.values()].map(run => ({ ...run.view })).sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  /** Decides one hand-off (the server already checked the message shape with isHandoffMessage). */
  async accept(message: HandoffMessage): Promise<boolean> {
    const running = this.#runs.get(message.upload_id);
    if (running && (running.view.status === 'uploading' || running.view.status === 'processing')) {
      return running.view.bytes === message.bytes; // the relay asks again before resuming: never start a second upload
    }
    const credentials = await this.#o.credentials().catch(() => null);
    if (!credentials) { this.#o.log?.('handoff refused: this laptop is not connected to a hub'); return false; }
    // 1. The path must still be the regular, allowed file the relay hashed.
    let real: string;
    try {
      const resolved = await resolveMediaPath(message.path, { platform: this.#o.platform, homeDir: this.#o.homeDir, denyDirs: [this.#o.dataDir] });
      if (resolved.stat.size !== message.bytes || resolved.stat.mtimeMs !== message.mtime_ms) {
        this.#o.log?.('handoff refused: the file changed', { upload_id: message.upload_id });
        return false;
      }
      real = resolved.real;
    } catch (error) {
      this.#o.log?.('handoff refused: path not allowed or missing', { upload_id: message.upload_id, code: (error as { code?: string }).code });
      return false;
    }
    // 2. It must match an existing, unfinished hub session for this upload.
    let session: UploadSessionView;
    try {
      session = await (this.#o.session ?? ((creds, id) => createHubApi(creds).status(id)))(credentials, message.upload_id);
    } catch (error) {
      this.#o.log?.('handoff refused: no such upload session', { upload_id: message.upload_id, error: String(error) });
      return false;
    }
    if (session.sha256 !== message.sha256 || session.bytes !== message.bytes || !ACTIVE_SESSION_STATES.has(session.status)) {
      this.#o.log?.('handoff refused: session does not match', { upload_id: message.upload_id, status: session.status });
      return false;
    }
    if (session.filename && session.filename !== basename(real) && session.filename !== basename(message.path)) {
      // A link or a renamed file: accept only when the bytes are the ones the session declared.
      if (await sha256File(real).catch(() => null) !== message.sha256) {
        this.#o.log?.('handoff refused: file content does not match the session', { upload_id: message.upload_id });
        return false;
      }
    }
    this.#run(credentials, message, real, session);
    return true;
  }

  #run(credentials: RelayCredentials, message: HandoffMessage, path: string, session: UploadSessionView) {
    const now = this.#o.now ?? Date.now;
    const abort = new AbortController();
    const view: HandoffUploadView = {
      upload_id: message.upload_id, filename: session.filename ?? basename(path), bytes: message.bytes,
      received: session.bytes_received ?? 0, status: 'uploading', error: null, started_at: new Date(now()).toISOString(), finished_at: null,
    };
    const reason = `upload:${message.upload_id}`;
    this.#o.hold?.(reason, true);
    const done = (async () => {
      try {
        const outcome = await (this.#o.continueUpload ?? relayContinueUpload)({
          hubOrigin: credentials.hubOrigin, token: credentials.token, uploadId: message.upload_id, path, sha256: message.sha256,
          bytes: message.bytes, mtimeMs: message.mtime_ms, signal: abort.signal,
          onProgress: received => { view.received = received; this.#o.onChange?.(); },
        });
        view.status = outcome.status;
        view.error = outcome.error ?? null;
        if (outcome.status !== 'failed') view.received = message.bytes;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Quitting or updating aborts our own signal: that is not giving up, the next hand-off resumes the session. The run
        // reads as active until the hub was told, so a hand-off arriving meanwhile cannot start a run the abort would end.
        if (!abort.signal.aborted && reason !== 'UPLOAD_SESSION_MISMATCH') await this.#giveUp(credentials, message.upload_id);
        view.status = 'failed';
        view.error = reason;
      } finally {
        view.finished_at = new Date(now()).toISOString();
        this.#o.hold?.(reason, false);
        this.#o.log?.('handed-off upload finished', { upload_id: message.upload_id, status: view.status, error: view.error });
        this.#o.onChange?.();
      }
    })();
    this.#runs.set(message.upload_id, { view, abort, done });
    this.#o.onChange?.();
  }

  /**
   * §6.3 step 9 (MCP-3): the App gave up, so tell the hub, which marks the media failed and alerts the owner (upload_failed).
   * Only a session that is still receiving: once complete was accepted the hub finishes and reports by itself, and a session
   * continueUpload already aborted is failed. Best effort: an unreachable hub keeps the session resumable by the next hand-off.
   */
  async #giveUp(credentials: RelayCredentials, uploadId: string) {
    try {
      const session = await (this.#o.session ?? ((creds, id) => createHubApi(creds).status(id)))(credentials, uploadId);
      if (session.status !== 'receiving') return;
      await (this.#o.abortUpload ?? ((creds, id) => createHubApi(creds).abort(id, 'error')))(credentials, uploadId);
      this.#o.log?.('handed-off upload aborted on the hub', { upload_id: uploadId });
    } catch (error) {
      this.#o.log?.('could not tell the hub about the failed upload', { upload_id: uploadId, error: String(error) });
    }
  }
}
