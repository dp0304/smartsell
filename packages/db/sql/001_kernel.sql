CREATE SCHEMA IF NOT EXISTS smartsell;

CREATE TABLE smartsell.identity (
  id text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE smartsell.record (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, id)
);

ALTER TABLE smartsell.record ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartsell.record FORCE ROW LEVEL SECURITY;
CREATE POLICY record_scope ON smartsell.record AS RESTRICTIVE TO app_rw
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND workspace_id = ANY(nullif(current_setting('app.workspace_ids', true), '')::uuid[])
    AND nullif(current_setting('app.principal', true), '') IS NOT NULL
  );
CREATE POLICY record_read ON smartsell.record FOR SELECT TO app_rw USING (true);
CREATE POLICY record_insert ON smartsell.record FOR INSERT TO app_rw WITH CHECK (true);
CREATE POLICY record_update ON smartsell.record FOR UPDATE TO app_rw
  USING (id NOT LIKE 'audit/%') WITH CHECK (id NOT LIKE 'audit/%');
CREATE POLICY record_delete ON smartsell.record FOR DELETE TO app_rw USING (id NOT LIKE 'audit/%');

GRANT USAGE ON SCHEMA smartsell TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON smartsell.identity, smartsell.record TO app_rw;
