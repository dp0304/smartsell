-- Derive the RLS actor from the session or public locator presented by the request.
-- Tenant and workspace settings remain selectors, never proof of membership.
CREATE FUNCTION ss.scope_actor() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN nullif(current_setting('smartsell.session_hash', true), '') IS NOT NULL THEN (
    SELECT s.user_id FROM ss.sessions s
    WHERE s.token_hash = current_setting('smartsell.session_hash', true)
      AND s.expires_at > transaction_timestamp()
  ) ELSE (
    SELECT a.actor_id FROM ss.public_locators l JOIN ss.public_actors a USING (workspace_id)
    WHERE l.locator = current_setting('smartsell.public_locator', true)
      AND l.id = current_setting('smartsell.public_id', true)
  ) END;
$$;
REVOKE EXECUTE ON FUNCTION ss.scope_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.scope_actor() TO smartsell_request;

CREATE OR REPLACE FUNCTION ss.actor() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ss.scope_actor();
$$;

ALTER FUNCTION ss.bootstrap(text,text,text,text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.credentials(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.issue_session(text,uuid,text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.revoke_session(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.session_user(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.workspaces_for_actor() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.lock_workspace(uuid) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.in_scope(uuid,uuid) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.index_public_locator() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.public_scope(text,text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION ss.change_membership(uuid,uuid,text,text) SET search_path = pg_catalog, pg_temp;
