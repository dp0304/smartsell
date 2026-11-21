import { Problem } from '@smartsell/contracts';
import { AdapterError } from '../../../../../packages/adapters/src/official.ts';
import { connectionContext, type AccountServices } from '../account/oauth.js';
import { unavailable, type CommerceServices } from './store-operations.js';

export function bindPromotionReadback(account: AccountServices): NonNullable<CommerceServices['readPromotion']> {
  return async (ctx, store, id) => {
    if (store.provider !== 'shopify') return unavailable('Promotion readback is only available for authorized Shopify stores');
    const authorizationRequired = () => new Problem(409, 'discount_authorization_required', 'Authorize this Shopify store with the read_discounts scope');
    if (typeof store.connection_id !== 'string' || typeof store.external_store_id !== 'string' || !['active', 'connecting', 'degraded'].includes(String(store.status))) throw authorizationRequired();
    const connection = ctx.get('connection', store.connection_id);
    if (connection.provider !== store.provider || connection.purpose !== 'store' || connection.brand_id !== store.brand_id ||
        typeof connection.platform_app_id !== 'string' || !Array.isArray(connection.scopes) || !connection.scopes.includes('read_discounts')) throw authorizationRequired();
    const install = account.shopifyApp?.(ctx, connection.platform_app_id);
    const adapter = account.adapter?.('shopify', connection.platform_app_id);
    if (!install?.egressVerified || !install.oauthScopes.includes('read_discounts') || !adapter?.readPromotion) throw authorizationRequired();
    const auth = connectionContext(ctx, connection, account, store.external_store_id);
    try {
      return await adapter.readPromotion(id, auth);
    } catch (error) {
      if (error instanceof AdapterError && error.errorClass === 'invalid_input') throw new Problem(422, 'invalid_discount_id', 'Enter the Shopify DiscountCodeNode GID');
      const classification = adapter.classifyError(error);
      if (['auth_expired', 'permission_denied'].includes(classification.errorClass)) throw authorizationRequired();
      return unavailable('Shopify discount readback failed; retry before relying on this offer');
    }
  };
}
