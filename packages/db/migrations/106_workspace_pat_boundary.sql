-- A member's session belongs to the user, not to an individual workspace.
CREATE OR REPLACE FUNCTION ss.change_membership(p_workspace uuid, p_member uuid, p_action text, p_role text)
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
    AND (actor_role = 'owner' OR p_role NOT IN ('owner','admin')) THEN
    UPDATE ss.memberships SET role = p_role WHERE workspace_id = p_workspace AND user_id = p_member;
  ELSE RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- Permit credential validation before workspace admission. This grants only reads of
-- the authenticated session user's own MCP credential metadata, even after removal.
CREATE POLICY personal_mcp_credential ON ss.entities FOR SELECT TO smartsell_request
  USING (module = 'mcp_runtime' AND kind = 'credential'
    AND id = current_setting('smartsell.mcp_credential_id', true)
    AND workspace_id::text = current_setting('smartsell.mcp_workspace_id', true)
    AND data->>'actor_id' IN (
    SELECT id::text FROM ss.session_user(current_setting('smartsell.session_hash', true))
  ));
