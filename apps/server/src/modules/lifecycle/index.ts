import { createHash, randomBytes } from 'node:crypto';
import { admins, DomainError, readers, required, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { flag, instant, invalid, object, oneOf } from './validation.ts';

const module = 'lifecycle';
const channels = ['email', 'sms', 'whatsapp', 'push', 'site_tracking', 'platform_dm'] as const;
const purposes = ['marketing', 'service'] as const;
export type ConsentChannel = typeof channels[number];
type Purpose = typeof purposes[number];
type Action = 'opt_in' | 'opt_out' | 'withdrawn' | 'pending' | 'imported_state';
type State = 'unknown' | 'pending' | 'opted_in' | 'opted_out';
interface ConsentChange {
  customerId: string;
  channel: ConsentChannel;
  purpose: Purpose;
  action: Action;
  source: 'lp_form' | 'support_request' | 'import' | 'unsubscribe_link';
  sourceRef: string;
  capturedAt: string;
  textVersionId?: string;
  evidenceRef?: string;
  identityId?: string;
}
const opaque = () => randomBytes(24).toString('base64url');
const own = (ctx: Context, kind: string, id: string) => required(ctx, module, kind, id);

export async function getConsentText(ctx: Context, id: string, channel: ConsentChannel, purpose: Purpose) {
  const row = await own(ctx, 'consent_text_version', id);
  if (row.data.channel !== channel || row.data.purpose !== purpose || Date.parse(row.data.effective_from) > Date.parse(ctx.now)) {
    invalid('Consent text is not effective for this channel and purpose');
  }
  return row;
}

function evaluate(rows: Entity[]): { state: State; last_record_id: string | null } {
  // Imported positives carry no proof. At equal timestamps withdrawal has priority.
  const priority = (action: unknown) => action === 'withdrawn' || action === 'opt_out' ? 3 : action === 'opt_in' ? 2 : action === 'pending' ? 1 : 0;
  let result: { state: State; last_record_id: string | null } = { state: 'unknown', last_record_id: null };
  for (const row of [...rows].sort((a, b) => a.data.captured_at.localeCompare(b.data.captured_at) || priority(a.data.action) - priority(b.data.action) || a.id.localeCompare(b.id))) {
    const action = row.data.action;
    let state: State;
    if (action === 'withdrawn' || action === 'opt_out') state = 'opted_out';
    else if (action === 'opt_in') state = 'opted_in';
    else if (action === 'pending' && (result.state === 'unknown' || result.state === 'pending')) state = 'pending';
    else continue;
    result = { state, last_record_id: row.id };
  }
  return result;
}

async function consentRows(ctx: Context, customerId: string, channel: ConsentChannel, purpose: Purpose) {
  return (await ctx.list(module, 'consent_record')).filter(({ data }) => data.customer_id === customerId && data.channel === channel && data.purpose === purpose);
}

export async function serviceContactCustomers(ctx: Context): Promise<Set<string>> {
  const ledger = new Map<string, Map<ConsentChannel, Entity[]>>();
  const customers = new Map((await ctx.list(module, 'customer')).map(row => [row.id, row]));
  for (const row of await ctx.list(module, 'consent_record')) {
    const { customer_id, channel, purpose } = row.data;
    if (purpose !== 'service') continue;
    const byChannel = ledger.get(customer_id) ?? new Map<ConsentChannel, Entity[]>();
    const history = byChannel.get(channel) ?? [];
    history.push(row);
    byChannel.set(channel, history);
    ledger.set(customer_id, byChannel);
  }
  return new Set([...ledger].filter(([id, channels]) => {
    const customer = customers.get(id);
    return customer?.data.status === 'active' && [...channels].some(([channel, history]) =>
      !(Array.isArray(customer.data.suppressed_channels) && customer.data.suppressed_channels.includes(channel)) &&
      evaluate(history).state === 'opted_in');
  }).map(([id]) => id));
}

async function appendConsent(ctx: Context, change: ConsentChange) {
  const customer = await own(ctx, 'customer', change.customerId);
  if (customer.data.status !== 'active') throw new DomainError('state_conflict', 'Customer is inactive', 409);
  if (change.textVersionId) {
    const copy = await getConsentText(ctx, change.textVersionId, change.channel, change.purpose);
    if (Date.parse(copy.data.effective_from) > Date.parse(change.capturedAt)) invalid('Consent text was not effective when consent was captured');
  }
  const rows = await consentRows(ctx, change.customerId, change.channel, change.purpose);
  const before = evaluate(rows);
  const record = await ctx.insert(module, 'consent_record', {
    customer_id: change.customerId, identity_id: change.identityId ?? null, channel: change.channel, purpose: change.purpose,
    action: change.action, source: change.source, source_ref: change.sourceRef, captured_at: change.capturedAt,
    consent_text_version_id: change.textVersionId ?? null, evidence_ref: change.evidenceRef ?? null,
  });
  const after = evaluate([...rows, record]);
  if (before.state !== after.state) {
    await ctx.emit('lifecycle.consent.changed', {
      customer_id: change.customerId, channel: change.channel, purpose: change.purpose,
      previous_state: before.state, state: after.state, consent_record_id: record.id,
    });
  }
  return { record, ...after };
}

async function createCustomer(ctx: Context, data: Fields) {
  const customer = await ctx.insert(module, 'customer', { ...data, status: 'active' });
  await ctx.emit('lifecycle.customer.created', { customer_id: customer.id });
  return customer;
}

/** A public lead attaches to its own identity until a separate verification flow exists. */
export async function recordLeadConsent(ctx: Context, leadId: string, versionId: string, choices: readonly { channel: ConsentChannel; purpose: Purpose; textVersionId: string }[]) {
  const customer = await createCustomer(ctx, { lifecycle_stage: 'prospect' });
  const identity = await ctx.insert(module, 'customer_identity', { customer_id: customer.id, kind: 'lead', source_ref: leadId, verified: false });
  const records: string[] = [];
  for (const choice of choices) {
    const consent = await appendConsent(ctx, {
      ...choice, customerId: customer.id, identityId: identity.id, capturedAt: instant(ctx.now, 'now'),
      action: choice.purpose === 'service' ? 'opt_in' : 'pending', source: 'lp_form', sourceRef: versionId,
    });
    records.push(consent.record.id);
  }
  return { customer_id: customer.id, consent_record_ids: records };
}

/** Called after the public adapter verifies the signature and scopes the transaction to the stored token. */
export async function unsubscribe(ctx: Context, opaqueLinkId: string): Promise<{ unsubscribed: true }> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(opaqueLinkId)) throw new DomainError('not_found', 'Unsubscribe link not found', 404);
  const link = await own(ctx, 'unsubscribe_link', opaqueLinkId);
  if (Date.parse(link.data.expires_at) <= Date.parse(ctx.now)) throw new DomainError('not_found', 'Unsubscribe link not found', 404);
  const channel = oneOf(link.data.channel, channels, 'channel');
  // A repeated token cannot withdraw a later, independently recorded opt-in.
  if (!link.data.used_at) {
    await ctx.update(module, 'unsubscribe_link', link.id, { used_at: ctx.now }, link.version);
    await appendConsent(ctx, {
      customerId: link.data.customer_id, channel, purpose: 'marketing', action: 'opt_out',
      source: 'unsubscribe_link', sourceRef: link.id, capturedAt: instant(ctx.now, 'now'),
    });
  }
  return { unsubscribed: true };
}

function segmentDefinition(value: unknown) {
  const data = object(value, ['market_id', 'primary_locale', 'lifecycle_stage', 'product_id', 'interacted_since']);
  return {
    ...(data.market_id === undefined ? {} : { market_id: text(data, 'market_id', 128) }),
    ...(data.primary_locale === undefined ? {} : { primary_locale: text(data, 'primary_locale', 35) }),
    ...(data.lifecycle_stage === undefined ? {} : { lifecycle_stage: oneOf(data.lifecycle_stage, ['prospect', 'first_purchase', 'repeat', 'lapsed'], 'lifecycle_stage') }),
    ...(data.product_id === undefined ? {} : { product_id: text(data, 'product_id', 128) }),
    ...(data.interacted_since === undefined ? {} : { interacted_since: instant(data.interacted_since, 'interacted_since') }),
  };
}

function segmentInput(input: Fields) {
  return { definition: segmentDefinition(input.definition ?? {}), channel: oneOf(input.channel, channels, 'channel') };
}

async function addSegmentVersion(ctx: Context, segment: Entity, input: ReturnType<typeof segmentInput>) {
  const version = await ctx.insert(module, 'segment_version', {
    segment_id: segment.id, version_no: (segment.data.version_no ?? 0) + 1,
    definition: input.definition, required_consent: { channel: input.channel, purpose: 'marketing' },
  });
  await ctx.update(module, 'segment', segment.id, { current_version_id: version.id, version_no: version.data.version_no }, segment.version);
  await ctx.emit('lifecycle.segment.version_created', { segment_id: segment.id, segment_version_id: version.id });
  return version;
}

export const commands = {
  create_customer: { roles: admins, async run(ctx, input) {
    const data = object(input, ['market_id', 'primary_locale', 'lifecycle_stage', 'product_ids', 'last_interaction_at']);
    const stage = data.lifecycle_stage === undefined ? 'prospect' : oneOf(data.lifecycle_stage, ['prospect', 'first_purchase', 'repeat', 'lapsed'], 'lifecycle_stage');
    const products = data.product_ids ?? [];
    if (!Array.isArray(products) || products.length > 200) invalid('Invalid product_ids');
    return createCustomer(ctx, {
      market_id: data.market_id === undefined ? null : text(data, 'market_id', 128),
      primary_locale: data.primary_locale === undefined ? null : text(data, 'primary_locale', 35),
      lifecycle_stage: stage, product_ids: [...new Set(products.map(value => text({ value }, 'value', 128)))],
      last_interaction_at: data.last_interaction_at === undefined ? null : instant(data.last_interaction_at, 'last_interaction_at'),
    });
  } },
  create_consent_text: { roles: admins, async run(ctx, input) {
    object(input, ['channel', 'purpose', 'locale', 'text', 'effective_from']);
    const copy = text(input, 'text');
    return ctx.insert(module, 'consent_text_version', {
      channel: oneOf(input.channel, channels, 'channel'), purpose: oneOf(input.purpose, purposes, 'purpose'),
      locale: text(input, 'locale', 35), text: copy, content_hash: createHash('sha256').update(copy).digest('hex'),
      effective_from: instant(input.effective_from ?? ctx.now, 'effective_from'),
    });
  } },
  record_consent: { roles: admins, async run(ctx, input) {
    object(input, ['customer_id', 'channel', 'purpose', 'action', 'consent_text_version_id', 'evidence_ref', 'captured_at']);
    const action = oneOf(input.action, ['opt_in', 'opt_out', 'withdrawn', 'imported_state'], 'action');
    const capturedAt = instant(input.captured_at ?? ctx.now, 'captured_at');
    if (Date.parse(capturedAt) > Date.parse(ctx.now)) invalid('Consent cannot be captured in the future');
    return appendConsent(ctx, {
      customerId: text(input, 'customer_id', 128), channel: oneOf(input.channel, channels, 'channel'),
      purpose: oneOf(input.purpose, purposes, 'purpose'), action, capturedAt,
      evidenceRef: text(input, 'evidence_ref', 240), source: action === 'imported_state' ? 'import' : 'support_request', sourceRef: ctx.actorId,
      ...(action === 'opt_in' ? { textVersionId: text(input, 'consent_text_version_id', 128) } : {}),
    });
  } },
  get_consent_state: { roles: admins, async run(ctx, input) {
    object(input, ['customer_id', 'channel', 'purpose']);
    const customer = await own(ctx, 'customer', text(input, 'customer_id', 128));
    return evaluate(await consentRows(ctx, customer.id, oneOf(input.channel, channels, 'channel'), oneOf(input.purpose, purposes, 'purpose')));
  } },
  create_unsubscribe_link: { roles: admins, async run(ctx, input) {
    object(input, ['customer_id', 'channel']);
    const customer = await own(ctx, 'customer', text(input, 'customer_id', 128));
    const channel = oneOf(input.channel, channels, 'channel');
    if (customer.data.status !== 'active') throw new DomainError('state_conflict', 'Customer is inactive', 409);
    return ctx.insert(module, 'unsubscribe_link', {
      customer_id: customer.id, channel, expires_at: new Date(Date.parse(ctx.now) + 30 * 86_400_000).toISOString(),
    }, opaque());
  } },
  create_segment: { roles: writers, async run(ctx, input) {
    object(input, ['name', 'definition', 'channel']);
    const definition = segmentInput(input);
    const segment = await ctx.insert(module, 'segment', { name: text(input, 'name', 160), mode: 'local_definition' });
    const version = await addSegmentVersion(ctx, segment, definition);
    return { segment_id: segment.id, version };
  } },
  revise_segment: { roles: writers, async run(ctx, input) {
    object(input, ['segment_id', 'expected_version', 'definition', 'channel']);
    const segment = await own(ctx, 'segment', text(input, 'segment_id', 128));
    if (input.expected_version !== segment.version) throw new DomainError('version_conflict', 'Segment version has changed', 409);
    return addSegmentVersion(ctx, segment, segmentInput(input));
  } },
  segments_preview: { roles: readers, async run(ctx, input) {
    object(input, ['segment_version_id', 'definition', 'channel', 'save_snapshot']);
    const save = flag(input.save_snapshot, 'save_snapshot');
    if (save && !writers.includes(ctx.role)) throw new DomainError('forbidden', 'Cannot save audience snapshots', 403);
    if (input.segment_version_id !== undefined && (input.definition !== undefined || input.channel !== undefined)) invalid('Choose one segment definition');
    const version = input.segment_version_id === undefined ? undefined : await own(ctx, 'segment_version', text(input, 'segment_version_id', 128));
    if (save && !version) invalid('A saved snapshot needs a segment version');
    const { definition, channel } = version
      ? segmentInput({ definition: version.data.definition, channel: version.data.required_consent.channel })
      : segmentInput(input);
    const consentByCustomer = new Map<string, Entity[]>();
    for (const row of await ctx.list(module, 'consent_record')) {
      if (row.data.channel !== channel || row.data.purpose !== 'marketing') continue;
      const rows = consentByCustomer.get(row.data.customer_id) ?? [];
      rows.push(row);
      consentByCustomer.set(row.data.customer_id, rows);
    }
    const eligible: string[] = [];
    const excluded = { criteria: 0, inactive: 0, suppression: 0, opted_out: 0, pending: 0, no_consent: 0 };
    for (const { id, data } of await ctx.list(module, 'customer')) {
      if (data.status !== 'active') { excluded.inactive++; continue; }
      if ((definition.market_id && definition.market_id !== data.market_id)
        || (definition.primary_locale && definition.primary_locale !== data.primary_locale)
        || (definition.lifecycle_stage && definition.lifecycle_stage !== data.lifecycle_stage)
        || (definition.product_id && !data.product_ids?.includes(definition.product_id))
        || (definition.interacted_since && (!data.last_interaction_at || data.last_interaction_at < definition.interacted_since))) {
        excluded.criteria++;
        continue;
      }
      if (Array.isArray(data.suppressed_channels) && data.suppressed_channels.includes(channel)) { excluded.suppression++; continue; }
      const { state } = evaluate(consentByCustomer.get(id) ?? []);
      if (state === 'opted_in') eligible.push(id);
      else excluded[state === 'unknown' ? 'no_consent' : state]++;
    }
    const result = { eligible_count: eligible.length, excluded };
    if (!save || !version) return result;
    const snapshot = await ctx.insert(module, 'segment_snapshot', {
      ...result, segment_version_id: version.id, purpose: 'preview', taken_at: ctx.now,
      member_hash: createHash('sha256').update(JSON.stringify(eligible.sort())).digest('hex'),
    });
    return { ...result, snapshot_id: snapshot.id };
  } },
} satisfies Commands;

export { operations } from "./operations.js";
export { recordLeadConsents, recordLeadConsent as recordWorkspaceLeadConsent } from "./consent.js";
