import type { Entity, Role } from './modules/types';

type Policy = { fields: string[]; roles?: readonly Role[] };
const members = ['owner', 'admin', 'editor', 'reviewer'] as const;
const admins = ['owner', 'admin'] as const;
const policy = (fields: string, roles?: readonly Role[]): Policy => ({ fields: fields.split(' '), roles });

// Public-to-the-workspace fields only. New record kinds and fields require review.
const records = new Map<string, Policy>(Object.entries({
  'workspace.brand': policy('name slug status description default_locale'),
  'workspace.work_item': policy('title status due_at assignee_id brand_id priority', members),
  'account.social_account': policy('platform display_name handle status brand_id'),
  'account.connection': policy('provider platform status expires_at access_expires_at', admins),
  'account.device': policy('name label platform status last_seen_at', admins),
  'account.account_block': policy('status reason kind severity social_account_id', members),
  'ingest.data_source': policy('name provider kind status', members),
  'ingest.import_template': policy('name kind status version_no', members),
  'ingest.sync_run': policy('source_id status started_at finished_at row_count', members),
  'ingest.quality_issue': policy('source_id sync_run_id status kind severity', members),
  'commerce.store': policy('name provider status default_currency brand_id'),
  'commerce.product': policy('title name sku status store_id brand_id currency price'),
  'commerce.product_change': policy('product_id kind status changed_at'),
  'campaign.campaign': policy('name title status kind starts_at ends_at brand_id'),
  'intel.watch_target': policy('name platform kind status', members),
  'intel.research_board': policy('name title status brand_id', members),
  'intel.product_candidate': policy('name title status brand_id', members),
  'content.content_item': policy('title production_stage status campaign_id brand_id production_due_at'),
  'content.idea': policy('title status brand_id'),
  'content.pillar': policy('name title status brand_id'),
  'content.content_pillar': policy('name title status brand_id'),
  'asset.asset': policy('title name status mime_type media_type brand_id'),
  'asset.rights_grant': policy('asset_id status starts_at expires_at', members),
  'asset.knowledge': policy('title name status brand_id', members),
  'asset.knowledge_entry': policy('title kind status brand_id current_revision_id active_revision_id', members),
  'asset.template': policy('name kind status brand_id', members),
  'content.content_variant': policy('platform format locale market_id brand_id content_item_id readiness', members),
  'workspace.market': policy('name code locale brand_id status'),
  'planning.publish_target': policy('title status scheduled_at social_account_id content_id content_item_id'),
  'planning.approval_policy': policy('name title status brand_id', members),
  'planning.approval': policy('status target_id approval_type created_at', members),
  'execution.task': policy('title status sub_status executor target_id', members),
  'execution.execution_task': policy('title status sub_status executor target_id', members),
  'execution.platform_post': policy('title origin verification published_at social_account_id'),
  'inbox.tag': policy('name label color status', members),
  'creator.collaboration': policy('title name status creator_id starts_at due_at', members),
  'traffic.short_link': policy('name title status expires_at', members),
  'traffic.landing_page': policy('name title status', members),
  'ads.ad_account': policy('name provider platform status currency', members),
  'ads.ad_entity': policy('name title status kind ad_account_id', members),
  'ads.adjustment_suggestion': policy('name title status kind ad_entity_id', members),
  'lifecycle.esp_flow': policy('name provider status kind', admins),
  'analytics.report': policy('name title kind status'),
  'analytics.metric_definition': policy('key name unit availability'),
  'agent.automation_rule': policy('name kind status enabled', admins),
  'team.task': policy('title status dueAt due_at', members),
  'team.delivery': policy('title name status publishedAt', members),
  'team.handover': policy('status completedAt', admins),
}));

export function readProjection(module: string, kind: string, role: Role) {
  const found = records.get(`${module}.${kind}`);
  if (!found || (found.roles && !found.roles.includes(role))) return undefined;
  return (row: Entity): Entity => ({ ...row, data: Object.fromEntries(found.fields.flatMap(key => {
    const value = row.data[key];
    return value === null || ['boolean', 'number', 'string'].includes(typeof value) ? [[key, value]] : [];
  })) });
}
