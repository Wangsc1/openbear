-- Cron owns definitions and executions, not a Webhook event queue.
CREATE TABLE IF NOT EXISTS cron_jobs (
 job_id TEXT PRIMARY KEY,
 owner_chat_id INTEGER NOT NULL,
 folder_id TEXT NOT NULL,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1,
 config_json TEXT NOT NULL,
 next_run_at_ms INTEGER,
 schedule_state TEXT NOT NULL DEFAULT 'disabled',
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL,
 deleted_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS cron_jobs_due ON cron_jobs(next_run_at_ms) WHERE enabled=1 AND deleted_at_ms IS NULL;
CREATE INDEX IF NOT EXISTS cron_jobs_folder ON cron_jobs(owner_chat_id,folder_id,created_at_ms);
CREATE TABLE IF NOT EXISTS cron_runs (
 run_id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL,
 owner_chat_id INTEGER NOT NULL,
 folder_id TEXT NOT NULL,
 job_name TEXT NOT NULL,
 trigger_kind TEXT NOT NULL,
 scheduled_at_ms INTEGER NOT NULL,
 occurrence_key TEXT NOT NULL UNIQUE,
 config_json TEXT NOT NULL,
 config_revision INTEGER NOT NULL,
 conversation_uuid TEXT NOT NULL DEFAULT '',
 root_turn_uuid TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'starting',
 phase TEXT NOT NULL DEFAULT 'starting',
 outcome TEXT NOT NULL DEFAULT '',
 error TEXT NOT NULL DEFAULT '',
 started_at_ms INTEGER NOT NULL,
 finished_at_ms INTEGER,
 pre_attempts_json TEXT NOT NULL DEFAULT '[]',
 post_attempts_json TEXT NOT NULL DEFAULT '[]',
 final_text TEXT NOT NULL DEFAULT '',
 total_tokens INTEGER NOT NULL DEFAULT 0,
 cost_usd REAL NOT NULL DEFAULT 0,
 model_calls INTEGER NOT NULL DEFAULT 0,
 notification_state TEXT NOT NULL DEFAULT 'not_requested'
);
CREATE INDEX IF NOT EXISTS cron_runs_job ON cron_runs(owner_chat_id,job_id,started_at_ms DESC,run_id);
CREATE INDEX IF NOT EXISTS cron_runs_conversation ON cron_runs(conversation_uuid,root_turn_uuid);
CREATE TABLE IF NOT EXISTS cron_operations (
 owner_chat_id INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 result_json TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_chat_id,request_id)
);
