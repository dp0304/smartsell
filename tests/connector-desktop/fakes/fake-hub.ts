// In-process fake hub implementing the signed device protocol (§5.4, §6.6,
// §8.13, Appendix B.2) closely enough to test the Worker client: Ed25519
// request signatures with a 60 s window and nonce replay protection, heartbeat
// v2, jobs.claim/go/report with fencing, event_id de-duplication and per-fence
// seq, Range media download, evidence upload and driver-config. It also lets
// tests inject faults (status codes, network drops, clock skew).
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import {
  TERMINAL_JOB_STATUSES, isFactReport, type ClaimedJob, type GoDenyReason, type HeartbeatV2Request, type HeartbeatV2Response,
  type JobReport, type RevokeReason, type WorkerJobStatus,
} from '../../../packages/contracts/src/phase1.ts';

export interface FakeJob {
  claimed: ClaimedJob; deviceId: string; status: WorkerJobStatus; history: string[];
  hold: boolean; hold_reason: GoDenyReason | null; mode: 'auto' | 'assist'; resume_token: number;
  revoke: RevokeReason | null; approval_invalid: boolean; media_pending: boolean;
  seq_by_fence: Record<number, number>; event_ids: Set<string>; reports: JobReport[]; go_source: 'hub' | 'offline' | null;
  result: Record<string, unknown> | null; fence_override: boolean;
}

export interface Fault {
  action: string; times?: number; status?: number; code?: string; retryAfter?: string; details?: Record<string, unknown>;
  /** Destroy the socket instead of answering (connection error). */
  network?: boolean; delayMs?: number;
  /** Only when the report event matches. */
  event?: string;
}

export interface RequestLog { action: string; method: string; path: string; at: number; body: unknown; status: number }

const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
};

async function raw(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export class FakeHub {
  origin = '';
  readonly workspaceId = 'ws-fake-0001';
  readonly devices = new Map<string, { publicKey: string; name: string; platform: string }>();
  readonly jobs = new Map<string, FakeJob>();
  readonly media = new Map<string, { bytes: Buffer; corruptOnce?: boolean; truncateOnceAt?: number }>();
  readonly evidence = new Map<string, { sha256: string; bytes: number; mime: string }[]>();
  readonly registrations: unknown[] = [];
  readonly log: RequestLog[] = [];
  readonly faults: Fault[] = [];
  pairingCodes = new Set<string>();
  paused = false;
  pauseAll = false;
  syncGeneration = 1;
  channels: HeartbeatV2Response['channels'] = [];
  latestWorker: HeartbeatV2Response['latest_worker'] = null;
  driverConfig: { bytes: Buffer; version: string; sha256: string } | null = null;
  /** Hub clock = real clock + offset (tests of clock correction and DEVICE_PROOF_EXPIRED). */
  clockOffsetMs = 0;
  revokedDevices = new Set<string>();
  #down = false;
  #nonces = new Set<string>();
  #sockets = new Set<Socket>();
  #server = createServer((request, response) => { void this.#handle(request, response); });

  now() { return Date.now() + this.clockOffsetMs; }

  async start(port = 0) {
    this.#server.on('connection', socket => { this.#sockets.add(socket); socket.on('close', () => this.#sockets.delete(socket)); });
    await new Promise<void>(resolve => this.#server.listen(port, '127.0.0.1', () => resolve()));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async close() {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>(resolve => this.#server.close(() => resolve()));
  }

  /** While down, every request gets its connection reset (hub unreachable). */
  setDown(down: boolean) { this.#down = down; if (down) for (const socket of this.#sockets) socket.destroy(); }

  inject(fault: Fault) { this.faults.push({ times: 1, ...fault }); }

  issuePairingCode() { const code = randomBytes(24).toString('base64url'); this.pairingCodes.add(code); return code; }

  /** Registers a device key directly (tests that skip pairing). */
  addDevice(deviceId: string, publicKeyDer: string, name = 'Mac-B') { this.devices.set(deviceId, { publicKey: publicKeyDer, name, platform: 'darwin' }); }

  addJob(deviceId: string, claimed: ClaimedJob, status: WorkerJobStatus = 'queued') {
    const job: FakeJob = { claimed: structuredClone(claimed), deviceId, status, history: [deviceId], hold: false, hold_reason: null, mode: claimed.mode,
      resume_token: 0, revoke: null, approval_invalid: false, media_pending: false, seq_by_fence: {}, event_ids: new Set(), reports: [], go_source: null,
      result: null, fence_override: false };
    this.jobs.set(claimed.job_id, job);
    return job;
  }

  job(id: string) { const job = this.jobs.get(id); if (!job) throw new Error(`no job ${id}`); return job; }
  events(id: string) { return this.job(id).reports.map(report => report.event); }
  actions() { return this.log.map(entry => entry.action); }

  #fault(action: string, event?: string) {
    const index = this.faults.findIndex(fault => (fault.action === action || (fault.action.endsWith('*') && action.startsWith(fault.action.slice(0, -1))))
      && (!fault.event || fault.event === event) && (fault.times ?? 1) > 0);
    if (index < 0) return undefined;
    const fault = this.faults[index];
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    return fault;
  }

  #authenticate(request: IncomingMessage, action: string, body: Buffer): { deviceId: string } | { status: number; code: string } {
    const header = (name: string) => { const value = request.headers[name]; return typeof value === 'string' ? value : ''; };
    if (header('x-smartsell-workspace') !== this.workspaceId) return { status: 401, code: 'INVALID_DEVICE_PROOF' };
    const deviceId = header('x-smartsell-device'), timestamp = header('x-smartsell-timestamp'), nonce = header('x-smartsell-nonce'), signature = header('x-smartsell-signature');
    const issuedAt = Date.parse(timestamp);
    if (!Number.isFinite(issuedAt) || Math.abs(this.now() - issuedAt) > 60_000) return { status: 401, code: 'DEVICE_PROOF_EXPIRED' };
    const device = this.devices.get(deviceId);
    if (!device) return { status: 401, code: 'INVALID_DEVICE_PROOF' };
    if (this.revokedDevices.has(deviceId)) return { status: 401, code: 'DEVICE_INACTIVE' };
    const digest = createHash('sha256').update(body).digest('hex');
    const bytes = Buffer.from(JSON.stringify(['smartsell.device.v1', this.workspaceId, deviceId, action, timestamp, nonce, digest]));
    const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.from(device.publicKey, 'base64url') });
    if (!verify(null, bytes, key, Buffer.from(signature, 'base64url'))) return { status: 401, code: 'INVALID_DEVICE_PROOF' };
    if (this.#nonces.has(nonce)) return { status: 401, code: 'INVALID_DEVICE_PROOF' };
    this.#nonces.add(nonce);
    return { deviceId };
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    if (this.#down) { request.socket.destroy(); return; }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = await raw(request);
    response.setHeader('date', new Date(this.now()).toUTCString());
    const routes: Record<string, string> = {
      '/api/v1/device/heartbeat': 'heartbeat', '/api/v1/device/jobs/claim': 'jobs.claim', '/api/v1/device/jobs/report': 'jobs.report',
      '/api/v1/device/jobs/go': 'jobs.go', '/api/v1/device/channels/register': 'channels.register', '/api/v1/device/driver-config': 'driver_config.read',
    };
    let action = routes[url.pathname];
    const media = /^\/api\/v1\/device\/media\/([^/]+)$/.exec(url.pathname);
    const evidence = /^\/api\/v1\/device\/evidence\/([^/]+)$/.exec(url.pathname);
    if (media) action = `media.read:${decodeURIComponent(media[1])}:${request.headers['x-smartsell-job']}:${request.headers['x-smartsell-fence']}`;
    if (evidence) action = `evidence.upload:${decodeURIComponent(evidence[1])}:${request.headers['x-smartsell-fence']}`;
    if (url.pathname === '/api/v1/device/pair') return this.#pair(body, request, response);
    if (!action) return json(response, 404, { error: { code: 'NOT_FOUND' } });
    let parsed: unknown = null;
    try { parsed = body.length && !evidence ? JSON.parse(body.toString('utf8')) : null; } catch { /* raw */ }
    const entry: RequestLog = { action: action.split(':')[0], method: request.method ?? '', path: url.pathname, at: this.now(), body: parsed, status: 0 };
    this.log.push(entry);
    const fault = this.#fault(entry.action, (parsed as { event?: string } | null)?.event);
    if (fault?.delayMs) await new Promise(done => setTimeout(done, fault.delayMs));
    if (fault?.network) { entry.status = -1; request.socket.destroy(); return; }
    if (fault?.status) {
      entry.status = fault.status;
      return json(response, fault.status, { error: { code: fault.code ?? 'FAULT', ...fault.details } }, fault.retryAfter ? { 'retry-after': fault.retryAfter } : {});
    }
    const auth = this.#authenticate(request, action, body);
    if ('status' in auth) { entry.status = auth.status; return json(response, auth.status, { error: { code: auth.code } }); }
    const reply = (status: number, value: unknown, headers: Record<string, string> = {}) => { entry.status = status; json(response, status, value, headers); };
    try {
      if (media) return this.#media(auth.deviceId, decodeURIComponent(media[1]), request, response, entry);
      if (evidence) return this.#evidence(auth.deviceId, decodeURIComponent(evidence[1]), request, body, reply);
      switch (entry.action) {
        case 'heartbeat': return reply(200, { data: this.#heartbeat(auth.deviceId, parsed as HeartbeatV2Request) });
        case 'jobs.claim': return reply(200, { data: this.#claim(auth.deviceId, parsed as { kinds: string[]; horizon_minutes: number; held_job_ids: string[] }) });
        case 'jobs.go': { const result = this.#go(auth.deviceId, parsed as { job_id: string; fencing_token: number }); return reply(result.status, result.body); }
        case 'jobs.report': { const result = this.#report(auth.deviceId, parsed as JobReport); return reply(result.status, result.body); }
        case 'channels.register': {
          const selections = (parsed as { selections: { kind: string; platform: string; external_id: string }[] }).selections;
          this.registrations.push(...selections);
          return reply(200, { data: { registrations: selections.map(item => ({ kind: item.kind, platform: item.platform, external_id: item.external_id, resource_id: `acct-${item.external_id}`, device_id: auth.deviceId })) } });
        }
        case 'driver_config.read':
          if (!this.driverConfig) return reply(404, { error: { code: 'DRIVER_CONFIG_NOT_FOUND' } });
          entry.status = 200;
          response.writeHead(200, { 'content-type': 'application/json' });
          return response.end(this.driverConfig.bytes);
      }
    } catch (error) { return reply(500, { error: { code: 'FAKE_HUB_ERROR', message: String(error) } }); }
  }

  #pair(body: Buffer, request: IncomingMessage, response: ServerResponse) {
    const input = JSON.parse(body.toString('utf8')) as { pairing_code: string; public_key: string; platform: string; name: string; proof: string };
    if (request.headers['x-smartsell-workspace'] !== this.workspaceId || !this.pairingCodes.has(input.pairing_code)) return json(response, 401, { error: { code: 'PAIRING_CODE_INVALID' } });
    const bytes = Buffer.from(JSON.stringify(['smartsell.pair.v1', this.workspaceId, input.pairing_code, input.public_key, input.platform, input.name]));
    const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.from(input.public_key, 'base64url') });
    if (!verify(null, bytes, key, Buffer.from(input.proof, 'base64url'))) return json(response, 401, { error: { code: 'INVALID_DEVICE_PROOF' } });
    this.pairingCodes.delete(input.pairing_code);
    const deviceId = `dev-${randomBytes(6).toString('hex')}`;
    this.devices.set(deviceId, { publicKey: input.public_key, name: input.name, platform: input.platform });
    return json(response, 200, { data: { device_id: deviceId } });
  }

  #terminal(job: FakeJob) { return TERMINAL_JOB_STATUSES.includes(job.status); }

  #heartbeat(deviceId: string, request: HeartbeatV2Request): HeartbeatV2Response {
    if (request.protocol !== 2) throw new Error('v1 heartbeat');
    for (const id of request.released_jobs ?? []) {
      const job = this.jobs.get(id);
      if (job && job.status === 'releasing') job.status = job.revoke === 'superseded' ? 'superseded' : 'cancelled';
    }
    const jobs = request.jobs.flatMap(item => {
      const job = this.jobs.get(item.job_id);
      if (!job || job.deviceId !== deviceId || this.#terminal(job)) return [];
      const paused = this.paused || this.pauseAll;
      return [{ job_id: item.job_id, fencing_token: job.claimed.fencing_token, hold: job.hold || paused || !!job.revoke, hold_reason: job.hold_reason ?? (paused ? 'paused' as const : job.revoke ? 'revoked' as const : null),
        mode: job.mode, resume_token: job.resume_token }];
    });
    const revoked = [...this.jobs.values()].filter(job => job.deviceId === deviceId && job.revoke && (job.status === 'releasing' || job.status === 'running' || job.status === 'needs_owner'))
      .map(job => ({ job_id: job.claimed.job_id, reason: job.revoke! }));
    const claimable = [...this.jobs.values()].filter(job => job.deviceId === deviceId && job.status === 'queued').length;
    return { status: 'online', protocol: 2, server_time: new Date(this.now()).toISOString(), paused: this.paused, pause_all: this.pauseAll, claimable,
      sync_generation: this.syncGeneration, jobs, revoked_jobs: revoked, channels: this.channels, latest_worker: this.latestWorker,
      driver_config: this.driverConfig ? { version: this.driverConfig.version, sha256: this.driverConfig.sha256 } : null };
  }

  #claim(deviceId: string, request: { kinds: string[]; horizon_minutes: number; held_job_ids: string[] }) {
    if (this.paused) return { jobs: [], server_time: new Date(this.now()).toISOString() };
    const out: ClaimedJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.deviceId !== deviceId || job.media_pending || !request.kinds.includes(job.claimed.kind)) continue;
      const due = job.claimed.kind === 'check_login' || Date.parse(job.claimed.not_before) <= this.now() + request.horizon_minutes * 60_000;
      const recover = ['claimed', 'ready', 'needs_owner'].includes(job.status) && !request.held_job_ids.includes(job.claimed.job_id);
      if (job.status === 'queued' && Date.parse(job.claimed.not_after) < this.now()) { job.status = 'missed'; continue; }
      if (!((job.status === 'queued' && due) || recover)) continue;
      job.claimed.fencing_token += 1;
      if (job.status === 'queued') job.status = 'claimed';
      out.push(structuredClone(job.claimed));
    }
    return { jobs: out, server_time: new Date(this.now()).toISOString() };
  }

  #go(deviceId: string, request: { job_id: string; fencing_token: number }) {
    const job = this.jobs.get(request.job_id);
    const deny = (reason: GoDenyReason, release: boolean) => ({ status: 200, body: { data: { go: false, reason, release } } });
    if (!job || job.deviceId !== deviceId || job.claimed.fencing_token !== request.fencing_token) return deny('fence_lost', false);
    if (job.status === 'running' && job.go_source === 'hub') return { status: 200, body: { data: { go: true, mode: job.mode, server_time: new Date(this.now()).toISOString() } } };
    if (!['claimed', 'ready', 'needs_owner'].includes(job.status)) return deny('invalid_state', false);
    const now = this.now();
    if (now < Date.parse(job.claimed.not_before) - 60_000) return deny('too_early', false);
    if (now > Date.parse(job.claimed.not_after)) return deny('too_late', false);
    if (job.revoke) return deny('revoked', true);
    if (this.paused || this.pauseAll || job.hold_reason === 'paused') return deny('paused', false);
    if (job.approval_invalid && !job.claimed.dry_run) return deny('approval_invalid', true);
    job.status = 'running';
    job.go_source = 'hub';
    return { status: 200, body: { data: { go: true, mode: job.mode, server_time: new Date(now).toISOString() } } };
  }

  #report(deviceId: string, report: JobReport) {
    const job = this.jobs.get(report.job_id);
    if (!job) return { status: 404, body: { error: { code: 'JOB_NOT_FOUND' } } };
    if (!job.history.includes(deviceId)) return { status: 409, body: { error: { code: 'JOB_FENCE_LOST' } } };
    if (job.event_ids.has(report.event_id)) return { status: 200, body: { data: { status: 'duplicate' } } };
    const fact = isFactReport(report);
    const fenceOk = report.fencing_token === job.claimed.fencing_token && !this.#terminal(job);
    if (!fact && !fenceOk) return { status: 409, body: { error: { code: 'JOB_FENCE_LOST' } } };
    const last = job.seq_by_fence[report.fencing_token] ?? 0;
    if (report.seq > last + 1) return { status: 409, body: { error: { code: 'SEQ_GAP', expected: last + 1 } } };
    if (report.seq <= last) return { status: 409, body: { error: { code: 'SEQ_CONFLICT' } } };
    job.seq_by_fence[report.fencing_token] = report.seq;
    job.event_ids.add(report.event_id);
    job.reports.push(report);
    if (!fenceOk) job.fence_override = true;
    const data = report.data as Record<string, unknown>;
    switch (report.event) {
      case 'prepared': if (data.stage === 'final') job.status = 'ready'; else if (job.status === 'needs_owner') job.status = 'claimed'; break;
      case 'prepare_blocked': job.status = 'needs_owner'; break;
      case 'started': job.status = 'running'; job.go_source = data.go as 'hub' | 'offline'; break;
      case 'submitting': job.status = 'submitting'; break;
      case 'submitted': job.status = 'result_pending'; break;
      case 'result': job.status = 'succeeded'; job.result = data; break;
      case 'blocked': job.status = (data.blocker as { phase: string }).phase === 'after_submit' ? 'outcome_unknown' : 'needs_owner'; break;
      case 'failed': job.status = 'failed'; break;
      case 'missed': job.status = 'missed'; break;
      case 'dry_run_done': job.status = 'succeeded'; job.result = { ...data, dry_run: true }; break;
      case 'outcome_unknown': job.status = 'outcome_unknown'; break;
      case 'released': job.status = job.revoke === 'superseded' ? 'superseded' : 'cancelled'; break;
      case 'login_state': job.status = data.state === 'verified' ? 'succeeded' : 'needs_owner'; job.result = data; break;
    }
    return { status: 200, body: { data: { status: 'ok' } } };
  }

  #media(deviceId: string, fileId: string, request: IncomingMessage, response: ServerResponse, entry: RequestLog) {
    const job = this.jobs.get(String(request.headers['x-smartsell-job']));
    const fence = Number(request.headers['x-smartsell-fence']);
    const file = this.media.get(fileId);
    const listed = job && 'media' in job.claimed.payload && job.claimed.payload.media.some(item => item.file_id === fileId);
    if (job && job.deviceId === deviceId && job.claimed.fencing_token !== fence) {
      entry.status = 409;
      return json(response, 409, { error: { code: 'JOB_FENCE_LOST' } });
    }
    if (!job || job.deviceId !== deviceId || this.#terminal(job) || !listed || !file) {
      entry.status = 403;
      return json(response, 403, { error: { code: 'MEDIA_FORBIDDEN' } });
    }
    let bytes = file.bytes;
    if (file.corruptOnce) { file.corruptOnce = false; bytes = Buffer.from(bytes); bytes[bytes.length - 1] ^= 0xff; }
    const sha = createHash('sha256').update(file.bytes).digest('hex');
    const range = /^bytes=(\d+)-$/.exec(String(request.headers.range ?? ''));
    const ifRange = request.headers['if-range'];
    let start = 0;
    if (range && (!ifRange || ifRange === `"${sha}"`)) start = Number(range[1]);
    const slice = bytes.subarray(start);
    entry.status = start ? 206 : 200;
    response.writeHead(start ? 206 : 200, {
      'content-type': 'video/mp4', 'content-length': String(slice.length), etag: `"${sha}"`, 'cache-control': 'no-store',
      ...(start && { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` }),
    });
    if (file.truncateOnceAt !== undefined && file.truncateOnceAt > start) {
      const cut = file.truncateOnceAt - start;
      file.truncateOnceAt = undefined;
      response.write(slice.subarray(0, cut), () => setTimeout(() => response.socket?.destroy(), 20));
      return;
    }
    response.end(slice);
  }

  #evidence(deviceId: string, jobId: string, request: IncomingMessage, body: Buffer, reply: (status: number, value: unknown) => void) {
    const job = this.jobs.get(jobId);
    if (!job || !job.history.includes(deviceId)) return reply(409, { error: { code: 'JOB_FENCE_LOST' } });
    if (body.length > 4 * 1024 * 1024) return reply(413, { error: { code: 'EVIDENCE_TOO_LARGE' } });
    const list = this.evidence.get(jobId) ?? [];
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (!list.some(item => item.sha256 === sha256)) list.push({ sha256, bytes: body.length, mime: String(request.headers['content-type']) });
    this.evidence.set(jobId, list);
    return reply(200, { data: { sha256 } });
  }
}

export async function startFakeHub() { return new FakeHub().start(); }
