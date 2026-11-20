// Columns are an explicit allowlist. The runtime envelope often contains other fields,
// including sealed credentials, which must not be copied into the typed tables.
export interface Mapping {
  table: string;
  columns: string[];
  required: string[];
  immutable?: boolean;
  versionless?: boolean;
  actorless?: boolean;
  defaults?: Record<string, unknown>;
  aliases?: Record<string, string>;
  parents?: Record<string, string>;
  read?: string[];
}

type Options = Omit<Mapping, 'table' | 'columns' | 'required' | 'read'> & { read?: string };
function map(table: string, required: string, extra: string, { read, ...options }: Options = {}): Mapping {
  return { table, required: required.split(' '), columns: `${required} ${extra}`.trim().split(' '), ...options,
    ...(read ? { read: read.split(' ') } : {}) };
}

export const mappings: Record<string, Mapping> = {
  store: map('commerce.store', 'brand_id provider name default_currency default_locale status',
    'connection_id external_store_id region sync_scope status_reason last_snapshot_at last_incremental_at', {
      parents: { brand_id: 'brand', connection_id: 'connection' }, read: 'name status default_currency default_locale',
    }),
  product: map('commerce.product', 'store_id brand_id title status source',
    'external_product_id handle product_type vendor source_updated_at', {
      parents: { store_id: 'store', brand_id: 'brand' }, read: 'title status handle product_type vendor',
    }),
  product_variant: map('commerce.product_variant', 'product_id store_id status source', 'external_variant_id sku barcode options', {
    actorless: true, parents: { product_id: 'product', store_id: 'store' }, read: 'sku barcode options status',
  }),
  brand: map('workspace.brand', 'name slug status', 'logo_file_id default_market_id', {
    defaults: { status: 'active' }, read: 'name slug status', parents: { logo_file_id: 'file_object' },
  }),
  market: map('workspace.market', 'brand_id name country_code primary_language languages currency timezone status', 'sales_channels', {
    defaults: { status: 'active', sales_channels: [] }, parents: { brand_id: 'brand' },
    read: 'name country_code primary_language languages currency timezone status sales_channels',
  }),
  work_item: map('workspace.work_item', 'type title status source_type',
    'description priority assignee_type assignee_id due_at board_key stage_key sort_rank brand_id campaign_id resource_type resource_id parent_id blocked_reason completion_criteria source_ref dedupe_key completed_at completed_by_type completed_by_id', {
      defaults: { priority: 'normal', source_type: 'manual' }, aliases: { type: 'kind' }, parents: { brand_id: 'brand', parent_id: 'work_item', campaign_id: 'campaign' },
      read: 'type title status priority blocked_reason',
    }),
  campaign: map('campaign.campaign', 'brand_id name kind status timezone owner_user_id utm_key',
    'starts_at ends_at audience_note objective_summary template_id closed_at', {
      parents: { brand_id: 'brand' }, read: 'name kind status timezone audience_note objective_summary utm_key',
    }),
  content_pillar: map('content.content_pillar', 'brand_id name', 'description audience_note target_share evergreen archived_at', {
    defaults: { evergreen: false }, parents: { brand_id: 'brand' }, read: 'name description audience_note evergreen',
  }),
  idea: map('content.idea', 'brand_id title origin status', 'pillar_id campaign_id hypothesis objective audience_note origin_refs observed_at priority tags', {
    defaults: { origin_refs: [], tags: [] }, parents: { brand_id: 'brand', pillar_id: 'content_pillar', campaign_id: 'campaign' },
    read: 'title origin status',
  }),
  content_item: map('content.content_item', 'brand_id title production_stage',
    'campaign_id pillar_id idea_id owner_user_id production_due_at derived_from_item_id blocked_reason archived_at', {
      parents: { brand_id: 'brand', campaign_id: 'campaign', pillar_id: 'content_pillar', idea_id: 'idea', derived_from_item_id: 'content_item' },
      read: 'title production_stage blocked_reason',
    }),
  content_variant: map('content.content_variant', 'content_item_id platform format locale draft_doc readiness',
    'market_id social_account_id parent_variant_id current_revision_id stale_reasons derived_from_revision_id owner_user_id archived_at', {
      defaults: { stale_reasons: [] }, aliases: { market_id: 'market', readiness: 'state' }, parents: {
        content_item_id: 'content_item', market_id: 'market', social_account_id: 'social_account', parent_variant_id: 'content_variant', derived_from_revision_id: 'content_revision',
      }, read: 'platform format locale draft_doc readiness stale_reasons',
    }),
  content_revision: map('content.content_revision', 'variant_id revision_no body_doc rendered origin content_hash',
    'media product_refs link_refs settings ai_generated agent_job_id based_on_revision_id restored_from_revision_id', {
      immutable: true, versionless: true, defaults: { media: [], product_refs: [], link_refs: [], settings: {}, ai_generated: false },
      parents: { variant_id: 'content_variant', based_on_revision_id: 'content_revision', restored_from_revision_id: 'content_revision' }, read: 'revision_no body_doc rendered origin content_hash media product_refs link_refs settings ai_generated',
    }),
  content_stage_history: map('content.content_stage_history', 'content_item_id to_stage changed_by_type changed_at',
    'from_stage changed_by_id note', { immutable: true, versionless: true, actorless: true, parents: { content_item_id: 'content_item' } }),
  translation_link: map('content.translation_link', 'target_variant_id source_variant_id source_revision_id status',
    'target_revision_id glossary_version divergence_note', { parents: {
      target_variant_id: 'content_variant', source_variant_id: 'content_variant', source_revision_id: 'content_revision', target_revision_id: 'content_revision',
    } }),
  connection: map('account.connection', 'provider purpose auth_strategy status',
    'platform_app_id external_principal_id external_principal_name granted_scopes required_scopes status_reason secret_id access_expires_at refresh_expires_at last_refreshed_at last_verified_at revoked_at revoked_by meta', {
      defaults: { auth_strategy: 'oauth2', granted_scopes: [], required_scopes: [], meta: {} },
      aliases: { external_principal_id: 'principal_id', access_expires_at: 'expires_at' },
      parents: { platform_app_id: 'platform_app', secret_id: 'secret' },
    }),
  social_account: map('account.social_account', 'provider external_account_id brand_id status',
    'handle display_name avatar_file_id account_type owner_user_id default_timezone write_connection_id disabled_reason profile_observed_at', {
      aliases: { display_name: 'name' }, parents: { brand_id: 'brand', write_connection_id: 'connection' },
      read: 'provider external_account_id handle display_name account_type default_timezone status disabled_reason',
    }),
  file_object: map('core.file_object', 'storage_key bucket mime_type size_bytes sha256 scan_status purpose',
    'original_filename retention_until deleted_at', { versionless: true }),
  evidence: map('core.evidence', 'kind captured_at linked_resource_type linked_resource_id',
    'file_object_id url note content_hash capture_context masked retention_until', {
      immutable: true, versionless: true, defaults: { masked: false },
      aliases: { captured_at: 'observed_at', linked_resource_type: 'resource_type', linked_resource_id: 'resource_id' },
      parents: { file_object_id: 'file_object' }, read: 'kind note url content_hash masked',
    }),
  approval_policy: map('core.approval_policy', 'name resource_type conditions steps change_tolerance mode', 'active', { defaults: { active: true } }),
  approval_request: map('core.approval_request', 'resource_type resource_id resource_hash status',
    'policy_id policy_version current_step approved_via standing_grant_id due_at decided_at invalidated_reason context', {
      defaults: { current_step: 1 }, parents: { policy_id: 'approval_policy' }, read: 'status resource_hash current_step approved_via decided_at invalidated_reason',
    }),
  approval_decision: map('core.approval_decision', 'request_id step_no decision decided_by_user_id decided_via decided_at', 'comment', {
    immutable: true, actorless: true, versionless: true, parents: { request_id: 'approval_request' },
  }),
  publish_plan: map('planning.publish_plan', 'source status', 'campaign_id title commit_mode preview committed_at operation_id agent_job_id', {
    defaults: { source: 'manual', commit_mode: 'partial' }, aliases: { title: 'name' }, parents: { campaign_id: 'campaign', operation_id: 'operation' },
  }),
  publish_target: map('planning.publish_target', 'brand_id social_account_id content_item_id content_variant_id variant_revision_id content_format schedule_kind plan_status',
    'plan_id campaign_id operation visibility options scheduled_at schedule_tz local_scheduled_at dst_resolution late_policy grace_minutes connector_mode_pref close_reason approval_request_id frozen_hash last_precheck_run_id precheck_summary origin schedule_rule_id evergreen_queue_item_id execution_task_id paused_by_switch_id owner_user_id', {
      defaults: { operation: 'publish', visibility: 'public', options: {}, connector_mode_pref: 'inherit', origin: 'manual' },
      aliases: { social_account_id: 'account_id', variant_revision_id: 'revision_id' }, parents: {
        brand_id: 'brand', social_account_id: 'social_account', content_item_id: 'content_item', content_variant_id: 'content_variant',
        variant_revision_id: 'content_revision', plan_id: 'publish_plan', campaign_id: 'campaign', approval_request_id: 'approval_request',
      }, read: 'plan_status content_format schedule_kind visibility options frozen_hash',
    }),
  precheck_run: map('planning.precheck_run', 'publish_target_id stage target_version overall checked_at', 'valid_until', {
    immutable: true, versionless: true, parents: { publish_target_id: 'publish_target' },
  }),
  pause_switch: map('planning.pause_switch', 'scope_type scope_id reason activated_at', 'mode released_at released_by release_decisions', { defaults: { mode: 'hold' } }),
  execution_task: map('execution.execution_task', 'publish_target_id social_account_id operation content_format frozen frozen_hash route status late_policy',
    'frozen_version due_at prepare_lead_seconds sub_status status_reason active_attempt_id attempt_count auto_retry_count grace_minutes cancel_requested_at cancel_requested_by platform_post_id first_started_at finished_at lease_owner_type lease_owner_id lease_expires_at fencing_token', {
      actorless: true, defaults: { frozen_version: 1, prepare_lead_seconds: 300, attempt_count: 0, auto_retry_count: 0, grace_minutes: 0, fencing_token: 0 },
      parents: { publish_target_id: 'publish_target', social_account_id: 'social_account' }, read: 'status sub_status status_reason',
    }),
  execution_attempt: map('execution.execution_attempt', 'task_id attempt_no executor fencing_token client_request_id request_hash status triggered_by_type',
    'purpose parent_attempt_id device_id connector_channel mobile_device_id mobile_app connector_mode submitted_by adapter adapter_version api_version external_refs receipt error_class error_detail submitted_at outcome_checked_at next_check_at check_count started_at finished_at triggered_by_id', {
      actorless: true, versionless: true, defaults: { purpose: 'submit', external_refs: {}, check_count: 0 },
      parents: { task_id: 'execution_task', parent_attempt_id: 'execution_attempt', device_id: 'device', mobile_device_id: 'mobile_device' },
    }),
  platform_post: map('execution.platform_post', 'social_account_id provider origin verification post_status first_seen_at source',
    'external_post_id permalink post_type submitted_by visibility published_at caption_snapshot media_summary publish_target_id execution_task_id campaign_id last_observed_at evidence_ids', {
      actorless: true, defaults: { evidence_ids: [] }, parents: { social_account_id: 'social_account', publish_target_id: 'publish_target', execution_task_id: 'execution_task' },
    }),
};

// Some optional references point at tables which are not yet populated by this repository.
// They can still be linked when an already scoped typed row exists, e.g. after an import.
export const externalParents: Record<string, string> = {
  file_object: 'core.file_object', secret: 'core.secret', operation: 'core.operation', platform_app: 'account.platform_app',
  device: 'account.device', mobile_device: 'account.mobile_device',
};
