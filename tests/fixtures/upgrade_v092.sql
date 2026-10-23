-- Empty database created by DB.connect() from v0.9.2, commit 17db451af37e641e5369f8c18c48ee13461cd63e.
-- Contains no user data. Keep frozen: this is a pre-upgrade schema, not a current-schema copy.
BEGIN TRANSACTION;
CREATE TABLE app_state (
  key         TEXT PRIMARY KEY,
  value       TEXT DEFAULT '',
  updated_at  INTEGER DEFAULT 0
);
CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT DEFAULT '',
  actor        TEXT DEFAULT '',
  chat_id      INTEGER DEFAULT 0,
  ip           TEXT DEFAULT '',
  detail_json  TEXT DEFAULT '{}',
  created_at   INTEGER DEFAULT 0
);
CREATE TABLE context_editor_branches (
  conversation_uuid TEXT PRIMARY KEY REFERENCES web_conversations(conversation_uuid) ON DELETE CASCADE,
  source_conversation_uuid TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE context_editor_drafts (
  conversation_uuid TEXT PRIMARY KEY REFERENCES web_conversations(conversation_uuid) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  document_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE context_execution_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'execution',
  task_uuid TEXT NOT NULL DEFAULT '',
  turn_uuid TEXT NOT NULL DEFAULT '',
  message_id INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_key,event_id)
);
CREATE TABLE context_window_rotations (
  rotation_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  window_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_key,window_version)
);
CREATE TABLE context_windows (
  owner_key TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('controller','agent')),
  conversation_uuid TEXT NOT NULL DEFAULT '',
  session_uuid TEXT NOT NULL DEFAULT '',
  agent_session_uuid TEXT NOT NULL DEFAULT '',
  task_uuid TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  window_version INTEGER NOT NULL DEFAULT 0,
  source_revision INTEGER NOT NULL DEFAULT 0,
  source_high_water INTEGER NOT NULL DEFAULT 0,
  route_fingerprint TEXT NOT NULL DEFAULT '',
  state_json TEXT NOT NULL DEFAULT '{}',
  usage_known INTEGER NOT NULL DEFAULT 0,
  usage_tokens INTEGER NOT NULL DEFAULT 0,
  usage_request_id TEXT NOT NULL DEFAULT '',
  request_sequence INTEGER NOT NULL DEFAULT 0,
  usage_request_sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE controller_model_contexts (
  chat_id             INTEGER PRIMARY KEY,
  conversation_uuid   TEXT NOT NULL DEFAULT '',
  session_id          TEXT NOT NULL DEFAULT '',
  protocol            TEXT NOT NULL DEFAULT '',
  model               TEXT NOT NULL DEFAULT '',
  model_label         TEXT NOT NULL DEFAULT '',
  state_json          TEXT NOT NULL DEFAULT '{}',
  revision            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER DEFAULT 0,
  updated_at          INTEGER DEFAULT 0
);
CREATE TABLE conversation_task_memories (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_uuid            TEXT NOT NULL UNIQUE,
  conversation_uuid      TEXT NOT NULL,
  scope_type             TEXT NOT NULL CHECK(scope_type IN ('conversation','agent_task','agent_session')),
  task_uuid              TEXT NOT NULL DEFAULT '',
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  body                   TEXT NOT NULL DEFAULT '',
  auto_reinject_catalog  INTEGER NOT NULL DEFAULT 1,
  visible_to_agents      INTEGER NOT NULL DEFAULT 0,
  revision               INTEGER NOT NULL DEFAULT 1,
  created_by             TEXT NOT NULL DEFAULT '',
  source_turn_uuid       TEXT NOT NULL DEFAULT '',
  source_run_uuid        TEXT NOT NULL DEFAULT '',
  created_at             INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL DEFAULT 0,
  deleted_at             INTEGER NOT NULL DEFAULT 0,
  idempotency_key        TEXT NOT NULL DEFAULT '',
  CHECK(
    (scope_type='conversation' AND task_uuid='') OR
    (scope_type IN ('agent_task','agent_session') AND task_uuid<>'')
  )
);
CREATE TABLE interaction_tg_drafts (
  interaction_id        TEXT PRIMARY KEY,
  owner_chat_id         INTEGER NOT NULL,
  callback_token        TEXT NOT NULL UNIQUE,
  interaction_revision  INTEGER NOT NULL,
  action                TEXT NOT NULL,
  selected_values_json  TEXT NOT NULL DEFAULT '[]',
  selected_indexes_json TEXT NOT NULL DEFAULT '[]',
  text_value            TEXT NOT NULL DEFAULT '',
  confirm_decision      TEXT NOT NULL DEFAULT '',
  questionnaire_json    TEXT NOT NULL DEFAULT '{}',
  current_question_index INTEGER NOT NULL DEFAULT -1,
  view                   TEXT NOT NULL DEFAULT 'root',
  draft_version          INTEGER NOT NULL DEFAULT 1,
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE TABLE interaction_tg_messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id           INTEGER UNIQUE,
  interaction_id        TEXT NOT NULL,
  owner_chat_id         INTEGER NOT NULL,
  telegram_message_id   INTEGER NOT NULL,
  role                  TEXT NOT NULL, -- root|question|summary
  question_index        INTEGER NOT NULL DEFAULT -1,
  interaction_revision  INTEGER NOT NULL,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE(owner_chat_id, telegram_message_id)
);
CREATE TABLE interaction_tg_outbox (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_key          TEXT NOT NULL UNIQUE,
  interaction_id        TEXT NOT NULL,
  owner_chat_id         INTEGER NOT NULL,
  event_type            TEXT NOT NULL, -- created|resolved|refresh|question|summary
  question_index        INTEGER NOT NULL DEFAULT -1,
  draft_version         INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL DEFAULT 'pending', -- pending|processing|sent|cancelled|failed
  deliver_after         INTEGER NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  telegram_message_id   INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  delivered_at          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE memory_categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  icon         TEXT DEFAULT '',
  render_type  TEXT NOT NULL DEFAULT 'fields',
  schema_json  TEXT NOT NULL DEFAULT '{"fields":[]}',
  inject       INTEGER DEFAULT 1,
  sort         INTEGER DEFAULT 0
);
CREATE TABLE memory_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  title       TEXT DEFAULT '',
  summary     TEXT DEFAULT '',
  project     TEXT DEFAULT '',
  importance  INTEGER DEFAULT 3,
  tags        TEXT DEFAULT '',
  grp         TEXT DEFAULT '',
  enabled     INTEGER DEFAULT 1,
  archived    INTEGER DEFAULT 0,
  sort        INTEGER DEFAULT 0,
  content     TEXT DEFAULT '',
  created_at  INTEGER DEFAULT 0,
  updated_at  INTEGER DEFAULT 0
);
CREATE TABLE memory_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER NOT NULL,
  grp          TEXT DEFAULT '',
  ref          TEXT DEFAULT '',
  note         TEXT DEFAULT '',
  title        TEXT NOT NULL,
  fields_json  TEXT NOT NULL DEFAULT '{}',
  body         TEXT DEFAULT '',
  expanded     INTEGER DEFAULT 0,
  enabled      INTEGER DEFAULT 1,
  archived     INTEGER DEFAULT 0,
  sort         INTEGER DEFAULT 0,
  created_at   INTEGER DEFAULT 0,
  updated_at   INTEGER DEFAULT 0
);
CREATE TABLE memory_render_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER DEFAULT 0,
  params_json    TEXT DEFAULT '',
  output         TEXT DEFAULT '',
  output_len     INTEGER DEFAULT 0,
  source         TEXT DEFAULT 'runtime',
  client_ip      TEXT DEFAULT '',
  template_id    INTEGER DEFAULT 0,
  template_name  TEXT DEFAULT '',
  auth_ok        INTEGER DEFAULT 1,
  auth_error     TEXT DEFAULT '',
  ms             INTEGER DEFAULT 0
);
CREATE TABLE memory_secrets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  note        TEXT DEFAULT '',
  kv_json     TEXT NOT NULL DEFAULT '[]',
  grp         TEXT DEFAULT '',
  enabled     INTEGER DEFAULT 1,
  archived    INTEGER DEFAULT 0,
  sort        INTEGER DEFAULT 0,
  created_at  INTEGER DEFAULT 0,
  updated_at  INTEGER DEFAULT 0
);
CREATE TABLE memory_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  is_active   INTEGER DEFAULT 0,
  is_agent_active INTEGER DEFAULT 0,
  updated_at  INTEGER DEFAULT 0
);
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  role          TEXT NOT NULL,          -- user|assistant|tool
  content       TEXT,
  reasoning     TEXT,                   -- assistant thinking（anthropic 多轮回传含 signature）
  signature     TEXT,
  tool_calls_json TEXT,                 -- assistant 发起的工具调用（JSON）
  tool_call_id  TEXT,                   -- tool 结果回灌
  name          TEXT,                   -- tool 名
  tokens        INTEGER DEFAULT 0,
  compacted     INTEGER DEFAULT 0,      -- 1=已被压缩进摘要
  created_at    INTEGER,
  -- Durable ownership metadata for later turn deletion / audit.
  -- These fields stay in DB only; build_history/to_message never send them to the model.
  conversation_uuid    TEXT DEFAULT '',
  turn_uuid            TEXT DEFAULT '',
  parent_turn_uuid     TEXT DEFAULT '',
  run_root_turn_uuid   TEXT DEFAULT '',
  task_uuid            TEXT DEFAULT '',  -- Rath/Agent task run id (empty for pure main-controller rows)
  agent_session_uuid   TEXT DEFAULT ''   -- Rath agent session continuity id
);
CREATE TABLE model_calls (
  attempt_id TEXT NOT NULL DEFAULT '',
  usage_known INTEGER,
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id             INTEGER NOT NULL,
  session_uuid        TEXT DEFAULT '',
  model               TEXT DEFAULT '',
  protocol            TEXT DEFAULT '',
  think_level         TEXT DEFAULT '',
  call_kind           TEXT DEFAULT '',
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  cache_read_tokens   INTEGER DEFAULT 0,
  cache_write_tokens  INTEGER DEFAULT 0,
  last_input_tokens   INTEGER DEFAULT 0,
  last_output_tokens  INTEGER DEFAULT 0,
  last_cache_read_tokens   INTEGER DEFAULT 0,
  last_cache_write_tokens  INTEGER DEFAULT 0,
  expert_input_tokens       INTEGER DEFAULT 0,
  expert_output_tokens      INTEGER DEFAULT 0,
  expert_cache_read_tokens  INTEGER DEFAULT 0,
  expert_cache_write_tokens INTEGER DEFAULT 0,
  expert_tool_calls         INTEGER DEFAULT 0,
  cost_usd            REAL DEFAULT 0,
  connect_ms          INTEGER DEFAULT 0,
  first_token_ms      INTEGER DEFAULT 0,
  total_time_ms       INTEGER DEFAULT 0,
  peak_tps            REAL DEFAULT 0,  -- 本次 Agent run 内单次模型 API 调用最高 TPS
  min_tps             REAL DEFAULT 0,  -- 本次 Agent run 内单次模型 API 调用最低 TPS（仅统计有输出调用）
  status              TEXT DEFAULT 'ok',
  model_call_count    INTEGER DEFAULT 1,
  model_ok_count      INTEGER DEFAULT 1,
  model_retry_count   INTEGER DEFAULT 0,
  model_fail_count    INTEGER DEFAULT 0,
  error_type          TEXT DEFAULT '',
  created_at          INTEGER
);
CREATE TABLE operations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_uuid   TEXT NOT NULL UNIQUE,
  chat_id          INTEGER DEFAULT 0,
  kind             TEXT DEFAULT '',
  status           TEXT DEFAULT '',
  detail_json      TEXT DEFAULT '{}',
  error            TEXT DEFAULT '',
  started_at       INTEGER,
  finished_at      INTEGER DEFAULT 0
);
CREATE TABLE rath_agent_sessions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  session_uuid             TEXT NOT NULL UNIQUE,
  session_kind             TEXT NOT NULL DEFAULT 'legacy',
  active_task_uuid         TEXT NOT NULL DEFAULT '',
  context_task_uuid        TEXT NOT NULL DEFAULT '',
  context_revision         INTEGER NOT NULL DEFAULT 0,
  revision                 INTEGER NOT NULL DEFAULT 0,
  turn_count               INTEGER NOT NULL DEFAULT 0,
  openbear_session_uuid    TEXT DEFAULT '',
  chat_id                  INTEGER DEFAULT 0,
  workflow_uuid            TEXT DEFAULT '',
  agent_key                TEXT DEFAULT '',
  status                   TEXT DEFAULT 'active',
  title                    TEXT DEFAULT '',
  summary                  TEXT DEFAULT '',
  last_task_uuid           TEXT DEFAULT '',
  metadata_json            TEXT DEFAULT '{}',
  created_at               INTEGER DEFAULT 0,
  updated_at               INTEGER DEFAULT 0,
  closed_at                INTEGER DEFAULT 0
);
CREATE TABLE rath_agents (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key            TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT DEFAULT '',
  system_prompt        TEXT DEFAULT '',
  model                TEXT DEFAULT '',
  think_level          TEXT DEFAULT '',
  tool_allowlist_json  TEXT DEFAULT '[]',
  sort                 INTEGER DEFAULT 0,
  enabled              INTEGER DEFAULT 1,
  created_at           INTEGER DEFAULT 0,
  updated_at           INTEGER DEFAULT 0,
  UNIQUE(agent_key)
);
CREATE TABLE rath_task_artifacts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_uuid     TEXT NOT NULL UNIQUE,
  task_uuid         TEXT NOT NULL,
  agent_key         TEXT DEFAULT '',
  kind              TEXT DEFAULT '',
  name              TEXT DEFAULT '',
  summary           TEXT DEFAULT '',
  content           TEXT DEFAULT '',
  content_type      TEXT DEFAULT 'text/plain',
  source_refs_json  TEXT DEFAULT '[]',
  size_bytes        INTEGER DEFAULT 0,
  created_at        INTEGER DEFAULT 0
);
CREATE TABLE rath_task_controls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  control_uuid   TEXT NOT NULL UNIQUE,
  task_uuid       TEXT NOT NULL,
  action          TEXT NOT NULL,
  message         TEXT DEFAULT '',
  requested_by    TEXT DEFAULT '',
  status          TEXT DEFAULT 'pending',
  created_at      INTEGER DEFAULT 0,
  applied_at      INTEGER DEFAULT 0,
  result          TEXT DEFAULT '',
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  response_status TEXT DEFAULT '',
  response_reason TEXT DEFAULT '',
  response_plan_impact TEXT DEFAULT '',
  response_next_action TEXT DEFAULT '',
  responded_at    INTEGER DEFAULT 0
);
CREATE TABLE rath_task_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uuid    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           INTEGER DEFAULT 0,
  kind         TEXT NOT NULL,
  agent_key    TEXT DEFAULT '',
  summary      TEXT DEFAULT '',
  detail_json  TEXT DEFAULT '{}',
  elapsed_ms   INTEGER DEFAULT 0,
  UNIQUE(task_uuid, seq)
);
CREATE TABLE rath_task_model_contexts (
  task_uuid       TEXT PRIMARY KEY,
  protocol        TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  session_id      TEXT NOT NULL DEFAULT '',
  state_json      TEXT NOT NULL DEFAULT '{}',
  revision        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER DEFAULT 0,
  updated_at      INTEGER DEFAULT 0
);
CREATE TABLE rath_task_plan_decisions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_uuid        TEXT NOT NULL UNIQUE,
  task_uuid            TEXT NOT NULL,
  expected_version     INTEGER NOT NULL,
  action               TEXT NOT NULL,
  issues_json          TEXT NOT NULL DEFAULT '[]',
  reason               TEXT DEFAULT '',
  required_changes_json TEXT NOT NULL DEFAULT '[]',
  granted_tools_json    TEXT NOT NULL DEFAULT '[]',
  requested_by         TEXT DEFAULT '',
  user_instruction_id  TEXT DEFAULT '',
  request_id           TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  UNIQUE(task_uuid, request_id)
);
CREATE TABLE rath_task_plan_evidence (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_uuid  TEXT NOT NULL UNIQUE,
  task_uuid      TEXT NOT NULL,
  plan_version   INTEGER NOT NULL,
  step_id        TEXT NOT NULL,
  criterion_id   TEXT DEFAULT '',
  evidence_type  TEXT NOT NULL,
  reference      TEXT NOT NULL,
  summary        TEXT NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  request_id     TEXT DEFAULT '',
  created_at     INTEGER NOT NULL
);
CREATE TABLE rath_task_plan_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uuid    TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  operation    TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL DEFAULT '',
  result_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(task_uuid, request_id)
);
CREATE TABLE rath_task_plan_state (
  task_uuid                 TEXT PRIMARY KEY,
  phase                     TEXT NOT NULL DEFAULT 'drafting',
  active_plan_version       INTEGER NOT NULL DEFAULT 0,
  pending_plan_version      INTEGER NOT NULL DEFAULT 0,
  current_step_id           TEXT DEFAULT '',
  approval_cycle            INTEGER NOT NULL DEFAULT 0,
  revision_count            INTEGER NOT NULL DEFAULT 0,
  final_outputs_state_json  TEXT NOT NULL DEFAULT '{}',
  approved_tools_json       TEXT NOT NULL DEFAULT '[]',
  last_controller_guidance  TEXT DEFAULT '',
  row_revision              INTEGER NOT NULL DEFAULT 1,
  updated_at                INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE rath_task_plan_step_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uuid           TEXT NOT NULL,
  plan_version        INTEGER NOT NULL,
  step_id             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  result              TEXT DEFAULT '',
  criteria_state_json TEXT NOT NULL DEFAULT '{}',
  blocker_json        TEXT NOT NULL DEFAULT '{}',
  started_at          INTEGER NOT NULL DEFAULT 0,
  completed_at        INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL DEFAULT 0,
  row_revision        INTEGER NOT NULL DEFAULT 1,
  UNIQUE(task_uuid, plan_version, step_id)
);
CREATE TABLE rath_task_plan_versions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uuid          TEXT NOT NULL,
  version            INTEGER NOT NULL,
  plan_type          TEXT NOT NULL, -- initial|replan
  parent_version     INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'submitted',
  plan_json          TEXT NOT NULL,
  plan_hash          TEXT NOT NULL,
  change_reason      TEXT DEFAULT '',
  submit_request_id  TEXT NOT NULL,
  submitted_at       INTEGER NOT NULL,
  decided_at         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(task_uuid, version),
  UNIQUE(task_uuid, submit_request_id)
);
CREATE TABLE rath_tasks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uuid             TEXT NOT NULL UNIQUE,
  chat_id               INTEGER DEFAULT 0,
  parent_session_uuid   TEXT DEFAULT '',
  agent_session_uuid    TEXT DEFAULT '',
  caller_agent_session_uuid TEXT DEFAULT '',
  parent_task_uuid      TEXT DEFAULT '',
  workflow_uuid         TEXT DEFAULT '',
  title                 TEXT DEFAULT '',
  status                TEXT DEFAULT 'queued',
  control_state         TEXT DEFAULT '',
  current_agent_key     TEXT DEFAULT '',
  current_status        TEXT DEFAULT '',
  input_json            TEXT DEFAULT '{}',
  output_json           TEXT DEFAULT '{}',
  error                 TEXT DEFAULT '',
  model_call_count      INTEGER DEFAULT 0,
  tool_call_count       INTEGER DEFAULT 0,
  work_tool_call_count  INTEGER DEFAULT 0,
  plan_tool_call_count  INTEGER DEFAULT 0,
  input_tokens          INTEGER DEFAULT 0,
  output_tokens         INTEGER DEFAULT 0,
  cache_read_tokens     INTEGER DEFAULT 0,
  cache_write_tokens    INTEGER DEFAULT 0,
  last_input_tokens     INTEGER DEFAULT 0,
  last_output_tokens    INTEGER DEFAULT 0,
  last_cache_read_tokens INTEGER DEFAULT 0,
  last_cache_write_tokens INTEGER DEFAULT 0,
  cost_usd              REAL DEFAULT 0,
  started_at            INTEGER DEFAULT 0,
  updated_at            INTEGER DEFAULT 0,
  finished_at           INTEGER DEFAULT 0,
  -- Parent Web/main-controller ownership. Agent internal transcript stays in
  -- output_json checkpoints; these fields bind the task back to the spawning turn.
  turn_uuid             TEXT DEFAULT '',
  parent_turn_uuid      TEXT DEFAULT '',
  run_root_turn_uuid    TEXT DEFAULT ''
);
CREATE TABLE rath_workflows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_uuid   TEXT NOT NULL UNIQUE,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  kind            TEXT DEFAULT '',
  enabled         INTEGER DEFAULT 1,
  config_json     TEXT DEFAULT '{}',
  created_at      INTEGER DEFAULT 0,
  updated_at      INTEGER DEFAULT 0
);
CREATE TABLE runtime_accounting_claims (
  action_id TEXT PRIMARY KEY REFERENCES runtime_actions(action_id),
  created_at INTEGER NOT NULL
);
CREATE TABLE runtime_actions (
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
CREATE TABLE runtime_commands (
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
CREATE TABLE runtime_runs (
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
CREATE TABLE sessions (
  chat_id                  INTEGER PRIMARY KEY,
  created_at               INTEGER,
  updated_at               INTEGER,
  thinking_level           TEXT DEFAULT '',
  fast_mode                INTEGER DEFAULT 0,  -- 1=本会话请求支持 Fast 的模型时携带对应协议的加速参数
  show_thinking            INTEGER DEFAULT -1, -- -1=跟随配置；0=隐藏；1=显示
  session_uuid             TEXT DEFAULT '',   -- 稳定会话 id（同会话不变，新会话换新），供上游 prompt cache 亲和
  system_snapshot          TEXT DEFAULT '',   -- 系统提示词快照（会话内锁定，防缓存撕裂）
  usage_input_tokens       INTEGER DEFAULT 0,
  usage_output_tokens      INTEGER DEFAULT 0,
  usage_cache_read_tokens  INTEGER DEFAULT 0,
  usage_cache_write_tokens INTEGER DEFAULT 0,
  usage_cost_usd           REAL DEFAULT 0,
  last_input_tokens        INTEGER DEFAULT 0,
  last_output_tokens       INTEGER DEFAULT 0,
  last_cache_read_tokens   INTEGER DEFAULT 0,
  last_cache_write_tokens  INTEGER DEFAULT 0,
  last_cost_usd            REAL DEFAULT 0,  -- 最近一次模型 API 调用费用
  last_connect_ms          INTEGER DEFAULT 0,
  last_first_token_ms      INTEGER DEFAULT 0,
  last_total_time_ms       INTEGER DEFAULT 0,
  last_run_cost_usd        REAL DEFAULT 0,  -- 最近一次 Agent run 总费用
  last_run_total_time_ms   INTEGER DEFAULT 0,
  last_run_model_calls     INTEGER DEFAULT 0,
  last_run_tool_calls      INTEGER DEFAULT 0,
  last_model               TEXT DEFAULT '',
  last_protocol            TEXT DEFAULT '',
  last_think_level         TEXT DEFAULT '',
  last_created_at          INTEGER DEFAULT 0,
  -- 本轮统计；新会话时全部清零
  turn_started_at          INTEGER DEFAULT 0,   -- 本轮开始时间
  stat_user_turns          INTEGER DEFAULT 0,   -- 用户回复次数
  stat_tool_calls          INTEGER DEFAULT 0,   -- 工具调用次数
  stat_model_calls         INTEGER DEFAULT 0,   -- 模型调用次数（含重试）
  stat_model_ok            INTEGER DEFAULT 0,   -- 模型成功次数
  stat_model_retry         INTEGER DEFAULT 0,   -- 模型重试次数
  stat_model_fail          INTEGER DEFAULT 0,   -- 模型失败次数
  stat_connect_ms_sum      INTEGER DEFAULT 0,   -- 连接耗时累加（求平均分子）
  stat_first_token_ms_sum  INTEGER DEFAULT 0,   -- 首字耗时累加
  stat_total_time_ms_sum   INTEGER DEFAULT 0,   -- 总耗时累加
  stat_output_tokens_sum   INTEGER DEFAULT 0    -- 输出 token 累加（求平均 t/s）
);
CREATE TABLE summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  summary       TEXT,
  up_to_message_id INTEGER,
  tokens        INTEGER DEFAULT 0,
  created_at    INTEGER
);
CREATE TABLE tool_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        INTEGER NOT NULL,
  session_uuid   TEXT DEFAULT '',
  tool_name      TEXT DEFAULT '',
  status         TEXT DEFAULT 'ok',
  duration_ms    INTEGER DEFAULT 0,
  result_size    INTEGER DEFAULT 0,
  error_type     TEXT DEFAULT '',
  created_at     INTEGER
);
CREATE TABLE user_interactions (
  interaction_id    TEXT PRIMARY KEY,
  owner_chat_id     INTEGER NOT NULL,
  conversation_uuid TEXT NOT NULL,
  turn_uuid         TEXT NOT NULL DEFAULT '',
  tool_call_id      TEXT NOT NULL DEFAULT '',
  payload_json      TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending',
  revision          INTEGER NOT NULL DEFAULT 1,
  expires_at_ms     INTEGER NOT NULL,
  created_at_ms     INTEGER NOT NULL,
  resolved_at_ms    INTEGER NOT NULL DEFAULT 0,
  result_json       TEXT NOT NULL DEFAULT '',
  answer_digest     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE web_artifacts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_uuid      TEXT NOT NULL UNIQUE,
  conversation_uuid  TEXT NOT NULL,
  owner_chat_id      INTEGER NOT NULL,
  internal_chat_id   INTEGER NOT NULL,
  turn_uuid          TEXT DEFAULT '',
  message_id         INTEGER DEFAULT 0,
  op_id              TEXT DEFAULT '',
  file_name          TEXT NOT NULL,
  mime_type          TEXT DEFAULT 'application/octet-stream',
  size_bytes         INTEGER DEFAULT 0,
  sha256             TEXT NOT NULL,
  storage_path       TEXT NOT NULL,
  source_path        TEXT DEFAULT '',
  source_url         TEXT DEFAULT '',
  created_at         INTEGER,
  deleted_at         INTEGER DEFAULT 0
);
CREATE TABLE web_catalog_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    owner_chat_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE web_controller_context_snapshots (
  chat_id INTEGER PRIMARY KEY,
  session_uuid TEXT NOT NULL DEFAULT '',
  summary_id INTEGER NOT NULL DEFAULT 0,
  known INTEGER NOT NULL DEFAULT 1,
  tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE web_conversation_defaults (
  owner_chat_id         INTEGER PRIMARY KEY,
  main_model            TEXT DEFAULT '',
  main_thinking_level   TEXT DEFAULT '',
  main_fast_mode        INTEGER DEFAULT 0,
  agent_model           TEXT DEFAULT '',
  agent_think_level     TEXT DEFAULT '',
  agent_fast_mode       INTEGER DEFAULT -1, -- -1=跟随主会话；0=关；1=开
  revision              INTEGER NOT NULL DEFAULT 1,
  updated_at            INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE web_conversation_folders (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_uuid           TEXT NOT NULL UNIQUE,
  owner_chat_id         INTEGER NOT NULL,
  parent_uuid           TEXT NOT NULL DEFAULT '',
  name                  TEXT NOT NULL,
  workspace_dir         TEXT NOT NULL DEFAULT '',
  prompt_markdown       TEXT NOT NULL DEFAULT '',
  -- Sparse per-field overrides; missing keys inherit, false/null remain explicit.
  run_defaults_json     TEXT NOT NULL DEFAULT '{}',
  pinned_at             INTEGER NOT NULL DEFAULT 0,
  display_order         REAL,
  created_at            INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE web_conversations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_uuid     TEXT NOT NULL UNIQUE,
  owner_chat_id         INTEGER NOT NULL,
  internal_chat_id      INTEGER NOT NULL UNIQUE,
  title                 TEXT DEFAULT '',
  model                 TEXT DEFAULT '',
  context_strategy      TEXT NOT NULL DEFAULT 'sliding_window',
  -- Completed executions and the exact completion version seen by the Web user.
  activity_version      INTEGER NOT NULL DEFAULT 0,
  activity_read_version INTEGER NOT NULL DEFAULT 0,
  activity_result_json  TEXT NOT NULL DEFAULT '{}',
  -- 会话级 Agent 默认运行配置；空/-1 表示跟随主会话或模型默认。
  agent_model           TEXT DEFAULT '',
  agent_think_level     TEXT DEFAULT '',
  agent_fast_mode       INTEGER DEFAULT -1, -- -1=跟随主会话 Fast；0=关；1=开
  status                TEXT DEFAULT 'idle', -- idle|running|stopping|error
  current_status        TEXT DEFAULT '',
  last_error            TEXT DEFAULT '',
  created_at            INTEGER,
  updated_at            INTEGER,
  pinned_at             INTEGER DEFAULT 0,
  -- 用户在各自置顶/非置顶组内调整的持久展示顺序；NULL 回退到创建时间排序。
  display_order         REAL,
  archived_at           INTEGER DEFAULT 0,
  -- 真实可见交互与默认会话选择的轻量投影。NULL 仅表示旧库尚未惰性回填；
  -- 0 表示已知没有对应交互，不能把两者混为一谈。
  last_interaction_at_ms INTEGER,
  last_conversation_at  INTEGER,
  -- 只在可见 user/assistant 正文快照变化时递增，供引用目录按会话失效。
  reference_revision    INTEGER NOT NULL DEFAULT 0,
  -- 空值属于“临时会话”；归档只改变状态，不清除目录归属。
  folder_uuid           TEXT NOT NULL DEFAULT ''
);
CREATE TABLE web_event_frames (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_uuid  TEXT NOT NULL,
  internal_chat_id   INTEGER DEFAULT 0,
  owner_chat_id      INTEGER DEFAULT 0,
  frame_seq          INTEGER NOT NULL,
  op_id              TEXT NOT NULL,
  op_type            TEXT NOT NULL,
  action             TEXT NOT NULL,
  turn_uuid          TEXT DEFAULT '',
  parent_turn_uuid   TEXT DEFAULT '',
  run_root_turn_uuid TEXT DEFAULT '',
  target_type        TEXT DEFAULT '',
  target_id          TEXT DEFAULT '',
  task_uuid          TEXT DEFAULT '',
  run_id             TEXT DEFAULT '',
  revision           INTEGER NOT NULL,
  display_seq        INTEGER NOT NULL,
  payload_json       TEXT NOT NULL,
  debug_json         TEXT DEFAULT '{}',
  created_at_ms      INTEGER NOT NULL,
  updated_at_ms      INTEGER NOT NULL
);
CREATE TABLE web_hidden_operations (
  conversation_uuid TEXT NOT NULL,
  op_id TEXT NOT NULL,
  hidden_at_ms INTEGER NOT NULL,
  PRIMARY KEY (conversation_uuid, op_id)
);
CREATE TABLE web_login_failures (
  ip              TEXT PRIMARY KEY,
  failed_count    INTEGER DEFAULT 0,
  first_failed_at INTEGER DEFAULT 0,
  last_failed_at  INTEGER DEFAULT 0,
  blocked_until   INTEGER DEFAULT 0
);
CREATE TABLE web_login_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_uuid    TEXT NOT NULL UNIQUE,
  chat_id         INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'pending',
  nonce_hash      TEXT DEFAULT '',
  ip              TEXT DEFAULT '',
  user_agent      TEXT DEFAULT '',
  created_at      INTEGER DEFAULT 0,
  expires_at      INTEGER DEFAULT 0,
  decided_at      INTEGER DEFAULT 0,
  decided_by      INTEGER DEFAULT 0
);
CREATE TABLE web_memory_reminders (
  chat_id INTEGER NOT NULL,
  session_uuid TEXT NOT NULL DEFAULT '',
  summary_id INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id, summary_id)
);
CREATE TABLE web_operation_messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_uuid  TEXT NOT NULL,
  op_id               TEXT NOT NULL,
  message_id          INTEGER NOT NULL,
  relation_kind       TEXT DEFAULT 'transcript',
  created_at_ms       INTEGER NOT NULL,
  UNIQUE(conversation_uuid, op_id, message_id),
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE TABLE web_operations (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_uuid           TEXT NOT NULL,
  internal_chat_id            INTEGER DEFAULT 0,
  op_id                       TEXT NOT NULL,
  op_type                     TEXT NOT NULL,
  turn_uuid                   TEXT DEFAULT '',
  parent_turn_uuid            TEXT DEFAULT '',
  run_root_turn_uuid          TEXT DEFAULT '',
  target_type                 TEXT DEFAULT '',
  target_id                   TEXT DEFAULT '',
  task_uuid                   TEXT DEFAULT '',
  run_id                      TEXT DEFAULT '',
  display_seq                 INTEGER NOT NULL,
  status                      TEXT DEFAULT '',
  lifecycle                   TEXT DEFAULT '',
  internal                    INTEGER DEFAULT 0,
  source                      TEXT DEFAULT '',
  transcript_message_ids_json TEXT DEFAULT '[]',
  revision                    INTEGER NOT NULL,
  payload_json                TEXT NOT NULL,
  created_at_ms               INTEGER NOT NULL,
  updated_at_ms               INTEGER NOT NULL
);
CREATE TABLE web_push_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(subscription_id, event_key)
);
CREATE TABLE web_push_runs (
  root_uuid TEXT PRIMARY KEY,
  conversation_uuid TEXT NOT NULL,
  owner_chat_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL
);
CREATE TABLE web_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  owner_chat_id INTEGER NOT NULL,
  session_token_hash TEXT NOT NULL,
  subscription_json TEXT NOT NULL,
  origin TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE web_reference_bundles (
    bundle_uuid TEXT PRIMARY KEY,
    conversation_uuid TEXT NOT NULL,
    op_id TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    material_json TEXT NOT NULL DEFAULT '[]',
    protected_material TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE TABLE web_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token_hash  TEXT NOT NULL UNIQUE,
  chat_id             INTEGER DEFAULT 0,
  created_at          INTEGER DEFAULT 0,
  expires_at          INTEGER DEFAULT 0,
  last_seen_at        INTEGER DEFAULT 0,
  revoked_at          INTEGER DEFAULT 0,
  ip                  TEXT DEFAULT '',
  user_agent          TEXT DEFAULT ''
);
CREATE TABLE web_task_notifications (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_uuid     TEXT NOT NULL UNIQUE,
  notification_key      TEXT NOT NULL UNIQUE,
  conversation_uuid     TEXT NOT NULL,
  internal_chat_id      INTEGER NOT NULL,
  owner_chat_id         INTEGER DEFAULT 0,
  task_uuid             TEXT DEFAULT '',
  kind                  TEXT DEFAULT 'task-notification',
  task_status           TEXT DEFAULT '',
  payload_json          TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'pending', -- pending|processing|paused (awaiting user)|delivered|suppressed
  attempts              INTEGER NOT NULL DEFAULT 0,
  claim_token           TEXT DEFAULT '',
  claimed_at            INTEGER DEFAULT 0,
  next_attempt_at       INTEGER DEFAULT 0,
  last_error            TEXT DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  delivered_at          INTEGER DEFAULT 0
);
CREATE TABLE web_temporary_conversation_properties (
  owner_chat_id         INTEGER PRIMARY KEY,
  prompt_markdown       TEXT NOT NULL DEFAULT '',
  run_defaults_json     TEXT NOT NULL DEFAULT '{}',
  updated_at            INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE web_tg_messages (
  owner_chat_id          INTEGER NOT NULL,
  telegram_message_id    INTEGER NOT NULL,
  conversation_uuid      TEXT NOT NULL,
  root_turn_uuid         TEXT NOT NULL DEFAULT '',
  role                   TEXT NOT NULL DEFAULT 'notification',
  created_at             INTEGER NOT NULL,
  PRIMARY KEY (owner_chat_id, telegram_message_id)
);
CREATE TABLE web_tg_notification_outbox (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_key          TEXT NOT NULL UNIQUE,
  root_turn_uuid        TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  payload_json          TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'pending', -- pending|processing|sent|cancelled|failed
  deliver_after         INTEGER NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  telegram_message_ids_json TEXT DEFAULT '[]',
  last_error            TEXT DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  delivered_at          INTEGER DEFAULT 0
);
CREATE TABLE web_tg_notification_runs (
  root_turn_uuid       TEXT PRIMARY KEY,
  conversation_uuid    TEXT NOT NULL,
  owner_chat_id        INTEGER NOT NULL,
  internal_chat_id     INTEGER NOT NULL,
  title                TEXT DEFAULT '',
  model                TEXT DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'running', -- running|completed|failed|interrupted|short
  config_json          TEXT NOT NULL,
  result_text          TEXT DEFAULT '',
  started_at           INTEGER NOT NULL,
  threshold_at         INTEGER NOT NULL,
  completed_at         INTEGER DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE TABLE web_tg_reply_inbox (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_chat_id          INTEGER NOT NULL,
  telegram_message_id    INTEGER NOT NULL,
  reply_to_message_id    INTEGER NOT NULL,
  conversation_uuid      TEXT NOT NULL,
  text                   TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'pending',
  root_turn_uuid         TEXT NOT NULL DEFAULT '',
  response_text          TEXT NOT NULL DEFAULT '',
  response_sent          INTEGER NOT NULL DEFAULT 0,
  response_attempts      INTEGER NOT NULL DEFAULT 0,
  response_after         INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE (owner_chat_id, telegram_message_id)
);
CREATE TABLE web_visibility_state (
  conversation_uuid TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_chat ON messages(chat_id, id, compacted);
CREATE INDEX idx_messages_chat_turn
  ON messages(chat_id, turn_uuid, id);
CREATE INDEX idx_messages_chat_root_turn
  ON messages(chat_id, run_root_turn_uuid, id);
CREATE INDEX idx_messages_user_chat_time
  ON messages(chat_id, created_at)
  WHERE role='user' AND COALESCE(task_uuid,'')='';
CREATE INDEX idx_messages_task
  ON messages(task_uuid, id);
CREATE INDEX idx_messages_conversation_turn
  ON messages(conversation_uuid, turn_uuid, id);
CREATE INDEX idx_controller_model_contexts_conversation
  ON controller_model_contexts(conversation_uuid);
CREATE INDEX idx_controller_model_contexts_updated
  ON controller_model_contexts(updated_at DESC);
CREATE INDEX idx_web_conversation_folders_parent
  ON web_conversation_folders(owner_chat_id, parent_uuid, pinned_at DESC, display_order, id);
CREATE INDEX idx_web_conversation_folders_name
  ON web_conversation_folders(owner_chat_id, name);
CREATE INDEX idx_web_conversations_owner_time
  ON web_conversations(owner_chat_id, archived_at, pinned_at DESC, updated_at DESC, id DESC);
CREATE INDEX idx_web_conversations_owner_created
  ON web_conversations(owner_chat_id, archived_at, created_at DESC, id DESC);
CREATE INDEX idx_web_conversations_internal_chat
  ON web_conversations(internal_chat_id);
CREATE INDEX idx_web_conversations_folder_order
  ON web_conversations(owner_chat_id, folder_uuid, archived_at, pinned_at DESC, display_order, id);
CREATE INDEX idx_web_conversations_owner_recent
  ON web_conversations(owner_chat_id, archived_at, last_interaction_at_ms DESC, conversation_uuid ASC);
CREATE INDEX idx_web_conversations_owner_default
  ON web_conversations(owner_chat_id, archived_at, last_conversation_at DESC, created_at DESC, id DESC);
CREATE TRIGGER web_conversation_last_message_insert
AFTER INSERT ON messages
WHEN COALESCE(NEW.task_uuid,'')=''
 AND (NEW.role='user' OR (NEW.role='assistant' AND TRIM(COALESCE(NEW.content,''))<>''))
BEGIN
  UPDATE web_conversations
  SET last_conversation_at=MAX(last_conversation_at,COALESCE(NEW.created_at,0))
  WHERE internal_chat_id=NEW.chat_id AND last_conversation_at IS NOT NULL;
END;
CREATE TRIGGER web_conversation_last_message_delete
AFTER DELETE ON messages
WHEN COALESCE(OLD.task_uuid,'')=''
 AND (OLD.role='user' OR (OLD.role='assistant' AND TRIM(COALESCE(OLD.content,''))<>''))
BEGIN
  UPDATE web_conversations
  SET last_conversation_at=COALESCE((
    SELECT MAX(m.created_at) FROM messages m
    WHERE m.chat_id=OLD.chat_id AND COALESCE(m.task_uuid,'')=''
      AND (m.role='user' OR (m.role='assistant' AND TRIM(COALESCE(m.content,''))<>''))
  ),0)
  WHERE internal_chat_id=OLD.chat_id AND last_conversation_at IS NOT NULL
    AND COALESCE(OLD.created_at,0)>=last_conversation_at;
END;
CREATE TRIGGER web_conversation_last_message_update
AFTER UPDATE OF chat_id,role,content,created_at,task_uuid ON messages
BEGIN
  UPDATE web_conversations
  SET last_conversation_at=COALESCE((
    SELECT MAX(m.created_at) FROM messages m
    WHERE m.chat_id=OLD.chat_id AND COALESCE(m.task_uuid,'')=''
      AND (m.role='user' OR (m.role='assistant' AND TRIM(COALESCE(m.content,''))<>''))
  ),0)
  WHERE internal_chat_id=OLD.chat_id AND last_conversation_at IS NOT NULL;
  UPDATE web_conversations
  SET last_conversation_at=COALESCE((
    SELECT MAX(m.created_at) FROM messages m
    WHERE m.chat_id=NEW.chat_id AND COALESCE(m.task_uuid,'')=''
      AND (m.role='user' OR (m.role='assistant' AND TRIM(COALESCE(m.content,''))<>''))
  ),0)
  WHERE internal_chat_id=NEW.chat_id AND last_conversation_at IS NOT NULL;
END;
CREATE UNIQUE INDEX ux_conversation_task_memories_active_name
  ON conversation_task_memories(conversation_uuid, scope_type, task_uuid, name COLLATE NOCASE)
  WHERE deleted_at=0;
CREATE UNIQUE INDEX ux_conversation_task_memories_idempotency
  ON conversation_task_memories(conversation_uuid, scope_type, task_uuid, idempotency_key)
  WHERE idempotency_key<>'';
CREATE INDEX idx_conversation_task_memories_scope
  ON conversation_task_memories(conversation_uuid, scope_type, task_uuid, deleted_at, updated_at DESC);
CREATE INDEX idx_conversation_task_memories_catalog
  ON conversation_task_memories(conversation_uuid, scope_type, task_uuid, auto_reinject_catalog, visible_to_agents, deleted_at);
CREATE INDEX idx_web_artifacts_conversation_uuid
  ON web_artifacts(conversation_uuid, artifact_uuid);
CREATE INDEX idx_web_artifacts_owner_time
  ON web_artifacts(owner_chat_id, created_at DESC, id DESC);
CREATE INDEX idx_web_artifacts_conversation_hash
  ON web_artifacts(conversation_uuid, sha256, file_name, deleted_at);
CREATE UNIQUE INDEX ux_web_event_frames_conv_seq
  ON web_event_frames(conversation_uuid, frame_seq);
CREATE INDEX idx_web_event_frames_conv_op_revision
  ON web_event_frames(conversation_uuid, op_id, revision);
CREATE INDEX idx_web_event_frames_conv_turn_seq
  ON web_event_frames(conversation_uuid, turn_uuid, frame_seq);
CREATE INDEX idx_web_event_frames_conv_target_seq
  ON web_event_frames(conversation_uuid, target_type, target_id, frame_seq);
CREATE INDEX idx_web_event_frames_task_seq
  ON web_event_frames(task_uuid, frame_seq);
CREATE INDEX idx_web_event_frames_internal_seq
  ON web_event_frames(internal_chat_id, frame_seq);
CREATE UNIQUE INDEX ux_web_operations_conv_op
  ON web_operations(conversation_uuid, op_id);
CREATE TRIGGER web_hidden_operations_insert
AFTER INSERT ON web_hidden_operations BEGIN
  INSERT INTO web_visibility_state(conversation_uuid, revision) VALUES(NEW.conversation_uuid, 1)
  ON CONFLICT(conversation_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER web_hidden_operations_delete
AFTER DELETE ON web_hidden_operations BEGIN
  INSERT INTO web_visibility_state(conversation_uuid, revision) VALUES(OLD.conversation_uuid, 1)
  ON CONFLICT(conversation_uuid) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER web_operation_visibility_cleanup
AFTER DELETE ON web_operations BEGIN
  DELETE FROM web_hidden_operations WHERE conversation_uuid=OLD.conversation_uuid AND op_id=OLD.op_id;
END;
CREATE TRIGGER web_conversation_visibility_cleanup
AFTER DELETE ON web_conversations BEGIN
  DELETE FROM web_hidden_operations WHERE conversation_uuid=OLD.conversation_uuid;
  DELETE FROM web_visibility_state WHERE conversation_uuid=OLD.conversation_uuid;
END;
CREATE INDEX idx_web_operations_conv_display
  ON web_operations(conversation_uuid, display_seq, id);
CREATE INDEX idx_web_operations_stats_conversation_time
  ON web_operations(conversation_uuid, created_at_ms)
  WHERE op_type='stats';
CREATE INDEX idx_web_operations_conv_turn_display
  ON web_operations(conversation_uuid, turn_uuid, display_seq);
CREATE INDEX idx_web_operations_conv_target_display
  ON web_operations(conversation_uuid, target_type, target_id, display_seq);
CREATE INDEX idx_web_operations_task_display
  ON web_operations(task_uuid, display_seq);
CREATE INDEX idx_web_operations_run_display
  ON web_operations(run_id, display_seq);
CREATE INDEX idx_web_operations_internal_status
  ON web_operations(internal_chat_id, status, updated_at_ms DESC);
CREATE INDEX idx_web_operations_active_conversation
  ON web_operations(conversation_uuid, lifecycle, op_type, created_at_ms)
  WHERE op_type!='notice' AND lifecycle IN ('active','paused','waiting_control');
CREATE TRIGGER web_operation_reference_insert
AFTER INSERT ON web_operations
WHEN NEW.op_type IN ('user_message','assistant_message')
BEGIN
  UPDATE web_conversations SET reference_revision=reference_revision+1
  WHERE conversation_uuid=NEW.conversation_uuid;
END;
CREATE TRIGGER web_operation_reference_update
AFTER UPDATE OF op_type,turn_uuid,display_seq,internal,payload_json ON web_operations
WHEN OLD.op_type IN ('user_message','assistant_message')
  OR NEW.op_type IN ('user_message','assistant_message')
BEGIN
  UPDATE web_conversations SET reference_revision=reference_revision+1
  WHERE conversation_uuid IN (OLD.conversation_uuid,NEW.conversation_uuid);
END;
CREATE TRIGGER web_operation_reference_delete
AFTER DELETE ON web_operations
WHEN OLD.op_type IN ('user_message','assistant_message')
BEGIN
  UPDATE web_conversations SET reference_revision=reference_revision+1
  WHERE conversation_uuid=OLD.conversation_uuid;
END;
CREATE INDEX idx_web_operation_messages_op
  ON web_operation_messages(conversation_uuid, op_id, message_id);
CREATE INDEX idx_web_operation_messages_message
  ON web_operation_messages(message_id, conversation_uuid, op_id);
CREATE INDEX idx_web_task_notifications_delivery
  ON web_task_notifications(state, next_attempt_at, conversation_uuid, id);
CREATE INDEX idx_web_task_notifications_task
  ON web_task_notifications(task_uuid, id DESC);
CREATE INDEX idx_web_tg_notification_runs_status
  ON web_tg_notification_runs(status, threshold_at, updated_at);
CREATE INDEX idx_web_tg_notification_runs_conversation
  ON web_tg_notification_runs(conversation_uuid, started_at DESC);
CREATE INDEX idx_web_tg_notification_outbox_delivery
  ON web_tg_notification_outbox(state, deliver_after, id);
CREATE INDEX idx_web_tg_notification_outbox_turn
  ON web_tg_notification_outbox(root_turn_uuid, id);
CREATE INDEX idx_summaries_chat ON summaries(chat_id, id);
CREATE INDEX idx_model_calls_chat_time ON model_calls(chat_id, created_at DESC, id DESC);
CREATE INDEX idx_model_calls_model_time ON model_calls(model, created_at DESC);
CREATE INDEX idx_model_calls_kind_time ON model_calls(chat_id, call_kind, created_at DESC, id DESC);
CREATE INDEX idx_tool_calls_chat_time ON tool_calls(chat_id, created_at DESC, id DESC);
CREATE INDEX idx_tool_calls_name_time ON tool_calls(tool_name, created_at DESC);
CREATE INDEX idx_operations_chat_time
  ON operations(chat_id, started_at DESC, id DESC);
CREATE INDEX idx_web_login_requests_uuid
  ON web_login_requests(request_uuid);
CREATE INDEX idx_web_login_requests_time
  ON web_login_requests(created_at DESC, id DESC);
CREATE INDEX idx_web_login_failures_blocked
  ON web_login_failures(blocked_until DESC);
CREATE INDEX idx_web_sessions_hash
  ON web_sessions(session_token_hash);
CREATE INDEX idx_web_sessions_expiry
  ON web_sessions(expires_at DESC, id DESC);
CREATE INDEX idx_audit_logs_time
  ON audit_logs(created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_memory_entries_ref
  ON memory_entries(ref) WHERE ref <> '';
CREATE INDEX idx_memory_entries_category_sort
  ON memory_entries(category_id, archived, enabled, sort, id);
CREATE INDEX idx_memory_secrets_sort
  ON memory_secrets(archived, enabled, sort, id);
CREATE INDEX idx_memory_secrets_group_sort
  ON memory_secrets(grp, sort, id);
CREATE INDEX idx_memory_docs_sort
  ON memory_docs(archived, enabled, importance DESC, id);
CREATE INDEX idx_memory_docs_group_sort
  ON memory_docs(grp, sort, id);
CREATE INDEX idx_memory_templates_active
  ON memory_templates(is_active, id DESC);
CREATE INDEX idx_memory_templates_agent_active
  ON memory_templates(is_agent_active, id DESC);
CREATE INDEX idx_memory_render_logs_time
  ON memory_render_logs(ts DESC, id DESC);
CREATE INDEX idx_rath_workflows_enabled
  ON rath_workflows(enabled, slug);
CREATE INDEX idx_rath_agents_sort
  ON rath_agents(enabled, sort, id);
CREATE INDEX idx_rath_agent_sessions_openbear_agent
  ON rath_agent_sessions(openbear_session_uuid, workflow_uuid, agent_key, status, updated_at DESC);
CREATE UNIQUE INDEX ux_rath_agent_sessions_active_openbear_agent
  ON rath_agent_sessions(openbear_session_uuid, workflow_uuid, agent_key)
  WHERE status='active' AND session_kind='legacy';
CREATE INDEX idx_rath_agent_sessions_chat_time
  ON rath_agent_sessions(chat_id, updated_at DESC, id DESC);
CREATE INDEX idx_rath_tasks_chat_time
  ON rath_tasks(chat_id, updated_at DESC, id DESC);
CREATE INDEX idx_rath_tasks_status_time
  ON rath_tasks(status, updated_at DESC, id DESC);
CREATE INDEX idx_rath_tasks_session
  ON rath_tasks(parent_session_uuid);
CREATE INDEX idx_rath_tasks_agent_session
  ON rath_tasks(agent_session_uuid, updated_at DESC);
CREATE INDEX idx_rath_tasks_caller_agent_session
  ON rath_tasks(caller_agent_session_uuid, updated_at DESC);
CREATE INDEX idx_rath_tasks_parent_task
  ON rath_tasks(parent_task_uuid, updated_at DESC);
CREATE INDEX idx_rath_tasks_root_turn
  ON rath_tasks(run_root_turn_uuid, updated_at DESC, id DESC);
CREATE INDEX idx_rath_tasks_turn
  ON rath_tasks(turn_uuid, updated_at DESC, id DESC);
CREATE INDEX idx_rath_task_model_contexts_updated
  ON rath_task_model_contexts(updated_at DESC);
CREATE INDEX idx_rath_plan_state_phase
  ON rath_task_plan_state(phase, updated_at DESC);
CREATE INDEX idx_rath_plan_versions_task_status
  ON rath_task_plan_versions(task_uuid, status, version DESC);
CREATE INDEX idx_rath_plan_versions_hash
  ON rath_task_plan_versions(task_uuid, plan_hash, version DESC);
CREATE INDEX idx_rath_plan_decisions_task
  ON rath_task_plan_decisions(task_uuid, id ASC);
CREATE INDEX idx_rath_plan_steps_task_version
  ON rath_task_plan_step_runs(task_uuid, plan_version, status, id);
CREATE INDEX idx_rath_plan_evidence_step
  ON rath_task_plan_evidence(task_uuid, plan_version, step_id, id);
CREATE INDEX idx_rath_plan_evidence_criterion
  ON rath_task_plan_evidence(task_uuid, plan_version, step_id, criterion_id, id);
CREATE INDEX idx_rath_plan_requests_task
  ON rath_task_plan_requests(task_uuid, id DESC);
CREATE TRIGGER trg_rath_task_terminal_notification_update
AFTER UPDATE OF status ON rath_tasks
WHEN OLD.status <> NEW.status
 AND NEW.status IN ('completed','failed','needs_openbear_control')
 AND EXISTS (
   SELECT 1 FROM web_conversations c
   WHERE c.conversation_uuid=NEW.parent_session_uuid
     AND c.internal_chat_id=NEW.chat_id
 )
BEGIN
  INSERT INTO web_task_notifications (
    notification_uuid, notification_key, conversation_uuid, internal_chat_id,
    owner_chat_id, task_uuid, kind, task_status, payload_json, state,
    attempts, claim_token, claimed_at, next_attempt_at, last_error,
    created_at, updated_at, delivered_at
  ) VALUES (
    lower(hex(randomblob(16))), lower(hex(randomblob(16))),
    NEW.parent_session_uuid, NEW.chat_id,
    COALESCE((SELECT c.owner_chat_id FROM web_conversations c WHERE c.conversation_uuid=NEW.parent_session_uuid LIMIT 1),0),
    NEW.task_uuid, 'task-notification', NEW.status,
    json_object(
      'taskUuid', NEW.task_uuid,
      'status', NEW.status,
      'summary', COALESCE(NULLIF(NEW.current_status,''), NULLIF(NEW.title,''), 'Agent task completed'),
      'content', COALESCE(NULLIF(NEW.output_json,''), NULLIF(NEW.error,''), ''),
      'conversationUuid', NEW.parent_session_uuid,
      'chatId', NEW.chat_id,
      'kind', 'task-notification',
      'durableFallback', 1
    ),
    'pending', 0, '', 0, 0, '', NEW.updated_at, NEW.updated_at, 0
  );
END;
CREATE TRIGGER trg_rath_task_terminal_notification_insert
AFTER INSERT ON rath_tasks
WHEN NEW.status IN ('completed','failed','needs_openbear_control')
 AND EXISTS (
   SELECT 1 FROM web_conversations c
   WHERE c.conversation_uuid=NEW.parent_session_uuid
     AND c.internal_chat_id=NEW.chat_id
 )
BEGIN
  INSERT INTO web_task_notifications (
    notification_uuid, notification_key, conversation_uuid, internal_chat_id,
    owner_chat_id, task_uuid, kind, task_status, payload_json, state,
    attempts, claim_token, claimed_at, next_attempt_at, last_error,
    created_at, updated_at, delivered_at
  ) VALUES (
    lower(hex(randomblob(16))), lower(hex(randomblob(16))),
    NEW.parent_session_uuid, NEW.chat_id,
    COALESCE((SELECT c.owner_chat_id FROM web_conversations c WHERE c.conversation_uuid=NEW.parent_session_uuid LIMIT 1),0),
    NEW.task_uuid, 'task-notification', NEW.status,
    json_object(
      'taskUuid', NEW.task_uuid,
      'status', NEW.status,
      'summary', COALESCE(NULLIF(NEW.current_status,''), NULLIF(NEW.title,''), 'Agent task completed'),
      'content', COALESCE(NULLIF(NEW.output_json,''), NULLIF(NEW.error,''), ''),
      'conversationUuid', NEW.parent_session_uuid,
      'chatId', NEW.chat_id,
      'kind', 'task-notification',
      'durableFallback', 1
    ),
    'pending', 0, '', 0, 0, '', NEW.updated_at, NEW.updated_at, 0
  );
END;
CREATE INDEX idx_rath_task_events_task_seq
  ON rath_task_events(task_uuid, seq);
CREATE INDEX idx_rath_task_events_kind_time
  ON rath_task_events(kind, ts DESC, id DESC);
CREATE INDEX idx_rath_artifacts_task_kind
  ON rath_task_artifacts(task_uuid, kind, id);
CREATE INDEX idx_rath_controls_task_status
  ON rath_task_controls(task_uuid, status, id);
CREATE INDEX idx_rath_controls_time
  ON rath_task_controls(created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_model_calls_attempt ON model_calls(attempt_id) WHERE attempt_id != '';
CREATE INDEX idx_user_interactions_conversation
  ON user_interactions(conversation_uuid, status, created_at_ms);
CREATE INDEX idx_user_interactions_terminal
  ON user_interactions(status, resolved_at_ms);
CREATE INDEX idx_interaction_tg_outbox_delivery
  ON interaction_tg_outbox(state, deliver_after, id);
CREATE INDEX idx_interaction_tg_outbox_interaction
  ON interaction_tg_outbox(interaction_id, id);
CREATE INDEX idx_interaction_tg_drafts_owner
  ON interaction_tg_drafts(owner_chat_id, active, updated_at DESC);
CREATE INDEX idx_interaction_tg_messages_interaction
  ON interaction_tg_messages(interaction_id, active, id);
CREATE INDEX idx_interaction_tg_messages_reply
  ON interaction_tg_messages(owner_chat_id, telegram_message_id);
CREATE INDEX idx_web_tg_messages_conversation
  ON web_tg_messages(conversation_uuid);
CREATE INDEX idx_web_tg_reply_inbox_pending
  ON web_tg_reply_inbox(state, id);
CREATE INDEX idx_web_tg_reply_inbox_receipts
  ON web_tg_reply_inbox(response_sent, response_after, id);
CREATE INDEX idx_web_push_owner ON web_push_subscriptions(owner_chat_id);
CREATE INDEX idx_web_push_pending ON web_push_deliveries(state, next_attempt_at);
CREATE INDEX idx_context_windows_conversation ON context_windows(conversation_uuid);
CREATE INDEX idx_context_windows_session ON context_windows(session_uuid);
CREATE INDEX idx_context_windows_agent ON context_windows(agent_session_uuid);
CREATE INDEX idx_context_execution_owner_seq ON context_execution_events(owner_key,seq);
CREATE INDEX idx_context_execution_task ON context_execution_events(task_uuid,seq);
CREATE INDEX idx_context_execution_message ON context_execution_events(message_id);
CREATE INDEX idx_runtime_runs_owner ON runtime_runs(owner_key,created_at);
CREATE INDEX idx_runtime_actions_run ON runtime_actions(run_id,created_at,action_id);
CREATE INDEX idx_runtime_commands_pending ON runtime_commands(run_id,status,created_at);
CREATE INDEX idx_web_catalog_changes_entity ON web_catalog_changes(kind, entity_id, seq);
CREATE TRIGGER catalog_change_retention
AFTER INSERT ON web_catalog_changes WHEN NEW.seq % 1000 = 0 BEGIN
    DELETE FROM web_catalog_changes WHERE seq < NEW.seq - 10000;
END;
CREATE INDEX idx_web_reference_bundles_conversation
    ON web_reference_bundles(conversation_uuid, op_id);
CREATE TRIGGER reference_bundle_operation_deleted
AFTER DELETE ON web_operations BEGIN
    DELETE FROM web_reference_bundles WHERE conversation_uuid=OLD.conversation_uuid AND op_id=OLD.op_id;
END;
CREATE TRIGGER reference_bundle_conversation_deleted
AFTER DELETE ON web_conversations BEGIN
    DELETE FROM web_reference_bundles WHERE conversation_uuid=OLD.conversation_uuid;
END;
CREATE TRIGGER catalog_web_conversation_content_update
AFTER UPDATE OF reference_revision ON web_conversations
WHEN OLD.reference_revision IS NOT NEW.reference_revision BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('chat-content', CAST(NEW.conversation_uuid AS TEXT), NEW.owner_chat_id);
END;
CREATE TRIGGER catalog_memory_entries_insert
AFTER INSERT ON memory_entries  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('mem', CAST(NEW.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_memory_entries_delete
AFTER DELETE ON memory_entries  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('mem', CAST(OLD.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_memory_entries_update
AFTER UPDATE ON memory_entries WHEN OLD.ref IS NOT NEW.ref OR OLD.title IS NOT NEW.title OR OLD.grp IS NOT NEW.grp OR OLD.body IS NOT NEW.body OR OLD.fields_json IS NOT NEW.fields_json OR OLD.enabled IS NOT NEW.enabled OR OLD.archived IS NOT NEW.archived OR OLD.category_id IS NOT NEW.category_id OR OLD.sort IS NOT NEW.sort BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('mem', CAST(NEW.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_memory_docs_insert
AFTER INSERT ON memory_docs  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('doc', CAST(NEW.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_memory_docs_delete
AFTER DELETE ON memory_docs  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('doc', CAST(OLD.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_memory_docs_update
AFTER UPDATE ON memory_docs WHEN OLD.name IS NOT NEW.name OR OLD.title IS NOT NEW.title OR OLD.grp IS NOT NEW.grp OR OLD.content IS NOT NEW.content OR OLD.summary IS NOT NEW.summary OR OLD.enabled IS NOT NEW.enabled OR OLD.archived IS NOT NEW.archived OR OLD.sort IS NOT NEW.sort BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('doc', CAST(NEW.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_memory_secrets_insert
AFTER INSERT ON memory_secrets  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('secret', CAST(NEW.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_memory_secrets_delete
AFTER DELETE ON memory_secrets  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('secret', CAST(OLD.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_memory_secrets_update
AFTER UPDATE ON memory_secrets WHEN OLD.name IS NOT NEW.name OR OLD.grp IS NOT NEW.grp OR OLD.kv_json IS NOT NEW.kv_json OR OLD.enabled IS NOT NEW.enabled OR OLD.archived IS NOT NEW.archived OR OLD.sort IS NOT NEW.sort BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('secret', CAST(NEW.id AS TEXT), 0);
END;
CREATE TRIGGER catalog_web_conversations_insert
AFTER INSERT ON web_conversations  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('chat', CAST(NEW.conversation_uuid AS TEXT), NEW.owner_chat_id);
END;
CREATE TRIGGER catalog_web_conversations_delete
AFTER DELETE ON web_conversations  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('chat', CAST(OLD.conversation_uuid AS TEXT), OLD.owner_chat_id);
END;
CREATE TRIGGER catalog_web_conversations_update
AFTER UPDATE ON web_conversations WHEN OLD.title IS NOT NEW.title OR OLD.folder_uuid IS NOT NEW.folder_uuid OR OLD.archived_at IS NOT NEW.archived_at OR OLD.pinned_at IS NOT NEW.pinned_at OR OLD.display_order IS NOT NEW.display_order OR OLD.status IS NOT NEW.status OR OLD.current_status IS NOT NEW.current_status BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('chat', CAST(NEW.conversation_uuid AS TEXT), NEW.owner_chat_id);
END;
CREATE TRIGGER catalog_web_conversation_folders_insert
AFTER INSERT ON web_conversation_folders  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('folder', CAST(NEW.folder_uuid AS TEXT), NEW.owner_chat_id);
END;
CREATE TRIGGER catalog_web_conversation_folders_delete
AFTER DELETE ON web_conversation_folders  BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('folder', CAST(OLD.folder_uuid AS TEXT), OLD.owner_chat_id);
END;
CREATE TRIGGER catalog_web_conversation_folders_update
AFTER UPDATE ON web_conversation_folders WHEN OLD.name IS NOT NEW.name OR OLD.parent_uuid IS NOT NEW.parent_uuid OR OLD.pinned_at IS NOT NEW.pinned_at OR OLD.display_order IS NOT NEW.display_order BEGIN
    INSERT INTO web_catalog_changes(kind, entity_id, owner_chat_id)
    VALUES('folder', CAST(NEW.folder_uuid AS TEXT), NEW.owner_chat_id);
END;
DELETE FROM "sqlite_sequence";
COMMIT;
