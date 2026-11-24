// E2E-11 (phase1-design §10.2): a 1 GB file through the real relay. The relay is killed at 40 % and media_upload runs
// again: it resumes from the chunks the hub already holds, the final SHA-256 matches, every tool answer stays under
// 4 KB (no base64 in the model's context) and both Workers keep heartbeating while the hub assembles and probes it.
// Gated: set SMARTSELL_TEST_LARGE=1 (writes 1 GiB to the temp directory and uploads it over loopback).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { largeMp4, type TestMedia } from './video.ts';
import { stackUnavailable, startStack, until, type Data, type Stack } from './stack.ts';

const GiB = 1024 ** 3;
const skip = stackUnavailable ?? (process.env.SMARTSELL_TEST_LARGE === '1' ? false : 'E2E-11 uploads 1 GiB: set SMARTSELL_TEST_LARGE=1');

describe('E2E-11: 1 GB upload, relay killed at 40 %, resumed', { skip, concurrency: false, timeout: 20 * 60_000 }, () => {
  let stack: Stack;
  let file: TestMedia;
  before(async () => {
    stack = await startStack({ name: 'large', clip: false });
    file = await largeMp4(stack.mediaDir, GiB);
  });
  after(async () => { await stack?.close(); });

  async function agent(method: string, path: string, body?: Data) {
    const response = await fetch(`${stack.origin}${path}`, { method, headers: { authorization: `Bearer ${stack.agentToken}`, ...(body && { 'content-type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as Data };
  }

  test('resumes from the received chunks; same SHA-256; answers < 4 KB; heartbeats never fail during assembly and ffprobe', async () => {
    assert.equal(file.bytes, GiB);
    const windowStart = Date.now();
    // Hub responsiveness through the whole upload, assembly and probe: a read transaction every 200 ms. The store runs one
    // transaction at a time, so a copy or ffprobe inside a transaction would show up here as seconds of latency (§0 rule 8).
    const latencies: number[] = [];
    let probing = true;
    const prober = (async () => {
      while (probing) {
        const started = performance.now();
        await stack.view('/views/machines');
        latencies.push(performance.now() - started);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    })();
    // 1. First relay: killed once the hub holds 40 % of the file.
    let killedAt = 0;
    const first = stack.mcp('media_upload', { path: file.path, wait_seconds: 50 }, {
      timeoutMs: 600_000,
      onprogress: progress => {
        if (!killedAt && progress.total && progress.progress / progress.total >= 0.4) { killedAt = progress.progress; stack.killRelay(); }
      },
    });
    await assert.rejects(first, 'the relay died mid-upload');
    assert.ok(killedAt >= 0.4 * GiB && killedAt < GiB, `killed at ${(killedAt / GiB * 100).toFixed(1)} %`);
    // What the hub holds now (the same create call the relay makes to resume, §6.3 step 6).
    const resume = await agent('POST', '/api/v1/agent/uploads', { filename: 'large.mp4', bytes: file.bytes, sha256: file.sha256, mime: 'video/mp4' });
    assert.equal(resume.status, 200, `an unfinished upload exists: ${JSON.stringify(resume.body)}`);
    const received = resume.body.received as number[];
    const chunkBytes = Number(resume.body.chunk_bytes);
    const chunks = Number(resume.body.chunks);
    assert.ok(received.length >= Math.floor(0.4 * chunks) && received.length < chunks, `${received.length}/${chunks} chunks before the restart`);
    const heldBefore = received.length * chunkBytes;

    // 2. A fresh relay runs media_upload again for the same path.
    await stack.reconnectMcp();
    const progress: number[] = [];
    const second = await stack.mcp<Data>('media_upload', { path: file.path, wait_seconds: 50 }, { timeoutMs: 600_000, onprogress: item => { progress.push(item.progress); } });
    assert.ok(second.ok, JSON.stringify(second.error));
    assert.ok(progress.length > 0 && progress[0] >= heldBefore, `resumed: first progress ${progress[0]} ≥ ${heldBefore} bytes already held`);
    assert.equal(second.data.media_id, resume.body.media_id, 'the same media');
    assert.equal(second.data.sha256, file.sha256);
    assert.equal(second.data.bytes, file.bytes);
    for (const call of stack.mcpCalls) assert.ok(call.bytes < 4096, `${call.tool} answered ${call.bytes} bytes`);

    // 3. Until the hub has assembled, hashed and probed it: ready, and the Workers' heartbeats never failed.
    const uploadId = String(resume.body.upload_id);
    const done = await until(async () => { const state = await agent('GET', `/api/v1/agent/uploads/${uploadId}`); return ['ready', 'failed'].includes(String(state.body.status)) && state.body; },
      600_000, 'upload ready', 1000);
    assert.equal(done.status, 'ready', JSON.stringify(done));
    assert.equal(done.bytes_received, file.bytes);
    probing = false;
    await prober;
    // Every heartbeat that overlapped the window succeeded: wait for one more of each machine, then look for failures.
    await Promise.all(Object.values(stack.machines).map(machine => stack.nextHeartbeat(machine.name, 40_000)));
    const windowEnd = Date.now();
    for (const machine of Object.values(stack.machines)) {
      assert.deepEqual(machine.failures.filter(at => at >= windowStart && at <= windowEnd), [], `${machine.name}: no failed heartbeat`);
      assert.ok(machine.heartbeats.some(at => at >= windowStart), `${machine.name} heartbeated during the window`);
    }
    const slowest = Math.max(...latencies);
    stack.log(`E2E-11: relay killed at ${(killedAt / GiB * 100).toFixed(1)} %, hub held ${received.length}/${chunks} chunks, second run started at ${progress[0]} bytes, ` +
      `${latencies.length} probes, slowest ${Math.round(slowest)} ms, upload ready ${Math.round((windowEnd - windowStart) / 1000)} s after the start`);
    assert.ok(latencies.length >= 5 && slowest < 3000, `hub stayed responsive: ${latencies.length} probes, slowest ${Math.round(slowest)} ms (heartbeat timeout 10 s)`);
    const media = await stack.view<{ items?: { media_id: string; status: string; bytes: number }[] } | { media_id: string; status: string; bytes: number }[]>('/views/media/recent');
    const list = Array.isArray(media) ? media : media.items ?? [];
    const item = list.find(row => row.media_id === second.data.media_id);
    assert.equal(item?.status, 'ready');
    assert.equal(item?.bytes, file.bytes);
  });
});
