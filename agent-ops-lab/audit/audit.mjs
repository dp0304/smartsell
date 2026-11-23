import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';

export function callBatches(cases, size = 25) {
  const batches = [];
  for (const item of cases) {
    let batch = batches.at(-1);
    const input = item.nativeArguments ?? item.arguments;
    if (!batch || batch.length >= size || batch.some(other => other.name === item.name &&
        isDeepStrictEqual(other.nativeArguments ?? other.arguments, input))) {
      batch = [];
      batches.push(batch);
    }
    batch.push(item);
  }
  return batches;
}

export function callSlot(batch, name, args) {
  const matches = batch.filter(item => item.name === name && isDeepStrictEqual(item.nativeArguments ?? item.arguments, args));
  assert.equal(matches.length, 1, `Expected one exact planned call for ${name}`);
  return matches[0];
}

// A test-only relay captures the actual HTTP response header, including when Claude Code renders only MCP content.
// It forwards exactly the supplied request to the product's public /mcp route and never injects a request ID.
export async function nativeRelay({ origin, token }, batch) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const calls = [];
  const failures = [];
  const relay = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/mcp');
      assert(['GET', 'POST', 'DELETE'].includes(req.method));
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const body = req.method === 'POST' ? Buffer.concat(await Array.fromAsync(req)) : undefined;
      const message = body?.length ? JSON.parse(body) : undefined;
      assert(!Array.isArray(message), 'Unexpected MCP batch envelope');
      const slot = message?.method === 'tools/call' ? callSlot(batch, message.params.name, message.params.arguments ?? {}) : undefined;
      const wire = slot && { caseId: slot.id, rpcId: message.id, at: new Date().toISOString(), requestId: null, httpStatus: null };
      if (wire) calls.push(wire);
      const headers = new Headers();
      for (const name of ['authorization', 'accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'origin']) {
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      }
      const stop = new AbortController();
      res.once('close', () => stop.abort());
      const upstream = await fetch(`${origin}/mcp`, { method: req.method, body, headers, redirect: 'error', signal: stop.signal });
      if (wire) Object.assign(wire, { requestId: upstream.headers.get('x-request-id'), httpStatus: upstream.status });
      for (const [name, value] of upstream.headers) {
        if (!['content-length', 'content-encoding', 'connection', 'transfer-encoding'].includes(name)) res.setHeader(name, value);
      }
      res.writeHead(upstream.status);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (error) {
      if (res.destroyed) return;
      // Store only an error class. An assertion message could serialize the authorization header.
      failures.push(error.code ?? error.name);
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    }
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  return { origin: `http://127.0.0.1:${relay.address().port}`, calls, failures,
    close: () => new Promise(resolve => { relay.close(resolve); relay.closeAllConnections(); }) };
}

export function exactWebMatch(requestId, rows, expected) {
  if (!requestId) return { status: 'missing_request_id', cohort: [] };
  if (!rows.length) return { status: 'missing_web_row', cohort: [] };
  if (rows.length !== 1) return { status: 'ambiguous_web_rows', cohort: rows };
  const [row] = rows;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const projected = ['id', 'call_id', 'request_id', 'credential_id', 'actor_id', 'occurred_at', 'tool', 'target', 'outcome', 'error_code', 'status', 'replayed', 'agent_job_id', 'task_id', 'device_id'];
  const outcome = { succeeded: 'success', denied: 'error', failed: 'error' }[row.outcome] ?? row.outcome;
  const target = row.target;
  const problems = [];
  if (row.request_id !== requestId) problems.push('request_id');
  if (!uuid.test(row.id) || !uuid.test(row.call_id) || row.id !== row.call_id) problems.push('id/call_id');
  if (row.tool !== expected.name) problems.push('tool');
  if (typeof target !== 'string' || !target || (expected.target && target !== expected.target)) problems.push('target');
  if (outcome !== expected.outcome || (expected.exactOutcome && row.outcome !== expected.exactOutcome)) problems.push('outcome');
  if ((expected.code && row.error_code !== expected.code) || (outcome === 'success' && row.error_code != null)) problems.push('error_code');
  if (expected.credentialId !== undefined && row.credential_id !== expected.credentialId || !uuid.test(row.credential_id)) problems.push('credential_id');
  if (row.actor_id !== expected.actorId) problems.push('actor_id');
  if (typeof row.occurred_at !== 'string' || !Number.isFinite(Date.parse(row.occurred_at))) problems.push('occurred_at');
  if (Object.keys(row).some(key => !projected.includes(key))) problems.push('unexpected_fields');
  return problems.length ? { status: 'web_row_mismatch', problems, cohort: rows } : { status: 'matched', auditId: row.id, cohort: rows };
}
