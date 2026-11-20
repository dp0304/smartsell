import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { catalogOperations } from '../commerce/catalog-operations.js';
import { choice, conflict, invalid, money, number, object, optionalText, strings, text, time } from './input.js';
import { evidenceItems } from './intel-research.js';
import { fromAgent } from '../../agent-actor.js';

export const dimensions = ['demand_evidence', 'competition', 'product_fit', 'supply_feasibility'] as const;
export function candidateValues(ctx: Context, body: Data): Data {
  const marketIds = strings(body.market_ids ?? [], 'market_ids');
  marketIds.forEach(id => ctx.get('market', id));
  const brand = optionalText(body.brand_id, 'brand_id', 200);
  if (brand) ctx.get('brand', brand);
  let priceRange: Data | null = null;
  if (body.price_range != null) {
    const range = object(body.price_range, 'price_range');
    const min = money(range.min ?? { amount_minor: range.min_minor, currency: range.currency }, 'price_range.min');
    const max = money(range.max ?? { amount_minor: range.max_minor, currency: range.currency }, 'price_range.max');
    if (min.currency !== max.currency || Number(min.amount_minor) > Number(max.amount_minor)) invalid('price_range', 'requires ordered amounts in a common currency');
    priceRange = { min, max };
  }
  return {
    name: text(body.name, 'name', 250), brand_id: brand, market_ids: marketIds, price_range: priceRange,
    supply_notes: optionalText(body.supply_notes, 'supply_notes'),
    estimated_cost: body.estimated_cost == null ? null : money(body.estimated_cost, 'estimated_cost'),
    actual_quote: body.actual_quote == null ? null : money(body.actual_quote, 'actual_quote'),
  };
}
export function addScore(ctx: Context, candidate: Row, body: Data): Row {
  if (candidate.status !== 'researching' && candidate.status !== 'validating') conflict('Candidates can be scored while researching or validating');
  const dimension = choice(body.dimension, dimensions, 'dimension');
  const evidence = evidenceItems(ctx, body.evidence_item_ids ?? body.evidence_refs);
  if (evidence.some(item => item.item_type === 'candidate' && item.ref_id === candidate.id)) conflict('A candidate cannot be its own evidence');
  const derivedEstimate = evidence.some(item => item.item_type === 'observation' && (ctx.get('observation', String(item.ref_id)).source as Data)?.estimate === true);
  const changes = {
    candidate_id: candidate.id, dimension, score: number(body.score, 'score', 0, 100), uncertainty: number(body.uncertainty, 'uncertainty', 0, 1),
    evidence_item_ids: evidence.map(row => row.id), is_estimate: body.is_estimate === true || (fromAgent(ctx) && !evidence.length) || derivedEstimate,
    stance: fromAgent(ctx) && !evidence.length ? 'hypothesis' : 'assessment', scored_by: ctx.actorId,
  };
  const existing = ctx.list('candidate_score').find(row => row.candidate_id === candidate.id && row.dimension === dimension);
  const row = existing ? ctx.update('candidate_score', existing.id, changes) : ctx.create('candidate_score', changes);
  ctx.update('product_candidate', candidate.id, {});
  return row;
}
export async function transition(ctx: Context, candidate: Row, body: Data): Promise<Row> {
  const status = choice(body.status, ['researching', 'validating', 'accepted', 'rejected', 'parked'], 'status');
  const edges: Record<string, string[]> = { proposed: ['researching'], researching: ['validating', 'parked'], validating: ['accepted', 'rejected'], parked: ['researching'], rejected: ['researching'] };
  if (!edges[String(candidate.status)]?.includes(status)) conflict(`Cannot move from ${candidate.status} to ${status}`);
  const reason = optionalText(body.decision_reason ?? body.reason, 'decision_reason');
  const scores = ctx.list('candidate_score').filter(row => row.candidate_id === candidate.id);
  if (status === 'validating') {
    const evidenced = scores.filter(row => evidenceItems(ctx, row.evidence_item_ids).length > 0);
    if (new Set(evidenced.map(row => row.dimension)).size < 2) conflict('Validation requires evidence in at least two dimensions');
  }
  let productId: string | null = null;
  if ((status === 'accepted' || status === 'rejected') && !reason) invalid('decision_reason', 'is required for a decision');
  if (status === 'accepted') {
    if (body.linked_product_id != null && body.product_draft != null) invalid('product_draft', 'cannot accompany a linked product');
    if (scores.filter(score => evidenceItems(ctx, score.evidence_item_ids).length > 0).length < 2) conflict('Acceptance requires evidence in at least two dimensions');
    let product: Row;
    if (body.product_draft != null) {
      const draft = object(body.product_draft, 'product_draft');
      const store = ctx.get('store', text(draft.store_id, 'product_draft.store_id', 200));
      if (candidate.brand_id && store.brand_id !== candidate.brand_id) conflict('Store is outside the candidate brand');
      const create = catalogOperations.find(op => op.name === 'commerce_product_create');
      if (!create) throw new Problem(503, 'INTEGRATION_UNAVAILABLE', 'Product draft creation is unavailable');
      if (!create.roles.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Product draft permission is required');
      product = await create.run(ctx, { body: { store_id: store.id, title: draft.title ?? candidate.name, status: 'draft' }, params: {}, query: {} }) as Row;
    } else {
      product = ctx.get('product', text(body.linked_product_id, 'linked_product_id', 200));
    }
    if (!['active', 'draft'].includes(String(product.status))) conflict('Linked product must be active or a draft');
    if (candidate.brand_id && product.brand_id !== candidate.brand_id) conflict('Linked product is outside the candidate brand');
    productId = product.id;
  }
  if (candidate.status === 'rejected') {
    const refs = evidenceItems(ctx, body.evidence_item_ids ?? body.evidence_refs);
    const rejectedAt = time(candidate.decided_at, 'decided_at');
    if (!refs.some(row => row.created_at > rejectedAt)) conflict('Reopening a rejected candidate requires new evidence');
  }
  const result = ctx.update('product_candidate', candidate.id, { status, decision_reason: reason, linked_product_id: productId, ...(status === 'accepted' || status === 'rejected' ? { decided_at: ctx.now } : {}) });
  if (status === 'accepted' || status === 'rejected') ctx.emit('intel.candidate.decided', { candidate_id: candidate.id, status, linked_product_id: productId, reason });
  return result;
}
export function candidateDetail(ctx: Context, candidate: Row): Row {
  return { ...candidate, scores: ctx.list('candidate_score').filter(row => row.candidate_id === candidate.id) };
}
