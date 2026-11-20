import type { ConnectionCtx } from './adapter-types.ts';
import { graphConnection, shopifyGraphql } from './provider-commerce.ts';
import { AdapterError, record, text, type Client } from './provider-http.ts';

export interface PromotionReadback {
  rule: { percent_off: number };
  valid_from: string;
  valid_until: string;
  codes: string[];
  status: 'ACTIVE' | 'EXPIRED' | 'SCHEDULED';
}

/** Only verify the offer shape we can faithfully represent. Never match a restricted offer as sitewide. */
export async function readShopifyPromotion(request: Client, token: string, ctx: ConnectionCtx, id: string): Promise<PromotionReadback | null> {
  if (!/^gid:\/\/shopify\/DiscountCodeNode\/\d+$/.test(id)) throw new AdapterError('invalid_input', 'invalid_shopify_discount_id');
  const response = await shopifyGraphql(request, token, ctx.shopDomain, `query PromotionReadback($id: ID!) {
    codeDiscountNode(id: $id) { id codeDiscount { __typename ... on DiscountCodeBasic {
      startsAt endsAt status usageLimit appliesOncePerCustomer minimumRequirement { __typename }
      context { __typename }
      customerGets { appliesOnOneTimePurchase appliesOnSubscription items { __typename } value { __typename ... on DiscountPercentage { percentage } } }
      codes(first: 100) { nodes { code } pageInfo { hasNextPage endCursor } }
    } } }
  }`, { id });
  const data = record(record(response.body).data);
  if (data.codeDiscountNode === null) return null;
  const node = record(data.codeDiscountNode);
  if (node.id !== id) throw new AdapterError('transient', 'discount_identity_mismatch');
  const discount = record(node.codeDiscount);
  const gets = record(discount.customerGets);
  const value = record(gets.value);
  const percent = Number(value.percentage) * 100;
  const from = Date.parse(text(discount.startsAt) ?? '');
  const until = Date.parse(text(discount.endsAt) ?? '');
  const status = discount.status;
  if (discount.__typename !== 'DiscountCodeBasic' || record(discount.context).__typename !== 'DiscountCustomerAll' ||
      record(gets.items).__typename !== 'AllDiscountItems' || gets.appliesOnOneTimePurchase !== true || gets.appliesOnSubscription !== false ||
      discount.minimumRequirement !== null || discount.usageLimit !== null || discount.appliesOncePerCustomer !== false ||
      value.__typename !== 'DiscountPercentage' || Math.abs(percent - Math.round(percent)) > 1e-9 || !(percent > 0 && percent <= 100) ||
      !Number.isFinite(from) || !Number.isFinite(until) || from >= until ||
      (status !== 'ACTIVE' && status !== 'EXPIRED' && status !== 'SCHEDULED')) return null;
  const { nodes, nextCursor } = graphConnection(discount.codes, 'malformed_discount_codes');
  const codes = nodes.map(item => text(item.code));
  if (nextCursor || !codes.length || codes.some(code => !code)) return null;
  return { rule: { percent_off: Math.round(percent) }, valid_from: new Date(from).toISOString(), valid_until: new Date(until).toISOString(), codes: codes as string[], status };
}
