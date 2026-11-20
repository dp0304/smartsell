import { createHash } from 'node:crypto';
import { admins, text, type Commands } from '../types.js';
import { parseSalesQuery, revenueQuery } from './sales.js';
import { addDays, currency, currentTime, date, integer, invalid, ref, revenueRoles, safeNumber, state, timeZone } from './shared.js';

const digest = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export const reconciliationCommands: Commands = {
  reconcile_revenue_day: { roles: admins, async run(ctx, input) {
    const store_id = text(input, 'store_id', 160);
    const store = await ctx.get('commerce', 'store', store_id);
    if (!store || store.data.rolled_back || store.data.status === 'disabled') state('An enabled store is required');
    const day = date(input.day, 'day');
    const tz = timeZone(input.tz);
    const currency_code = currency(input.currency);
    const source_report_ref = text(input, 'source_report_ref', 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(source_report_ref)) invalid('Provide an opaque source report reference');
    const source = {
      order_count: integer(input.order_count, 'order_count'),
      order_total_minor: integer(input.order_total_minor, 'order_total_minor'),
      refunds_succeeded_minor: integer(input.refunds_succeeded_minor, 'refunds_succeeded_minor'),
    };
    const as_of = currentTime(ctx);
    const query = parseSalesQuery({ period: { from: day, to: addDays(day, 1), tz }, store_ids: [store_id] });
    if (query.period.to > as_of) state('Reconcile a completed store day');
    const result = await revenueQuery(ctx, query, as_of);
    const row = result.rows.find(candidate => candidate.day === day && candidate.currency === currency_code);
    const observed = {
      order_count: row?.order_count ?? 0,
      order_total_minor: row?.observed_order_total_minor ?? 0,
      refunds_succeeded_minor: row?.observed_refunds_succeeded_minor ?? 0,
    };
    const delta = {
      order_count: observed.order_count - source.order_count,
      order_total_minor: safeNumber(BigInt(observed.order_total_minor) - BigInt(source.order_total_minor)),
      refunds_succeeded_minor: safeNumber(BigInt(observed.refunds_succeeded_minor) - BigInt(source.refunds_succeeded_minor)),
    };
    const status = Object.values(delta).some(value => value !== 0) ? 'mismatch' : 'matched';
    const fingerprint = digest(store_id, day, tz, currency_code);
    const evidence = [ref(store), ...(row?.evidence ?? [])];
    const signature = digest(source_report_ref, source, observed, evidence);
    const latest = await ctx.get('analytics', 'reconciliation_state', fingerprint);
    if (latest?.data.signature === signature) {
      return ctx.get('analytics', 'reconciliation_check', latest.data.check_id);
    }
    const check = await ctx.insert('analytics', 'reconciliation_check', {
      store_id, provider: store.data.provider, day, tz, currency: currency_code, as_of,
      source_report_ref, source, observed, delta, status, coverage: row?.coverage ?? null, evidence,
    });
    const stateData = { signature, check_id: check.id };
    if (latest) await ctx.update('analytics', 'reconciliation_state', fingerprint, stateData, latest.version);
    else await ctx.insert('analytics', 'reconciliation_state', stateData, fingerprint);
    const issueId = digest('store_revenue_reconciliation', fingerprint);
    const issue = await ctx.get('ingest', 'quality_issue', issueId);
    if (status === 'mismatch') {
      const issueData = { rule_key: 'store_revenue_reconciliation', store_id, data_source_id: null, resource: 'transactions',
        subject_ref: { resource_type: 'store', resource_id: store_id }, observed: { delta, reconciliation_check_id: check.id },
        severity: 'warning', fingerprint, status: 'open', last_seen_at: as_of, resolved_at: null, resolved_by: null, resolution_note: null };
      if (issue) await ctx.update('ingest', 'quality_issue', issueId, { ...issueData, occurrences: issue.data.occurrences + 1 }, issue.version);
      else await ctx.insert('ingest', 'quality_issue', { ...issueData, occurrences: 1, first_seen_at: as_of }, issueId);
      if (!issue || ['resolved', 'false_positive'].includes(issue.data.status)) {
        await ctx.emit('ingest.quality_issue.opened', { quality_issue_id: issueId, store_id, rule_key: issueData.rule_key });
      }
    } else if (issue && ['open', 'acknowledged', 'investigating'].includes(issue.data.status)) {
      await ctx.update('ingest', 'quality_issue', issueId, { status: 'resolved', resolved_at: as_of, resolved_by: ctx.actorId,
        resolution_note: 'Source report matches the observed commerce records', resolved_by_check_id: check.id }, issue.version);
      await ctx.emit('ingest.quality_issue.resolved', { quality_issue_id: issueId, store_id, reconciliation_check_id: check.id });
    }
    await ctx.emit('analytics.reconciliation_check.recorded', { reconciliation_check_id: check.id, store_id, day, status });
    return check;
  } },
  revenue_reconciliation_list: { roles: revenueRoles, async run(ctx, input) {
    const store_id = text(input, 'store_id', 160);
    const from = date(input.from, 'from');
    const to = date(input.to, 'to');
    if (from >= to) invalid('Select an increasing date range');
    return { items: (await ctx.list('analytics', 'reconciliation_check')).filter(row => row.data.store_id === store_id
      && row.data.day >= from && row.data.day < to).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)) };
  } },
};
