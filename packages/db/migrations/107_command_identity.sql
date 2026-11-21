-- Commands owns this state. Standalone Operations uses its own identity schema.
CREATE TABLE ss.command_identity_state (
  key text PRIMARY KEY,
  version text NOT NULL,
  value jsonb NOT NULL
);

CREATE TABLE ss.command_identity_flow (
  key text PRIMARY KEY,
  binding text NOT NULL,
  expires_at timestamptz NOT NULL,
  value jsonb NOT NULL
);
CREATE INDEX command_identity_flow_expiry ON ss.command_identity_flow (expires_at);

CREATE TABLE ss.command_identity_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES ss.users(id),
  action text NOT NULL CHECK (action IN ('enroll','confirm','revoke','recovery_revoke','login_totp','login_recovery')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

-- Recheck the credential of the account in the challenge without granting access to ss.users.
CREATE FUNCTION ss.command_identity_password_hash(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT password_hash FROM ss.users WHERE id = p_user;
$$;

CREATE FUNCTION ss.command_identity_put_flow(p_key text, p_binding text, p_expires_at timestamptz, p_value jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  -- A completion transaction may hold a flow row while waiting for an account lock.
  DELETE FROM ss.command_identity_flow WHERE key IN (
    SELECT key FROM ss.command_identity_flow WHERE expires_at <= statement_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  INSERT INTO ss.command_identity_flow (key, binding, expires_at, value) VALUES (p_key, p_binding, p_expires_at, p_value);
$$;

REVOKE ALL ON ss.command_identity_state, ss.command_identity_flow, ss.command_identity_audit FROM PUBLIC, smartsell_request;
GRANT SELECT, INSERT ON ss.command_identity_state TO smartsell_request;
GRANT UPDATE (version, value) ON ss.command_identity_state TO smartsell_request;
GRANT SELECT, DELETE ON ss.command_identity_flow TO smartsell_request;
GRANT INSERT (user_id, action) ON ss.command_identity_audit TO smartsell_request;

REVOKE ALL ON FUNCTION ss.command_identity_password_hash(uuid), ss.command_identity_put_flow(text,text,timestamptz,jsonb)
  FROM PUBLIC, smartsell_request;
GRANT EXECUTE ON FUNCTION ss.command_identity_password_hash(uuid), ss.command_identity_put_flow(text,text,timestamptz,jsonb)
  TO smartsell_request;
