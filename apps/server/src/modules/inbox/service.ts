import { loopbackEsp } from '../lifecycle/local-esp.js';
import { ADMIN, Problem, READ, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { businessClock, type Calendar } from './business-hours.js';

const support = ['owner', 'admin', 'manager', 'editor'] as const;
const invalid = (key: string): never => { throw new Problem(422, 'INVALID_INPUT', `Invalid ${key}`); };
const blocked = (message: string): never => { throw new Problem(409, 'INVALID_STATE', message); };
function text(body: Data, key: string, max = 255) {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid(key);
  return value.trim();
}
function enumValue<T extends string>(body: Data, key: string, options: readonly T[]) {
  return options.find(value => body[key] === value) ?? invalid(key);
}
function write(ctx: Context, row: Row, status: string, patch: Data = {}) {
  const result = ctx.update('case', row.id, { status, ...patch });
  ctx.emit('inbox.case.status_changed', { case_id: row.id, from: row.status, to: status });
  return result;
}
function sourceUrl(body: Data) {
  const value = text(body, 'source_url', 2048);
  let parsed: URL;
  try { parsed = new URL(value); } catch { return invalid('source_url'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return invalid('source_url');
  return value;
}

function participantContext(ctx: Context, conversation: Row) {
  const participant = ctx.list('participant').find(row => row.id === conversation.primary_participant_id);
  if (!participant) return { participant: null, customer: null, history: [] };
  const identity = ctx.list('customer_identity').find(row => row.id === participant.customer_identity_id);
  const customer = identity && ctx.list('customer').find(row => row.id === identity.customer_id && row.status === 'active' && (!row.brand_id || row.brand_id === conversation.brand_id));
  return {
    participant: { id: participant.id, version: participant.version, display_name: participant.display_name, provider: participant.provider, customer_identity_id: participant.customer_identity_id ?? null },
    customer: customer ? { id: customer.id, lifecycle_stage: customer.lifecycle_stage } : null,
    history: ctx.list('participant_link').filter(row => row.participant_id === participant.id),
  };
}

export const serviceOperations: Operation[] = [
  { method: 'GET', path: '/inbox/sla-sample', name: 'inbox_get_sla_sample', roles: support, summary: 'Summarize SLA sample coverage and policy pause time', run(ctx) {
    const conversations = ctx.list('conversation').filter(row => !row.merged_into_id);
    const ids = new Set(conversations.map(row => row.id));
    const samples = ctx.list('conversation_sla').filter(row => ids.has(String(row.conversation_id)));
    const pausedSeconds = (row: Row) => Number(row.paused_seconds ?? 0) + (row.paused_at ?
      businessClock((row.business_hours ?? null) as Calendar | null).between(Date.parse(String(row.paused_at)), Date.parse(ctx.now)) / 1000 : 0);
    return {
      sample_count: samples.length, without_policy_count: conversations.length - samples.length,
      first_response_count: samples.filter(row => row.first_responded_at).length,
      resolution_count: samples.filter(row => row.resolution_at).length,
      policy_pause_seconds: Math.floor(samples.reduce((total, row) => total + pausedSeconds(row), 0)),
    };
  } },
  { method: 'GET', path: '/conversations/:id/customer-link', name: 'inbox_get_participant_link', roles: support, summary: 'Read the participant’s masked customer link and audit history', run(ctx, { params }) {
    return participantContext(ctx, ctx.get('conversation', params.id));
  } },
  { method: 'GET', path: '/conversations/:id/moderation', name: 'inbox_list_moderation', roles: support, summary: 'Read comment moderation history and manual platform entry', run(ctx, { params }) {
    const row = ctx.get('conversation', params.id);
    if (!['comment_thread', 'ad_comment'].includes(String(row.kind))) return { mode: 'unavailable', source_url: null, actions: [] };
    return {
      mode: 'manual_only', source_url: row.external_url ?? null,
      ...(row.kind === 'comment_thread' && process.env.SMARTSELL_LOCAL_SOCIAL_ORIGIN && ctx.list('inbox_local_comment_grant').some(grant => grant.enabled === true && grant.account_id === row.social_account_id && grant.provider === row.provider) ? { local_readback: true } : {}),
      actions: ctx.list('moderation_action').filter(action => action.conversation_id === row.id),
    };
  } },
  { method: 'POST', path: '/conversations/:id/moderation', name: 'inbox_record_manual_moderation', roles: support, summary: 'Record a completed manual comment moderation action without writing to the platform', run(ctx, { params, body }) {
    const row = ctx.get('conversation', params.id);
    const message = ctx.get('message', text(body, 'message_id'));
    if (!['comment_thread', 'ad_comment'].includes(String(row.kind)) || message.conversation_id !== row.id || message.direction !== 'inbound' || message.visibility !== 'public') return invalid('message_id');
    const action = enumValue(body, 'action', ['hide', 'delete', 'block']);
    const source_url = sourceUrl(body);
    const reason = text(body, 'reason', 2000);
    if (body.confirmed_on_platform !== true) return invalid('confirmed_on_platform');
    const audit = ctx.create('moderation_action', {
      conversation_id: row.id, message_id: message.id, original_text: message.body_text ?? null,
      original_message_version: message.version, action, source_url, reason, actor_id: ctx.actorId,
      mode: 'manual', status: 'operator_reported',
    });
    ctx.emit('inbox.moderation.recorded', { moderation_action_id: audit.id, conversation_id: row.id, action });
    return audit;
  } },
  { method: 'PUT', path: '/inbox/local-comment-access', name: 'inbox_set_local_comment_access', roles: ADMIN,
    summary: 'Authorize loopback comment readback for a known comment account', run(ctx, { body }) {
      const accountId = text(body, 'account_id');
      const provider = enumValue(body, 'provider', ['meta_facebook','meta_instagram','youtube']);
      if (typeof body.enabled !== 'boolean') return invalid('enabled');
      if (!ctx.list('conversation').some(row => row.social_account_id === accountId && row.provider === provider && row.kind === 'comment_thread')) return invalid('account_id');
      const prior = ctx.list('inbox_local_comment_grant').find(row => row.account_id === accountId && row.provider === provider);
      const patch = { account_id: accountId, provider, enabled: body.enabled, authorized_by: ctx.actorId };
      return prior ? ctx.update('inbox_local_comment_grant', prior.id, patch) : ctx.create('inbox_local_comment_grant', patch);
    } },
  { method: 'POST', path: '/conversations/:id/moderation/readback', name: 'inbox_read_comment_state', roles: support,
    summary: 'Read the authorized provider state after a manual comment action', async run(ctx, { params, body }) {
      const row = ctx.get('conversation', params.id);
      const original = ctx.get('moderation_action', text(body, 'moderation_action_id'));
      if (row.kind !== 'comment_thread' || original.conversation_id !== row.id || original.mode !== 'manual') return invalid('moderation_action_id');
      const origin = process.env.SMARTSELL_LOCAL_SOCIAL_ORIGIN;
      if (!origin || !ctx.list('inbox_local_comment_grant').some(grant => grant.enabled === true && grant.account_id === row.social_account_id && grant.provider === row.provider)) {
        return blocked('Authorized comment readback is unavailable. Use the platform entry.');
      }
      const message = ctx.get('message', String(original.message_id));
      if (typeof message.external_message_id !== 'string' || !message.external_message_id) return blocked('Comment has no provider reference');
      let state = 'unknown';
      try {
        const provider = await loopbackEsp(origin, 'social')('comment', { account_id: row.social_account_id, comment_id: message.external_message_id }) as Data;
        if (provider?.account_id === row.social_account_id && provider.comment_id === message.external_message_id) {
          state = enumValue(provider, 'state', ['visible', 'hidden', 'deleted', 'author_blocked', 'unknown']);
        }
      } catch {
        // Unavailable or invalid readback leaves the manual action unconfirmed.
      }
      const expected: Record<string, string> = { hide: 'hidden', delete: 'deleted', block: 'author_blocked' };
      const receipt = ctx.create('moderation_readback', { conversation_id: row.id, moderation_action_id: original.id, state,
        status: state === expected[String(original.action)] ? 'verified' : 'unconfirmed', actor_id: ctx.actorId, observed_at: ctx.now });
      ctx.update('moderation_action', original.id, { latest_readback_id: receipt.id, latest_readback_status: receipt.status });
      return receipt;
    } },
  { method: 'GET', path: '/cases', name: 'inbox_list_cases', roles: support, summary: 'List cases by handling status', run(ctx, { query }) {
    return ctx.list('case').filter(row => !query.status || row.status === query.status);
  } },
  { method: 'GET', path: '/cases/:id', name: 'inbox_get_case', roles: support, summary: 'Read case and handoff history', run(ctx, { params }) {
    return { case: ctx.get('case', params.id), handoffs: ctx.list('case_handoff').filter(row => row.case_id === params.id) };
  } },
  { method: 'POST', path: '/cases', name: 'inbox_create_case', roles: support, summary: 'Escalate inbox conversations as a case', run(ctx, { body }) {
    if (!Array.isArray(body.conversation_ids) || !body.conversation_ids.length || body.conversation_ids.length > 30) return invalid('conversation_ids');
    const conversations = [...new Set(body.conversation_ids.map(id => text({ id }, 'id')))].map(id => ctx.get('conversation', id));
    if (conversations.some(row => row.merged_into_id || row.brand_id !== conversations[0].brand_id)) return invalid('conversation_ids');
    const kind = enumValue(body, 'kind', ['presale_inquiry', 'return_exchange', 'product_issue', 'other']);
    const title = text(body, 'title');
    const row = ctx.create('case', { brand_id: conversations[0].brand_id, conversation_ids: conversations.map(item => item.id), kind, title, status: 'open', created_by: ctx.actorId });
    ctx.emit('inbox.case.created', { case_id: row.id, conversation_ids: row.conversation_ids });
    return row;
  } },
  { method: 'POST', path: '/cases/:id/handoff', name: 'inbox_handoff_case', roles: support, versionKind: 'case', summary: 'Record a handoff request awaiting acknowledgment', run(ctx, { params, body }) {
    const row = ctx.get('case', params.id);
    const target = enumValue(body, 'target', ['crm', 'helpdesk', 'team']);
    const key = text(body, 'handoff_dedupe_key');
    const existing = ctx.list('case_handoff').find(item => item.handoff_dedupe_key === key);
    if (existing) {
      if (existing.case_id !== row.id || existing.target !== target) return blocked('Handoff key belongs to a different request');
      return existing;
    }
    if (row.status !== 'open') return blocked('Only an open case can be handed off');
    const handoff = ctx.create('case_handoff', { case_id: row.id, target, handoff_dedupe_key: key, requested_at: ctx.now, requested_by: ctx.actorId });
    write(ctx, row, 'handed_off', { current_handoff_id: handoff.id });
    ctx.emit('inbox.case.handed_off', { case_id: row.id, case_handoff_id: handoff.id, target });
    return handoff;
  } },
  { method: 'PATCH', path: '/cases/:id', name: 'inbox_update_case', roles: support, versionKind: 'case', summary: 'Record external acknowledgment, resolution or closeout', run(ctx, { params, body }) {
    const row = ctx.get('case', params.id);
    const status = enumValue(body, 'status', ['accepted_by_external', 'resolved', 'closed']);
    if (status === 'accepted_by_external' && row.status === 'handed_off') {
      const ref = text(body, 'external_ref');
      ctx.update('case_handoff', String(row.current_handoff_id), { acknowledged_at: ctx.now, external_ref: ref });
      return write(ctx, row, status, { external_ref: ref });
    }
    if (status === 'resolved' && ['open', 'accepted_by_external'].includes(String(row.status))) return write(ctx, row, status, { resolved_at: ctx.now });
    if (status === 'closed' && row.status === 'resolved') return write(ctx, row, status, { closed_at: ctx.now });
    return blocked('Invalid case transition');
  } },
  { method: 'POST', path: '/messages/:id/translations', name: 'inbox_record_translation', roles: support, summary: 'Attach a human translation while preserving the original', run(ctx, { params, body }) {
    const message = ctx.get('message', params.id);
    const language = text(body, 'target_lang', 30);
    const translated = text(body, 'text', 16000);
    return ctx.create('message_translation', { message_id: message.id, message_version: message.version, target_lang: language, text: translated, origin: 'human', created_by: ctx.actorId });
  } },
  { method: 'GET', path: '/messages/:id/translations', name: 'inbox_list_translations', roles: READ, summary: 'Read human translations for a message', run(ctx, { params }) {
    ctx.get('message', params.id);
    return ctx.list('message_translation').filter(row => row.message_id === params.id);
  } },
  { method: 'GET', path: '/inbox/review-sources', name: 'inbox_list_review_sources', roles: support, summary: 'List manual public review sources', run: ctx => ctx.list('review_source') },
  { method: 'POST', path: '/inbox/review-sources', name: 'inbox_register_review_source', roles: ADMIN, summary: 'Register a manual public review import source', run(ctx, { body }) {
    return ctx.create('review_source', { label: text(body, 'label'), source_url: sourceUrl(body), mode: 'manual_import' });
  } },
  { method: 'POST', path: '/inbox/review-sources/:id/import', name: 'inbox_import_review', roles: ADMIN, summary: 'Import a public rating and its source link', run(ctx, { params, body }) {
    const source = ctx.get('review_source', params.id);
    const id = text(body, 'external_review_id');
    const { rating, scale_max } = body;
    if (typeof rating !== 'number' || !Number.isFinite(rating) || typeof scale_max !== 'number' || !Number.isSafeInteger(scale_max) || scale_max < 1 || scale_max > 100 || rating < 0 || rating > scale_max) return invalid('rating or scale_max');
    const source_url = sourceUrl(body);
    if (new URL(source_url).origin !== new URL(String(source.source_url)).origin) return invalid('source_url origin');
    const values = { source_id: source.id, external_review_id: id, source_url, rating, scale_max, editable_by_brand: false, reply_capability: 'unknown' };
    const existing = ctx.list('review').find(review => review.source_id === source.id && review.external_review_id === id);
    return existing ? ctx.update('review', existing.id, values) : ctx.create('review', { ...values, status: 'open' });
  } },
  { method: 'GET', path: '/reviews', name: 'inbox_list_reviews', roles: READ, summary: 'List public reviews and rating scales', run(ctx, { query }) {
    return ctx.list('review').filter(row => (!query.source_id || row.source_id === query.source_id) && (!query.status || row.status === query.status) && (!query.rating || row.rating === Number(query.rating)));
  } },
  { method: 'GET', path: '/inbox/review-summary', name: 'inbox_get_review_summary', roles: READ, summary: 'Report observed public ratings by source and scale', run(ctx, { query }) {
    const groups = new Map<string, { source_id: string; scale_max: number; sample_count: number; rating_total: number; replies_verified_manually: number }>();
    for (const review of ctx.list('review')) {
      const source_id = String(review.source_id);
      if (query.source_id && query.source_id !== source_id) continue;
      const scale_max = Number(review.scale_max);
      const key = JSON.stringify([source_id, scale_max]);
      const group = groups.get(key) ?? { source_id, scale_max, sample_count: 0, rating_total: 0, replies_verified_manually: 0 };
      group.sample_count++;
      group.rating_total += Number(review.rating);
      if (review.status === 'reply_verified_manually') group.replies_verified_manually++;
      groups.set(key, group);
    }
    const items = [...groups.values()].map(({ rating_total, ...group }) => ({
      ...group, average_rating: rating_total / group.sample_count,
    }));
    return { items, coverage: 'imported_public_reviews' };
  } },
  { method: 'POST', path: '/reviews/:id/handoff', name: 'inbox_handoff_review', roles: support, versionKind: 'review', summary: 'Assign a public review for manual follow-up', run(ctx, { params, body }) {
    const review = ctx.get('review', params.id);
    if (review.status !== 'open') return blocked('Only an open review can be handed off');
    const assignee = text(body, 'assignee_user_id');
    const row = ctx.update('review', review.id, { assignee_user_id: assignee, status: 'handed_off', handed_off_at: ctx.now });
    ctx.emit('inbox.review.handed_off', { review_id: row.id, assignee_user_id: assignee });
    return row;
  } },
  { method: 'GET', path: '/reviews/:id', name: 'inbox_get_review', roles: support, summary: 'Read the public review and manual reply verification history', run(ctx, { params }) {
    return { ...ctx.get('review', params.id), verification_history: ctx.list('review_reply_check').filter(row => row.review_id === params.id) };
  } },
  { method: 'POST', path: '/reviews/:id/verify-reply', name: 'inbox_verify_review_reply', roles: support, versionKind: 'review', summary: 'Record manually observed platform reply evidence', run(ctx, { params, body }) {
    const review = ctx.get('review', params.id);
    if (review.status !== 'handed_off') return blocked('Hand off the review before recording a platform reply');
    const reply_url = sourceUrl({ source_url: body.reply_url });
    if (new URL(reply_url).origin !== new URL(String(review.source_url)).origin) return invalid('reply_url origin');
    const evidence_note = text(body, 'evidence_note', 2000);
    ctx.create('review_reply_check', { review_id: review.id, reply_url, evidence_note, actor_id: ctx.actorId, observed_at: ctx.now, verification: 'manual' });
    ctx.emit('inbox.review.reply_verified', { review_id: review.id, verification: 'manual' });
    return ctx.update('review', review.id, { status: 'reply_verified_manually' });
  } },
  { method: 'POST', path: '/inbox/participants/:id/link-customer', name: 'inbox_link_participant', roles: support, versionKind: 'participant', summary: 'Link a participant to an evidenced customer identity', run(ctx, { params, body }) {
    const participant = ctx.get('participant', params.id);
    if (participant.customer_identity_id) return blocked('Undo the current link before creating another');
    const identity = ctx.get('customer_identity', text(body, 'customer_identity_id'));
    const customer = ctx.get('customer', String(identity.customer_id));
    const conversations = ctx.list('conversation').filter(row => row.primary_participant_id === participant.id);
    if (customer.status !== 'active' || (customer.brand_id && (!conversations.length || conversations.some(row => row.brand_id !== customer.brand_id)))) return blocked('Customer is inactive or belongs to a different brand');
    const evidence = body.evidence_id === undefined ? null : ctx.get('evidence', text(body, 'evidence_id'));
    const confirmation = evidence ? null : text(body, 'manual_confirmation', 2000);
    const next = ctx.update('participant', participant.id, { customer_identity_id: identity.id });
    ctx.create('participant_link', { participant_id: participant.id, prior_identity_id: null, customer_identity_id: identity.id, evidence_id: evidence?.id ?? null, manual_confirmation: confirmation, actor_id: ctx.actorId });
    ctx.emit('inbox.participant.linked', { participant_id: participant.id, customer_identity_id: identity.id });
    return next;
  } },
  { method: 'DELETE', path: '/inbox/participants/:id/link-customer', name: 'inbox_unlink_participant', roles: support, versionKind: 'participant', summary: 'Remove a manually linked customer identity', run(ctx, { params, body }) {
    const participant = ctx.get('participant', params.id);
    if (!participant.customer_identity_id) return participant;
    const reason = text(body, 'reason', 2000);
    ctx.create('participant_link', { participant_id: participant.id, prior_identity_id: participant.customer_identity_id, customer_identity_id: null, reason, actor_id: ctx.actorId });
    const next = ctx.update('participant', participant.id, { customer_identity_id: null });
    ctx.emit('inbox.participant.unlinked', { participant_id: participant.id });
    return next;
  } },
  ...(['PATCH', 'DELETE'] as const).map((method): Operation => ({
    method, path: '/notes/:id', name: method === 'PATCH' ? 'inbox_update_note' : 'inbox_delete_note', roles: support,
    versionKind: 'internal_note', summary: 'Manage an internal note', run(ctx, { params, body }) {
      const note = ctx.get('internal_note', params.id);
      if (note.deleted_at) throw new Problem(404, 'NOT_FOUND', 'Note was deleted');
      if (note.created_by !== ctx.actorId && !ADMIN.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Only the author or an admin may manage the note');
      return ctx.update('internal_note', note.id, method === 'PATCH' ? { body: text(body, 'body', 16000) } : { deleted_at: ctx.now });
    },
  })),
];
