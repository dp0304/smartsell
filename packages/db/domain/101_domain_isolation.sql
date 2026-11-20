-- The application GUCs narrow a scope. A live session or a transaction-bound
-- operation actor proves access. Public locators have no general domain access.
create function core.in_domain_scope(p_tenant uuid, p_workspace uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p_tenant = nullif(current_setting('app.tenant_id', true), '')::uuid
    and ss.actor() = nullif(current_setting('app.principal', true), '')::uuid
    and exists (
      select from ss.workspaces w
      where w.tenant_id = p_tenant
        and w.id = any(nullif(current_setting('app.workspace_ids', true), '')::uuid[])
        and (p_workspace is null or w.id = p_workspace)
        and case when nullif(current_setting('smartsell.session_hash', true), '') is not null then
          exists (select from ss.memberships m where m.workspace_id = w.id and m.user_id = ss.actor())
        when nullif(current_setting('smartsell.operation_workspace', true), '') is not null then
          ss.in_operation_scope(w.tenant_id, w.id)
        else false end
    );
$$;
revoke all on function core.in_domain_scope(uuid, uuid) from public;
grant execute on function core.in_domain_scope(uuid, uuid) to smartsell_request;

-- Identity is still managed by ss. Keep stable identifiers and leave credentials
-- in the existing authenticated repository. Run this before forcing domain RLS.
create function core.mirror_identity() returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  case tg_table_name
    when 'tenants' then
      insert into core.tenant (id, name, deployment_kind, data_region, status)
      values (new.id, new.id::text, 'private', 'overseas', 'active');
    when 'workspaces' then
      insert into workspace.workspace (id, tenant_id, slug, name, kind, default_timezone, reporting_currency, status, created_by_type)
      values (new.id, new.tenant_id, new.id::text, new.name, 'brand_team', 'Asia/Taipei', 'USD', 'active', 'system')
      on conflict (id) do update set name = excluded.name, updated_at = now();
    when 'users' then
      insert into iam."user" (id, email, display_name, kind, status)
      values (new.id, new.email, new.name, 'staff', 'active')
      on conflict (id) do update set display_name = excluded.display_name, email = excluded.email, updated_at = now();
  end case;
  return new;
end;
$$;
revoke all on function core.mirror_identity() from public;

-- Installing the triggers before seeding excludes concurrent changes to the
-- source identity tables until this migration commits.
create trigger domain_tenant after insert on ss.tenants for each row execute function core.mirror_identity();
create trigger domain_workspace after insert or update of name on ss.workspaces for each row execute function core.mirror_identity();
create trigger domain_user after insert or update of name, email on ss.users for each row execute function core.mirror_identity();
insert into core.tenant (id, name, deployment_kind, data_region, status)
select id, id::text, 'private', 'overseas', 'active' from ss.tenants;
insert into workspace.workspace (id, tenant_id, slug, name, kind, default_timezone, reporting_currency, status, created_by_type)
select id, tenant_id, id::text, name, 'brand_team', 'Asia/Taipei', 'USD', 'active', 'system' from ss.workspaces;
insert into iam."user" (id, email, display_name, kind, status)
select id, email, name, 'staff', 'active' from ss.users;

-- Provision UTC ranges for current and upcoming writes. Default partitions
-- preserve late and out-of-range writes, including during an upgrade.
create function core.ensure_domain_partitions(anchor date default (now() at time zone 'UTC')::date)
returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  parent record;
  starts date;
  ends date;
  step interval;
  current_start date;
  child text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ss.domain.partitions', 0));
  for parent in select * from (values
    ('core', 'audit_event', 'month'), ('ingest', 'raw_record', 'month'), ('ingest', 'webhook_delivery', 'month'),
    ('intel', 'observation', 'quarter'), ('traffic', 'click_event', 'month'), ('analytics', 'metric_observation', 'month'),
    ('agent', 'tool_call', 'month'), ('ops', 'usage_event', 'month')
  ) as p(schema_name, table_name, cadence) loop
    step := case parent.cadence when 'month' then interval '1 month' else interval '3 months' end;
    current_start := date_trunc(parent.cadence, anchor::timestamp)::date;
    for n in -1..3 loop
      starts := current_start + n * step;
      ends := starts + step;
      child := parent.table_name || '_p' || to_char(starts, 'YYYYMM');
      execute format('create table if not exists %I.%I partition of %I.%I for values from (%L) to (%L)',
        parent.schema_name, child, parent.schema_name, parent.table_name, starts || ' 00:00:00+00', ends || ' 00:00:00+00');
      execute format('alter table %I.%I enable row level security, force row level security', parent.schema_name, child);
    end loop;
    execute format('create table if not exists %I.%I partition of %I.%I default',
      parent.schema_name, parent.table_name || '_default', parent.schema_name, parent.table_name);
  end loop;
end;
$$;
revoke all on function core.ensure_domain_partitions(date) from public;
select core.ensure_domain_partitions();

create index audit_event_scope_time_idx on core.audit_event (tenant_id, workspace_id, occurred_at desc);
create index approval_decision_request_idx on core.approval_decision (tenant_id, workspace_id, request_id);
create index evidence_resource_idx on core.evidence (tenant_id, workspace_id, linked_resource_type, linked_resource_id);

-- Policies are installed on the parents. Direct access to a child partition
-- requires its own grant and policy, neither of which is issued here.
do $$
declare
  rel record;
  predicate text;
  tenant_col text;
  workspace_col text;
begin
  for rel in select c.oid, c.relname, c.relispartition, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in
      ('core','iam','workspace','account','ingest','commerce','campaign','intel','content','asset','planning','execution','inbox','traffic','analytics','agent','team','ops')
  loop
    execute format('alter table %I.%I enable row level security', rel.nspname, rel.relname);
    execute format('alter table %I.%I force row level security', rel.nspname, rel.relname);
    if rel.relispartition then continue; end if;
    tenant_col := null;
    workspace_col := 'null::uuid';
    if rel.nspname = 'core' and rel.relname = 'tenant' then
      tenant_col := 'id';
    elsif exists (select from pg_attribute where attrelid = rel.oid and attname = 'tenant_id' and not attisdropped) then
      tenant_col := 'tenant_id';
    end if;
    if rel.nspname = 'workspace' and rel.relname = 'workspace' then
      workspace_col := 'id';
    elsif exists (select from pg_attribute where attrelid = rel.oid and attname = 'workspace_id' and not attisdropped) then
      workspace_col := 'workspace_id';
    end if;
    predicate := case
      when rel.nspname = 'ingest' and rel.relname = 'import_row' then
        'exists (select from ingest.import_batch b where b.id = batch_id and b.tenant_id = import_row.tenant_id and core.in_domain_scope(b.tenant_id, b.workspace_id))'
      when rel.nspname = 'ops' and rel.relname = 'egress_rule' then
        'exists (select from ops.egress_policy p where p.id = policy_id and p.tenant_id = egress_rule.tenant_id and core.in_domain_scope(p.tenant_id, p.workspace_id))'
      when tenant_col is not null then format('core.in_domain_scope(%s, %s)', tenant_col, workspace_col)
    end;
    if predicate is not null then
      execute format('create policy tenant_scope on %I.%I to smartsell_request using (%s) with check (%s)',
        rel.nspname, rel.relname, predicate, predicate);
    end if;
    -- The migration owner maintains schema, deploy-wide records and retention.
    execute format('create policy domain_owner on %I.%I to %I using (true) with check (true)',
      rel.nspname, rel.relname, current_user);
  end loop;
end;
$$;

-- A shared parent can have a null workspace. Retain its tenant FK and also
-- reject references to a workspace-specific parent from any other workspace.
create function core.check_shared_workspace_reference() returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  ref_id uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  matching boolean;
begin
  if ref_id is null then return new; end if;
  execute format('select exists (select from %s where id = $1 and tenant_id = $2 and (workspace_id is null or workspace_id = $3))',
    tg_argv[1]::regclass)
    into matching using ref_id, new.tenant_id, new.workspace_id;
  if not matching then
    raise foreign_key_violation using message = format('%I must reference the same tenant and workspace, or a tenant-wide row', tg_argv[0]);
  end if;
  return new;
end;
$$;
revoke all on function core.check_shared_workspace_reference() from public;

create trigger evidence_file_scope before insert or update of tenant_id, workspace_id, file_object_id on core.evidence
  for each row execute function core.check_shared_workspace_reference('file_object_id', 'core.file_object');
create trigger brand_logo_scope before insert or update of tenant_id, workspace_id, logo_file_id on workspace.brand
  for each row execute function core.check_shared_workspace_reference('logo_file_id', 'core.file_object');
create trigger connection_secret_scope before insert or update of tenant_id, workspace_id, secret_id on account.connection
  for each row execute function core.check_shared_workspace_reference('secret_id', 'core.secret');
create trigger attempt_device_scope before insert or update of tenant_id, workspace_id, device_id on execution.execution_attempt
  for each row execute function core.check_shared_workspace_reference('device_id', 'account.device');
create trigger attempt_mobile_scope before insert or update of tenant_id, workspace_id, mobile_device_id on execution.execution_attempt
  for each row execute function core.check_shared_workspace_reference('mobile_device_id', 'account.mobile_device');

grant usage on schema core, workspace, account, campaign, commerce, content, planning, execution to smartsell_request;
grant select on core.tenant, workspace.workspace, core.audit_event, core.file_object, core.operation,
  account.platform_app, account.device, account.mobile_device to smartsell_request;
grant select, insert, update on workspace.brand, workspace.market, workspace.work_item,
  account.connection, account.social_account,
  commerce.store, commerce.product, commerce.product_variant, campaign.campaign,
  content.content_pillar, content.idea, content.content_item, content.content_variant, content.translation_link,
  core.approval_policy, core.approval_request, planning.publish_plan, planning.publish_target, planning.pause_switch,
  execution.execution_task, execution.execution_attempt, execution.platform_post to smartsell_request;
grant select, insert on core.approval_decision, core.evidence, content.content_revision, content.content_stage_history,
  planning.precheck_run to smartsell_request;

-- A service account, public actor or background operation cannot decide an approval.
create policy require_human_approval on core.approval_decision as restrictive for insert to smartsell_request
with check (nullif(current_setting('smartsell.session_hash', true), '') is not null and decided_by_user_id = ss.actor());

create function core.reject_immutable_edit() returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% is immutable', tg_table_name using errcode = '55000';
end;
$$;
revoke all on function core.reject_immutable_edit() from public;
create trigger auto_terms_append_only before update or delete on ops.auto_terms for each row execute function core.reject_immutable_edit();

-- Legacy audit remains the event/outbox FK authority. Mirror new successful
-- operations after legacy authorization, in the same transaction and savepoint.
create function core.mirror_audit() returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  insert into core.audit_event (id, tenant_id, workspace_id, occurred_at, actor_type, actor_id, via, action, resource_type, outcome)
  values (new.id, new.tenant_id, new.workspace_id, new.created_at,
    case when nullif(current_setting('smartsell.operation_workspace', true), '') is not null then 'system'
         when nullif(current_setting('smartsell.public_locator', true), '') is not null then 'public' else 'user' end,
    new.actor_id,
    case when nullif(current_setting('smartsell.operation_workspace', true), '') is not null then 'system'
         when nullif(current_setting('smartsell.public_locator', true), '') is not null then 'portal' else 'web' end,
    new.action, new.module, 'success');
  return new;
end;
$$;
revoke all on function core.mirror_audit() from public;
create trigger domain_audit after insert on ss.audit for each row execute function core.mirror_audit();
