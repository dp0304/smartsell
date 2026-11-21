-- Keep related records consistent within a workspace as well as across tenants.
-- Validate existing rows before recording this migration.
alter table commerce.store add unique (tenant_id, workspace_id, brand_id, id);
alter table commerce.product add constraint product_store_brand_fk
  foreign key (tenant_id, workspace_id, brand_id, store_id) references commerce.store (tenant_id, workspace_id, brand_id, id);

alter table content.content_item add unique (tenant_id, workspace_id, brand_id, id);
alter table content.content_variant add unique (tenant_id, workspace_id, content_item_id, id);
alter table account.social_account add unique (tenant_id, workspace_id, brand_id, id);
alter table core.approval_request add unique (tenant_id, workspace_id, resource_id, id);
alter table planning.precheck_run add unique (tenant_id, workspace_id, publish_target_id, id);
alter table planning.publish_target
  add constraint target_approval_resource_fk foreign key (tenant_id, workspace_id, id, approval_request_id)
    references core.approval_request (tenant_id, workspace_id, resource_id, id),
  add constraint target_precheck_fk foreign key (tenant_id, workspace_id, id, last_precheck_run_id)
    references planning.precheck_run (tenant_id, workspace_id, publish_target_id, id),
  add constraint target_item_brand_fk foreign key (tenant_id, workspace_id, brand_id, content_item_id)
    references content.content_item (tenant_id, workspace_id, brand_id, id),
  add constraint target_item_variant_fk foreign key (tenant_id, workspace_id, content_item_id, content_variant_id)
    references content.content_variant (tenant_id, workspace_id, content_item_id, id),
  add constraint target_account_brand_fk foreign key (tenant_id, workspace_id, brand_id, social_account_id)
    references account.social_account (tenant_id, workspace_id, brand_id, id);

alter table execution.execution_attempt add unique (tenant_id, workspace_id, task_id, id);
alter table execution.platform_post add unique (tenant_id, workspace_id, execution_task_id, id);
alter table execution.execution_task
  add constraint task_active_attempt_fk foreign key (tenant_id, workspace_id, id, active_attempt_id)
    references execution.execution_attempt (tenant_id, workspace_id, task_id, id),
  add constraint task_platform_post_fk foreign key (tenant_id, workspace_id, id, platform_post_id)
    references execution.platform_post (tenant_id, workspace_id, execution_task_id, id);

-- The runtime inserts parents first and binds inverse links in a second pass.
-- Check the forward references before releasing its per-row savepoint.
do $$
declare
  link record;
begin
  for link in select conrelid::regclass as child, conname from pg_constraint
    where contype = 'f' and condeferred and (conrelid, confrelid) in (
      ('commerce.product_variant'::regclass, 'commerce.product'::regclass),
      ('planning.publish_target'::regclass, 'content.content_revision'::regclass))
  loop
    execute format('alter table %s alter constraint %I deferrable initially immediate', link.child, link.conname);
  end loop;
end;
$$;

-- File uploads and evidence use the same workspace transaction.
grant insert, update on core.file_object to smartsell_request;

-- Approval permits multiple reviewers per step, but one decision per reviewer.
alter table core.approval_decision
  add constraint approval_decision_reviewer_key unique (request_id, step_no, decided_by_user_id);
create trigger content_revision_append_only before update or delete on content.content_revision
  for each row execute function core.reject_immutable_edit();
create trigger approval_decision_append_only before update or delete on core.approval_decision
  for each row execute function core.reject_immutable_edit();

-- A workspace may read tenant-wide rows. A tenant-wide child cannot point to
-- a workspace-specific parent, and a workspace child cannot point to a sibling.
-- Discover the scoped references that already have a tenant FK in the schema.
do $$
declare
  link record;
begin
  for link in
    select con.conname, con.conrelid::regclass as child, con.confrelid::regclass as parent, ref.attname as column_name
    from pg_constraint con
    join pg_attribute ref on ref.attrelid = con.conrelid and ref.attnum = con.conkey[2]
    join pg_attribute child_scope on child_scope.attrelid = con.conrelid and child_scope.attname = 'workspace_id' and not child_scope.attisdropped
    join pg_attribute parent_scope on parent_scope.attrelid = con.confrelid and parent_scope.attname = 'workspace_id' and not parent_scope.attisdropped
    where con.contype = 'f' and con.conparentid = 0 and cardinality(con.conkey) = 2
      and con.confrelid in ('core.file_object'::regclass, 'core.secret'::regclass, 'account.device'::regclass, 'account.mobile_device'::regclass)
      and not exists (select from pg_trigger t where t.tgrelid = con.conrelid
        and t.tgfoid = 'core.check_shared_workspace_reference()'::regprocedure
        and split_part(encode(t.tgargs, 'escape'), chr(92) || '000', 1) = ref.attname)
  loop
    execute format('create trigger shared_%1$I before insert or update of tenant_id, workspace_id, %2$I on %3$s
      for each row execute function core.check_shared_workspace_reference(%4$L, %5$L)',
      link.column_name, link.column_name, link.child, link.column_name, link.parent);
  end loop;
end;
$$;

-- References to shared objects use tenant+id keys, which cannot detect a
-- subsequent workspace move. Keep the scope immutable for these identities.
create function core.reject_shared_scope_move() returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if (old.tenant_id, old.workspace_id) is distinct from (new.tenant_id, new.workspace_id) then
    raise foreign_key_violation using message = 'Shared object scope is immutable';
  end if;
  return new;
end;
$$;
revoke all on function core.reject_shared_scope_move() from public;
create trigger immutable_scope before update of tenant_id, workspace_id on core.file_object
  for each row execute function core.reject_shared_scope_move();
create trigger immutable_scope before update of tenant_id, workspace_id on core.secret
  for each row execute function core.reject_shared_scope_move();
create trigger immutable_scope before update of tenant_id, workspace_id on account.device
  for each row execute function core.reject_shared_scope_move();
create trigger immutable_scope before update of tenant_id, workspace_id on account.mobile_device
  for each row execute function core.reject_shared_scope_move();
