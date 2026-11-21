import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Data, Row } from '@smartsell/contracts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const reportEvent = 'analytics.report_version.finalized';

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function close(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function eventually<T>(check: () => Promise<T | undefined>, failure: () => string, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error(failure());
}

// Exercise the same child entry point as pnpm start:kernel, using the actual HTTP API and a persistent file store.
test('kernel entry point restarts, sends a signed finalized report to loopback and persists the receipt', { timeout: 70_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-signed-hook-'));
  let stopActive: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await stopActive?.(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const stateFile = join(directory, 'operations.json');
  const placeholder = createServer();
  const port = await listen(placeholder);
  await close(placeholder);
  const origin = `http://127.0.0.1:${port}`;
  const appSecret = randomBytes(32).toString('hex');
  const setupToken = randomUUID();
  const signingKey = randomBytes(32).toString('hex');
  let logs = '';
  async function launch(destination?: { tenantId: string; workspaceId: string; url: string }) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/kernel-main.ts'], {
      cwd: root,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin,
        SMARTSELL_DATA_FILE: stateFile, SMARTSELL_WEBHOOK_LOOPBACK: '1', APP_SECRET: appSecret, SETUP_TOKEN: setupToken,
        ...(destination ? { SMARTSELL_CUSTOMER_EGRESS: JSON.stringify([{ ...destination, kind: 'webhook',
          secretId: 'report', secretEnv: 'SMARTSELL_EGRESS_SECRET_REPORT' }]), SMARTSELL_EGRESS_SECRET_REPORT: signingKey } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { logs = (logs + String(chunk)).slice(-30_000); });
    child.stderr.on('data', chunk => { logs = (logs + String(chunk)).slice(-30_000); });
    const exited = once(child, 'exit');
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 4000).unref();
      try { await exited; }
      finally { clearTimeout(timeout); }
    };
    stopActive = stop;
    await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Kernel exited\n${logs}`);
      const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined);
      await response?.body?.cancel();
      if (response?.ok) return true;
    }, () => `Kernel did not become ready\n${logs}`, 15_000);
    return stop;
  }

  const requests: { body: Buffer; signature?: string; idempotencyKey?: string }[] = [];
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-smartsell-signature'] as string | undefined;
      requests.push({ body, signature, idempotencyKey: req.headers['idempotency-key'] as string | undefined });
      const expected = `sha256=${createHmac('sha256', signingKey).update(body).digest('hex')}`;
      if (req.method !== 'POST' || req.url !== '/receiver' || signature !== expected) res.writeHead(401).end();
      else res.writeHead(202, { 'X-SmartSell-Receipt-Id': 'offline-report-receipt' }).end();
    });
  });
  const receiverPort = await listen(receiver);
  t.after(() => close(receiver));
  const url = `http://127.0.0.1:${receiverPort}/receiver`;

  const stopInitial = await launch();
  const setupResponse = await fetch(`${origin}/api/v1/setup`, { method: 'POST', headers: {
    origin, 'x-setup-token': setupToken, 'content-type': 'application/json',
  }, body: JSON.stringify({ email: 'owner@example.test', password: 'isolated-fixture-1234', workspace_name: 'Signed webhook smoke' }) });
  const setup = await setupResponse.json();
  assert.equal(setupResponse.status, 201, JSON.stringify(setup));
  const workspaceId = setup.data.workspaces[0].id as string;
  const cookie = setupResponse.headers.get('set-cookie')!.split(';')[0]!;
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as { identity: [string, string][] };
  const tenantId = (JSON.parse(new Map(state.identity).get(`workspace/${workspaceId}`)!) as { tenantId: string }).tenantId;
  await stopInitial();

  const destination = { tenantId, workspaceId, url };
  const stopConfigured = await launch(destination);
  const api = `/api/v1/workspaces/${workspaceId}`;
  async function request<T>(path: string, options?: { method?: string; body?: Data; version?: number }) {
    const response = await fetch(`${origin}${api}${path}`, { method: options?.method ?? 'GET', headers: {
      origin, cookie, 'x-csrf-token': setup.data.csrf_token,
      ...(options?.body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      ...(options?.version === undefined ? {} : { 'if-match': `"${options.version}"` }),
    }, ...(options?.body ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(3500) });
    const body = await response.json();
    assert.ok(response.ok, `${path} returned ${response.status} ${JSON.stringify(body)}`);
    return body.data as T;
  }
  const subscription = await request<Row>('/admin/webhook-subscriptions', { method: 'POST', body: {
    url, secret_id: 'report', event_types: [reportEvent],
  } });
  await request('/admin/egress-policies/workspace', { method: 'PUT', body: { rules: [{ destination_kind: 'outbound_webhook',
    destination_id: subscription.id, data_class: 'internal', effect: 'allow' }] } });
  const report = await request<Row>('/reports', { method: 'POST', body: { title: 'Offline report',
    period: { from: '2026-11-01', to: '2026-11-02' }, sections: [{ key: 'summary', type: 'narrative' }] } });
  const receipt = await request<{ operation_id: string }>(`/reports/${report.id}/versions`, { method: 'POST', body: {} });
  const draft = await eventually(async () => {
    const job = await request<{ status: string; result_ref?: { version_id: string } }>(`/operations/${receipt.operation_id}`);
    if (job.result_ref) return request<Row>(`/report-versions/${job.result_ref.version_id}`);
  }, () => 'Report generation did not complete');
  await request(`/report-versions/${draft.id}/finalize`, { method: 'POST', body: {}, version: draft.version });
  const deliveriesPath = `/signed-webhook-deliveries?subscription_id=${subscription.id}`;
  let observed: Row[] = [];
  const delivery = await eventually(async () => {
    observed = await request<Row[]>(deliveriesPath);
    return observed.find(row => row.status === 'delivered');
  }, () => `No signed receipt for finalized report (${JSON.stringify(observed)})\n${logs}`);
  assert.equal(delivery.attempt, 1);
  assert.equal(delivery.response_code, 202);
  assert.equal(delivery.receipt_id, 'offline-report-receipt');
  assert.equal(requests.length, 1);
  const received = requests[0]!;
  const parsed = JSON.parse(received.body.toString());
  assert.equal(parsed.type, reportEvent);
  assert.equal(parsed.tenant_id, tenantId);
  assert.equal(parsed.workspace_id, workspaceId);
  assert.equal(parsed.delivery_id, received.idempotencyKey);
  assert.deepEqual(parsed.data, { report_id: report.id, version_id: draft.id });
  assert.equal(received.idempotencyKey, delivery.idempotency_key);
  assert.equal(createHash('sha256').update(received.body).digest('hex'), delivery.payload_sha256);

  await stopConfigured();
  await launch(destination);
  await delay(1200);
  assert.deepEqual(await request<Row[]>(deliveriesPath), [delivery]);
  assert.equal(requests.length, 1);
});
