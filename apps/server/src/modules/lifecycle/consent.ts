import type { Context, Data, Row } from '@smartsell/contracts';
import { conflict, dto, flag, hash, instant, invalid, oneOf, optional, strings, text } from './dto.js';

export const channels = ['email','sms','whatsapp','push','site_tracking','platform_dm'] as const;
export const purposes = ['marketing','service'] as const;
const actions = ['opt_in','opt_out','double_opt_in_confirmed','withdrawn','imported_state'] as const;
const sources = ['lp_form','store','esp','import','support_request','unsubscribe_link'] as const;

function project(records: Row[], asOf: string) {
  let state = 'unknown';
  let last_record_id: string | undefined;
  let lastTime = '';
  let lastSource: unknown;
  let pendingUntil: string | undefined;
  const ordered = records.sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
  for (const record of ordered) {
    const at = String(record.captured_at);
    if (at > asOf) continue;
    const negative = record.action === 'opt_out' || record.action === 'withdrawn' ||
      (record.action === 'imported_state' && record.imported_state === 'opted_out');
    if (negative) {
      const contradictory = (state === 'opted_in' || state === 'conflict') && lastSource !== record.source &&
        ['store','esp'].includes(String(lastSource)) && ['store','esp'].includes(String(record.source));
      state = contradictory ? 'conflict' : 'opted_out';
    } else if ((state === 'opted_out' || state === 'conflict') && at === lastTime) {
      continue;
    } else if (record.action === 'opt_in') {
      state = record.requires_double_opt_in ? 'pending' : 'opted_in';
    } else if (record.action === 'double_opt_in_confirmed' && state === 'pending' && at < (pendingUntil ?? '')) {
      state = 'opted_in';
    } else {
      // Imported positive states are evidence only and cannot undo withdrawal.
      if ((state === 'opted_out' || state === 'conflict') && record.imported_state === 'opted_in' &&
          lastSource !== record.source && ['store','esp'].includes(String(lastSource)) && ['store','esp'].includes(String(record.source))) {
        state = 'conflict';
        last_record_id = record.id;
      }
      continue;
    }
    pendingUntil = state === 'pending' ? String(record.pending_until) : undefined;
    lastTime = at;
    lastSource = record.source;
    last_record_id = record.id;
  }
  if (state === 'pending' && (pendingUntil ?? '') <= asOf) state = 'unknown';
  return { state, last_record_id };
}

function customerFamilyIds(ctx: Context, customerId: string) {
  const customerIds = new Set([customerId]);
  const customers = ctx.list('customer');
  for (let size = 0; size !== customerIds.size;) {
    size = customerIds.size;
    for (const row of customers) {
      if (row.status === 'merged' && typeof row.merged_into_id === 'string' && customerIds.has(row.merged_into_id)) customerIds.add(row.id);
    }
  }
  return customerIds;
}

export function consentFor(ctx: Context, customerId: string, channel: unknown, purpose: unknown) {
  const customerIds = customerFamilyIds(ctx, customerId);
  return project(ctx.list('consent_record').filter(r => typeof r.customer_id === 'string' && customerIds.has(r.customer_id) &&
    r.channel === channel && r.purpose === purpose), new Date(ctx.now).toISOString());
}

export function mayContact(ctx: Context, customerId: string, channel: unknown, purpose: unknown) {
  const customers = ctx.list('customer');
  let customer = customers.find(row => row.id === customerId);
  const seen = new Set<string>();
  while (customer?.status === 'merged' && !seen.has(customer.id)) {
    seen.add(customer.id);
    const target = customer.merged_into_id;
    customer = customers.find(row => row.id === target);
  }
  if (customer?.status !== 'active') return false;
  const ids = customerFamilyIds(ctx, customer.id);
  if (ctx.list('suppression').some(row => row.channel === channel && ids.has(String(row.customer_id)) && row.active === true &&
    (!row.expires_at || Date.parse(String(row.expires_at)) > Date.parse(ctx.now)))) return false;
  return consentFor(ctx, customer.id, channel, purpose).state === 'opted_in';
}

export function createConsentText(ctx: Context, body: Data) {
  dto(body, ['channel','purpose','locale','text','effective_from']);
  const values = {
    channel: oneOf(body.channel, channels, 'channel'), purpose: oneOf(body.purpose, purposes, 'purpose'),
    locale: text(body.locale, 'locale'), text: text(body.text, 'text'),
    effective_from: instant(body.effective_from ?? ctx.now, 'effective_from'),
  };
  return ctx.create('consent_text_version', { ...values, content_hash: hash(values) });
}

export function appendConsent(ctx: Context, body: Data): Row {
  dto(body, ['customer_id','lead_id','identity_id','channel','purpose','action','source','source_ref','consent_text_version_id',
    'captured_at','evidence_ids','requires_double_opt_in','pending_until','imported_state']);
  const customer_id = optional(body.customer_id, 'customer_id');
  const lead_id = optional(body.lead_id, 'lead_id');
  if (!customer_id && !lead_id) invalid('A customer or lead is required');
  if (customer_id && ctx.get('customer', customer_id).status === 'erased') conflict('Customer has been erased');
  const identity_id = optional(body.identity_id, 'identity_id');
  if (identity_id && ctx.get('customer_identity', identity_id).customer_id !== customer_id) invalid('Identity belongs to another customer');
  const channel = oneOf(body.channel, channels, 'channel');
  const purpose = oneOf(body.purpose, purposes, 'purpose');
  const action = oneOf(body.action, actions, 'action');
  const source = oneOf(body.source, sources, 'source');
  const source_ref = text(body.source_ref, 'source_ref');
  const captured_at = instant(body.captured_at ?? ctx.now, 'captured_at');
  if (Date.parse(captured_at) > Date.parse(ctx.now)) invalid('Consent time is in the future');
  const evidence_ids = strings(body.evidence_ids, 'evidence_ids');
  if (source !== 'lp_form' && action !== 'imported_state' && !evidence_ids.length) invalid('Consent evidence is required');
  const consent_text_version_id = optional(body.consent_text_version_id, 'consent_text_version_id');
  if (action === 'opt_in' && purpose === 'marketing' && !consent_text_version_id) invalid('Marketing consent requires a text version');
  if (consent_text_version_id) {
    const version = ctx.get('consent_text_version', consent_text_version_id);
    if (version.channel !== channel || version.purpose !== purpose || Date.parse(String(version.effective_from)) > Date.parse(captured_at)) {
      invalid('Consent text is not effective for this channel and purpose');
    }
  }
  const requires_double_opt_in = flag(body.requires_double_opt_in, 'requires_double_opt_in');
  const pending_until = requires_double_opt_in ? instant(body.pending_until, 'pending_until') : undefined;
  if (pending_until && (action !== 'opt_in' || pending_until <= captured_at)) invalid('Invalid confirmation period');
  const imported_state = action === 'imported_state' ? oneOf(body.imported_state, ['opted_in','opted_out','unknown'], 'imported_state') : undefined;
  const directCustomer = customer_id ? ctx.get('customer', customer_id) : undefined;
  let affected = directCustomer;
  const seen = new Set<string>();
  while (affected?.status === 'merged' && typeof affected.merged_into_id === 'string' && !seen.has(affected.id)) {
    seen.add(affected.id);
    affected = ctx.get('customer', affected.merged_into_id);
  }
  const before = affected ? consentFor(ctx, affected.id, channel, purpose) : undefined;
  const record = ctx.create('consent_record', { customer_id, lead_id, identity_id, channel, purpose, action, source, source_ref,
    captured_at, evidence_ids, consent_text_version_id, requires_double_opt_in, pending_until, imported_state });
  const projected = affected ? refreshConsent(ctx, affected.id, channel, purpose) : undefined;
  if (!before || projected?.state !== before.state) {
    ctx.emit('lifecycle.consent.changed', {
      customer_id: affected?.id, lead_id, channel, purpose, record_id: record.id,
      state: projected?.state ?? (action === 'opt_in' ? 'opted_in' : 'unknown'),
    });
    if (projected?.state === 'conflict') ctx.emit('lifecycle.consent.conflict_detected', { customer_id: affected?.id, channel, purpose });
  }
  return record;
}

export function refreshConsent(ctx: Context, customerId: string, channel: unknown, purpose: unknown) {
  const projection = consentFor(ctx, customerId, channel, purpose);
  const current = ctx.list('consent_state').find(r => r.customer_id === customerId && r.channel === channel && r.purpose === purpose);
  const values = { customer_id: customerId, channel, purpose, ...projection };
  return current ? ctx.update('consent_state', current.id, values) : ctx.create('consent_state', values);
}

type LeadChoice = { channel: string; purpose: string; consent_text_version_id?: string };
export function recordLeadConsent(ctx: Context, input: LeadChoice & { lead_id?: string; customer_id?: string; source_ref: string }) {
  return appendConsent(ctx, { ...input, action: 'opt_in', source: 'lp_form' });
}

export function recordLeadConsents(ctx: Context, input: { leadId: string; formVersionId?: string; brandId?: string; choices: readonly LeadChoice[] }) {
  const leadId = text(input.leadId, 'leadId');
  const sourceRef = text(input.formVersionId ?? leadId, 'formVersionId');
  const brandId = optional(input.brandId, 'brandId');
  const existing = ctx.list('customer_identity').find(r => r.kind === 'lead' && r.namespace === 'traffic' && r.value_hash === hash(leadId));
  if (existing) conflict('Lead already has a lifecycle customer');
  const customer = ctx.create('customer', { status: 'active', lifecycle_stage: 'prospect', brand_id: brandId });
  const identity = ctx.create('customer_identity', { customer_id: customer.id, kind: 'lead', namespace: 'traffic', value_hash: hash(leadId), verified: false });
  ctx.emit('lifecycle.customer.created', { customer_id: customer.id });
  const seen = new Set<string>();
  const records = input.choices.map(choice => {
    dto(choice, ['channel','purpose','consent_text_version_id']);
    const key = `${choice.channel}:${choice.purpose}`;
    if (seen.has(key)) invalid('Duplicate lead consent choice');
    seen.add(key);
    return appendConsent(ctx, { ...choice, customer_id: customer.id, lead_id: leadId, identity_id: identity.id,
      source_ref: sourceRef, action: 'opt_in', source: 'lp_form' });
  });
  return { customer, records };
}
