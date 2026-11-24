// Local job store and outbox (§8.4). Every write is atomic (tmp → fsync →
// rename → fsync dir) and synchronous: a state transition is on disk before
// the caller takes its next step, and in particular before any Post click.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  isFactReport, type Blocker, type ClaimedJob, type GoDenyReason, type HeartbeatV2Response, type JobReport, type JobReportData,
  type JobReportEvent,
} from './contracts.ts';

export type LocalState = 'claimed' | 'downloading' | 'media_ready' | 'preflighting' | 'preparing' | 'ready' | 'blocked' | 'waiting_go'
  | 'running' | 'submitting' | 'result_pending' | 'done' | 'missed' | 'released' | 'failed';
export const LOCAL_FINAL_STATES: readonly LocalState[] = ['done', 'missed', 'released', 'failed'];
/** States in which the Post button has not been clicked and never will be by this attempt. */
export const PRE_RUN_STATES: readonly LocalState[] = ['claimed', 'downloading', 'media_ready', 'preflighting', 'preparing', 'ready', 'blocked', 'waiting_go'];
export const isLocalFinal = (state: LocalState) => LOCAL_FINAL_STATES.includes(state);
export const isPreRun = (state: LocalState) => PRE_RUN_STATES.includes(state);

export interface LocalSync {
  hold: boolean; hold_reason: GoDenyReason | null; mode: 'auto' | 'assist'; resume_token: number;
  machine_paused: boolean; pause_all: boolean; channel_paused: boolean; synced_at: string;
}

export interface LocalJob {
  claimed: ClaimedJob;
  state: LocalState;
  media_paths: Record<string, string>;
  sync: LocalSync;
  last_sync_at: string;
  offline_go_disabled: boolean;
  revoked: boolean;
  fence: number; next_seq: number;
  blocker?: Blocker; preflight_at?: string; prepared_at?: string; started_at?: string; submitting_at?: string; submitted_at?: string;
  result?: { url: string | null; external_post_id: string | null; published_at: string | null; evidence_sha256: string[] };
  readback_attempts: number;
  // Fields beyond §8.4 used by the runner:
  blocker_stage?: 'preflight' | 'final' | 'before_submit';
  /** resume_token seen when an owner-resume blocker was raised; a larger token clears it (§8.5). */
  blocker_resume_token?: number;
  go_source?: 'hub' | 'offline';
  run_mode?: 'auto' | 'assist';
  submitted_by?: 'auto' | 'owner';
  /** Publish hint for read-back; known_ids (WA-1) are the TikTok content list's video ids seen before the click. */
  hint?: { url?: string; external_post_id?: string; known_ids?: string[] };
  next_readback_at?: string;
  finished_at?: string;
  final_reason?: string;
  /** Consecutive heartbeats in which the hub no longer listed this held job. */
  hub_absent?: number;
  /**
   * WA-6: a terminal fact written in the same atomic job write as the final state. It is moved to the outbox right
   * after; if the process dies in between, JobRunner.start() queues it (matched by event_id, so never twice).
   */
  pending_report?: { event_id: string; event: JobReportEvent; data: JobReportData; at: string };
}

export interface OutboxEntry { event_id: string; job_id: string; fencing_token: number; seq: number; kind: 'fact' | 'lease'; report: JobReport }
export interface StoredOutboxEntry extends OutboxEntry { file: string }

export interface RuntimeState {
  last_sync_at: string | null;
  machine: { paused: boolean; pause_all: boolean; synced_at: string } | null;
  channels: HeartbeatV2Response['channels'];
  applied_sync_generation: number;
  clock_offset_ms: number | null;
  released_jobs: string[];
  emergency_stop: boolean;
  outbox_counter: number;
  /** social_account_id → last successful login check or preflight (§8.5 preflight skip). */
  channel_checks: Record<string, string>;
  /** Local successes for the offline daily cap (§5.7 rule 6). */
  successes: { social_account_id: string; local_date: string; job_id: string }[];
  driver_config: { version: string; sha256: string } | null;
  posture_sent_at: string | null;
  posture_key: string | null;
}

export interface EvidenceRecord { n: number; sha256: string; label: string; mime: 'image/jpeg' | 'image/png'; bytes: number; uploaded: boolean; rejected?: boolean; at: string }

const emptyState = (): RuntimeState => ({
  last_sync_at: null, machine: null, channels: [], applied_sync_generation: 0, clock_offset_ms: null, released_jobs: [],
  emergency_stop: false, outbox_counter: 0, channel_checks: {}, successes: [], driver_config: null, posture_sent_at: null, posture_key: null,
});

/** Atomic write: temporary file, fsync, rename, then fsync of the directory (where the OS allows it). */
export function writeAtomic(path: string, data: string | Uint8Array, mode = 0o600) {
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(temp, 'w', mode);
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, path);
  syncDirectory(join(path, '..'));
}

export function syncDirectory(dir: string) {
  let fd: number | undefined;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); }
  catch { /* Windows cannot fsync a directory handle; the rename is still atomic there. */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

export type StoreFault = (operation: 'job' | 'state' | 'outbox' | 'evidence') => void;

export class JobStore {
  readonly jobsDir: string;
  readonly outboxDir: string;
  readonly evidenceDir: string;
  readonly statePath: string;
  #jobs = new Map<string, LocalJob>();
  #state: RuntimeState;
  /** Test hook: throw from here to simulate a crash between two writes. */
  fault?: StoreFault;

  constructor(readonly root: string) {
    this.jobsDir = join(root, 'jobs');
    this.outboxDir = join(root, 'outbox');
    this.evidenceDir = join(root, 'evidence');
    this.statePath = join(root, 'runtime-state.json');
    for (const dir of [root, this.jobsDir, this.outboxDir, this.evidenceDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#cleanTemporary(this.jobsDir);
    this.#cleanTemporary(this.outboxDir);
    this.#cleanTemporary(root);
    this.#state = this.#readState();
    for (const name of readdirSync(this.jobsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(readFileSync(join(this.jobsDir, name), 'utf8')) as LocalJob;
        if (job?.claimed?.job_id) this.#jobs.set(job.claimed.job_id, job);
      } catch { /* A corrupt record is ignored; the hub re-issues jobs we no longer list as held. */ }
    }
    // The outbox counter must stay ahead of any file already on disk.
    const highest = this.#outboxFiles().map(name => Number(name.slice(0, 13))).reduce((max, value) => Math.max(max, value), 0);
    if (highest > this.#state.outbox_counter) this.#state.outbox_counter = highest;
  }

  #cleanTemporary(dir: string) {
    for (const name of readdirSync(dir)) if (name.endsWith('.tmp')) rmSync(join(dir, name), { force: true });
  }

  #readState(): RuntimeState {
    try { return { ...emptyState(), ...JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<RuntimeState> }; }
    catch { return emptyState(); }
  }

  // ---------- jobs ----------
  jobs(): LocalJob[] { return [...this.#jobs.values()].map(job => structuredClone(job)); }
  get(jobId: string): LocalJob | undefined { const job = this.#jobs.get(jobId); return job && structuredClone(job); }
  has(jobId: string) { return this.#jobs.has(jobId); }
  heldJobIds(): string[] { return [...this.#jobs.values()].filter(job => !isLocalFinal(job.state)).map(job => job.claimed.job_id); }

  put(job: LocalJob) {
    this.fault?.('job');
    writeAtomic(join(this.jobsDir, `${job.claimed.job_id}.json`), JSON.stringify(job));
    this.#jobs.set(job.claimed.job_id, structuredClone(job));
  }

  /** Read-modify-write of one job. Returns the stored copy. */
  update(jobId: string, change: (job: LocalJob) => void): LocalJob {
    const current = this.get(jobId);
    if (!current) throw new Error(`Unknown local job ${jobId}`);
    change(current);
    this.put(current);
    return current;
  }

  remove(jobId: string) {
    rmSync(join(this.jobsDir, `${jobId}.json`), { force: true });
    this.#jobs.delete(jobId);
  }

  // ---------- runtime state ----------
  state(): RuntimeState { return structuredClone(this.#state); }
  updateState(change: (state: RuntimeState) => void): RuntimeState {
    const next = structuredClone(this.#state);
    change(next);
    this.fault?.('state');
    writeAtomic(this.statePath, JSON.stringify(next));
    this.#state = next;
    return structuredClone(next);
  }

  // ---------- outbox ----------
  #outboxFiles() { return readdirSync(this.outboxDir).filter(name => /^\d{13}-.+\.json$/.test(name)).sort(); }

  /**
   * Appends a report for `jobId`: first the job's next_seq is advanced and written,
   * then the outbox file. Callers write their own state transition before calling this.
   */
  enqueue(jobId: string, event: JobReportEvent, data: JobReportData, workerTime: string, eventId: string = randomUUID()): StoredOutboxEntry {
    const job = this.update(jobId, value => { value.next_seq += 1; });
    const seq = job.next_seq - 1;
    const report: JobReport = { job_id: jobId, fencing_token: job.fence, seq, event_id: eventId, worker_time: workerTime, event, data };
    const counter = this.updateState(state => { state.outbox_counter += 1; }).outbox_counter;
    const file = `${String(counter).padStart(13, '0')}-${jobId}.json`;
    const entry: OutboxEntry = { event_id: report.event_id, job_id: jobId, fencing_token: job.fence, seq, kind: isFactReport(report) ? 'fact' : 'lease', report };
    this.fault?.('outbox');
    writeAtomic(join(this.outboxDir, file), JSON.stringify(entry));
    return { ...entry, file };
  }

  outbox(): StoredOutboxEntry[] {
    const entries: StoredOutboxEntry[] = [];
    for (const file of this.#outboxFiles()) {
      try { entries.push({ ...JSON.parse(readFileSync(join(this.outboxDir, file), 'utf8')) as OutboxEntry, file }); }
      catch { rmSync(join(this.outboxDir, file), { force: true }); }
    }
    return entries;
  }
  outboxDepth() { return this.#outboxFiles().length; }

  removeOutbox(entry: Pick<StoredOutboxEntry, 'file'>) {
    rmSync(join(this.outboxDir, entry.file), { force: true });
    syncDirectory(this.outboxDir);
  }

  /** Rewrites a pending entry in place (used to renumber seq after SEQ_GAP). */
  rewriteOutbox(entry: StoredOutboxEntry) {
    const { file, ...value } = entry;
    writeAtomic(join(this.outboxDir, file), JSON.stringify(value));
  }

  // ---------- evidence ----------
  #evidenceIndex(jobId: string): EvidenceRecord[] {
    try { return JSON.parse(readFileSync(join(this.evidenceDir, jobId, 'index.json'), 'utf8')) as EvidenceRecord[]; }
    catch { return []; }
  }

  addEvidence(jobId: string, label: string, bytes: Uint8Array, mime: EvidenceRecord['mime'] = 'image/jpeg', at = new Date().toISOString()): string {
    const dir = join(this.evidenceDir, jobId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const index = this.#evidenceIndex(jobId);
    if (index.some(record => record.sha256 === sha256)) return sha256;
    const n = index.reduce((max, record) => Math.max(max, record.n), 0) + 1;
    this.fault?.('evidence');
    writeAtomic(join(dir, `${n}.${mime === 'image/png' ? 'png' : 'jpg'}`), bytes);
    index.push({ n, sha256, label, mime, bytes: bytes.length, uploaded: false, at });
    writeAtomic(join(dir, 'index.json'), JSON.stringify(index));
    return sha256;
  }

  evidence(jobId: string): EvidenceRecord[] { return this.#evidenceIndex(jobId); }

  evidenceBytes(jobId: string, record: EvidenceRecord) {
    return readFileSync(join(this.evidenceDir, jobId, `${record.n}.${record.mime === 'image/png' ? 'png' : 'jpg'}`));
  }

  markEvidence(jobId: string, sha256: string, outcome: 'uploaded' | 'rejected') {
    const index = this.#evidenceIndex(jobId);
    const record = index.find(item => item.sha256 === sha256);
    if (!record) return;
    if (outcome === 'uploaded') record.uploaded = true; else record.rejected = true;
    writeAtomic(join(this.evidenceDir, jobId, 'index.json'), JSON.stringify(index));
  }

  /**
   * Housekeeping: evidence of jobs that ended more than `retainMs` ago and whose
   * screenshots were all uploaded is removed, and so are those finished job records
   * once no outbox entry references them.
   */
  collect(now: number, retainMs = 7 * 24 * 3600_000) {
    const pending = new Set(this.outbox().map(entry => entry.job_id));
    for (const job of this.#jobs.values()) {
      if (!isLocalFinal(job.state) || !job.finished_at || now - Date.parse(job.finished_at) < retainMs || pending.has(job.claimed.job_id)) continue;
      const index = this.#evidenceIndex(job.claimed.job_id);
      if (index.some(record => !record.uploaded && !record.rejected)) continue;
      rmSync(join(this.evidenceDir, job.claimed.job_id), { recursive: true, force: true });
      this.remove(job.claimed.job_id);
    }
  }

  /** Size in bytes of a file under the store, for diagnostics. */
  static fileSize(path: string) { return existsSync(path) ? statSync(path).size : 0; }
}
