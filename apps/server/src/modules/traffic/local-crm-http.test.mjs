import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { fixture } from '../lifecycle/local-http-fixture.mjs';

test('local CRM handoff waits for a matched receipt after an ambiguous dispatch', async t => {
  const received = [];
  let outcome = 'unknown';
  const mock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (request.url === '/crm/handoff') {
      received.push(body);
      response.writeHead(503).end();
      return;
    }
    const receipt = { handoff_id: body.handoff_id, outcome, evidence_ref: `mock-${outcome}`, external_ref: 'record-1' };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(receipt));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const key = 'SMARTSELL_LOCAL_CRM_ORIGIN';
  const previous = process.env[key];
  process.env[key] = `http://127.0.0.1:${mock.address().port}`;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const { call, seed } = await fixture(t);
  const customer = await call('POST', '/customers', { brand_id: 'brand' });
  const copy = await call('POST', '/consent-texts', { channel: 'email', purpose: 'service', locale: 'en', text: 'Service follow-up' });
  const consent = await call('POST', `/customers/${customer.id}/consents`, { channel: 'email', purpose: 'service', action: 'opt_in', source: 'support_request', source_ref: 'form', consent_text_version_id: copy.id, evidence_ids: ['local-fixture'] });
  const lead = await seed(ctx => ctx.create('lead', { brand_id: 'brand', customer_id: customer.id, channel_consents: [consent.id], status: 'qualified' }));
  const path = `/leads/${lead.id}`;
  const handoff = await call('POST', `${path}/handoff`, { channel: 'email', destination: 'local-mock' }, { version: lead.version });
  const receipt = async status => call('POST', `${path}/handoff/receipt`, { handoff_id: handoff.handoff_id, readback: 'local' }, { version: (await call('GET', path)).version, status });
  await receipt(409);
  const dispatch = async (idempotencyKey, status) => call('POST', `${path}/handoff/local-dispatch`, {}, { key: idempotencyKey, version: (await call('GET', path)).version, status });
  assert.ok((await dispatch('crm-submit')).local_crm_dispatched_at);
  assert.equal((await receipt()).handoff_status, 'unknown');
  await dispatch('crm-repeat', 409);
  assert.deepEqual(received, [{ handoff_id: handoff.handoff_id, lead_id: lead.id, channel: 'email' }]);
  outcome = 'confirmed';
  assert.equal((await receipt()).status, 'handed_off');
  const stored = await call('GET', path);
  assert.equal(stored.contact, 'masked');
  assert.equal(stored.activities.filter(row => row.type === 'handed_off').length, 1);
});
