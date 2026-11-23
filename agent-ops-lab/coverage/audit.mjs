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
  const cohort = rows.filter(row => row.request_id === requestId);
  if (!cohort.length) return { status: 'missing_web_row', cohort: [] };
  if (cohort.length !== 1) return { status: 'ambiguous_web_rows', cohort };
  const [row] = cohort;
  const outcome = { succeeded: 'success', denied: 'error', failed: 'error', failure: 'error', rejected: 'error' }[row.outcome] ?? row.outcome;
  const fields = [
    ['id', typeof row.id === 'string' && row.id.length > 0 && row.call_id === row.id],
    ['tool', row.tool === expected.name],
    ['outcome', outcome === expected.outcome],
    ['error_code', row.error_code === expected.code],
    ['credential_id', row.credential_id === expected.credentialId],
    ['request_id_filter', cohort.length === rows.length],
  ];
  const mismatches = fields.filter(([, ok]) => !ok).map(([field]) => field);
  if (mismatches.length) return { status: 'web_row_mismatch', mismatches, expected, cohort };
  return { status: 'matched', auditId: row.id, cohort };
}