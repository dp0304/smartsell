import { admins, readers, required, reviewers, text, writers } from '../types.ts';
import type { Commands, Context, Entity } from '../types.ts';
import { checkVersion, choice, conflict, currency, date, day, digest, get, insert, integer, invalid, list, optional, optionalDate, safeMinor, signedTerms, strings, update } from './command-input.ts';

const funded = ['paid', 'partially_refunded', 'refunded'];
function amount(rule: { kind: string; rate_bps?: number; amount_minor?: number }, basis: number) {
  return rule.kind === 'rate' ? safeMinor((BigInt(basis) * BigInt(rule.rate_bps!) + 5000n) / 10000n) : rule.amount_minor!;
}
function isRefundFinal(refund: Entity) {
  return ['succeeded', 'completed', 'refunded', 'success'].includes(refund.data.status);
}
async function orderRefunds(ctx: Context, orderId: string) {
  return (await ctx.list('commerce', 'refund')).filter(item => item.data.order_id === orderId && isRefundFinal(item));
}
function refundBasis(refund: Entity, entry: Entity) {
  if (Array.isArray(refund.data.lines) && refund.data.lines.length) {
    return safeMinor(refund.data.lines.filter((line: { external_line_id: string }) => line.external_line_id === entry.data.external_line_id)
      .reduce((sum: bigint, line: { amount_minor: number }) => sum + BigInt(line.amount_minor), 0n));
  }
  return null;
}

async function payableCommission(ctx: Context, entry: Entity) {
  const order = await required(ctx, 'commerce', 'order', entry.data.order_id);
  if (order.data.cancelled_at || order.data.financial_status === 'refunded') return null;
  const adjustments = (await list(ctx, 'commission_entry')).filter(row => row.data.reversal_of_id === entry.id);
  const refunds = await orderRefunds(ctx, order.id);
  if (order.data.financial_status === 'partially_refunded' && !refunds.length) return null;
  for (const refund of refunds) {
    const basis = refundBasis(refund, entry);
    if (basis === null || basis > 0 && !adjustments.some(row => row.data.refund_id === refund.id)) return null;
  }
  return safeMinor(adjustments.reduce((total, row) => total + BigInt(row.data.commission_minor), BigInt(entry.data.commission_minor)));
}

export const commissionCommands: Commands = {
  create_affiliate_assignment: { roles: writers, async run(ctx, input) {
    const collaboration = await get(ctx, 'collaboration', text(input, 'collaboration_id', 240));
    if (!['active', 'delivering'].includes(collaboration.data.status)) return conflict('invalid_status', 'Collaboration must be active');
    await signedTerms(ctx, collaboration);
    const kind = choice(input, 'kind', ['discount_code', 'short_link', 'platform_affiliate'] as const);
    const code = kind === 'discount_code' ? text(input, 'code', 240).toLowerCase() : null;
    const link = kind === 'short_link' ? await required(ctx, 'traffic', 'short_link', text(input, 'short_link_id', 240)) : null;
    if (link?.data.brand_id && link.data.brand_id !== collaboration.data.brand_id) return invalid('short_link_id');
    const platformRef = kind === 'platform_affiliate' ? text(input, 'external_affiliate_ref', 240) : null;
    const key = code ?? link?.id ?? platformRef!;
    const id = digest(['assignment', kind, key]);
    const existing = await ctx.get('creator', 'affiliate_assignment', id);
    if (existing) return conflict('duplicate_affiliate', 'Affiliate identifier already assigned');
    const start = optionalDate(input, 'valid_from') ?? ctx.now;
    const end = optionalDate(input, 'valid_until');
    if (end && end <= start) return invalid('valid_until');
    const row = await insert(ctx, 'affiliate_assignment', { collaboration_id: collaboration.id, kind, code, short_link_id: link?.id ?? null, external_affiliate_ref: platformRef, valid_from: start, valid_until: end }, id);
    await ctx.emit('creator.affiliate.assigned', { collaboration_id: collaboration.id, affiliate_assignment_id: id });
    return row;
  } },
  accrue_commission: { roles: admins, async run(ctx, input) {
    if (input.estimated === true || input.source_kind !== undefined && !['order_derived', 'import'].includes(input.source_kind)) return invalid('source_kind');
    const assignment = await get(ctx, 'affiliate_assignment', text(input, 'affiliate_assignment_id', 240));
    const collaboration = await get(ctx, 'collaboration', assignment.data.collaboration_id);
    const line = await required(ctx, 'commerce', 'order_line', text(input, 'order_line_id', 240));
    const order = await required(ctx, 'commerce', 'order', line.data.order_id);
    const externalLineId = text(line.data, 'external_line_id', 240);
    const id = digest(['commission', order.id, externalLineId, collaboration.id]);
    const prior = await ctx.get('creator', 'commission_entry', id);
    if (prior) return prior;
    if (!['active', 'delivering'].includes(collaboration.data.status)) return conflict('invalid_status', 'Collaboration must be active');
    if (order.data.cancelled_at || ['refunded', 'partially_refunded'].includes(order.data.financial_status) || (await orderRefunds(ctx, order.id)).length) return conflict('ORDER_NOT_ELIGIBLE', 'Review refunds before accruing this order');
    const store = await required(ctx, 'commerce', 'store', order.data.store_id);
    if (store.data.brand_id !== collaboration.data.brand_id) return invalid('order_line_id');
    const payment = (await ctx.list('commerce', 'payment_transaction')).filter(item => item.data.order_id === order.id &&
      ['sale', 'capture'].includes(item.data.kind) && item.data.status === 'succeeded' && item.data.amount_minor > 0)
      .sort((a, b) => a.data.processed_at.localeCompare(b.data.processed_at)).at(-1);
    const paidAt = optionalDate(order.data, 'paid_at') ?? (payment ? date(payment.data, 'processed_at') : null);
    if (!paidAt || paidAt > ctx.now || (!payment && !funded.includes(order.data.financial_status))) return conflict('ORDER_NOT_ELIGIBLE', 'A paid Commerce order is required');
    if (paidAt < assignment.data.valid_from || assignment.data.valid_until && paidAt >= assignment.data.valid_until) return conflict('ORDER_NOT_ELIGIBLE', 'Order is outside the affiliate assignment window');
    const source = choice(input, 'source_kind', ['order_derived', 'import'] as const, 'order_derived');
    let evidenceId = null;
    if (source === 'import') evidenceId = (await required(ctx, 'core', 'evidence', text(input, 'evidence_id', 240))).id;
    else {
      const match = assignment.data.kind === 'discount_code' && (await ctx.list('commerce', 'discount_usage')).some(item => item.data.order_id === order.id && item.data.code?.toLowerCase() === assignment.data.code);
      const attributed = assignment.data.kind === 'short_link' && order.data.attributed_short_link_id === assignment.data.short_link_id;
      if (!match && !attributed) return conflict('ORDER_NOT_ELIGIBLE', 'Order does not match the affiliate assignment');
    }
    const terms = await signedTerms(ctx, collaboration);
    if (terms.data.signed_at && paidAt < terms.data.signed_at) return conflict('ORDER_NOT_ELIGIBLE', 'Order predates signature');
    const rule = terms.data.commission_rule;
    if (!rule) return conflict('TERMS_REQUIRED', 'Signed terms do not specify a commission');
    const orderCurrency = currency(order.data);
    if (rule.kind === 'fixed' && rule.currency !== orderCurrency) return invalid('currency');
    const basis = safeMinor(BigInt(integer(line.data, 'unit_price_minor')) * BigInt(integer(line.data, 'quantity', 1)) - BigInt(integer(line.data, 'discount_minor')));
    if (basis <= 0) return conflict('ORDER_NOT_ELIGIBLE', 'Net sales amount must be positive');
    const commission = amount(rule, basis);
    if (!commission) return conflict('ORDER_NOT_ELIGIBLE', 'Net sales amount does not accrue commission');
    const row = await insert(ctx, 'commission_entry', {
      kind: 'accrual', affiliate_assignment_id: assignment.id, collaboration_id: collaboration.id, terms_revision_id: terms.id,
      order_id: order.id, order_line_id: line.id, external_line_id: externalLineId, basis_amount_minor: basis, commission_minor: commission,
      currency: orderCurrency, paid_at: paidAt, observe_until: new Date(Date.parse(paidAt) + rule.observation_days * day).toISOString(),
      status: 'observing', settlement_by: rule.settlement_by, source_kind: source, source_evidence_id: evidenceId, settlement_batch_id: null,
    }, id);
    await ctx.emit('creator.commission.accrued', { commission_entry_id: row.id, collaboration_id: collaboration.id });
    return row;
  } },
  mature_commissions: { roles: admins, async run(ctx) {
    let count = 0;
    for (const entry of await list(ctx, 'commission_entry')) {
      const reviewable = entry.data.status === 'observing' || entry.data.status === 'disputed' && entry.data.dispute?.reason === 'partial_refund';
      if (entry.data.kind !== 'accrual' || !reviewable || entry.data.observe_until > ctx.now) continue;
      const payable = await payableCommission(ctx, entry);
      if (payable == null) continue;
      await update(ctx, entry, { status: payable > 0 ? 'eligible' : 'reversed', matured_at: ctx.now });
      if (payable <= 0) continue;
      await ctx.emit('creator.commission.eligible', { commission_entry_id: entry.id });
      count++;
    }
    return { count };
  } },
  reverse_commission: { roles: reviewers, async run(ctx, input) {
    const entry = await get(ctx, 'commission_entry', text(input, 'commission_entry_id', 240));
    if (entry.data.kind !== 'accrual') return conflict('invalid_status', 'Only accruals can be reversed');
    if (entry.data.settlement_batch_id && entry.data.status !== 'paid') return conflict('invalid_status', 'Release this entry from its unpaid batch before reversing');
    const order = await required(ctx, 'commerce', 'order', entry.data.order_id);
    const refundId = optional(input, 'refund_id');
    const refund = refundId ? await required(ctx, 'commerce', 'refund', refundId) : null;
    if (refund && (refund.data.order_id !== order.id || refund.data.currency !== entry.data.currency || !isRefundFinal(refund))) return invalid('refund_id');
    if (!refund && !order.data.cancelled_at) return invalid('refund_id');
    const id = digest(['commission_reversal', entry.id, refund?.id ?? 'cancelled']);
    const prior = await ctx.get('creator', 'commission_entry', id);
    if (prior) return prior;
    const priorReversals = (await list(ctx, 'commission_entry')).filter(item => item.data.reversal_of_id === entry.id);
    const remaining = entry.data.basis_amount_minor + priorReversals.reduce((total, item) => total + item.data.basis_amount_minor, 0);
    if (remaining <= 0) return conflict('invalid_status', 'Accrual already fully reversed');
    const attributable = refund ? refundBasis(refund, entry) : remaining;
    if (attributable == null || attributable <= 0) return conflict('REFUND_REVIEW_REQUIRED', 'Confirmed refund must identify the matching order line');
    const basis = Math.min(remaining, attributable);
    const terms = await get(ctx, 'collaboration_terms', entry.data.terms_revision_id);
    const rule = terms.data.commission_rule;
    // Fixed per-line commissions reverse when the line is fully refunded; cumulative rate rounding balances exactly.
    const remainingCommission = remaining === basis ? 0 : amount(rule, remaining - basis);
    const reversal = Math.max(0, (remaining === entry.data.basis_amount_minor ? entry.data.commission_minor : amount(rule, remaining)) - remainingCommission);
    const result = await insert(ctx, 'commission_entry', {
      kind: 'reversal', reversal_of_id: entry.id, refund_id: refund?.id ?? null, affiliate_assignment_id: entry.data.affiliate_assignment_id,
      collaboration_id: entry.data.collaboration_id, terms_revision_id: terms.id, order_id: order.id,
      order_line_id: entry.data.order_line_id, basis_amount_minor: -basis, commission_minor: reversal ? -reversal : 0,
      currency: entry.data.currency, status: 'reversed', settlement_by: entry.data.settlement_by,
      source_kind: 'order_derived', recovery_required: reversal > 0 && ['paid', 'platform_settled'].includes(entry.data.status),
    }, id);
    if (basis === remaining) await update(ctx, entry, { status: 'reversed', status_before_reversal: entry.data.status });
    else if (['observing', 'eligible', 'approved'].includes(entry.data.status)) await update(ctx, entry, { status: 'disputed', dispute: { reason: 'partial_refund', raised_at: ctx.now } });
    await ctx.emit('creator.commission.reversed', { commission_entry_id: entry.id, reversal_id: result.id });
    return result;
  } },
  approve_commission: { roles: reviewers, async run(ctx, input) {
    const entry = await get(ctx, 'commission_entry', text(input, 'commission_entry_id', 240));
    checkVersion(entry, input);
    if (entry.data.kind !== 'accrual' || entry.data.status !== 'eligible') return conflict('invalid_status', 'Commission is not eligible for approval');
    const payable = await payableCommission(ctx, entry);
    if (!payable || payable < 0) return conflict('REFUND_REVIEW_REQUIRED', 'Order changed after eligibility');
    const approved = await update(ctx, entry, { status: 'approved', approved_minor: payable, approved_by: ctx.actorId, approved_at: ctx.now });
    await ctx.emit('creator.commission.approved', { commission_entry_id: entry.id });
    return approved;
  } },
  list_commissions: { roles: readers, async run(ctx, input) {
    const start = optionalDate(input, 'from');
    const end = optionalDate(input, 'to');
    if (start && end && start >= end) return invalid('to');
    const rows = await list(ctx, 'commission_entry');
    return { items: rows.filter(row => (!start || row.created_at >= start) && (!end || row.created_at < end) && ['collaboration_id', 'status', 'settlement_by', 'currency'].every(key => input[key] === undefined || input[key] === row.data[key])) };
  } },
  record_platform_settlement: { roles: reviewers, async run(ctx, input) {
    const entry = await get(ctx, 'commission_entry', text(input, 'commission_entry_id', 240));
    checkVersion(entry, input);
    if (entry.data.status !== 'approved' || entry.data.settlement_by === 'self' || entry.data.settlement_batch_id) return conflict('invalid_status', 'Only approved external commissions can be reconciled');
    const ref = text(input, 'external_settlement_id', 240);
    const payable = await payableCommission(ctx, entry);
    if (!payable || payable !== (entry.data.approved_minor ?? entry.data.commission_minor)) return conflict('REFUND_REVIEW_REQUIRED', 'Order changed after approval');
    const evidence = (await required(ctx, 'core', 'evidence', text(input, 'evidence_id', 240))).id;
    if ((await list(ctx, 'commission_entry')).some(item => item.data.settlement_by === entry.data.settlement_by && item.data.external_settlement_id === ref && item.data.order_id === entry.data.order_id && item.data.external_line_id === entry.data.external_line_id)) return conflict('duplicate_settlement', 'External settlement is already recorded for this order line');
    const settled = await update(ctx, entry, { status: 'platform_settled', external_settlement_id: ref, settlement_evidence_id: evidence, settled_at: ctx.now });
    await ctx.emit('creator.commission.platform_settled', { commission_entry_id: entry.id });
    return settled;
  } },
  create_settlement_batch: { roles: reviewers, async run(ctx, input) {
    const ids = strings(input, 'commission_entry_ids');
    const batchCurrency = currency(input);
    if (!ids.length) return invalid('commission_entry_ids');
    const entries = await Promise.all(ids.map(id => get(ctx, 'commission_entry', id)));
    if (entries.some(item => item.data.status !== 'approved' || item.data.settlement_by !== 'self' || item.data.currency !== batchCurrency || item.data.settlement_batch_id || item.data.kind !== 'accrual')) return conflict('INELIGIBLE_SETTLEMENT', 'Batch may contain only unbatched approved self-settled accruals in the same currency');
    for (const entry of entries) {
      const payable = await payableCommission(ctx, entry);
      if (!payable || payable !== (entry.data.approved_minor ?? entry.data.commission_minor)) return conflict('REFUND_REVIEW_REQUIRED', 'An order changed after approval');
    }
    const total = safeMinor(entries.reduce((sum, item) => sum + BigInt(item.data.approved_minor ?? item.data.commission_minor), 0n));
    const batch = await insert(ctx, 'settlement_batch', {
      period: text(input, 'period', 80), currency: batchCurrency, total_minor: total, commission_entry_ids: ids, status: 'pending_approval', created_by: ctx.actorId,
    });
    for (const entry of entries) await update(ctx, entry, { settlement_batch_id: batch.id });
    await ctx.emit('creator.settlement.requested', { settlement_batch_id: batch.id });
    return batch;
  } },
  approve_settlement_batch: { roles: reviewers, async run(ctx, input) {
    const batch = await get(ctx, 'settlement_batch', text(input, 'settlement_batch_id', 240));
    checkVersion(batch, input);
    if (batch.data.status !== 'pending_approval') return conflict('invalid_status', 'Batch is not awaiting approval');
    const approved = await update(ctx, batch, { status: 'approved', approved_at: ctx.now, approved_by: ctx.actorId });
    await ctx.emit('creator.settlement.approved', { settlement_batch_id: batch.id });
    return approved;
  } },
  cancel_settlement_batch: { roles: reviewers, async run(ctx, input) {
    const batch = await get(ctx, 'settlement_batch', text(input, 'settlement_batch_id', 240));
    checkVersion(batch, input);
    if (!['pending_approval', 'approved'].includes(batch.data.status)) return conflict('invalid_status', 'Batch can no longer be cancelled');
    const reason = text(input, 'reason', 4096);
    for (const id of batch.data.commission_entry_ids) {
      const entry = await get(ctx, 'commission_entry', id);
      if (entry.data.settlement_batch_id === batch.id) await update(ctx, entry, { settlement_batch_id: null });
    }
    const cancelled = await update(ctx, batch, { status: 'cancelled', cancelled_at: ctx.now, cancellation_reason: reason });
    await ctx.emit('creator.settlement.cancelled', { settlement_batch_id: batch.id });
    return cancelled;
  } },
  record_settlement_payment: { roles: reviewers, async run(ctx, input) {
    const batch = await get(ctx, 'settlement_batch', text(input, 'settlement_batch_id', 240));
    checkVersion(batch, input);
    if (batch.data.status !== 'approved') return conflict('invalid_status', 'Only an approved batch can be paid');
    const evidenceIds = strings(input, 'payment_evidence_ids');
    const payoutRef = text(input, 'external_payout_ref', 240);
    if (!evidenceIds.length || integer(input, 'amount_minor', 1) !== batch.data.total_minor || currency(input) !== batch.data.currency) return invalid('payment amount, currency or evidence');
    for (const id of evidenceIds) await required(ctx, 'core', 'evidence', id);
    if ((await list(ctx, 'settlement_batch')).some(item => item.data.external_payout_ref === payoutRef)) return conflict('duplicate_settlement', 'Payment reference already used');
    for (const id of batch.data.commission_entry_ids) {
      const entry = await get(ctx, 'commission_entry', id);
      const payable = await payableCommission(ctx, entry);
      if (entry.data.status !== 'approved' || entry.data.settlement_batch_id !== batch.id || entry.data.settlement_by !== 'self' ||
        !payable || payable !== (entry.data.approved_minor ?? entry.data.commission_minor)) return conflict('INELIGIBLE_SETTLEMENT', 'A commission is no longer eligible for payment');
      await update(ctx, entry, { status: 'paid', settled_minor: payable, settled_at: ctx.now });
    }
    const paid = await update(ctx, batch, { status: 'paid', paid_at: ctx.now, payment_evidence_ids: evidenceIds, external_payout_ref: payoutRef });
    await ctx.emit('creator.settlement.paid', { settlement_batch_id: batch.id });
    return paid;
  } },
};
