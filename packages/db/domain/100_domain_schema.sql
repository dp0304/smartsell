-- plan.md §§4–5. Expanded table definitions (PostgreSQL 17).
-- Foreign keys follow table creation to support forward and cyclic references.
set local search_path = pg_catalog, public;

create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
create extension if not exists btree_gist with schema public;

create schema core;
create schema iam;
create schema workspace;
create schema account;
create schema ingest;
create schema commerce;
create schema campaign;
create schema intel;
create schema content;
create schema asset;
create schema planning;
create schema execution;
create schema inbox;
create schema traffic;
create schema analytics;
create schema agent;
create schema team;
create schema ops;

create table core.tenant (
  id uuid primary key,
  name text not null,
  deployment_kind text not null check (deployment_kind in ('saas','private')),
  data_region text not null,
  status text not null check (status in ('active','suspended')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table iam.user (
  id uuid primary key,
  email citext not null unique,
  display_name text not null,
  ui_locale text check (ui_locale in ('zh-Hant','en')),
  timezone text not null default 'Asia/Taipei',
  password_hash text,
  mfa jsonb,
  kind text not null check (kind in ('staff','portal_client','portal_creator')),
  status text not null check (status in ('invited','active','disabled')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table iam.tenant_membership (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  user_id uuid not null,
  tenant_role text not null check (tenant_role in ('owner','admin','member','guest')),
  status text not null check (status in ('invited','active','removed')),
  unique (tenant_id, user_id)
);

create table iam.workspace_membership (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  user_id uuid not null,
  status text not null check (status in ('invited','active','suspended','removed')),
  invited_by uuid, joined_at timestamptz, removed_at timestamptz,
  handover_to_user_id uuid,
  unique (workspace_id, user_id),
  unique (tenant_id, id)
);

create table iam.role (
  id uuid primary key,
  tenant_id uuid,
  key text not null, name text not null,
  permissions text[] not null,
  is_system boolean not null default false,
  version integer not null default 1 check (version > 0),
  unique nulls not distinct (tenant_id, key)
);

create table iam.membership_role (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  workspace_membership_id uuid not null,
  role_id uuid not null,
  scope jsonb,
  unique (workspace_membership_id, role_id)
);

create table iam.session (
  id uuid primary key, user_id uuid not null, tenant_id uuid,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  ip inet, user_agent text, revoked_at timestamptz
);

create table iam.api_token (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  owner_type text not null check (owner_type in ('user','service_account')),
  owner_id uuid not null,
  name text not null,
  token_hash bytea not null unique,
  scopes text[] not null,
  workspace_ids uuid[] not null,
  tool_allowlist text[],
  expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz,
  unique (tenant_id, id)
);

create table iam.oauth_client (
  id uuid primary key, tenant_id uuid,
  client_id text not null unique,
  name text not null, kind text not null check (kind in ('mcp_host','integration')),
  redirect_uris text[] not null,
  registered_via text not null check (registered_via in ('admin','dcr','cimd')),
  status text not null check (status in ('active','blocked')),
  created_at timestamptz not null default now()
);

create table iam.oauth_grant (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  user_id uuid not null, client_id uuid not null,
  scopes text[] not null, workspace_ids uuid[] not null,
  tool_allowlist text[],
  refresh_token_hash bytea, expires_at timestamptz, revoked_at timestamptz,
  last_used_at timestamptz
);

create table iam.service_account (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  name text not null, purpose text, status text not null check (status in ('active','disabled')),
  unique (tenant_id, workspace_id, id)
);

create table iam.standing_grant (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  grantee_type text not null check (grantee_type in ('user','agent_client','service_account')),
  grantee_id uuid not null,
  actions text[] not null,
  resource_scope jsonb not null,
  "constraints" jsonb not null,
  valid_from timestamptz not null, valid_until timestamptz,
  revoked_at timestamptz, revoked_by uuid,
  reason text not null
);

create table core.audit_event (
  id uuid not null, tenant_id uuid not null, workspace_id uuid,
  occurred_at timestamptz not null,
  actor_type text not null, actor_id uuid,
  on_behalf_of_user_id uuid,
  via text not null check (via in ('web','portal','mcp','api','automation','connector','webhook','system')),
  action text not null,
  resource_type text not null, resource_id uuid, resource_version integer,
  outcome text not null check (outcome in ('success','denied','failed','require_approval')),
  reason text,
  diff jsonb,
  request_id text, trace_id text, idempotency_key text,
  agent_job_id uuid, tool_name text,
  ip inet, user_agent text,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table core.evidence (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  kind text not null check (kind in ('api_response','screenshot','url','file','manual_note','webhook_payload','ui_hierarchy','screen_recording')),
  file_object_id uuid,
  url text, note text,
  content_hash text,
  captured_at timestamptz not null,
  capture_context jsonb,
  masked boolean not null default false,
  retention_until timestamptz,
  linked_resource_type text not null, linked_resource_id uuid not null
);

create table core.outbox (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid,
  type text not null,
  aggregate_type text not null, aggregate_id uuid not null, aggregate_version integer,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  dispatched_at timestamptz,
  trace_id text
);

create table core.event_consumption (
  subscriber text not null, event_id uuid not null,
  consumed_at timestamptz not null default now(),
  primary key (subscriber, event_id)
);

create table core.operation (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  kind text not null,
  status text not null check (status in ('queued','running','succeeded','partially_succeeded','failed','cancel_requested','cancelled')),
  progress jsonb not null default '{}',
  input jsonb not null,
  result_ref jsonb,
  error jsonb,
  cancel_requested_at timestamptz,
  started_at timestamptz, finished_at timestamptz,
  agent_job_id uuid,
  unique (tenant_id, id),
  unique (tenant_id, workspace_id, id)
);

create table core.operation_item (
  tenant_id uuid not null, workspace_id uuid not null,
  operation_id uuid not null,
  seq integer not null,
  target_ref jsonb not null,
  status text not null check (status in ('pending','succeeded','failed','skipped')),
  reason_code text, message text,
  result_ref jsonb,
  primary key (operation_id, seq)
);

create table core.idempotency_record (
  tenant_id uuid not null, principal_id uuid not null, key text not null,
  request_hash text not null, status text not null check (status in ('in_progress','completed')),
  response_status integer, response_body jsonb,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  primary key (tenant_id, principal_id, key)
);

create table core.approval_policy (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  name text not null,
  resource_type text not null,
  conditions jsonb not null,
  steps jsonb not null,
  change_tolerance jsonb not null,
  mode text not null check (mode in ('required','optional')),
  active boolean not null default true,
  unique (tenant_id, workspace_id, id)
);

create table core.approval_request (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  resource_type text not null, resource_id uuid not null,
  resource_hash text not null,
  policy_id uuid, policy_version integer,
  status text not null check (status in ('pending','approved','rejected','changes_requested','cancelled','invalidated','expired')),
  current_step integer not null default 1,
  approved_via text check (approved_via in ('human','policy')),
  standing_grant_id uuid,
  due_at timestamptz, decided_at timestamptz,
  invalidated_reason text,
  context jsonb,
  unique (tenant_id, workspace_id, id)
);

create table core.approval_decision (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  request_id uuid not null,
  step_no integer not null,
  decision text not null check (decision in ('approve','reject','request_changes')),
  decided_by_user_id uuid not null,
  decided_via text not null check (decided_via in ('web','portal','mcp')),
  comment text,
  decided_at timestamptz not null
);

create table core.file_object (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  storage_key text not null unique,
  bucket text not null,
  mime_type text not null, size_bytes bigint not null,
  sha256 text not null,
  original_filename text,
  scan_status text not null check (scan_status in ('pending','clean','infected','skipped')),
  purpose text not null check (purpose in ('asset','evidence','import','export','attachment','avatar')),
  retention_until timestamptz,
  deleted_at timestamptz,
  unique (tenant_id, id)
);

create table core.secret (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  kind text not null check (kind in ('oauth_token','api_key','webhook_secret','model_key','signing_key')),
  ciphertext bytea not null, dek_wrapped bytea not null, kek_id text not null,
  expires_at timestamptz, rotated_from uuid, revoked_at timestamptz,
  last_used_at timestamptz,
  unique (tenant_id, id)
);

create table core.fx_rate (
  id uuid primary key,
  rate_date date not null, base char(3) not null, quote char(3) not null,
  rate numeric(20,10) not null, source text not null,
  unique (rate_date, base, quote, source)
);

create table workspace.workspace (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  slug text not null, name text not null,
  kind text not null check (kind in ('brand_team','agency_client','internal')),
  default_timezone text not null,
  default_ui_locale text not null default 'zh-Hant' check (default_ui_locale in ('zh-Hant','en')),
  reporting_currency char(3) not null,
  status text not null check (status in ('active','archived','suspended')),
  settings jsonb not null default '{}',
  unique (tenant_id, slug),
  unique (tenant_id, id)
);

create table workspace.brand (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  name text not null, slug text not null,
  logo_file_id uuid,
  default_market_id uuid,
  status text not null check (status in ('active','archived')),
  unique (workspace_id, slug),
  unique (tenant_id, workspace_id, id)
);

create table workspace.market (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  name text not null,
  country_code char(2) not null,
  primary_language text not null,
  languages text[] not null,
  currency char(3) not null,
  timezone text not null,
  sales_channels text[] not null default '{}',
  status text not null check (status in ('active','paused','archived')),
  unique (brand_id, country_code, primary_language),
  unique (tenant_id, workspace_id, brand_id, id),
  unique (tenant_id, workspace_id, id)
);

create table workspace.work_item (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  type text not null check (type in ('todo','production_task','milestone','review_task','fix_task','followup')),
  title text not null, description jsonb,
  status text not null check (status in ('open','in_progress','blocked','done','cancelled')),
  priority text not null default 'normal' check (priority in ('urgent','high','normal','low')),
  assignee_type text check (assignee_type in ('user','agent_client','team_queue')),
  assignee_id uuid,
  due_at timestamptz,
  board_key text, stage_key text,
  sort_rank text,
  brand_id uuid,
  campaign_id uuid,
  resource_type text, resource_id uuid,
  parent_id uuid,
  blocked_reason text,
  completion_criteria jsonb,
  source_type text not null check (source_type in ('manual','event','agent','automation','template')),
  source_ref jsonb,
  dedupe_key text,
  completed_at timestamptz, completed_by_type text, completed_by_id uuid,
  unique (workspace_id, dedupe_key),
  unique (tenant_id, id),
  unique (tenant_id, workspace_id, id)
);

create table workspace.work_item_dependency (
  tenant_id uuid not null,
  work_item_id uuid not null,
  depends_on_id uuid not null,
  kind text not null default 'finish_to_start',
  primary key (work_item_id, depends_on_id),
  check (work_item_id <> depends_on_id)
);

create table workspace.work_item_event (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  work_item_id uuid not null,
  kind text not null check (kind in ('assigned','status_changed','due_changed','handed_over','commented')),
  from_value jsonb, to_value jsonb, note text
);

create table workspace.notification (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid,
  recipient_user_id uuid not null,
  type text not null,
  title text not null, summary text,
  resource_type text, resource_id uuid,
  work_item_id uuid,
  source_event_id uuid,
  dedupe_key text,
  read_at timestamptz, archived_at timestamptz,
  unique (recipient_user_id, dedupe_key),
  unique (tenant_id, id)
);

create table workspace.notification_delivery (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  notification_id uuid not null,
  channel text not null check (channel in ('in_app','email','chat_webhook')),
  status text not null check (status in ('pending','delivered','failed','suppressed')),
  attempts integer not null default 0,
  last_error text, delivered_at timestamptz,
  unique (notification_id, channel)
);

create table workspace.notification_preference (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  user_id uuid not null, workspace_id uuid,
  type_pattern text not null,
  channels text[] not null,
  quiet_hours jsonb,
  unique (user_id, workspace_id, type_pattern)
);

create table workspace.subscription (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  user_id uuid not null,
  resource_type text not null, resource_id uuid not null,
  reason text not null check (reason in ('manual','assigned','mentioned','created','approver')),
  muted boolean not null default false,
  unique (user_id, resource_type, resource_id)
);

create table workspace.search_document (
  tenant_id uuid not null, workspace_id uuid not null,
  resource_type text not null, resource_id uuid not null,
  brand_id uuid, campaign_id uuid, social_account_id uuid,
  title text not null, subtitle text, excerpt text,
  status text, owner_id uuid,
  tsv tsvector not null,
  trgm_text text not null,
  source_version integer not null,
  updated_at timestamptz not null,
  primary key (resource_type, resource_id)
);

create table workspace.onboarding_progress (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  flow_key text not null,
  step_key text not null check (step_key in ('brand','market','social_account','connector_pairing','product_source','history_sync','test_draft','invite_team')),
  status text not null check (status in ('not_started','in_progress','blocked','done','skipped')),
  check_result jsonb,
  checked_at timestamptz,
  updated_by_id uuid, skip_reason text,
  unique (workspace_id, flow_key, step_key)
);

create table account.platform_app (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  provider text not null check (provider in ('shopify')),
  ownership text not null check (ownership in ('partner_custom_distribution','merchant_org')),
  name text not null,
  client_id text not null,
  secret_id uuid not null,
  grant_type text not null check (grant_type in ('authorization_code','client_credentials')),
  api_version text not null,
  scope_version text not null,
  scopes text[] not null default '{}',
  target_shop_domain text,
  allowlist_enforced boolean not null default false,
  allowlist_egress_digest bytea,
  allowlist_enforced_at timestamptz, allowlist_confirmed_by uuid,
  bulk_enabled_at timestamptz,
  bulk_last_used_at timestamptz,
  install_link_status text not null check (install_link_status in ('not_applicable','pending','issued','installed','revoked')),
  install_link_url text,
  install_link_issued_at timestamptz,
  status text not null check (status in ('draft','active','suspended','retired')),
  status_reason text,
  unique (provider, client_id),
  check ((ownership = 'merchant_org') = (install_link_status = 'not_applicable')),
  check (ownership <> 'partner_custom_distribution' or grant_type = 'authorization_code'),
  check (install_link_status not in ('issued','installed') or (allowlist_enforced and allowlist_egress_digest is not null)),
  unique (tenant_id, id)
);

create table account.connection (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  provider text not null,
  purpose text not null check (purpose in ('social','store','ads','esp','data_vendor')),
  auth_strategy text not null check (auth_strategy in ('oauth2','connector_session','api_key','none')),
  platform_app_id uuid,
  external_principal_id text,
  external_principal_name text,
  granted_scopes text[] not null default '{}',
  required_scopes text[] not null default '{}',
  status text not null check (status in ('pending','active','partial','expiring','needs_reauth','revoked','error')),
  status_reason text,
  secret_id uuid,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  last_refreshed_at timestamptz,
  last_verified_at timestamptz,
  revoked_at timestamptz, revoked_by uuid,
  meta jsonb not null default '{}',
  check (provider <> 'shopify' or platform_app_id is not null),
  unique (tenant_id, id),
  unique (tenant_id, workspace_id, id)
);

create table account.oauth_flow (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  provider text not null, user_id uuid not null,
  state_hash bytea not null unique,
  pkce_verifier_secret_id uuid,
  requested_scopes text[] not null,
  reconnect_connection_id uuid,
  brand_id uuid,
  return_to text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table account.social_account (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  provider text not null,
  external_account_id text not null,
  handle text, display_name text, avatar_file_id uuid,
  account_type text check (account_type in ('business','creator','personal','page','channel')),
  brand_id uuid not null,
  owner_user_id uuid,
  default_timezone text,
  write_connection_id uuid,
  status text not null check (status in ('active','disabled','archived')),
  disabled_reason text,
  profile_observed_at timestamptz,
  unique (tenant_id, provider, external_account_id),
  unique (tenant_id, id),
  unique (tenant_id, workspace_id, id)
);

create table account.social_account_connection (
  tenant_id uuid not null,
  social_account_id uuid not null,
  connection_id uuid not null,
  role text not null check (role in ('write','read')),
  linked_at timestamptz not null default now(),
  primary key (social_account_id, connection_id)
);

create table account.capability (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  social_account_id uuid,
  connection_id uuid,
  operation text not null,
  content_format text not null default '*',
  status text not null check (status in ('available','read_only','needs_authorization','manual_only','unsupported','unverified')),
  executors text[] not null default '{}',
  connector_channels text[] not null default '{}',
  granted_scopes text[],
  region text,
  api_version text,
  limits jsonb not null default '{}',
  source text not null check (source in ('static_matrix','probe','runtime_error','manual_override')),
  verified_at timestamptz,
  failure_reason text,
  failure_count integer not null default 0,
  check ((social_account_id is not null) or (connection_id is not null))
);

create table account.device (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  workspace_id uuid,
  name text not null,
  owner_user_id uuid not null,
  public_key text not null,
  key_fingerprint text not null unique,
  app_version text,
  os text check (os in ('windows','macos')),
  supported_task_types text[] not null default '{}',
  mobile_platforms text[] not null default '{}',
  max_mobile_devices integer,
  status text not null check (status in ('pairing','online','offline','disabled','revoked')),
  last_heartbeat_at timestamptz,
  last_ip inet,
  revoked_at timestamptz, revoked_reason text,
  unique (tenant_id, id)
);

create table account.device_pairing_code (
  id uuid primary key, tenant_id uuid not null,
  code_hash bytea not null unique,
  created_by uuid not null, workspace_id uuid,
  expires_at timestamptz not null,
  consumed_device_id uuid, consumed_at timestamptz
);

create table account.browser_session (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, version integer not null default 1 check (version > 0),
  device_id uuid not null,
  social_account_id uuid not null,
  profile_ref text not null,
  status text not null check (status in ('unbound','login_required','verified','identity_mismatch','blocked')),
  observed_platform_user_id text,
  verified_at timestamptz,
  last_checked_at timestamptz,
  blocked_reason text,
  unique (device_id, social_account_id)
);

create table account.mobile_device (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  workspace_id uuid,
  device_id uuid not null,
  platform text not null check (platform in ('android','ios')),
  manufacturer text, model text not null,
  os_version text not null,
  hardware_id_hash bytea not null,
  connection_type text not null check (connection_type in ('usb','wifi')),
  display_name text,
  status text not null check (status in ('detected','pending_setup','ready','offline','needs_attention','disabled','removed')),
  status_reason text,
  driver_version text,
  helper_app_version text,
  app_versions jsonb not null default '{}',
  prereq_checks jsonb not null default '{}',
  signing_team_ref text,
  signing_expires_at timestamptz,
  approved_by uuid, approved_at timestamptz,
  last_seen_at timestamptz,
  removed_at timestamptz, removed_reason text,
  unique (tenant_id, id)
);

create table account.mobile_app_binding (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  mobile_device_id uuid not null,
  app text not null check (app in ('tiktok','douyin','xiaohongshu','instagram','facebook')),
  social_account_id uuid not null,
  confirmed_by uuid not null, confirmed_at timestamptz not null,
  status text not null check (status in ('login_required','verified','identity_mismatch','blocked','removed')),
  observed_platform_user_id text, observed_handle text,
  verified_at timestamptz, last_checked_at timestamptz,
  blocked_reason text,
  removed_at timestamptz, removed_by uuid
);

create table account.account_execution_binding (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  social_account_id uuid not null unique,
  mode text not null check (mode in ('api','connector','manual','hybrid')),
  device_id uuid,
  connector_channel text not null default 'browser' check (connector_channel in ('browser','mobile')),
  mobile_device_id uuid,
  mobile_app text,
  connector_mode text not null default 'assist' check (connector_mode in ('assist','auto')),
  allow_manual_fallback boolean not null default true,
  paused boolean not null default false,
  note text,
  auto_enabled_by uuid, auto_enabled_at timestamptz,
  auto_ack_by uuid, auto_ack_at timestamptz,
  auto_ack_terms_version text,
  auto_max_per_hour integer,
  auto_min_interval_seconds integer,
  auto_daily_cap integer,
  auto_allowed_windows jsonb,
  auto_halted boolean not null default false,
  auto_halted_at timestamptz, auto_halted_by uuid, auto_halted_reason text,
  auto_consecutive_failures integer not null default 0,
  auto_stopped_at timestamptz,
  auto_stop_reason text check (auto_stop_reason in ('failure_streak','captcha','risk_control','identity_mismatch','terms_outdated')),
  auto_stop_block_id uuid,
  check (connector_channel <> 'mobile' or (device_id is not null and mobile_device_id is not null and mobile_app is not null)),
  check (connector_mode <> 'auto' or (auto_ack_at is not null and auto_ack_terms_version is not null
         and auto_max_per_hour is not null and auto_min_interval_seconds is not null
         and auto_daily_cap is not null and auto_allowed_windows is not null))
);

create table account.connector_auto_policy (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  halted boolean not null default false,
  halted_by_workspace boolean not null default false,
  ops_halt_rule_ids uuid[] not null default '{}',
  halted_at timestamptz, halted_by uuid, halted_reason text,
  default_max_per_hour integer not null,
  default_min_interval_seconds integer not null,
  default_daily_cap integer not null,
  failure_stop_threshold integer not null default 3,
  check (halted = (halted_by_workspace or cardinality(ops_halt_rule_ids) > 0)),
  unique (workspace_id)
);

create table account.account_block (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  social_account_id uuid,
  connection_id uuid,
  device_id uuid,
  mobile_device_id uuid,
  kind text not null check (kind in ('token_expired','scope_missing','login_required','captcha','identity_mismatch','device_offline','platform_restriction','connector_outdated','auto_failure_streak','mobile_offline','mobile_setup_required','signing_expired','app_prompt')),
  severity text not null check (severity in ('blocking','degraded')),
  status text not null check (status in ('open','assigned','resolving','resolved','dismissed')),
  detail jsonb not null default '{}',
  affected_task_count integer not null default 0,
  first_seen_at timestamptz not null, last_seen_at timestamptz not null,
  assignee_user_id uuid,
  resolved_at timestamptz, resolved_by uuid,
  resolution text check (resolution in ('reauthorized','relogged_in','device_reassigned','mobile_restored','dismissed')),
  work_item_id uuid,
  unique (tenant_id, workspace_id, id)
);

create table ingest.data_source (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  name text not null,
  kind text not null check (kind in ('platform_account','store','ad_account','esp','vendor','file_import')),
  provider text not null,
  connection_id uuid,
  social_account_id uuid,
  brand_id uuid,
  resources text[] not null,
  field_coverage jsonb not null,
  history_limit jsonb,
  allowed_uses jsonb not null,
  contract_ref text,
  status text not null check (status in ('active','paused','needs_authorization','degraded','disabled')),
  status_reason text,
  last_success_at timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table ingest.sync_schedule (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  data_source_id uuid not null,
  resource text not null,
  mode text not null check (mode in ('interval','cron','on_event','manual_only')),
  interval_seconds integer, cron text, tz text,
  overlap_seconds integer not null default 3600,
  settle_seconds integer not null default 300,
  priority smallint not null default 5,
  adaptive jsonb,
  next_due_at timestamptz,
  paused_until timestamptz,
  unique (data_source_id, resource)
);

create table ingest.sync_cursor (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, version integer not null default 1 check (version > 0),
  data_source_id uuid not null,
  resource text not null,
  cursor jsonb,
  high_watermark timestamptz,
  last_run_id uuid,
  unique (data_source_id, resource)
);

create table ingest.sync_run (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  data_source_id uuid not null,
  resource text not null,
  run_type text not null check (run_type in ('incremental','backfill','reconcile','manual_refresh','webhook_triggered')),
  status text not null check (status in ('queued','running','rate_limited','succeeded','partially_succeeded','failed','cancelled')),
  window_start timestamptz, window_end timestamptz,
  target_external_ids text[],
  cursor_in jsonb, cursor_out jsonb,
  counts jsonb not null default '{}',
  request_count integer not null default 0,
  cost_units numeric not null default 0,
  error_class text,
  error_reason text,
  error_detail jsonb,
  executor_ref jsonb,
  operation_id uuid,
  parent_run_id uuid,
  trigger_ref jsonb not null,
  attempt integer not null default 1,
  lease_owner_id text, lease_expires_at timestamptz, fencing_token bigint not null default 0,
  started_at timestamptz, finished_at timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table ingest.coverage_segment (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  data_source_id uuid not null,
  resource text not null,
  period tstzrange not null,
  status text not null check (status in ('complete','partial','unavailable_out_of_retention','unavailable_no_permission','failed')),
  reason text,
  sync_run_id uuid,
  exclude using gist (data_source_id with =, resource with =, period with &&)
);

create table ingest.raw_record (
  id uuid not null, tenant_id uuid not null, workspace_id uuid not null,
  data_source_id uuid not null,
  sync_run_id uuid, webhook_delivery_id uuid, import_batch_id uuid,
  resource text not null,
  external_id text,
  fetched_at timestamptz not null,
  payload jsonb,
  payload_file_object_id uuid,
  payload_hash text not null,
  masked_fields text[] not null default '{}',
  transform_version text not null,
  retention_until timestamptz not null,
  primary key (id, fetched_at)
) partition by range (fetched_at);

create table ingest.webhook_delivery (
  id uuid not null,
  tenant_id uuid, workspace_id uuid,
  provider text not null,
  endpoint_key text not null,
  received_at timestamptz not null,
  signature_status text not null check (signature_status in ('valid','invalid','not_applicable')),
  dedupe_key text not null,
  event_type text,
  event_occurred_at timestamptz,
  payload jsonb, payload_file_object_id uuid,
  status text not null check (status in ('received','rejected','duplicate','routed','processed','failed')),
  routed_data_source_id uuid,
  triggered_sync_run_id uuid,
  error jsonb,
  retention_until timestamptz not null,
  primary key (id, received_at),
  check (workspace_id is null or tenant_id is not null)
) partition by range (received_at);

create table ingest.webhook_dedupe (
  provider text not null, dedupe_key text not null,
  first_delivery_id uuid not null, received_at timestamptz not null,
  primary key (provider, dedupe_key)
);

create table ingest.import_batch (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  template_key text not null check (template_key in ('social_post_report','social_account_report','product_list','inventory_list','competitor_observation')),
  data_source_id uuid,
  file_object_id uuid not null,
  mapping jsonb not null,
  options jsonb not null,
  status text not null,
  stats jsonb not null default '{}',
  confirmed_by uuid, confirmed_at timestamptz, merged_at timestamptz,
  error_file_object_id uuid,
  supersedes_batch_id uuid,
  operation_id uuid,
  expires_at timestamptz not null,
  unique (tenant_id, id),
  unique (tenant_id, workspace_id, id)
);

create table ingest.import_row (
  batch_id uuid not null,
  row_no integer not null,
  tenant_id uuid not null,
  raw jsonb not null,
  normalized jsonb,
  dedupe_key text,
  status text not null check (status in ('valid','invalid','dup_in_file','new','changed','unchanged','merged','merge_failed','skipped')),
  issues jsonb,
  target_ref jsonb,
  primary key (batch_id, row_no)
);

create table ingest.field_mapping (
  id uuid primary key,
  tenant_id uuid,
  provider text not null, resource text not null, api_version text not null,
  source_path text not null,
  target_kind text not null check (target_kind in ('metric','entity_field')),
  metric_key text,
  metric_definition_revision integer,
  entity_field text,
  transform jsonb,
  revision integer not null,
  effective_from timestamptz not null, effective_to timestamptz
);

create table ingest.data_gap (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  data_source_id uuid not null,
  resource text not null,
  period tstzrange not null,
  gap_type text not null check (gap_type in ('missing_window','sync_failed','no_permission','out_of_retention','source_outage','webhook_missed','ip_not_allowed')),
  severity text not null check (severity in ('info','warning','critical')),
  status text not null check (status in ('open','backfill_scheduled','resolved','unrecoverable','accepted')),
  detected_by text not null check (detected_by in ('coverage_scan','quality_check','webhook_reconcile','manual')),
  backfill_run_id uuid,
  work_item_id uuid,
  resolved_at timestamptz, resolution_note text
);

create table ingest.quality_rule (
  id uuid primary key, tenant_id uuid,
  key text not null,
  check_type text not null check (check_type in ('freshness','completeness','duplicate','anomaly_jump','negative_cumulative_delta','schema_drift','rate_limit_pressure')),
  scope jsonb not null,
  params jsonb not null,
  severity text not null,
  active boolean not null default true
);

create table ingest.quality_issue (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  rule_key text not null,
  data_source_id uuid, resource text,
  subject_ref jsonb,
  observed jsonb not null,
  fingerprint text not null,
  status text not null check (status in ('open','acknowledged','investigating','resolved','false_positive')),
  first_seen_at timestamptz not null, last_seen_at timestamptz not null,
  occurrences integer not null default 1,
  work_item_id uuid,
  resolved_by uuid, resolved_at timestamptz, resolution_note text
);

create table commerce.store (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  provider text not null check (provider in ('tiktok_shop','shopify','shopee','lazada','amazon_sp','file_import','other')),
  connection_id uuid,
  data_source_id uuid,
  external_store_id text,
  name text not null,
  default_currency char(3) not null,
  default_locale text not null,
  region text,
  sync_scope jsonb not null default '{}',
  status text not null check (status in ('import_only','connecting','active','degraded','needs_reauth','disabled')),
  status_reason text,
  last_snapshot_at timestamptz,
  last_incremental_at timestamptz,
  unique (tenant_id, provider, external_store_id),
  unique (tenant_id, workspace_id, id)
);

create table commerce.store_market (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  store_id uuid not null,
  market_id uuid not null,
  channel text not null check (channel in ('online_store','tiktok_shop','marketplace','other')),
  price_source text not null check (price_source in ('store_market_price','store_base_price','manual')),
  purchase_url_template text,
  low_stock_threshold integer,
  inventory_locations text[],
  snapshot_ttl_minutes integer not null default 1440,
  enabled boolean not null default true,
  unique (store_id, market_id, channel)
);

create table commerce.product (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  store_id uuid not null,
  brand_id uuid not null,
  external_product_id text,
  handle text,
  title text not null,
  product_type text, vendor text,
  status text not null check (status in ('active','draft','archived','removed_at_source')),
  primary_asset_id uuid,
  source jsonb not null,
  source_updated_at timestamptz,
  unique (store_id, external_product_id),
  unique (tenant_id, workspace_id, id),
  unique (tenant_id, workspace_id, store_id, id)
);

create table commerce.product_variant (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, version integer not null default 1 check (version > 0),
  product_id uuid not null,
  store_id uuid not null,
  external_variant_id text,
  sku text,
  barcode text,
  options jsonb not null default '{}',
  status text not null check (status in ('active','archived','removed_at_source')),
  source jsonb not null,
  unique (store_id, external_variant_id),
  unique (tenant_id, workspace_id, id)
);

create table commerce.variant_group (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  name text not null,
  note text,
  unique (tenant_id, workspace_id, id)
);

create table commerce.variant_group_member (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  group_id uuid not null,
  variant_id uuid not null,
  linked_via text not null check (linked_via in ('manual','suggestion_accepted','import')),
  evidence text,
  unlinked_at timestamptz, unlinked_by uuid, unlink_reason text
);

create table commerce.listing_snapshot (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  variant_id uuid not null,
  market_id uuid not null,
  channel text not null,
  observed_at timestamptz not null,
  source_updated_at timestamptz,
  price_amount_minor bigint,
  compare_at_amount_minor bigint,
  currency char(3),
  price_source text not null check (price_source in ('store_market_price','store_base_price','manual','fx_estimate')),
  is_estimate boolean not null default false,
  fx_rate_id uuid,
  available_for_sale boolean,
  inventory_quantity integer,
  inventory_status text not null check (inventory_status in ('in_stock','low','out_of_stock','unknown','not_tracked')),
  purchase_url text,
  availability text not null,
  source jsonb not null,
  is_current boolean not null default true,
  unique (tenant_id, workspace_id, id)
);

create table commerce.product_fact (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  product_id uuid not null,
  variant_id uuid,
  brand_id uuid not null,
  fact_key text not null,
  category text not null check (category in ('spec','claim','selling_point','usage_scenario','marketing_copy','speculation')),
  applicable_market_ids uuid[],
  current_revision_id uuid,
  approved_revision_id uuid,
  status text not null check (status in ('active','retracted')),
  unique nulls not distinct (product_id, variant_id, fact_key),
  unique (tenant_id, workspace_id, id)
);

create table commerce.product_fact_revision (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  fact_id uuid not null,
  revision_no integer not null,
  value jsonb not null,
  category text not null,
  evidence_urls text[] not null default '{}',
  evidence_ids uuid[] not null default '{}',
  source jsonb not null,
  review_status text not null check (review_status in ('draft','approved','rejected','superseded')),
  reviewed_by uuid, reviewed_at timestamptz,
  content_hash text not null,
  created_by_type text not null, created_by_id uuid,
  created_at timestamptz not null default now(),
  unique (fact_id, revision_no),
  unique (tenant_id, workspace_id, fact_id, id)
);

create table commerce.product_localization (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  product_id uuid not null,
  field_key text not null,
  locale text not null,
  market_id uuid,
  source_locale text not null,
  source_ref jsonb not null,
  status text not null check (status in ('draft','machine_translated','in_review','approved','stale')),
  current_revision_id uuid,
  approved_revision_id uuid,
  pending_revision_id uuid,
  writeback_status text not null default 'none' check (writeback_status in ('none','pending','written','verified','failed')),
  unique nulls not distinct (product_id, field_key, locale, market_id),
  unique (tenant_id, workspace_id, id)
);

create table commerce.product_localization_revision (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  localization_id uuid not null,
  revision_no integer not null,
  text text not null,
  origin text not null check (origin in ('human','machine','agent','store_sync')),
  source_hash text not null,
  glossary_version text,
  content_hash text not null,
  created_by_type text not null, created_by_id uuid,
  created_at timestamptz not null default now(),
  unique (localization_id, revision_no),
  unique (tenant_id, workspace_id, localization_id, id)
);

create table commerce.change_event (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  change_type text not null check (change_type in ('price_changed','became_unavailable','became_available','stock_low','out_of_stock','fact_retracted','fact_revised','localization_stale','product_removed')),
  product_id uuid not null,
  variant_id uuid,
  market_id uuid,
  channel text,
  before jsonb, after jsonb,
  snapshot_id uuid,
  detected_at timestamptz not null,
  severity text not null check (severity in ('blocking','review','info')),
  status text not null check (status in ('open','acknowledged','resolved','dismissed')),
  resolved_by uuid, resolved_at timestamptz, resolution_note text
);

create table campaign.campaign (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  name text not null,
  kind text not null check (kind in ('launch','seasonal','promotion','always_on','brand','other')),
  status text not null check (status in ('draft','planned','active','paused','wrapping','closed','cancelled')),
  starts_at timestamptz, ends_at timestamptz,
  timezone text not null,
  owner_user_id uuid not null,
  audience_note text,
  utm_key text not null,
  objective_summary text,
  template_id uuid,
  closed_at timestamptz,
  unique (workspace_id, utm_key),
  unique (tenant_id, workspace_id, id)
);

create table campaign.campaign_market (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  campaign_id uuid not null,
  market_id uuid not null,
  locales text[] not null,
  starts_at timestamptz, ends_at timestamptz,
  owner_user_id uuid,
  status text not null check (status in ('planned','active','skipped','done')),
  unique (campaign_id, market_id),
  unique (tenant_id, workspace_id, id)
);

create table campaign.campaign_goal (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  campaign_id uuid not null,
  campaign_market_id uuid,
  metric_key text not null,
  unit text not null check (unit in ('count','currency','percent','seconds')),
  currency char(3),
  baseline_value numeric,
  baseline_source text,
  target_value numeric not null,
  due_at timestamptz not null,
  attribution_note text,
  status text not null check (status in ('active','achieved','missed','withdrawn'))
);

create table campaign.campaign_product (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  campaign_id uuid not null,
  product_id uuid not null,
  variant_ids uuid[],
  market_ids uuid[],
  role text not null check (role in ('hero','supporting','bundle','gift')),
  unique (campaign_id, product_id)
);

create table campaign.campaign_plan_slot (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  campaign_id uuid not null,
  stage text not null check (stage in ('teaser','launch','sustain','conversion','recap','custom')),
  platform text not null,
  social_account_id uuid,
  market_id uuid,
  locale text,
  content_format text,
  planned_count integer not null default 1,
  window_start timestamptz, window_end timestamptz,
  owner_user_id uuid,
  note text
);

create table campaign.brief (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  campaign_id uuid not null,
  kind text not null check (kind in ('main','market','creator','production')),
  campaign_market_id uuid,
  title text not null,
  current_revision_id uuid,
  approved_revision_id uuid,
  unique (tenant_id, workspace_id, id)
);

create table campaign.brief_revision (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  brief_id uuid not null,
  revision_no integer not null,
  body_doc jsonb not null,
  requirements jsonb not null default '[]',
  fact_refs jsonb not null default '[]',
  status text not null check (status in ('draft','in_review','approved','changes_requested','superseded')),
  ai_generated boolean not null default false,
  content_hash text not null,
  created_by_type text not null, created_by_id uuid,
  created_at timestamptz not null default now(),
  unique (brief_id, revision_no),
  unique (tenant_id, workspace_id, brief_id, id)
);

create table intel.watch_target (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid,
  target_type text not null check (target_type in ('competitor_account','keyword','hashtag','category','product_url','store','creator_account')),
  platform text,
  market_ids uuid[] not null default '{}',
  name text not null,
  query jsonb not null,
  external_ref jsonb,
  data_mode text not null check (data_mode in ('manual','import','vendor','official_api')),
  data_source_id uuid,
  refresh_frequency text not null default 'manual' check (refresh_frequency in ('manual','daily','weekly')),
  owner_user_id uuid,
  tags text[] not null default '{}',
  coverage_note text,
  status text not null check (status in ('active','paused','archived')),
  unique (tenant_id, workspace_id, id)
);

create table intel.observation (
  id uuid not null, tenant_id uuid not null, workspace_id uuid not null,
  watch_target_id uuid not null,
  subject_type text not null check (subject_type in ('post','account','product','video','live')),
  external_id text, url text,
  published_at timestamptz,
  observed_at timestamptz not null,
  age_at_observation interval,
  metrics jsonb not null,
  attributes jsonb,
  source jsonb not null,
  note text,
  created_by_type text not null, created_by_id uuid,
  primary key (id, observed_at)
) partition by range (observed_at);

create table intel.research_board (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid, campaign_id uuid,
  kind text not null check (kind in ('research','creative','product_opportunity')),
  title text not null, description text,
  status text not null check (status in ('active','archived')),
  unique (tenant_id, workspace_id, id)
);

create table intel.research_item (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  board_id uuid not null,
  item_type text not null check (item_type in ('link','observation','note','creative_reference','mention','candidate')),
  ref_id uuid,
  url text, title text, body text,
  stance text check (stance in ('evidence','counter_example','question','demand','hypothesis')),
  labels text[] not null default '{}',
  lane text, position numeric,
  ai_generated boolean not null default false,
  converted_to jsonb
);

create table intel.creative_reference (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  url text not null, platform text, external_id text,
  watch_target_id uuid,
  thumbnail_file_object_id uuid,
  structure jsonb not null default '{}',
  structure_source text not null check (structure_source in ('human','agent','mixed')),
  agent_job_id uuid, model_ref text,
  observed_metrics jsonb,
  tags text[] not null default '{}'
);

create table content.content_pillar (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  name text not null, description text,
  audience_note text,
  target_share numeric(5,2),
  evergreen boolean not null default false,
  archived_at timestamptz,
  unique (brand_id, name),
  unique (tenant_id, workspace_id, id)
);

create table content.idea (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  pillar_id uuid,
  campaign_id uuid,
  title text not null,
  hypothesis text,
  objective text,
  audience_note text,
  origin text not null check (origin in ('observation','customer_question','competitor_ref','product_point','monitoring','rss','agent','other')),
  origin_refs jsonb not null default '[]',
  observed_at timestamptz,
  status text not null check (status in ('open','discussing','accepted','parked','rejected')),
  priority integer,
  tags text[] not null default '{}',
  unique (tenant_id, workspace_id, id)
);

create table content.content_item (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  campaign_id uuid,
  pillar_id uuid,
  idea_id uuid,
  title text not null,
  production_stage text not null check (production_stage in ('accepted','drafting','design','awaiting_assets','internal_review','ready','archived')),
  owner_user_id uuid,
  production_due_at timestamptz,
  derived_from_item_id uuid,
  blocked_reason text,
  archived_at timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table content.content_stage_history (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  content_item_id uuid not null,
  from_stage text, to_stage text not null,
  changed_by_type text not null, changed_by_id uuid,
  note text, changed_at timestamptz not null
);

create table content.content_variant (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  content_item_id uuid not null,
  platform text not null check (platform in ('instagram','facebook','tiktok','youtube','douyin','xiaohongshu','generic')),
  format text not null check (format in ('feed_image','carousel','reel','story','short_video','long_video','text','note','live_teaser')),
  locale text not null,
  market_id uuid,
  social_account_id uuid,
  parent_variant_id uuid,
  draft_doc jsonb not null,
  current_revision_id uuid,
  readiness text not null check (readiness in ('draft','ready','stale')),
  stale_reasons jsonb not null default '[]',
  derived_from_revision_id uuid,
  owner_user_id uuid,
  archived_at timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table content.content_revision (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  variant_id uuid not null,
  revision_no integer not null,
  body_doc jsonb not null,
  rendered jsonb not null,
  media jsonb not null default '[]',
  product_refs jsonb not null default '[]',
  link_refs jsonb not null default '[]',
  settings jsonb not null default '{}',
  origin text not null check (origin in ('human','agent','template','import','translation')),
  ai_generated boolean not null default false,
  agent_job_id uuid,
  based_on_revision_id uuid,
  restored_from_revision_id uuid,
  content_hash text not null,
  created_by_type text not null, created_by_id uuid,
  created_at timestamptz not null default now(),
  unique (variant_id, revision_no),
  unique (tenant_id, workspace_id, id),
  unique (tenant_id, workspace_id, variant_id, id)
);

create table content.content_reference (
  tenant_id uuid not null, workspace_id uuid not null,
  revision_id uuid not null,
  ref_type text not null check (ref_type in ('asset','asset_version','asset_rendition','product_variant','product_fact_revision','listing_snapshot','short_link','knowledge_entry','template')),
  ref_id uuid not null,
  ref_version text,
  primary key (revision_id, ref_type, ref_id)
);

create table content.translation_link (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  target_variant_id uuid not null,
  source_variant_id uuid not null,
  source_revision_id uuid not null,
  target_revision_id uuid,
  glossary_version text,
  status text not null check (status in ('in_sync','source_changed','needs_review','accepted_divergence')),
  divergence_note text,
  unique (target_variant_id)
);

create table asset.asset_folder (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid,
  parent_id uuid,
  name text not null,
  path text not null,
  unique (tenant_id, workspace_id, id)
);

create table asset.asset (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  folder_id uuid,
  kind text not null check (kind in ('image','video','audio','subtitle','document','design_link')),
  title text not null,
  description text,
  tags text[] not null default '{}',
  locale text,
  origin text not null check (origin in ('upload','ugc','creator_delivery','design_tool','import','ai_generated','stock')),
  origin_ref jsonb,
  current_version_id uuid,
  status text not null check (status in ('processing','ready','failed','archived')),
  favorite_count integer not null default 0,
  archived_at timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table asset.asset_version (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  asset_id uuid not null,
  version_no integer not null,
  file_object_id uuid not null,
  sha256 text not null,
  mime_type text not null,
  meta jsonb not null default '{}',
  thumbnail_file_id uuid,
  perceptual_hash text,
  change_note text,
  external_version text,
  created_by_type text not null, created_by_id uuid,
  created_at timestamptz not null default now(),
  unique (asset_id, version_no),
  unique (tenant_id, workspace_id, asset_id, id),
  unique (tenant_id, workspace_id, id)
);

create table asset.asset_rendition (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  asset_version_id uuid not null,
  kind text not null check (kind in ('platform_resize','crop','subtitle_burned','cover','thumbnail','transcode','preview','waveform')),
  params jsonb not null,
  params_hash text not null,
  target_platform text,
  file_object_id uuid,
  meta jsonb,
  status text not null check (status in ('queued','processing','ready','failed')),
  error text,
  attempts integer not null default 0,
  unique (asset_version_id, params_hash)
);

create table asset.asset_link (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  asset_id uuid not null,
  link_type text not null check (link_type in ('product','product_variant','campaign')),
  link_id uuid not null,
  unique (asset_id, link_type, link_id)
);

create table asset.rights_grant (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  grant_type text not null check (grant_type in ('owned','license','ugc_permission','creator_contract','stock','employee')),
  grantor_kind text not null check (grantor_kind in ('brand','creator','external_party','stock_provider','employee')),
  grantor_ref jsonb,
  current_revision_id uuid,
  status text not null check (status in ('draft','active','expiring','expired','revoked','superseded')),
  valid_from timestamptz,
  valid_until timestamptz,
  expiring_notice_days integer not null default 14,
  revoked_at timestamptz,
  revocation_effect text check (revocation_effect in ('stop_new_use','takedown_required')),
  superseded_by uuid,
  unique (tenant_id, workspace_id, id)
);

create table asset.rights_grant_revision (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  rights_grant_id uuid not null,
  revision_no integer not null,
  usages text[] not null,
  platforms text[],
  regions text[],
  valid_from timestamptz not null,
  valid_until timestamptz,
  allow_modification boolean not null,
  attribution_required boolean not null default false,
  attribution_text text,
  exclusivity text check (exclusivity in ('none','category','full')),
  restrictions text,
  evidence_ids uuid[] not null default '{}',
  confirmed_by uuid, confirmed_at timestamptz,
  content_hash text not null,
  created_by_type text not null, created_by_id uuid,
  created_at timestamptz not null default now(),
  unique (rights_grant_id, revision_no),
  unique (tenant_id, workspace_id, rights_grant_id, id)
);

create table asset.rights_grant_asset (
  tenant_id uuid not null, workspace_id uuid not null,
  rights_grant_id uuid not null,
  asset_id uuid not null,
  version_scope text not null default 'all_versions' check (version_scope in ('all_versions','specific_version')),
  asset_version_id uuid,
  primary key (rights_grant_id, asset_id)
);

create table asset.knowledge_entry (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  kind text not null check (kind in ('positioning','tone','forbidden_phrase','glossary_term','faq','example','policy','product_pointer')),
  title text not null,
  market_ids uuid[],
  locales text[],
  status text not null check (status in ('proposed','active','rejected','retired')),
  current_revision_id uuid,
  active_revision_id uuid,
  priority integer not null default 0,
  unique (tenant_id, workspace_id, id)
);

create table asset.knowledge_revision (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  entry_id uuid not null,
  revision_no integer not null,
  body text not null,
  structured jsonb,
  source jsonb not null,
  review_status text not null check (review_status in ('draft','approved','rejected','superseded')),
  reviewed_by uuid, reviewed_at timestamptz,
  content_hash text not null,
  created_by_type text not null, created_by_id uuid,
  created_at timestamptz not null default now(),
  unique (entry_id, revision_no),
  unique (tenant_id, workspace_id, entry_id, id)
);

create table asset.template (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  brand_id uuid,
  kind text not null check (kind in ('text_snippet','hashtag_set','cta','caption_template','visual_template')),
  name text not null,
  body jsonb not null,
  variables jsonb not null default '[]',
  platforms text[], market_ids uuid[], locales text[],
  status text not null check (status in ('active','archived')),
  unique (tenant_id, workspace_id, id)
);

create table planning.publish_plan (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  campaign_id uuid,
  title text,
  source text not null check (source in ('manual','batch','agent','recurring','evergreen')),
  commit_mode text not null default 'partial' check (commit_mode in ('all_or_nothing','partial')),
  status text not null check (status in ('draft','previewed','committing','committed','partially_committed','failed')),
  preview jsonb,
  committed_at timestamptz,
  operation_id uuid,
  agent_job_id uuid,
  unique (tenant_id, workspace_id, id)
);

create table planning.publish_target (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  plan_id uuid,
  campaign_id uuid,
  brand_id uuid not null,
  social_account_id uuid not null,
  content_item_id uuid not null,
  content_variant_id uuid not null,
  variant_revision_id uuid not null,
  operation text not null default 'publish',
  content_format text not null check (content_format in ('image','carousel','reel','video','short','story','text')),
  visibility text not null default 'public' check (visibility in ('public','private','unlisted','followers','scheduled_private')),
  options jsonb not null default '{}',
  schedule_kind text not null check (schedule_kind in ('exact','asap','manual_date')),
  scheduled_at timestamptz,
  schedule_tz text,
  local_scheduled_at timestamp,
  dst_resolution text check (dst_resolution in ('none','shifted_forward','earlier_occurrence','later_occurrence')),
  late_policy text,
  grace_minutes integer,
  connector_mode_pref text not null default 'inherit' check (connector_mode_pref in ('inherit','assist')),
  plan_status text not null check (plan_status in ('draft','awaiting_approval','changes_requested','ready','paused','cancel_requested','cancelled','superseded','closed')),
  close_reason text check (close_reason in ('published','failed_final','manual_done','expired_skipped','matched_native')),
  approval_request_id uuid,
  frozen_hash text,
  last_precheck_run_id uuid,
  precheck_summary text check (precheck_summary in ('pass','risk','blocked','stale','not_run')),
  origin text not null default 'manual' check (origin in ('manual','batch','agent','recurring','evergreen','native_reconciled')),
  schedule_rule_id uuid,
  evergreen_queue_item_id uuid,
  execution_task_id uuid,
  paused_by_switch_id uuid,
  owner_user_id uuid,
  unique (tenant_id, workspace_id, id)
);

create table planning.publish_target_ref (
  tenant_id uuid not null, workspace_id uuid not null,
  publish_target_id uuid not null,
  ref_type text not null check (ref_type in ('product_variant','listing_snapshot','promotion','short_link','asset_rendition','rights_grant')),
  ref_id uuid not null,
  bound_at_revision uuid,
  primary key (publish_target_id, ref_type, ref_id)
);

create table planning.precheck_run (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  publish_target_id uuid not null,
  stage text not null check (stage in ('schedule','approval','preflight','execution')),
  target_version integer not null,
  overall text not null check (overall in ('pass','risk','blocked')),
  checked_at timestamptz not null,
  valid_until timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table planning.precheck_item (
  tenant_id uuid not null, workspace_id uuid not null,
  run_id uuid not null,
  check_key text not null check (check_key in ('capability','media_spec','caption_rules','rights','product_fact','listing_availability','promotion_validity','account_connection','session_identity','device_online','mobile_device_online','mobile_app_binding','mobile_signing','connector_mode','automation_limits','time_conflict','approval_valid','link_health','pause_switch','quota')),
  severity text not null check (severity in ('blocker','risk','info')),
  result text not null check (result in ('pass','fail','warn','unknown')),
  message text not null,
  detail jsonb not null default '{}',
  fix_action jsonb,
  evidence jsonb,
  primary key (run_id, check_key)
);

create table planning.pause_switch (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  scope_type text not null check (scope_type in ('workspace','brand','campaign','social_account')),
  scope_id uuid not null,
  reason text not null,
  mode text not null default 'hold',
  activated_at timestamptz not null,
  released_at timestamptz, released_by uuid,
  release_decisions jsonb
);

create table execution.execution_task (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, version integer not null default 1 check (version > 0),
  publish_target_id uuid not null,
  social_account_id uuid not null,
  operation text not null,
  content_format text not null,
  frozen jsonb not null,
  frozen_hash text not null,
  frozen_version integer not null default 1,
  due_at timestamptz,
  prepare_lead_seconds integer not null default 300,
  route jsonb not null,
  status text not null check (status in ('scheduled','queued','blocked','running','accepted','outcome_unknown','published','failed','retryable','cancel_pending','cancelled','manual','expired')),
  sub_status text,
  status_reason text,
  active_attempt_id uuid,
  attempt_count integer not null default 0,
  auto_retry_count integer not null default 0,
  late_policy text not null check (late_policy in ('skip','notify','grace_window')),
  grace_minutes integer not null default 0,
  cancel_requested_at timestamptz, cancel_requested_by uuid,
  platform_post_id uuid,
  first_started_at timestamptz, finished_at timestamptz,
  lease_owner_type text, lease_owner_id text, lease_expires_at timestamptz,
  fencing_token bigint not null default 0,
  unique (tenant_id, workspace_id, id),
  unique (tenant_id, workspace_id, publish_target_id, id)
);

create table execution.execution_attempt (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  task_id uuid not null,
  attempt_no integer not null,
  purpose text not null default 'submit' check (purpose in ('submit','complete_draft')),
  parent_attempt_id uuid,
  executor text not null check (executor in ('api','connector','manual')),
  device_id uuid,
  connector_channel text check (connector_channel in ('browser','mobile')),
  mobile_device_id uuid,
  mobile_app text,
  connector_mode text check (connector_mode in ('assist','auto')),
  submitted_by text,
  adapter text, adapter_version text, api_version text,
  fencing_token bigint not null,
  client_request_id text not null,
  request_hash text not null,
  status text not null check (status in ('created','claimed','in_progress','submitted','accepted','rejected','unknown','verified_published','verified_failed','verified_absent','abandoned')),
  external_refs jsonb not null default '{}',
  receipt jsonb,
  error_class text check (error_class in ('transient','rate_limited','auth_expired','permission_denied','invalid_input','platform_rejected','outcome_unknown','unsupported','quota_exhausted')),
  error_detail jsonb,
  submitted_at timestamptz,
  outcome_checked_at timestamptz, next_check_at timestamptz, check_count integer not null default 0,
  started_at timestamptz, finished_at timestamptz,
  triggered_by_type text not null, triggered_by_id uuid check (triggered_by_type in ('system','user','agent_client')),
  check (executor <> 'connector' or connector_channel is not null),
  check (connector_channel is distinct from 'mobile' or (mobile_device_id is not null and mobile_app is not null)),
  check (purpose <> 'complete_draft' or (parent_attempt_id is not null and executor = 'connector' and connector_channel = 'mobile')),
  unique (task_id, attempt_no),
  unique (tenant_id, workspace_id, id)
);

create table execution.execution_attempt_step (
  tenant_id uuid not null, workspace_id uuid not null,
  attempt_id uuid not null,
  seq integer not null,
  step text not null check (step in ('claim','precheck','prepare_media','push_media','open_app','identity_check','open_draft','fill','upload','submit_permit','submit','await_click','mode_downgrade','capture_result','poll','verify','cancel')),
  status text not null check (status in ('started','succeeded','failed','skipped')),
  detail jsonb, evidence_id uuid,
  at timestamptz not null default now(),
  primary key (attempt_id, seq)
);

create table execution.platform_post (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, version integer not null default 1 check (version > 0),
  social_account_id uuid not null,
  provider text not null,
  external_post_id text,
  permalink text,
  post_type text check (post_type in ('image','carousel','reel','video','short','story','text','note')),
  origin text not null check (origin in ('system','native','manual_registered')),
  verification text not null check (verification in ('system_verified','manual_confirmed','unverified')),
  submitted_by text,
  post_status text not null check (post_status in ('live','private','processing','removed_by_platform','deleted','hidden','unknown')),
  visibility text,
  published_at timestamptz,
  caption_snapshot text,
  media_summary jsonb,
  publish_target_id uuid,
  execution_task_id uuid,
  campaign_id uuid,
  first_seen_at timestamptz not null,
  last_observed_at timestamptz,
  source jsonb not null,
  evidence_ids uuid[] not null default '{}',
  unique (tenant_id, workspace_id, id)
);

create table execution.account_write_slot (
  social_account_id uuid primary key,
  tenant_id uuid not null,
  holder_kind text check (holder_kind in ('attempt','post_operation','reply')),
  holder_id uuid,
  fencing_token bigint not null default 0,
  lease_expires_at timestamptz
);

create table execution.auto_submit_permit (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  social_account_id uuid not null,
  attempt_id uuid not null,
  device_id uuid not null,
  write_slot_fencing_token bigint not null,
  decision text not null check (decision in ('granted','deferred','denied')),
  deny_reason text,
  halt_source text,
  retry_at timestamptz,
  local_day date not null,
  decided_at timestamptz not null default now()
);

create table execution.post_operation (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  platform_post_id uuid not null,
  kind text not null check (kind in ('edit_caption','delete','hide','unschedule')),
  executor text not null check (executor in ('api','connector','manual')),
  status text not null check (status in ('requested','awaiting_approval','queued','running','accepted','verified','failed','unknown','manual','cancelled')),
  before_snapshot jsonb not null,
  after_payload jsonb,
  approval_request_id uuid,
  reason text not null,
  receipt jsonb, error_class text,
  fencing_token bigint not null default 0,
  completed_at timestamptz,
  evidence_ids uuid[] not null default '{}'
);

create table execution.execution_handover (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  task_id uuid not null,
  from_attempt_id uuid,
  from_executor text not null, to_executor text not null check (to_executor in ('api','connector','manual')),
  to_device_id uuid, assignee_user_id uuid,
  to_connector_channel text, to_mobile_device_id uuid,
  reason text not null,
  completed_steps jsonb not null,
  pending_side_effects jsonb not null,
  status text not null check (status in ('proposed','fenced','in_progress','completed','aborted')),
  work_item_id uuid,
  completed_at timestamptz
);

create table execution.execution_setting (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  scope_type text not null check (scope_type in ('workspace','brand','social_account')),
  scope_id uuid not null,
  late_policy text not null default 'notify' check (late_policy in ('skip','notify','grace_window')),
  grace_minutes integer not null default 30,
  max_auto_retries integer not null default 3,
  verify_schedule_seconds integer[] not null default '{30,120,300,900,3600,21600}',
  unknown_to_manual_after_minutes integer not null default 360,
  assist_submit_timeout_minutes integer not null default 30,
  unique (scope_type, scope_id)
);

create table inbox.participant (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  provider text not null check (provider in ('meta_instagram','meta_facebook','tiktok','youtube','douyin','xiaohongshu')),
  scope_account_id uuid,
  external_user_id text not null,
  handle text, display_name text, avatar_file_object_id uuid, profile_url text,
  is_own_account boolean not null default false,
  customer_identity_id uuid,
  first_seen_at timestamptz not null, last_seen_at timestamptz not null,
  source jsonb not null,
  unique nulls not distinct (tenant_id, provider, scope_account_id, external_user_id),
  unique (tenant_id, workspace_id, id)
);

create table inbox.conversation (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, version integer not null default 1 check (version > 0),
  brand_id uuid not null,
  social_account_id uuid not null,
  kind text not null check (kind in ('comment_thread','private_thread','mention','ad_comment','review')),
  platform_post_id uuid,
  external_thread_id text not null,
  primary_participant_id uuid,
  status text not null default 'open' check (status in ('open','waiting_customer','snoozed','resolved')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assignee_user_id uuid,
  assignee_team_key text,
  snooze_until timestamptz,
  campaign_id uuid,
  language text,
  last_inbound_at timestamptz, last_outbound_at timestamptz,
  last_message_id uuid,
  inbound_since_last_reply integer not null default 0,
  reopened_count integer not null default 0,
  resolved_at timestamptz, resolved_by uuid,
  sync_state text not null default 'synced' check (sync_state in ('synced','partial','stale')),
  unique (social_account_id, kind, external_thread_id),
  unique (tenant_id, id),
  unique (tenant_id, workspace_id, id)
);

create table inbox.message (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  conversation_id uuid not null,
  social_account_id uuid not null,
  external_message_id text not null,
  parent_external_id text,
  direction text not null check (direction in ('inbound','outbound')),
  visibility text not null check (visibility in ('public','private')),
  author_participant_id uuid,
  body_text text,
  attachments jsonb not null default '[]',
  platform_created_at timestamptz not null,
  platform_state text not null default 'visible' check (platform_state in ('visible','hidden','deleted_by_author','deleted_by_us','unknown')),
  edit_history jsonb not null default '[]',
  outbound_reply_id uuid,
  sent_via text check (sent_via in ('system','native','unknown')),
  source jsonb not null,
  unique (social_account_id, external_message_id),
  unique (tenant_id, workspace_id, id)
);

create table inbox.conversation_read_state (
  tenant_id uuid not null, user_id uuid not null,
  conversation_id uuid not null,
  last_read_message_id uuid, read_at timestamptz not null,
  primary key (user_id, conversation_id)
);

create table inbox.tag (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  kind text not null check (kind in ('topic','issue_type','intent','sentiment','custom')),
  key text not null, label text not null, color text,
  archived_at timestamptz,
  unique (workspace_id, kind, key),
  unique (tenant_id, workspace_id, id)
);

create table inbox.conversation_tag (
  tenant_id uuid not null, workspace_id uuid not null,
  conversation_id uuid not null,
  tag_id uuid not null,
  applied_by_type text not null, applied_by_id uuid,
  ai_suggested boolean not null default false, confidence numeric(4,3),
  applied_at timestamptz not null default now(),
  primary key (conversation_id, tag_id)
);

create table inbox.conversation_activity (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  conversation_id uuid not null,
  type text not null check (type in ('assigned','unassigned','status_changed','tagged','untagged','priority_changed','occupied','released','reopened','escalated')),
  from_value jsonb, to_value jsonb,
  via text not null check (via in ('web','mcp','automation','system'))
);

create table inbox.conversation_occupancy (
  conversation_id uuid primary key,
  tenant_id uuid not null, workspace_id uuid not null,
  holder_type text not null check (holder_type in ('user','agent_client')),
  holder_id uuid not null,
  agent_job_id uuid,
  purpose text not null default 'reply' check (purpose in ('reply','review','moderate')),
  acquired_at timestamptz not null,
  lease_expires_at timestamptz not null,
  fencing_token bigint not null,
  based_on_message_id uuid
);

create table inbox.reply_draft (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  conversation_id uuid not null,
  in_reply_to_message_id uuid,
  reply_mode text not null check (reply_mode in ('public_reply','private_reply','dm')),
  body_text text not null,
  attachments jsonb not null default '[]',
  template_id uuid,
  based_on_message_id uuid not null,
  content_hash text not null,
  ai_generated boolean not null default false,
  agent_job_id uuid,
  fact_refs jsonb not null default '[]',
  status text not null default 'editing' check (status in ('editing','pending_approval','approved','submitted','discarded')),
  approval_request_id uuid,
  unique (tenant_id, workspace_id, id)
);

create table inbox.outbound_reply (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  conversation_id uuid not null,
  reply_draft_id uuid not null,
  draft_content_hash text not null,
  social_account_id uuid not null,
  reply_mode text not null,
  target_external_id text,
  status text not null default 'queued' check (status in ('queued','running','accepted','outcome_unknown','delivered','failed','retryable','manual','cancelled')),
  idempotency_key text not null,
  current_attempt_no integer not null default 0,
  result_message_id uuid,
  error_class text, error_detail text,
  submitted_via text not null check (submitted_via in ('web','mcp','automation')),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, workspace_id, id)
);

create table inbox.outbound_reply_attempt (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  outbound_reply_id uuid not null,
  attempt_no integer not null,
  executor text not null check (executor in ('api','connector','manual')),
  device_id uuid,
  connector_channel text check (connector_channel in ('browser','mobile')),
  mobile_device_id uuid,
  submitted_by text check (submitted_by in ('auto','human')),
  fencing_token bigint not null,
  client_request_id text not null,
  started_at timestamptz not null, finished_at timestamptz,
  outcome text check (outcome in ('accepted','failed','outcome_unknown','delivered','not_delivered')),
  error_class text,
  receipt jsonb, evidence_ids uuid[] not null default '{}',
  unique (outbound_reply_id, attempt_no),
  check (executor <> 'connector' or connector_channel is not null),
  check (connector_channel is distinct from 'mobile' or mobile_device_id is not null)
);

create table inbox.internal_note (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  conversation_id uuid not null,
  anchor_message_id uuid,
  body text not null,
  mentions uuid[] not null default '{}',
  data_refs jsonb not null default '[]',
  deleted_at timestamptz
);

create table traffic.link_domain (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid,
  created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  hostname text not null unique,
  kind text not null check (kind in ('shared_default','custom')),
  verification_status text not null check (verification_status in ('pending','verified','failed')),
  tls_status text not null check (tls_status in ('pending','active','failed')),
  verified_at timestamptz,
  unique (tenant_id, id)
);

create table traffic.utm_template (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  name text not null,
  params jsonb not null,
  rules jsonb not null,
  is_default boolean not null default false
);

create table traffic.short_link (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  domain_id uuid not null,
  code text not null,
  brand_id uuid not null,
  campaign_id uuid,
  content_item_id uuid,
  publish_target_id uuid,
  collaboration_id uuid,
  product_variant_id uuid,
  market_id uuid,
  current_revision_id uuid,
  status text not null default 'active' check (status in ('active','paused','expired','archived')),
  expires_at timestamptz,
  fallback_url text,
  locked_after_publish boolean not null default true,
  unique (domain_id, code),
  unique (tenant_id, workspace_id, id)
);

create table traffic.short_link_revision (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  short_link_id uuid not null,
  revision_no integer not null,
  destination_url text not null,
  utm_params jsonb not null,
  final_url text not null,
  market_routes jsonb,
  destination_ref jsonb,
  change_reason text,
  unique (short_link_id, revision_no),
  unique (tenant_id, workspace_id, short_link_id, id)
);

create table traffic.click_event (
  id uuid not null, tenant_id uuid not null, workspace_id uuid not null,
  short_link_id uuid not null, revision_id uuid not null,
  occurred_at timestamptz not null,
  classification text not null check (classification in ('human_likely','bot_preview','crawler','prefetch','unknown')),
  classification_rule text,
  referrer_host text,
  country char(2),
  ua_family text, device_class text check (device_class in ('mobile','desktop','tablet','bot','unknown')),
  daily_visitor_hash text,
  route_market_id uuid,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table traffic.click_rollup_hourly (
  tenant_id uuid not null, workspace_id uuid not null,
  short_link_id uuid not null, hour timestamptz not null,
  redirects integer not null,
  human_likely integer not null,
  bot_filtered integer not null,
  daily_unique_estimate integer not null,
  primary key (short_link_id, hour)
);

create table traffic.landing_destination (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  url text not null,
  kind text not null check (kind in ('store_product','store_collection','external_page','own_landing_page')),
  brand_id uuid not null, market_id uuid,
  product_id uuid, product_variant_id uuid,
  campaign_id uuid,
  expected_language text,
  status text not null default 'active' check (status in ('active','archived')),
  last_check_id uuid,
  last_check_status text check (last_check_status in ('pass','warn','fail','unknown')),
  unique (workspace_id, url)
);

create table traffic.page_check (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  target_type text not null check (target_type in ('short_link','landing_destination','landing_page_version')),
  target_id uuid not null,
  kind text not null check (kind in ('auto_link','manual_checklist','pre_publish')),
  "trigger" text not null check (trigger in ('schedule','pre_publish','manual','event')),
  publish_target_id uuid,
  status text not null check (status in ('pass','warn','fail','unknown')),
  items jsonb not null,
  checked_at timestamptz not null
);

create table analytics.metric_definition (
  id uuid primary key,
  tenant_id uuid,
  key text not null,
  scope text not null check (scope in ('platform_native','normalized','derived','traffic','commerce')),
  platform text,
  native_name text,
  display_name jsonb not null,
  subject_types text[] not null,
  unit text not null check (unit in ('count','seconds','ratio','percent','currency')),
  value_kind text not null check (value_kind in ('cumulative','period_sum','gauge','ratio')),
  additivity text not null check (additivity in ('additive','additive_within_platform','non_additive')),
  numerator_key text, denominator_key text,
  current_revision integer not null,
  status text not null check (status in ('active','deprecated')),
  unique nulls not distinct (tenant_id, key)
);

create table analytics.metric_definition_revision (
  definition_id uuid not null,
  revision integer not null,
  definition_text jsonb not null,
  formula jsonb,
  platform_window text,
  effective_from timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (definition_id, revision)
);

create table analytics.metric_observation (
  id uuid not null,
  tenant_id uuid not null, workspace_id uuid not null,
  metric_key text not null,
  definition_revision integer not null,
  subject_type text not null,
  subject_id uuid not null,
  brand_id uuid, platform text,
  dims jsonb not null default '{}',
  dims_hash text not null default '',
  period_kind text not null check (period_kind in ('lifetime','day','hour','range')),
  period_start timestamptz, period_end timestamptz,
  observed_at timestamptz not null,
  subject_age_seconds bigint,
  value numeric,
  availability text not null check (availability in ('observed','not_collected','no_permission','not_applicable','sync_failed','source_not_provided','estimated')),
  currency char(3),
  source jsonb not null,
  ingested_at timestamptz not null default now(),
  primary key (id, observed_at),
  unique (subject_type, subject_id, metric_key, period_kind, period_start, dims_hash, observed_at)
) partition by range (observed_at);

create table analytics.metric_latest (
  tenant_id uuid not null, workspace_id uuid not null,
  subject_type text not null, subject_id uuid not null,
  metric_key text not null, dims_hash text not null default '',
  value numeric, availability text not null,
  observed_at timestamptz not null, subject_age_seconds bigint,
  source jsonb not null,
  primary key (subject_type, subject_id, metric_key, dims_hash)
);

create table analytics.metric_at_age (
  tenant_id uuid not null, workspace_id uuid not null,
  subject_type text not null, subject_id uuid not null,
  metric_key text not null,
  age_bucket text not null,
  value numeric, availability text not null,
  method text not null check (method in ('exact','nearest_before','interpolated')),
  observed_at timestamptz,
  deviation_seconds bigint,
  primary key (subject_type, subject_id, metric_key, age_bucket)
);

create table analytics.metric_daily (
  tenant_id uuid not null, workspace_id uuid not null,
  subject_type text not null, subject_id uuid not null,
  metric_key text not null, dims_hash text not null default '',
  day date not null, tz text not null,
  value numeric, availability text not null,
  derivation text not null check (derivation in ('native_daily','cumulative_diff','interpolated','backfilled')),
  coverage numeric,
  computed_at timestamptz not null,
  primary key (subject_type, subject_id, metric_key, dims_hash, day)
);

create table analytics.report (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  title text not null,
  kind text not null check (kind in ('social_performance','campaign','client_monthly','custom')),
  template_id uuid,
  scope jsonb not null,
  period jsonb not null,
  sections jsonb not null,
  owner_user_id uuid,
  schedule jsonb,
  status text not null check (status in ('active','archived')),
  unique (tenant_id, workspace_id, id)
);

create table analytics.report_version (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  report_id uuid not null,
  version_no integer not null,
  status text not null check (status in ('generating','draft','finalized','superseded','failed')),
  data_cutoff_at timestamptz not null,
  query_snapshot jsonb not null,
  definition_revisions jsonb not null,
  attribution_versions jsonb,
  results jsonb not null,
  narrative jsonb,
  data_issues jsonb not null default '[]',
  supersedes_version_id uuid,
  rendered_files jsonb,
  finalized_by uuid, finalized_at timestamptz,
  agent_job_id uuid,
  unique (report_id, version_no)
);

create table agent.mcp_session (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid,
  session_key text not null unique,
  principal_type text not null check (principal_type in ('agent_client','user')),
  principal_id uuid not null,
  on_behalf_of_user_id uuid not null,
  oauth_client_id uuid,
  api_token_id uuid,
  client_name text, client_version text, protocol_version text not null,
  started_at timestamptz not null, last_seen_at timestamptz not null,
  closed_at timestamptz
);

create table agent.tool_call (
  id uuid not null, tenant_id uuid not null, workspace_id uuid,
  occurred_at timestamptz not null,
  mcp_session_id uuid, agent_job_id uuid,
  tool_name text not null,
  kind text not null check (kind in ('read','draft','plan','execute','spend','export')),
  side_effect boolean not null,
  input_hash text not null,
  input_summary jsonb not null,
  outcome text not null check (outcome in ('success','denied','require_approval','conflict','error','outcome_unknown')),
  error_code text,
  resource_refs jsonb not null default '[]',
  operation_id uuid,
  latency_ms integer not null,
  idempotency_key text,
  trace_id text,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table agent.agent_job (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  work_item_id uuid not null unique,
  kind text not null check (kind in ('content_batch_draft','translate','report_analysis','inbox_triage','research','custom')),
  title text not null,
  input_scope jsonb not null,
  expected_output jsonb not null,
  workflow_template_revision_id uuid,
  status text not null check (status in ('open','claimed','in_progress','submitted','returned','lease_expired','accepted','cancelled','done')),
  assignee_type text check (assignee_type in ('user','agent_client','runner')),
  assignee_id uuid,
  lease_owner_type text, lease_owner_id uuid,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0,
  due_at timestamptz,
  result_ref jsonb,
  source_rule_run_id uuid,
  cancel_requested_at timestamptz,
  check (status in ('open','claimed','in_progress','submitted','returned','lease_expired','accepted','cancelled','done')),
  unique (tenant_id, workspace_id, id)
);

create table agent.agent_job_event (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  agent_job_id uuid not null,
  type text not null check (type in ('claimed','heartbeat','progress','handoff','submitted','returned','accepted','lease_expired','cancel_requested','cancelled')),
  actor_type text not null, actor_id uuid,
  fencing_token bigint,
  note text,
  pending_side_effects jsonb,
  occurred_at timestamptz not null
);

create table agent.change_set (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  agent_job_id uuid,
  title text not null,
  rationale text,
  sources jsonb not null default '[]',
  status text not null check (status in ('drafting','pending','partial','applied','rejected','stale')),
  review_mode text not null check (review_mode in ('human','standing_grant')),
  standing_grant_id uuid,
  reviewed_by_user_id uuid, reviewed_at timestamptz,
  check (status in ('drafting','pending','partial','applied','rejected','stale')),
  unique (tenant_id, workspace_id, id)
);

create table agent.change_set_item (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  change_set_id uuid not null,
  seq integer not null,
  target_type text not null,
  target_id uuid,
  operation text not null check (operation in ('create','update','delete','schedule','reschedule','cancel','link')),
  expected_version integer,
  patch jsonb not null,
  preview jsonb not null,
  required_permission text not null,
  status text not null check (status in ('pending','applied','conflict','rejected','failed','skipped')),
  result jsonb,
  unique (change_set_id, seq)
);

create table agent.automation_rule (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  name text not null,
  enabled boolean not null default false,
  "trigger" jsonb not null,
  conditions jsonb not null default '[]',
  actions jsonb not null,
  run_as_service_account_id uuid not null,
  rate_limit jsonb,
  last_run_at timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table agent.rule_run (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  rule_id uuid not null,
  rule_version integer not null,
  trigger_ref jsonb not null,
  status text not null check (status in ('triggered','evaluating','skipped','waiting','acting','succeeded','failed')),
  waiting_reason text,
  action_results jsonb not null default '[]',
  started_at timestamptz not null, finished_at timestamptz,
  unique (rule_id, trigger_ref),
  unique (tenant_id, workspace_id, id)
);

create table agent.model_provider (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  kind text not null check (kind in ('openai_compatible','anthropic_compatible','internal_gateway','anthropic','bedrock','vertex','foundry')),
  protocol text not null check (protocol in ('openai_chat','anthropic_messages')),
  name text not null,
  endpoint text,
  secret_id uuid,
  capabilities jsonb not null default '{}',
  allowed_data_classes text[] not null,
  monthly_budget_minor bigint, currency char(3),
  status text not null check (status in ('active','disabled'))
);

create table agent.workflow_template (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  key text not null, name text not null,
  scope text not null check (scope in ('system','tenant','workspace')),
  current_revision_id uuid,
  unique nulls not distinct (tenant_id, workspace_id, key),
  unique (tenant_id, id)
);

create table agent.workflow_template_revision (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  template_id uuid not null,
  revision_no integer not null,
  prompt jsonb not null,
  steps jsonb not null default '[]',
  required_resources text[] not null default '{}',
  content_hash text not null,
  unique (template_id, revision_no),
  unique (tenant_id, template_id, id)
);

create table team.comment_thread (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  resource_type text not null, resource_id uuid not null,
  revision_id uuid,
  anchor jsonb,
  anchor_outdated boolean not null default false,
  audience text not null default 'internal' check (audience in ('internal','client','creator')),
  status text not null check (status in ('open','resolved')),
  resolved_by uuid, resolved_at timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table team.comment (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  thread_id uuid not null,
  body jsonb not null,
  body_text text not null,
  visibility text not null check (visibility in ('internal','client','creator')),
  attachment_file_ids uuid[] not null default '{}',
  suggestion jsonb,
  edited_at timestamptz, deleted_at timestamptz,
  check (visibility in ('internal','client','creator')),
  unique (tenant_id, workspace_id, id)
);

create table team.comment_mention (
  tenant_id uuid not null, workspace_id uuid not null,
  comment_id uuid not null,
  mentioned_type text not null check (mentioned_type in ('user','role','portal_user')),
  mentioned_id uuid not null,
  primary key (comment_id, mentioned_type, mentioned_id)
);

create table team.handover (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  from_user_id uuid not null, to_user_id uuid,
  reason text not null check (reason in ('member_removed','leave','reassign')),
  status text not null check (status in ('draft','pending_accept','completed','cancelled')),
  note text,
  accepted_at timestamptz, completed_at timestamptz,
  unique (tenant_id, workspace_id, id)
);

create table team.handover_item (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid not null,
  handover_id uuid not null,
  item_type text not null check (item_type in ('work_item','conversation_lease','agent_job','standing_grant','approval_step','saved_view')),
  item_id uuid not null,
  done_summary text, pending_summary text,
  result text not null default 'pending' check (result in ('pending','transferred','revoked','skipped')),
  result_reason text
);

create table ops.deployment_setting (
  id uuid primary key,
  tenant_id uuid,
  key text not null,
  value jsonb not null,
  is_secret_ref boolean not null default false,
  updated_by uuid, updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique nulls not distinct (tenant_id, key)
);

create table ops.node_heartbeat (
  node_id text primary key,
  roles text[] not null,
  version text not null, host text,
  started_at timestamptz not null, last_seen_at timestamptz not null,
  status jsonb not null
);

create table ops.egress_policy (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  default_effect text not null check (default_effect in ('deny','allow')),
  unique nulls not distinct (tenant_id, workspace_id),
  unique (tenant_id, id)
);

create table ops.egress_rule (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  policy_id uuid not null,
  destination_kind text not null check (destination_kind in ('mcp_client','model_provider','data_vendor','outbound_webhook','platform_api','connector')),
  destination_id text,
  data_classes text[] not null,
  effect text not null check (effect in ('allow','deny','allow_masked')),
  note text
);

create table ops.license_entitlement (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version integer not null default 1 check (version > 0),
  module_key text not null,
  enabled boolean not null,
  plan_key text,
  limits jsonb not null,
  valid_from timestamptz not null, valid_until timestamptz,
  status text not null check (status in ('active','grace','read_only','terminated')),
  source text not null check (source in ('saas_subscription','offline_license_file','manual')),
  unique (tenant_id, module_key)
);

create table ops.license_file (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  payload jsonb not null,
  signature bytea not null,
  install_fingerprint text not null,
  verified_at timestamptz, verify_error text,
  superseded_by uuid
);

create table ops.usage_event (
  id uuid not null, tenant_id uuid not null, workspace_id uuid,
  meter_key text not null check (meter_key in ('seats','brands','social_accounts','storage_bytes','sync_calls','model_tokens','mcp_calls','vendor_queries')),
  quantity numeric not null,
  source_ref jsonb,
  occurred_at timestamptz not null,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table ops.usage_meter (
  tenant_id uuid not null, meter_key text not null,
  period_start date not null, period_end date not null,
  aggregation text not null check (aggregation in ('peak','sum')),
  quantity numeric not null, computed_at timestamptz not null,
  primary key (tenant_id, meter_key, period_start)
);

create table ops.job_pause_rule (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  scope text not null check (scope in ('queue','provider','workspace','side_effect','task_kind','connector_auto')),
  scope_value text not null,
  reason text not null,
  active boolean not null default true,
  expires_at timestamptz
);

create table ops.retention_policy (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  data_class text not null check (data_class in ('raw_record','tool_call','audit_event','evidence','asset_file','metric_observation','message','customer_pii','export_file','operation','store_pii_amazon')),
  retain_mode text not null default 'fixed_days'
    check (retain_mode in ('fixed_days','follow_resource')),
  retain_days integer,
  check (retain_mode = 'follow_resource' or retain_days is not null),
  retain_anchor text not null default 'created_at'
    check (retain_anchor in ('created_at','order_delivered_at')),
  workspace_override text not null default 'any'
    check (workspace_override in ('any','shorten_only')),
  action text not null check (action in ('delete','anonymize','archive')),
  legal_hold boolean not null default false,
  unique nulls not distinct (tenant_id, workspace_id, data_class),
  unique (tenant_id, id)
);

create table ops.purge_run (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  policy_id uuid,
  status text not null check (status in ('previewed','approved','running','completed','blocked','failed')),
  preview jsonb not null,
  operation_id uuid,
  approved_by uuid, completed_at timestamptz
);

create table ops.alert_rule (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid, created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  name text not null,
  signal text not null check (signal in ('queue_lag','job_failure_rate','publish_unknown_count','sync_staleness','node_down','auth_expired_count','storage_usage','license_usage','webhook_failures','connector_auto_stopped','connector_auto_halt_active','platform_ip_denied','device_compat_blocked')),
  condition jsonb not null,
  severity text not null check (severity in ('critical','warning','info')),
  channels jsonb not null,
  enabled boolean not null default true,
  unique (tenant_id, id)
);

create table ops.alert_incident (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid,
  rule_id uuid not null,
  scope_key text not null,
  status text not null check (status in ('open','acknowledged','resolved')),
  first_seen_at timestamptz not null, last_seen_at timestamptz not null,
  occurrences integer not null default 1,
  snapshot jsonb not null,
  acknowledged_by uuid, resolved_at timestamptz, resolution_note text
);

create table ops.backup_policy (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  schedule text not null,
  includes text[] not null,
  retention_days integer not null,
  pitr_enabled boolean not null default false,
  target jsonb not null,
  unique (tenant_id, id)
);

create table ops.backup_run (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  policy_id uuid,
  status text not null check (status in ('running','succeeded','failed','verified')),
  db_snapshot_ref text, storage_manifest_ref text, config_ref text,
  consistent_at timestamptz,
  verified_by_restore_drill_at timestamptz,
  error text,
  unique (tenant_id, id)
);

create table ops.restore_run (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid,
  backup_run_id uuid,
  restore_point timestamptz not null,
  status text not null check (status in ('restoring','safe_mode','reconciling','needs_decision','resumed','failed')),
  safe_mode_entered_at timestamptz, resumed_at timestamptz, resumed_by uuid,
  summary jsonb,
  unique (tenant_id, id)
);

create table ops.restore_reconciliation_item (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), workspace_id uuid,
  restore_run_id uuid not null,
  domain text not null check (domain in ('publish','reply','ad_action','sample_shipment','commission_payment','esp_send','connector_task')),
  resource_type text not null, resource_id uuid not null,
  db_state text not null,
  external_state text,
  decision text not null default 'pending' check (decision in ('pending','adopt_external','keep_cancelled','requeue','manual')),
  decided_by uuid, decided_at timestamptz, evidence_id uuid
);

create table ops.callback_endpoint (
  id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by_type text not null check (created_by_type in ('user','agent_client','service_account','device','portal_user','system')), created_by_id uuid, version integer not null default 1 check (version > 0),
  provider text not null,
  channel text not null default 'https' check (channel in ('https','sqs','eventbridge'))
    check (channel in ('https','sqs','eventbridge')),
  path text not null,
  verify_secret_id uuid,
  reachable boolean, last_received_at timestamptz, last_check_at timestamptz,
  fallback_polling boolean not null default false,
  unique (tenant_id, provider, channel)
);

create table ops.system_release (
  id uuid primary key,
  version text not null unique,
  migrations text[] not null,
  released_at timestamptz not null, applied_at timestamptz,
  notes text
);

create table ops.component_compat (
  id uuid primary key,
  component_type text not null check (component_type in ('connector','adapter','mcp_protocol','connector_task','mobile_os','mobile_driver'))
    check (component_type in ('connector','adapter','mcp_protocol','connector_task','mobile_os','mobile_driver')),
  component_key text not null,
  component_version text not null,
  min_server_version text not null, max_server_version text,
  status text not null check (status in ('supported','deprecated','blocked')),
  supported_modes text[],
  check (supported_modes is null or supported_modes <@ array['assist','auto']::text[]),
  check (component_type <> 'connector_task' or supported_modes is not null),
  device_requirements jsonb,
  auto_terms_version text,
  note text,
  unique (component_type, component_key, component_version)
);

create table ops.auto_terms (
  id uuid primary key,
  version text not null,
  locale text not null
    check (locale in ('zh-Hant','en')),
  body text not null,
  content_hash text not null,
  released_at timestamptz not null,
  released_by uuid,
  unique (version, locale)
);

alter table iam.tenant_membership
  add foreign key (user_id) references iam.user (id),
  add foreign key (tenant_id) references core.tenant (id);

alter table iam.workspace_membership
  add foreign key (user_id) references iam.user (id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table iam.membership_role
  add foreign key (tenant_id, workspace_membership_id) references iam.workspace_membership (tenant_id, id),
  add foreign key (role_id) references iam.role (id),
  add foreign key (tenant_id) references core.tenant (id);

alter table iam.oauth_grant
  add foreign key (client_id) references iam.oauth_client (id),
  add foreign key (user_id) references iam.user (id),
  add foreign key (tenant_id) references core.tenant (id);

alter table core.evidence
  add foreign key (tenant_id, file_object_id) references core.file_object (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.operation_item
  add foreign key (tenant_id, workspace_id, operation_id) references core.operation (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.approval_request
  add foreign key (tenant_id, workspace_id, policy_id) references core.approval_policy (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.approval_decision
  add foreign key (tenant_id, workspace_id, request_id) references core.approval_request (tenant_id, workspace_id, id),
  add foreign key (decided_by_user_id) references iam.user (id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.brand
  add foreign key (tenant_id, logo_file_id) references core.file_object (tenant_id, id),
  add foreign key (tenant_id, workspace_id, id, default_market_id) references workspace.market (tenant_id, workspace_id, brand_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.market
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.work_item
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, parent_id) references workspace.work_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.work_item_dependency
  add foreign key (tenant_id, work_item_id) references workspace.work_item (tenant_id, id),
  add foreign key (tenant_id, depends_on_id) references workspace.work_item (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table workspace.work_item_event
  add foreign key (tenant_id, workspace_id, work_item_id) references workspace.work_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.notification
  add foreign key (recipient_user_id) references iam.user (id),
  add foreign key (tenant_id, work_item_id) references workspace.work_item (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.notification_delivery
  add foreign key (tenant_id, notification_id) references workspace.notification (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table account.platform_app
  add foreign key (tenant_id, secret_id) references core.secret (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table account.connection
  add foreign key (tenant_id, platform_app_id) references account.platform_app (tenant_id, id),
  add foreign key (tenant_id, secret_id) references core.secret (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.social_account
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, write_connection_id) references account.connection (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.social_account_connection
  add foreign key (tenant_id, social_account_id) references account.social_account (tenant_id, id),
  add foreign key (tenant_id, connection_id) references account.connection (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table account.capability
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, connection_id) references account.connection (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.browser_session
  add foreign key (tenant_id, device_id) references account.device (tenant_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.mobile_device
  add foreign key (tenant_id, device_id) references account.device (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.mobile_app_binding
  add foreign key (tenant_id, mobile_device_id) references account.mobile_device (tenant_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.account_execution_binding
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, device_id) references account.device (tenant_id, id),
  add foreign key (tenant_id, mobile_device_id) references account.mobile_device (tenant_id, id),
  add foreign key (tenant_id, workspace_id, auto_stop_block_id) references account.account_block (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.account_block
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, connection_id) references account.connection (tenant_id, workspace_id, id),
  add foreign key (tenant_id, device_id) references account.device (tenant_id, id),
  add foreign key (tenant_id, mobile_device_id) references account.mobile_device (tenant_id, id),
  add foreign key (tenant_id, workspace_id, work_item_id) references workspace.work_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.data_source
  add foreign key (tenant_id, workspace_id, connection_id) references account.connection (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.sync_schedule
  add foreign key (tenant_id, workspace_id, data_source_id) references ingest.data_source (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.sync_cursor
  add foreign key (tenant_id, workspace_id, data_source_id) references ingest.data_source (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.sync_run
  add foreign key (tenant_id, workspace_id, data_source_id) references ingest.data_source (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, operation_id) references core.operation (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, parent_run_id) references ingest.sync_run (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.coverage_segment
  add foreign key (tenant_id, workspace_id, data_source_id) references ingest.data_source (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.import_batch
  add foreign key (tenant_id, workspace_id, data_source_id) references ingest.data_source (tenant_id, workspace_id, id),
  add foreign key (tenant_id, file_object_id) references core.file_object (tenant_id, id),
  add foreign key (tenant_id, workspace_id, operation_id) references core.operation (tenant_id, workspace_id, id),
  add foreign key (tenant_id, error_file_object_id) references core.file_object (tenant_id, id),
  add foreign key (tenant_id, workspace_id, supersedes_batch_id) references ingest.import_batch (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.import_row
  add foreign key (tenant_id, batch_id) references ingest.import_batch (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table ingest.data_gap
  add foreign key (tenant_id, workspace_id, data_source_id) references ingest.data_source (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, work_item_id) references workspace.work_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.store
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, connection_id) references account.connection (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, data_source_id) references ingest.data_source (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.store_market
  add foreign key (tenant_id, workspace_id, store_id) references commerce.store (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, market_id) references workspace.market (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.product
  add foreign key (tenant_id, workspace_id, store_id) references commerce.store (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, primary_asset_id) references asset.asset (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.product_variant
  add foreign key (tenant_id, workspace_id, store_id, product_id) references commerce.product (tenant_id, workspace_id, store_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, store_id) references commerce.store (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.variant_group
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.variant_group_member
  add foreign key (tenant_id, workspace_id, group_id) references commerce.variant_group (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, variant_id) references commerce.product_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.listing_snapshot
  add foreign key (tenant_id, workspace_id, variant_id) references commerce.product_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, market_id) references workspace.market (tenant_id, workspace_id, id),
  add foreign key (fx_rate_id) references core.fx_rate (id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.product_fact
  add foreign key (tenant_id, workspace_id, product_id) references commerce.product (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, variant_id) references commerce.product_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, id, current_revision_id) references commerce.product_fact_revision (tenant_id, workspace_id, fact_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, id, approved_revision_id) references commerce.product_fact_revision (tenant_id, workspace_id, fact_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.product_fact_revision
  add foreign key (tenant_id, workspace_id, fact_id) references commerce.product_fact (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.product_localization
  add foreign key (tenant_id, workspace_id, product_id) references commerce.product (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, market_id) references workspace.market (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, id, current_revision_id) references commerce.product_localization_revision (tenant_id, workspace_id, localization_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, id, approved_revision_id) references commerce.product_localization_revision (tenant_id, workspace_id, localization_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, id, pending_revision_id) references commerce.product_localization_revision (tenant_id, workspace_id, localization_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.product_localization_revision
  add foreign key (tenant_id, workspace_id, localization_id) references commerce.product_localization (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table commerce.change_event
  add foreign key (tenant_id, workspace_id, product_id) references commerce.product (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, variant_id) references commerce.product_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, market_id) references workspace.market (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, snapshot_id) references commerce.listing_snapshot (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table campaign.campaign
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table campaign.campaign_market
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, market_id) references workspace.market (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table campaign.campaign_goal
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, campaign_market_id) references campaign.campaign_market (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table campaign.campaign_product
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, product_id) references commerce.product (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table campaign.campaign_plan_slot
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, market_id) references workspace.market (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table campaign.brief
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, campaign_market_id) references campaign.campaign_market (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, id, current_revision_id) references campaign.brief_revision (tenant_id, workspace_id, brief_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, id, approved_revision_id) references campaign.brief_revision (tenant_id, workspace_id, brief_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table campaign.brief_revision
  add foreign key (tenant_id, workspace_id, brief_id) references campaign.brief (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table intel.watch_target
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, data_source_id) references ingest.data_source (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table intel.research_board
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table intel.research_item
  add foreign key (tenant_id, workspace_id, board_id) references intel.research_board (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table intel.creative_reference
  add foreign key (tenant_id, workspace_id, watch_target_id) references intel.watch_target (tenant_id, workspace_id, id),
  add foreign key (tenant_id, thumbnail_file_object_id) references core.file_object (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table content.content_pillar
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table content.idea
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, pillar_id) references content.content_pillar (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table content.content_item
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, pillar_id) references content.content_pillar (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, idea_id) references content.idea (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, derived_from_item_id) references content.content_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table content.content_stage_history
  add foreign key (tenant_id, workspace_id, content_item_id) references content.content_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table content.content_variant
  add foreign key (tenant_id, workspace_id, content_item_id) references content.content_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, market_id) references workspace.market (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, parent_variant_id) references content.content_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, id, current_revision_id) references content.content_revision (tenant_id, workspace_id, variant_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, derived_from_revision_id) references content.content_revision (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table content.content_revision
  add foreign key (tenant_id, workspace_id, variant_id) references content.content_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, based_on_revision_id) references content.content_revision (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, restored_from_revision_id) references content.content_revision (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table content.content_reference
  add foreign key (tenant_id, workspace_id, revision_id) references content.content_revision (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table content.translation_link
  add foreign key (tenant_id, workspace_id, target_variant_id) references content.content_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, source_variant_id) references content.content_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, source_revision_id) references content.content_revision (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, target_revision_id) references content.content_revision (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.asset_folder
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, parent_id) references asset.asset_folder (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.asset
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, folder_id) references asset.asset_folder (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, id, current_version_id) references asset.asset_version (tenant_id, workspace_id, asset_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.asset_version
  add foreign key (tenant_id, workspace_id, asset_id) references asset.asset (tenant_id, workspace_id, id),
  add foreign key (tenant_id, file_object_id) references core.file_object (tenant_id, id),
  add foreign key (tenant_id, thumbnail_file_id) references core.file_object (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.asset_rendition
  add foreign key (tenant_id, workspace_id, asset_version_id) references asset.asset_version (tenant_id, workspace_id, id),
  add foreign key (tenant_id, file_object_id) references core.file_object (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.asset_link
  add foreign key (tenant_id, workspace_id, asset_id) references asset.asset (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.rights_grant
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, superseded_by) references asset.rights_grant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, id, current_revision_id) references asset.rights_grant_revision (tenant_id, workspace_id, rights_grant_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.rights_grant_revision
  add foreign key (tenant_id, workspace_id, rights_grant_id) references asset.rights_grant (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.rights_grant_asset
  add foreign key (tenant_id, workspace_id, rights_grant_id) references asset.rights_grant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, asset_id) references asset.asset (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, asset_version_id) references asset.asset_version (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.knowledge_entry
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, id, current_revision_id) references asset.knowledge_revision (tenant_id, workspace_id, entry_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, id, active_revision_id) references asset.knowledge_revision (tenant_id, workspace_id, entry_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.knowledge_revision
  add foreign key (tenant_id, workspace_id, entry_id) references asset.knowledge_entry (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table asset.template
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table planning.publish_plan
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, operation_id) references core.operation (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table planning.publish_target
  add foreign key (tenant_id, workspace_id, plan_id) references planning.publish_plan (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, content_item_id) references content.content_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, content_variant_id) references content.content_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, content_variant_id, variant_revision_id) references content.content_revision (tenant_id, workspace_id, variant_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, approval_request_id) references core.approval_request (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, id, execution_task_id) references execution.execution_task (tenant_id, workspace_id, publish_target_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table planning.publish_target_ref
  add foreign key (tenant_id, workspace_id, publish_target_id) references planning.publish_target (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table planning.precheck_run
  add foreign key (tenant_id, workspace_id, publish_target_id) references planning.publish_target (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table planning.precheck_item
  add foreign key (tenant_id, workspace_id, run_id) references planning.precheck_run (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table execution.execution_task
  add foreign key (tenant_id, workspace_id, publish_target_id) references planning.publish_target (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table execution.execution_attempt
  add foreign key (tenant_id, workspace_id, task_id) references execution.execution_task (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, parent_attempt_id) references execution.execution_attempt (tenant_id, workspace_id, id),
  add foreign key (tenant_id, device_id) references account.device (tenant_id, id),
  add foreign key (tenant_id, mobile_device_id) references account.mobile_device (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table execution.execution_attempt_step
  add foreign key (tenant_id, workspace_id, attempt_id) references execution.execution_attempt (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table execution.platform_post
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, publish_target_id) references planning.publish_target (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, execution_task_id) references execution.execution_task (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table execution.account_write_slot
  add foreign key (tenant_id, social_account_id) references account.social_account (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table execution.auto_submit_permit
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, attempt_id) references execution.execution_attempt (tenant_id, workspace_id, id),
  add foreign key (tenant_id, device_id) references account.device (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table execution.post_operation
  add foreign key (tenant_id, workspace_id, platform_post_id) references execution.platform_post (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, approval_request_id) references core.approval_request (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table execution.execution_handover
  add foreign key (tenant_id, workspace_id, task_id) references execution.execution_task (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, from_attempt_id) references execution.execution_attempt (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, work_item_id) references workspace.work_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.participant
  add foreign key (tenant_id, workspace_id, scope_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.conversation
  add foreign key (tenant_id, workspace_id, brand_id) references workspace.brand (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, platform_post_id) references execution.platform_post (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, primary_participant_id) references inbox.participant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.message
  add foreign key (tenant_id, workspace_id, conversation_id) references inbox.conversation (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, author_participant_id) references inbox.participant (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, outbound_reply_id) references inbox.outbound_reply (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.conversation_read_state
  add foreign key (tenant_id, conversation_id) references inbox.conversation (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table inbox.conversation_tag
  add foreign key (tenant_id, workspace_id, conversation_id) references inbox.conversation (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, tag_id) references inbox.tag (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.conversation_activity
  add foreign key (tenant_id, workspace_id, conversation_id) references inbox.conversation (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.conversation_occupancy
  add foreign key (tenant_id, workspace_id, conversation_id) references inbox.conversation (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.reply_draft
  add foreign key (tenant_id, workspace_id, conversation_id) references inbox.conversation (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, in_reply_to_message_id) references inbox.message (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, approval_request_id) references core.approval_request (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, template_id) references asset.template (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.outbound_reply
  add foreign key (tenant_id, workspace_id, conversation_id) references inbox.conversation (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, reply_draft_id) references inbox.reply_draft (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, social_account_id) references account.social_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, result_message_id) references inbox.message (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.outbound_reply_attempt
  add foreign key (tenant_id, workspace_id, outbound_reply_id) references inbox.outbound_reply (tenant_id, workspace_id, id),
  add foreign key (tenant_id, mobile_device_id) references account.mobile_device (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.internal_note
  add foreign key (tenant_id, workspace_id, conversation_id) references inbox.conversation (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, anchor_message_id) references inbox.message (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table traffic.short_link
  add foreign key (tenant_id, domain_id) references traffic.link_domain (tenant_id, id),
  add foreign key (tenant_id, workspace_id, id, current_revision_id) references traffic.short_link_revision (tenant_id, workspace_id, short_link_id, id) deferrable initially deferred,
  add foreign key (tenant_id, workspace_id, campaign_id) references campaign.campaign (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, content_item_id) references content.content_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, publish_target_id) references planning.publish_target (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, product_variant_id) references commerce.product_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table traffic.short_link_revision
  add foreign key (tenant_id, workspace_id, short_link_id) references traffic.short_link (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table analytics.metric_definition_revision
  add foreign key (definition_id) references analytics.metric_definition (id);

alter table analytics.report_version
  add foreign key (tenant_id, workspace_id, report_id) references analytics.report (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.mcp_session
  add foreign key (oauth_client_id) references iam.oauth_client (id),
  add foreign key (tenant_id, api_token_id) references iam.api_token (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.agent_job_event
  add foreign key (tenant_id, workspace_id, agent_job_id) references agent.agent_job (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.change_set
  add foreign key (tenant_id, workspace_id, agent_job_id) references agent.agent_job (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.change_set_item
  add foreign key (tenant_id, workspace_id, change_set_id) references agent.change_set (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.automation_rule
  add foreign key (tenant_id, workspace_id, run_as_service_account_id) references iam.service_account (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.rule_run
  add foreign key (tenant_id, workspace_id, rule_id) references agent.automation_rule (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.model_provider
  add foreign key (tenant_id, secret_id) references core.secret (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.workflow_template_revision
  add foreign key (tenant_id, template_id) references agent.workflow_template (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table team.comment
  add foreign key (tenant_id, workspace_id, thread_id) references team.comment_thread (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table team.comment_mention
  add foreign key (tenant_id, workspace_id, comment_id) references team.comment (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table team.handover_item
  add foreign key (tenant_id, workspace_id, handover_id) references team.handover (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.egress_rule
  add foreign key (tenant_id, policy_id) references ops.egress_policy (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table ops.purge_run
  add foreign key (tenant_id, policy_id) references ops.retention_policy (tenant_id, id),
  add foreign key (tenant_id, operation_id) references core.operation (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.alert_incident
  add foreign key (tenant_id, rule_id) references ops.alert_rule (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.backup_run
  add foreign key (tenant_id, policy_id) references ops.backup_policy (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table ops.restore_run
  add foreign key (tenant_id, backup_run_id) references ops.backup_run (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table ops.restore_reconciliation_item
  add foreign key (tenant_id, restore_run_id) references ops.restore_run (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.workflow_template
  add foreign key (tenant_id, id, current_revision_id) references agent.workflow_template_revision (tenant_id, template_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table iam.session
  add foreign key (user_id) references iam.user (id),
  add foreign key (tenant_id) references core.tenant (id);

alter table traffic.click_event
  add foreign key (tenant_id, workspace_id, short_link_id) references traffic.short_link (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, short_link_id, revision_id) references traffic.short_link_revision (tenant_id, workspace_id, short_link_id, id) deferrable initially deferred,
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table traffic.click_rollup_hourly
  add foreign key (tenant_id, workspace_id, short_link_id) references traffic.short_link (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table traffic.landing_destination
  add foreign key (tenant_id, workspace_id, product_id) references commerce.product (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, product_variant_id) references commerce.product_variant (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table traffic.page_check
  add foreign key (tenant_id, workspace_id, publish_target_id) references planning.publish_target (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.tool_call
  add foreign key (tenant_id, operation_id) references core.operation (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table agent.agent_job
  add foreign key (tenant_id, workspace_id, work_item_id) references workspace.work_item (tenant_id, workspace_id, id),
  add foreign key (tenant_id, workspace_id, source_rule_run_id) references agent.rule_run (tenant_id, workspace_id, id),
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.callback_endpoint
  add foreign key (tenant_id, verify_secret_id) references core.secret (tenant_id, id),
  add foreign key (tenant_id) references core.tenant (id);

alter table iam.role
  add foreign key (tenant_id) references core.tenant (id);

alter table iam.api_token
  add foreign key (tenant_id) references core.tenant (id);

alter table iam.oauth_client
  add foreign key (tenant_id) references core.tenant (id);

alter table iam.service_account
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table iam.standing_grant
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.audit_event
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.outbox
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.operation
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.idempotency_record
  add foreign key (tenant_id) references core.tenant (id);

alter table core.approval_policy
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.file_object
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table core.secret
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.workspace
  add foreign key (tenant_id) references core.tenant (id);

alter table workspace.notification_preference
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.subscription
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.search_document
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table workspace.onboarding_progress
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.oauth_flow
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.device
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.device_pairing_code
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table account.connector_auto_policy
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.raw_record
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.webhook_delivery
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ingest.field_mapping
  add foreign key (tenant_id) references core.tenant (id);

alter table ingest.quality_rule
  add foreign key (tenant_id) references core.tenant (id);

alter table ingest.quality_issue
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table intel.observation
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table planning.pause_switch
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table execution.execution_setting
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table inbox.tag
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table traffic.link_domain
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table traffic.utm_template
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table analytics.metric_definition
  add foreign key (tenant_id) references core.tenant (id);

alter table analytics.metric_observation
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table analytics.metric_latest
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table analytics.metric_at_age
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table analytics.metric_daily
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table analytics.report
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table team.comment_thread
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table team.handover
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.deployment_setting
  add foreign key (tenant_id) references core.tenant (id);

alter table ops.egress_policy
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.license_entitlement
  add foreign key (tenant_id) references core.tenant (id);

alter table ops.license_file
  add foreign key (tenant_id) references core.tenant (id);

alter table ops.usage_event
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.usage_meter
  add foreign key (tenant_id) references core.tenant (id);

alter table ops.job_pause_rule
  add foreign key (tenant_id) references core.tenant (id);

alter table ops.retention_policy
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.alert_rule
  add foreign key (tenant_id) references core.tenant (id),
  add foreign key (tenant_id, workspace_id) references workspace.workspace (tenant_id, id);

alter table ops.backup_policy
  add foreign key (tenant_id) references core.tenant (id);

create index on core.outbox (dispatched_at) where dispatched_at is null;
create index on core.approval_request (resource_type, resource_id, status);
create index on core.file_object (tenant_id, sha256);
create index on workspace.work_item (workspace_id, assignee_id, status, due_at);
create index on workspace.work_item (workspace_id, resource_type, resource_id);
create index on workspace.notification (recipient_user_id, read_at, created_at desc);
create index on workspace.search_document using gin (tsv);
create index on workspace.search_document using gin (trgm_text gin_trgm_ops);
create index on account.connection (tenant_id, provider, external_principal_id);
create unique index on account.capability (social_account_id, operation, content_format) where social_account_id is not null;
create unique index on account.capability (connection_id, operation, content_format) where social_account_id is null;
create unique index on account.mobile_device (tenant_id, hardware_id_hash) where status <> 'removed';
create unique index on account.mobile_app_binding (mobile_device_id, app) where status <> 'removed';
create unique index on account.mobile_app_binding (social_account_id) where status <> 'removed';
create unique index on account.account_block (social_account_id, kind) where status in ('open','assigned','resolving');
create unique index on account.account_block (mobile_device_id, kind) where status in ('open','assigned','resolving') and social_account_id is null;
create unique index on ingest.data_source (workspace_id, provider, connection_id, social_account_id)
  where status <> 'disabled';
create index on ingest.sync_schedule (next_due_at) where paused_until is null;
create index on ingest.sync_run (data_source_id, resource, created_at desc);
create index on ingest.sync_run (status) where status in ('queued','running','rate_limited');
create index on ingest.raw_record (data_source_id, resource, external_id, fetched_at desc);
create unique index on ingest.field_mapping (coalesce(tenant_id,'00000000-0000-0000-0000-000000000000'), provider, resource, api_version, source_path, revision);
create unique index on ingest.quality_issue (workspace_id, fingerprint)
  where status in ('open','acknowledged','investigating');
create index on commerce.product_variant (store_id, sku);
create unique index on commerce.variant_group_member (variant_id) where unlinked_at is null;
create unique index on commerce.listing_snapshot (variant_id, market_id, channel) where is_current;
create index on commerce.listing_snapshot (variant_id, market_id, channel, observed_at desc);
create index on commerce.change_event (workspace_id, status, detected_at desc);
create index on intel.observation (watch_target_id, external_id, observed_at desc);
create index on content.content_item (workspace_id, production_stage);
create index on content.content_item (campaign_id);
create index on content.content_variant (content_item_id);
create index on content.content_revision (variant_id, content_hash);
create index on content.content_reference (ref_type, ref_id);
create index on asset.asset using gin (tags);
create index on asset.asset_version (tenant_id, sha256);
create index on asset.asset_link (link_type, link_id);
create index on asset.rights_grant (workspace_id, status, valid_until);
create index on asset.rights_grant_asset (asset_id);
create index on asset.knowledge_entry (brand_id, kind, status);
create index on planning.publish_target (workspace_id, scheduled_at);
create index on planning.publish_target (social_account_id, scheduled_at);
create index on planning.publish_target (plan_status) where plan_status in ('ready','paused','awaiting_approval');
create unique index on planning.publish_target (plan_id, social_account_id, content_variant_id, scheduled_at)
  where plan_status not in ('cancelled','superseded');
create index on planning.publish_target_ref (ref_type, ref_id);
create unique index on planning.pause_switch (scope_type, scope_id) where released_at is null;
create unique index on execution.execution_task (publish_target_id)
  where status not in ('cancelled','expired','failed','published');
create index on execution.execution_task (status, due_at);
create index on execution.execution_task (social_account_id, status);
create index on execution.execution_attempt (status, next_check_at) where status in ('submitted','accepted','unknown');
create unique index on execution.execution_attempt (mobile_device_id) where status in ('claimed','in_progress');
create unique index on execution.execution_attempt (parent_attempt_id) where purpose = 'complete_draft' and status <> 'abandoned';
create unique index on execution.platform_post (social_account_id, external_post_id) where external_post_id is not null;
create index on execution.platform_post (publish_target_id);
create unique index on execution.auto_submit_permit (attempt_id) where decision = 'granted';
create index on execution.auto_submit_permit (social_account_id, decided_at) where decision = 'granted';
create index on inbox.conversation (workspace_id, status, assignee_user_id, last_inbound_at desc);
create index on inbox.conversation (platform_post_id);
create index on inbox.message (conversation_id, platform_created_at);
create index on inbox.conversation_activity (conversation_id, created_at);
create index on traffic.short_link (workspace_id, campaign_id);
create index on traffic.page_check (target_type, target_id, checked_at desc);
create index on analytics.metric_observation (subject_type, subject_id, metric_key, observed_at desc);
create index on analytics.metric_observation (workspace_id, metric_key, period_start) where period_kind = 'day';
create index on agent.agent_job (workspace_id, status, due_at);
create index on team.comment_thread (workspace_id, resource_type, resource_id);
create unique index on ops.alert_incident (rule_id, scope_key) where status <> 'resolved';
