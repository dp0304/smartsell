-- Only loaded into an isolated smoke project, after HTTP first-run setup.
WITH fixture(kind, id, fields) AS (VALUES
  ('social_account', '00000000-0000-4000-8000-000000000001', '{"provider":"meta_facebook","status":"active"}'::jsonb),
  ('publish_target', '00000000-0000-4000-8000-000000000002', '{"plan_status":"ready"}'),
  ('execution_task', '00000000-0000-4000-8000-000000000003', '{"status":"outcome_unknown","attempt_count":1,"fencing_token":1,"publish_target_id":"00000000-0000-4000-8000-000000000002","social_account_id":"00000000-0000-4000-8000-000000000001"}'),
  ('execution_attempt', '00000000-0000-4000-8000-000000000004', '{"status":"unknown","attempt_no":1,"executor":"official","side_effect_possible":true,"task_id":"00000000-0000-4000-8000-000000000003"}'),
  ('file_object', '00000000-0000-4000-8000-000000000005', '{"purpose":"evidence","scan_status":"clean"}')
)
INSERT INTO ss.entities (tenant_id, workspace_id, module, kind, id, data, created_at, updated_at)
SELECT w.tenant_id, w.id, 'operation_runtime', 'record', 'row/' || f.kind || '/' || f.id,
       jsonb_build_object('value', (f.fields || jsonb_build_object('id', f.id, 'version', 1, 'created_at', now(), 'updated_at', now()))::text), now(), now()
  FROM ss.workspaces w CROSS JOIN fixture f
 WHERE w.name = 'Ops Smoke';
