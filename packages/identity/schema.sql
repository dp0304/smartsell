CREATE SCHEMA IF NOT EXISTS ss_identity;
REVOKE ALL ON SCHEMA ss_identity FROM PUBLIC;

CREATE TABLE IF NOT EXISTS ss_identity.state (
  key text PRIMARY KEY,
  version text NOT NULL,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS ss_identity.flow (
  key text PRIMARY KEY,
  binding text NOT NULL,
  expires_at timestamptz NOT NULL,
  value jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS identity_flow_expiry ON ss_identity.flow (expires_at);
