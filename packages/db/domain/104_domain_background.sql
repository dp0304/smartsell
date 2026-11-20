-- Revoke the 007 capability even when this deployment has no background login.
revoke execute on function ss.operation_workspaces(), ss.lock_operation_workspace(uuid), ss.operation_members(uuid)
  from public, smartsell_request;

do $$
declare
  background_role pg_roles%rowtype;
begin
  select * into background_role from pg_roles where rolname = 'smartsell_background';
  if not found then return; end if;
  if background_role.rolcanlogin or background_role.rolsuper or background_role.rolbypassrls
    or background_role.rolcreaterole or background_role.rolcreatedb or background_role.rolreplication
    or pg_has_role(background_role.oid, current_user, 'MEMBER')
    or pg_has_role('smartsell_request', background_role.oid, 'MEMBER') then
    raise exception 'Provision smartsell_background as a separate, unprivileged NOLOGIN role';
  end if;
  grant execute on function ss.operation_workspaces(), ss.lock_operation_workspace(uuid), ss.operation_members(uuid)
    to smartsell_background;
end;
$$;

-- The background login inherits the existing scoped table permissions from
-- smartsell_request. Only its session may resolve a transaction-bound operation actor.
create or replace function ss.scope_actor() returns uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case when nullif(current_setting('smartsell.session_hash', true), '') is not null then (
    select s.user_id from ss.sessions s where s.token_hash = current_setting('smartsell.session_hash', true)
      and s.expires_at > transaction_timestamp()
  ) when nullif(current_setting('smartsell.operation_workspace', true), '') is not null then (
    select a.actor_id from ss.operation_actors a
    where a.workspace_id::text = current_setting('smartsell.operation_workspace', true)
      and a.transaction_id = pg_current_xact_id_if_assigned()
      and exists (select from pg_roles r where r.rolname = 'smartsell_background'
        and pg_has_role(session_user, r.oid, 'USAGE'))
  ) else (
    select a.actor_id from ss.public_locators l join ss.public_actors a using (workspace_id)
    where l.locator = current_setting('smartsell.public_locator', true) and l.id = current_setting('smartsell.public_id', true)
  ) end
$$;

create or replace function ss.in_operation_scope(p_tenant uuid, p_workspace uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select from ss.operation_actors a join ss.workspaces w on w.id = a.workspace_id
    where a.workspace_id = p_workspace and w.tenant_id = p_tenant
      and a.workspace_id::text = current_setting('smartsell.operation_workspace', true)
      and a.transaction_id = pg_current_xact_id_if_assigned()
      and a.actor_id = ss.actor()
      and exists (select from pg_roles r where r.rolname = 'smartsell_background'
        and pg_has_role(session_user, r.oid, 'USAGE')))
$$;
