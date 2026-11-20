import { planningOperations, shipmentView } from './planning.js';
import { createHash } from 'node:crypto';
import { READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { commissionOperations, commissionRule, evidence } from './commission-operations.js';
import { approvers, array, bad, block, choice, collaborationStatus, created, date, ids, integer, moneyCurrency, object, operators, optional, related, signedTerms, text, url } from './model.js';

import { createCommands } from './commands.ts';
import { parseCsv } from '../ingest/csv.js';

const closed = ['cancelled', 'completed'];
const collaborationTypes = ['gifted', 'fixed_fee', 'commission', 'hybrid'] as const;
const channelTypes = ['email', 'platform_dm', 'phone', 'other'] as const;
const profileStatuses = ['active', 'do_not_contact', 'archived'] as const;
const deliveryTypes = ['short_video', 'image_post', 'story', 'live', 'raw_footage', 'other'] as const;
const profileFields = (body: Data) => {
  const patch: Data = {};
  if ('display_name' in body) patch.display_name = text(body, 'display_name');
  for (const field of ['languages', 'tags']) if (field in body) patch[field] = ids(body, field);
  if ('audience_markets' in body) patch.audience_markets = array(body.audience_markets, 'audience_markets').map(item => {
    const market = object(item, 'audience_markets');
    return { market: text(market, 'market'), share_bps: integer(market, 'share_bps', 0, 10_000), ...provenance(market) };
  });
  if ('rate_card' in body) {
    const rate = object(body.rate_card, 'rate_card');
    patch.rate_card = { amount_minor: integer(rate, 'amount_minor'), currency: moneyCurrency(rate), ...provenance(rate) };
  }
  if ('status' in body) {
    patch.status = choice(body, 'status', profileStatuses);
    patch.do_not_contact_reason = patch.status === 'do_not_contact' ? text(body, 'do_not_contact_reason', 4000) : null;
  }
  return patch;
};
function provenance(body: Data) {
  return { source_kind: choice(body, 'source_kind', ['self_reported', 'public', 'manual']), observed_at: date(body, 'observed_at'),
    ...('source_ref' in body && { source_ref: optional(body, 'source_ref', 2000) }),
  };
}
function editableCollaboration(ctx: Context, id: string) {
  const row = ctx.get('collaboration', id);
  if (closed.includes(String(row.status))) return block('INVALID_STATE', 'Collaboration is closed');
  return row;
}
const children = (ctx: Context, kind: string, id: string) => related(ctx, kind, 'collaboration_id', id);
function collaborationPlan(body: Data) {
  const patch: Data = {};
  for (const field of ['owner_user_id', 'next_action']) if (field in body) patch[field] = optional(body, field, 4000);
  if ('next_action_due_at' in body) patch.next_action_due_at = body.next_action_due_at == null ? null : date(body, 'next_action_due_at');
  if ('market_ids' in body) patch.market_ids = ids(body, 'market_ids');
  return patch;
}
function termsDTO(body: Data, collaboration: Row) {
  const fee = body.fee == null ? null : object(body.fee, 'fee');
  const rights = body.usage_rights_required == null ? null : object(body.usage_rights_required, 'usage_rights_required');
  const rule = body.commission_rule == null ? null : commissionRule(object(body.commission_rule, 'commission_rule'));
  if (['commission', 'hybrid'].includes(String(collaboration.type)) && !rule) return bad('commission_rule');
  if (['fixed_fee', 'hybrid'].includes(String(collaboration.type)) && !fee) return bad('fee');
  return {
    fee: fee && { amount_minor: integer(fee, 'amount_minor'), currency: moneyCurrency(fee) }, commission_rule: rule,
    deliverable_requirements: body.deliverable_requirements == null ? [] : ids(body, 'deliverable_requirements'),
    usage_rights_required: rights && {
      channels: ids(rights, 'channels'), market_ids: ids(rights, 'market_ids'), end_at: date(rights, 'end_at'),
      paid_use: rights.paid_use === true,
    },
    deadline: body.deadline == null ? null : date(body, 'deadline'),
    attachment_ids: body.attachment_ids == null ? [] : ids(body, 'attachment_ids'),
  };
}

export const operations: Operation[] = [
  { method: 'GET', path: '/creators', name: 'creators_search', roles: READ, summary: 'Search workspace creator profiles', run(ctx, { query }) {
    return ctx.list('creator').filter(row => {
      if (query.status ? row.status !== query.status : row.status === 'archived') return false;
      if (query.q && !String(row.display_name).toLowerCase().includes(query.q.toLowerCase())) return false;
      if (query.language && !(row.languages as string[]).includes(query.language)) return false;
      if (query.tag && !(row.tags as string[]).includes(query.tag)) return false;
      return !query.market || (row.audience_markets as Data[]).some(market => market.market === query.market);
    });
  } },
  { method: 'GET', path: '/creators/:id', name: 'creators_get', roles: READ, summary: 'Read creator profile and linked public accounts', run(ctx, { params }) {
    return { creator: ctx.get('creator', params.id), accounts: related(ctx, 'creator_account', 'creator_id', params.id), collaborations: related(ctx, 'collaboration', 'creator_id', params.id) };
  } },
  { method: 'POST', path: '/creators', name: 'creators_create', roles: operators, summary: 'Create a creator profile', run(ctx, { body }) {
    return created(ctx, 'creator', { status: 'active', languages: [], tags: [], audience_markets: [], ...profileFields(body), display_name: text(body, 'display_name') });
  } },
  { method: 'PATCH', path: '/creators/:id', name: 'creators_update', roles: operators, versionKind: 'creator', summary: 'Update creator profile and contact preference', run(ctx, { params, body }) {
    return ctx.update('creator', params.id, profileFields(body));
  } },
  { method: 'POST', path: '/creators/:id/audience-observations', name: 'creators_record_audience', roles: operators, versionKind: 'creator', summary: 'Record an audience market share with its source and observation time', run(ctx, { params, body }) {
    const creator = ctx.get('creator', params.id);
    const market = text(body, 'market');
    const observation = { market, share_bps: integer(body, 'share_bps', 0, 10_000), ...provenance(body) };
    if (observation.observed_at > ctx.now) return bad('observed_at');
    const existing = (creator.audience_markets ?? []) as Data[];
    const sameObservation = (row: Data) => row.market === market && row.source_kind === observation.source_kind &&
      (row.source_ref ?? null) === (observation.source_ref ?? null) && row.observed_at === observation.observed_at;
    return ctx.update('creator', creator.id, { audience_markets: [...existing.filter(row => !sameObservation(row)), observation] });
  } },
  { method: 'GET', path: '/creators/:id/contacts', name: 'creators_list_contacts', roles: operators, summary: 'Read creator contact details', run(ctx, { params }) {
    ctx.get('creator', params.id);
    return related(ctx, 'creator_contact', 'creator_id', params.id);
  } },
  { method: 'POST', path: '/creators/:id/contacts/import', name: 'creators_import_contacts', roles: operators, summary: 'Import creator contacts from CSV into a selected profile', run(ctx, { params, body }) {
    ctx.get('creator', params.id);
    const source = text(body, 'source_ref', 2048);
    const { header, records } = parseCsv(text(body, 'csv', 100_000));
    if (records.length > 200 || header.length !== 2 || !header.includes('channel') || !header.includes('value')) return bad('csv columns or row count');
    const contacts = records.map(({ line, cells }) => {
      if (cells.length !== header.length) return bad(`csv row ${line}`);
      const row = Object.fromEntries(header.map((key, index) => [key, cells[index]]));
      const channel = choice(row, 'channel', channelTypes);
      const value = text(row, 'value');
      if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return bad(`csv email on row ${line}`);
      return { channel, value };
    });
    const keys = new Set(related(ctx, 'creator_contact', 'creator_id', params.id).map(row => JSON.stringify([row.channel, row.value])));
    const added = contacts.flatMap(contact => {
      const key = JSON.stringify([contact.channel, contact.value]);
      if (keys.has(key)) return [];
      keys.add(key);
      return [created(ctx, 'creator_contact', { creator_id: params.id, ...contact, source_ref: source })];
    });
    return { added: added.length, duplicates: contacts.length - added.length };
  } },
  { method: 'GET', path: '/creators/:id/associations', name: 'creators_list_associations', roles: READ, summary: 'Review past and current creator profile associations', run(ctx, { params }) {
    ctx.get('creator', params.id);
    return ctx.list('creator_association').filter(row => [row.creator_id, row.related_creator_id].includes(params.id)).map(row => {
      const counterpart = ctx.get('creator', String(row.creator_id === params.id ? row.related_creator_id : row.creator_id));
      return { ...row, related_display_name: counterpart.display_name };
    });
  } },
  { method: 'POST', path: '/creators/:id/associations', name: 'creators_associate_profiles', roles: operators, summary: 'Associate duplicate creator profiles with evidence', run(ctx, { params, body }) {
    ctx.get('creator', params.id);
    const other = ctx.get('creator', text(body, 'related_creator_id'));
    if (params.id === other.id) return bad('related_creator_id');
    const refs = evidence(body);
    refs.forEach(id => ctx.get('evidence', id));
    const reason = text(body, 'reason', 4_000);
    // Keep each pair reviewable without transitive links or moving either profile's records.
    if (ctx.list('creator_association').some(row => row.status === 'associated' && [row.creator_id, row.related_creator_id].some(id => id === params.id || id === other.id))) {
      return block('ALREADY_ASSOCIATED', 'Undo the existing association before linking either profile again');
    }
    return created(ctx, 'creator_association', { creator_id: params.id, related_creator_id: other.id, evidence_ids: refs, reason, status: 'associated' });
  } },
  { method: 'POST', path: '/creator-associations/:id/revoke', name: 'creators_revoke_association', roles: operators, versionKind: 'creator_association', summary: 'Undo an association and retain its evidence', run(ctx, { params, body }) {
    const row = ctx.get('creator_association', params.id);
    if (row.status !== 'associated') return block('ALREADY_REVOKED', 'Association has already been undone');
    return ctx.update('creator_association', row.id, { status: 'revoked', revoked_reason: text(body, 'reason', 4000), revoked_by: ctx.actorId, revoked_at: ctx.now });
  } },
  { method: 'POST', path: '/creators/:id/accounts', name: 'creators_link_account', roles: operators, summary: 'Link a self-reported or publicly verifiable account', run(ctx, { params, body }) {
    ctx.get('creator', params.id);
    const provider = text(body, 'provider');
    const externalId = optional(body, 'external_account_id');
    const handle = optional(body, 'handle');
    const profileUrl = url(body, 'profile_url');
    if (!handle && !externalId) return bad('handle or external_account_id');
    if (externalId && ctx.list('creator_account').some(row => row.provider === provider && row.external_account_id === externalId)) return block('DUPLICATE_ACCOUNT', 'Platform ID already linked');
    return created(ctx, 'creator_account', { creator_id: params.id, provider, external_account_id: externalId, handle, profile_url: profileUrl, verification_level: 'self_reported' });
  } },
  { method: 'POST', path: '/creator-accounts/:id/verify', name: 'creators_verify_account', roles: operators, versionKind: 'creator_account', summary: 'Record a manual creator account verification with supporting evidence', run(ctx, { params, body }) {
    const account = ctx.get('creator_account', params.id);
    const sourceRef = url(body, 'source_ref');
    if (!sourceRef) return bad('source_ref');
    const verificationNote = text(body, 'verification_note', 4_000);
    ctx.update('creator', String(account.creator_id), { last_verified_at: ctx.now });
    return ctx.update('creator_account', account.id, {
      verification_level: 'manually_verified', verification_ref: sourceRef, verification_note: verificationNote,
      verified_at: ctx.now, verified_by: ctx.actorId,
    });
  } },
  { method: 'GET', path: '/collaborations', name: 'collaborations_list', roles: READ, summary: 'Read collaboration board', run(ctx, { query }) {
    return ctx.list('collaboration').filter(row => (!query.status || row.status === query.status) && (!query.campaign_id || row.campaign_id === query.campaign_id) && (!query.creator_id || row.creator_id === query.creator_id));
  } },
  { method: 'GET', path: '/collaborations/:id', name: 'collaborations_get', roles: READ, summary: 'Read a collaboration and its workflow records', run(ctx, { params }) {
    const result: Data = { collaboration: ctx.get('collaboration', params.id) };
    for (const kind of ['collaboration_terms', 'outreach', 'deliverable', 'sample_shipment', 'affiliate_assignment', 'live_session']) {
      result[kind] = children(ctx, kind, params.id).map(row => kind === 'sample_shipment' ? shipmentView(row) : row);
    }
    return result;
  } },
  { method: 'POST', path: '/collaborations', name: 'collaborations_create', roles: operators, summary: 'Create a prospect collaboration', run(ctx, { body }) {
    const creator = ctx.get('creator', text(body, 'creator_id'));
    if (creator.status !== 'active') return block('CREATOR_UNAVAILABLE', 'Creator is archived or marked do not contact');
    const campaign = ctx.get('campaign', text(body, 'campaign_id'));
    const brandId = text(campaign, 'brand_id');
    if (ctx.list('collaboration').some(row => row.creator_id === creator.id && row.campaign_id === campaign.id && !closed.includes(String(row.status)))) return block('DUPLICATE_COLLABORATION', 'An active collaboration already exists');
    return created(ctx, 'collaboration', { creator_id: creator.id, campaign_id: campaign.id, brand_id: brandId, type: choice(body, 'type', collaborationTypes), ...collaborationPlan(body), status: 'prospect', current_terms_revision_id: null });
  } },
  { method: 'PATCH', path: '/collaborations/:id', name: 'collaborations_update', roles: operators, versionKind: 'collaboration', summary: 'Plan next actions, complete or cancel a collaboration', run(ctx, { params, body }) {
    const row = editableCollaboration(ctx, params.id);
    const status = body.status === undefined ? String(row.status) : choice(body, 'status', ['prospect', 'contacted', 'negotiating', 'terms_pending', 'active', 'delivering', ...closed]);
    const patch = collaborationPlan(body);
    if (status === row.status) return ctx.update('collaboration', row.id, patch);
    const deliveries = children(ctx, 'deliverable', row.id);
    const commissions = children(ctx, 'commission_entry', row.id);
    if (status === 'completed') {
      if (row.status !== 'delivering' || !deliveries.length || deliveries.some(item => !['accepted', 'published_verified'].includes(String(item.status))) || commissions.some(item => !['reversed', 'paid', 'platform_settled'].includes(String(item.status)))) return block('COMPLETION_BLOCKED', 'Accept all deliveries and settle all commissions first');
      if (row.type !== 'gifted') patch.settlement_confirmation_ref = text(body, 'settlement_confirmation_ref');
    } else if (status === 'cancelled') {
      patch.cancellation_reason = text(body, 'cancellation_reason', 4000);
      if (['active', 'delivering'].includes(String(row.status))) {
        patch.closeout_evidence_ids = evidence(body);
        for (const id of patch.closeout_evidence_ids as string[]) ctx.get('evidence', id);
      }
    } else return block('INVALID_STATE', 'Use the relevant outreach, terms or delivery action to advance this collaboration');
    return collaborationStatus(ctx, row, status, patch);
  } },
  { method: 'POST', path: '/collaborations/:id/outreach', name: 'outreach_draft', roles: WRITE, summary: 'Draft an invitation without sending it', run(ctx, { params, body }) {
    const collaboration = editableCollaboration(ctx, params.id);
    return created(ctx, 'outreach', { collaboration_id: collaboration.id, channel: choice(body, 'channel', channelTypes), body: text(body, 'body', 20_000), language: optional(body, 'language'), status: 'draft', direction: 'outbound', ai_generated: ctx.role === 'agent' });
  } },
  { method: 'POST', path: '/outreach/:id/send', name: 'outreach_send', roles: operators, versionKind: 'outreach', external: true, summary: 'Return manual outreach instructions for a saved draft', run(ctx, { params }) {
    const row = ctx.get('outreach', params.id);
    const collaboration = editableCollaboration(ctx, String(row.collaboration_id));
    if (ctx.get('creator', String(collaboration.creator_id)).status !== 'active') return block('CREATOR_UNAVAILABLE', 'Creator is archived or marked do not contact');
    if (row.status !== 'draft') return block('INVALID_STATE', 'Invitation is no longer a draft');
    const collaborations = new Set(related(ctx, 'collaboration', 'creator_id', collaboration.creator_id).map(item => item.id));
    const recent = ctx.list('outreach').some(item => collaborations.has(String(item.collaboration_id)) && item.status === 'sent' && Date.parse(String(item.sent_at)) >= Date.parse(ctx.now) - 604_800_000);
    return { outreach: row, delivery_mode: 'manual', recent_contact: recent };
  } },
  { method: 'POST', path: '/outreach/:id/record-sent', name: 'outreach_record_sent', roles: operators, versionKind: 'outreach', summary: 'Record an invitation actually sent outside SmartSell', run(ctx, { params, body }) {
    const row = ctx.get('outreach', params.id);
    const collaboration = editableCollaboration(ctx, String(row.collaboration_id));
    const ref = text(body, 'external_message_ref');
    const sentAt = date(body, 'sent_at');
    if (sentAt > ctx.now) return bad('sent_at');
    if (row.status === 'sent' && row.external_message_ref === ref) return row;
    if (row.status !== 'draft') return block('INVALID_STATE', 'Invitation is no longer a draft');
    if (ctx.get('creator', String(collaboration.creator_id)).status !== 'active') return block('CREATOR_UNAVAILABLE', 'Creator is archived or marked do not contact');
    if (related(ctx, 'outreach', 'external_message_ref', ref).length) return block('DUPLICATE_OUTREACH', 'Outreach evidence already recorded');
    const result = ctx.update('outreach', row.id, { status: 'sent', external_message_ref: ref, sent_at: sentAt, recorded_by: ctx.actorId });
    if (collaboration.status === 'prospect') collaborationStatus(ctx, collaboration, 'contacted');
    ctx.emit('creator.outreach.sent', { collaboration_id: collaboration.id, outreach_id: row.id });
    return result;
  } },
  { method: 'POST', path: '/collaborations/:id/outreach/reply', name: 'outreach_record_reply', roles: operators, summary: 'Record an actual creator reply', run(ctx, { params, body }) {
    const collaboration = editableCollaboration(ctx, params.id);
    if (!children(ctx, 'outreach', collaboration.id).some(row => row.status === 'sent')) return block('INVALID_STATE', 'Record the sent invitation before recording a reply');
    const ref = text(body, 'external_message_ref');
    const existing = related(ctx, 'outreach', 'external_message_ref', ref)[0];
    if (existing) {
      if (existing.collaboration_id === collaboration.id && existing.status === 'received') return existing;
      return block('DUPLICATE_OUTREACH', 'Outreach evidence already recorded');
    }
    const row = created(ctx, 'outreach', { collaboration_id: collaboration.id, channel: choice(body, 'channel', channelTypes), direction: 'inbound', status: 'received', external_message_ref: ref, body: text(body, 'body', 20_000), received_at: ctx.now });
    if (collaboration.status === 'contacted') collaborationStatus(ctx, collaboration, 'negotiating');
    ctx.emit('creator.outreach.replied', { collaboration_id: collaboration.id, outreach_id: row.id });
    return row;
  } },
  { method: 'POST', path: '/collaborations/:id/terms', name: 'collaborations_create_terms', roles: operators, versionKind: 'collaboration', summary: 'Create an immutable collaboration terms revision', run(ctx, { params, body }) {
    const collaboration = editableCollaboration(ctx, params.id);
    if (!['negotiating', 'terms_pending', 'active', 'delivering'].includes(String(collaboration.status))) return block('INVALID_STATE', 'Collaboration is not ready for terms');
    const values = termsDTO(body, collaboration);
    const revisions = children(ctx, 'collaboration_terms', collaboration.id);
    const last = revisions.sort((a, b) => Number(b.revision_no) - Number(a.revision_no))[0];
    if (last && ['draft', 'sent'].includes(String(last.sign_status))) {
      ctx.update('collaboration_terms', last.id, { sign_status: 'superseded' });
      ctx.emit('creator.terms.superseded', { collaboration_id: collaboration.id, terms_revision_id: last.id });
    }
    if (collaboration.status === 'terms_pending') collaborationStatus(ctx, collaboration, 'negotiating');
    return created(ctx, 'collaboration_terms', { ...values, sign_status: 'draft', collaboration_id: collaboration.id, revision_no: Number(last?.revision_no ?? 0) + 1, content_hash: createHash('sha256').update(JSON.stringify(values)).digest('hex') });
  } },
  { method: 'POST', path: '/terms/:id/send', name: 'collaborations_send_terms', roles: approvers, versionKind: 'collaboration_terms', summary: 'Record reference for the terms sent for signature', run(ctx, { params, body }) {
    const row = ctx.get('collaboration_terms', params.id);
    const collaboration = editableCollaboration(ctx, String(row.collaboration_id));
    if (row.sign_status !== 'draft') return block('INVALID_STATE', 'Terms revision must be a draft');
    const signatureRequestRef = text(body, 'signature_request_ref');
    if (collaboration.status === 'negotiating') collaborationStatus(ctx, collaboration, 'terms_pending');
    return ctx.update('collaboration_terms', row.id, { sign_status: 'sent', signature_request_ref: signatureRequestRef, sent_at: ctx.now });
  } },
  { method: 'POST', path: '/terms/:id/mark-signed', name: 'collaborations_mark_terms_signed', roles: approvers, versionKind: 'collaboration_terms', summary: 'Record signed terms evidence and activate revision', run(ctx, { params, body }) {
    const row = ctx.get('collaboration_terms', params.id);
    const collaboration = editableCollaboration(ctx, String(row.collaboration_id));
    if (row.sign_status !== 'sent') return block('INVALID_STATE', 'Only terms sent for signature may be marked signed');
    const evidenceIds = evidence(body, 'signed_evidence_ids');
    for (const id of evidenceIds) ctx.get('evidence', id);
    const prev = collaboration.current_terms_revision_id;
    if (prev) {
      ctx.update('collaboration_terms', String(prev), { sign_status: 'superseded' });
      ctx.emit('creator.terms.superseded', { collaboration_id: collaboration.id, terms_revision_id: prev });
    }
    collaborationStatus(ctx, collaboration, collaboration.status === 'terms_pending' ? 'active' : String(collaboration.status), { current_terms_revision_id: row.id });
    const result = ctx.update('collaboration_terms', row.id, { sign_status: 'signed', signed_evidence_ids: evidenceIds, signed_at: ctx.now, verified_by: ctx.actorId });
    ctx.emit('creator.terms.signed', { collaboration_id: collaboration.id, terms_revision_id: row.id });
    return result;
  } },
  { method: 'POST', path: '/collaborations/:id/deliverables', name: 'deliverables_create', roles: operators, summary: 'Request a collaboration deliverable', run(ctx, { params, body }) {
    const collaboration = editableCollaboration(ctx, params.id);
    const targetId = optional(body, 'publish_target_id');
    if (targetId) {
      const target = ctx.get('publish_target', targetId);
      if (target.campaign_id !== collaboration.campaign_id || target.brand_id !== collaboration.brand_id) {
        return block('PUBLISH_TARGET_MISMATCH', 'Select a publish target in this collaboration campaign');
      }
    }
    return created(ctx, 'deliverable', { collaboration_id: params.id, kind: choice(body, 'kind', deliveryTypes), platform: optional(body, 'platform'), due_at: date(body, 'due_at'), acceptance_criteria: ids(body, 'acceptance_criteria'), status: 'requested', rights_grant_ids: [], publish_target_id: targetId });
  } },
  { method: 'GET', path: '/collaborations/:id/deliverables', name: 'deliverables_list', roles: READ, summary: 'List collaboration deliverables', run(ctx, { params }) {
    ctx.get('collaboration', params.id);
    return children(ctx, 'deliverable', params.id);
  } },
  { method: 'GET', path: '/deliverables/:id', name: 'deliverables_get', roles: READ, summary: 'Read deliverable and its submission history', run(ctx, { params }) {
    return { deliverable: ctx.get('deliverable', params.id), versions: related(ctx, 'deliverable_version', 'deliverable_id', params.id),
      deadline_changes: related(ctx, 'deliverable_deadline_change', 'deliverable_id', params.id).sort((a, b) => Number(b.deliverable_version) - Number(a.deliverable_version)) };
  } },
  { method: 'PATCH', path: '/deliverables/:id/deadline', name: 'deliverables_change_deadline', roles: operators,
    versionKind: 'deliverable', summary: 'Update a deliverable deadline and flag the linked publication for schedule review', run(ctx, { params, body }) {
    const delivery = ctx.get('deliverable', params.id);
    const collaboration = editableCollaboration(ctx, String(delivery.collaboration_id));
    if (['accepted', 'published_verified'].includes(String(delivery.status))) return block('INVALID_STATE', 'Accepted deliverable deadlines cannot be changed');
    const dueAt = date(body, 'due_at');
    const reason = text(body, 'reason', 4000);
    if (delivery.due_at === dueAt) return block('DEADLINE_UNCHANGED', 'Select a different deadline');
    const target = typeof delivery.publish_target_id === 'string'
      ? ctx.list('publish_target').find(row => row.id === delivery.publish_target_id && row.campaign_id === collaboration.campaign_id && row.brand_id === collaboration.brand_id)
      : undefined;
    const impact = target && target.plan_status !== 'closed' && !['cancelled', 'published', 'closed'].includes(String(target.status)) ? {
      publish_target_id: target.id, scheduled_at: target.scheduled_at ?? null, review_required: true,
      deadline_after_schedule: typeof target.scheduled_at === 'string' && Date.parse(dueAt) > Date.parse(target.scheduled_at),
    } : null;
    const updated = ctx.update('deliverable', delivery.id, { due_at: dueAt });
    const change = created(ctx, 'deliverable_deadline_change', {
      deliverable_id: delivery.id, deliverable_version: updated.version, previous_due_at: delivery.due_at, due_at: dueAt, reason, impact,
    });
    ctx.emit('creator.deliverable.deadline_changed', {
      change_id: change.id, deliverable_id: delivery.id, collaboration_id: collaboration.id, campaign_id: collaboration.campaign_id,
      brand_id: collaboration.brand_id, recipient_user_ids: [...new Set([collaboration.owner_user_id, target?.owner_user_id].filter(id => typeof id === 'string'))],
      publish_target_id: impact?.publish_target_id, previous_due_at: delivery.due_at, due_at: dueAt, impact,
    });
    return { deliverable: updated, deadline_change: change };
  } },
  { method: 'GET', path: '/deliverables/missing', name: 'deliverables_list_missing', roles: READ, summary: 'List requested deliverables past their due date', run(ctx) {
    return ctx.list('deliverable').filter(row => ['requested', 'in_progress', 'changes_requested'].includes(String(row.status)) && String(row.due_at) < ctx.now && !closed.includes(String(ctx.get('collaboration', String(row.collaboration_id)).status)));
  } },
  { method: 'POST', path: '/deliverables/:id/versions', name: 'deliverables_submit', roles: operators, versionKind: 'deliverable', summary: 'Submit files or a source link for review', run(ctx, { params, body }) {
    const delivery = ctx.get('deliverable', params.id);
    const collaboration = editableCollaboration(ctx, String(delivery.collaboration_id));
    if (!['active', 'delivering'].includes(String(collaboration.status)) || !['requested', 'in_progress', 'changes_requested'].includes(String(delivery.status))) return block('INVALID_STATE', 'Deliverable is not open for a submission');
    const assetIds = body.asset_ids == null ? [] : ids(body, 'asset_ids');
    const postUrl = url(body, 'post_url');
    if (!postUrl && !assetIds.length) return bad('asset_ids or post_url');
    signedTerms(ctx, collaboration);
    const assetVersions: Record<string, string | null> = {};
    for (const id of assetIds) {
      const asset = ctx.get('asset', id);
      if (asset.brand_id !== collaboration.brand_id) return block('DELIVERABLE_ASSET_MISMATCH', 'Submitted assets must belong to the collaboration brand');
      assetVersions[id] = typeof asset.current_version_id === 'string' ? asset.current_version_id : null;
    }
    const count = related(ctx, 'deliverable_version', 'deliverable_id', delivery.id).length;
    const row = created(ctx, 'deliverable_version', { deliverable_id: delivery.id, version_no: count + 1, asset_ids: assetIds, asset_versions: assetVersions, post_url: postUrl, submitted_at: ctx.now, submitted_by: ctx.actorId, review_status: 'pending' });
    ctx.update('deliverable', delivery.id, { status: 'submitted', latest_version_id: row.id, rights_grant_ids: [] });
    if (collaboration.status === 'active') collaborationStatus(ctx, collaboration, 'delivering');
    ctx.emit('creator.deliverable.submitted', { deliverable_id: delivery.id, deliverable_version_id: row.id, collaboration_id: collaboration.id });
    return row;
  } },
  { method: 'POST', path: '/deliverable-versions/:id/review', name: 'deliverables_review', roles: approvers, versionKind: 'deliverable_version', summary: 'Accept a submitted version or request changes', run(ctx, { params, body }) {
    const row = ctx.get('deliverable_version', params.id);
    const delivery = ctx.get('deliverable', String(row.deliverable_id));
    const collaboration = editableCollaboration(ctx, String(delivery.collaboration_id));
    if (row.review_status !== 'pending' || delivery.status !== 'submitted' || delivery.latest_version_id !== row.id) return block('INVALID_STATE', 'Only the latest pending submission can be reviewed');
    const status = choice(body, 'status', ['accepted', 'changes_requested']);
    const note = status === 'changes_requested' ? text(body, 'note', 4000) : optional(body, 'note', 4000);
    if (status === 'accepted') {
      const terms = signedTerms(ctx, collaboration);
      if (terms.usage_rights_required) checkRights(ctx, collaboration, delivery.rights_grant_ids as string[], row, terms.usage_rights_required as Data);
      ctx.emit('creator.deliverable.accepted', { deliverable_id: delivery.id, deliverable_version_id: row.id, collaboration_id: collaboration.id });
    }
    ctx.update('deliverable', delivery.id, { status, ...(status === 'accepted' && { accepted_version_id: row.id }) });
    return ctx.update('deliverable_version', row.id, { review_status: status, review_note: note, reviewed_by: ctx.actorId, reviewed_at: ctx.now });
  } },
  { method: 'POST', path: '/deliverables/:id/link-rights', name: 'deliverables_link_rights', roles: approvers, versionKind: 'deliverable', summary: 'Link AS grant references to deliverable assets', run(ctx, { params, body }) {
    const row = ctx.get('deliverable', params.id);
    const collaboration = editableCollaboration(ctx, String(row.collaboration_id));
    if (!row.latest_version_id) return block('DELIVERABLE_REQUIRED', 'Submit the asset before linking its associated rights');
    const version = ctx.get('deliverable_version', String(row.latest_version_id));
    const grants = ids(body, 'rights_grant_ids');
    const terms = signedTerms(ctx, collaboration);
    checkRights(ctx, collaboration, grants, version, terms.usage_rights_required as Data | null);
    return ctx.update('deliverable', row.id, { rights_grant_ids: grants });
  } },
  { method: 'POST', path: '/deliverables/:id/verify-publication', name: 'deliverables_verify_publication', roles: approvers, versionKind: 'deliverable', summary: 'Record a platform post or manually confirmed publication link', run(ctx, { params, body }) {
    const row = ctx.get('deliverable', params.id);
    if (row.status !== 'accepted') return block('INVALID_STATE', 'Accept the deliverable before confirming publication');
    const platformPostId = optional(body, 'platform_post_id');
    const manualLink = url(body, 'platform_url');
    if (!platformPostId && !manualLink) return bad('platform_post_id or platform_url');
    if (platformPostId) {
      const post = ctx.get('platform_post', platformPostId);
      const collaboration = ctx.get('collaboration', String(row.collaboration_id));
      if (post.brand_id !== collaboration.brand_id || row.platform && post.provider && row.platform !== post.provider) return block('PUBLICATION_MISMATCH', 'Observed post is outside the collaboration brand or platform');
    }
    const result = ctx.update('deliverable', row.id, { status: 'published_verified', platform_post_id: platformPostId, platform_url: manualLink, verified_by: ctx.actorId, verification: platformPostId ? 'platform_post' : 'manual_link' });
    ctx.emit('creator.deliverable.published_verified', { deliverable_id: row.id, collaboration_id: row.collaboration_id });
    return result;
  } },
  { method: 'POST', path: '/collaborations/:id/affiliate-assignments', name: 'creators_assign_affiliate', roles: operators, summary: 'Assign an existing promotion code, short link or platform reference', run(ctx, { params, body }) {
    editableCollaboration(ctx, params.id);
    const kind = choice(body, 'kind', ['discount_code', 'short_link', 'platform_affiliate']);
    const code = kind === 'discount_code' ? text(body, 'code', 128).toLowerCase() : null;
    const promotionId = kind === 'discount_code' && body.promotion_id != null ? ctx.get('promotion', text(body, 'promotion_id')).id : null;
    const link = kind === 'short_link' ? ctx.get('short_link', text(body, 'short_link_id')).id : null;
    const ref = kind === 'platform_affiliate' ? text(body, 'external_affiliate_ref') : null;
    const validFrom = body.valid_from == null ? ctx.now : date(body, 'valid_from');
    const validUntil = body.valid_until == null ? null : date(body, 'valid_until');
    if (validUntil && validUntil <= validFrom) return bad('valid_until');
    if (ctx.list('affiliate_assignment').some(row => row.kind === kind && (code ? row.code === code : link ? row.short_link_id === link : row.external_affiliate_ref === ref))) return block('DUPLICATE_ASSIGNMENT', 'Affiliate identifier is already assigned');
    return created(ctx, 'affiliate_assignment', { collaboration_id: params.id, kind, code, promotion_id: promotionId, short_link_id: link, external_affiliate_ref: ref, valid_from: validFrom, valid_until: validUntil });
  } },
  ...planningOperations,
  ...commissionOperations,
];

export { submitPortalDeliverable } from './portal-submit.js';
export const commands = createCommands(operations);

function checkRights(ctx: Context, collaboration: Row, grantIds: string[], submission: Row, required?: Data | null) {
  const assetIds = submission.asset_ids as string[];
  const versions = (submission.asset_versions ?? {}) as Record<string, string | null>;
  if (!grantIds.length || !assetIds.length) return block('RIGHTS_REQUIRED', 'Link usage grants to submitted assets');
  const grants = grantIds.map(id => ctx.get('rights_grant', id));
  const links = ctx.list('rights_grant_asset');
  const covers = (grant: Row, assetId: string) => grant.brand_id === collaboration.brand_id && links.some(link =>
    link.rights_grant_id === grant.id && link.asset_id === assetId &&
    (link.version_scope === 'all_versions' || link.version_scope === 'specific_version' && !!versions[assetId] && versions[assetId] === link.asset_version_id));
  if (grants.some(grant => !assetIds.some(id => covers(grant, id))) || assetIds.some(id => !grants.some(grant => covers(grant, id)))) {
    return block('RIGHTS_MISMATCH', 'Rights grants must cover the submitted assets in the collaboration brand');
  }
  const regions = (required?.market_ids as string[] | undefined ?? []).map(id => {
    const market = ctx.get('market', id);
    return String(market.country_code ?? market.region ?? market.code ?? '').toUpperCase();
  });
  const channels = required?.channels as string[] | undefined ?? [];
  const scopes = grants.map(grant => {
    if (!['active', 'expiring'].includes(String(grant.status)) || !grant.active_revision_id) return block('RIGHTS_MISMATCH', 'Each linked grant must be active');
    const revision = ctx.get('rights_grant_revision', String(grant.active_revision_id));
    if (revision.rights_grant_id !== grant.id || typeof revision.valid_from !== 'string' || revision.valid_from > ctx.now ||
        typeof revision.valid_until === 'string' && (revision.valid_until <= ctx.now || typeof required?.end_at === 'string' && revision.valid_until < required.end_at)) {
      return block('RIGHTS_MISMATCH', 'Grant does not cover the required period');
    }
    return { grant, revision };
  });
  if (!required) return;
  const usages = required.paid_use === true ? ['organic_social', 'paid_ads'] : ['organic_social'];
  for (const assetId of assetIds) {
    for (const channel of channels.length ? channels : [null]) {
      for (const region of regions.length ? regions : [null]) {
        for (const usage of usages) {
          const covered = scopes.some(({ grant, revision }) => covers(grant, assetId) && (revision.usages as string[]).includes(usage) &&
            (!revision.platforms || channel !== null && (revision.platforms as string[]).includes(channel)) &&
            (!revision.regions || region !== null && (revision.regions as string[]).includes(region)));
          if (!covered) return block('RIGHTS_REQUIRED', 'Confirmed grant scope does not satisfy the signed usage terms');
        }
      }
    }
  }
}
