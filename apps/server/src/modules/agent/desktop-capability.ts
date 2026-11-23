import { Problem, type Operation, type Row } from '@smartsell/contracts';
import { missing } from '../../identity.js';
import { COMMERCE_WRITE } from '../commerce/store-operations.js';

const path = '/desktop-capability-requests';
const kind = 'desktop_capability_request';
const reference = { type: 'string', format: 'uuid' } as const;
const properties = {
  capability: { type: 'string', const: 'product_listing' }, product_id: reference, variant_id: reference, store_id: reference,
} as const;

export const desktopCapabilityNames = ['desktop_request_capability', 'desktop_get_capability_request'] as const;

function ref(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) {
    throw new Problem(422, 'INVALID_INPUT', `Invalid ${field}`);
  }
  return value;
}

function receipt(row: Row) {
  const { id, workspace_id, actor_id, requested_at, capability, status, reason, product_id, variant_id, store_id } = row;
  return { id, workspace_id, actor_id, requested_at, capability, status, reason, product_id,
    ...(variant_id !== undefined && { variant_id }), ...(store_id !== undefined && { store_id }) };
}

export const desktopCapabilityOperations: Operation[] = [
  { method: 'POST', path, name: desktopCapabilityNames[0], roles: COMMERCE_WRITE,
    summary: 'Record an unsupported product listing request without listing anything or scheduling a Worker',
    contract: { bodyRequired: true, body: { type: 'object', additionalProperties: false, required: ['capability', 'product_id'], properties } },
    run(ctx, { body, query, expectedVersion, idempotencyKey }) {
      if (!idempotencyKey || expectedVersion !== undefined || Object.keys(query).length || body.capability !== 'product_listing' ||
        Object.keys(body).some(field => !Object.hasOwn(properties, field))) {
        throw new Problem(422, 'INVALID_INPUT', 'Expected an idempotency key, product listing capability and catalog references only');
      }
      const product = ctx.get('product', ref(body.product_id, 'product_id'));
      const variant = body.variant_id === undefined ? undefined : ctx.get('product_variant', ref(body.variant_id, 'variant_id'));
      const store = body.store_id === undefined ? undefined : ctx.get('store', ref(body.store_id, 'store_id'));
      if ((variant && variant.product_id !== product.id) || (store && store.id !== product.store_id)) {
        throw new Problem(422, 'INVALID_INPUT', 'Catalog references do not belong to the same product');
      }
      return receipt(ctx.create(kind, {
        workspace_id: ctx.workspaceId, actor_id: ctx.actorId, requested_at: ctx.now, capability: 'product_listing',
        status: 'unsupported', reason: 'product_listing_not_supported', product_id: product.id,
        ...(variant && { variant_id: variant.id }), ...(store && { store_id: store.id }),
      }));
    },
  },
  { method: 'GET', path: `${path}/:id`, name: desktopCapabilityNames[1], roles: COMMERCE_WRITE,
    summary: 'Read your retained unsupported desktop capability receipt',
    run(ctx, { params, body, query }) {
      if (Object.keys(body).length || Object.keys(query).length) throw new Problem(422, 'INVALID_INPUT', 'Expected a receipt ID only');
      const row = ctx.get(kind, ref(params.id, 'id'));
      if (row.actor_id !== ctx.actorId) throw missing();
      return receipt(row);
    },
  },
];
