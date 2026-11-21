ALTER TABLE ss.users ADD COLUMN username text COLLATE "C" UNIQUE;

CREATE FUNCTION ss.is_initialized() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM ss.initialized)
      OR EXISTS (SELECT FROM ss.users)
      OR EXISTS (SELECT FROM ss.workspaces);
$$;

CREATE FUNCTION ss.bootstrap(p_email text, p_name text, p_password text, p_workspace text, p_username text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  uid uuid := gen_random_uuid();
  tid uuid;
  wid uuid;
BEGIN
  INSERT INTO ss.initialized VALUES (true) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT FROM ss.users) OR EXISTS (SELECT FROM ss.workspaces) THEN RETURN NULL; END IF;
  -- Keep the existing non-null email projection. Username-only accounts have no deliverable email.
  INSERT INTO ss.users(id, email, name, password_hash, username)
    VALUES (uid, coalesce(p_email, 'username:' || uid), p_name, p_password, p_username);
  INSERT INTO ss.tenants DEFAULT VALUES RETURNING id INTO tid;
  INSERT INTO ss.workspaces(tenant_id, name) VALUES (tid, p_workspace) RETURNING id INTO wid;
  INSERT INTO ss.memberships VALUES (wid, uid, 'owner');
  RETURN uid;
END;
$$;

CREATE OR REPLACE FUNCTION ss.bootstrap(p_email text, p_name text, p_password text, p_workspace text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT ss.bootstrap(p_email, p_name, p_password, p_workspace, NULL);
$$;

CREATE FUNCTION ss.username_credentials(p_username text)
RETURNS TABLE(id uuid, password_hash text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT id, password_hash FROM ss.users WHERE username = p_username COLLATE "C";
$$;

REVOKE EXECUTE ON FUNCTION ss.is_initialized(), ss.bootstrap(text,text,text,text,text), ss.username_credentials(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.is_initialized(), ss.bootstrap(text,text,text,text,text), ss.username_credentials(text) TO smartsell_request;
