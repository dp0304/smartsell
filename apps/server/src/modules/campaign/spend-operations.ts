import type { Context, Data, Operation, Row } from '@smartsell/contracts';
import { CAMPAIGN, INTERNAL_READ, LEAD, PLAN, campaign, choice, conflict, currency, day, event, fields, hash, integer, invalid, mutable, optionalText, record, rows, scoped, strings, text, version } from './shared.js';

const CATEGORIES = ['ads', 'creator', 'production', 'sample', 'other'] as const;
const SOURCES = ['manual', 'import', 'ads_sync', 'creator_settlement'] as const;
const LINE_FIELDS = ['category', 'amount_minor', 'currency', 'fx_date', 'owner_user_id'];
const COMMITMENT_FIELDS = ['budget_line_id', 'source_ref', 'amount_minor', 'currency', 'status', 'fx_date', 'fx_rate_id'];
const ENTRY_FIELDS = ['budget_line_id', 'commitment_id', 'source', 'amount_minor', 'currency', 'incurred_on', 'fx_rate_id', 'attachment_file_ids'];

function lineValues(ctx: Context, campaign: Row, body: Data): Data {
  return {
    campaign_id: campaign.id, category: choice(body.category, CATEGORIES, 'category'), amount_minor: integer(body.amount_minor, 'amount_minor'),
    currency: currency(body.currency), fx_date: day(body.fx_date, 'fx_date'), owner_user_id: text(body.owner_user_id ?? ctx.actorId, 'owner_user_id'),
  };
}

function exponent(code: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits!;
}
function converted(ctx: Context, record: Data, target: string): bigint {
  const amount = BigInt(record.amount_minor as number);
  const source = String(record.currency);
  if (source === target) return amount;
  if (typeof record.fx_rate_id !== 'string') conflict('Cross-currency amounts need an FX rate');
  const fx = ctx.get('fx_rate', record.fx_rate_id);
  const rate = String(fx.rate);
  if (fx.base !== source || fx.quote !== target || fx.rate_date !== record.fx_date || !/^\d{1,15}(?:\.\d{1,10})?$/.test(rate) || Number(rate) <= 0) {
    invalid('FX rate must match the original currency, budget currency, and conversion date');
  }
  const [whole, fraction = ''] = rate.split('.');
  const numerator = amount * BigInt(`${whole}${fraction}`) * 10n ** BigInt(exponent(target));
  const denominator = 10n ** BigInt(fraction.length + exponent(source));
  return (numerator + denominator / 2n) / denominator;
}
function safeAmount(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) conflict('Budget rollup exceeds the supported amount range');
  return n;
}
function money(ctx: Context, body: Data, line: Row, fxDate: unknown): Data {
  const data = { amount_minor: integer(body.amount_minor, 'amount_minor', 1), currency: currency(body.currency), fx_date: day(fxDate, 'fx_date'), fx_rate_id: optionalText(body.fx_rate_id, 'fx_rate_id') };
  if (data.currency === line.currency && data.fx_rate_id) invalid('Same-currency costs do not use an FX rate');
  converted(ctx, data, String(line.currency));
  return data;
}
function commitmentValues(ctx: Context, campaign: Row, body: Data, before?: Row): Data {
  const line = scoped(ctx, 'budget_line', text(body.budget_line_id, 'budget_line_id'), 'campaign_id', campaign.id);
  const source = record(body.source_ref, 'source_ref');
  fields(source, ['type', 'id']);
  const type = choice(source.type, ['collaboration', 'ad_proposal', 'external_po'], 'source_ref.type');
  const id = text(source.id, 'source_ref.id');
  if (type !== 'external_po') scoped(ctx, type, id, 'campaign_id', campaign.id);
  if (rows(ctx, 'cost_commitment', 'campaign_id', campaign.id).some(item => item.id !== before?.id && item.status !== 'released'
    && (item.source_ref as Data).type === type && (item.source_ref as Data).id === id)) conflict('An active commitment already uses this source');
  const status = choice(body.status ?? 'pending_approval', ['pending_approval', 'committed', 'released'], 'status');
  if (before?.status === 'released' && status !== 'released') conflict('A released commitment cannot be reactivated');
  if (status !== before?.status && status === 'committed' && !LEAD.some(role => role === ctx.role)) conflict('A budget approver must record a confirmed commitment');
  if (!before && status === 'released') invalid('A new commitment cannot be released');
  if (before?.status === 'committed' && status === 'pending_approval') conflict('A confirmed commitment must be released');
  const values = { campaign_id: campaign.id, budget_line_id: line.id, source_ref: { type, id }, status, ...money(ctx, body, line, body.fx_date ?? line.fx_date) };
  if (before && before.status !== 'pending_approval' && hash({ ...values, status: before.status }) !== hash(Object.fromEntries(Object.keys(values).map(key => [key, before[key]])))) {
    conflict('Release the confirmed commitment to change its financial terms');
  }
  return values;
}
function entryValues(ctx: Context, campaign: Row, body: Data): Data {
  const line = scoped(ctx, 'budget_line', text(body.budget_line_id, 'budget_line_id'), 'campaign_id', campaign.id);
  const commitment_id = optionalText(body.commitment_id, 'commitment_id');
  if (commitment_id) {
    const item = scoped(ctx, 'cost_commitment', commitment_id, 'budget_line_id', line.id);
    if (item.status === 'pending_approval') conflict('Only a confirmed or released commitment can be matched to realized costs');
  }
  const incurred_on = day(body.incurred_on, 'incurred_on');
  const attachment_file_ids = strings(body.attachment_file_ids ?? [], 'attachment_file_ids');
  for (const id of attachment_file_ids) ctx.get('file_object', id);
  return { campaign_id: campaign.id, budget_line_id: line.id, commitment_id, source: choice(body.source ?? 'manual', SOURCES, 'source'),
    incurred_on, attachment_file_ids, ...money(ctx, body, line, incurred_on) };
}

type Totals = { budget_minor: number; committed_minor: number; open_commitment_minor: number; pending_approval_minor: number; actual_minor: number; remaining_minor: number; overrun_minor: number };
function totals(budget: bigint, committed: bigint, open: bigint, pending: bigint, actual: bigint): Totals {
  const remaining = budget - open - actual;
  return { budget_minor: safeAmount(budget), committed_minor: safeAmount(committed), open_commitment_minor: safeAmount(open), pending_approval_minor: safeAmount(pending),
    actual_minor: safeAmount(actual), remaining_minor: safeAmount(remaining), overrun_minor: safeAmount(remaining < 0n ? -remaining : 0n) };
}
export function budgetSummary(ctx: Context, campaignId: string) {
  const entries = rows(ctx, 'cost_entry', 'campaign_id', campaignId);
  const commitments = rows(ctx, 'cost_commitment', 'campaign_id', campaignId);
  const byCurrency = new Map<string, bigint[]>();
  const lines = rows(ctx, 'budget_line', 'campaign_id', campaignId).map(line => {
    const code = String(line.currency);
    const paid = new Map<unknown, bigint>();
    let actual = 0n;
    for (const entry of entries.filter(row => row.budget_line_id === line.id)) {
      const amount = converted(ctx, entry, code);
      actual += amount;
      if (entry.commitment_id) paid.set(entry.commitment_id, (paid.get(entry.commitment_id) ?? 0n) + amount);
    }
    let committed = 0n, open = 0n, pending = 0n;
    for (const commitment of commitments.filter(row => row.budget_line_id === line.id)) {
      if (commitment.status === 'released') continue;
      const amount = converted(ctx, commitment, code);
      if (commitment.status === 'pending_approval') { pending += amount; continue; }
      committed += amount;
      const unpaid = amount - (paid.get(commitment.id) ?? 0n);
      if (unpaid > 0n) open += unpaid;
    }
    const budget = BigInt(line.amount_minor as number);
    const values = [budget, committed, open, pending, actual];
    const existing = byCurrency.get(code) ?? [0n, 0n, 0n, 0n, 0n];
    byCurrency.set(code, existing.map((amount, index) => amount + values[index]!));
    return { budget_line_id: line.id, category: line.category, currency: code, fx_date: line.fx_date, ...totals(budget, committed, open, pending, actual) };
  });
  const currencies = [...byCurrency].map(([currency, values]) => ({ currency, ...totals(values[0]!, values[1]!, values[2]!, values[3]!, values[4]!) }));
  return { campaign_id: campaignId, lines, currencies };
}

export function budgetRollup(ctx: Context, campaignId: string): ReturnType<typeof budgetSummary> {
  const summary = budgetSummary(ctx, campaignId);
  const previous = ctx.list('approval_request').filter(row => row.resource_type === 'budget_line'
    && (row.context as Data | undefined)?.campaign_id === campaignId);
  for (const line of summary.lines) {
    const resource_hash = hash(line);
    const active = previous.filter(row => row.resource_id === line.budget_line_id && ['pending', 'approved'].includes(String(row.status)));
    for (const request of active) {
      if (line.overrun_minor === 0 || request.resource_hash !== resource_hash) {
        ctx.update('approval_request', request.id, { status: 'invalidated', invalidated_reason: 'campaign_budget_changed' });
        ctx.emit('core.approval_request.invalidated', { request_id: request.id, resource_type: 'budget_line', resource_id: line.budget_line_id });
      }
    }
    if (line.overrun_minor === 0 || previous.some(item => item.resource_id === line.budget_line_id
      && item.resource_hash === resource_hash && ['pending', 'approved', 'rejected'].includes(String(item.status)))) continue;
    const request = ctx.create('approval_request', { resource_type: 'budget_line', resource_id: line.budget_line_id, resource_hash, status: 'pending', current_step: 1, context: { ...line, campaign_id: campaignId, purpose: 'campaign_budget_overrun' } });
    ctx.emit('core.approval_request.created', { request_id: request.id, resource_type: 'budget_line', resource_id: line.budget_line_id, campaign_id: campaignId });
    event(ctx, 'budget.overrun_detected', campaignId, { ...line, approval_request_id: request.id });
  }
  return summary;
}

/** Imports only verified, unambiguously mapped costs. A source identity survives observation revisions. */
export function applyCampaignCostEvent(ctx: Context, envelope: Data): void {
  const payload = record(envelope.data ?? {}, 'event data');
  const active = new Map(ctx.list('campaign').filter(row => !['closed', 'cancelled'].includes(String(row.status))).map(row => [row.id, row]));
  const affected = new Set<string>();
  function budgetLine(campaignId: string, category: string, code: unknown, pinned?: unknown): Row | undefined {
    const matching = rows(ctx, 'budget_line', 'campaign_id', campaignId).filter(line => line.category === category && line.currency === code);
    return pinned == null ? matching.length === 1 ? matching[0] : undefined : matching.find(line => line.id === pinned);
  }
  if (envelope.type === 'creator.terms.signed' && typeof payload.collaboration_id === 'string' && typeof payload.terms_revision_id === 'string') {
    const collaboration = ctx.get('collaboration', payload.collaboration_id);
    const campaign = active.get(String(collaboration.campaign_id));
    const terms = ctx.get('collaboration_terms', payload.terms_revision_id);
    if (!campaign || terms.collaboration_id !== collaboration.id || collaboration.current_terms_revision_id !== terms.id || terms.sign_status !== 'signed') return;
    const fee = (terms.fee ?? {}) as Data;
    const existing = rows(ctx, 'cost_commitment', 'campaign_id', campaign.id).filter(row => {
      const source = row.source_ref as Data;
      return source.type === 'collaboration' && source.id === collaboration.id && row.status !== 'released';
    });
    if (existing.some(row => row.terms_revision_id === terms.id)) return;
    if (existing.some(row => !row.terms_revision_id)) return;
    const line = budgetLine(campaign.id, 'creator', fee.currency, collaboration.budget_line_id);
    if (!line || typeof fee.amount_minor !== 'number' || !Number.isSafeInteger(fee.amount_minor) || fee.amount_minor <= 0) return;
    for (const old of existing) ctx.update('cost_commitment', old.id, { status: 'released' });
    const commitment = ctx.create('cost_commitment', {
      ...commitmentValues(ctx, campaign, { budget_line_id: line.id, amount_minor: fee.amount_minor, currency: fee.currency, status: 'committed',
        source_ref: { type: 'collaboration', id: collaboration.id }, fx_date: typeof terms.signed_at === 'string' ? terms.signed_at.slice(0, 10) : line.fx_date }), terms_revision_id: terms.id,
    });
    event(ctx, 'budget.changed', campaign.id, { id: commitment.id, kind: 'cost_commitment', action: 'created', budget_line_id: line.id });
    affected.add(campaign.id);
  }
  if (envelope.type === 'analytics.observations.recorded' && payload.subject_type === 'ads.ad_entity' && typeof payload.subject_id === 'string') {
    const ad = ctx.get('ad_entity', payload.subject_id);
    const campaign = active.get(String(ad.campaign_id));
    if (!campaign || ad.level !== 'campaign') return; // Child totals overlap the parent campaign total.
    const observations = rows(ctx, 'metric_observation', 'subject_id', ad.id)
      .filter(row => row.subject_type === 'ads.ad_entity' && row.metric_key === 'ads.spend' && row.period_kind === 'day' && typeof row.native_date === 'string')
      .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)) || b.id.localeCompare(a.id));
    const seen = new Set<string>();
    for (const observation of observations) {
      const date = String(observation.native_date);
      if (seen.has(date)) continue;
      seen.add(date);
      const line = budgetLine(campaign.id, 'ads', observation.currency, ad.budget_line_id);
      if (!line || observation.availability !== 'observed' || typeof observation.value !== 'number' || !Number.isSafeInteger(observation.value) || observation.value < 0) continue;
      const source_key = `ads:${ad.id}:${date}`;
      const prior = rows(ctx, 'cost_entry', 'campaign_id', campaign.id).find(row => row.source_key === source_key);
      if (prior?.observation_id === observation.id) continue;
      if (prior && prior.budget_line_id !== line.id) continue;
      const values = { campaign_id: campaign.id, budget_line_id: line.id, source: 'ads_sync', source_key, observation_id: observation.id,
        amount_minor: observation.value, currency: observation.currency, incurred_on: day(date, 'native_date'), fx_date: date, fx_rate_id: null,
        commitment_id: null, attachment_file_ids: [] };
      const entry = prior ? ctx.update('cost_entry', prior.id, values) : ctx.create('cost_entry', values);
      event(ctx, 'cost_entry.changed', campaign.id, { id: entry.id, kind: 'cost_entry', action: prior ? 'updated' : 'created', budget_line_id: line.id });
      affected.add(campaign.id);
    }
  }
  if (envelope.type === 'creator.settlement.paid' || envelope.type === 'creator.commission.platform_settled') {
    let settledIds: unknown[] = [];
    if (typeof payload.settlement_batch_id === 'string') {
      const batch = ctx.get('settlement_batch', payload.settlement_batch_id);
      if (batch.status === 'paid' && Array.isArray(batch.commission_entry_ids)) settledIds = batch.commission_entry_ids;
    } else if (typeof payload.commission_entry_id === 'string') settledIds = [payload.commission_entry_id];
    for (const id of settledIds) {
      const commission = ctx.get('commission_entry', String(id));
      if (!['paid', 'platform_settled'].includes(String(commission.status)) || commission.kind !== 'accrual') continue;
      const collaboration = ctx.get('collaboration', String(commission.collaboration_id));
      const campaign = active.get(String(collaboration.campaign_id));
      if (!campaign) continue;
      const line = budgetLine(campaign.id, 'creator', commission.currency, collaboration.budget_line_id);
      if (!line || typeof commission.settled_at !== 'string' || typeof commission.commission_minor !== 'number'
        || !Number.isSafeInteger(commission.commission_minor) || commission.commission_minor <= 0) continue;
      const source_key = `commission:${commission.id}`;
      if (rows(ctx, 'cost_entry', 'campaign_id', campaign.id).some(entry => entry.source_key === source_key)) continue;
      const date = day(commission.settled_at.slice(0, 10), 'settled_at');
      const entry = ctx.create('cost_entry', { campaign_id: campaign.id, budget_line_id: line.id, source: 'creator_settlement',
        source_key, commission_entry_id: commission.id, amount_minor: commission.commission_minor, currency: commission.currency,
        incurred_on: date, fx_date: date, fx_rate_id: null, commitment_id: null, attachment_file_ids: [] });
      event(ctx, 'cost_entry.changed', campaign.id, { id: entry.id, kind: 'cost_entry', action: 'created', budget_line_id: line.id });
      affected.add(campaign.id);
    }
  }
  for (const campaignId of affected) budgetRollup(ctx, campaignId);
}

const resources = [
  { path: 'budget-lines', param: 'budgetLineId', kind: 'budget_line', roles: LEAD, fields: LINE_FIELDS, values: lineValues, event: 'budget.changed' },
  { path: 'cost-commitments', param: 'commitmentId', kind: 'cost_commitment', roles: PLAN, fields: COMMITMENT_FIELDS, values: commitmentValues, event: 'budget.changed' },
  { path: 'cost-entries', param: 'entryId', kind: 'cost_entry', roles: PLAN, fields: ENTRY_FIELDS, values: entryValues, event: 'cost_entry.changed' },
] as const;
export const spendOperations: Operation[] = resources.flatMap((resource): Operation[] => {
  const collection = `${CAMPAIGN}/${resource.path}`;
  const item = `${collection}/:${resource.param}`;
  const get = (ctx: Context, id: string, parent: string) => scoped(ctx, resource.kind, id, 'campaign_id', parent);
  function notify(ctx: Context, campaignId: string, row: Row, action: string) {
    event(ctx, resource.event, campaignId, { kind: resource.kind, id: row.id, action, budget_line_id: row.budget_line_id ?? row.id });
    budgetRollup(ctx, campaignId);
  }
  function checkSource(ctx: Context, body: Data, before?: Row) {
    if (resource.kind === 'cost_entry') {
      const source = body.source ?? before?.source ?? 'manual';
      if (source !== 'manual' && source !== 'import') invalid('Automated expenses must originate from their owning integration');
    }
    if (resource.kind === 'cost_commitment' && before?.status === 'committed' && body.status === 'released' && !LEAD.some(role => role === ctx.role)) {
      conflict('A budget approver must release a confirmed commitment');
    }
  }
  return [
    { method: 'GET', path: collection, name: `campaign_${resource.kind}_list`, roles: INTERNAL_READ, summary: `List ${resource.path}`, run: (ctx, input) => rows(ctx, resource.kind, 'campaign_id', campaign(ctx, input).id) },
    { method: 'GET', path: item, name: `campaign_${resource.kind}_get`, roles: INTERNAL_READ, summary: `Read ${resource.kind}`, run: (ctx, input) => get(ctx, input.params[resource.param]!, campaign(ctx, input).id) },
    { method: 'POST', path: collection, name: `campaign_${resource.kind}_create`, roles: resource.roles, summary: `Record ${resource.kind}`, run(ctx, input) {
      const parent = campaign(ctx, input); mutable(parent);
      fields(input.body, resource.fields);
      checkSource(ctx, input.body);
      const row = ctx.create(resource.kind, resource.values(ctx, parent, input.body));
      notify(ctx, parent.id, row, 'created');
      return row;
    } },
    { method: 'PATCH', path: item, name: `campaign_${resource.kind}_update`, roles: resource.roles, summary: `Revise ${resource.kind}`, run(ctx, input) {
      const parent = campaign(ctx, input); mutable(parent);
      const before = get(ctx, input.params[resource.param]!, parent.id);
      version(before, input);
      fields(input.body, [...resource.fields, 'expected_version']);
      checkSource(ctx, input.body, before);
      const values = resource.values(ctx, parent, { ...before, ...input.body }, before);
      if (resource.kind === 'budget_line' && values.currency !== before.currency) conflict('Budget line currency is immutable');
      if (resource.kind !== 'budget_line' && values.budget_line_id !== before.budget_line_id) conflict('Move costs by recording them against their correct budget line');
      const row = ctx.update(resource.kind, before.id, values);
      notify(ctx, parent.id, row, 'updated');
      return row;
    } },
    { method: 'DELETE', path: item, name: `campaign_${resource.kind}_delete`, roles: resource.roles, summary: `Delete an eligible ${resource.kind}`, run(ctx, input) {
      const parent = campaign(ctx, input); mutable(parent);
      const row = get(ctx, input.params[resource.param]!, parent.id);
      version(row, input);
      if (resource.kind === 'budget_line' && ['cost_commitment', 'cost_entry'].some(kind => rows(ctx, kind, 'budget_line_id', row.id).length !== 0)) conflict('A budget line with ledger activity cannot be deleted');
      if (resource.kind === 'cost_commitment' && (row.status !== 'pending_approval' || rows(ctx, 'cost_entry', 'commitment_id', row.id).length)) conflict('Release a confirmed commitment to retain its history');
      if (resource.kind === 'cost_entry') checkSource(ctx, {}, row);
      ctx.remove(resource.kind, row.id);
      notify(ctx, parent.id, row, 'deleted');
      return { id: row.id, deleted: true };
    } },
  ];
});
function reallocationHash(proposal: Row): string {
  const { campaign_id, from_line_id, to_line_id, from_version, to_version, amount_minor, reason } = proposal;
  return hash({ campaign_id, from_line_id, to_line_id, from_version, to_version, amount_minor, reason });
}

spendOperations.push(
  { method: 'GET', path: `${CAMPAIGN}/budget-summary`, name: 'campaign_budget_summary', roles: INTERNAL_READ, summary: 'Summarize budget, outstanding commitments, actuals and overruns by currency', run: (ctx, input) => budgetSummary(ctx, campaign(ctx, input).id) },
  { method: 'GET', path: `${CAMPAIGN}/budget-benchmarks`, name: 'campaign_budget_benchmarks', roles: LEAD, summary: 'Compare planned spend with actuals for similar closed campaigns', run(ctx, input) {
    const parent = campaign(ctx, input);
    const selected = new Set(rows(ctx, 'campaign', 'brand_id', parent.brand_id)
      .filter(row => row.id !== parent.id && row.kind === parent.kind && row.status === 'closed').map(row => row.id));
    const groups = new Map<string, { category: string; currency: string; amounts: bigint[]; campaign_ids: string[] }>();
    for (const closeout of ctx.list('campaign_closeout').filter(row => selected.has(String(row.campaign_id)))) {
      const snapshot = closeout.snapshot as Data | undefined;
      const costs = snapshot?.costs as ReturnType<typeof budgetSummary> | undefined;
      if (!Array.isArray(costs?.lines)) continue;
      const byCampaign = new Map<string, bigint>();
      for (const line of costs.lines) {
        const key = `${line.category}:${line.currency}`;
        byCampaign.set(key, (byCampaign.get(key) ?? 0n) + BigInt(line.actual_minor));
        if (!groups.has(key)) groups.set(key, { category: String(line.category), currency: line.currency, amounts: [], campaign_ids: [] });
      }
      for (const [key, amount] of byCampaign) {
        const group = groups.get(key)!;
        group.amounts.push(amount);
        group.campaign_ids.push(String(closeout.campaign_id));
      }
    }
    return [...groups.values()].map(({ category, currency, amounts, campaign_ids }) => {
      amounts.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      const upper = Math.floor(amounts.length / 2);
      const median = amounts.length % 2 ? amounts[upper]! : (amounts[upper - 1]! + amounts[upper]! + 1n) / 2n;
      return { category, currency, suggested_amount_minor: safeAmount(median), min_minor: safeAmount(amounts[0]!),
        max_minor: safeAmount(amounts.at(-1)!), sample_size: amounts.length, campaign_ids };
    }).sort((a, b) => a.category.localeCompare(b.category) || a.currency.localeCompare(b.currency));
  } },
  { method: 'POST', path: `${CAMPAIGN}/budget-reallocations`, name: 'campaign_budget_reallocation_request', roles: LEAD, summary: 'Request approval to transfer budget between lines in the same currency', run(ctx, input) {
    const parent = campaign(ctx, input); mutable(parent);
    fields(input.body, ['from_line_id', 'to_line_id', 'amount_minor', 'reason']);
    const from = scoped(ctx, 'budget_line', text(input.body.from_line_id, 'from_line_id'), 'campaign_id', parent.id);
    const to = scoped(ctx, 'budget_line', text(input.body.to_line_id, 'to_line_id'), 'campaign_id', parent.id);
    const amount_minor = integer(input.body.amount_minor, 'amount_minor', 1);
    const reason = text(input.body.reason, 'reason');
    if (from.id === to.id || from.currency !== to.currency) invalid('Choose different budget lines in the same currency');
    if (Number(from.amount_minor) < amount_minor) conflict('Source line has insufficient allocated budget');
    safeAmount(BigInt(to.amount_minor as number) + BigInt(amount_minor));
    const proposal = ctx.create('campaign_budget_reallocation', { campaign_id: parent.id, from_line_id: from.id, to_line_id: to.id,
      from_version: from.version, to_version: to.version, amount_minor, reason, status: 'pending', requested_by: ctx.actorId });
    const request = ctx.create('approval_request', { resource_type: 'campaign_budget_reallocation', resource_id: proposal.id,
      resource_hash: reallocationHash(proposal), current_step: 1, status: 'pending', context: { campaign_id: parent.id } });
    ctx.emit('core.approval_request.created', { request_id: request.id, resource_type: request.resource_type, resource_id: proposal.id, campaign_id: parent.id });
    return { ...proposal, approval_request_id: request.id };
  } },
  { method: 'GET', path: `${CAMPAIGN}/budget-approvals`, name: 'campaign_budget_approval_list', roles: LEAD, summary: 'List campaign budget approval requests', run(ctx, input) {
    const parent = campaign(ctx, input);
    return ctx.list('approval_request').filter(row => ['budget_line', 'campaign_budget_reallocation'].includes(String(row.resource_type))
      && (row.context as Data | undefined)?.campaign_id === parent.id);
  } },
  { method: 'POST', path: `${CAMPAIGN}/budget-approvals/:requestId/decide`, name: 'campaign_budget_approval_decide', roles: LEAD, summary: 'Record a human decision on the current overrun', run(ctx, input) {
    const parent = campaign(ctx, input);
    mutable(parent);
    const request = ctx.get('approval_request', input.params.requestId!);
    if (!['budget_line', 'campaign_budget_reallocation'].includes(String(request.resource_type)) || (request.context as Data | undefined)?.campaign_id !== parent.id) invalid('Approval request belongs to another resource');
    version(request, input);
    if (request.status !== 'pending') conflict('The budget approval is no longer current');
    fields(input.body, ['decision', 'reason', 'expected_version']);
    const decision = choice(input.body.decision, ['approve', 'reject'], 'decision');
    const comment = text(input.body.reason, 'reason');
    if (request.resource_type === 'budget_line') {
      const line = budgetSummary(ctx, parent.id).lines.find(row => row.budget_line_id === request.resource_id);
      if (!line || hash(line) !== request.resource_hash) conflict('The budget approval is no longer current');
    } else {
      const proposal = scoped(ctx, 'campaign_budget_reallocation', String(request.resource_id), 'campaign_id', parent.id);
      if (proposal.status !== 'pending' || reallocationHash(proposal) !== request.resource_hash) conflict('The budget proposal is no longer current');
      if (decision === 'approve') {
        const from = scoped(ctx, 'budget_line', String(proposal.from_line_id), 'campaign_id', parent.id);
        const to = scoped(ctx, 'budget_line', String(proposal.to_line_id), 'campaign_id', parent.id);
        const amount = BigInt(proposal.amount_minor as number);
        if (from.version !== proposal.from_version || to.version !== proposal.to_version || BigInt(from.amount_minor as number) < amount) {
          conflict('Budget lines changed after the reallocation was requested');
        }
        ctx.update('budget_line', from.id, { amount_minor: safeAmount(BigInt(from.amount_minor as number) - amount) });
        ctx.update('budget_line', to.id, { amount_minor: safeAmount(BigInt(to.amount_minor as number) + amount) });
        budgetRollup(ctx, parent.id);
        event(ctx, 'budget.changed', parent.id, { reallocation_id: proposal.id, from_line_id: from.id, to_line_id: to.id });
      }
      ctx.update('campaign_budget_reallocation', proposal.id, { status: decision === 'approve' ? 'applied' : 'rejected' });
    }
    ctx.create('approval_decision', { request_id: request.id, step_no: request.current_step, decision, decided_by_user_id: ctx.actorId, comment, decided_at: ctx.now });
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const saved = ctx.update('approval_request', request.id, { status, approved_via: status === 'approved' ? 'human' : null, decided_at: ctx.now });
    ctx.emit(`core.approval_request.${status}`, { request_id: request.id, resource_type: 'budget_line', resource_id: request.resource_id, campaign_id: parent.id });
    return saved;
  } },
);
