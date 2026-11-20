CREATE FUNCTION ss.change_membership(p_workspace uuid, p_member uuid, p_action text, p_role text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor_role text;
  target_role text;
BEGIN
  IF p_member = ss.actor() OR p_workspace IS DISTINCT FROM nullif(current_setting('smartsell.workspace_id', true), '')::uuid THEN
    RETURN false;
  END IF;
  SELECT role INTO actor_role FROM ss.memberships WHERE workspace_id = p_workspace AND user_id = ss.actor();
  IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN RETURN false; END IF;
  SELECT role INTO target_role FROM ss.memberships WHERE workspace_id = p_workspace AND user_id = p_member FOR UPDATE;
  IF target_role IS NULL OR target_role = 'owner' OR (actor_role = 'admin' AND target_role = 'admin') THEN RETURN false; END IF;
  IF p_action = 'remove' THEN
    DELETE FROM ss.memberships WHERE workspace_id = p_workspace AND user_id = p_member;
    DELETE FROM ss.sessions WHERE user_id = p_member;
  ELSIF p_action = 'set_role' AND p_role IN ('owner','admin','editor','reviewer','viewer')
    AND (actor_role = 'owner' OR p_role NOT IN ('owner','admin')) THEN
    UPDATE ss.memberships SET role = p_role WHERE workspace_id = p_workspace AND user_id = p_member;
  ELSE RETURN false;
  END IF;
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION ss.change_membership(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.change_membership(uuid,uuid,text,text) TO smartsell_request;
