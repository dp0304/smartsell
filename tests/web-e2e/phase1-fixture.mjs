import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { DeviceProtocolClient, SignedDeviceClient, createSignedHttpTransport, pairOverHttp } from '../../apps/connector/src/device-client.ts';
import { AUTOMATION_NOTICE_VERSION } from '../../packages/contracts/src/phase1.ts';
import { createHubApi, createMediaUploadHandler } from '../../packages/agent-relay/src/index.ts';

// Phase-1 data for the owner dashboard specs, made through the same interfaces the real parts use and nothing else:
// a machine pairs and heartbeats with the signed device protocol (§5.4, Appendix B.2), a channel is registered by that
// machine (channels.register, §8.16), media goes up through the relay's own media_upload code (§6.3) and posts are
// scheduled by an Agent over MCP (post_schedule, §7.2.6). Everything talks to the local dev server only.

/** The pairing grant /worker-connect asks for (apps/web/src/worker-connect.tsx workerPairingBody, §2.9 step 3.4). */
export const workerPairingBody = { owned_device_confirmed: true, allow_channel_registration: true };

/** A REST client bound to the browser context's owner session (cookie + CSRF), like the web app itself. */
export async function sessionRest(page, dev, workspaceId) {
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrf.status()).toBe(200);
  const { csrf_token } = await csrf.json();
  const root = `/api/v1/workspaces/${workspaceId}`;
  async function rest(method, path, data, { status, version } = {}) {
    const response = await page.request.fetch(`${dev.origin}${root}${path}`, {
      method, data, maxRedirects: 0,
      headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
        ...(version === undefined ? {} : { 'If-Match': `"${version}"` }) },
    });
    const text = await response.text();
    if (status === undefined) expect(response.ok(), `${method} ${path}: ${text}`).toBe(true);
    else expect(response.status(), `${method} ${path}: ${text}`).toBe(status);
    return text ? JSON.parse(text).data ?? JSON.parse(text) : undefined;
  }
  return { id: workspaceId, root, app: `${dev.origin}/app/${workspaceId}`, rest };
}

/** First-time setup through REST; the browser context keeps the owner's session cookie. */
export async function ownerWorkspace(page, dev, { workspaceName = 'Phase 1 fixture', name = 'Phase 1 owner' } = {}) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { name, email: 'phase1-owner@example.test', workspaceName, password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: { workspaces: [workspace] } } = await setup.json();
  return sessionRest(page, dev, workspace.id);
}

/** A posture with nothing to warn about (§3.2): no idle sleep, automatic login on. */
export const quietPosture = { os: 'darwin', os_version: '15.1', sleep_idle_min: 0, on_battery: false, auto_login: 'on', filevault: 'off', power_plan_sleep_min: null };

/**
 * Pairs a machine with the signed protocol, as the Worker App does after /worker-connect hands it the code, and returns a
 * small Worker double that sends v2 heartbeats, registers channels and claims and reports jobs with its own key.
 */
export async function pairMachine(dev, ws, name, { platform = 'darwin', grant = workerPairingBody } = {}) {
  const { pairing_code } = await ws.rest('POST', '/devices/pairing-codes', grant);
  const { privateKey } = generateKeyPairSync('ed25519');
  const id = await pairOverHttp(dev.origin, ws.id, pairing_code, platform, name, privateKey, { userInitiated: true, ownsDevice: true });
  const client = new DeviceProtocolClient({ origin: dev.origin, workspaceId: ws.id, deviceId: id, key: privateKey, now: Date.now });
  let generation = 0;
  const held = new Map();
  const sequence = new Map();
  const released = new Set();
  return {
    id, name, client,
    /** The same machine's key on the older signed routes (catalog, Zhihu and identity reports that phase 1 keeps). */
    signed: new SignedDeviceClient(ws.id, id, privateKey, createSignedHttpTransport(dev.origin)),
    /** A §5.4.1 heartbeat v2; it echoes the hub's sync generation and lists the jobs this machine holds. */
    async heartbeat(extra = {}) {
      const { data } = await client.heartbeat({
        client_version: '0.2.0', protocol: 2, drivers: [{ provider: 'x', version: 'x@2026.11.1', health: 'ok' }],
        jobs: [...held.values()], ...(released.size && { released_jobs: [...released] }), outbox_depth: 0, worker_time: new Date().toISOString(),
        applied_sync_generation: generation, posture: { ...quietPosture, os: platform }, arch: 'arm64', ...extra,
      });
      released.clear();
      generation = data.sync_generation;
      return data;
    },
    /** channels.register with the §8.16 step 5 fields: the owner signed in on this machine and pressed 加入. */
    async addChannel(provider, handle, externalId = handle) {
      const { data } = await client.registerChannels([{
        kind: 'social', platform: provider, external_id: externalId, observed_at: new Date().toISOString(), display_name: handle,
        profile_key: `ch-${randomBytes(6).toString('hex')}`, handle, automation_notice_version: AUTOMATION_NOTICE_VERSION,
      }]);
      expect(data.registrations).toHaveLength(1);
      expect(data.registrations[0]).toMatchObject({ kind: 'social', platform: provider, device_id: id });
      return data.registrations[0].resource_id;
    },
    /** jobs.claim (§5.4.2) for publish jobs within the horizon; the claimed jobs are listed in later heartbeats. */
    async claim(horizonMinutes = 48 * 60) {
      const { data } = await client.claim({ kinds: ['publish_post', 'check_login'], horizon_minutes: horizonMinutes, max: 5, held_job_ids: [...held.keys()] });
      for (const job of data.jobs) held.set(job.job_id, { job_id: job.job_id, local_state: 'claimed', fencing_token: job.fencing_token });
      return data.jobs;
    },
    /** jobs.report (§5.4.3) with a per-fence sequence number; `data` is the event's JobReportData without `event`. */
    async report(job, event, data = {}) {
      const seq = (sequence.get(job.job_id) ?? 0) + 1;
      sequence.set(job.job_id, seq);
      const { data: reply } = await client.report({ job_id: job.job_id, fencing_token: job.fencing_token, event_id: randomUUID(), seq,
        event, worker_time: new Date().toISOString(), data: { event, ...data } });
      const entry = held.get(job.job_id);
      if (entry && event === 'prepared') entry.local_state = 'ready';
      return reply;
    },
    /** The machine dropped a job the hub revoked: the next heartbeat lists it in released_jobs (§5.4.1, §5.10). */
    release(jobId) { held.delete(jobId); released.add(jobId); },
  };
}

/** A minimal MCP client over streamable HTTP with an Agent connection's bearer token. */
export function mcpClient(url, token) {
  async function rpc(method, params = {}) {
    const notification = method.startsWith('notifications/');
    const response = await fetch(url, { method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: randomUUID() }), method, params }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` } });
    const text = await response.text();
    if (notification) { expect(response.status, `MCP ${method}: ${text}`).toBe(202); return undefined; }
    expect(response.status, `MCP ${method}: ${text}`).toBe(200);
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text;
    const message = JSON.parse(body);
    expect(message.error, `MCP ${method}: ${body}`).toBeUndefined();
    return message.result;
  }
  return {
    rpc,
    async initialize(name = 'phase1-web-e2e') {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } });
      await rpc('notifications/initialized');
    },
    /** Calls a hub tool and returns its structured result; a tool error fails with the server's message. */
    async call(name, args = {}) {
      const result = await rpc('tools/call', { name, arguments: args });
      expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeFalsy();
      return result.structuredContent;
    },
  };
}

/** An Agent connection made by the owner (POST /agent-connections, what the 「建立連線」 button calls). */
export async function agentConnection(ws, label = 'Phase 1 Codex') {
  const created = await ws.rest('POST', '/agent-connections', { label, client: 'codex', expires_days: 30 }, { status: 201 });
  expect(created).toMatchObject({ token: expect.stringMatching(/^ss_command_/), mcp_url: expect.stringMatching(/\/mcp$/) });
  return created;
}

/** A small file with an MP4 header (the hub accepts it; ffprobe finding no streams is a risk, not a blocker, E3). */
export function fakeMp4(size = 300_000) {
  const bytes = Buffer.alloc(size);
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(bytes);
  for (let index = 16; index < size; index++) bytes[index] = (index * 31) & 0xff;
  return bytes;
}

/** media_upload with the relay's own handler (§6.3): absolute path, chunked upload with SHA-256 to the hub. */
export async function uploadMedia(dev, token, filename = 'video.mp4') {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-phase1-media-'));
  try {
    const path = join(dir, filename);
    await writeFile(path, fakeMp4());
    const relay = createMediaUploadHandler({ api: createHubApi({ hubOrigin: dev.origin, token }) });
    const result = await relay.handle({ path, wait_seconds: 40 }, { notify() {} });
    await relay.idle();
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'ready', filename, kind: 'video' });
    return result.structuredContent;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Tomorrow's date in a time zone, as post_schedule's `when` expects it. */
export function tomorrow(timeZone = 'UTC') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86_400_000));
}

/**
 * One machine (Mac-B) with one X channel registered by it, an Agent connection and one uploaded video: the state right
 * before the owner says "post video.mp4 to X on Mac-B tomorrow at 9:00" in Codex.
 */
export async function postingFixture(page, dev, { handle = 'fixture_x', machineName = 'Mac-B', withoutDailySummary = false } = {}) {
  const ws = await ownerWorkspace(page, dev);
  // The 21:00 daily summary is an optional alert (§9.8 settings/notifications); a test that counts alerts turns it off
  // first, so its result does not depend on the clock.
  if (withoutDailySummary) await ws.rest('PUT', '/hub/alerts/channels', { preferences: { daily_summary: false } });
  const machine = await pairMachine(dev, ws, machineName);
  await machine.heartbeat();
  const channelId = await machine.addChannel('x', handle);
  await machine.heartbeat();
  const connection = await agentConnection(ws);
  const agent = mcpClient(connection.mcp_url, connection.token);
  await agent.initialize();
  const media = await uploadMedia(dev, connection.token);
  return { ws, machine, channelId, connection, agent, media, handle };
}

/** post_schedule through MCP for tomorrow at a local time in the workspace zone. */
export async function schedulePost(fixture, { at = '09:00', caption, channels = [fixture.channelId] } = {}) {
  const day = tomorrow();
  const scheduled = await fixture.agent.call('post_schedule', {
    media_ids: [fixture.media.media_id], channel_ids: channels, when: `${day} ${at}`,
    ...(caption ? { captions: { default: { text: caption } } } : { no_caption: true }),
  });
  expect(scheduled.posts).toHaveLength(channels.length);
  return { day, scheduled, post: scheduled.posts[0] };
}
