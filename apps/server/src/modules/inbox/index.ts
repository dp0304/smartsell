import { createHash } from 'node:crypto';
import { admins, DomainError, readers, required, reviewers, text, writers } from '../types.ts';
import type { Commands, Context, Entity, Fields } from '../types.ts';
import { businessClock, localDate, minute, weeklyMinutes, type Calendar } from './business-hours.js';

const module = 'inbox';
const statuses = ['open', 'waiting_customer', 'snoozed', 'resolved'] as const;
export { operations } from './operations.js';

const pendingReplies = ['queued', 'running', 'accepted', 'outcome_unknown', 'manual', 'retryable'];
const list = (ctx: Context, kind: string) => ctx.list(module, kind);
const get = (ctx: Context, kind: string, id: string) => required(ctx, module, kind, id);
const insert = (ctx: Context, kind: string, data: Fields, id?: string) => ctx.insert(module, kind, data, id);
const update = (ctx: Context, row: Entity, data: Fields) => ctx.update(module, row.kind, row.id, data, row.version);
const stableId = (...key: string[]) => createHash('sha256').update(JSON.stringify(key)).digest('hex');
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const invalid = (key: string): never => { throw new DomainError('invalid_input', `Invalid ${key}`); };
const conflict = (code: string, message: string): never => { throw new DomainError(code, message, 409); };
const optional = (input: Fields, key: string, max = 240) => input[key] == null ? null : text(input, key, max);
function choice<T extends string>(input: Fields, key: string, options: readonly T[], fallback?: T): T {
  const value = input[key] === undefined ? fallback : input[key];
  return options.includes(value) ? value : invalid(key);
}
function date(input: Fields, key: string): string {
  const value = text(input, key, 48);
  return /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : invalid(key);
}
function stringList(input: Fields, key: string): string[] {
  const value: unknown = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return invalid(key);
  return [...new Set(value.map(entry => text({ [key]: entry }, key, 240)))];
}
function checkVersion(row: Entity, input: Fields) {
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) invalid('expected_version');
  if (row.version !== input.expected_version) conflict('version_conflict', 'Record changed. Refresh and try again.');
}
async function conversation(ctx: Context, id: string): Promise<Entity> {
  let row = await get(ctx, 'conversation', id);
  while (row.data.merged_into_id) row = await get(ctx, 'conversation', row.data.merged_into_id);
  return row;
}
async function activity(ctx: Context, row: Entity, type: string, from: unknown, to: unknown) {
  await insert(ctx, 'conversation_activity', { conversation_id: row.id, type, from_value: from ?? null, to_value: to ?? null, actor_id: ctx.actorId, via: 'workspace' });
}
async function setStatus(ctx: Context, row: Entity, status: string, snoozeUntil: string | null = null) {
  if (row.data.status === status && row.data.snooze_until === snoozeUntil) return row;
  const reopened = row.data.status === 'resolved' && status === 'open';
  const next = await update(ctx, row, {
    status, snooze_until: snoozeUntil,
    resolved_at: status === 'resolved' ? ctx.now : null, resolved_by: status === 'resolved' ? ctx.actorId : null,
    reopened_count: row.data.reopened_count + Number(reopened),
  });
  await activity(ctx, row, reopened ? 'reopened' : 'status_changed', row.data.status, status);
  await ctx.emit(reopened ? 'inbox.conversation.reopened' : 'inbox.conversation.status_changed', { conversation_id: row.id, from: row.data.status, to: status });
  await syncSla(ctx, next);
  return next;
}
function compareMessages(a: Entity, b: Entity) {
  return a.data.platform_created_at.localeCompare(b.data.platform_created_at) || a.id.localeCompare(b.id);
}
async function mergeThread(ctx: Context, from: Entity, into: Entity) {
  for (const kind of ['message', 'internal_note', 'conversation_activity', 'reply_draft', 'outbound_reply']) {
    for (const row of await list(ctx, kind)) {
      if (row.data.conversation_id === from.id) await update(ctx, row, { conversation_id: into.id });
    }
  }
  const sourceLease = await ctx.get(module, 'conversation_occupancy', from.id);
  const targetLease = await ctx.get(module, 'conversation_occupancy', into.id);
  if (sourceLease) {
    await revokeLease(ctx, sourceLease);
    if (targetLease?.data.holder_id) await revokeLease(ctx, targetLease);
  }
  const sourceSla = await ctx.get(module, 'conversation_sla', from.id);
  const targetSla = await ctx.get(module, 'conversation_sla', into.id);
  if (sourceSla) {
    if (!targetSla || sourceSla.data.started_at < targetSla.data.started_at) {
      const data = { ...sourceSla.data, conversation_id: into.id };
      if (targetSla) await update(ctx, targetSla, data);
      else await insert(ctx, 'conversation_sla', data, into.id);
    }
    await update(ctx, sourceSla, { merged_into_id: into.id });
  }
  const tagIds = [...new Set([...into.data.tag_ids, ...from.data.tag_ids])];
  into = await update(ctx, into, {
    tag_ids: tagIds,
    assignee_user_id: into.data.assignee_user_id ?? from.data.assignee_user_id,
    inbound_revision: into.data.inbound_revision + from.data.inbound_revision + 1,
  });
  await update(ctx, from, { merged_into_id: into.id });
  await activity(ctx, into, 'thread_merged', from.id, into.id);
  await ctx.emit('inbox.conversation.merged', { from_conversation_id: from.id, conversation_id: into.id });
  return into;
}

async function ingestMessage(ctx: Context, input: Fields) {
  const account = text(input, 'social_account_id', 240);
  const brand = text(input, 'brand_id', 240);
  const provider = text(input, 'provider', 80);
  const externalId = text(input, 'external_message_id', 240);
  const parentId = optional(input, 'parent_external_id');
  const threadId = optional(input, 'external_thread_id');
  const kind = choice(input, 'kind', ['comment_thread', 'private_thread', 'mention', 'ad_comment'] as const);
  if (parentId === externalId || (kind === 'private_thread' && !threadId && !parentId)) invalid('external_thread_id or parent_external_id');
  const direction = choice(input, 'direction', ['inbound', 'outbound'] as const, 'inbound');
  const platformCreatedAt = date(input, 'platform_created_at');
  const platformUpdatedAt = input.platform_updated_at == null ? platformCreatedAt : date(input, 'platform_updated_at');
  if (platformUpdatedAt < platformCreatedAt) invalid('platform_updated_at');
  const body = input.body_text == null ? null : text(input, 'body_text', 16000);
  const state = choice(input, 'platform_state', ['visible', 'hidden', 'deleted_by_author', 'deleted_by_us', 'unknown'] as const, 'visible');
  const accountMessages = (await list(ctx, 'message')).filter(row => row.data.social_account_id === account);
  const existing = accountMessages.find(row => row.data.external_message_id === externalId);
  if (existing) {
    const row = await conversation(ctx, existing.data.conversation_id);
    if (row.data.brand_id !== brand || row.data.kind !== kind || row.data.provider !== provider || existing.data.direction !== direction) conflict('thread_conflict', 'Conflicting message identity');
    const changed = platformUpdatedAt > existing.data.platform_updated_at ||
      (platformUpdatedAt === existing.data.platform_updated_at && input.platform_updated_at == null && !existing.data.has_platform_revision && existing.data.body_text === body && existing.data.platform_state !== state);
    if (!changed) return { conversation: row, message: existing, deduplicated: true };
    const editHistory = existing.data.body_text === body ? existing.data.edit_history : [...existing.data.edit_history, {
      body_text: existing.data.body_text, platform_updated_at: existing.data.platform_updated_at,
    }];
    const message = await update(ctx, existing, { body_text: body, platform_state: state, platform_updated_at: platformUpdatedAt, has_platform_revision: input.platform_updated_at != null, edit_history: editHistory });
    if (existing.data.direction === 'inbound' && existing.data.body_text !== body) await update(ctx, row, { inbound_revision: row.data.inbound_revision + 1 });
    await ctx.emit('inbox.message.updated', { conversation_id: row.id, message_id: message.id });
    return { conversation: await conversation(ctx, row.id), message, deduplicated: false };
  }

  const parent = accountMessages.find(row => row.data.external_message_id === parentId);
  const parentThread = parent ? await conversation(ctx, parent.data.conversation_id) : null;
  const key = threadId ?? parentId ?? externalId;
  const conversations = (await list(ctx, 'conversation')).filter(row => row.data.social_account_id === account && row.data.kind === kind);
  const keyed = conversations.find(row => row.data.external_thread_id === key);
  const children = accountMessages.filter(row => row.data.parent_external_id === externalId);
  let row = parentThread ?? (keyed && await conversation(ctx, keyed.id)) ?? await insert(ctx, 'conversation', {
    brand_id: brand, social_account_id: account, provider, kind, external_thread_id: key,
    provisional: !!parentId && !threadId, platform_post_id: optional(input, 'platform_post_id'), external_url: httpUrl(input, 'external_url'),
    status: 'open', priority: 'normal', tag_ids: [], assignee_user_id: null, snooze_until: null,
    primary_participant_id: null, inbound_revision: 0, inbound_since_last_reply: 0, reopened_count: 0,
    sync_state: 'synced', last_message_id: null, last_inbound_at: null, last_outbound_at: null,
  }, stableId('conversation', account, kind, key));
  if (row.data.brand_id !== brand || row.data.kind !== kind || row.data.provider !== provider) conflict('thread_conflict', 'Parent belongs to a different conversation scope');
  const isNew = !parentThread && !keyed;
  if (isNew) await ctx.emit('inbox.conversation.created', { conversation_id: row.id });
  if (!parentId && row.data.external_thread_id === key && row.data.provisional) row = await update(ctx, row, { provisional: false });
  for (const id of new Set([...(keyed ? [keyed.id] : []), ...children.map(child => child.data.conversation_id)])) {
    const other = await conversation(ctx, id);
    if (other.id !== row.id && other.data.kind === kind && other.data.brand_id === brand && other.data.provider === provider && other.data.provisional) row = await mergeThread(ctx, other, row);
  }

  const externalUserId = optional(input, 'external_user_id');
  let participantId: string | null = null;
  if (externalUserId) {
    participantId = stableId('participant', provider, account, externalUserId);
    const participant = await ctx.get(module, 'participant', participantId);
    if (!participant) participantId = (await insert(ctx, 'participant', {
      provider, scope_account_id: account, external_user_id: externalUserId, handle: optional(input, 'handle'),
      display_name: optional(input, 'display_name'), is_own_account: direction === 'outbound', first_seen_at: ctx.now, last_seen_at: ctx.now,
    }, participantId)).id;
    else { participantId = participant.id; await update(ctx, participant, { last_seen_at: ctx.now }); }
  }
  const message = await insert(ctx, 'message', {
    conversation_id: row.id, social_account_id: account, external_message_id: externalId, parent_external_id: parentId,
    author_participant_id: participantId, direction, visibility: kind === 'private_thread' ? 'private' : 'public',
    body_text: body, platform_state: state, platform_created_at: platformCreatedAt, platform_updated_at: platformUpdatedAt,
    has_platform_revision: input.platform_updated_at != null, edit_history: [],
    sent_via: direction === 'outbound' ? 'native' : null,
    source: choice(input, 'source', ['webhook', 'poll', 'import', 'manual'] as const, 'import'),
  }, stableId('message', account, externalId));
  const messages = (await list(ctx, 'message')).filter(item => item.data.conversation_id === row.id).sort(compareMessages);
  const inbound = messages.filter(item => item.data.direction === 'inbound');
  const lastOutbound = messages.findLast(item => item.data.direction === 'outbound');
  const known = new Set(messages.map(item => item.data.external_message_id));
  const missingParents = [...new Set(messages.map(item => item.data.parent_external_id).filter(id => id && !known.has(id)))];
  row = await update(ctx, row, {
    primary_participant_id: row.data.primary_participant_id ?? inbound.find(item => item.data.author_participant_id)?.data.author_participant_id ?? null,
    inbound_revision: row.data.inbound_revision + Number(direction === 'inbound'),
    last_message_id: messages.at(-1)?.id,
    last_inbound_at: inbound.at(-1)?.data.platform_created_at ?? null,
    last_outbound_at: lastOutbound?.data.platform_created_at ?? null,
    inbound_since_last_reply: inbound.filter(item => !lastOutbound || compareMessages(item, lastOutbound) > 0).length,
    sync_state: missingParents.length ? 'partial' : 'synced', missing_parent_external_ids: missingParents,
  });
  if (direction === 'inbound') {
    if (row.data.status !== 'open' && (!row.data.last_outbound_at || platformCreatedAt >= row.data.last_outbound_at) && (!row.data.resolved_at || platformCreatedAt >= row.data.resolved_at)) row = await setStatus(ctx, row, 'open');
    await ctx.emit('inbox.message.received', { conversation_id: row.id, message_id: message.id });
  } else if (row.data.status === 'open' && row.data.last_message_id === message.id) row = await setStatus(ctx, row, 'waiting_customer');
  await syncSla(ctx, row);
  if (direction === 'inbound') await evaluateDraftRules(ctx, row, message);
  return { conversation: row, message, deduplicated: false };
}

function activeLease(lease: Entity | undefined, now: string): lease is Entity {
  return !!lease?.data.holder_id && lease.data.lease_expires_at > now;
}
function leaseHolder(ctx: Context) {
  const credential = (ctx as Context & { agentCredentialId?: string }).agentCredentialId;
  return credential
    ? { holder_type: 'agent_client', holder_id: credential, holder_user_id: ctx.actorId }
    : { holder_type: 'user', holder_id: ctx.actorId, holder_user_id: ctx.actorId };
}
function holdsLease(ctx: Context, lease: Entity) {
  const holder = leaseHolder(ctx);
  return lease.data.holder_type === holder.holder_type && lease.data.holder_id === holder.holder_id;
}
async function revokeLease(ctx: Context, lease: Entity) {
  await update(ctx, lease, { holder_id: null, holder_user_id: null, lease_expires_at: ctx.now, fencing_token: lease.data.fencing_token + 1 });
  await activity(ctx, await get(ctx, 'conversation', lease.data.conversation_id ?? lease.id), 'released', lease.data.holder_id, null);
}

/** Invoke with the same scoped transaction as the authoritative membership change. */
export async function releaseMemberOccupancy(ctx: Context, userId: string): Promise<number> {
  const leases = (await list(ctx, 'conversation_occupancy')).filter(row => row.data.holder_user_id === userId || (row.data.holder_type === 'user' && row.data.holder_id === userId));
  for (const lease of leases) await revokeLease(ctx, lease);
  return leases.length;
}
async function awaitingReply(ctx: Context, id: string) {
  return (await list(ctx, 'outbound_reply')).find(row => row.data.conversation_id === id && pendingReplies.includes(row.data.status));
}
async function changeDraft(ctx: Context, input: Fields, from: string, status: string) {
  const draft = await get(ctx, 'reply_draft', text(input, 'reply_draft_id', 240));
  checkVersion(draft, input);
  if (draft.data.status !== from) conflict('invalid_status', `Draft must be ${from}`);
  if (draft.data.auto_rule_id && status === 'approved') {
    const thread = await conversation(ctx, draft.data.conversation_id);
    const message = await get(ctx, 'message', draft.data.in_reply_to_message_id);
    if (thread.id !== draft.data.conversation_id || thread.data.status !== 'open' ||
      thread.data.inbound_revision !== draft.data.based_on_inbound_revision || thread.data.last_message_id !== message.id ||
      message.data.platform_state !== 'visible' || await awaitingReply(ctx, thread.id)) {
      return conflict('PRECHECK_BLOCKED', 'The rule-generated reply is stale or no longer actionable');
    }
  }
  const row = await update(ctx, draft, { status, ...(status === 'approved' && { approved_by: ctx.actorId, approved_at: ctx.now }) });
  await ctx.emit(`inbox.reply_draft.${status}`, { reply_draft_id: row.id, conversation_id: row.data.conversation_id });
  return row;
}

const iso = (ms: number) => new Date(ms).toISOString();
function positiveMinutes(input: Fields, key: string) {
  const value = input[key];
  return Number.isSafeInteger(value) && value > 0 && value <= 525600 ? value as number : invalid(key);
}
async function slaPolicyFields(ctx: Context, input: Fields) {
  const conditions: Fields = {};
  if (input.conditions !== undefined) {
    if (!input.conditions || typeof input.conditions !== 'object' || Array.isArray(input.conditions)) return invalid('conditions');
    for (const key of Object.keys(input.conditions)) {
      if (key === 'tag_ids') conditions[key] = stringList(input.conditions, key);
      else if (['social_account_id', 'kind', 'priority'].includes(key)) conditions[key] = text(input.conditions, key, 240);
      else return invalid('conditions');
    }
  }
  const pause = stringList(input, 'pause_on_status');
  if (pause.some(status => status !== 'waiting_customer' && status !== 'snoozed')) return invalid('pause_on_status');
  const businessHoursId = optional(input, 'business_hours_id');
  const first = positiveMinutes(input, 'first_response_minutes');
  const resolution = positiveMinutes(input, 'resolution_minutes');
  if (businessHoursId) {
    const calendar = await get(ctx, 'business_hours', businessHoursId);
    if (calendar.data.archived_at || Math.max(first, resolution) > weeklyMinutes(calendar.data as Calendar) * 104) {
      return invalid('business_hours_id or service target (maximum 104 weeks of recurring hours)');
    }
  }
  return {
    name: text(input, 'name', 120), conditions, pause_on_status: pause,
    first_response_minutes: first, resolution_minutes: resolution, business_hours_id: businessHoursId,
  };
}
async function syncSla(ctx: Context, row: Entity) {
  if (!row.data.last_inbound_at || row.data.merged_into_id) return;
  let sla = await ctx.get(module, 'conversation_sla', row.id);
  if (!sla) {
    const policy = (await list(ctx, 'sla_policy')).filter(item =>
      !item.data.archived_at && Object.entries(item.data.conditions as Fields).every(([key, value]) =>
        key === 'tag_ids' ? (value as string[]).every(tag => row.data.tag_ids.includes(tag)) : row.data[key] === value))
      .sort((a, b) => Object.keys(b.data.conditions).length - Object.keys(a.data.conditions).length || a.id.localeCompare(b.id))[0];
    if (!policy) return;
    const firstInbound = (await list(ctx, 'message')).filter(item => item.data.conversation_id === row.id && item.data.direction === 'inbound').sort(compareMessages)[0];
    if (!firstInbound) return;
    const start = firstInbound.data.platform_created_at as string;
    const calendar = policy.data.business_hours_id ? (await get(ctx, 'business_hours', policy.data.business_hours_id)).data as Calendar : null;
    const clock = businessClock(calendar);
    sla = await insert(ctx, 'conversation_sla', {
      conversation_id: row.id, policy_id: policy.id, started_at: start, business_hours: calendar,
      first_response_due_at: iso(clock.add(Date.parse(start), policy.data.first_response_minutes * minute)),
      resolution_due_at: iso(clock.add(Date.parse(start), policy.data.resolution_minutes * minute)),
      paused_seconds: 0, pause_on_status: policy.data.pause_on_status,
      paused_at: null, first_responded_at: null, resolution_at: null,
      breached_first: false, breached_resolution: false, at_risk_first: false, at_risk_resolution: false,
    }, row.id);
  }
  const data = sla.data;
  const pause = data.pause_on_status.includes(row.data.status);
  const firstResponse = data.first_responded_at ?? (await list(ctx, 'message'))
    .filter(item => item.data.conversation_id === row.id && item.data.direction === 'outbound' && item.data.platform_created_at >= data.started_at)
    .sort(compareMessages)[0]?.data.platform_created_at ??
    (row.data.last_outbound_at >= data.started_at ? row.data.last_outbound_at : null);
  const clock = businessClock(data.business_hours ?? null);
  const pausedAt = pause ? data.paused_at ?? ctx.now : null;
  const pauseStart = data.paused_at ? Date.parse(data.paused_at) : null;
  const now = Date.parse(ctx.now);
  const delta = !pause && pauseStart !== null ? clock.between(pauseStart, now) : 0;
  const next: Fields = {
    paused_at: pausedAt, paused_seconds: data.paused_seconds + delta / 1000,
    first_responded_at: firstResponse, resolution_at: data.resolution_at ?? row.data.resolved_at ?? null,
  };
  const targets = [
    ['first', 'first_response_due_at', firstResponse, data.first_responded_at],
    ['resolution', 'resolution_due_at', next.resolution_at, data.resolution_at],
  ];
  for (const [target, due, completed, wasCompleted] of targets) {
    const originalDue = Date.parse(data[due]);
    const completionTime = completed ? Date.parse(completed) : null;
    const resumedAt = completionTime ?? (pause ? null : now);
    const extend = !wasCompleted && !data[`breached_${target}`] && pauseStart !== null && resumedAt !== null &&
      originalDue > pauseStart && clock.between(pauseStart, resumedAt) > 0;
    next[due] = extend ? iso(clock.add(resumedAt, clock.between(pauseStart, originalDue))) : data[due];
    const asOf = completionTime ?? (pausedAt ? Date.parse(pausedAt) : now);
    const deadline = Date.parse(next[due]);
    if (asOf >= deadline && !data[`breached_${target}`]) {
      next[`breached_${target}`] = true;
      await ctx.emit('inbox.sla.breached', { conversation_id: row.id, target, due_at: next[due] });
    } else if (!completed && !pause && deadline > asOf && !data[`at_risk_${target}`] &&
      clock.contains(asOf) && clock.between(asOf, deadline, 15 * minute) <= 15 * minute) {
      next[`at_risk_${target}`] = true;
      await ctx.emit('inbox.sla.at_risk', { conversation_id: row.id, target, due_at: next[due] });
    }
  }
  if (Object.entries(next).some(([key, value]) => data[key] !== value)) await update(ctx, sla, next);
}

export const commands: Commands = {
  ingest_message: { roles: admins, run: (ctx, input) => ingestMessage(ctx, { ...input, source: 'import' }) },
  ingest_batch: { roles: admins, async run(ctx, input) {
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 100) return invalid('messages');
    const items = [];
    for (const message of input.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return invalid('messages');
      items.push(await ingestMessage(ctx, { ...message, source: 'import' }));
    }
    return { items };
  } },
  list: { roles: readers, async run(ctx, input) {
    const view = choice(input, 'view', ['all', 'unassigned', 'mine', 'open', 'waiting', 'snoozed', 'resolved'] as const, 'all');
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return invalid('limit');
    const items = (await list(ctx, 'conversation')).filter(row => {
      const data = row.data;
      if (data.merged_into_id || ['kind', 'brand_id', 'social_account_id', 'priority'].some(key => input[key] !== undefined && input[key] !== data[key])) return false;
      if (input.tag_id !== undefined && !data.tag_ids.includes(input.tag_id)) return false;
      if (view === 'all') return true;
      if (view === 'unassigned') return !data.assignee_user_id && data.status !== 'resolved';
      if (view === 'mine') return data.assignee_user_id === ctx.actorId && data.status !== 'resolved';
      return data.status === (view === 'waiting' ? 'waiting_customer' : view);
    }).sort((a, b) => (b.data.last_inbound_at ?? '').localeCompare(a.data.last_inbound_at ?? '') || a.id.localeCompare(b.id));
    return { items: items.slice(0, limit), as_of: (await list(ctx, 'message')).reduce<string | null>((last, row) => !last || row.updated_at > last ? row.updated_at : last, null) };
  } },
  get_conversation: { roles: readers, async run(ctx, input) {
    const row = await conversation(ctx, text(input, 'conversation_id', 240));
    const byConversation = async (kind: string) => (await list(ctx, kind)).filter(item => item.data.conversation_id === row.id);
    const rows = input.include_messages === false ? [] : (await byConversation('message')).sort(compareMessages);
    const start = input.after == null ? 0 : rows.findIndex(message => message.id === input.after) + 1;
    if (input.after != null && start === 0) return invalid('after');
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return invalid('limit');
    const page = rows.slice(start, start + limit);
    const translations = new Map<string, Entity[]>();
    if (page.length) {
      const versions = new Map(page.map(message => [message.id, message.version]));
      for (const translation of await list(ctx, 'message_translation')) {
        const { message_id, message_version } = translation.data;
        if (versions.get(message_id) !== message_version || !versions.has(message_id)) continue;
        const attached = translations.get(message_id) ?? [];
        attached.push(translation);
        translations.set(message_id, attached);
      }
    }
    const messages = page.map(message => {
      const { body_text, edit_history, ...data } = message.data;
      const visibleTranslations = (translations.get(message.id) ?? []).map(({ id, data }) => ({ id, target_lang: data.target_lang, text: data.text }));
      return { ...message, data: { ...data, translations: visibleTranslations, untrusted_content: { body_text, edit_history } } };
    });
    return {
      conversation: row, messages, next_cursor: rows.length > start + limit ? messages.at(-1)?.id : null, notes: (await byConversation('internal_note')).filter(note => !note.data.deleted_at),
      reply_drafts: (await byConversation('reply_draft'))
        .filter(draft => ['editing', 'pending_approval', 'approved'].includes(draft.data.status))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
        .map(({ id, data }) => ({ id, status: data.status, body_text: data.body_text })),
      activity: await byConversation('conversation_activity'), occupancy: await ctx.get(module, 'conversation_occupancy', row.id),
      sla: await ctx.get(module, 'conversation_sla', row.id),
    };
  } },
  update_conversation: { roles: writers, async run(ctx, input) {
    const id = text(input, 'conversation_id', 240);
    let row = await conversation(ctx, id);
    if (row.id !== id) conflict('thread_merged', 'Open the merged conversation before editing');
    checkVersion(row, input);
    const status = choice(input, 'status', statuses, row.data.status);
    const snooze = status === 'snoozed' ? date({ ...input, snooze_until: input.snooze_until ?? row.data.snooze_until }, 'snooze_until') : null;
    if (snooze && snooze <= ctx.now) return invalid('snooze_until');
    const patch: Fields = {};
    if (input.priority !== undefined) patch.priority = choice(input, 'priority', ['low', 'normal', 'high', 'urgent'] as const);
    if (input.assignee_user_id !== undefined) patch.assignee_user_id = optional(input, 'assignee_user_id');
    if (input.tag_ids !== undefined) patch.tag_ids = stringList(input, 'tag_ids');
    if (patch.assignee_user_id !== undefined && patch.assignee_user_id !== row.data.assignee_user_id) {
      await activity(ctx, row, 'assigned', row.data.assignee_user_id, patch.assignee_user_id);
      await ctx.emit('inbox.conversation.assigned', { conversation_id: id, assignee_user_id: patch.assignee_user_id });
    }
    for (const key of ['priority', 'tag_ids']) {
      if (patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(row.data[key])) await activity(ctx, row, `${key}_changed`, row.data[key], patch[key]);
    }
    if (Object.keys(patch).length) row = await update(ctx, row, patch);
    return setStatus(ctx, row, status, snooze);
  } },
  unsnooze: { roles: admins, async run(ctx) {
    let count = 0;
    for (const row of await list(ctx, 'conversation')) {
      if (!row.data.merged_into_id && row.data.status === 'snoozed' && row.data.snooze_until <= ctx.now) {
        await setStatus(ctx, row, 'open');
        count++;
      }
    }
    return { count };
  } },
  mark_read: { roles: readers, async run(ctx, input) {
    const row = await conversation(ctx, text(input, 'conversation_id', 240));
    const message = await get(ctx, 'message', text(input, 'message_id', 240));
    if (message.data.conversation_id !== row.id) return invalid('message_id');
    const id = stableId('read', row.id, ctx.actorId);
    const previous = await ctx.get(module, 'conversation_read_state', id);
    const patch = { user_id: ctx.actorId, conversation_id: row.id, last_read_message_id: message.id, read_at: ctx.now };
    if (previous) {
      const lastRead = await get(ctx, 'message', previous.data.last_read_message_id);
      return compareMessages(lastRead, message) >= 0 ? previous : update(ctx, previous, patch);
    }
    return insert(ctx, 'conversation_read_state', patch, id);
  } },
  claim: { roles: writers, async run(ctx, input) {
    const row = await conversation(ctx, text(input, 'conversation_id', 240));
    const purpose = choice(input, 'purpose', ['reply', 'review', 'moderate'] as const, 'reply');
    const lease = await ctx.get(module, 'conversation_occupancy', row.id);
    const active = activeLease(lease, ctx.now);
    if (active && !holdsLease(ctx, lease)) conflict('LEASE_HELD', 'Conversation already has an active lease');
    // A new lease can resolve an outstanding attempt, but cannot submit a second reply.
    const renewing = active && lease.data.purpose === purpose;
    const holder = leaseHolder(ctx);
    const patch = {
      conversation_id: row.id, ...holder, purpose,
      acquired_at: renewing ? lease.data.acquired_at : ctx.now, lease_expires_at: iso(Date.parse(ctx.now) + 5 * minute),
      fencing_token: renewing ? lease.data.fencing_token : (lease?.data.fencing_token ?? 0) + 1,
      based_on_message_id: renewing ? lease.data.based_on_message_id : row.data.last_message_id,
    };
    if (!renewing) await activity(ctx, row, 'occupied', lease?.data.holder_id, holder.holder_id);
    return lease ? update(ctx, lease, patch) : insert(ctx, 'conversation_occupancy', patch, row.id);
  } },
  release: { roles: writers, async run(ctx, input) {
    const row = await conversation(ctx, text(input, 'conversation_id', 240));
    const lease = await ctx.get(module, 'conversation_occupancy', row.id);
    if (!activeLease(lease, ctx.now) || !holdsLease(ctx, lease) || input.fencing_token !== lease.data.fencing_token) return conflict('LEASE_HELD', 'The active lease and its current fencing token are required');
    const handover = optional(input, 'handover_to_user_id');
    if (handover) {
      if (await awaitingReply(ctx, row.id)) conflict('OUTCOME_UNKNOWN', 'An outbound reply still needs verification');
      await activity(ctx, row, 'handed_over', ctx.actorId, handover);
      return update(ctx, lease, { holder_type: 'user', holder_id: handover, holder_user_id: handover, fencing_token: lease.data.fencing_token + 1, acquired_at: ctx.now, lease_expires_at: iso(Date.parse(ctx.now) + 5 * minute), based_on_message_id: row.data.last_message_id });
    }
    await revokeLease(ctx, lease);
    return { released: true };
  } },
  reap_occupancy: { roles: admins, async run(ctx) {
    let count = 0;
    for (const lease of await list(ctx, 'conversation_occupancy')) {
      if (lease.data.holder_id && lease.data.lease_expires_at <= ctx.now && !await awaitingReply(ctx, lease.data.conversation_id ?? lease.id)) {
        await revokeLease(ctx, lease);
        count++;
      }
    }
    return { count };
  } },
  draft_reply: { roles: writers, async run(ctx, input) {
    const row = await conversation(ctx, text(input, 'conversation_id', 240));
    if (!row.data.last_message_id) return conflict('PRECHECK_BLOCKED', 'The conversation has no message to reply to');
    const target = optional(input, 'in_reply_to_message_id');
    if (target && (await get(ctx, 'message', target)).data.conversation_id !== row.id) return invalid('in_reply_to_message_id');
    const mode = choice(input, 'reply_mode', ['public_reply', 'private_reply', 'dm'] as const, row.data.kind === 'private_thread' ? 'dm' : 'public_reply');
    if ((row.data.kind === 'private_thread') !== (mode === 'dm') || (mode === 'private_reply' && !target)) return invalid('reply_mode');
    const body = text(input, 'body_text', 16000);
    const rowDraft = await insert(ctx, 'reply_draft', {
      conversation_id: row.id, in_reply_to_message_id: target, reply_mode: mode, body_text: body,
      based_on_message_id: row.data.last_message_id, based_on_inbound_revision: row.data.inbound_revision,
      content_hash: hash(body), fact_refs: stringList(input, 'fact_refs'), status: 'editing', created_by: ctx.actorId,
    });
    await ctx.emit('inbox.reply_draft.created', { conversation_id: row.id, reply_draft_id: rowDraft.id });
    return rowDraft;
  } },
  update_reply_draft: { roles: writers, async run(ctx, input) {
    const draft = await get(ctx, 'reply_draft', text(input, 'reply_draft_id', 240));
    checkVersion(draft, input);
    if (draft.data.status === 'submitted' || draft.data.status === 'discarded' || (draft.data.auto_rule_id && draft.data.status === 'approved')) {
      return conflict('invalid_status', 'Draft cannot be edited');
    }
    const row = await conversation(ctx, draft.data.conversation_id);
    const body = text(input, 'body_text', 16000);
    const updated = await update(ctx, draft, {
      body_text: body, content_hash: hash(body), status: 'editing',
      based_on_message_id: row.data.last_message_id, based_on_inbound_revision: row.data.inbound_revision,
    });
    await ctx.emit('inbox.reply_draft.updated', { reply_draft_id: draft.id, conversation_id: row.id });
    return updated;
  } },
  submit_reply_approval: { roles: writers, run: (ctx, input) => changeDraft(ctx, input, 'editing', 'pending_approval') },
  approve_reply: { roles: reviewers, run: (ctx, input) => changeDraft(ctx, input, 'pending_approval', 'approved') },
  send_reply: { roles: writers, async run(ctx, input) {
    const draft = await get(ctx, 'reply_draft', text(input, 'reply_draft_id', 240));
    const key = text(input, 'idempotency_key', 240);
    const holder = leaseHolder(ctx);
    const credentialId = holder.holder_type === 'agent_client' ? holder.holder_id : null;
    const existing = (await list(ctx, 'outbound_reply')).find(item => item.data.idempotency_key === key);
    if (existing) {
      if (existing.data.reply_draft_id !== draft.id || existing.data.requested_by !== ctx.actorId || (existing.data.requested_credential_id ?? null) !== credentialId) return conflict('IDEMPOTENCY_CONFLICT', 'Reply key is already in use');
      return existing;
    }
    const row = await conversation(ctx, draft.data.conversation_id);
    const lease = await ctx.get(module, 'conversation_occupancy', row.id);
    if (!activeLease(lease, ctx.now) || !holdsLease(ctx, lease) || lease.data.purpose !== 'reply' || input.fencing_token !== lease.data.fencing_token) return conflict('LEASE_HELD', 'The active reply lease and its current fencing token are required');
    if (await awaitingReply(ctx, row.id)) return conflict('OUTCOME_UNKNOWN', 'An outbound reply still needs verification');
    checkVersion(draft, input);
    if (row.data.status === 'resolved' || row.data.inbound_revision !== draft.data.based_on_inbound_revision) return conflict('PRECHECK_BLOCKED', 'Conversation changed since the draft was written');
    if (draft.data.status !== 'approved') return conflict('APPROVAL_REQUIRED', 'Reply draft requires approval');
    const mode = choice(input, 'mode', ['manual', 'api'] as const, 'manual');
    if (row.data.kind === 'review' && mode === 'api') return conflict('CAPABILITY_UNAVAILABLE', 'Review replies require an approved review adapter');
    if (mode === 'api') await requireCapability(ctx, row, draft.data.reply_mode);
    const target = draft.data.in_reply_to_message_id ? await get(ctx, 'message', draft.data.in_reply_to_message_id) : null;
    const reply = await insert(ctx, 'outbound_reply', {
      conversation_id: row.id, reply_draft_id: draft.id, draft_content_hash: draft.data.content_hash,
      social_account_id: row.data.social_account_id, reply_mode: draft.data.reply_mode,
      target_external_id: target?.data.external_message_id ?? row.data.external_thread_id,
      status: mode === 'manual' ? 'manual' : 'queued', needs_verification: false, current_attempt_no: 0, result_message_id: null,
      idempotency_key: key, executor: mode, submitted_via: 'workspace',
      verification_requested_at: ctx.now, requested_by: ctx.actorId, requested_credential_id: credentialId, fencing_token: lease.data.fencing_token,
    }, stableId('outbound_reply', draft.id));
    await update(ctx, draft, { status: 'submitted' });
    await ctx.emit('inbox.reply.submitted', { conversation_id: row.id, outbound_reply_id: reply.id, social_account_id: row.data.social_account_id, executor: mode });
    return reply;
  } },
  get_reply_status: { roles: readers, async run(ctx, input) {
    const reply = await get(ctx, 'outbound_reply', text(input, 'outbound_reply_id', 240));
    const attempts = (await list(ctx, 'outbound_reply_attempt')).filter(row => row.data.outbound_reply_id === reply.id);
    const ids = new Set(attempts.map(row => row.id));
    return { reply, attempts, receipts: (await list(ctx, 'outbound_reply_receipt')).filter(row => ids.has(row.data.outbound_reply_attempt_id)) };
  } },
  reconcile_reply: { roles: writers, async run(ctx, input) {
    const reply = await get(ctx, 'outbound_reply', text(input, 'outbound_reply_id', 240));
    if (reply.data.status === 'delivered') return reply;
    if (!['accepted', 'outcome_unknown', 'manual'].includes(reply.data.status) || !reply.data.current_attempt_no) return conflict('invalid_status', 'No platform attempt awaiting verification');
    const attempt = await currentAttempt(ctx, reply);
    const row = await conversation(ctx, reply.data.conversation_id);
    const candidates = (await list(ctx, 'message')).filter(message => {
      const data = message.data;
      const targetMatches = reply.data.reply_mode === 'dm' || data.parent_external_id === reply.data.target_external_id;
      return data.conversation_id === row.id && data.social_account_id === reply.data.social_account_id && data.direction === 'outbound' &&
        ['poll', 'webhook'].includes(data.source) && data.platform_state === 'visible' && targetMatches && !data.outbound_reply_id &&
        typeof data.body_text === 'string' && hash(data.body_text) === reply.data.draft_content_hash &&
        Math.abs(Date.parse(data.platform_created_at) - Date.parse(attempt.data.started_at)) <= 10 * minute;
    });
    if (candidates.length !== 1) {
      const checks = (reply.data.verification_checks ?? 0) + 1;
      if (reply.data.status === 'manual') return reply;
      if (reply.data.status === 'accepted') {
        const next = await update(ctx, attempt, { outcome: 'outcome_unknown', finished_at: ctx.now });
        await emitAttempt(ctx, reply, next, 'outcome_unknown');
      }
      return update(ctx, reply, { verification_checks: checks, needs_verification: true, status: checks >= 3 ? 'manual' : 'outcome_unknown' });
    }
    const message = candidates[0];
    await update(ctx, message, { outbound_reply_id: reply.id, sent_via: 'system' });
    const next = await update(ctx, attempt, { outcome: 'delivered', finished_at: ctx.now });
    const delivered = await update(ctx, reply, { status: 'delivered', needs_verification: false, result_message_id: message.id, verification: 'platform_readback' });
    await emitAttempt(ctx, delivered, next, 'delivered');
    return delivered;
  } },
  manual_complete_reply: { roles: writers, async run(ctx, input) {
    const reply = await get(ctx, 'outbound_reply', text(input, 'outbound_reply_id', 240));
    checkVersion(reply, input);
    if (!['manual', 'accepted', 'outcome_unknown', 'failed', 'retryable'].includes(reply.data.status)) return conflict('invalid_status', 'Reply cannot be completed manually');
    const row = await conversation(ctx, reply.data.conversation_id);
    const lease = await requireReplyLease(ctx, row, input);
    const platformUrl = httpUrl(input, 'platform_url');
    const evidenceIds = stringList(input, 'evidence_ids');
    if (!platformUrl && !evidenceIds.length) return invalid('platform_url or evidence_ids');
    for (const id of evidenceIds) await required(ctx, 'core', 'evidence', id);
    const attempt = await insert(ctx, 'outbound_reply_attempt', {
      outbound_reply_id: reply.id, attempt_no: reply.data.current_attempt_no + 1, executor: 'manual',
      submitted_by: 'human', started_at: ctx.now, finished_at: ctx.now, fencing_token: lease.data.fencing_token,
      outcome: 'delivered', platform_url: platformUrl, evidence_ids: evidenceIds, recorded_by: ctx.actorId,
    });
    const delivered = await update(ctx, reply, { status: 'delivered', needs_verification: false, current_attempt_no: attempt.data.attempt_no, verification: 'manual_evidence' });
    const draft = await get(ctx, 'reply_draft', reply.data.reply_draft_id);
    if (row.data.status === 'open' && row.data.inbound_revision === draft.data.based_on_inbound_revision) {
      await setStatus(ctx, await update(ctx, row, { last_outbound_at: ctx.now, inbound_since_last_reply: 0 }), 'waiting_customer');
    }
    await emitAttempt(ctx, delivered, attempt, 'delivered');
    return delivered;
  } },
  retry_reply: { roles: writers, async run(ctx, input) {
    const reply = await get(ctx, 'outbound_reply', text(input, 'outbound_reply_id', 240));
    checkVersion(reply, input);
    if (reply.data.status !== 'retryable' || (await currentAttempt(ctx, reply)).data.outcome !== 'not_delivered') return conflict('OUTCOME_UNKNOWN', 'Retry requires confirmed non-delivery');
    const row = await conversation(ctx, reply.data.conversation_id);
    const lease = await requireReplyLease(ctx, row, input);
    await checkReplyBaseline(ctx, reply, row);
    await requireCapability(ctx, row, reply.data.reply_mode);
    const queued = await update(ctx, reply, { status: 'queued', needs_verification: false, verification_checks: 0, fencing_token: lease.data.fencing_token });
    await ctx.emit('inbox.reply.submitted', { conversation_id: row.id, outbound_reply_id: reply.id, social_account_id: reply.data.social_account_id, executor: reply.data.executor });
    return queued;
  } },
  cancel_reply: { roles: admins, async run(ctx, input) {
    const reply = await get(ctx, 'outbound_reply', text(input, 'outbound_reply_id', 240));
    checkVersion(reply, input);
    if (!['queued', 'retryable', 'failed'].includes(reply.data.status) && !(reply.data.status === 'manual' && !reply.data.current_attempt_no)) {
      return conflict('OUTCOME_UNKNOWN', 'Resolve the uncertain platform outcome before cancelling');
    }
    const cancelled = await update(ctx, reply, { status: 'cancelled', needs_verification: false, resolved_by: ctx.actorId });
    await ctx.emit('inbox.reply.cancelled', { conversation_id: reply.data.conversation_id, outbound_reply_id: reply.id });
    return cancelled;
  } },
  batch_conversations: { roles: writers, async run(ctx, input) {
    const ids = stringList(input, 'conversation_ids');
    if (!ids.length || typeof input.dry_run !== 'boolean') return invalid('conversation_ids or dry_run');
    const rows = await Promise.all(ids.map(id => conversation(ctx, id)));
    if (rows.some((row, idx) => row.id !== ids[idx])) return conflict('thread_merged', 'Use the current conversation ID');
    if (input.dry_run) return { conversation_ids: ids, count: ids.length };
    const items = [];
    for (const row of rows) items.push(await commands.update_conversation.run(ctx, { ...input, conversation_id: row.id, expected_version: row.version }));
    return { items };
  } },
  add_note: { roles: writers, async run(ctx, input) {
    const row = await conversation(ctx, text(input, 'conversation_id', 240));
    const anchor = optional(input, 'anchor_message_id');
    if (anchor && (await get(ctx, 'message', anchor)).data.conversation_id !== row.id) return invalid('anchor_message_id');
    const mentions = stringList(input, 'mentions');
    const note = await insert(ctx, 'internal_note', { conversation_id: row.id, anchor_message_id: anchor, body: text(input, 'body', 16000), mentions, created_by: ctx.actorId });
    await ctx.emit('inbox.note.created', { conversation_id: row.id, note_id: note.id });
    if (mentions.length) await ctx.emit('inbox.note.mentioned', { conversation_id: row.id, note_id: note.id, mentions });
    return note;
  } },
  create_sla_policy: { roles: admins, async run(ctx, input) {
    const policy = await insert(ctx, 'sla_policy', await slaPolicyFields(ctx, input));
    await ctx.emit('inbox.sla.policy_created', { policy_id: policy.id });
    return policy;
  } },
  update_sla_policy: { roles: admins, async run(ctx, input) {
    const policy = await get(ctx, 'sla_policy', text(input, 'policy_id', 240));
    checkVersion(policy, input);
    if (policy.data.archived_at) return conflict('INVALID_STATE', 'Policy is archived');
    const next = await update(ctx, policy, await slaPolicyFields(ctx, { ...policy.data, ...input }));
    await ctx.emit('inbox.sla.policy_updated', { policy_id: policy.id });
    return next;
  } },
  sla_tick: { roles: admins, async run(ctx) {
    for (const row of await list(ctx, 'conversation')) await syncSla(ctx, row);
    return { checked_at: ctx.now };
  } },
};

function httpUrl(input: Fields, key: string) {
  const value = optional(input, key, 2048);
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return invalid(key); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return invalid(key);
  return value;
}
async function requireReplyLease(ctx: Context, row: Entity, input: Fields) {
  const lease = await ctx.get(module, 'conversation_occupancy', row.id);
  if (!activeLease(lease, ctx.now) || !holdsLease(ctx, lease) || lease.data.purpose !== 'reply' || lease.data.fencing_token !== input.fencing_token) {
    return conflict('LEASE_HELD', 'A current reply lease is required');
  }
  return lease;
}
async function currentAttempt(ctx: Context, reply: Entity) {
  return (await list(ctx, 'outbound_reply_attempt')).find(row => row.data.outbound_reply_id === reply.id && row.data.attempt_no === reply.data.current_attempt_no)
    ?? conflict('invalid_status', 'No current attempt');
}
async function checkReplyBaseline(ctx: Context, reply: Entity, row: Entity) {
  const draft = await get(ctx, 'reply_draft', reply.data.reply_draft_id);
  if (draft.data.based_on_inbound_revision !== row.data.inbound_revision || draft.data.content_hash !== reply.data.draft_content_hash || row.data.status === 'resolved') {
    return conflict('PRECHECK_BLOCKED', 'Conversation or draft changed before sending');
  }
}
async function requireCapability(ctx: Context, row: Entity, mode: string) {
  const capability = mode === 'dm' ? 'dm.send' : mode === 'private_reply' ? 'comment.private_reply' : 'comment.reply';
  const capabilities = await list(ctx, 'inbox_capability');
  if (!capabilities.some(item => item.data.social_account_id === row.data.social_account_id && item.data.capability === capability && item.data.status === 'available' &&
    (!item.data.valid_until || item.data.valid_until > ctx.now))) return conflict('CAPABILITY_UNAVAILABLE', 'No usable API capability for this reply');
}
async function emitAttempt(ctx: Context, reply: Entity, attempt: Entity, status: string) {
  await ctx.emit(`inbox.reply.${status}`, {
    conversation_id: reply.data.conversation_id, outbound_reply_id: reply.id, outbound_reply_attempt_id: attempt.id,
    social_account_id: reply.data.social_account_id, executor: attempt.data.executor, submitted_by: attempt.data.submitted_by ?? null,
    connector_channel: null, mobile_device_id: null, error_class: attempt.data.error_class ?? null,
  });
}

/** Trusted sync adapters supply authenticated platform observations. */
export async function ingestPlatformMessage(ctx: Context, input: Fields) {
  return ingestMessage(ctx, { ...input, source: choice(input, 'source', ['poll', 'webhook'] as const) });
}

/** The executor enforces platform limits and acquires the account write slot before opening an API attempt. */
export async function beginReplyAttempt(ctx: Context, replyId: string, requestId: string) {
  const reply = await get(ctx, 'outbound_reply', replyId);
  if (reply.data.status !== 'queued' || reply.data.executor !== 'api') return conflict('invalid_status', 'Reply is not queued for API execution');
  const row = await conversation(ctx, reply.data.conversation_id);
  const lease = await ctx.get(module, 'conversation_occupancy', row.id);
  if (!activeLease(lease, ctx.now) || lease.data.fencing_token !== reply.data.fencing_token) return conflict('LEASE_HELD', 'Reply lease expired or changed');
  await checkReplyBaseline(ctx, reply, row);
  await requireCapability(ctx, row, reply.data.reply_mode);
  const clientRequestId = text({ requestId }, 'requestId', 240);
  if ((await list(ctx, 'outbound_reply_attempt')).some(item => item.data.client_request_id === clientRequestId)) return conflict('DUPLICATE_ATTEMPT', 'Request ID was already used');
  const attempt = await insert(ctx, 'outbound_reply_attempt', {
    outbound_reply_id: reply.id, attempt_no: reply.data.current_attempt_no + 1, executor: 'api', client_request_id: clientRequestId,
    started_at: ctx.now, fencing_token: lease.data.fencing_token,
  });
  await update(ctx, reply, { status: 'running', current_attempt_no: attempt.data.attempt_no });
  return attempt;
}

/** The adapter receives only the approved draft and the routing fields needed for this attempt. */
export async function startReplyDispatch(ctx: Context, replyId: string, requestId: string) {
  const attempt = await beginReplyAttempt(ctx, replyId, requestId);
  const reply = await get(ctx, 'outbound_reply', replyId);
  const draft = await get(ctx, 'reply_draft', reply.data.reply_draft_id);
  return { attempt, payload: {
    social_account_id: reply.data.social_account_id, target_external_id: reply.data.target_external_id,
    reply_mode: reply.data.reply_mode, body_text: draft.data.body_text,
  } };
}

/** Only trusted executor callbacks may record receipts or confirm non-delivery. */
export async function recordReplyReceipt(ctx: Context, attemptId: string, input: Fields) {
  const attempt = await get(ctx, 'outbound_reply_attempt', attemptId);
  const reply = await get(ctx, 'outbound_reply', attempt.data.outbound_reply_id);
  if (attempt.data.executor !== 'api' || attempt.data.attempt_no !== reply.data.current_attempt_no) return conflict('STALE_ATTEMPT', 'Receipt does not match the current API attempt');
  const outcome = choice(input, 'outcome', ['accepted', 'outcome_unknown', 'failed', 'not_delivered'] as const);
  const receiptRef = optional(input, 'receipt_ref');
  const errorClass = optional(input, 'error_class');
  if (attempt.data.outcome === outcome && attempt.data.receipt_ref === receiptRef && attempt.data.error_class === errorClass) return reply;
  const allowed: Record<string, string[]> = {
    running: ['accepted', 'outcome_unknown', 'failed', 'not_delivered'], accepted: ['outcome_unknown', 'not_delivered'],
    outcome_unknown: ['not_delivered'], failed: ['not_delivered'], manual: ['not_delivered'],
  };
  if (!allowed[reply.data.status]?.includes(outcome)) return conflict('invalid_status', 'Receipt conflicts with the current outcome');
  if (outcome !== 'outcome_unknown' && !receiptRef) return invalid('receipt_ref');
  await insert(ctx, 'outbound_reply_receipt', { outbound_reply_attempt_id: attempt.id, outcome, receipt_ref: receiptRef, error_class: errorClass, recorded_at: ctx.now });
  const status = outcome === 'not_delivered' ? 'retryable' : outcome;
  const next = await update(ctx, attempt, { outcome, receipt_ref: receiptRef, error_class: errorClass, finished_at: ctx.now, submitted_by: 'auto' });
  const result = await update(ctx, reply, { status, needs_verification: ['accepted', 'outcome_unknown'].includes(status) });
  await emitAttempt(ctx, result, next, status);
  return result;
}

/** Scheduled entry points share the callable operation state and workspace transaction. */
export async function unsnoozeConversations(ctx: import('@smartsell/contracts').Context) {
  const { commandContext } = await import('./operations.js');
  return commands.unsnooze.run(commandContext(ctx), {});
}
export const schedules = [
  { id: 'inbox.sla_tick', intervalMs: minute, async run(ctx: import('@smartsell/contracts').Context) {
    const { commandContext } = await import('./operations.js');
    return commands.sla_tick.run(commandContext(ctx), {});
  } },
  { id: 'inbox.unsnooze', intervalMs: minute, run: unsnoozeConversations },
];

export async function evaluateStoredRules(ctx: Context, id: string) {
  const message = await get(ctx, 'message', id);
  return evaluateDraftRules(ctx, await conversation(ctx, message.data.conversation_id), message, true);
}

async function evaluateDraftRules(ctx: Context, row: Entity, message: Entity, explicit = false) {
  const trusted = ['poll', 'webhook'].includes(message.data.source);
  if (message.data.direction !== 'inbound' || (!trusted && !(explicit && message.data.source === 'import'))) return [];
  const rules = (await list(ctx, 'auto_rule')).filter(rule => rule.data.enabled && !rule.data.archived_at && rule.data.social_account_id === row.data.social_account_id);
  if (!rules.length) return [];
  const account = await ctx.get('account', 'social_account', row.data.social_account_id);
  if (!account || (account.data.brand_id && account.data.brand_id !== row.data.brand_id)) return [];
  const settings = (await ctx.list('workspace', 'workspace'))[0];
  const timezone = settings?.data.default_timezone ?? 'UTC';
  const today = localDate(Date.parse(ctx.now), timezone);
  const runs = await list(ctx, 'auto_rule_run');
  const results = [];
  for (const rule of rules) {
    const existing = runs.find(run => run.data.rule_id === rule.id && run.data.message_id === message.id);
    if (existing) { results.push(existing); continue; }
    const ruleData = rule.data;
    const mentionsKeyword = ruleData.trigger === 'keyword' && typeof message.data.body_text === 'string' && message.data.body_text.toLowerCase().includes(ruleData.keyword);
    const newDM = ruleData.trigger === 'new_dm' && row.data.kind === 'private_thread' && row.data.inbound_revision === 1;
    const afterHours = ruleData.trigger === 'business_hours_off' && ruleData.business_hours_id &&
      !businessClock((await get(ctx, 'business_hours', ruleData.business_hours_id)).data as Calendar).contains(Date.parse(message.data.platform_created_at));
    if (!mentionsKeyword && !newDM && !afterHours) continue;
    const lease = await ctx.get(module, 'conversation_occupancy', row.id);
    const participant = message.data.author_participant_id;
    const priorToday = runs.filter(run => run.data.rule_id === rule.id && run.data.participant_id === participant &&
      run.data.outcome === 'drafted' && localDate(Date.parse(run.created_at), timezone) === today).length;
    const replyMode = row.data.kind === 'private_thread' ? 'dm' : 'public_reply';
    const alreadyReplied = row.data.last_outbound_at && row.data.last_outbound_at >= message.data.platform_created_at;
    let outcome = message.data.platform_state !== 'visible' ? 'skipped_unavailable' :
      alreadyReplied ? 'skipped_replied' :
      row.data.status !== 'open' ? 'skipped_unavailable' :
      activeLease(lease, ctx.now) ? 'skipped_occupied' :
      await awaitingReply(ctx, row.id) ? 'skipped_replied' :
      !participant || priorToday >= ruleData.max_per_participant_per_day ? 'skipped_frequency' :
      row.data.last_message_id !== message.id || Date.parse(message.data.platform_created_at) > Date.parse(ctx.now) ||
        Date.parse(ctx.now) - Date.parse(message.data.platform_created_at) > ruleData.window_minutes * minute ? 'skipped_window' : 'drafted';
    let draftId = null;
    if (outcome === 'drafted' && trusted) {
      try { await requireCapability(ctx, row, replyMode); }
      catch (error) { if (error instanceof DomainError && error.code === 'CAPABILITY_UNAVAILABLE') outcome = 'skipped_capability'; else throw error; }
    }
    if (outcome === 'drafted') {
      const draft = await commands.draft_reply.run(ctx, { conversation_id: row.id, in_reply_to_message_id: message.id, body_text: ruleData.body_text, reply_mode: replyMode }) as Entity;
      draftId = draft.id;
      await update(ctx, draft, { auto_rule_id: rule.id, auto_rule_version: rule.version });
    }
    const result = await insert(ctx, 'auto_rule_run', { rule_id: rule.id, rule_version: rule.version, message_id: message.id,
      conversation_id: row.id, participant_id: participant, outcome, reply_draft_id: draftId }, stableId('auto_rule_run', rule.id, message.id));
    runs.push(result);
    results.push(result);
  }
  return results;
}
