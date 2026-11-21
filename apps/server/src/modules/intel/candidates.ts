import { DomainError, required, reviewers, text, writers } from '../types.ts';
import type { Context, Fields } from '../types.ts';
import { evidence, isEvidence } from './research.ts';
import { assertVersion, boolean, choice, command, conflict, create, fail, get, list, money, number, object, optional, selected, strings, update } from './validation.ts';

const candidateFields = ['name', 'market_ids', 'price_range', 'supply_notes', 'estimated_cost', 'actual_quote'];
const dimensions = ['demand_evidence', 'competition', 'product_fit', 'supply_feasibility'] as const;
const decisionRoles = [...new Set([...writers, ...reviewers])];
function priceRange(value: unknown) {
  const input = object(value, ['min_minor', 'max_minor', 'currency'], 'price_range');
  const { amount_minor: min_minor, currency } = money({ amount_minor: input.min_minor, currency: input.currency });
  const max_minor = number(input, 'max_minor', min_minor, Number.MAX_SAFE_INTEGER, true);
  return { min_minor, max_minor, currency };
}
function candidatePatch(input: Fields) {
  return {
    ...selected(input, ['name', 'supply_notes']),
    ...(input.market_ids !== undefined ? { market_ids: strings(input, 'market_ids') } : {}),
    ...(input.price_range !== undefined ? { price_range: priceRange(input.price_range) } : {}),
    ...(input.estimated_cost !== undefined ? { estimated_cost: money(input.estimated_cost) } : {}),
    ...(input.actual_quote !== undefined ? { actual_quote: money(input.actual_quote) } : {}),
  };
}
async function scoreEvidence(ctx: Context, ids: string[]) {
  const items = await evidence(ctx, ids, 'team_share');
  const primary = items.filter(row => row.kind === 'research_item' && ids.includes(row.id));
  return { items, supported: primary.some(isEvidence), includesEstimate: items.some(item => item.data.source?.estimate) };
}
export const candidateCommands = {
  product_candidate_detail: command(decisionRoles, async (ctx, input) => {
    object(input, ['id']);
    const candidate = await get(ctx, 'product_candidate', text(input, 'id'));
    const scores = (await list(ctx, 'candidate_score')).filter(row => row.data.candidate_id === candidate.id);
    for (const score of scores) await scoreEvidence(ctx, score.data.evidence_item_ids);
    return { candidate, scores };
  }),
  create_product_candidate: command(writers, async (ctx, input) => {
    object(input, candidateFields);
    return create(ctx, 'product_candidate', { market_ids: [], ...candidatePatch(input), name: text(input, 'name', 160),
      status: 'proposed', linked_product_id: null, decision_reason: null });
  }),
  update_product_candidate: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', ...candidateFields]);
    const row = await get(ctx, 'product_candidate', text(input, 'id'));
    if (['accepted', 'rejected'].includes(row.data.status)) conflict('Decided candidates are read-only');
    const patch = candidatePatch(input);
    if (!Object.keys(patch).length) fail('No candidate changes supplied');
    return update(ctx, 'product_candidate', row, patch, input, 'candidate.changed');
  }),
  score_product_candidate: command(writers, async (ctx, input) => {
    object(input, ['candidate_id', 'expected_version', 'dimension', 'score', 'uncertainty', 'evidence_item_ids', 'authorship', 'is_estimate']);
    const row = await get(ctx, 'product_candidate', text(input, 'candidate_id'));
    assertVersion(row, input);
    if (!['researching', 'validating'].includes(row.data.status)) conflict('Candidate must be under active research or validation');
    const dimension = choice(input, 'dimension', dimensions);
    const score = number(input, 'score', 0, 100);
    const uncertainty = choice(input, 'uncertainty', ['low', 'medium', 'high', 'unknown']);
    const scored_by_type = optional(input, 'authorship', (value, key) => choice(value, key, ['human', 'agent'])) ?? 'human';
    const estimate = optional(input, 'is_estimate', boolean);
    const evidence_item_ids = strings(input, 'evidence_item_ids', 30);
    const { items, supported, includesEstimate } = await scoreEvidence(ctx, evidence_item_ids);
    if (!supported && scored_by_type === 'human') fail('A score requires an evidence, demand, or counterexample item');
    const candidate_score = await create(ctx, 'candidate_score', { candidate_id: row.id, dimension, score,
      uncertainty: supported ? uncertainty : 'unknown', evidence_item_ids,
      evidence_versions: items.map(item => ({ id: item.id, kind: item.kind, version: item.version })),
      is_estimate: estimate === true || includesEstimate || !supported,
      status: supported ? 'supported' : 'hypothesis', scored_by: ctx.actorId, scored_by_type });
    const candidate = await update(ctx, 'product_candidate', row, { latest_score_ids: { ...row.data.latest_score_ids, [dimension]: candidate_score.id } },
      input, 'candidate.scored');
    return { candidate, score: candidate_score };
  }),
  transition_product_candidate: command(decisionRoles, async (ctx, input) => {
    object(input, ['id', 'expected_version', 'status', 'reason', 'linked_product_id', 'draft_store_id', 'new_evidence_item_ids']);
    const row = await get(ctx, 'product_candidate', text(input, 'id'));
    assertVersion(row, input);
    const status = choice(input, 'status', ['researching', 'validating', 'accepted', 'rejected', 'parked']);
    const allowed: Record<string, string[]> = { proposed: ['researching'], researching: ['validating', 'parked'],
      validating: ['accepted', 'rejected'], parked: ['researching'], rejected: ['researching'], accepted: [] };
    if (!allowed[row.data.status]?.includes(status)) conflict(`Cannot transition from ${row.data.status} to ${status}`);
    const decided = status === 'accepted' || status === 'rejected';
    if (!(decided ? reviewers : writers).includes(ctx.role)) throw new DomainError('forbidden', 'Insufficient candidate transition permissions', 403);
    const reason = optional(input, 'reason', text);
    if (decided && !reason) fail('A decision reason is required');
    const productId = optional(input, 'linked_product_id', text);
    const storeId = optional(input, 'draft_store_id', text);
    if (status !== 'accepted' && (productId || storeId)) fail('Product linking requires acceptance');
    const newEvidence = optional(input, 'new_evidence_item_ids', strings);
    const reopened = row.data.status === 'rejected';
    if (!reopened && newEvidence !== undefined) fail('New evidence is only used to reopen a rejected candidate');
    if (reopened) {
      if (!newEvidence?.length) return fail('Rejected candidates require new evidence to reopen');
      const { items } = await scoreEvidence(ctx, newEvidence);
      if (!items.some(item => item.kind === 'research_item' && newEvidence.includes(item.id) && isEvidence(item) &&
        Date.parse(item.created_at) > Date.parse(row.data.decided_at) && !(row.data.decision_evidence_item_ids ?? []).includes(item.id))) {
        fail('Reopening requires a new evidence item created after the decision');
      }
    }
    const currentScoreIds: string[] = Object.values(row.data.latest_score_ids ?? {});
    const currentScores = (await list(ctx, 'candidate_score')).filter(score => currentScoreIds.includes(score.id));
    if (status === 'validating' || status === 'accepted') {
      let supported = 0;
      for (const score of currentScores) {
        if (score.data.status !== 'supported') continue;
        if ((await scoreEvidence(ctx, score.data.evidence_item_ids)).supported) supported++;
      }
      if (supported < 2) conflict('Validation requires evidence in at least two dimensions');
    }
    let linkedProductId: string | null = null;
    if (status === 'accepted') {
      if (Boolean(productId) === Boolean(storeId)) fail('Link exactly one commerce product or provide a store for a draft');
      if (productId) {
        linkedProductId = (await required(ctx, 'commerce', 'product', productId)).id;
      } else {
        const { catalogCommands } = await import('../commerce/catalog-commands.ts');
        const createProduct = catalogCommands.create_product;
        if (!createProduct?.roles.includes(ctx.role)) throw new DomainError('forbidden', 'Insufficient permission to create a commerce product draft', 403);
        const result = await createProduct.run(ctx, { store_id: storeId, title: row.data.name, status: 'draft' });
        const product = object(result, ['id', 'module', 'kind', 'data', 'version', 'tenant_id', 'workspace_id', 'created_at', 'updated_at'], 'product');
        linkedProductId = (await required(ctx, 'commerce', 'product', text(product, 'id'))).id;
      }
    }
    return update(ctx, 'product_candidate', row, { status, linked_product_id: linkedProductId, decision_reason: decided ? reason : null,
      ...(reason ? { transition_reason: reason } : {}),
      ...(decided ? { decided_by: ctx.actorId, decided_at: ctx.now, decision_evidence_item_ids: [...new Set(currentScores.flatMap(score => score.data.evidence_item_ids))] } : {}),
      ...(reopened ? { reopened_with_evidence: newEvidence } : {}),
    }, input, decided ? 'candidate.decided' : 'candidate.transitioned', { candidate_id: row.id, linked_product_id: linkedProductId });
  }),
};
