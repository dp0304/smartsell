import { loopbackEsp } from '../lifecycle/local-esp.js';
import { queueManualExternalWork } from '../../integration/manual-external-work.js';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { APPROVE, WRITE, Problem, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { mayContact, recordLeadConsents } from '../lifecycle/consent.js';
import { channels, consentText, conflict, invalid, items, missing, object, oneOf, optional, slug, text, time } from './operation-policy.js';
import { hash } from './pages.js';

const leadRoles = ['owner','admin','manager','editor'] as const;
const piiRoles = ['owner','admin','manager'] as const;
const fieldKeys = ['name','email','phone','message'] as const;
const channelKeys = { email: 'email', sms: 'phone', whatsapp: 'phone' } as const;
const leadTransitions: Record<string, readonly string[]> = {
  new: ['closed'], contact_not_permitted: ['closed'], contact_permitted: ['contacted','closed'],
  contacted: ['qualified','closed'], qualified: ['closed'], handed_off: ['converted','closed'], converted: ['closed'], closed: [],
};
function formVersion(ctx: Context, form: Row, body: Data) {
  const fields = items(body.fields, 10).map(raw => {
    const row = object(raw);
    return { key: oneOf(row.key, fieldKeys, 'field'), label: text(row.label, 'field label'), required: row.required === true };
  });
  if (!fields.length || new Set(fields.map(row => row.key)).size !== fields.length) invalid('Select unique form fields');
  const service_contact_only = body.service_contact_only === true;
  const channel_options = items(body.channel_options ?? [], 10).map(raw => {
    const row = object(raw);
    const channel = oneOf(row.channel, channels, 'channel');
    if (channel !== 'email' && channel !== 'sms' && channel !== 'whatsapp') invalid('Anonymous forms support email and phone contact only');
    if (!fields.some(field => field.key === channelKeys[channel])) invalid('Consent option requires a matching contact field');
    const purpose = oneOf(row.purpose ?? (service_contact_only ? 'service' : 'marketing'), ['service','marketing'], 'purpose');
    if (service_contact_only && purpose !== 'service') invalid('Service-only forms cannot request marketing consent');
    const id = text(row.consent_text_version_id, 'consent_text_version_id');
    consentText(ctx, id, channel, purpose);
    return { channel, purpose, consent_text_version_id: id };
  });
  if (new Set(channel_options.map(row => `${row.channel}:${row.purpose}`)).size !== channel_options.length) invalid('Duplicate consent option');
  const content = { title: text(body.title, 'title'), fields, channel_options, service_contact_only };
  return ctx.create('form_version', { ...content, form_id: form.id, content_hash: hash(content), version_no: ctx.list('form_version').filter(row => row.form_id === form.id).length + 1 });
}
export function activeForm(ctx: Context, id: string) {
  const form = ctx.list('form').find(row => row.id === id && row.status === 'active' && typeof row.active_version_id === 'string');
  if (!form) return missing();
  const row = ctx.get('form_version', String(form.active_version_id));
  if (row.form_id !== form.id) return missing();
  const fields = items(row.fields).map(value => {
    const item = object(value);
    const key = oneOf(item.key, fieldKeys, 'field');
    return { key, label: String(item.label), required: item.required === true };
  });
  const choices = items(row.channel_options).map(value => {
    const item = object(value);
    const channel = oneOf(item.channel, ['email','sms','whatsapp'], 'channel');
    const purpose = oneOf(item.purpose, ['service','marketing'], 'purpose');
    const id = text(item.consent_text_version_id, 'consent_text_version_id');
    const label = text(consentText(ctx, id, channel, purpose).text, 'consent text', 8000);
    return { channel, purpose, consent_text_version_id: id, key: `${channel}:${purpose}`, label };
  });
  return { form, row, fields, choices };
}
function secret(value: Uint8Array) {
  if (value.byteLength !== 32) throw new Error('Traffic PII key must contain 32 bytes');
  return value;
}
function encrypt(ctx: Context, leadId: string, value: Data, sourceKey: Uint8Array) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(sourceKey), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([ctx.workspaceId, leadId])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}
export function decryptLeadContact(ctx: Context, id: string, sourceKey: Uint8Array): Data {
  if (!piiRoles.some(role => role === ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Lead PII access denied');
  const row = ctx.get('lead', id);
  const value = object(row.contact_encrypted);
  if (value.version !== 1) invalid('Unsupported lead encryption version');
  const decipher = createDecipheriv('aes-256-gcm', secret(sourceKey), Buffer.from(String(value.iv), 'base64url'));
  decipher.setAAD(Buffer.from(JSON.stringify([ctx.workspaceId, id])));
  decipher.setAuthTag(Buffer.from(String(value.tag), 'base64url'));
  const contact = object(JSON.parse(Buffer.concat([decipher.update(Buffer.from(String(value.ciphertext), 'base64url')), decipher.final()]).toString('utf8')));
  ctx.emit('traffic.lead.pii_accessed', { lead_id: id, actor_id: ctx.actorId });
  return contact;
}
export function acceptLead(ctx: Context, active: ReturnType<typeof activeForm>, input: Data, sourceKey: Uint8Array, pageVersion: Row, tracking?: { sessionRef: string; shortLinkId?: string | undefined }) {
  if (input.form_version_id !== active.row.id) conflict('Form version changed. Reload the page before submitting.');
  const values = object(input.fields);
  const contact: Data = {};
  for (const field of active.fields) {
    const raw = values[field.key];
    if (raw == null || raw === '') {
      if (field.required) invalid(`Complete the ${field.label} field`);
      continue;
    }
    let value = text(raw, field.key, field.key === 'message' ? 4000 : 254);
    if (field.key === 'email') {
      value = value.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid('Invalid email address');
    }
    if (field.key === 'phone') {
      value = value.replace(/[\s().-]/g, '');
      if (!/^\+[1-9]\d{6,14}$/.test(value)) invalid('Use an international phone number with the country code');
    }
    contact[field.key] = value;
  }
  if (!Object.keys(contact).length) invalid('Enter at least one value');
  const choiceKeys = items(input.consents ?? [], 10);
  if (new Set(choiceKeys).size !== choiceKeys.length || choiceKeys.some(key => !active.choices.some(option => option.key === key))) invalid('Invalid consent selection');
  const choices = active.choices.filter(choice => choiceKeys.includes(choice.key));
  for (const choice of choices) if (!contact[channelKeys[choice.channel]]) invalid('Provide the contact address for the selected channel');
  const dedupe_key = createHmac('sha256', secret(sourceKey)).update(JSON.stringify(['lead', ctx.workspaceId, active.row.id, contact, choiceKeys.slice().sort()])).digest('hex');
  const prior = ctx.list('lead').find(row => row.dedupe_key === dedupe_key && Date.parse(ctx.now) - Date.parse(row.created_at) < 86_400_000);
  if (prior) return { accepted: true };
  const status = choices.length ? 'contact_permitted' : 'contact_not_permitted';
  const lead = ctx.create('lead', { form_version_id: active.row.id, source_page_version_id: pageVersion.id, brand_id: active.form.brand_id, status, dedupe_key });
  const { customer, records } = recordLeadConsents(ctx, { leadId: lead.id, formVersionId: active.row.id, brandId: String(active.form.brand_id),
    choices: choices.map(({ channel, purpose, consent_text_version_id }) => ({ channel, purpose, consent_text_version_id })) });
  ctx.update('lead', lead.id, { contact_encrypted: encrypt(ctx, lead.id, contact, sourceKey), customer_id: customer.id, channel_consents: records.map(row => row.id) });
  const receipt = { lead_id: lead.id, form_version_id: active.row.id, source_page_version_id: pageVersion.id };
  ctx.emit('traffic.form.submitted', receipt);
  ctx.emit('traffic.lead.created', { ...receipt, status });
  if (tracking) ctx.create('touchpoint_event', { event_id: `form_submit_${lead.id}`, event_type: 'form_submit',
    landing_page_version_id: pageVersion.id, short_link_id: tracking.shortLinkId ?? null, session_ref: tracking.sessionRef,
    consent_state: 'opted_in', occurred_at: ctx.now });
  return { accepted: true };
}
function contactPermitted(ctx: Context, row: Row, channel?: string, purpose?: string): boolean {
  if (typeof row.customer_id !== 'string') return false;
  const consentIds = items(row.channel_consents ?? []);
  return ctx.list('consent_record').some(record => consentIds.includes(record.id) &&
    (!channel || record.channel === channel) && (!purpose || record.purpose === purpose) &&
    mayContact(ctx, String(row.customer_id), record.channel, record.purpose));
}

/** Apply a verified connector receipt in the same workspace transaction. */
export function recordLeadHandoffReceipt(ctx: Context, input: { requestId: string; externalRef?: string; outcome: 'confirmed' | 'failed' | 'unknown' }) {
  const request = ctx.get('lead_handoff', input.requestId);
  const lead = ctx.get('lead', String(request.lead_id));
  if (lead.handoff_id !== request.id || lead.status !== 'qualified') conflict('Handoff is no longer current');
  if (request.status !== 'pending' && request.status !== 'unknown') conflict('Handoff already has a final receipt');
  const outcome = oneOf(input.outcome, ['confirmed','failed','unknown'], 'handoff outcome');
  if (outcome === 'confirmed') {
    const external_crm_ref = text(input.externalRef, 'external CRM reference');
    ctx.update('lead_handoff', request.id, { status: outcome, external_crm_ref, received_at: ctx.now });
    ctx.create('lead_activity', { lead_id: lead.id, type: 'handed_off', at: ctx.now, handoff_id: request.id });
    ctx.emit('traffic.lead.handed_off', { lead_id: lead.id, handoff_id: request.id });
    return leadView(ctx, ctx.update('lead', lead.id, { status: 'handed_off', handoff_status: outcome, external_crm_ref }));
  }
  ctx.update('lead_handoff', request.id, { status: outcome, received_at: ctx.now });
  return leadView(ctx, ctx.update('lead', lead.id, { handoff_status: outcome }));
}
function leadView(ctx: Context, row: Row) {
  const status = row.status === 'contact_permitted' && !contactPermitted(ctx, row) ? 'contact_not_permitted' : row.status;
  const serviceContactChannels = ['email', 'sms', 'whatsapp'].filter(channel => contactPermitted(ctx, row, channel, 'service'));
  return { id: row.id, version: row.version, status, contact: 'masked', contact_permitted: contactPermitted(ctx, row),
    service_contact_channels: serviceContactChannels, handoff_status: row.handoff_status ?? null,
    local_crm_dispatched_at: row.local_crm_dispatched_at ?? null,
    local_crm_receipt_available: Boolean(process.env.SMARTSELL_LOCAL_CRM_ORIGIN && row.handoff_id && ctx.list('lead_handoff').some(request => request.id === row.handoff_id && request.destination === 'local-mock')),
    ...(piiRoles.some(role => role === ctx.role) && row.handoff_id ? { handoff_id: row.handoff_id } : {}),
    form_version_id: row.form_version_id, source_page_version_id: row.source_page_version_id, brand_id: row.brand_id,
    assignee_user_id: row.assignee_user_id, next_follow_up_at: row.next_follow_up_at, created_at: row.created_at };
}
export const formOperations: Operation[] = [
  { method: 'GET', path: '/forms', name: 'forms_list', roles: leadRoles, summary: 'List forms', run: ctx => ctx.list('form') },
  { method: 'POST', path: '/forms', name: 'forms_create', roles: WRITE, summary: 'Create a form draft', run(ctx, { body }) {
    const key = slug(body.slug);
    if (ctx.list('form').some(row => row.slug === key)) conflict('Form identifier is already in use');
    return ctx.create('form', { slug: key, brand_id: text(body.brand_id, 'brand_id'), name: text(body.name, 'name'), status: 'draft' });
  } },
  { method: 'GET', path: '/forms/:id/versions', name: 'forms_versions', roles: leadRoles, summary: 'List historical form versions', run: (ctx, { params }) => ctx.list('form_version').filter(row => row.form_id === params.id) },
  { method: 'POST', path: '/forms/:id/versions', name: 'forms_create_version', roles: WRITE, versionKind: 'form', summary: 'Append an immutable form version', run(ctx, { params, body }) {
    const form = ctx.get('form', params.id!);
    const version = formVersion(ctx, form, body);
    ctx.update('form', form.id, { latest_version_id: version.id });
    return version;
  } },
  { method: 'POST', path: '/forms/:id/activate', name: 'forms_activate', roles: APPROVE, versionKind: 'form', summary: 'Activate a form version', run(ctx, { params, body }) {
    const form = ctx.get('form', params.id!);
    const row = ctx.get('form_version', text(body.version_id, 'version_id'));
    if (row.form_id !== form.id) missing();
    for (const value of items(row.channel_options)) {
      const option = object(value);
      consentText(ctx, String(option.consent_text_version_id), String(option.channel), String(option.purpose));
    }
    return ctx.update('form', form.id, { status: 'active', active_version_id: row.id });
  } },
  { method: 'POST', path: '/forms/:id/deactivate', name: 'forms_deactivate', roles: APPROVE, versionKind: 'form', summary: 'Stop accepting form submissions', run: (ctx, { params }) => ctx.update('form', params.id!, { status: 'inactive', active_version_id: null }) },
  { method: 'GET', path: '/leads', name: 'leads_list', roles: leadRoles, summary: 'List masked leads', run: (ctx, { query }) => ctx.list('lead').map(row => leadView(ctx, row)).filter(row => (!query.status || row.status === query.status) && (!query.assignee_user_id || row.assignee_user_id === query.assignee_user_id)) },
  { method: 'GET', path: '/leads/:id', name: 'leads_get', roles: leadRoles, summary: 'Read a masked lead and its follow-up history', run(ctx, { params }) {
    const lead = leadView(ctx, ctx.get('lead', params.id!));
    return { ...lead, activities: ctx.list('lead_activity').filter(row => row.lead_id === lead.id),
      ...(piiRoles.some(role => role === ctx.role) && { handoff_receipts: ctx.list('lead_handoff')
        .filter(row => row.lead_id === lead.id && row.verified_by && row.evidence_ref)
        .map(row => ({ id: row.id, outcome: row.status, evidence_ref: row.evidence_ref, received_at: row.received_at })) }) };
  } },
  { method: 'PATCH', path: '/leads/:id', name: 'leads_update', roles: leadRoles, versionKind: 'lead', summary: 'Assign or follow up on a lead', run(ctx, { params, body }) {
    const row = ctx.get('lead', params.id!);
    const changes: Data = {};
    if (body.assignee_user_id !== undefined) changes.assignee_user_id = optional(body.assignee_user_id, 'assignee_user_id') ?? null;
    if (body.next_follow_up_at !== undefined) changes.next_follow_up_at = time(body.next_follow_up_at, 'next_follow_up_at');
    if (body.status !== undefined && body.status !== row.status) {
      const status = text(body.status, 'status');
      if (!leadTransitions[String(row.status)]?.includes(status)) conflict('Lead status transition is not allowed');
      if (status === 'contacted') {
        const channel = oneOf(body.channel, ['email','sms','whatsapp'], 'channel');
        const purpose = oneOf(body.purpose, ['service','marketing'], 'purpose');
        if (!contactPermitted(ctx, row, channel, purpose) || !body.outcome) conflict('Record a permitted contact and its outcome');
        ctx.create('lead_activity', { lead_id: row.id, type: 'contacted', channel, purpose, outcome: text(body.outcome, 'outcome'), at: ctx.now });
      }
      changes.status = status;
      ctx.emit('traffic.lead.status_changed', { lead_id: row.id, previous_status: row.status, status });
    }
    if (changes.status !== 'contacted' && (body.outcome !== undefined || changes.status)) ctx.create('lead_activity', { lead_id: row.id, type: changes.status ? 'status_changed' : 'note', outcome: optional(body.outcome, 'outcome') ?? null, at: ctx.now });
    return leadView(ctx, Object.keys(changes).length ? ctx.update('lead', row.id, changes) : row);
  } },
  { method: 'POST', path: '/leads/:id/handoff', name: 'leads_handoff', roles: piiRoles, versionKind: 'lead', summary: 'Queue a consent-checked CRM handoff', run(ctx, { params, body }) {
    const row = ctx.get('lead', params.id!);
    const channel = oneOf(body.channel, ['email','sms','whatsapp'], 'channel');
    if (row.status !== 'qualified' || !contactPermitted(ctx, row, channel, 'service')) conflict('Handoff requires a qualified lead with current service consent on this channel');
    if (row.handoff_status === 'pending' || row.handoff_status === 'unknown') conflict('Resolve the existing handoff before retrying');
    const destination = text(body.destination, 'destination');
    const request = ctx.create('lead_handoff', { lead_id: row.id, destination, channel, status: 'pending' });
    ctx.update('lead', row.id, { handoff_id: request.id, handoff_status: 'pending', local_crm_dispatched_at: null });
    const task = queueManualExternalWork(ctx, { key: `crm:${request.id}`, title: 'Check CRM routing and verify lead handoff',
      resourceType: 'lead', resourceId: row.id, brandId: row.brand_id, initiallyBlocked: true,
      event: 'traffic.lead.handoff_requested', references: { lead_id: row.id, handoff_id: request.id } });
    return { lead_id: row.id, handoff_id: request.id, handoff_status: 'pending', work_item_id: task.id };
  } },
  { method: 'POST', path: '/leads/:id/handoff/local-dispatch', name: 'leads_dispatch_local_handoff', roles: piiRoles,
    versionKind: 'lead', external: true, summary: 'Dispatch a pending handoff to the configured loopback CRM', async run(ctx, { params }) {
    const lead = ctx.get('lead', params.id!);
    const request = ctx.get('lead_handoff', String(lead.handoff_id));
    const origin = process.env.SMARTSELL_LOCAL_CRM_ORIGIN;
    if (!origin || request.destination !== 'local-mock' || request.status !== 'pending' || request.local_dispatch_at ||
        !contactPermitted(ctx, lead, String(request.channel), 'service')) conflict('Local CRM handoff is unavailable or no longer permitted');
    const transport = loopbackEsp(origin!, 'crm');
    try {
      await transport('handoff', { handoff_id: request.id, lead_id: lead.id, channel: request.channel });
    } catch {
      // An accepted handoff may lose its response. Use the receipt endpoint to resolve it.
    }
    ctx.update('lead_handoff', request.id, { local_dispatch_at: ctx.now });
    return leadView(ctx, ctx.update('lead', lead.id, { local_crm_dispatched_at: ctx.now }));
  } },
  { method: 'POST', path: '/leads/:id/handoff/receipt', name: 'leads_record_handoff_receipt', roles: piiRoles, versionKind: 'lead', summary: 'Record CRM provider readback for the current handoff', async run(ctx, { params, body }) {
    const lead = ctx.get('lead', params.id!);
    const requestId = text(body.handoff_id, 'handoff_id');
    if (lead.handoff_id !== requestId) conflict('Handoff is no longer current');
    const request = ctx.get('lead_handoff', requestId);
    if (ctx.list('webhook_delivery').some(row => row.event_id === requestId && row.event_type === 'traffic.lead.handoff_requested' && ['queued', 'sending'].includes(String(row.status)))) {
      conflict('Wait for the current transport attempt before recording provider readback');
    }
    let receipt = body;
    if (body.readback === 'local') {
      const origin = process.env.SMARTSELL_LOCAL_CRM_ORIGIN;
      if (!origin || request.destination !== 'local-mock' || !request.local_dispatch_at) conflict('Dispatch the handoff before reading its local CRM receipt');
      const payload = object(await loopbackEsp(origin!, 'crm')('receipt', { handoff_id: requestId }));
      if (payload.handoff_id !== requestId) conflict('CRM returned a receipt for a different handoff');
      receipt = payload;
    }
    const outcome = oneOf(receipt.outcome, ['confirmed', 'failed', 'unknown'], 'outcome');
    const evidenceRef = text(receipt.evidence_ref, 'provider evidence reference');
    const result = recordLeadHandoffReceipt(ctx, { requestId, outcome, externalRef: optional(receipt.external_ref, 'external CRM reference') });
    ctx.update('lead_handoff', request.id, { evidence_ref: evidenceRef, verified_by: ctx.actorId });
    const task = ctx.list('work_item').find(row => row.dedupe_key === `manual-external:crm:${requestId}`);
    if (task) ctx.update('work_item', task.id, { status: outcome === 'confirmed' ? 'done' : 'blocked',
      blocked_reason: outcome === 'unknown' ? 'CRM outcome remains unknown. Do not resend.' : outcome === 'failed' ? 'Provider readback indicates failure.' : null,
      ...(outcome === 'confirmed' && { completed_at: ctx.now, completed_by_type: 'user', completed_by_id: ctx.actorId }) });
    return result;
  } },
  { method: 'POST', path: '/leads/export', name: 'leads_export', roles: piiRoles, summary: 'Export masked lead records with audit event', run(ctx, { body }) {
    const ids = body.lead_ids === undefined ? undefined : new Set(items(body.lead_ids, 1000).map(value => text(value, 'lead ID')));
    const rows = ctx.list('lead').filter(row => !ids || ids.has(row.id)).map(row => leadView(ctx, row));
    ctx.emit('traffic.lead.exported', { count: rows.length, actor_id: ctx.actorId });
    return { items: rows };
  } },
];
