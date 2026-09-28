-- Runtime facts are references to existing context, transcript and billing data.
-- They do not replace context history, model_calls or Web projections.
CREATE TABLE IF NOT EXISTS runtime_runs (
  run_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  task_uuid TEXT NOT NULL DEFAULT '',
  root_turn_uuid TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN
    ('running','waiting','completed','cancelled','failed','interrupted','needs_control')),
  phase TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_runs_owner ON runtime_runs(owner_key,created_at);
CREATE TABLE IF NOT EXISTS runtime_actions (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runtime_runs(run_id),
  kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
  call_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN
    ('started','completed','failed','cancelled','not_started','unknown')),
  result_ref TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  outcome_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_actions_run ON runtime_actions(run_id,created_at,action_id);
CREATE TABLE IF NOT EXISTS runtime_commands (
  command_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runtime_runs(run_id),
  kind TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('received','delivered','acknowledged')),
  received_checkpoint_revision INTEGER NOT NULL DEFAULT -1,
  checkpoint_revision INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  acknowledged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_commands_pending ON runtime_commands(run_id,status,created_at);
CREATE TABLE IF NOT EXISTS runtime_accounting_claims (
  action_id TEXT PRIMARY KEY REFERENCES runtime_actions(action_id),
  created_at INTEGER NOT NULL
);
