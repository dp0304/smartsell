import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { fixture } from './local-http-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

async function espFixture(t, handler) {
  const mock = httpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const [status, result] = await handler(request.url, body);
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(result));
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
  return fixture(t);
}

test('local ESP previews native members, excludes withdrawals and suppressions, and recovers delivery by receipt', async t => {
  const submitted = [];
  const suppressions = [];
  const acknowledgments = new Map();
  const { call } = await espFixture(t, (url, body) => {
    if (url === '/esp/members') return [200, { profile_refs: ['one','two','three','four'].map(sha) }];
    if (url === '/esp/suppressions') return [200, { events: suppressions }];
    if (url === '/esp/submit') {
      submitted.push(body);
      acknowledgments.set(body.request_key, { request_key: body.request_key, receipt_ref: `receipt-${submitted.length}`, status: 'failed' });
      return [503];
    }
    if (url === '/esp/cancel') {
      acknowledgments.set(body.request_key, { request_key: body.request_key, receipt_ref: 'cancelled', status: 'cancelled' });
      return [503];
    }
    if (url === '/esp/receipt') return [200, acknowledgments.get(body.request_key)];
    if (url === '/esp/flow') return [200, { flow_ref: body.flow_ref, status: 'paused' }];
    return [404];
  });
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

test('EM01 excludes a late ESP withdrawal from the actual submission and deduplicates retries', async t => {
  const withdrawnAddress = 'withdrawn@mail.test';
  const eligibleAddress = 'eligible@mail.test';
  const addresses = [withdrawnAddress, eligibleAddress];
  const submitted = [];
  const feed = [];
  const withdrawal = { id: 'withdrawal', kind: 'unsubscribe', address_hash: sha(withdrawnAddress), at: '2025-01-04T00:00:00.000Z' };
  const olderWithdrawal = { ...withdrawal, id: 'older-withdrawal', at: '2025-01-02T00:00:00.000Z' };
  let readback;
  let releaseFeedOnMembers = false;
  const { call, events } = await espFixture(t, (url, body) => {
    if (url === '/esp/members') {
      if (releaseFeedOnMembers) {
        releaseFeedOnMembers = false;
        feed.push(withdrawal, olderWithdrawal, withdrawal);
      }
      return [200, { profile_refs: addresses.map(sha) }];
    }
    if (url === '/esp/suppressions') return [200, { events: feed }];
    if (url === '/esp/submit') {
      submitted.push(body);
      return [503];
    }
    if (url === '/esp/receipt') return [200, readback];
    return [404];
  });
  const account = await call('POST', '/esp-accounts', { provider: 'mock', external_account_id: 'late-withdrawal', brand_id: 'brand', channel: 'email', is_sending_system_of_record: true });
  await call('PUT', `/esp-accounts/${account.id}/local-config`, { enable: true, address_allowlist: addresses }, { version: account.version });
  const customers = new Map();
  for (const address of addresses) {
    const customer = await call('POST', '/customers', { brand_id: 'brand' });
    customers.set(address, customer.id);
    for (const [kind, namespace] of [['esp_profile', account.id], ['email', 'verified-email']]) {
      await call('POST', `/customers/${customer.id}/identities`, { kind, namespace, value_hash: sha(address), verified: true,
        verification_method: 'manual_evidence', evidence_ids: ['local-fixture'] }, { version: customer.version });
    }
  }
  for (const [channel, purpose] of [['email', 'marketing'], ['sms', 'marketing'], ['email', 'service']]) {
    const copy = await call('POST', '/consent-texts', { channel, purpose, locale: 'en', text: 'Contact consent', effective_from: '2025-01-01T00:00:00.000Z' });
    const recipients = channel === 'email' && purpose === 'marketing' ? addresses : [withdrawnAddress];
    for (const address of recipients) {
      await call('POST', `/customers/${customers.get(address)}/consents`, { channel, purpose, action: 'opt_in', source: 'support_request',
        source_ref: 'local-fixture', consent_text_version_id: copy.id, evidence_ids: ['local-fixture'], captured_at: '2025-01-03T00:00:00.000Z' });
    }
  }
  const segment = await call('POST', '/segments', { name: 'Native', brand_id: 'brand', mode: 'esp_native', esp_segment_ref: 'native', required_consent: { channel: 'email', purpose: 'marketing' } });
  assert.equal((await call('POST', `/segments/${segment.id}/preview`, {})).eligible_count, 2);
  const campaign = await call('POST', '/esp-campaigns', { esp_account_id: account.id, segment_version_id: segment.current_version_id, template_ref: 'local-template' });
  const path = `/esp-campaigns/${campaign.id}`;
  const submit = () => call('POST', `${path}/local-submit`, { action: 'schedule' }, { version: campaign.version, key: 'schedule-with-retry' });
  const reconcile = attempt => call('POST', `${path}/local-reconcile`, { attempt_id: attempt.id });

  releaseFeedOnMembers = true;
  const [attempt, retry] = await Promise.all([submit(), submit()]);
  assert.deepEqual(retry, attempt);
  assert.equal(attempt.status, 'unknown');
  const eligibleId = customers.get(eligibleAddress);
  assert.deepEqual(submitted.map(request => request.recipients), [[{ address: eligibleAddress, customer_id: eligibleId }]]);

  const sync = () => call('POST', `/esp-accounts/${account.id}/sync-suppressions`, {});
  await Promise.all([sync(), sync()]);
  const withdrawnId = customers.get(withdrawnAddress);
  const consents = await call('GET', `/customers/${withdrawnId}/consents`);
  assert.equal(consents.records.filter(record => record.source === 'esp' && record.action === 'withdrawn').length, 2);
  const state = (channel, purpose) => consents.states.find(row => row.channel === channel && row.purpose === purpose).state;
  assert.equal(state('email', 'marketing'), 'opted_out');
  assert.equal(state('email', 'service'), 'opted_in');
  assert.equal(state('sms', 'marketing'), 'opted_in');
  const withdrawals = (await events()).filter(event => event.type === 'lifecycle.consent.changed' && event.payload.customer_id === withdrawnId && event.payload.state === 'opted_out');
  assert.equal(withdrawals.length, 1);

  readback = { status: 'sent', request_key: attempt.request_key, receipt_ref: 'actual', customer_ids: [eligibleId],
    sent_at: new Date().toISOString(), delivered_count: 1 };
  const [sent, replayed] = await Promise.all([reconcile(attempt), reconcile(attempt)]);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.delivered_count, 1);
  assert.equal(replayed.send_snapshot_id, sent.send_snapshot_id);
  readback = { status: 'scheduled', request_key: attempt.request_key, receipt_ref: 'stale-schedule' };
  assert.equal((await reconcile(attempt)).status, 'sent');
  assert.equal((await call('GET', path)).status, 'sent');
  const snapshots = await call('GET', `/segments/${segment.id}/snapshots`);
  assert.deepEqual(snapshots.filter(row => row.purpose === 'preview').map(row => row.eligible_count), [2]);
  assert.deepEqual(snapshots.filter(row => row.purpose === 'schedule_estimate').map(row => row.excluded), [{ opted_out: 1 }]);
  assert.deepEqual(snapshots.filter(row => row.purpose === 'send_execution').map(row => row.esp_count), [1]);

  const followUp = await call('POST', '/esp-campaigns', { esp_account_id: account.id, segment_version_id: segment.current_version_id, template_ref: 'follow-up' });
  const followUpPath = `/esp-campaigns/${followUp.id}`;
  const blocked = await call('POST', `${followUpPath}/local-submit`, { action: 'test_send', test_address: withdrawnAddress }, { version: followUp.version, key: 'follow-up-test' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'no_eligible_allowlisted_addresses');
  assert.deepEqual(await call('GET', `${followUpPath}/attempts`), []);
  assert.equal(submitted.length, 1);
});
