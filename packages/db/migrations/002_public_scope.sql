CREATE TABLE ss.public_locators (
  locator text NOT NULL,
  id text NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (locator, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES ss.workspaces (tenant_id, id)
);
CREATE TABLE ss.public_actors (
  workspace_id uuid PRIMARY KEY REFERENCES ss.workspaces,
  actor_id uuid NOT NULL UNIQUE REFERENCES ss.users
);

CREATE FUNCTION ss.index_public_locator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE locator text := NEW.module || '.' || NEW.kind;
BEGIN
  IF locator IN ('team.share','traffic.landing_page','traffic.short_link','lifecycle.unsubscribe_link')
    AND NEW.id ~ '^[A-Za-z0-9_-]{32}$' THEN
    INSERT INTO ss.public_locators VALUES (locator, NEW.id, NEW.tenant_id, NEW.workspace_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION ss.index_public_locator() FROM PUBLIC;
CREATE TRIGGER index_public_locator AFTER INSERT ON ss.entities FOR EACH ROW EXECUTE FUNCTION ss.index_public_locator();

CREATE FUNCTION ss.public_scope(p_locator text, p_id text)
RETURNS TABLE(tenant_id uuid, workspace_id uuid, actor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  found_locator ss.public_locators%ROWTYPE;
  service_actor uuid;
BEGIN
  SELECT * INTO found_locator FROM ss.public_locators l WHERE l.locator = p_locator AND l.id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT a.actor_id INTO service_actor FROM ss.public_actors a WHERE a.workspace_id = found_locator.workspace_id;
  IF NOT FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ss.public:' || found_locator.workspace_id, 0));
    SELECT a.actor_id INTO service_actor FROM ss.public_actors a WHERE a.workspace_id = found_locator.workspace_id;
    IF NOT FOUND THEN
      service_actor := gen_random_uuid();
      INSERT INTO ss.users VALUES (service_actor, 'service:' || service_actor, 'Public link service', '!');
      INSERT INTO ss.public_actors VALUES (found_locator.workspace_id, service_actor);
    END IF;
  END IF;
  RETURN QUERY SELECT found_locator.tenant_id, found_locator.workspace_id, service_actor;
END;
$$;
REVOKE EXECUTE ON FUNCTION ss.public_scope(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.public_scope(text,text) TO smartsell_request;

CREATE OR REPLACE FUNCTION ss.in_scope(p_tenant uuid, p_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p_tenant = nullif(current_setting('smartsell.tenant_id', true), '')::uuid
    AND p_workspace = nullif(current_setting('smartsell.workspace_id', true), '')::uuid
    AND EXISTS (SELECT FROM ss.workspaces w WHERE w.tenant_id = p_tenant AND w.id = p_workspace)
    AND (
      EXISTS (SELECT FROM ss.memberships m WHERE m.workspace_id = p_workspace AND m.user_id = ss.actor())
      OR EXISTS (SELECT FROM ss.public_actors a WHERE a.workspace_id = p_workspace AND a.actor_id = ss.actor())
    );
$$;
