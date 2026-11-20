CREATE TABLE ss.member_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ss.workspaces,
  invited_by uuid NOT NULL REFERENCES ss.users,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','editor','reviewer','viewer')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);

CREATE FUNCTION ss.members_for_actor(p_workspace uuid)
RETURNS TABLE(user_id uuid, role text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.user_id, m.role FROM ss.memberships m
  WHERE m.workspace_id = p_workspace AND EXISTS (
    SELECT FROM ss.memberships a WHERE a.workspace_id = p_workspace AND a.user_id = ss.actor()
  ) ORDER BY m.user_id;
$$;

CREATE FUNCTION ss.invite_member(p_workspace uuid, p_id uuid, p_email text, p_role text, p_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor_role text;
BEGIN
  SELECT role INTO actor_role FROM ss.memberships
  WHERE workspace_id = p_workspace AND user_id = ss.actor() FOR SHARE;
  IF actor_role IS NULL OR p_role IS NULL OR p_role NOT IN ('admin','editor','reviewer','viewer')
    OR NOT (actor_role = 'owner' OR (actor_role = 'admin' AND p_role <> 'admin')) THEN
    RETURN 'forbidden';
  END IF;
  IF EXISTS (SELECT FROM ss.users WHERE email = p_email) THEN RETURN 'account_exists'; END IF;
  INSERT INTO ss.member_invitations (id, workspace_id, invited_by, email, role, token_hash, expires_at)
  VALUES (p_id, p_workspace, ss.actor(), p_email, p_role, p_hash, statement_timestamp() + interval '7 days');
  RETURN 'created';
END;
$$;

CREATE FUNCTION ss.accept_member_invitation(p_hash text, p_email text, p_name text, p_password_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  invitation ss.member_invitations%ROWTYPE;
  actor_role text;
  uid uuid;
BEGIN
  SELECT * INTO invitation FROM ss.member_invitations
  WHERE token_hash = p_hash AND email = p_email AND accepted_at IS NULL AND expires_at > statement_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT role INTO actor_role FROM ss.memberships
  WHERE workspace_id = invitation.workspace_id AND user_id = invitation.invited_by FOR SHARE;
  IF actor_role IS NULL OR NOT (actor_role = 'owner' OR (actor_role = 'admin' AND invitation.role <> 'admin')) THEN
    RETURN false;
  END IF;
  INSERT INTO ss.users (email, name, password_hash) VALUES (p_email, p_name, p_password_hash)
  ON CONFLICT (email) DO NOTHING RETURNING id INTO uid;
  IF uid IS NULL THEN RETURN false; END IF;
  INSERT INTO ss.memberships (workspace_id, user_id, role) VALUES (invitation.workspace_id, uid, invitation.role);
  UPDATE ss.member_invitations SET accepted_at = statement_timestamp() WHERE id = invitation.id;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION ss.members_for_actor(uuid), ss.invite_member(uuid,uuid,text,text,text),
  ss.accept_member_invitation(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.members_for_actor(uuid), ss.invite_member(uuid,uuid,text,text,text),
  ss.accept_member_invitation(text,text,text,text) TO smartsell_request;
