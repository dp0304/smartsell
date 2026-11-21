-- The locator trigger covers new rows. Backfill rows that predate it.
-- The migration transaction holds the table lock until FORCE RLS is restored.
ALTER TABLE ss.entities NO FORCE ROW LEVEL SECURITY;
INSERT INTO ss.public_locators (locator, id, tenant_id, workspace_id)
SELECT e.module || '.' || e.kind, e.id, e.tenant_id, e.workspace_id
FROM ss.entities e
WHERE (e.module || '.' || e.kind) IN ('team.share','traffic.landing_page','traffic.short_link','lifecycle.unsubscribe_link')
  AND e.id ~ '^[A-Za-z0-9_-]{32}$'
  AND NOT EXISTS (
    SELECT FROM ss.public_locators l
    WHERE l.locator = e.module || '.' || e.kind AND l.id = e.id
      AND l.tenant_id = e.tenant_id AND l.workspace_id = e.workspace_id
  );
ALTER TABLE ss.entities FORCE ROW LEVEL SECURITY;

CREATE INDEX sessions_user ON ss.sessions (user_id);

CREATE OR REPLACE FUNCTION ss.change_membership(p_workspace uuid, p_member uuid, p_action text, p_role text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor_role text;
BEGIN
  IF p_member = ss.actor() OR p_workspace IS DISTINCT FROM nullif(current_setting('smartsell.workspace_id', true), '')::uuid THEN
    RETURN false;
  END IF;
  -- Hold the actor's authorization through the update even without lock_workspace().
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
    DELETE FROM ss.sessions WHERE user_id = p_member;
  ELSIF p_action = 'set_role' AND p_role IN ('owner','admin','editor','reviewer','viewer')
    AND (actor_role = 'owner' OR p_role NOT IN ('owner','admin')) THEN
    UPDATE ss.memberships SET role = p_role WHERE workspace_id = p_workspace AND user_id = p_member;
  ELSE RETURN false;
  END IF;
  RETURN true;
END;
$$;
