-- Incremental runtime reliability schema. Applied once by the versioned migrator;
-- never changes or bypasses the deployed webhooks_v1 signature.
CREATE TABLE webhook_conversation_stops (
  conversation_uuid TEXT PRIMARY KEY,
  owner_chat_id INTEGER NOT NULL,
  stopped_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE webhook_report_requests (
  assignment_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (assignment_id, request_id),
  FOREIGN KEY (assignment_id) REFERENCES webhook_assignments(assignment_id)
);
-- Marks only webhook-owned channel runs. Existing ordinary notification retry
-- behavior is untouched; unknown physical delivery is not blindly re-enqueued.
CREATE TABLE webhook_notification_routes (
  root_turn_uuid TEXT PRIMARY KEY,
  notification_key TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
