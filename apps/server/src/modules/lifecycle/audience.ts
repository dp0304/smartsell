import type { Context, Data } from '@smartsell/contracts';
import { channels, consentFor, purposes } from './consent.js';
import { dto, hash, instant, integer, invalid, oneOf, strings } from './dto.js';

export function segmentDefinition(body: Data) {
  const definition = dto(body.definition ?? {}, ['market_ids','locales','product_ids','interacted_since','esp_member_ids']);
  const required = dto(body.required_consent, ['channel','purpose']);
  return {
    definition: {
      market_ids: strings(definition.market_ids, 'market_ids'), locales: strings(definition.locales, 'locales'),
      product_ids: strings(definition.product_ids, 'product_ids'),
      interacted_since: definition.interacted_since === undefined ? undefined : instant(definition.interacted_since, 'interacted_since'),
      esp_member_ids: definition.esp_member_ids === undefined ? undefined : strings(definition.esp_member_ids, 'esp_member_ids'),
    },
    required_consent: { channel: oneOf(required.channel, channels, 'channel'), purpose: oneOf(required.purpose, purposes, 'purpose') },
  };
}

export function saveSegmentVersion(ctx: Context, segmentId: string, body: Data) {
  const segment = ctx.get('segment', segmentId);
  const config = segmentDefinition(body);
  if (config.definition.esp_member_ids !== undefined && segment.mode !== 'esp_native') invalid('ESP members require an ESP-native segment');
  const previous = ctx.list('segment_version').filter(r => r.segment_id === segment.id);
  const version = ctx.create('segment_version', { segment_id: segmentId, version_no: previous.length + 1,
    ...config, content_hash: hash(config) });
  ctx.update('segment', segmentId, { current_version_id: version.id });
  ctx.emit('lifecycle.segment.version_created', { segment_id: segmentId, segment_version_id: version.id });
  return version;
}

export function saveSuppression(ctx: Context, body: Data) {
  dto(body, ['customer_id','channel','reason','source','source_ref','active','expires_at']);
  const customer = ctx.get('customer', String(body.customer_id ?? ''));
  const channel = oneOf(body.channel, channels, 'channel');
  const reason = oneOf(body.reason, ['bounce','complaint','provider_suppression','manual'], 'reason');
  const source = oneOf(body.source, ['esp','manual'], 'source');
  const source_ref = strings([body.source_ref], 'source_ref')[0];
  const active = body.active === undefined ? true : body.active;
  if (typeof active !== 'boolean') invalid('Invalid active flag');
  const expires_at = body.expires_at === undefined ? undefined : instant(body.expires_at, 'expires_at');
  const existing = ctx.list('suppression').find(r => r.customer_id === customer.id && r.channel === channel &&
    r.reason === reason && r.source === source && r.source_ref === source_ref);
  const values = { customer_id: customer.id, channel, reason, source, source_ref, active, expires_at };
  return existing ? ctx.update('suppression', existing.id, values) : ctx.create('suppression', values);
}

type SnapshotPurpose = 'preview' | 'schedule_estimate' | 'send_execution';
export function snapshotAudience(ctx: Context, versionId: string, purpose: SnapshotPurpose, espCount?: number, providerMembers?: string[],
  submission?: { esp_campaign_ref_id: string; esp_account_id: string; action: 'test_send' | 'schedule' }) {
  const version = ctx.get('segment_version', versionId);
  const segment = ctx.get('segment', String(version.segment_id));
  const config = segmentDefinition({ definition: version.definition, required_consent: version.required_consent });
  const query = config.definition;
  const { channel, purpose: consentPurpose } = config.required_consent;
  const customers = ctx.list('customer');
  const suppressions = ctx.list('suppression');
  const rules = ctx.list('frequency_rule').filter(r => r.channel === channel && r.applies_to !== 'flow');
  const sends = ctx.list('contact_send_observation');
  const excluded: Record<string, number> = {};
  const members: string[] = [];
  for (const customer of customers) {
    if (customer.status !== 'active' || (segment.brand_id && segment.brand_id !== customer.brand_id)) continue;
    const ids = new Set([customer.id]);
    for (let size = 0; size !== ids.size;) {
      size = ids.size;
      for (const row of customers) if (row.status === 'merged' && ids.has(String(row.merged_into_id))) ids.add(row.id);
    }
    const products = Array.isArray(customer.purchased_product_ids) ? customer.purchased_product_ids : [];
    if ((query.market_ids.length && !query.market_ids.includes(String(customer.market_id))) ||
        (query.locales.length && !query.locales.includes(String(customer.primary_locale))) ||
        (query.product_ids.length && !query.product_ids.some(id => products.includes(id))) ||
        (query.interacted_since && !(Date.parse(String(customer.last_interaction_at)) >= Date.parse(query.interacted_since))) ||
        (segment.mode === 'esp_native' && !(providerMembers ?? query.esp_member_ids)?.some(id => ids.has(id)))) continue;
    const { state } = consentFor(ctx, customer.id, channel, consentPurpose);
    const now = Date.parse(ctx.now);
    const suppressed = suppressions.some(r => ids.has(String(r.customer_id)) && r.channel === channel && r.active &&
      (!r.expires_at || Date.parse(String(r.expires_at)) > now));
    const frequency = consentPurpose === 'marketing' && rules.some(rule =>
      (rule.scope === 'workspace' || rule.brand_id === customer.brand_id) && sends.filter(send => {
        const at = Date.parse(String(send.sent_at));
        return ids.has(String(send.customer_id)) && send.channel === channel &&
          (rule.scope === 'workspace' || send.brand_id === rule.brand_id) && at <= now && at > now - Number(rule.window_hours) * 3_600_000;
      }).length >= Number(rule.max_per_window));
    const reason = state === 'opted_out' ? 'opted_out' : state === 'conflict' ? 'consent_conflict'
      : suppressed ? 'suppressed' : state !== 'opted_in' ? 'no_consent' : frequency ? 'frequency' : undefined;
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    else members.push(customer.id);
  }
  const snapshot = ctx.create('segment_snapshot', { ...submission, segment_version_id: version.id, purpose, taken_at: ctx.now,
    eligible_count: members.length, excluded, member_hash: hash(members.sort()),
    esp_count: espCount === undefined ? undefined : integer(espCount, 'esp_count'),
    frequency_coverage: 'observed_esp_sends_only',
    audience_coverage: segment.mode === 'esp_native' ? (providerMembers ? 'local_esp_readback' : query.esp_member_ids ? 'imported_esp_members' : 'unavailable') : 'local_profiles',
  });
  if (providerMembers || purpose === 'schedule_estimate') ctx.create('segment_snapshot_members', { snapshot_id: snapshot.id, member_ids: members });
  return snapshot;
}
