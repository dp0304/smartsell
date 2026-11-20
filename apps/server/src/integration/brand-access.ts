import { Problem, type Context, type Role, type Row } from '@smartsell/contracts';
import { invalid, missing } from '../identity.js';

const reads = new Set([
  'workspace_brands_list', 'workspace_brand_get', 'workspace_markets_list', 'workspace_market_get', 'workspace_get_context',
  'search_query', 'asset_search', 'asset_get', 'asset_list_versions', 'knowledge_get_context', 'catalog_list_facts', 'agent_preview_context',
]);

export function validateBrandScopes(ctx: Context, role: Role, scopes: string[]) {
  if (scopes.length && role !== 'viewer') throw invalid('Brand scopes require the viewer role');
  if (scopes.some(scope => !scope.startsWith('brand:'))) throw invalid('Expected brand:<id> scopes');
  for (const scope of scopes) ctx.get('brand', scope.slice('brand:'.length));
  return [...new Set(scopes)];
}

export function brandOperationAllowed(scopes: readonly string[] | undefined, name: string, method: string) {
  return !scopes?.length || (method === 'GET' && reads.has(name));
}

export function scopedBrandContext(ctx: Context, scopes: readonly string[] | undefined): Context {
  if (!scopes?.length) return ctx;
  const allowed = new Set(scopes.filter(scope => scope.startsWith('brand:')).map(scope => scope.slice('brand:'.length)));
  const parents: Record<string, [string, string]> = {
    asset_version: ['asset', 'asset_id'], asset_rendition: ['asset_version', 'asset_version_id'],
    knowledge_revision: ['knowledge_entry', 'entry_id'], product_fact: ['product', 'product_id'],
    product_fact_revision: ['product_fact', 'fact_id'],
  };
  function visible(kind: string, row: Row): boolean {
    if (kind === 'workspace') return true;
    if (kind === 'brand') return allowed.has(row.id);
    if (kind === 'knowledge_revision' && row.review_status !== 'approved') return false;
    if (kind === 'product_fact_revision' && row.review_status !== 'approved') return false;
    if (typeof row.brand_id === 'string' && !allowed.has(row.brand_id)) return false;
    const parent = parents[kind];
    if (!parent) return typeof row.brand_id === 'string';
    const [parentKind, parentKey] = parent;
    const parentId = row[parentKey];
    if (typeof parentId !== 'string') return false;
    try {
      return visible(parentKind, ctx.get(parentKind, parentId));
    } catch (error) {
      if (error instanceof Problem && error.status === 404) return false;
      throw error;
    }
  }
  return { ...ctx,
    list: kind => ctx.list(kind).filter(row => visible(kind, row)),
    get(kind, id) {
      const row = ctx.get(kind, id);
      if (!visible(kind, row)) throw missing();
      return row;
    },
  };
}
