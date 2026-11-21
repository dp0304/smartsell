-- Maintenance needs active lease holders, without access to credential rows or tool scopes.
-- The definer is subject to FORCE RLS. This policy applies only inside the bound background scope.
CREATE POLICY operation_pat_lease_metadata ON ss.entities FOR SELECT TO CURRENT_USER
  USING (module = 'mcp_runtime' AND kind = 'credential' AND ss.in_operation_scope(tenant_id, workspace_id));

CREATE FUNCTION ss.operation_active_pat_holders(p_tenant uuid, p_workspace uuid)
RETURNS TABLE(id text, "actorId" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.id, m.user_id::text
  FROM ss.entities e JOIN ss.memberships m ON m.workspace_id = e.workspace_id AND m.user_id::text = e.data->>'actor_id'
  WHERE e.tenant_id = p_tenant AND e.workspace_id = p_workspace
    AND ss.in_operation_scope(p_tenant, p_workspace)
    AND e.module = 'mcp_runtime' AND e.kind = 'credential'
    AND e.data->'revoked' IS DISTINCT FROM 'true'::jsonb
    AND e.data->'workspace_removed' IS DISTINCT FROM 'true'::jsonb
    AND jsonb_typeof(e.data->'expires') = 'number'
    AND e.data->'expires' > to_jsonb(extract(epoch FROM statement_timestamp()) * 1000)
$$;

REVOKE EXECUTE ON FUNCTION ss.operation_active_pat_holders(uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'smartsell_background') THEN
    GRANT EXECUTE ON FUNCTION ss.operation_active_pat_holders(uuid, uuid) TO smartsell_background;
  END IF;
END $$;
