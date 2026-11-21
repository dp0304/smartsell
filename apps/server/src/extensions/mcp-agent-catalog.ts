import type { Registered } from '../operations.js';

const businessTools = new Set([
  'search_query', 'asset_search', 'asset_get', 'asset_list_versions', 'knowledge_get_context',
  'catalog_search', 'catalog_list_facts', 'workspace_brands_list', 'workspace_brand_get',
  'workspace_markets_list', 'workspace_market_get', 'workspace_get_context',
  'account_list_devices', 'accounts_check_operation', 'devices_list', 'mobile_devices_list',
  'research_search', 'research_item_evidence', 'research_create_note', 'creative_reference_annotate',
  'items_get', 'tasks_get', 'publishing_get_target',
  'content_get_variant', 'content_autosave_variant', 'content_commit_revision', 'content_update_variant',
  'inbox_claim', 'inbox_release', 'inbox_send_reply',
]);

export function agentToolAllowed(operation: Registered) {
  if (operation.module === 'agent') return operation.mcp === true;
  return operation.mcp !== false && businessTools.has(operation.name);
}
