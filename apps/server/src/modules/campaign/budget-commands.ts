import type { Commands, Context, Entity, Fields } from '../types.ts';
import { command, conflict, currency, date, emit, expected, fields, getCampaign, integer, invalid, leadRoles, moduleName, mutable, object, options, optionalText, readRoles, related, rows, strings, text, writeRoles } from './command-input.ts';

const categories = ['ads', 'creator', 'production', 'sample', 'other'] as const;
const sources = ['manual', 'import', 'ads_sync', 'creator_settlement'] as const;
const amount = (value: unknown) => integer(value, 'amount_minor', 0);
const money = (value: number) => integer(value, 'aggregate amount_minor', -Number.MAX_SAFE_INTEGER);
const sum = (values: number[]) => values.reduce((total, value) => money(total + value), 0);
const lineKeys = ['category', 'amount_minor', 'currency', 'fx_date', 'owner_user_id'];
const entryKeys = ['budget_line_id', 'commitment_id', 'amount_minor', 'currency', 'fx_date', 'source', 'incurred_on', 'fx_rate_id', 'attachment_file_ids', 'source_ref'];

function lineData(input: Fields) {
  return { category: options(input.category, 'category', categories), amount_minor: amount(input.amount_minor), currency: currency(input.currency),
    fx_date: date(input.fx_date, 'fx_date'), owner_user_id: optionalText(input.owner_user_id, 'owner_user_id') };
}
function monetary(input: Fields, line: Entity) {
  const code = currency(input.currency ?? line.data.currency);
  if (code !== line.data.currency) invalid('Use a budget line denominated in the original cost currency');
  return { amount_minor: amount(input.amount_minor), currency: code, fx_date: date(input.fx_date ?? line.data.fx_date, 'fx_date') };
}

export async function budgetSummary(ctx: Context, campaignId: string) {
  const [lines, commitments, entries] = await Promise.all(['budget_line', 'cost_commitment', 'cost_entry'].map(kind => rows(ctx, kind, campaignId)));
  const perLine = lines.map(line => {
    const actual = entries.filter(entry => entry.data.budget_line_id === line.id && !entry.data.voided_at);
    const committed = commitments.filter(row => row.data.budget_line_id === line.id && row.data.status === 'committed');
    const actual_minor = sum(actual.map(row => row.data.amount_minor));
    const committed_minor = sum(committed.map(row => row.data.amount_minor));
    const outstanding_minor = sum(committed.map(row => Math.max(0, row.data.amount_minor - sum(actual.filter(entry => entry.data.commitment_id === row.id).map(entry => entry.data.amount_minor)))));
    const remaining_minor = money(line.data.amount_minor - money(actual_minor + outstanding_minor));
    return { budget_line_id: line.id, category: line.data.category, currency: line.data.currency, fx_date: line.data.fx_date,
      budget_minor: line.data.amount_minor as number, committed_minor, outstanding_minor, actual_minor, remaining_minor, overrun_minor: Math.max(0, -remaining_minor) };
  });
  const currencies = [...new Set(perLine.map(row => row.currency))];
  const totals = currencies.map(currency => {
    const local = perLine.filter(row => row.currency === currency);
    const remaining_minor = sum(local.map(row => row.remaining_minor));
    return { currency, budget_minor: sum(local.map(row => row.budget_minor)), committed_minor: sum(local.map(row => row.committed_minor)),
      outstanding_minor: sum(local.map(row => row.outstanding_minor)), actual_minor: sum(local.map(row => row.actual_minor)), remaining_minor,
      overrun_minor: Math.max(0, -remaining_minor) };
  });
  return { lines: perLine, totals, commitments, entries };
}

async function ledgerChange(ctx: Context, campaignId: string, lineId: string, event: string, payload: Fields = {}) {
  await emit(ctx, event, campaignId, { ...payload, budget_line_id: lineId });
  const current = (await budgetSummary(ctx, campaignId)).lines.find(line => line.budget_line_id === lineId);
  const prior = (await ctx.list(moduleName, 'budget_overrun')).find(row => row.data.budget_line_id === lineId);
  const previousAmount = prior?.data.overrun_minor ?? 0;
  const overrunMinor = current?.overrun_minor ?? 0;
  if (previousAmount === overrunMinor) return;
  if (prior) await ctx.update(moduleName, 'budget_overrun', prior.id, { overrun_minor: overrunMinor }, prior.version);
  else await ctx.insert(moduleName, 'budget_overrun', { campaign_id: campaignId, budget_line_id: lineId, overrun_minor: overrunMinor });
  if (current && overrunMinor > previousAmount) {
    const request = await ctx.insert('core', 'approval_request', {
      resource_type: 'campaign.budget', resource_id: lineId, campaign_id: campaignId,
      status: 'pending', requested_by: ctx.actorId, reason: 'budget_overrun', snapshot: current,
    });
    await ctx.emit('core.approval_request.created', { approval_request_id: request.id, resource_type: 'campaign.budget', resource_id: lineId, campaign_id: campaignId });
    await emit(ctx, 'budget.overrun_detected', campaignId, { ...current, approval_request_id: request.id });
  }
}

async function costEntryData(ctx: Context, campaignId: string, input: Fields, line: Entity) {
  const commitmentId = optionalText(input.commitment_id, 'commitment_id');
  if (commitmentId) {
    const commit = await related(ctx, 'cost_commitment', campaignId, commitmentId);
    if (commit.data.budget_line_id !== line.id || !['committed', 'released'].includes(commit.data.status)) invalid('Entry must reference an approved commitment on the same budget line');
  }
  const source = options(input.source ?? 'manual', 'source', sources);
  const sourceRef = optionalText(input.source_ref, 'source_ref');
  if (source !== 'manual' && !sourceRef) invalid('Imported ledger entries require source_ref');
  const fxRateId = optionalText(input.fx_rate_id, 'fx_rate_id');
  const values = monetary(input, line);
  if (fxRateId) {
    const rate = await ctx.get('core', 'fx_rate', fxRateId);
    if (!rate || rate.data.base !== values.currency || rate.data.rate_date !== values.fx_date) invalid('FX rate must match the original currency and conversion date');
  }
  return { budget_line_id: line.id, commitment_id: commitmentId, ...values, source, source_ref: sourceRef,
    incurred_on: date(input.incurred_on, 'incurred_on'), fx_rate_id: fxRateId, attachment_file_ids: strings(input.attachment_file_ids ?? [], 'attachment_file_ids') };
}

async function ledgerCampaign(ctx: Context, input: Fields) {
  const campaign = await getCampaign(ctx, input);
  mutable(campaign);
  return campaign.id;
}
async function activeLine(ctx: Context, campaignId: string, value: unknown) {
  const row = await related(ctx, 'budget_line', campaignId, value);
  if (row.data.removed_at) conflict('Budget line has been removed');
  return row;
}

export const budgetCommands: Commands = {
  budget_summary: command(readRoles, async (ctx, input) => budgetSummary(ctx, (await getCampaign(ctx, input)).id)),
  list_budget_lines: command(readRoles, async (ctx, input) => rows(ctx, 'budget_line', (await getCampaign(ctx, input)).id)),
  list_cost_commitments: command(readRoles, async (ctx, input) => rows(ctx, 'cost_commitment', (await getCampaign(ctx, input)).id)),
  list_cost_entries: command(readRoles, async (ctx, input) => rows(ctx, 'cost_entry', (await getCampaign(ctx, input)).id)),
  create_budget_line: command(leadRoles, async (ctx, input) => {
    fields(input, ['campaign_id', ...lineKeys]);
    const campaignId = await ledgerCampaign(ctx, input);
    const row = await ctx.insert(moduleName, 'budget_line', { ...lineData(input), campaign_id: campaignId });
    await ledgerChange(ctx, campaignId, row.id, 'budget.changed');
    return row;
  }),
  update_budget_line: command(leadRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'budget_line_id', 'expected_version', 'patch']);
    const campaignId = await ledgerCampaign(ctx, input);
    const line = await activeLine(ctx, campaignId, input.budget_line_id);
    const patch = object(input.patch, 'patch');
    fields(patch, lineKeys);
    if (!Object.keys(patch).length) invalid('patch must contain a change');
    const values = lineData({ ...line.data, ...patch });
    if (values.currency !== line.data.currency) conflict('Budget line currency is immutable');
    const row = await ctx.update(moduleName, 'budget_line', line.id, values, expected(line, input.expected_version));
    await ledgerChange(ctx, campaignId, line.id, 'budget.changed');
    return row;
  }),
  remove_budget_line: command(leadRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'budget_line_id', 'expected_version']);
    const campaignId = await ledgerCampaign(ctx, input);
    const line = await activeLine(ctx, campaignId, input.budget_line_id);
    const [commitments, entries] = await Promise.all(['cost_commitment', 'cost_entry'].map(kind => rows(ctx, kind, campaignId)));
    if ([...commitments, ...entries].some(row => row.data.budget_line_id === line.id)) conflict('A budget line with ledger records must remain available for audit');
    const row = await ctx.update(moduleName, 'budget_line', line.id, { removed_at: ctx.now }, expected(line, input.expected_version));
    await ledgerChange(ctx, campaignId, line.id, 'budget.changed');
    return row;
  }),
  create_cost_commitment: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'budget_line_id', 'amount_minor', 'currency', 'fx_date', 'source_ref']);
    const campaignId = await ledgerCampaign(ctx, input);
    const line = await activeLine(ctx, campaignId, input.budget_line_id);
    const sourceRef = text(input.source_ref, 'source_ref');
    if ((await rows(ctx, 'cost_commitment', campaignId)).some(row => row.data.source_ref === sourceRef && row.data.budget_line_id === line.id && row.data.status !== 'released')) conflict('Commitment already exists for this budget line and source');
    const row = await ctx.insert(moduleName, 'cost_commitment', { ...monetary(input, line), campaign_id: campaignId, budget_line_id: line.id, source_ref: sourceRef, status: 'pending_approval' });
    await ledgerChange(ctx, campaignId, line.id, 'budget.changed', { commitment_id: row.id });
    return row;
  }),
  transition_cost_commitment: command(leadRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'commitment_id', 'expected_version', 'to', 'approval_ref', 'reason']);
    const campaignId = await ledgerCampaign(ctx, input);
    const commitment = await related(ctx, 'cost_commitment', campaignId, input.commitment_id);
    const version = expected(commitment, input.expected_version);
    const to = options(input.to, 'to', ['committed', 'released']);
    const from = commitment.data.status;
    if (from === 'released' || (to === 'committed' && from !== 'pending_approval')) conflict('Invalid commitment transition');
    const patch: Fields = { status: to };
    if (to === 'committed') patch.approval_ref = text(input.approval_ref, 'approval_ref');
    else patch.release_reason = text(input.reason, 'reason');
    const row = await ctx.update(moduleName, 'cost_commitment', commitment.id, patch, version);
    await ledgerChange(ctx, campaignId, row.data.budget_line_id, 'budget.changed', { commitment_id: row.id });
    return row;
  }),
  create_cost_entry: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', ...entryKeys]);
    const campaignId = await ledgerCampaign(ctx, input);
    const line = await activeLine(ctx, campaignId, input.budget_line_id);
    const values = await costEntryData(ctx, campaignId, input, line);
    if (values.source_ref && (await rows(ctx, 'cost_entry', campaignId)).some(row => row.data.budget_line_id === line.id && row.data.source === values.source && row.data.source_ref === values.source_ref && !row.data.voided_at)) conflict('This cost source was already recorded');
    const row = await ctx.insert(moduleName, 'cost_entry', { ...values, campaign_id: campaignId });
    await ledgerChange(ctx, campaignId, line.id, 'cost_entry.changed', { cost_entry_id: row.id });
    return row;
  }),
  void_cost_entry: command(leadRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'cost_entry_id', 'expected_version', 'reason']);
    const campaignId = await ledgerCampaign(ctx, input);
    const entry = await related(ctx, 'cost_entry', campaignId, input.cost_entry_id);
    if (entry.data.voided_at) conflict('Cost entry is already voided');
    const row = await ctx.update(moduleName, 'cost_entry', entry.id, { voided_at: ctx.now, void_reason: text(input.reason, 'reason') }, expected(entry, input.expected_version));
    await ledgerChange(ctx, campaignId, row.data.budget_line_id, 'cost_entry.changed', { cost_entry_id: row.id });
    return row;
  }),
};
