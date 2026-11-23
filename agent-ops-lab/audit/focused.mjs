import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export async function rawTool(env, token, name, args) {
  const response = await fetch(`${env.origin}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000), headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await response.text();
  const json = text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data: '))?.slice(6) : text;
  let value;
  if (json) try { value = JSON.parse(json); } catch {}
  return { status: response.status, requestId: response.headers.get('x-request-id'), value };
}

async function oauth(env, privateValue, protect) {
  const { origin, runtime, ws, http, rest, csrf_token } = env;
  const callback = 'http://127.0.0.1:1/audit-callback'; // Never followed or connected to.
  const { client_id } = (await http('/oauth/register', 'POST', { redirect_uris: [callback], client_name: 'Isolated audit fixture' })).value;
  const verifier = privateValue();
  const state = privateValue();
  const fields = { client_id, redirect_uri: callback, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', response_type: 'code', scope: 'smartsell:read', workspace_id: ws, state };
  let location, credentialId;
  if (runtime === 'commands') {
    const start = await fetch(`${origin}/oauth/authorize?${new URLSearchParams(fields)}`, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
    assert.equal(start.status, 303);
    const consent = new URL(start.headers.get('location'), origin);
    assert.equal(consent.origin, origin);
    const request = consent.searchParams.get('request');
    protect(request);
    const { ticket } = (await http('/api/v1/mcp-consent/open', 'POST', { request })).value.data;
    protect(ticket);
    location = (await http('/api/v1/mcp-consent', 'POST', { ticket, decision: 'approve', workspace_id: ws, expires_in: 600 })).value.data.redirect;
    credentialId = (await rest('GET', '/agent-authorizations')).find(row => row.client_id === client_id && row.status === 'approved')?.id;
    assert(credentialId, 'Approved OAuth grant absent from authenticated grant list');
  } else {
    const allow = await fetch(`${origin}/oauth/authorize`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: { ...env.session, 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, csrf_token }) });
    assert.equal(allow.status, 303);
    location = allow.headers.get('location');
    await allow.arrayBuffer();
  }
  const next = new URL(location);
  assert.equal(next.origin, new URL(callback).origin);
  assert(next.searchParams.get('state') === state, 'OAuth state mismatch');
  const code = next.searchParams.get('code');
  protect(code);
  const { access_token, scope } = (await http('/oauth/token', 'POST', { grant_type: 'authorization_code', code, code_verifier: verifier,
    client_id, redirect_uri: callback })).value;
  protect(access_token);
  assert.equal(scope, 'smartsell:read');
  return { id: credentialId, token: access_token, client_id };
}

export async function focused(env, { native, auditRecords, privateValue, protect }) {
  const { runtime, ws, main, readOnly, rest, webAudit } = env;
  const command = runtime === 'commands';
  const scope = command ? {} : { workspace_id: ws };
  const evidence = [];
  const fixture = async slug => rest('POST', '/brands', { name: slug, slug });
  const [a, b] = [await fixture('focused-a'), await fixture('focused-b')];
  const readTool = 'workspace_brand_get';
  const readTarget = 'GET /brands/:id';
  const readArgs = id => ({ ...scope, params: { id } });
  const plan = (label, name, args, target, { code, outcome = code ? 'failed' : 'success', check } = {}) => ({
    id: randomUUID(), label, focused: true, name, arguments: args, target, code, exactOutcome: outcome, check,
  });
  const run = async (cases, grant = main) => {
    const observed = await native({ ...env, main: grant }, cases, new Map(), '-focused');
    const found = [];
    for (const item of cases) {
      const receipt = observed.observed.find(row => row.caseId === item.id);
      let business = Boolean(receipt && receipt.childExit?.code === 0 && receipt.wire?.httpStatus === 200 &&
        (item.code ? receipt.conclusion === '预期拒绝' : !receipt.isError));
      if (business && item.check) business = item.check(receipt.data);
      const stripped = receipt && { ...receipt, data: undefined };
      evidence.push({ label: item.label, transport: 'native CLI', business, passed: business && receipt?.webAudit.status === 'matched', ...stripped });
      found.push(receipt);
    }
    return found;
  };
  const [first, second] = await run([
    plan('read-a', readTool, readArgs(a.id), readTarget, { check: data => data?.id === a.id }),
    plan('read-b-same-tool-in-same-turn', readTool, readArgs(b.id), readTarget, { check: data => data?.id === b.id }),
    plan('failed-missing-brand', readTool, readArgs(randomUUID()), readTarget, { code: 'NOT_FOUND' }),
  ]);
  evidence.push({ label: 'same-tool-independent-request-and-call-ids', passed: Boolean(first?.requestId && second?.requestId && first.requestId !== second.requestId &&
    first.webAudit?.auditId && second.webAudit?.auditId && first.webAudit.auditId !== second.webAudit.auditId) });

  let writeTool, writeTarget, writeArgs, checkWrite;
  if (command) {
    writeTool = 'workspace_brand_create'; writeTarget = 'POST /brands';
    writeArgs = { body: { name: 'Focused native write', slug: 'focused-native-write' }, idempotency_key: randomUUID() };
    checkWrite = data => data?.name === 'Focused native write' && Boolean(data?.id);
  } else {
    const created = await rest('POST', '/content-items', { brand_id: a.id, title: 'Focused audit draft' });
    const item = created.item ?? created;
    const made = await rest('POST', `/content-items/${item.id}/variants`, { platform: 'facebook', market: 'US', format: 'text', body_markdown: 'Initial fixture.' });
    const variant = made.variant ?? made;
    writeTool = 'content_autosave_variant'; writeTarget = 'PATCH /content-variants/:id';
    writeArgs = { ...scope, params: { id: variant.id }, body: { body_markdown: 'Focused native write', expected_version: variant.version },
      expected_version: variant.version, idempotency_key: randomUUID() };
    checkWrite = data => data?.id === variant.id && data.version === variant.version + 1 && data?.draft_doc?.body === 'Focused native write';
  }
  const [write] = await run([plan('first-write', writeTool, writeArgs, writeTarget, { check: checkWrite })]);
  const [replay] = await run([plan('identical-write-replay', writeTool, writeArgs, writeTarget, { check: data => checkWrite(data) && data.id === write?.data?.id && data.version === write?.data?.version })]);
  const stored = await auditRecords(env);
  const duplicateWrites = stored.filter(row => row.request_id === replay?.requestId && row.kind !== 'tool_call' && (row.action ?? row.tool_name) === writeTool).length;
  const [writeRow] = write?.webAudit?.cohort ?? [];
  const [replayRow] = replay?.webAudit?.cohort ?? [];
  const distinctReplay = Boolean(writeRow?.call_id && replayRow?.call_id && writeRow.call_id !== replayRow.call_id && writeRow.request_id !== replayRow.request_id);
  const persisted = write?.data?.id && (command ? await rest('GET', `/brands/${write.data.id}`) : await rest('GET', `/content-variants/${write.data.id}`));
  evidence.push({ label: 'replay-one-effect-two-audit-rows', duplicateWrites, distinctReplay, replayFlag: replayRow?.replayed ?? false,
    passed: distinctReplay && duplicateWrites === 0 && replayRow?.replayed === true && checkWrite(persisted?.variant ?? persisted) &&
      (!command || persisted.version === 1) });

  if (!command) {
    await run([plan('denied-cross-workspace-hidden-as-not-found', readTool, { ...readArgs(a.id), workspace_id: randomUUID() }, readTarget,
      { code: 'NOT_FOUND', outcome: 'denied' })]);
  } else {
    await run([plan('denied-human-required', 'smartsell_operation_call', { operation: 'ads_decide_proposal', params: { id: randomUUID() },
      body: { decision: 'approved' }, idempotency_key: randomUUID() }, undefined, { code: 'HUMAN_REQUIRED', outcome: 'denied' })]);
  }
  // Native discovery deliberately hides unauthorized tools. Exercise the exact wire denial without claiming a native call.
  const denied = await rawTool(env, readOnly.token, writeTool, writeArgs);
  const denialAudit = await webAudit(denied.requestId, { name: writeTool, outcome: 'error', code: 'TOOL_UNAVAILABLE',
    credentialId: readOnly.id, exactOutcome: 'denied', target: writeTarget });
  const deniedProtocol = Boolean(denied.value?.error || denied.value?.result?.isError);
  evidence.push({ label: 'denied-read-only-write', transport: 'direct JSON-RPC (hidden from native discovery)', requestId: denied.requestId, denialAudit,
    rpcError: denied.value?.error?.code ?? denied.value?.result?.structuredContent?.error?.code, passed: deniedProtocol && denialAudit.status === 'matched' });

  try {
    const grant = await oauth(env, privateValue, protect);
    const [one, two] = await run([
      plan('oauth-read-a', readTool, readArgs(a.id), readTarget, { check: data => data?.id === a.id }),
      plan('oauth-read-b', readTool, readArgs(b.id), readTarget, { check: data => data?.id === b.id }),
    ], grant);
    const id = one?.webAudit?.cohort?.[0]?.credential_id;
    const correlated = Boolean(id && id === two?.webAudit?.cohort?.[0]?.credential_id && ![main.id, readOnly.id].includes(id));
    await env.http('/oauth/revoke', 'POST', { token: grant.token, client_id: grant.client_id });
    const revoked = await rawTool(env, grant.token, readTool, readArgs(a.id));
    const noRow = await webAudit(revoked.requestId, {});
    evidence.push({ label: 'oauth-same-grant-and-revoked-call-unattributed', credentialId: id, requestId: revoked.requestId, status: revoked.status, noRow,
      passed: correlated && revoked.status === 401 && noRow.status === 'missing_web_row' });
  } catch (error) {
    evidence.push({ label: 'oauth-fixture', detail: error.message, passed: false });
  }
  const firstPath = `/api/v1/workspaces/${ws}/mcp-tool-calls?request_id=${encodeURIComponent(first?.requestId ?? randomUUID())}`;
  const anonymous = await fetch(env.origin + firstPath, { redirect: 'error', signal: AbortSignal.timeout(12000) });
  const bearer = await fetch(env.origin + firstPath, { redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { authorization: `Bearer ${main.token}` } });
  await Promise.all([anonymous.arrayBuffer(), bearer.arrayBuffer()]);
  evidence.push({ label: 'audit-needs-authenticated-browser-session', anonymousStatus: anonymous.status, bearerStatus: bearer.status,
    passed: anonymous.status === 401 && bearer.status === 401 && first?.webAudit?.httpStatus === 200 });
  const nativeCount = evidence.filter(row => row.transport === 'native CLI');
  return { passed: evidence.every(row => row.passed), native: { attempted: nativeCount.length, receipts: nativeCount.filter(row => row.wire).length,
    matched: nativeCount.filter(row => row.webAudit?.status === 'matched').length, business: nativeCount.filter(row => row.business).length }, evidence };
}
