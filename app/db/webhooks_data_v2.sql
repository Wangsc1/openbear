-- Immutable v1 is deliberately untouched. This is a statistics projection,
-- never an additional charging ledger: one row per original physical call.
CREATE TABLE webhook_call_projections (
  model_call_id INTEGER PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES webhook_assignments(assignment_id),
  created_at REAL NOT NULL,
  usage_known INTEGER,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd REAL,
  cost_source TEXT NOT NULL DEFAULT 'unclassified',
  ledger_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX webhook_call_projection_assignment ON webhook_call_projections(assignment_id,created_at);
CREATE INDEX webhook_call_projection_attempt ON webhook_call_projections(attempt_id);
INSERT INTO webhook_call_projections(model_call_id,attempt_id,assignment_id,created_at,usage_known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,cost_source)
SELECT m.id,m.attempt_id,l.assignment_id,m.created_at,m.usage_known,m.input_tokens,m.output_tokens,m.cache_read_tokens,m.cache_write_tokens,m.cost_usd,
  CASE WHEN m.cost_usd IS NULL THEN 'unknown'
       WHEN json_extract(r.outcome_json,'$.providerCostUsd') IS NOT NULL THEN 'providerReported'
       WHEN json_extract(r.outcome_json,'$.usageKnown')=1 THEN 'estimated' ELSE 'unclassified' END
FROM model_calls m JOIN runtime_actions r ON r.action_id=m.attempt_id
JOIN webhook_runtime_links l USING(run_id) WHERE l.billing_scope='origin_webhook';
CREATE TRIGGER webhook_project_model_call AFTER INSERT ON model_calls BEGIN
  INSERT INTO webhook_call_projections(model_call_id,attempt_id,assignment_id,created_at,usage_known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,cost_source)
  SELECT NEW.id,NEW.attempt_id,l.assignment_id,NEW.created_at,NEW.usage_known,NEW.input_tokens,NEW.output_tokens,NEW.cache_read_tokens,NEW.cache_write_tokens,NEW.cost_usd,
    CASE WHEN NEW.cost_usd IS NULL THEN 'unknown'
         WHEN json_extract(r.outcome_json,'$.providerCostUsd') IS NOT NULL THEN 'providerReported'
         WHEN json_extract(r.outcome_json,'$.usageKnown')=1 THEN 'estimated' ELSE 'unclassified' END
  FROM runtime_actions r JOIN webhook_runtime_links l USING(run_id)
  WHERE r.action_id=NEW.attempt_id AND l.billing_scope='origin_webhook';
END;
CREATE TRIGGER webhook_project_model_call_update AFTER UPDATE ON model_calls BEGIN
  UPDATE webhook_call_projections SET created_at=NEW.created_at,usage_known=NEW.usage_known,input_tokens=NEW.input_tokens,output_tokens=NEW.output_tokens,
    cache_read_tokens=NEW.cache_read_tokens,cache_write_tokens=NEW.cache_write_tokens,cost_usd=NEW.cost_usd,
    cost_source=CASE WHEN NEW.cost_usd IS NULL THEN 'unknown'
      WHEN (SELECT json_extract(outcome_json,'$.providerCostUsd') FROM runtime_actions WHERE action_id=NEW.attempt_id) IS NOT NULL THEN 'providerReported'
      WHEN (SELECT json_extract(outcome_json,'$.usageKnown') FROM runtime_actions WHERE action_id=NEW.attempt_id)=1 THEN 'estimated' ELSE 'unclassified' END
    WHERE model_call_id=OLD.id;
END;
CREATE TRIGGER webhook_project_cost_source AFTER UPDATE OF outcome_json ON runtime_actions BEGIN
  UPDATE webhook_call_projections SET cost_source=CASE WHEN cost_usd IS NULL THEN 'unknown'
    WHEN json_extract(NEW.outcome_json,'$.providerCostUsd') IS NOT NULL THEN 'providerReported'
    WHEN json_extract(NEW.outcome_json,'$.usageKnown')=1 THEN 'estimated' ELSE 'unclassified' END
    WHERE attempt_id=NEW.action_id;
END;
CREATE TRIGGER webhook_project_model_call_delete BEFORE DELETE ON model_calls BEGIN
  UPDATE webhook_call_projections SET ledger_deleted=1 WHERE model_call_id=OLD.id;
END;
-- Exact loss ranges remain independently of the data they describe.
CREATE TABLE webhook_retention_gaps (
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id),
  kind TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  PRIMARY KEY(endpoint_id,kind,start_ms,end_ms)
);
ALTER TABLE webhook_telemetry_operations ADD COLUMN revision INTEGER;
ALTER TABLE webhook_telemetry_operations ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
UPDATE webhook_telemetry_operations SET revision=COALESCE(
 (SELECT j.revision FROM webhook_stage_attempts t JOIN webhook_stage_jobs j USING(job_id) WHERE t.attempt_id=stage_attempt_id),
 (SELECT e.processing_revision FROM webhook_events e WHERE e.event_id=webhook_telemetry_operations.event_id),
 (SELECT a.origin_revision FROM webhook_assignments a WHERE a.assignment_id=webhook_telemetry_operations.assignment_id)),
 is_test=CASE WHEN EXISTS(SELECT 1 FROM webhook_events e WHERE e.event_id=webhook_telemetry_operations.event_id AND e.is_test=1)
 OR EXISTS(SELECT 1 FROM webhook_assignment_events m JOIN webhook_events e USING(event_id) WHERE m.assignment_id=webhook_telemetry_operations.assignment_id AND e.is_test=1) THEN 1 ELSE 0 END;
-- v1 did not record loss intervals. Retained operation identities can prove a
-- possible historical gap, not that the whole interval had zero observations.
INSERT OR IGNORE INTO webhook_retention_gaps
SELECT endpoint_id,'legacy_unknown',MIN(created_at_ms),MAX(MAX(created_at_ms)+1,CAST(strftime('%s','now') AS INTEGER)*1000)
FROM webhook_telemetry_operations o
WHERE endpoint_id IS NOT NULL AND state='applied'
  AND ((source!='framework' AND payload_json IS NULL)
       OR (source='framework' AND NOT EXISTS(SELECT 1 FROM webhook_metric_samples s WHERE s.telemetry_id=o.telemetry_id)
           AND NOT EXISTS(SELECT 1 FROM webhook_metric_rollups r JOIN webhook_metric_series se USING(series_id)
                          WHERE se.endpoint_id=o.endpoint_id AND r.bucket_start_ms<=o.created_at_ms AND r.bucket_start_ms+r.resolution_seconds*1000>o.created_at_ms)))
GROUP BY endpoint_id;
CREATE INDEX webhook_business_field_null ON webhook_business_fields(endpoint_id,field_name,observed_at_ms,record_id) WHERE value_type='null';
