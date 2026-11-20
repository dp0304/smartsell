import { createHash } from 'node:crypto';
import { ADMIN, APPROVE, Problem, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { appendConsent } from './consent.js';
import { saveSuppression, snapshotAudience } from './audience.js';
import { dto, instant, integer, oneOf, strings, text } from './dto.js';

export type EspTransport = (action: string, payload: Data) => Promise<unknown>;

export function loopbackEsp(origin: string, service: 'esp' | 'crm' | 'social' = 'esp'): EspTransport {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.origin !== origin || !url.port) {
    throw new Error('Local transport requires an explicit loopback HTTP origin');
  }
  return async (action, payload) => {
    const response = await fetch(new URL(`/${service}/${action}`, url), { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Local transport request failed');
    return response.json();
  };
}

const defaultTransport = () => process.env.SMARTSELL_LOCAL_ESP_ORIGIN ? loopbackEsp(process.env.SMARTSELL_LOCAL_ESP_ORIGIN) : undefined;
const digest = (address: string) => createHash('sha256').update(address).digest('hex');
const configFor = (ctx: Context, account: Row) => ctx.list('esp_local_config').find(row => row.esp_account_id === account.id && row.enabled === true);
const data = (value: unknown): Data => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ESP response');
  return value as Data;
};
function transportRequired(factory: () => EspTransport | undefined) {
  const transport = factory();
  if (!transport) throw new Problem(409, 'ESP_UNAVAILABLE', 'Local ESP transport has not been configured');
  return transport;
}

async function members(ctx: Context, version: Row, account: Row, transport: EspTransport) {
  const segment = ctx.get('segment', String(version.segment_id));
  if (segment.mode !== 'esp_native') return undefined;
  const response = data(await transport('members', { account: account.external_account_id, segment: segment.esp_segment_ref }));
  const refs = new Set(strings(response.profile_refs, 'profile_refs'));
  return [...new Set(ctx.list('customer_identity').filter(identity => identity.kind === 'esp_profile' && identity.verified === true &&
    identity.namespace === account.id && refs.has(String(identity.value_hash))).map(identity => String(identity.customer_id)))];
}

async function syncSuppressions(ctx: Context, account: Row, config: Row, transport: EspTransport) {
  const response = data(await transport('suppressions', { account: account.external_account_id }));
  if (!Array.isArray(response.events)) throw new Error('Invalid ESP suppression report');
  const allowed = new Set(strings(config.allowed_hashes, 'allowed_hashes'));
  const identities = ctx.list('customer_identity');
  for (const raw of response.events) {
    const event = data(raw);
    const hash = text(event.address_hash, 'address_hash');
    if (!allowed.has(hash)) continue;
    const sourceRef = `${account.id}:${text(event.id, 'id')}`;
    const kind = oneOf(event.kind, ['unsubscribe','bounce','complaint','provider_suppression'], 'kind');
    const at = instant(event.at, 'at');
    if (Date.parse(at) > Date.parse(ctx.now)) throw new Error('ESP event is in the future');
    const customerIds = new Set(identities.filter(identity => identity.kind === 'email' && identity.verified === true && identity.value_hash === hash)
      .map(identity => String(identity.customer_id)));
    for (const customerId of customerIds) {
      const customer = ctx.get('customer', customerId);
      if (customer.brand_id !== account.brand_id) continue;
      if (kind === 'unsubscribe') {
        if (!ctx.list('consent_record').some(record => record.source === 'esp' && record.source_ref === sourceRef && record.customer_id === customerId)) {
          appendConsent(ctx, { customer_id: customerId, channel: 'email', purpose: 'marketing', action: 'withdrawn',
            source: 'esp', source_ref: sourceRef, captured_at: at, evidence_ids: [sourceRef] });
        }
      } else {
        saveSuppression(ctx, { customer_id: customerId, channel: 'email', reason: kind, source: 'esp', source_ref: sourceRef });
      }
    }
  }
}

function recipients(ctx: Context, snapshot: Row, config: Row) {
  const whitelist = new Set(strings(config.address_allowlist, 'address_allowlist'));
  const approved = new Set(strings(ctx.list('segment_snapshot_members').find(row => row.snapshot_id === snapshot.id)?.member_ids, 'member_ids'));
  const byHash = new Map([...whitelist].map(address => [digest(address), address]));
  const all = new Map<string, Set<string>>();
  for (const identity of ctx.list('customer_identity')) {
    if (identity.kind !== 'email' || identity.verified !== true) continue;
    const address = byHash.get(String(identity.value_hash));
    if (!address) continue;
    const owners = all.get(address) ?? new Set<string>();
    owners.add(String(identity.customer_id));
    all.set(address, owners);
  }
  return [...all].flatMap(([address, owners]) => {
    const [customerId] = owners;
    return owners.size === 1 && customerId && approved.has(customerId) ? [{ address, customer_id: customerId }] : [];
  });
}

function applyReceipt(ctx: Context, campaign: Row, attempt: Row, raw: unknown) {
  const receipt = data(raw);
  const status = oneOf(receipt.status, ['not_found','failed','accepted','scheduled','sent','cancelled'], 'status');
  if (receipt.request_key !== attempt.request_key) throw new Error('ESP receipt does not match the request');
  if (status === 'not_found') return attempt;
  if (attempt.status === 'sent' && status !== 'sent') throw new Error('ESP receipt regressed');
  const receiptRef = text(receipt.receipt_ref, 'receipt_ref');
  if ((status === 'failed' && ['accepted','scheduled'].includes(String(attempt.status))) ||
      (status === 'accepted' && attempt.status === 'scheduled')) throw new Error('ESP receipt regressed');
  if (status === 'cancelled') {
    if (attempt.action !== 'schedule' || !attempt.cancel_requested_at) throw new Error('Unrequested ESP cancellation');
    ctx.update('esp_campaign_ref', campaign.id, { status: 'cancelled' });
  }
  if (status === 'sent') {
    if (!Array.isArray(receipt.customer_ids)) throw new Error('Send report must include the actual members');
    const actual = strings(receipt.customer_ids, 'customer_ids').sort();
    const expected = new Set(strings(attempt.customer_ids, 'customer_ids'));
    const sentAt = instant(receipt.sent_at, 'sent_at');
    if (new Set(actual).size !== actual.length || actual.some(id => !expected.has(id)) || Date.parse(sentAt) > Date.parse(ctx.now)) {
      throw new Error('Invalid ESP send report');
    }
    const delivered = receipt.delivered_count === undefined ? undefined : integer(receipt.delivered_count, 'delivered_count');
    if (delivered !== undefined && (delivered > actual.length || delivered < Number(attempt.delivered_count ?? 0))) throw new Error('Invalid ESP delivery count');
    if (attempt.send_snapshot_id) {
      const snapshot = ctx.get('segment_snapshot', String(attempt.send_snapshot_id));
      const original = ctx.list('segment_snapshot_members').find(row => row.snapshot_id === snapshot.id);
      if (snapshot.taken_at !== sentAt || JSON.stringify(original?.member_ids) !== JSON.stringify(actual)) throw new Error('ESP send report changed');
      return delivered === undefined || delivered === attempt.delivered_count ? attempt : ctx.update('esp_attempt', attempt.id, {
        delivered_count: delivered, delivery_receipt_ref: receiptRef, delivery_observed_at: ctx.now,
      });
    }
    const snapshot = ctx.create('segment_snapshot', { purpose: 'send_execution', segment_version_id: campaign.segment_version_id,
      esp_campaign_ref_id: campaign.id, esp_account_id: campaign.esp_account_id, action: attempt.action, taken_at: sentAt,
      source: 'local_esp_report', source_ref: receiptRef, audience_coverage: 'reported_esp_members', esp_count: actual.length });
    ctx.create('segment_snapshot_members', { snapshot_id: snapshot.id, member_ids: actual });
    if (attempt.action === 'schedule') ctx.update('esp_campaign_ref', campaign.id, { status: 'sent', send_snapshot_id: snapshot.id });
    return ctx.update('esp_attempt', attempt.id, { status, receipt_ref: receiptRef, send_snapshot_id: snapshot.id, reconciled_at: ctx.now,
      ...(delivered !== undefined && { delivered_count: delivered, delivery_receipt_ref: receiptRef, delivery_observed_at: ctx.now }) });
  }
  if (attempt.action === 'schedule' && status === 'scheduled' && campaign.status !== 'scheduled') {
    ctx.update('esp_campaign_ref', campaign.id, { status: 'scheduled' });
  }
  return ctx.update('esp_attempt', attempt.id, { status, receipt_ref: receiptRef, reconciled_at: ctx.now });
}

export function localEspOperations(factory: () => EspTransport | undefined = defaultTransport): Operation[] {
  return [
    { method: 'PUT', path: '/esp-accounts/:id/local-config', name: 'lifecycle_set_local_esp', roles: ADMIN, versionKind: 'esp_account',
      summary: 'Authorize the local email ESP with an explicit test-address allowlist', run(ctx, { params, body }) {
        dto(body, ['enable','address_allowlist']);
        const account = ctx.get('esp_account', String(params.id));
        if (account.channel !== 'email' || typeof body.enable !== 'boolean') throw new Problem(422, 'INVALID_INPUT', 'Expected an email ESP and an explicit enable flag');
        const addresses = [...new Set(strings(body.address_allowlist, 'address_allowlist').map(address => address.toLowerCase()))];
        if ((body.enable && !addresses.length) || addresses.length > 100 || addresses.some(address => !/^[a-z0-9._+%-]+@[a-z0-9.-]+\.test$/i.test(address))) {
          throw new Problem(422, 'INVALID_INPUT', 'Provide up to 100 explicit .test email addresses');
        }
        if (body.enable) transportRequired(factory);
        const previous = ctx.list('esp_local_config').find(row => row.esp_account_id === account.id);
        const values = { esp_account_id: account.id, enabled: body.enable, address_allowlist: addresses, allowed_hashes: addresses.map(digest), authorized_by: ctx.actorId };
        if (previous) ctx.update('esp_local_config', previous.id, values);
        else ctx.create('esp_local_config', values);
        return ctx.update('esp_account', account.id, { local_enabled: body.enable, allowlisted_count: addresses.length });
      } },
    { method: 'POST', path: '/esp-accounts/:id/sync-suppressions', name: 'lifecycle_sync_local_esp_suppressions', roles: ADMIN,
      summary: 'Read opt-outs and suppressions from the authorized local ESP', async run(ctx, { params }) {
        const account = ctx.get('esp_account', String(params.id));
        const config = configFor(ctx, account);
        if (!config) throw new Problem(409, 'ESP_UNAVAILABLE', 'Local ESP is disabled');
        await syncSuppressions(ctx, account, config, transportRequired(factory));
        return ctx.update('esp_account', account.id, { suppressions_synced_at: ctx.now });
      } },
    { method: 'POST', path: '/esp-campaigns/:id/local-submit', name: 'lifecycle_submit_local_esp', roles: APPROVE,
      external: true, versionKind: 'esp_campaign_ref', summary: 'Submit a consent-checked campaign to the authorized local ESP', async run(ctx, input) {
        dto(input.body, ['action','test_address']);
        const action = oneOf(input.body.action, ['test_send','schedule'], 'action');
        const campaign = ctx.get('esp_campaign_ref', String(input.params.id));
        const account = ctx.get('esp_account', String(campaign.esp_account_id));
        const config = configFor(ctx, account);
        const transport = transportRequired(factory);
        if (!config) throw new Problem(409, 'ESP_UNAVAILABLE', 'Local ESP is disabled');
        if (campaign.status !== 'draft') throw new Problem(409, 'STATE_CONFLICT', 'Only draft campaigns can be submitted');
        const attempts = ctx.list('esp_attempt').filter(row => row.esp_campaign_ref_id === campaign.id && row.action === action);
        if (attempts.some(row => row.status !== 'failed')) throw new Problem(409, 'STATE_CONFLICT', 'Read back the existing attempt before retrying');
        await syncSuppressions(ctx, account, config, transport);
        const version = ctx.get('segment_version', String(campaign.segment_version_id));
        const snapshot = snapshotAudience(ctx, version.id, 'schedule_estimate', undefined, await members(ctx, version, account, transport), {
          esp_campaign_ref_id: campaign.id, esp_account_id: account.id, action,
        });
        const targets = recipients(ctx, snapshot, config).filter(row => action !== 'test_send' || row.address === input.body.test_address);
        if (!targets.length) return { status: 'blocked', reason: 'no_eligible_allowlisted_addresses', snapshot_id: snapshot.id };
        const requestKey = `${ctx.workspaceId}:${campaign.id}:${action}:${attempts.length + 1}`;
        const attempt = ctx.create('esp_attempt', { esp_campaign_ref_id: campaign.id, action, request_key: requestKey,
          customer_ids: [...new Set(targets.map(target => target.customer_id))], estimate_snapshot_id: snapshot.id, status: 'unknown' });
        try {
          await transport('submit', { account: account.external_account_id, action, request_key: requestKey,
            recipients: targets, template_ref: campaign.template_ref, planned_send_at: campaign.planned_send_at });
        } catch {
          // A timeout can follow acceptance. Resolve it through independent readback.
        }
        const { customer_ids: _, ...view } = attempt;
        return view;
      } },
    { method: 'POST', path: '/esp-campaigns/:id/local-cancel', name: 'lifecycle_cancel_local_esp', roles: APPROVE,
      external: true, versionKind: 'esp_campaign_ref', summary: 'Request schedule cancellation and await an independent ESP receipt', async run(ctx, { params, body }) {
        dto(body, ['attempt_id']);
        const campaign = ctx.get('esp_campaign_ref', String(params.id));
        const attempt = ctx.get('esp_attempt', text(body.attempt_id, 'attempt_id'));
        if (attempt.esp_campaign_ref_id !== campaign.id || attempt.action !== 'schedule') throw new Problem(404, 'NOT_FOUND', 'Schedule attempt does not belong to this campaign');
        if (!['accepted','scheduled'].includes(String(attempt.status)) || attempt.cancel_requested_at) {
          throw new Problem(409, 'STATE_CONFLICT', 'A confirmed schedule is required. Read back any prior cancellation request.');
        }
        const account = ctx.get('esp_account', String(campaign.esp_account_id));
        if (!configFor(ctx, account)) throw new Problem(409, 'ESP_UNAVAILABLE', 'Local ESP is disabled');
        const transport = transportRequired(factory);
        const updated = ctx.update('esp_attempt', attempt.id, { cancel_requested_at: ctx.now });
        try {
          await transport('cancel', { account: account.external_account_id, request_key: attempt.request_key });
        } catch {
          // Keep the cancellation pending until the provider confirms its outcome.
        }
        const { customer_ids: _, ...view } = updated;
        return view;
      } },
    { method: 'POST', path: '/esp-campaigns/:id/local-reconcile', name: 'lifecycle_reconcile_local_esp', roles: APPROVE,
      summary: 'Read an independent ESP receipt and save actual delivery members', async run(ctx, { params, body }) {
        dto(body, ['attempt_id']);
        const campaign = ctx.get('esp_campaign_ref', String(params.id));
        const attempt = ctx.get('esp_attempt', text(body.attempt_id, 'attempt_id'));
        if (attempt.esp_campaign_ref_id !== campaign.id) throw new Problem(404, 'NOT_FOUND', 'Attempt does not belong to this campaign');
        const view = ({ customer_ids: _, ...row }: Row) => row;
        if (attempt.status === 'failed' || attempt.status === 'cancelled') return view(attempt);
        const account = ctx.get('esp_account', String(campaign.esp_account_id));
        if (!configFor(ctx, account)) throw new Problem(409, 'ESP_UNAVAILABLE', 'Local ESP is disabled');
        const transport = transportRequired(factory);
        try {
          const receipt = await transport('receipt', { account: account.external_account_id, request_key: attempt.request_key });
          const reconciled = applyReceipt(ctx, campaign, attempt, receipt);
          return view(reconciled.last_readback_failed_at != null
            ? ctx.update('esp_attempt', reconciled.id, { last_readback_failed_at: null })
            : reconciled);
        } catch {
          return view(ctx.update('esp_attempt', attempt.id, { last_readback_failed_at: ctx.now }));
        }
      } },
    { method: 'GET', path: '/esp-campaigns/:id/attempts', name: 'lifecycle_list_esp_attempts', roles: APPROVE,
      summary: 'Read the ESP submission and receipt history', run(ctx, { params }) {
        const campaign = ctx.get('esp_campaign_ref', String(params.id));
        return ctx.list('esp_attempt').filter(row => row.esp_campaign_ref_id === campaign.id).map(({ customer_ids: _, ...row }) => row);
      } },
    { method: 'POST', path: '/esp-flows/:id/local-readback', name: 'lifecycle_read_local_esp_flow', roles: APPROVE,
      summary: 'Read provider flow state independently of the campaign lifecycle', async run(ctx, { params, body }) {
        dto(body, ['flow_ref']);
        const flow = ctx.get('esp_flow_ref', String(params.id));
        const account = ctx.get('esp_account', String(flow.esp_account_id));
        if (!configFor(ctx, account)) throw new Problem(409, 'ESP_UNAVAILABLE', 'Local ESP is disabled');
        const flowRef = text(flow.external_flow_id ?? body.flow_ref, 'flow_ref');
        const response = data(await transportRequired(factory)('flow', { account: account.external_account_id, flow_ref: flowRef }));
        if (response.flow_ref !== flowRef) throw new Problem(409, 'STATE_CONFLICT', 'ESP returned a different flow');
        return ctx.update('esp_flow_ref', flow.id, { external_flow_id: flowRef,
          provider_status: oneOf(response.status, ['draft','live','paused','archived'], 'status'), provider_observed_at: ctx.now });
      } },
  ];
}

export function previewLocalEsp(ctx: Context, version: Row, factory = defaultTransport) {
  const segment = ctx.get('segment', String(version.segment_id));
  if (segment.mode !== 'esp_native') return undefined;
  const account = ctx.list('esp_account').find(row => row.channel === 'email' && row.brand_id === segment.brand_id && row.is_sending_system_of_record === true && configFor(ctx, row));
  if (!account) return undefined;
  const transport = transportRequired(factory);
  return syncSuppressions(ctx, account, configFor(ctx, account)!, transport).then(() => members(ctx, version, account, transport));
}
