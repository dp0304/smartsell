import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { fixture } from './local-http-fixture.mjs';

test('local ESP previews native members, excludes withdrawals and suppressions, and recovers delivery by receipt', async t => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  const submitted = [];
  const suppressions = [];
  const acknowledgments = new Map();
  const mock = httpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    let result;
    if (request.url === '/esp/members') result = { profile_refs: ['one','two','three','four'].map(sha) };
    if (request.url === '/esp/suppressions') result = { events: suppressions };
    if (request.url === '/esp/submit') {
      submitted.push(body);
      acknowledgments.set(body.request_key, { request_key: body.request_key, receipt_ref: `receipt-${submitted.length}`, status: 'failed' });
      response.writeHead(503).end();
      return;
    }
    if (request.url === '/esp/cancel') {
      acknowledgments.set(body.request_key, { request_key: body.request_key, receipt_ref: 'cancelled', status: 'cancelled' });
      response.writeHead(503).end();
      return;
    }
    if (request.url === '/esp/receipt') result = acknowledgments.get(body.request_key);
    if (request.url === '/esp/flow') result = { flow_ref: body.flow_ref, status: 'paused' };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const oldOrigin = process.env.SMARTSELL_LOCAL_ESP_ORIGIN;
  process.env.SMARTSELL_LOCAL_ESP_ORIGIN = `http://127.0.0.1:${mock.address().port}`;
  t.after(() => {
    if (oldOrigin === undefined) delete process.env.SMARTSELL_LOCAL_ESP_ORIGIN;
    else process.env.SMARTSELL_LOCAL_ESP_ORIGIN = oldOrigin;
  });
  const { call } = await fixture(t);
  const account = await call('POST', '/esp-accounts', { provider: 'mock', external_account_id: 'local-1', brand_id: 'brand', channel: 'email', is_sending_system_of_record: true });
  await call('PUT', `/esp-accounts/${account.id}/local-config`, { enable: true, address_allowlist: ['one@external.example'] }, { version: account.version, status: 422 });
  await call('PUT', `/esp-accounts/${account.id}/local-config`, { enable: true, address_allowlist: ['one','two','three'].map(name => `${name}@mail.test`) }, { version: account.version });
  const copy = await call('POST', '/consent-texts', { channel: 'email', purpose: 'marketing', locale: 'en', text: 'Email updates' });
  const customers = {};
  for (const name of ['one','two','three','four']) {
    const customer = await call('POST', '/customers', { brand_id: 'brand' });
    customers[name] = customer.id;
    for (const [kind, namespace, value] of [['esp_profile', account.id, name], ['email', 'verified-email', `${name}@mail.test`]]) {
      await call('POST', `/customers/${customer.id}/identities`, { kind, namespace, value_hash: sha(value), verified: true, verification_method: 'manual_evidence', evidence_ids: ['local-fixture'] }, { version: customer.version });
    }
    await call('POST', `/customers/${customer.id}/consents`, { channel: 'email', purpose: 'marketing', action: 'opt_in', source: 'support_request', source_ref: name, consent_text_version_id: copy.id, evidence_ids: ['local-fixture'] });
  }
  const segment = await call('POST', '/segments', { name: 'Native', brand_id: 'brand', mode: 'esp_native', esp_segment_ref: 'native', required_consent: { channel: 'email', purpose: 'marketing' } });
  const preview = await call('POST', `/segments/${segment.id}/preview`, {});
  assert.equal(preview.eligible_count, 4);
  assert.equal(preview.member_ids, undefined);
  suppressions.push({ id: 'optout', kind: 'unsubscribe', address_hash: sha('two@mail.test'), at: new Date().toISOString() },
    { id: 'bounce', kind: 'bounce', address_hash: sha('three@mail.test'), at: new Date().toISOString() });
  const campaign = await call('POST', '/esp-campaigns', { esp_account_id: account.id, segment_version_id: segment.current_version_id, template_ref: 'local-template' });
  const path = `/esp-campaigns/${campaign.id}`;
  const submit = (key, status = 200) => call('POST', `${path}/local-submit`, { action: 'schedule' }, { key, version: campaign.version, status });
  const reconcile = attempt => call('POST', `${path}/local-reconcile`, { attempt_id: attempt.id });
  const first = await submit('first');
  assert.equal(first.status, 'unknown');
  assert.deepEqual(submitted[0].recipients, [{ address: 'one@mail.test', customer_id: customers.one }]);
  await submit('too-soon', 409);
  assert.equal(submitted.length, 1);
  assert.equal((await reconcile(first)).status, 'failed');
  const retry = await submit('retry');
  assert.notEqual(retry.id, first.id);
  acknowledgments.set(retry.request_key, { status: 'scheduled', request_key: retry.request_key, receipt_ref: 'scheduled' });
  assert.equal((await reconcile(retry)).status, 'scheduled');
  acknowledgments.set(retry.request_key, { status: 'sent', request_key: retry.request_key, receipt_ref: 'actual', customer_ids: [customers.one], sent_at: new Date().toISOString() });
  const sent = await reconcile(retry);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.delivered_count, undefined);
  acknowledgments.set(retry.request_key, { ...acknowledgments.get(retry.request_key), receipt_ref: 'delivery-report', delivered_count: 1 });
  const delivered = await reconcile(retry);
  assert.equal(delivered.send_snapshot_id, sent.send_snapshot_id);
  assert.equal(delivered.delivered_count, 1);
  assert.equal((await call('GET', `${path}/attempts`)).find(row => row.id === sent.id).delivery_receipt_ref, 'delivery-report');
  assert.equal((await call('GET', path)).status, 'sent');
  const snapshots = await call('GET', `/segments/${segment.id}/snapshots`);
  assert.equal(snapshots.find(row => row.purpose === 'preview').eligible_count, 4);
  assert.deepEqual(snapshots.find(row => row.purpose === 'schedule_estimate').excluded, { opted_out: 1, suppressed: 1 });
  assert.equal(snapshots.find(row => row.purpose === 'send_execution').esp_count, 1);
  const cancelledCampaign = await call('POST', '/esp-campaigns', { esp_account_id: account.id, segment_version_id: segment.current_version_id, template_ref: 'cancel-example' });
  const cancelPath = `/esp-campaigns/${cancelledCampaign.id}`;
  const scheduled = await call('POST', `${cancelPath}/local-submit`, { action: 'schedule' }, { key: 'cancel-example', version: cancelledCampaign.version });
  acknowledgments.set(scheduled.request_key, { status: 'scheduled', receipt_ref: 'schedule-to-cancel', request_key: scheduled.request_key });
  await call('POST', `${cancelPath}/local-reconcile`, { attempt_id: scheduled.id });
  const scheduledCampaign = await call('GET', cancelPath);
  const cancel = await call('POST', `${cancelPath}/local-cancel`, { attempt_id: scheduled.id }, { key: 'cancel-request', version: scheduledCampaign.version });
  assert.ok(cancel.cancel_requested_at);
  assert.equal((await call('GET', cancelPath)).status, 'scheduled');
  assert.equal((await call('POST', `${cancelPath}/local-reconcile`, { attempt_id: scheduled.id })).status, 'cancelled');
  assert.equal((await call('GET', cancelPath)).status, 'cancelled');
  const flow = await call('POST', '/esp-flows', { esp_account_id: account.id, kind: 'welcome', trigger: 'sign_up', exit_on_purchase: false });
  assert.equal((await call('POST', `/esp-flows/${flow.id}/local-readback`, { flow_ref: 'welcome' })).provider_status, 'paused');
});
