ALTER TABLE ss.memberships ADD COLUMN scopes text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT membership_brand_scopes CHECK (cardinality(scopes) = 0 OR role = 'viewer');

CREATE FUNCTION ss.lock_scoped_workspace(p_workspace uuid)
RETURNS TABLE(tenant_id uuid, role text, scopes text[]) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.tenant_id, m.role, m.scopes FROM ss.workspaces w JOIN ss.memberships m ON m.workspace_id = w.id
  WHERE w.id = p_workspace AND m.user_id = ss.actor() FOR SHARE OF m;
$$;

CREATE FUNCTION ss.scoped_members_for_actor(p_workspace uuid)
RETURNS TABLE(user_id uuid, role text, scopes text[]) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.user_id, m.role, m.scopes FROM ss.members_for_actor(p_workspace) a
  JOIN ss.memberships m ON m.workspace_id = p_workspace AND m.user_id = a.user_id ORDER BY m.user_id;
$$;

CREATE FUNCTION ss.change_membership(p_workspace uuid, p_member uuid, p_action text, p_role text, p_scopes text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor_role text;
BEGIN
  IF p_member = ss.actor() OR p_workspace IS DISTINCT FROM nullif(current_setting('smartsell.workspace_id', true), '')::uuid THEN
    RETURN false;
  END IF;
  SELECT role INTO actor_role FROM ss.memberships
  WHERE workspace_id = p_workspace AND user_id = ss.actor() FOR SHARE;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN RETURN false; END IF;
  PERFORM 1 FROM ss.memberships
  WHERE workspace_id = p_workspace AND user_id = p_member
    AND role <> 'owner' AND (actor_role = 'owner' OR role <> 'admin')
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_action = 'remove' THEN
    DELETE FROM ss.memberships WHERE workspace_id = p_workspace AND user_id = p_member;
  ELSIF p_action = 'set_role' AND p_role IN ('owner','admin','editor','reviewer','viewer')
    AND (actor_role = 'owner' OR p_role NOT IN ('owner','admin'))
    AND (p_scopes IS NULL OR cardinality(p_scopes) = 0 OR p_role = 'viewer') THEN
    UPDATE ss.memberships SET role = p_role, scopes = CASE WHEN p_role = 'viewer' THEN coalesce(p_scopes, scopes) ELSE '{}' END
    WHERE workspace_id = p_workspace AND user_id = p_member;
  ELSE RETURN false;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION ss.change_membership(p_workspace uuid, p_member uuid, p_action text, p_role text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT ss.change_membership(p_workspace, p_member, p_action, p_role, NULL::text[]);
$$;

REVOKE EXECUTE ON FUNCTION ss.lock_scoped_workspace(uuid), ss.scoped_members_for_actor(uuid),
  ss.change_membership(uuid,uuid,text,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.lock_scoped_workspace(uuid), ss.scoped_members_for_actor(uuid),
  ss.change_membership(uuid,uuid,text,text,text[]) TO smartsell_request;
