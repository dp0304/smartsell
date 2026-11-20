CREATE TABLE ss.operation_actors (
  workspace_id uuid PRIMARY KEY REFERENCES ss.workspaces,
  actor_id uuid NOT NULL UNIQUE REFERENCES ss.users,
  transaction_id xid8 NOT NULL
);

CREATE FUNCTION ss.operation_workspaces() RETURNS TABLE(id uuid, "tenantId" uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.id, w.tenant_id, w.name FROM ss.workspaces w ORDER BY w.id
$$;

-- The scope is transaction-local and reserved for the Operation record store.
CREATE FUNCTION ss.lock_operation_workspace(p_workspace uuid)
RETURNS TABLE(tenant_id uuid, actor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tenant uuid;
  agent uuid;
BEGIN
  SELECT w.tenant_id INTO tenant FROM ss.workspaces w WHERE w.id = p_workspace;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ss.operation:' || p_workspace, 0));
  SELECT a.actor_id INTO agent FROM ss.operation_actors a WHERE a.workspace_id = p_workspace;
  IF NOT FOUND THEN
    agent := gen_random_uuid();
    INSERT INTO ss.users VALUES (agent, 'operation:' || agent, 'Operation background service', '!');
    INSERT INTO ss.operation_actors VALUES (p_workspace, agent, pg_current_xact_id());
  ELSE
    UPDATE ss.operation_actors SET transaction_id = pg_current_xact_id() WHERE workspace_id = p_workspace;
  END IF;
  PERFORM set_config('smartsell.operation_workspace', p_workspace::text, true);
  PERFORM set_config('smartsell.tenant_id', tenant::text, true);
  PERFORM set_config('smartsell.workspace_id', p_workspace::text, true);
  RETURN QUERY SELECT tenant, agent;
END;
$$;

CREATE FUNCTION ss.operation_members(p_workspace uuid) RETURNS TABLE("userId" uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.user_id, m.role FROM ss.memberships m
  WHERE m.workspace_id = p_workspace AND EXISTS (SELECT FROM ss.operation_actors a
    WHERE a.workspace_id = p_workspace AND a.actor_id = ss.actor())
$$;

CREATE OR REPLACE FUNCTION ss.scope_actor() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN nullif(current_setting('smartsell.session_hash', true), '') IS NOT NULL THEN (
    SELECT s.user_id FROM ss.sessions s WHERE s.token_hash = current_setting('smartsell.session_hash', true)
      AND s.expires_at > transaction_timestamp()
  ) WHEN nullif(current_setting('smartsell.operation_workspace', true), '') IS NOT NULL THEN (
    SELECT a.actor_id FROM ss.operation_actors a WHERE a.workspace_id::text = current_setting('smartsell.operation_workspace', true)
      AND a.transaction_id = pg_current_xact_id_if_assigned()
  ) ELSE (
    SELECT a.actor_id FROM ss.public_locators l JOIN ss.public_actors a USING (workspace_id)
    WHERE l.locator = current_setting('smartsell.public_locator', true) AND l.id = current_setting('smartsell.public_id', true)
  ) END
$$;

CREATE FUNCTION ss.in_operation_scope(p_tenant uuid, p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM ss.operation_actors a JOIN ss.workspaces w ON w.id = a.workspace_id
    WHERE a.workspace_id = p_workspace AND w.tenant_id = p_tenant AND a.actor_id = ss.actor())
$$;

CREATE POLICY operation_records ON ss.entities TO smartsell_request
  USING (module = 'operation_runtime' AND kind IN ('record','revision') AND ss.in_operation_scope(tenant_id, workspace_id));
CREATE POLICY operation_idempotency ON ss.idempotency TO smartsell_request
  USING (actor_id = ss.actor() AND ss.in_operation_scope(tenant_id, workspace_id));
CREATE POLICY operation_audit ON ss.audit TO smartsell_request
  USING (actor_id = ss.actor() AND module = 'operation_runtime' AND ss.in_operation_scope(tenant_id, workspace_id));

REVOKE EXECUTE ON FUNCTION ss.operation_workspaces(), ss.lock_operation_workspace(uuid), ss.operation_members(uuid), ss.in_operation_scope(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.operation_workspaces(), ss.lock_operation_workspace(uuid), ss.operation_members(uuid), ss.in_operation_scope(uuid,uuid) TO smartsell_request;
