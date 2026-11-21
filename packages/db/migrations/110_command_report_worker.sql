-- The transaction-bound Commands worker may read the inputs used by report generation.
CREATE POLICY command_report_inputs ON ss.entities FOR SELECT TO smartsell_request
  USING (ss.in_operation_scope(tenant_id, workspace_id) AND (
    (module = 'analytics' AND kind IN ('report', 'report_version', 'metric_definition_revision', 'metric_observation', 'fx_rate', 'attribution_model', 'attribution_evidence')) OR
    (module = 'core' AND kind = 'fx_rate') OR
    (module = 'execution' AND kind = 'platform_post') OR
    (module = 'ingest' AND kind IN ('data_source', 'data_gap', 'coverage_segment', 'sync_run', 'import_batch', 'import_row', 'raw_record', 'raw_record_tombstone')) OR
    (module = 'commerce' AND kind IN ('order', 'refund', 'payment_transaction', 'coverage_segment', 'import_batch', 'discount_usage', 'promotion')) OR
    (module = 'traffic' AND kind IN ('short_link', 'short_link_revision', 'click_event', 'touchpoint_event'))
  ));

CREATE POLICY command_report_version_write ON ss.entities FOR INSERT TO smartsell_request
  WITH CHECK (ss.in_operation_scope(tenant_id, workspace_id) AND module = 'analytics' AND kind = 'report_version');

CREATE POLICY command_report_counter_write ON ss.entities FOR UPDATE TO smartsell_request
  USING (ss.in_operation_scope(tenant_id, workspace_id) AND module = 'analytics' AND kind = 'report')
  WITH CHECK (ss.in_operation_scope(tenant_id, workspace_id) AND module = 'analytics' AND kind = 'report');

CREATE POLICY command_report_event_write ON ss.events FOR INSERT TO smartsell_request
  WITH CHECK (ss.in_operation_scope(tenant_id, workspace_id)
    AND name IN ('analytics.report_version.ready', 'analytics.report_version.failed'));

-- The composite foreign key limits outbox inserts to events in the same workspace.
CREATE POLICY command_report_outbox_write ON ss.outbox FOR INSERT TO smartsell_request
  WITH CHECK (ss.in_operation_scope(tenant_id, workspace_id));
