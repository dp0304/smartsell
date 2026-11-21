import { readers, writers, type Commands, type Context, type Entity, type Fields, DomainError } from '../types';
import { active, bad, conflict, currency, guard, id, insert, instant, integer, list, live, obj, one, store, str, update, version } from './model';

function IDs(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) return bad(field);
  return [...new Set(value.map(entry => id(entry, field)))];
}
function effectiveState(promotion: Entity, now: string) {
  if (promotion.data.state === 'draft' || promotion.data.state === 'cancelled') return promotion.data.state;
  if (now < promotion.data.valid_from) return 'scheduled';
  if (now >= promotion.data.valid_until) return 'expired';
  return 'active';
}
async function view(ctx: Context, row: Entity) {
  const codes = (await list(ctx, 'promotion_code')).filter(code => active(code) && !code.data.retired_at && code.data.promotion_id === row.id);
  const uses = (await list(ctx, 'discount_usage')).filter(use => active(use) && use.data.promotion_id === row.id).length;
  return { promotion: row, effective_state: effectiveState(row, ctx.now), codes, observed_usage_count: uses, has_verified_offer: row.data.verified_at != null };
}

export const promotionCommands: Commands = {
  save_promotion: { roles: writers, async run(ctx, input) {
    const promotionId = input.promotion_id == null ? undefined : id(input.promotion_id, 'promotion_id');
    const prior = promotionId ? await live(ctx, 'promotion', promotionId) : undefined;
    const storeId = prior?.data.store_id ?? id(input.store_id, 'store_id');
    await guard(ctx, storeId);
    const s = await store(ctx, storeId);
    const current = promotionId ? await live(ctx, 'promotion', promotionId) : undefined;
    if (current) version(input, current);
    if (current?.data.state === 'cancelled') return conflict('invalid_state', 'Promotion is cancelled');
    const from = instant(input.valid_from ?? current?.data.valid_from, 'valid_from');
    const until = instant(input.valid_until ?? current?.data.valid_until, 'valid_until');
    if (from >= until) return bad('valid_until');
    const state = one(input.state ?? current?.data.state ?? 'draft', 'state', ['draft', 'scheduled', 'cancelled']);
    if (state === 'cancelled' && !current) return bad('state');
    const ruleInput = obj(input.rule ?? current?.data.rule, 'rule');
    const rule: Fields = {};
    if ((ruleInput.percent_off == null) === (ruleInput.amount_off_minor == null)) return bad('rule discount');
    if (ruleInput.percent_off != null) rule.percent_off = integer(ruleInput.percent_off, 'percent_off', 1, 100);
    if (ruleInput.amount_off_minor != null) rule.amount_off_minor = integer(ruleInput.amount_off_minor, 'amount_off_minor', 1);
    if (ruleInput.minimum_spend_minor != null) rule.minimum_spend_minor = integer(ruleInput.minimum_spend_minor, 'minimum_spend_minor', 1);
    if (ruleInput.minimum_quantity != null) rule.minimum_quantity = integer(ruleInput.minimum_quantity, 'minimum_quantity', 1);
    if (rule.amount_off_minor || rule.minimum_spend_minor) rule.currency = currency(ruleInput.currency ?? s.data.default_currency);
    rule.product_ids = IDs(ruleInput.product_ids ?? [], 'product_ids');
    for (const key of rule.product_ids) if ((await live(ctx, 'product', key)).data.store_id !== s.id) return bad('product_ids');
    const markets = IDs(input.market_ids ?? current?.data.market_ids ?? [], 'market_ids');
    for (const key of markets) if (!active(await ctx.get('workspace', 'market', key))) throw new DomainError('not_found', 'Market not found', 404);
    const campaign = input.campaign_id === undefined ? current?.data.campaign_id ?? null : input.campaign_id === null ? null : id(input.campaign_id, 'campaign_id');
    if (campaign && !active(await ctx.get('campaign', 'campaign', campaign))) throw new DomainError('not_found', 'Campaign not found', 404);
    const externalId = input.external_discount_id === undefined ? current?.data.external_discount_id ?? null : input.external_discount_id === null ? null : id(input.external_discount_id, 'external_discount_id');
    if (externalId && (await list(ctx, 'promotion')).some(row => active(row) && row.id !== current?.id && row.data.store_id === storeId && row.data.external_discount_id === externalId)) return conflict('duplicate_promotion', 'Discount already exists in this store');
    const data = { store_id: s.id, name: str(input.name ?? current?.data.name, 'name'), campaign_id: campaign, external_discount_id: externalId, market_ids: markets, valid_from: from, valid_until: until, state, rule, verified_at: null };
    const row = current ? await update(ctx, current, data) : await insert(ctx, 'promotion', data);
    if (input.codes !== undefined) {
      if (!Array.isArray(input.codes) || input.codes.length > 100) return bad('codes');
      const codes = new Map<string, Fields>();
      for (const entry of input.codes) {
        const value = obj(entry, 'code');
        const code = str(value.code, 'code', 128);
        if (codes.has(code)) return bad('duplicate code');
        codes.set(code, { code, external_id: value.external_id == null ? null : id(value.external_id, 'code.external_id'), assigned_to: value.assigned_to == null ? null : id(value.assigned_to, 'assigned_to'), usage_limit: value.usage_limit == null ? null : integer(value.usage_limit, 'usage_limit', 1), retired_at: null });
      }
      for (const prior of (await list(ctx, 'promotion_code')).filter(code => code.data.promotion_id === row.id)) {
        const next = codes.get(prior.data.code);
        if (next) {
          await update(ctx, prior, next);
          codes.delete(prior.data.code);
        } else if (!prior.data.retired_at) await update(ctx, prior, { retired_at: ctx.now });
      }
      for (const code of codes.values()) await insert(ctx, 'promotion_code', { ...code, promotion_id: row.id, store_id: s.id });
    }
    const effective = effectiveState(row, ctx.now);
    await ctx.emit(effective === 'expired' ? 'commerce.promotion.expired' : 'commerce.promotion.changed', { promotion_id: row.id, store_id: s.id, state: effective });
    return view(ctx, row);
  } },
  promotion_get: { roles: readers, async run(ctx, input) {
    if (input.promotion_id != null) return view(ctx, await live(ctx, 'promotion', id(input.promotion_id, 'promotion_id')));
    const campaign = id(input.campaign_id, 'campaign_id');
    return Promise.all((await list(ctx, 'promotion')).filter(row => active(row) && row.data.campaign_id === campaign).map(row => view(ctx, row)));
  } },
};
