CREATE SCHEMA ss;
REVOKE ALL ON SCHEMA ss FROM PUBLIC;
GRANT USAGE ON SCHEMA ss TO smartsell_request;

CREATE TABLE ss.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL
);
CREATE TABLE ss.tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE ss.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES ss.tenants,
  name text NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE TABLE ss.memberships (
  workspace_id uuid REFERENCES ss.workspaces,
  user_id uuid REFERENCES ss.users,
  role text NOT NULL CHECK (role IN ('owner','admin','editor','reviewer','viewer')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE ss.sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ss.users,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON ss.sessions (expires_at);
CREATE TABLE ss.initialized (singleton boolean PRIMARY KEY CHECK (singleton));

CREATE FUNCTION ss.bootstrap(p_email text, p_name text, p_password text, p_workspace text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  uid uuid;
  tid uuid;
  wid uuid;
BEGIN
  INSERT INTO ss.initialized VALUES (true) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT FROM ss.memberships WHERE role = 'owner') THEN RETURN NULL; END IF;
  INSERT INTO ss.users(email, name, password_hash) VALUES (p_email, p_name, p_password) RETURNING id INTO uid;
  INSERT INTO ss.tenants DEFAULT VALUES RETURNING id INTO tid;
  INSERT INTO ss.workspaces(tenant_id, name) VALUES (tid, p_workspace) RETURNING id INTO wid;
  INSERT INTO ss.memberships VALUES (wid, uid, 'owner');
  RETURN uid;
END;
$$;

CREATE FUNCTION ss.credentials(p_email text)
RETURNS TABLE(id uuid, password_hash text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT id, password_hash FROM ss.users WHERE email = p_email;
$$;
CREATE FUNCTION ss.issue_session(p_token text, p_user uuid, p_replace text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  DELETE FROM ss.sessions WHERE token_hash = p_replace;
  DELETE FROM ss.sessions WHERE token_hash IN (
    SELECT token_hash FROM ss.sessions WHERE expires_at <= statement_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  INSERT INTO ss.sessions VALUES (p_token, p_user, statement_timestamp() + interval '12 hours');
$$;
CREATE FUNCTION ss.revoke_session(p_token text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  DELETE FROM ss.sessions WHERE token_hash = p_token;
$$;
CREATE FUNCTION ss.session_user(p_token text)
RETURNS TABLE(id uuid, email text, name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT u.id, u.email, u.name FROM ss.sessions s JOIN ss.users u ON u.id = s.user_id
  WHERE s.token_hash = p_token AND s.expires_at > statement_timestamp();
$$;
CREATE FUNCTION ss.actor()
RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('smartsell.actor_id', true), '')::uuid;
$$;
CREATE FUNCTION ss.workspaces_for_actor()
RETURNS TABLE(id uuid, name text, role text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT w.id, w.name, m.role FROM ss.workspaces w JOIN ss.memberships m ON m.workspace_id = w.id
  WHERE m.user_id = ss.actor() ORDER BY w.name, w.id;
$$;
CREATE FUNCTION ss.lock_workspace(p_workspace uuid)
RETURNS TABLE(tenant_id uuid, role text) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT w.tenant_id, m.role FROM ss.workspaces w JOIN ss.memberships m ON m.workspace_id = w.id
  WHERE w.id = p_workspace AND m.user_id = ss.actor() FOR SHARE OF m;
$$;
CREATE FUNCTION ss.in_scope(p_tenant uuid, p_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p_tenant = nullif(current_setting('smartsell.tenant_id', true), '')::uuid
    AND p_workspace = nullif(current_setting('smartsell.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT FROM ss.memberships m JOIN ss.workspaces w ON w.id = m.workspace_id
      WHERE w.tenant_id = p_tenant AND w.id = p_workspace AND m.user_id = ss.actor()
    );
$$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ss FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ss TO smartsell_request;

CREATE TABLE ss.entities (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  module text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, module, kind, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES ss.workspaces (tenant_id, id)
);
CREATE INDEX entities_read ON ss.entities (tenant_id, workspace_id, module, kind, created_at, id);
CREATE TABLE ss.idempotency (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES ss.users,
  key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, actor_id, key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES ss.workspaces (tenant_id, id)
);
CREATE TABLE ss.audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES ss.users,
  role text NOT NULL,
  module text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES ss.workspaces (tenant_id, id)
);
CREATE TABLE ss.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  audit_id uuid NOT NULL,
  ordinal integer NOT NULL,
  name text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, audit_id, ordinal),
  FOREIGN KEY (tenant_id, workspace_id, audit_id) REFERENCES ss.audit (tenant_id, workspace_id, id)
);
CREATE TABLE ss.outbox (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  available_at timestamptz NOT NULL,
  delivered_at timestamptz,
  FOREIGN KEY (tenant_id, workspace_id, event_id) REFERENCES ss.events (tenant_id, workspace_id, id)
);
CREATE INDEX outbox_pending ON ss.outbox (available_at, event_id) WHERE delivered_at IS NULL;

ALTER TABLE ss.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ss.entities FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON ss.entities TO smartsell_request USING (ss.in_scope(tenant_id, workspace_id));
ALTER TABLE ss.idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE ss.idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_scope ON ss.idempotency TO smartsell_request
  USING (ss.in_scope(tenant_id, workspace_id) AND actor_id = ss.actor());
ALTER TABLE ss.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ss.audit FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_scope ON ss.audit TO smartsell_request
  USING (ss.in_scope(tenant_id, workspace_id) AND actor_id = ss.actor());
ALTER TABLE ss.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ss.events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON ss.events TO smartsell_request USING (ss.in_scope(tenant_id, workspace_id));
ALTER TABLE ss.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ss.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON ss.outbox TO smartsell_request USING (ss.in_scope(tenant_id, workspace_id));

GRANT SELECT, INSERT ON ss.entities, ss.idempotency TO smartsell_request;
GRANT UPDATE (data, version, updated_at) ON ss.entities TO smartsell_request;
GRANT UPDATE (response) ON ss.idempotency TO smartsell_request;
GRANT INSERT ON ss.audit, ss.events, ss.outbox TO smartsell_request;
