import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'vitest';
import { frozenRevisionHash, parseConnectorClaim, parseConnectorTask, taskKinds } from '../../../packages/connector-tasks/src/index.ts';
import { createFixture, FixturePermitClient } from '../src/fixture.ts';
import { ConnectorRun } from '../src/workflow.ts';
import { HttpSubmitPermitClient, PermitError, type SubmitPermitClient } from '../src/permit.ts';
import { SignedDeviceClient, createPairingRequest, createSignedHttpTransport, pairOverHttp } from '../src/device-client.ts';
import { matchesAndroidHardware, parseManualTarget, runManualGatewayOnce, type ManualIO } from '../src/manual-gateway.ts';

function scenario(app: 'browser' | 'android' | 'ios' | 'tiktok' = 'browser', mode: 'assist' | 'auto' = 'auto', host = 'darwin') {
  let millis = Date.parse('2026-11-19T00:00:00Z');
  const now = () => millis;
  const fixture = createFixture(app, mode, now, host);
  const permits = new FixturePermitClient(now);
  return { ...fixture, now, tick: (ms: number) => { millis += ms; }, permits,
    run: (client: SubmitPermitClient = permits, timeout?: number) => new ConnectorRun(fixture.claim, fixture.driver, client, now, timeout) };
}

test('strict task schema rejects unknown commands, mixed targets, media URLs and tampered approvals', () => {
  const { claim, task } = scenario();
  assert.deepEqual(parseConnectorClaim(claim), claim);
  assert.throws(() => Reflect.apply(Array.prototype.push, taskKinds, ['douyin.custom']));
  assert.throws(() => parseConnectorTask({ ...task, kind: 'remote.shell' }));
  assert.throws(() => parseConnectorTask({ ...task, kind: 'douyin.app.comment_reply' }));
  assert.throws(() => parseConnectorTask({ ...task, script: 'anything' }));
  assert.throws(() => parseConnectorTask({ ...task, target: { ...task.target, app: 'xhs' } }));
  assert.throws(() => frozenRevisionHash({ ...task.payload.revision, media: [{ id: 'fixture-example', sha256: 'a'.repeat(64), url: 'https://example.com' }] }));
  assert.throws(() => parseConnectorTask({ ...task, payload: { ...task.payload, revision: { ...task.payload.revision, body: 'changed' } } }));
});

test('D20/D21 rejects unowned and unsupported machines before requesting a permit', async () => {
  for (const [entry, reason] of [
    [scenario('browser', 'auto', 'linux'), 'host_unsupported'], [scenario('ios', 'auto', 'win32'), 'device_compat_blocked'],
  ] as const) {
    assert.equal((await entry.run().advance() as { reason: string }).reason, reason);
    assert.equal(entry.permits.requestCount, 0);
  }
  const owned = scenario('android');
  owned.phone.owned = false;
  assert.deepEqual(await owned.run().advance(), { kind: 'blocked', reason: 'mobile_unavailable', handoff: 'manual' });
  const wifi = scenario('android');
  Object.assign(wifi.phone, { transport: 'same_lan', major: 10, same_lan_confirmed: true });
  assert.equal((await wifi.run().advance() as { reason: string }).reason, 'device_compat_blocked');
  const pair = scenario();
  pair.driver.localState.pairing!.revoked = true;
  assert.equal((await pair.run().advance() as { reason: string }).reason, 'pairing_required');
});

test('challenge and switched identity immediately hand off without submission', async () => {
  const blocked = scenario('tiktok');
  blocked.driver.identityObservation = { kind: 'captcha' };
  assert.deepEqual(await blocked.run().advance(), { kind: 'blocked', reason: 'captcha', auto_stop: 'captcha', handoff: 'awaiting_creator_action' });
  const changed = scenario('android');
  const run = changed.run({ request: input => changed.permits.request(input), consume: async input => {
    changed.driver.identityObservation = { kind: 'signed_in', platform_identity: 'fixture-different' };
    return changed.permits.consume(input);
  } });
  assert.deepEqual(await run.advance(), { kind: 'blocked', reason: 'identity_mismatch', auto_stop: 'identity_mismatch', handoff: 'manual' });
  assert.equal(changed.driver.submissions, 0);
});

test('independent approval, SHA-256 media and unique TikTok draft are required', async () => {
  const revoked = scenario();
  revoked.driver.approvals.clear();
  assert.equal((await revoked.run().advance() as { reason: string }).reason, 'approval_invalid');
  const media = scenario('android');
  media.driver.media.set('fixture-media', Buffer.from('tampered'));
  assert.equal((await media.run().advance() as { reason: string }).reason, 'media_unverified');
  assert.equal(media.permits.requestCount, 0);
  const draft = scenario('tiktok');
  draft.driver.registerDrafts(draft.task, ['fixture-draft', 'fixture-other']);
  assert.deepEqual(await draft.run().advance(), { kind: 'blocked', reason: 'draft_ambiguous', handoff: 'awaiting_creator_action' });
});

test('deferred permits wait, then consume once and emit accepted evidence for later verification', async () => {
  const entry = scenario('android');
  let deferred = false;
  const run = entry.run({
    request: async input => deferred ? entry.permits.request(input) :
      (deferred = true, { decision: 'deferred', deny_reason: 'hourly_cap', retry_at: new Date(entry.now() + 2000).toISOString() }),
    consume: input => entry.permits.consume(input),
  });
  for (let i = 0; i < 2; i++) assert.equal((await run.advance()).kind, 'awaiting_submit_permit');
  assert.equal(entry.permits.requestCount, 0);
  entry.tick(2000);
  const result = await run.advance();
  assert.equal(result.kind, 'accepted');
  if (result.kind !== 'accepted') return;
  assert.equal(result.submitted_by, 'auto');
  assert.equal(result.evidence.length, 2);
  for (const item of result.evidence) {
    const stored = entry.driver.evidence.get(item.object_id)!;
    assert.equal(createHash('sha256').update(stored.content).digest('hex'), item.sha256);
    assert.equal(stored.capture_context.mobile_device_id, 'fixture-phone');
  }
  assert.deepEqual(await run.advance(), result);
  assert.equal(entry.driver.submissions, 1);
  assert.equal(entry.permits.consumeCount, 1);
  const ref = { source_attempt_id: entry.task.attempt_id, platform_post_id: result.platform_post_id };
  const cleanup = () => new ConnectorRun({ ...entry.claim, task: { ...entry.task, kind: 'mobile.cleanup_media', attempt_id: 'fixture-clean',
    payload: { ...ref, media: entry.task.payload.revision.media } } }, entry.driver, entry.permits, entry.now);
  assert.equal((await cleanup().advance()).kind, 'blocked');
  const verification = new ConnectorRun({ ...entry.claim, task: { ...entry.task, kind: 'post.verify_visible', attempt_id: 'fixture-verify', payload: ref } }, entry.driver, entry.permits, entry.now);
  assert.deepEqual(await verification.advance(), { kind: 'visibility_checked', visible: true });
  assert.deepEqual(await cleanup().advance(), { kind: 'media_cleaned' });
});

test('denial and heartbeat stop allow only an explicit local assist click', async () => {
  const entry = scenario();
  const run = entry.run({ request: async () => ({ decision: 'denied', deny_reason: 'emergency_halt' }), consume: async () => assert.fail() });
  assert.equal((await run.advance()).kind, 'awaiting_user_click');
  assert.equal(entry.driver.submissions, 0);
  run.applyHeartbeat('auto');
  entry.driver.simulateHumanClick(entry.task);
  assert.equal((await run.advance() as { submitted_by: string }).submitted_by, 'human');
  const heartbeat = scenario();
  let switched: ConnectorRun;
  switched = heartbeat.run({ request: input => {
    switched.applyHeartbeat('assist');
    return heartbeat.permits.request(input);
  }, consume: async () => assert.fail() });
  assert.equal((await switched.advance()).kind, 'awaiting_user_click');
});

test('assist timeout, stale fences and ambiguous consume never submit', async () => {
  const entry = scenario('tiktok', 'assist');
  const run = entry.run(entry.permits, 10);
  assert.equal((await run.advance()).kind, 'awaiting_user_click');
  entry.tick(10);
  assert.deepEqual(await run.advance(), { kind: 'blocked', reason: 'assist_submit_timeout', handoff: 'awaiting_creator_action' });
  const stale = scenario();
  assert.equal((await stale.run({ request: async () => { throw new PermitError(409); }, consume: async () => assert.fail() }).advance() as { reason: string }).reason, 'late_or_stale');
  const ambiguous = scenario();
  assert.equal((await ambiguous.run({ request: input => ambiguous.permits.request(input), consume: async () => { throw new Error('disconnected'); } }).advance() as { reason: string }).reason, 'permit_unavailable');
  assert.equal(ambiguous.driver.submissions, 0);
});

test('submit disconnect remains unknown and can recover evidence by original attempt', async () => {
  const entry = scenario();
  entry.driver.failAfterSubmit = true;
  const run = entry.run();
  assert.deepEqual(await run.advance(), { kind: 'outcome_unknown', submitted_by: 'auto' });
  await run.advance();
  const recovery = new ConnectorRun({ ...entry.claim, task: { ...entry.task, kind: 'post.capture_result', attempt_id: 'fixture-recovery',
    payload: { source_attempt_id: entry.task.attempt_id } } }, entry.driver, entry.permits, entry.now);
  assert.equal((await recovery.advance()).kind, 'result_captured');
  assert.equal(entry.driver.submissions, 1);
});

test('signed device transport binds body, action, workspace, device and nonce', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const entry = scenario();
  const pairing = createPairingRequest(entry.task.workspace_id, 'a'.repeat(32), 'darwin', 'Fixture desktop', privateKey, { userInitiated: true, ownsDevice: true });
  assert.equal(verify(null, Buffer.from(JSON.stringify(['smartsell.pair.v1', entry.task.workspace_id, pairing.pairing_code, pairing.public_key, pairing.platform, pairing.name])), publicKey, Buffer.from(pairing.proof, 'base64url')), true);
  const actions: string[] = [];
  const nonces = new Set();
  const client = new SignedDeviceClient(entry.task.workspace_id, entry.task.connector_device_id, privateKey, async (action, raw, signed) => {
    const digest = createHash('sha256').update(raw).digest('hex');
    const signedBytes = Buffer.from(JSON.stringify(['smartsell.device.v1', entry.task.workspace_id, signed.device_id, action, signed.timestamp, signed.nonce, digest]));
    assert.equal(verify(null, signedBytes, publicKey, Buffer.from(signed.signature, 'base64url')), true);
    assert.equal(JSON.parse(Buffer.from(raw).toString()).attempt_id, entry.task.attempt_id);
    actions.push(action); nonces.add(signed.nonce);
    if (action === 'attempt.ready') return { status: 'verified' };
    if (action === 'attempt.permit') return { decision: 'granted', permit_id: 'fixture-permit', expires_at: new Date(entry.now() + 2000).toISOString() };
    return { decision: 'granted' };
  }, entry.now);
  const run = new ConnectorRun(entry.claim, entry.driver, client, entry.now, undefined, (claim, id) => client.ready(claim, id));
  assert.equal((await run.advance()).kind, 'accepted');
  await client.report(run.report()!);
  assert.deepEqual(actions, ['attempt.ready', 'attempt.permit', 'attempt.consume', 'attempt.report']);
  assert.equal(nonces.size, 4);
});

test('HTTP permit transport enforces fixed endpoints, origin, and no redirects', async () => {
  const entry = scenario();
  const input = { attempt_id: entry.task.attempt_id, fencing_token: 1, write_slot_token: 1, request_hash: entry.task.payload.frozen_hash };
  assert.throws(() => new HttpSubmitPermitClient('http://example.com', () => 'token'));
  const client = new HttpSubmitPermitClient('https://api.example.com', () => 'token', async (url, init) => {
    assert.equal(String(url), `https://api.example.com/api/v1/attempts/${input.attempt_id}/submit-permit/consume`);
    assert.equal(init?.redirect, 'error');
    return Response.json({ error: { code: 'FENCING_STALE' } }, { status: 409 });
  });
  await assert.rejects(client.consume({ ...input, permit_id: 'fixture-permit' }), (error: unknown) => error instanceof PermitError && error.status === 409);
});

test('assist rechecks consent, device and the lease deadline at the explicit click', async () => {
  const noConsent = scenario('android');
  noConsent.binding.consent_confirmed = false;
  assert.deepEqual(await noConsent.run().advance(), { kind: 'blocked', reason: 'consent_required', handoff: 'manual' });
  assert.equal(noConsent.permits.requestCount, 0);

  const revoked = scenario('android', 'assist');
  const run = revoked.run();
  assert.equal((await run.advance()).kind, 'awaiting_user_click');
  revoked.driver.localState.pairing!.revoked = true;
  assert.throws(() => revoked.driver.simulateHumanClick(revoked.task));
  assert.deepEqual(await run.advance(), { kind: 'blocked', reason: 'pairing_required', handoff: 'manual' });
  assert.equal(revoked.driver.submissions, 0);

  const expired = scenario('browser', 'assist');
  expired.claim.lease_expires_at = new Date(expired.now() + 15_500).toISOString();
  const leaseRun = expired.run();
  assert.deepEqual(await leaseRun.advance(), { kind: 'awaiting_user_click', expires_at: new Date(expired.now() + 500).toISOString() });
  expired.tick(15_500);
  assert.throws(() => expired.driver.simulateHumanClick(expired.task));
  assert.deepEqual(await leaseRun.advance(), { kind: 'blocked', reason: 'lease_expired', handoff: 'manual' });
  assert.equal(expired.driver.submissions, 0);
});

test('loss of assist observation leaves the original attempt uncertain', async () => {
  const entry = scenario('browser', 'assist');
  const run = entry.run();
  assert.equal((await run.advance()).kind, 'awaiting_user_click');
  entry.driver.observeAssist = () => { throw new Error('Synthetic observation failure'); };
  assert.deepEqual(await run.advance(), { kind: 'outcome_unknown' });
  assert.equal(run.report()?.kind, 'outcome_unknown');
});


test('live manual gateway requires explicit consent before readiness or platform handoff', async () => {
  const entry = scenario();
  const local = parseManualTarget({ origin: 'https://gateway.example.invalid', workspace_id: entry.task.workspace_id,
    connector_device_id: entry.task.connector_device_id, binding_id: entry.task.binding_id, account_id: entry.task.account_id,
    session_id: 'fixture-browser', platform_identity: entry.task.platform_identity, target: entry.task.target });
  let prompts = 0;
  const result = await runManualGatewayOnce({
    heartbeat: async () => {}, claim: async () => entry.claim, ready: async () => assert.fail('readiness must wait for consent'),
    report: async report => {
      assert.equal(report.kind, 'blocked');
      return { status: 'completed' };
    },
  }, local, {
    ask: async () => { prompts++; return 'cancel'; }, display: () => assert.fail('must not disclose revision'),
    verifyMedia: async () => assert.fail('media verification must wait for consent'),
  }, entry.now);
  assert.deepEqual(result, { status: 'reported', attempt_id: entry.task.attempt_id,
    result: { kind: 'blocked', reason: 'consent_required', handoff: 'manual' } });
  assert.equal(prompts, 1);
});

test('standalone gateway pairs and reports a human submission over the signed HTTP protocol', async () => {
  const { task, claim, now } = scenario();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const origin = 'https://gateway.example.invalid';
  const actions: string[] = [];
  const nonces = new Set<string>();
  const routes: Record<string, string> = {
    '/api/v1/device/heartbeat': 'heartbeat', '/api/v1/device/claim': 'claim',
    [`/api/v1/attempts/${task.attempt_id}/ready`]: 'attempt.ready',
    [`/api/v1/attempts/${task.attempt_id}/device-report`]: 'attempt.report',
  };
  const evidence = [{ kind: 'masked_screenshot', sha256: 'a'.repeat(64), object_id: 'registered-evidence' }];
  const receipt = { platform_post_id: '123', result_url: 'https://www.douyin.com/video/123', evidence };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, origin);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const raw = Buffer.from(init?.body as Uint8Array);
    const body = JSON.parse(raw.toString('utf8'));
    if (url.pathname === '/api/v1/device/pair') {
      assert.equal(verify(null, Buffer.from(JSON.stringify(['smartsell.pair.v1', task.workspace_id, body.pairing_code, body.public_key,
        'darwin', 'Fixture desktop'])), publicKey, Buffer.from(body.proof, 'base64url')), true);
      return Response.json({ data: { device_id: task.connector_device_id } });
    }
    const action = routes[url.pathname];
    assert.ok(action, `unexpected request ${url.pathname}`);
    actions.push(action);
    const h = new Headers(init?.headers);
    const timestamp = h.get('x-smartsell-timestamp');
    const nonce = h.get('x-smartsell-nonce')!;
    assert.equal(h.get('x-smartsell-device'), task.connector_device_id);
    assert.equal(timestamp, new Date(now()).toISOString());
    assert.ok(!nonces.has(nonce));
    nonces.add(nonce);
    const signed = Buffer.from(JSON.stringify(['smartsell.device.v1', task.workspace_id, task.connector_device_id, action,
      timestamp, nonce, createHash('sha256').update(raw).digest('hex')]));
    assert.equal(verify(null, signed, publicKey, Buffer.from(h.get('x-smartsell-signature')!, 'base64url')), true);
    if (action === 'heartbeat') return Response.json({ data: { status: 'online' } });
    if (action === 'claim') {
      assert.deepEqual(body, { binding_id: task.binding_id });
      return Response.json({ data: { claim } });
    }
    if (action === 'attempt.ready') {
      assert.deepEqual(body, { attempt_id: task.attempt_id, fencing_token: claim.fencing_token, write_slot_token: claim.write_slot_token,
        observed_platform_identity: task.platform_identity });
      return Response.json({ data: { status: 'verified' } });
    }
    assert.deepEqual(body, { kind: 'accepted', submitted_by: 'human', ...receipt, attempt_id: task.attempt_id, fencing_token: claim.fencing_token, write_slot_token: claim.write_slot_token });
    return Response.json({ data: { status: 'outcome_unknown' } });
  };
  const id = await pairOverHttp(origin, task.workspace_id, 'a'.repeat(32), 'darwin', 'Fixture desktop', privateKey,
    { userInitiated: true, ownsDevice: true }, fetcher);
  const client = new SignedDeviceClient(task.workspace_id, id, privateKey, createSignedHttpTransport(origin, fetcher), now);
  const local = parseManualTarget({ origin, workspace_id: task.workspace_id, connector_device_id: id, binding_id: task.binding_id,
    account_id: task.account_id, platform_identity: task.platform_identity, session_id: 'fixture-browser', target: task.target });
  const replies = ['confirm', 'owned-profile', task.platform_identity, 'staged', 'owned-profile', task.platform_identity, 'submitted', JSON.stringify(receipt)];
  const io: ManualIO = {
    ask: async prompt => {
      if (prompt.includes('click Publish')) assert.equal(actions.filter(action => action === 'attempt.ready').length, 2);
      return replies.shift();
    },
    display: value => assert.deepEqual(value, { attempt_id: task.attempt_id, target: task.target, revision: task.payload.revision, mode: 'assist' }),
    verifyMedia: async media => media.sha256 === task.payload.revision.media[0].sha256,
  };
  const result = await runManualGatewayOnce(client, local, io, now);
  assert.equal(result.status, 'reported');
  if (result.status === 'reported') assert.deepEqual(result.result, { kind: 'accepted', submitted_by: 'human', ...receipt });
  assert.deepEqual(actions, ['heartbeat', 'claim', 'heartbeat', 'attempt.ready', 'heartbeat', 'attempt.ready', 'attempt.report']);
  assert.equal(replies.length, 0);
});

test('manual Android handoff reports a challenge and does not retry a lost report acknowledgement', async () => {
  const { task, claim, now } = scenario('tiktok');
  const hardware = 'fixture-owned-android';
  const local = parseManualTarget({ origin: 'https://gateway.example.invalid', workspace_id: task.workspace_id,
    connector_device_id: task.connector_device_id, binding_id: task.binding_id, account_id: task.account_id,
    platform_identity: task.platform_identity, session_id: 'fixture-app', target: task.target,
    android: { hardware_id_hash: createHash('sha256').update(hardware).digest('hex'), connection: 'usb' } });
  const replies = ['confirm', hardware, 'captcha'];
  let reports = 0;
  const result = await runManualGatewayOnce({ heartbeat: async () => {}, claim: async () => claim,
    ready: async () => assert.fail('challenge must stop before readiness'),
    report: async report => { reports++; assert.equal(report.kind, 'blocked'); throw new Error('acknowledgement lost'); },
  }, local, { ask: async () => replies.shift(), display: () => assert.fail(), verifyMedia: async () => assert.fail() }, now);
  assert.deepEqual(result, { status: 'reconcile', attempt_id: task.attempt_id,
    result: { kind: 'blocked', reason: 'captcha', handoff: 'awaiting_creator_action' } });
  assert.equal(reports, 1);
});

test('manual gateway rejects a claim for a different local binding', async () => {
  const { task, claim, now } = scenario();
  const local = parseManualTarget({ origin: 'https://gateway.example.invalid', workspace_id: task.workspace_id,
    connector_device_id: task.connector_device_id, binding_id: 'not-the-approved-binding', account_id: task.account_id,
    platform_identity: task.platform_identity, session_id: 'fixture-browser', target: task.target });
  const result = await runManualGatewayOnce({ heartbeat: async () => {}, claim: async () => claim,
    ready: async () => assert.fail('out-of-scope claim'), report: async report => {
      assert.equal(report.kind, 'blocked');
      assert.equal(report.fencing_token, claim.fencing_token);
      return { status: 'completed' };
    },
  }, local, { ask: async () => assert.fail(), display: () => assert.fail(), verifyMedia: async () => assert.fail() }, now);
  assert.deepEqual(result, { status: 'reported', attempt_id: task.attempt_id,
    result: { kind: 'blocked', reason: 'binding_invalid', handoff: 'manual' } });
});


test('live manual gateway blocks a phone swap between staging and the publish prompt', async () => {
  const entry = scenario('android');
  const hardware = 'fixture-hardware';
  const local = parseManualTarget({ origin: 'https://gateway.example.invalid', workspace_id: entry.task.workspace_id,
    connector_device_id: entry.task.connector_device_id, binding_id: entry.task.binding_id, account_id: entry.task.account_id,
    session_id: 'fixture-session', platform_identity: entry.task.platform_identity, target: entry.task.target,
    android: { hardware_id_hash: createHash('sha256').update(hardware).digest('hex'), connection: 'usb' } });
  const answers = ['confirm', hardware, entry.task.platform_identity, 'staged', 'fixture-switched-phone'];
  let readiness = 0;
  const result = await runManualGatewayOnce({
    heartbeat: async () => {}, claim: async () => entry.claim, ready: async () => { readiness++; },
    report: async () => ({ status: 'completed' }),
  }, local, {
    ask: async () => {
      assert.ok(answers.length, 'must not show the publish prompt after a phone swap');
      return answers.shift();
    },
    display: () => {}, verifyMedia: async () => true,
  }, entry.now);
  assert.equal(readiness, 1);
  assert.equal(answers.length, 0);
  assert.deepEqual(result, { status: 'reported', attempt_id: entry.task.attempt_id,
    result: { kind: 'blocked', reason: 'identity_mismatch', handoff: 'manual' } });
});


test('checks frozen media and TikTok draft again after asynchronous permit decisions', async () => {
  const media = scenario('browser');
  const mediaRun = media.run({ request: input => media.permits.request(input), consume: async input => {
    const decision = await media.permits.consume(input);
    media.driver.media.clear();
    return decision;
  } });
  assert.deepEqual(await mediaRun.advance(), { kind: 'blocked', reason: 'media_unverified', handoff: 'manual' });
  assert.equal(media.driver.submissions, 0);
  assert.equal(mediaRun.report()?.write_slot_token, media.claim.write_slot_token);

  const draft = scenario('tiktok');
  const draftRun = draft.run({ request: async input => {
    const decision = await draft.permits.request(input);
    draft.driver.registerDrafts(draft.task, ['fixture-replacement']);
    return decision;
  }, consume: async () => assert.fail('must not consume against a changed draft') });
  assert.deepEqual(await draftRun.advance(), { kind: 'blocked', reason: 'draft_ambiguous', handoff: 'awaiting_creator_action' });
  assert.equal(draft.driver.submissions, 0);
});

test('rejects malformed evidence after submit and a mismatched post during recovery', async () => {
  const entry = scenario();
  const capture = entry.driver.capture.bind(entry.driver);
  entry.driver.capture = (task, source) => {
    const result = capture(task, source);
    return result && { ...result, evidence: [...result.evidence, ...result.evidence] };
  };
  const original = entry.run();
  assert.deepEqual(await original.advance(), { kind: 'outcome_unknown', submitted_by: 'auto' });
  assert.equal(entry.driver.submissions, 1);
  entry.driver.capture = (task, source) => capture(task, source);
  const recovery = new ConnectorRun({ ...entry.claim, task: { ...entry.task, kind: 'post.capture_result', attempt_id: 'fixture-recovery',
    payload: { source_attempt_id: entry.task.attempt_id, platform_post_id: 'fixture-different-post' } } }, entry.driver, entry.permits, entry.now);
  assert.deepEqual(await recovery.advance(), { kind: 'blocked', reason: 'result_not_found', handoff: 'manual' });
  assert.equal(entry.driver.submissions, 1);
});

test('Android cannot alias one physical phone under multiple approved device IDs', async () => {
  const entry = scenario('android');
  entry.driver.localState.phones = [entry.phone, { ...entry.phone, id: 'fixture-phone-alias' }];
  assert.deepEqual(await entry.run().advance(), { kind: 'blocked', reason: 'binding_invalid', handoff: 'manual' });
  assert.equal(entry.permits.requestCount, 0);
  const emulator = 'emulator-5554';
  assert.equal(matchesAndroidHardware(emulator, createHash('sha256').update(emulator).digest('hex')), false);
});

test('manual visibility reports the original post without exposing a publish prompt', async () => {
  const entry = scenario();
  const { workspace_id, connector_device_id, account_id, binding_id, platform_identity, target } = entry.task;
  assert.equal(target.channel, 'browser');
  if (target.channel !== 'browser') return;
  const local = parseManualTarget({ origin: 'http://localhost', workspace_id, connector_device_id, account_id, binding_id, platform_identity,
    session_id: target.profile_id, target });
  const payload = { source_attempt_id: entry.task.attempt_id, platform_post_id: '123' };
  const claim = parseConnectorClaim({ ...entry.claim, task: { ...entry.task, attempt_id: 'fixture-visibility', kind: 'post.verify_visible', payload } });
  const replies = ['confirm', 'owned-profile', platform_identity, 'visible'];
  const result = await runManualGatewayOnce({ heartbeat: async () => {}, claim: async () => claim, ready: async () => {},
    report: async report => {
      assert.deepEqual(report, { kind: 'visibility_checked', visible: true, attempt_id: claim.task.attempt_id,
        fencing_token: claim.fencing_token, write_slot_token: claim.write_slot_token });
      return { status: 'completed' };
    } }, local, {
    ask: async prompt => { assert.doesNotMatch(prompt, /click Publish/); return replies.shift(); },
    display: value => assert.deepEqual(value, payload),
    verifyMedia: async () => assert.fail('verification has no media'),
  }, entry.now);
  assert.equal(result.status, 'reported');
  assert.deepEqual(replies, []);
});
