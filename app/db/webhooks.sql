-- Webhook v1: applied atomically under the shared FK-enabled writer gate.
CREATE TABLE webhook_endpoints (
  endpoint_id TEXT NOT NULL PRIMARY KEY,
  owner_chat_id INTEGER NOT NULL, -- soft reference to the authenticated owner
  binding_kind TEXT NOT NULL CHECK(binding_kind IN ('folder','conversation')),
  binding_uuid TEXT NOT NULL, -- soft reference: web_conversation_folders / web_conversations
  create_request_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), -- manual all-stage pause only
  pause_reason TEXT, -- manual reason only, NOT the aggregate effective blocker
  dispatch_blockers_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(dispatch_blockers_json) AND json_type(dispatch_blockers_json)='object'),
  model_blockers_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(model_blockers_json) AND json_type(model_blockers_json)='object'),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK(control_version>=0),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK(current_revision>0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(owner_chat_id, create_request_id),
  FOREIGN KEY(endpoint_id,current_revision) REFERENCES webhook_revisions(endpoint_id,revision)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX webhook_endpoint_binding ON webhook_endpoints(owner_chat_id,binding_kind,binding_uuid)
  WHERE deleted_at_ms IS NULL;
CREATE INDEX webhook_endpoint_owner ON webhook_endpoints(owner_chat_id,deleted_at_ms,updated_at_ms,endpoint_id);

CREATE TABLE webhook_credentials (
  credential_id TEXT NOT NULL PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id),
  key_prefix TEXT NOT NULL, -- non-secret lookup/display identifier, never the Bearer value
  verifier BLOB NOT NULL, -- keyed digest of a high-entropy key; pepper stays outside DB
  verifier_algorithm TEXT NOT NULL,
  pepper_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  valid_from_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  replaced_by_id TEXT REFERENCES webhook_credentials(credential_id),
  UNIQUE(endpoint_id,key_prefix),
  CHECK(expires_at_ms IS NULL OR expires_at_ms>valid_from_ms)
);
CREATE INDEX webhook_credential_auth ON webhook_credentials(endpoint_id,revoked_at_ms,expires_at_ms);

CREATE TABLE webhook_revisions (
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id),
  revision INTEGER NOT NULL CHECK(revision>0),
  target_mode TEXT NOT NULL CHECK(target_mode IN ('newConversation','fixedConversation')),
  target_conversation_uuid TEXT, -- soft reference; NULL only for newConversation
  config_schema_version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json)='object'),
  config_sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(endpoint_id,revision),
  CHECK((target_mode='newConversation' AND target_conversation_uuid IS NULL) OR
        (target_mode='fixedConversation' AND target_conversation_uuid IS NOT NULL))
);
CREATE TRIGGER webhook_revision_immutable BEFORE UPDATE ON webhook_revisions BEGIN
  SELECT RAISE(ABORT,'immutable webhook revision');
END;

CREATE TABLE webhook_control_operations (
  operation_id TEXT NOT NULL PRIMARY KEY,
  owner_chat_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  endpoint_id TEXT REFERENCES webhook_endpoints(endpoint_id),
  action TEXT NOT NULL CHECK(action IN ('create','update','rotate_key','set_enabled','pause','resume','stop','delete','retry','rebind','resolve_match','recover')),
  request_sha256 TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  expected_version INTEGER,
  selection_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(selection_json)),
  result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(owner_chat_id,request_id)
);
CREATE INDEX webhook_control_endpoint ON webhook_control_operations(endpoint_id,created_at_ms,operation_id);

-- Small inbox identity survives payload expiry. receive_seq is the durable global cursor.
CREATE TABLE webhook_events (
  receive_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id),
  idempotency_key TEXT NOT NULL,
  identity_source TEXT NOT NULL CHECK(identity_source IN ('header','body','generated')),
  content_fingerprint TEXT NOT NULL,
  fingerprint_version INTEGER NOT NULL DEFAULT 1,
  received_revision INTEGER NOT NULL,
  processing_revision INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  source_at_ms INTEGER,
  expires_at_ms INTEGER,
  route_state TEXT NOT NULL DEFAULT 'pre' CHECK(route_state IN ('pre','eligible','batch','match_conflict','assigned','hold','terminal')),
  route_version INTEGER NOT NULL DEFAULT 0 CHECK(route_version>=0),
  aggregation_key TEXT,
  model_bytes INTEGER CHECK(model_bytes>=0),
  pre_completed_at_ms INTEGER,
  terminal_at_ms INTEGER,
  review_required INTEGER NOT NULL DEFAULT 0 CHECK(review_required IN (0,1)),
  terminal_reason TEXT,
  origin TEXT,
  correlation_id TEXT,
  acceptance_json TEXT NOT NULL CHECK(json_valid(acceptance_json)), -- original 202 receipt, no body/key
  is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0,1)),
  test_phase TEXT,
  notification_key TEXT, -- soft reference to web_task_notifications.notification_key
  UNIQUE(endpoint_id,idempotency_key),
  UNIQUE(event_id,endpoint_id),
  FOREIGN KEY(endpoint_id,received_revision) REFERENCES webhook_revisions(endpoint_id,revision),
  FOREIGN KEY(endpoint_id,processing_revision) REFERENCES webhook_revisions(endpoint_id,revision)
);
CREATE INDEX webhook_event_queue ON webhook_events(endpoint_id,route_state,receive_seq);
CREATE INDEX webhook_event_expiry ON webhook_events(expires_at_ms,receive_seq) WHERE terminal_at_ms IS NULL AND expires_at_ms IS NOT NULL;
CREATE INDEX webhook_event_retention ON webhook_events(terminal_at_ms,event_id) WHERE terminal_at_ms IS NOT NULL;
CREATE INDEX webhook_event_correlation ON webhook_events(endpoint_id,correlation_id,receive_seq) WHERE correlation_id IS NOT NULL;
CREATE TRIGGER webhook_event_identity_immutable BEFORE UPDATE OF event_id,endpoint_id,idempotency_key,identity_source,content_fingerprint,fingerprint_version,received_revision,received_at_ms,source_at_ms,expires_at_ms,acceptance_json ON webhook_events BEGIN
  SELECT RAISE(ABORT,'immutable inbox acceptance');
END;

CREATE TABLE webhook_event_payloads (
  event_id TEXT NOT NULL PRIMARY KEY REFERENCES webhook_events(event_id),
  content_type TEXT NOT NULL CHECK(content_type IN ('application/json','text/plain')),
  body_bytes BLOB NOT NULL, -- validated UTF-8, exact accepted bytes
  query_pairs_json TEXT NOT NULL CHECK(json_valid(query_pairs_json) AND json_type(query_pairs_json)='array'),
  model_data_json TEXT CHECK(model_data_json IS NULL OR json_valid(model_data_json)),
  pre_result_json TEXT CHECK(pre_result_json IS NULL OR json_valid(pre_result_json)),
  dimensions_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(dimensions_json)),
  retained_until_ms INTEGER
);
CREATE TRIGGER webhook_payload_raw_immutable BEFORE UPDATE OF content_type,body_bytes,query_pairs_json ON webhook_event_payloads BEGIN
  SELECT RAISE(ABORT,'immutable received payload');
END;

CREATE TABLE webhook_batches (
  batch_id TEXT NOT NULL PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  aggregation_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('collecting','sealed','dispatched','empty','cancelled')),
  first_entered_at_ms INTEGER NOT NULL,
  last_entered_at_ms INTEGER NOT NULL,
  idle_deadline_ms INTEGER,
  max_deadline_ms INTEGER,
  sealed_at_ms INTEGER,
  seal_reason TEXT,
  snapshot_event_count INTEGER CHECK(snapshot_event_count>=0),
  snapshot_bytes INTEGER CHECK(snapshot_bytes>=0),
  FOREIGN KEY(endpoint_id,revision) REFERENCES webhook_revisions(endpoint_id,revision)
);
CREATE UNIQUE INDEX webhook_batch_bucket ON webhook_batches(endpoint_id,revision,aggregation_key) WHERE state='collecting';
CREATE INDEX webhook_batch_dispatch ON webhook_batches(state,sealed_at_ms,batch_id);
CREATE INDEX webhook_batch_idle ON webhook_batches(idle_deadline_ms) WHERE state='collecting';
CREATE INDEX webhook_batch_max ON webhook_batches(max_deadline_ms) WHERE state='collecting';

CREATE TABLE webhook_batch_members (
  batch_id TEXT NOT NULL REFERENCES webhook_batches(batch_id),
  event_id TEXT NOT NULL REFERENCES webhook_events(event_id),
  receive_seq INTEGER NOT NULL,
  entered_at_ms INTEGER NOT NULL,
  snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes>=0),
  invalidated_at_ms INTEGER,
  invalidated_reason TEXT,
  PRIMARY KEY(batch_id,event_id),
  CHECK((invalidated_at_ms IS NULL AND invalidated_reason IS NULL) OR
        (invalidated_at_ms IS NOT NULL AND invalidated_reason IS NOT NULL))
);
CREATE UNIQUE INDEX webhook_batch_member_active ON webhook_batch_members(event_id) WHERE invalidated_at_ms IS NULL;
CREATE INDEX webhook_batch_member_order ON webhook_batch_members(batch_id,receive_seq,event_id);

CREATE TABLE webhook_assignments (
  assignment_id TEXT NOT NULL PRIMARY KEY,
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('webhook','human_wait')),
  conversation_uuid TEXT NOT NULL, -- soft reference, not an alternate conversation/run
  internal_chat_id INTEGER NOT NULL,
  root_turn_uuid TEXT NOT NULL,
  initial_batch_id TEXT UNIQUE REFERENCES webhook_batches(batch_id),
  origin_endpoint_id TEXT,
  origin_revision INTEGER,
  task_start_cursor INTEGER NOT NULL CHECK(task_start_cursor>=0),
  authorization_snapshot_json TEXT NOT NULL CHECK(json_valid(authorization_snapshot_json)),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closing','finalized')),
  recovery_state TEXT NOT NULL DEFAULT 'healthy' CHECK(recovery_state IN ('healthy','needs_control')),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK(row_version>=0),
  repair_count INTEGER NOT NULL DEFAULT 0 CHECK(repair_count IN (0,1)),
  repair_command_id TEXT, -- soft reference to runtime_commands
  repair_deadline_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  closing_at_ms INTEGER,
  finalized_at_ms INTEGER,
  terminal_reason TEXT,
  final_snapshot_json TEXT CHECK(final_snapshot_json IS NULL OR json_valid(final_snapshot_json)),
  notification_key TEXT, -- existing notification outbox is the delivery truth
  UNIQUE(conversation_uuid,root_turn_uuid),
  FOREIGN KEY(origin_endpoint_id,origin_revision) REFERENCES webhook_revisions(endpoint_id,revision),
  CHECK((origin_kind='webhook' AND origin_endpoint_id IS NOT NULL AND origin_revision IS NOT NULL) OR
        (origin_kind='human_wait' AND origin_endpoint_id IS NULL AND origin_revision IS NULL AND initial_batch_id IS NULL)),
  CHECK(state!='finalized' OR (finalized_at_ms IS NOT NULL AND final_snapshot_json IS NOT NULL))
);
CREATE UNIQUE INDEX webhook_assignment_live_conversation ON webhook_assignments(conversation_uuid) WHERE state!='finalized';
CREATE INDEX webhook_assignment_recovery ON webhook_assignments(recovery_state,state,created_at_ms);
CREATE INDEX webhook_assignment_origin ON webhook_assignments(origin_endpoint_id,created_at_ms,assignment_id);

CREATE TABLE webhook_waits (
  wait_id TEXT NOT NULL PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES webhook_assignments(assignment_id),
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id),
  register_request_id TEXT NOT NULL,
  predicate_json TEXT NOT NULL CHECK(json_valid(predicate_json)),
  predicate_sha256 TEXT NOT NULL,
  scope_snapshot_json TEXT NOT NULL CHECK(json_valid(scope_snapshot_json)),
  after_receive_seq INTEGER NOT NULL CHECK(after_receive_seq>=0),
  scan_through_seq INTEGER NOT NULL CHECK(scan_through_seq>=after_receive_seq),
  mode TEXT NOT NULL CHECK(mode IN ('single','collect')),
  max_events INTEGER NOT NULL DEFAULT 1 CHECK(max_events>0),
  max_bytes INTEGER NOT NULL DEFAULT 65536 CHECK(max_bytes>0),
  delivery_json TEXT CHECK(delivery_json IS NULL OR json_valid(delivery_json)),
  idle_ms INTEGER CHECK(idle_ms>0),
  collect_max_ms INTEGER CHECK(collect_max_ms>0),
  first_claimed_at_ms INTEGER,
  last_claimed_at_ms INTEGER,
  state TEXT NOT NULL DEFAULT 'registered' CHECK(state IN ('registered','collecting','sealed','delivered','cancelled','timed_out','closed')),
  registered_at_ms INTEGER NOT NULL,
  await_at_ms INTEGER,
  deadline_ms INTEGER,
  closed_at_ms INTEGER,
  close_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  delivery_command_id TEXT, -- stable runtime command, one persisted result per wait
  UNIQUE(assignment_id,register_request_id),
  UNIQUE(wait_id,assignment_id),
  CHECK(mode!='single' OR max_events=1)
);
CREATE INDEX webhook_wait_match ON webhook_waits(endpoint_id,state,after_receive_seq,wait_id);
CREATE INDEX webhook_wait_deadline ON webhook_waits(deadline_ms,wait_id) WHERE state IN ('registered','collecting','sealed');
CREATE INDEX webhook_wait_assignment ON webhook_waits(assignment_id,state,wait_id);

CREATE TABLE webhook_assignment_events (
  assignment_event_id TEXT NOT NULL PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES webhook_assignments(assignment_id),
  event_id TEXT NOT NULL REFERENCES webhook_events(event_id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('initial','wait','retry')),
  wait_id TEXT,
  retry_operation_id TEXT REFERENCES webhook_control_operations(operation_id),
  previous_assignment_event_id TEXT REFERENCES webhook_assignment_events(assignment_event_id),
  claimed_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  delivery_command_id TEXT, -- soft runtime command identity, not proof of business completion
  released_at_ms INTEGER,
  release_operation_id TEXT REFERENCES webhook_control_operations(operation_id),
  UNIQUE(assignment_id,event_id),
  UNIQUE(assignment_event_id,event_id),
  FOREIGN KEY(wait_id,assignment_id) REFERENCES webhook_waits(wait_id,assignment_id),
  CHECK((source_kind='wait' AND wait_id IS NOT NULL) OR (source_kind!='wait' AND wait_id IS NULL)),
  CHECK(source_kind!='retry' OR retry_operation_id IS NOT NULL),
  CHECK((released_at_ms IS NULL AND release_operation_id IS NULL) OR (released_at_ms IS NOT NULL AND release_operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX webhook_event_one_assignment ON webhook_assignment_events(event_id) WHERE released_at_ms IS NULL;
CREATE INDEX webhook_assignment_members ON webhook_assignment_events(assignment_id,claimed_at_ms,event_id);
CREATE INDEX webhook_wait_members ON webhook_assignment_events(wait_id,delivered_at_ms,event_id) WHERE wait_id IS NOT NULL;

CREATE TABLE webhook_wait_candidates (
  event_id TEXT NOT NULL REFERENCES webhook_events(event_id),
  wait_id TEXT NOT NULL REFERENCES webhook_waits(wait_id),
  detected_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  resolution TEXT CHECK(resolution IN ('selected','rejected','cancelled')),
  operation_id TEXT REFERENCES webhook_control_operations(operation_id),
  PRIMARY KEY(event_id,wait_id),
  CHECK((resolved_at_ms IS NULL AND resolution IS NULL) OR (resolved_at_ms IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX webhook_wait_candidate_active ON webhook_wait_candidates(event_id,wait_id) WHERE resolved_at_ms IS NULL;
CREATE INDEX webhook_wait_candidate_reverse ON webhook_wait_candidates(wait_id,resolved_at_ms,event_id);

-- Scripts only: model/tool attempts stay in runtime_actions / model_calls.
CREATE TABLE webhook_stage_jobs (
  job_id TEXT NOT NULL PRIMARY KEY,
  stage TEXT NOT NULL CHECK(stage IN ('pre','post')),
  event_id TEXT REFERENCES webhook_events(event_id),
  assignment_id TEXT REFERENCES webhook_assignments(assignment_id),
  endpoint_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','failed','held','cancelled','unknown')),
  row_version INTEGER NOT NULL DEFAULT 0,
  execution_fence INTEGER NOT NULL DEFAULT 0,
  retry_operation_id TEXT REFERENCES webhook_control_operations(operation_id),
  idempotency_policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(idempotency_policy_json)),
  execution_input_json TEXT CHECK(execution_input_json IS NULL OR json_valid(execution_input_json)),
  queued_at_ms INTEGER NOT NULL,
  next_attempt_at_ms INTEGER,
  terminal_at_ms INTEGER,
  FOREIGN KEY(endpoint_id,revision) REFERENCES webhook_revisions(endpoint_id,revision),
  CHECK((stage='pre' AND event_id IS NOT NULL AND assignment_id IS NULL) OR
        (stage='post' AND event_id IS NULL AND assignment_id IS NOT NULL))
);
CREATE UNIQUE INDEX webhook_pre_job ON webhook_stage_jobs(event_id) WHERE stage='pre';
CREATE UNIQUE INDEX webhook_post_job ON webhook_stage_jobs(assignment_id) WHERE stage='post';
CREATE INDEX webhook_job_ready ON webhook_stage_jobs(stage,state,next_attempt_at_ms,queued_at_ms);
CREATE INDEX webhook_job_endpoint ON webhook_stage_jobs(endpoint_id,state,queued_at_ms);

CREATE TABLE webhook_stage_attempts (
  attempt_id TEXT NOT NULL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES webhook_stage_jobs(job_id),
  attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
  execution_fence INTEGER NOT NULL CHECK(execution_fence>0),
  state TEXT NOT NULL CHECK(state IN ('reserved','running','succeeded','failed','cancelled','unknown')),
  worker_token TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  reserved_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  exit_code INTEGER,
  error_class TEXT,
  error_summary TEXT,
  log_ref TEXT,
  external_result_ref TEXT,
  side_effect_state TEXT NOT NULL DEFAULT 'unknown' CHECK(side_effect_state IN ('none','confirmed','unknown')),
  execution_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(execution_json)),
  stderr_text TEXT NOT NULL DEFAULT '',
  stderr_truncated INTEGER NOT NULL DEFAULT 0,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  UNIQUE(job_id,attempt_no),
  UNIQUE(job_id,execution_fence)
);
CREATE UNIQUE INDEX webhook_attempt_active ON webhook_stage_attempts(job_id) WHERE state IN ('reserved','running');
CREATE INDEX webhook_attempt_lease ON webhook_stage_attempts(lease_until_ms) WHERE state IN ('reserved','running');

CREATE TABLE webhook_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES webhook_events(event_id),
  result_version INTEGER NOT NULL CHECK(result_version>0),
  assignment_event_id TEXT,
  stage_attempt_id TEXT REFERENCES webhook_stage_attempts(attempt_id),
  source TEXT NOT NULL CHECK(source IN ('model','script','framework','administrator')),
  runtime_run_id TEXT, -- soft reference, supplied by framework
  runtime_action_id TEXT, -- soft reference, supplied by framework
  request_key TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL,
  outcome TEXT CHECK(outcome IN ('completed','skipped','failed','unknown')),
  disposition TEXT CHECK(disposition IN ('expired','cancelled','protocol_incomplete','not_delivered')),
  review_required INTEGER NOT NULL DEFAULT 0 CHECK(review_required IN (0,1)),
  summary TEXT NOT NULL DEFAULT '',
  reason TEXT,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs_json)),
  reported_at_ms INTEGER NOT NULL,
  UNIQUE(event_id,result_version),
  FOREIGN KEY(assignment_event_id,event_id) REFERENCES webhook_assignment_events(assignment_event_id,event_id),
  CHECK(outcome IS NOT NULL OR disposition IS NOT NULL),
  CHECK(source='framework' OR (outcome IS NOT NULL AND disposition IS NULL)),
  CHECK(source!='framework' OR outcome IS NULL OR outcome IN ('failed','unknown')),
  CHECK(source!='model' OR (assignment_event_id IS NOT NULL AND runtime_run_id IS NOT NULL)),
  CHECK(source!='script' OR stage_attempt_id IS NOT NULL)
);
CREATE INDEX webhook_receipt_member ON webhook_receipts(assignment_event_id,result_version DESC);
CREATE TRIGGER webhook_receipt_immutable BEFORE UPDATE ON webhook_receipts BEGIN
  SELECT RAISE(ABORT,'append receipts; never rewrite provenance');
END;

CREATE TABLE webhook_script_capabilities (
  capability_id TEXT NOT NULL PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES webhook_stage_attempts(attempt_id),
  verifier BLOB NOT NULL,
  verifier_algorithm TEXT NOT NULL,
  pepper_version TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), -- telemetry only, framework-bound input IDs
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  CHECK(expires_at_ms>issued_at_ms)
);
CREATE INDEX webhook_capability_attempt ON webhook_script_capabilities(attempt_id,expires_at_ms);

CREATE TABLE webhook_runtime_links (
  run_id TEXT NOT NULL PRIMARY KEY, -- soft runtime_runs reference; globally mapped once
  assignment_id TEXT NOT NULL REFERENCES webhook_assignments(assignment_id),
  relation_kind TEXT NOT NULL CHECK(relation_kind IN ('controller','agent')),
  task_uuid TEXT, -- soft rath_tasks reference
  linked_at_ms INTEGER NOT NULL,
  billing_scope TEXT NOT NULL CHECK(billing_scope IN ('origin_webhook','human')),
  effective_config_json TEXT NOT NULL CHECK(json_valid(effective_config_json))
);
CREATE INDEX webhook_runtime_assignment ON webhook_runtime_links(assignment_id,relation_kind,run_id);

CREATE TABLE webhook_phase_spans (
  span_id TEXT NOT NULL PRIMARY KEY,
  endpoint_id TEXT REFERENCES webhook_endpoints(endpoint_id),
  event_id TEXT REFERENCES webhook_events(event_id),
  batch_id TEXT REFERENCES webhook_batches(batch_id),
  assignment_id TEXT REFERENCES webhook_assignments(assignment_id),
  stage_attempt_id TEXT REFERENCES webhook_stage_attempts(attempt_id),
  phase TEXT NOT NULL CHECK(phase IN ('pre_queue','pre_execute','aggregation','model_queue','model_tool','human_wait','external_wait','post_queue','post_execute','delivery','end_to_end')),
  measurement_level TEXT NOT NULL CHECK(measurement_level IN ('event','batch','assignment','attempt')),
  source_key TEXT NOT NULL UNIQUE,
  runtime_ref TEXT, -- existing run/action/interaction evidence when applicable
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  end_reason TEXT,
  CHECK(ended_at_ms IS NULL OR ended_at_ms>=started_at_ms)
);
CREATE INDEX webhook_span_endpoint ON webhook_phase_spans(endpoint_id,phase,started_at_ms,span_id);
CREATE INDEX webhook_span_assignment ON webhook_phase_spans(assignment_id,started_at_ms,span_id);

CREATE TABLE webhook_metric_definitions (
  definition_id TEXT NOT NULL PRIMARY KEY,
  endpoint_id TEXT REFERENCES webhook_endpoints(endpoint_id), -- NULL for system-builtins
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('framework','custom')),
  metric_type TEXT NOT NULL CHECK(metric_type IN ('counter','gauge','histogram')),
  unit TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  allowed_labels_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(allowed_labels_json) AND json_type(allowed_labels_json)='object'),
  histogram_bounds_json TEXT CHECK(histogram_bounds_json IS NULL OR (json_valid(histogram_bounds_json) AND json_type(histogram_bounds_json)='array')),
  gauge_ttl_ms INTEGER CHECK(gauge_ttl_ms>0),
  max_series INTEGER NOT NULL CHECK(max_series>0),
  created_at_ms INTEGER NOT NULL,
  CHECK(source_kind!='custom' OR endpoint_id IS NOT NULL),
  CHECK((metric_type='histogram' AND histogram_bounds_json IS NOT NULL) OR (metric_type!='histogram' AND histogram_bounds_json IS NULL)),
  CHECK((metric_type='gauge' AND gauge_ttl_ms IS NOT NULL) OR (metric_type!='gauge' AND gauge_ttl_ms IS NULL))
);
CREATE UNIQUE INDEX webhook_metric_name ON webhook_metric_definitions(endpoint_id,name) WHERE endpoint_id IS NOT NULL;
CREATE UNIQUE INDEX webhook_metric_system_name ON webhook_metric_definitions(name) WHERE endpoint_id IS NULL;
CREATE TRIGGER webhook_metric_semantics_immutable BEFORE UPDATE OF endpoint_id,name,source_kind,metric_type,unit,allowed_labels_json,histogram_bounds_json,gauge_ttl_ms ON webhook_metric_definitions BEGIN
  SELECT RAISE(ABORT,'new metric name required for semantic change');
END;

CREATE TABLE webhook_metric_series (
  series_id TEXT NOT NULL PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES webhook_metric_definitions(definition_id),
  endpoint_id TEXT REFERENCES webhook_endpoints(endpoint_id), -- series attribution, even for global builtin definitions
  labels_json TEXT NOT NULL CHECK(json_valid(labels_json) AND json_type(labels_json)='object'), -- canonical bounded labels
  created_at_ms INTEGER NOT NULL,
  UNIQUE(definition_id,endpoint_id,labels_json)
);
CREATE UNIQUE INDEX webhook_series_system_unique ON webhook_metric_series(definition_id,labels_json) WHERE endpoint_id IS NULL;
CREATE INDEX webhook_series_endpoint_budget ON webhook_metric_series(endpoint_id,definition_id);
CREATE TRIGGER webhook_series_scope BEFORE INSERT ON webhook_metric_series BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM webhook_metric_definitions WHERE definition_id=NEW.definition_id AND endpoint_id IS NOT NULL AND endpoint_id IS NOT NEW.endpoint_id) THEN RAISE(ABORT,'series endpoint differs from definition') END;
END;
CREATE TRIGGER webhook_series_identity_immutable BEFORE UPDATE ON webhook_metric_series BEGIN
  SELECT RAISE(ABORT,'series identity/labels immutable');
END;

CREATE TABLE webhook_telemetry_operations (
  telemetry_id TEXT NOT NULL PRIMARY KEY,
  scope_key TEXT NOT NULL, -- 'system' or 'endpoint:' || endpoint_id; enforced below
  operation_id TEXT NOT NULL,
  endpoint_id TEXT REFERENCES webhook_endpoints(endpoint_id),
  event_id TEXT REFERENCES webhook_events(event_id),
  batch_id TEXT REFERENCES webhook_batches(batch_id),
  assignment_id TEXT REFERENCES webhook_assignments(assignment_id),
  stage_attempt_id TEXT REFERENCES webhook_stage_attempts(attempt_id),
  runtime_action_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('framework','script','model')),
  content_sha256 TEXT NOT NULL,
  payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)), -- independently retryable observation delivery
  state TEXT NOT NULL CHECK(state IN ('pending','applied','rejected')),
  created_at_ms INTEGER NOT NULL,
  applied_at_ms INTEGER,
  next_attempt_at_ms INTEGER,
  error_reason TEXT,
  UNIQUE(scope_key,operation_id),
  CHECK((endpoint_id IS NULL AND scope_key='system' AND source='framework') OR
        (endpoint_id IS NOT NULL AND scope_key='endpoint:'||endpoint_id))
);
CREATE INDEX webhook_telemetry_pending ON webhook_telemetry_operations(state,next_attempt_at_ms,telemetry_id);
CREATE INDEX webhook_telemetry_event ON webhook_telemetry_operations(event_id,created_at_ms);

CREATE TABLE webhook_metric_samples (
  sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
  telemetry_id TEXT NOT NULL REFERENCES webhook_telemetry_operations(telemetry_id),
  item_no INTEGER NOT NULL CHECK(item_no>=0),
  series_id TEXT NOT NULL REFERENCES webhook_metric_series(series_id),
  observed_at_ms INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  value REAL NOT NULL CHECK(value BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),
  expires_at_ms INTEGER, -- required only for gauge: observed_at + definition TTL
  UNIQUE(telemetry_id,item_no)
);
CREATE INDEX webhook_sample_series_time ON webhook_metric_samples(series_id,observed_at_ms,sample_id);
CREATE INDEX webhook_sample_retention ON webhook_metric_samples(recorded_at_ms,sample_id);
CREATE TRIGGER webhook_sample_semantics BEFORE INSERT ON webhook_metric_samples BEGIN
  SELECT CASE WHEN (SELECT metric_type FROM webhook_metric_definitions d JOIN webhook_metric_series s USING(definition_id) WHERE s.series_id=NEW.series_id)='counter' AND NEW.value<0 THEN RAISE(ABORT,'counter delta must be nonnegative') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM webhook_metric_definitions d JOIN webhook_metric_series s USING(definition_id) WHERE s.series_id=NEW.series_id AND ((d.metric_type='gauge' AND (NEW.expires_at_ms IS NULL OR NEW.expires_at_ms!=NEW.observed_at_ms+d.gauge_ttl_ms)) OR (d.metric_type!='gauge' AND NEW.expires_at_ms IS NOT NULL))) THEN RAISE(ABORT,'gauge expiry mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM webhook_metric_definitions d JOIN webhook_metric_series s USING(definition_id) JOIN webhook_telemetry_operations o ON o.telemetry_id=NEW.telemetry_id WHERE s.series_id=NEW.series_id AND ((d.source_kind='framework' AND o.source!='framework') OR s.endpoint_id IS NOT o.endpoint_id)) THEN RAISE(ABORT,'metric source/scope violation') END;
END;

-- Fixed minute/hour mergeable summaries. Histogram vector is NON-cumulative,
-- length=len(bounds)+1, final position is +Inf; checked by schema-check + service.
CREATE TABLE webhook_metric_rollups (
  series_id TEXT NOT NULL REFERENCES webhook_metric_series(series_id),
  resolution_seconds INTEGER NOT NULL CHECK(resolution_seconds IN (60,3600)),
  bucket_start_ms INTEGER NOT NULL,
  sample_count INTEGER NOT NULL CHECK(sample_count>0),
  sum_value REAL NOT NULL,
  min_value REAL NOT NULL,
  max_value REAL NOT NULL,
  last_value REAL NOT NULL,
  last_observed_at_ms INTEGER NOT NULL,
  last_sample_id INTEGER NOT NULL, -- value/cursor only; NO FK to purgable raw sample
  last_expires_at_ms INTEGER,
  histogram_counts_json TEXT CHECK(histogram_counts_json IS NULL OR (json_valid(histogram_counts_json) AND json_type(histogram_counts_json)='array')),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(series_id,resolution_seconds,bucket_start_ms),
  CHECK(bucket_start_ms % (resolution_seconds*1000)=0),
  CHECK(min_value<=max_value)
);
CREATE INDEX webhook_rollup_retention ON webhook_metric_rollups(resolution_seconds,bucket_start_ms);

CREATE TABLE webhook_business_records (
  record_id TEXT NOT NULL PRIMARY KEY,
  telemetry_id TEXT NOT NULL REFERENCES webhook_telemetry_operations(telemetry_id),
  item_no INTEGER NOT NULL CHECK(item_no>=0),
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id),
  record_type TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  fields_json TEXT NOT NULL CHECK(json_valid(fields_json) AND json_type(fields_json)='object'),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs_json)),
  UNIQUE(telemetry_id,item_no)
);
CREATE INDEX webhook_business_time ON webhook_business_records(endpoint_id,record_type,observed_at_ms,record_id);

-- Only declared queryable fields are projected here; not one metric series per ID.
CREATE TABLE webhook_business_fields (
  record_id TEXT NOT NULL REFERENCES webhook_business_records(record_id),
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id),
  field_name TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK(value_type IN ('string','number','boolean','null')),
  value_text TEXT,
  value_number REAL,
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(record_id,field_name),
  CHECK((value_type='string' AND value_text IS NOT NULL AND value_number IS NULL) OR
        (value_type='number' AND value_text IS NULL AND value_number IS NOT NULL) OR
        (value_type='boolean' AND value_text IS NULL AND value_number IS NOT NULL AND value_number IN (0,1)) OR
        (value_type='null' AND value_text IS NULL AND value_number IS NULL))
);
CREATE INDEX webhook_business_field_text ON webhook_business_fields(endpoint_id,field_name,value_text,observed_at_ms,record_id) WHERE value_type='string';
CREATE INDEX webhook_business_field_number ON webhook_business_fields(endpoint_id,field_name,value_number,observed_at_ms,record_id) WHERE value_type IN ('number','boolean');
CREATE INDEX webhook_business_field_rank ON webhook_business_fields(endpoint_id,field_name,observed_at_ms,value_text) WHERE value_type='string';

-- Defense-in-depth relational guards. Time, ACLs, predicates, existing runtime locks,
-- metric cardinality and complete state machines still require service transactions.
CREATE TRIGGER webhook_batch_member_insert_guard BEFORE INSERT ON webhook_batch_members BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM webhook_batches b JOIN webhook_events e ON e.event_id=NEW.event_id WHERE b.batch_id=NEW.batch_id AND b.state='collecting' AND b.endpoint_id=e.endpoint_id AND b.revision=e.processing_revision AND e.receive_seq=NEW.receive_seq AND e.route_state IN ('eligible','batch')) THEN RAISE(ABORT,'invalid batch scope/state') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM webhook_assignment_events WHERE event_id=NEW.event_id AND released_at_ms IS NULL) OR EXISTS(SELECT 1 FROM webhook_wait_candidates WHERE event_id=NEW.event_id AND resolved_at_ms IS NULL) THEN RAISE(ABORT,'event already claimed/conflicted') END;
END;
CREATE TRIGGER webhook_batch_member_history BEFORE UPDATE ON webhook_batch_members
WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.event_id IS NOT OLD.event_id OR NEW.receive_seq!=OLD.receive_seq OR NEW.entered_at_ms!=OLD.entered_at_ms OR NEW.snapshot_bytes!=OLD.snapshot_bytes OR OLD.invalidated_at_ms IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'batch membership history immutable');
END;
CREATE TRIGGER webhook_assignment_member_insert_guard BEFORE INSERT ON webhook_assignment_events BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM webhook_assignments WHERE assignment_id=NEW.assignment_id AND state='open') THEN RAISE(ABORT,'assignment closed to claims') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM webhook_batch_members WHERE event_id=NEW.event_id AND invalidated_at_ms IS NULL) OR EXISTS(SELECT 1 FROM webhook_wait_candidates WHERE event_id=NEW.event_id AND resolved_at_ms IS NULL) THEN RAISE(ABORT,'revoke batch/conflict before claim') END;
  SELECT CASE WHEN NEW.source_kind!='retry' AND NOT EXISTS(SELECT 1 FROM webhook_events WHERE event_id=NEW.event_id AND route_state IN ('eligible','batch')) THEN RAISE(ABORT,'event not pre-approved/eligible') END;
  SELECT CASE WHEN NEW.wait_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM webhook_waits w JOIN webhook_events e ON e.event_id=NEW.event_id WHERE w.wait_id=NEW.wait_id AND w.assignment_id=NEW.assignment_id AND w.endpoint_id=e.endpoint_id AND w.state IN ('registered','collecting') AND e.receive_seq>w.after_receive_seq) THEN RAISE(ABORT,'wait not eligible') END;
END;
CREATE TRIGGER webhook_assignment_member_update_guard BEFORE UPDATE ON webhook_assignment_events BEGIN
  SELECT CASE WHEN NEW.assignment_event_id IS NOT OLD.assignment_event_id OR NEW.assignment_id IS NOT OLD.assignment_id OR NEW.event_id IS NOT OLD.event_id OR NEW.source_kind IS NOT OLD.source_kind OR NEW.wait_id IS NOT OLD.wait_id OR NEW.claimed_at_ms!=OLD.claimed_at_ms OR OLD.released_at_ms IS NOT NULL THEN RAISE(ABORT,'assignment membership identity immutable') END;
  SELECT CASE WHEN OLD.released_at_ms IS NULL AND NEW.released_at_ms IS NOT NULL AND NOT EXISTS(SELECT 1 FROM webhook_assignments WHERE assignment_id=OLD.assignment_id AND state='finalized') THEN RAISE(ABORT,'release only formally finalized ownership') END;
END;
CREATE TRIGGER webhook_assignment_finalize_guard BEFORE UPDATE OF state ON webhook_assignments
WHEN NEW.state='finalized' AND OLD.state!='finalized' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM webhook_assignment_events ae WHERE ae.assignment_id=NEW.assignment_id AND NOT EXISTS(SELECT 1 FROM webhook_receipts r WHERE r.assignment_event_id=ae.assignment_event_id)) THEN RAISE(ABORT,'missing assignment receipt/disposition') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM webhook_waits WHERE assignment_id=NEW.assignment_id AND state IN ('registered','collecting','sealed')) THEN RAISE(ABORT,'close waits before finalization') END;
END;
CREATE TRIGGER webhook_post_requires_finalization BEFORE INSERT ON webhook_stage_jobs WHEN NEW.stage='post' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM webhook_assignments WHERE assignment_id=NEW.assignment_id AND state='finalized' AND origin_kind='webhook' AND origin_endpoint_id=NEW.endpoint_id AND origin_revision=NEW.revision) THEN RAISE(ABORT,'post requires origin final snapshot') END;
END;
CREATE TRIGGER webhook_business_field_scope BEFORE INSERT ON webhook_business_fields BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM webhook_business_records WHERE record_id=NEW.record_id AND endpoint_id=NEW.endpoint_id AND observed_at_ms=NEW.observed_at_ms) THEN RAISE(ABORT,'business field scope mismatch') END;
END;

CREATE TRIGGER webhook_assignment_state_monotone BEFORE UPDATE OF state,repair_count ON webhook_assignments BEGIN
  SELECT CASE WHEN (OLD.state='finalized' AND NEW.state!='finalized') OR (OLD.state='closing' AND NEW.state='open') OR NEW.repair_count<OLD.repair_count THEN RAISE(ABORT,'no assignment/repair rewind') END;
END;
CREATE TRIGGER webhook_model_receipt_scope BEFORE INSERT ON webhook_receipts WHEN NEW.source='model' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM webhook_assignment_events ae JOIN webhook_assignments a USING(assignment_id) JOIN webhook_runtime_links l USING(assignment_id) WHERE ae.assignment_event_id=NEW.assignment_event_id AND ae.event_id=NEW.event_id AND ae.delivered_at_ms IS NOT NULL AND ae.released_at_ms IS NULL AND a.state IN ('open','closing') AND l.run_id=NEW.runtime_run_id) THEN RAISE(ABORT,'model receipt requires delivered current ownership/run') END;
END;
CREATE TRIGGER webhook_stage_identity_guard BEFORE UPDATE OF stage,event_id,assignment_id,action_key,endpoint_id,revision ON webhook_stage_jobs BEGIN
  SELECT CASE WHEN NEW.stage IS NOT OLD.stage OR NEW.event_id IS NOT OLD.event_id OR NEW.assignment_id IS NOT OLD.assignment_id OR NEW.action_key IS NOT OLD.action_key OR NEW.endpoint_id IS NOT OLD.endpoint_id THEN RAISE(ABORT,'job identity immutable') END;
  SELECT CASE WHEN NEW.revision!=OLD.revision AND (OLD.stage='post' OR EXISTS(SELECT 1 FROM webhook_stage_attempts WHERE job_id=OLD.job_id)) THEN RAISE(ABORT,'only unstarted pre job may rebind revision') END;
END;
CREATE TRIGGER webhook_batch_snapshot_guard BEFORE UPDATE OF endpoint_id,revision,aggregation_key,first_entered_at_ms,last_entered_at_ms,sealed_at_ms,snapshot_event_count,snapshot_bytes ON webhook_batches WHEN OLD.state!='collecting' BEGIN
  SELECT RAISE(ABORT,'sealed batch snapshot immutable');
END;
CREATE TRIGGER webhook_business_record_scope BEFORE INSERT ON webhook_business_records BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM webhook_telemetry_operations WHERE telemetry_id=NEW.telemetry_id AND endpoint_id=NEW.endpoint_id) THEN RAISE(ABORT,'business record endpoint mismatch') END;
END;
