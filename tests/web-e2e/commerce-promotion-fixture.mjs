import assert from 'node:assert/strict';

// Merchant-owned test data lives on the simulated provider, not in SmartSell.
export function promotionProvider() {
  const discountId = 'gid://shopify/DiscountCodeNode/707';
  const placedAt = new Date(Date.now() - 3_600_000).toISOString();
  const pageInfo = { hasNextPage: false, endCursor: null };
  return (query, variables) => {
    assert.doesNotMatch(query, /\bmutation\b/);
    if (query.includes('PromotionReadback')) {
      assert.match(query, /codeDiscountNode\(id: \$id\)/);
      if (variables.id !== discountId) return { data: { codeDiscountNode: null } };
      return { data: { codeDiscountNode: { id: discountId, codeDiscount: {
        __typename: 'DiscountCodeBasic', startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', status: 'ACTIVE',
        usageLimit: null, appliesOncePerCustomer: false, minimumRequirement: null, context: { __typename: 'DiscountCustomerAll' },
        customerGets: { appliesOnOneTimePurchase: true, appliesOnSubscription: false,
          items: { __typename: 'AllDiscountItems' }, value: { __typename: 'DiscountPercentage', percentage: 0.1 } },
        codes: { nodes: [{ code: 'PC07SAVE' }], pageInfo },
      } } } };
    }
    if (query.includes('TradeOrders')) {
      assert.match(query, /\bdiscountCodes\b/);
      const window = [...variables.filter.matchAll(/updated_at:[^']+'([^']+)'/g)].map(match => match[1]);
      assert.equal(window.length, 2);
      const nodes = window[0] <= placedAt && placedAt < window[1] ? [{
        id: 'gid://shopify/Order/707', createdAt: placedAt, updatedAt: placedAt, displayFinancialStatus: 'PAID',
        totalPriceSet: { shopMoney: { amount: '90.00', currencyCode: 'USD' } },
        totalDiscountsSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } }, discountCodes: ['PC07SAVE'],
      }] : [];
      return { data: { orders: { nodes, pageInfo } } };
    }
  };
}
