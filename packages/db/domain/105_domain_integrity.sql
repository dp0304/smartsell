-- Child rows without workspace_id inherit visibility through their scoped parent.
do $$
declare
  link record;
  predicate text;
begin
  for link in select * from (values
    ('iam.membership_role'::regclass, 'iam.workspace_membership'::regclass, 'workspace_membership_id', 'id'),
    ('workspace.work_item_dependency'::regclass, 'workspace.work_item'::regclass, 'work_item_id', 'id'),
    ('workspace.notification_delivery'::regclass, 'workspace.notification'::regclass, 'notification_id', 'id'),
    ('account.social_account_connection'::regclass, 'account.social_account'::regclass, 'social_account_id', 'id'),
    ('execution.account_write_slot'::regclass, 'account.social_account'::regclass, 'social_account_id', 'id'),
    ('inbox.conversation_read_state'::regclass, 'inbox.conversation'::regclass, 'conversation_id', 'id')
  ) as links(child, parent, column_name, parent_key) loop
    predicate := format('exists (select from %s parent where parent.%I = %I and parent.tenant_id = %s.tenant_id
      and core.in_domain_scope(parent.tenant_id, parent.workspace_id))',
      link.parent, link.parent_key, link.column_name, link.child);
    execute format('alter policy tenant_scope on %s using (%s) with check (%s)', link.child, predicate, predicate);
  end loop;
end;
$$;

alter table ingest.raw_record
  add constraint raw_source_fk foreign key (tenant_id, workspace_id, data_source_id)
    references ingest.data_source (tenant_id, workspace_id, id),
  add constraint raw_run_fk foreign key (tenant_id, workspace_id, sync_run_id)
    references ingest.sync_run (tenant_id, workspace_id, id),
  add constraint raw_batch_fk foreign key (tenant_id, workspace_id, import_batch_id)
    references ingest.import_batch (tenant_id, workspace_id, id),
  add constraint raw_payload_file_fk foreign key (tenant_id, payload_file_object_id)
    references core.file_object (tenant_id, id);
create trigger raw_payload_file_scope before insert or update of tenant_id, workspace_id, payload_file_object_id on ingest.raw_record
  for each row execute function core.check_shared_workspace_reference('payload_file_object_id', 'core.file_object');

alter table ingest.webhook_delivery
  add constraint webhook_source_fk foreign key (tenant_id, workspace_id, routed_data_source_id)
    references ingest.data_source (tenant_id, workspace_id, id),
  add constraint webhook_source_scope check ((routed_data_source_id is null and triggered_sync_run_id is null) or workspace_id is not null),
  add constraint webhook_run_fk foreign key (tenant_id, workspace_id, triggered_sync_run_id)
    references ingest.sync_run (tenant_id, workspace_id, id),
  add constraint webhook_payload_file_fk foreign key (tenant_id, payload_file_object_id)
    references core.file_object (tenant_id, id);
create trigger webhook_payload_file_scope before insert or update of tenant_id, workspace_id, payload_file_object_id on ingest.webhook_delivery
  for each row execute function core.check_shared_workspace_reference('payload_file_object_id', 'core.file_object');

-- Lifetime observations have no period_start. Keep the partition key in the
-- unique constraint and treat null period starts as the same logical key.
alter table analytics.metric_observation add constraint metric_observation_scope_key
  unique nulls not distinct (tenant_id, workspace_id, subject_type, subject_id, metric_key, period_kind, period_start, dims_hash, observed_at);

do $$
declare prior name;
begin
  select conname into strict prior from pg_constraint where conrelid='analytics.metric_observation'::regclass
    and contype='u' and conname<>'metric_observation_scope_key';
  execute format('alter table analytics.metric_observation drop constraint %I', prior);
end;
$$;

-- Preserve historical audit rows using the immutable legacy event identities.
-- Grant the migration owner a SELECT policy just for this transaction.
do $$
begin
  execute format('create policy domain_audit_copy on ss.audit for select to %I using (true)', current_user);
end;
$$;
insert into core.audit_event (id, tenant_id, workspace_id, occurred_at, actor_type, actor_id, via, action, resource_type, outcome)
select a.id, a.tenant_id, a.workspace_id, a.created_at,
  case when o.actor_id is not null then 'system' when p.actor_id is not null then 'public' else 'user' end,
  a.actor_id, case when o.actor_id is not null then 'system' when p.actor_id is not null then 'portal' else 'web' end,
  a.action, a.module, 'success'
from ss.audit a
left join ss.operation_actors o on (o.workspace_id, o.actor_id)=(a.workspace_id, a.actor_id)
left join ss.public_actors p on (p.workspace_id, p.actor_id)=(a.workspace_id, a.actor_id)
on conflict (id, occurred_at) do nothing;
drop policy domain_audit_copy on ss.audit;

-- Partition rollover and authorized retention may delete and reinsert rows.
-- No runtime login has DELETE or UPDATE on either parent.
create trigger audit_no_update before update on core.audit_event
  for each row execute function core.reject_immutable_edit();
create trigger usage_no_update before update on ops.usage_event
  for each row execute function core.reject_immutable_edit();
