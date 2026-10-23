-- Cross-conversation requests and lead-owned conversation groups.

CREATE TABLE IF NOT EXISTS collab_requests (
  request_uuid           TEXT PRIMARY KEY,
  owner_chat_id          INTEGER NOT NULL,
  from_conversation_uuid TEXT NOT NULL,
  from_root_turn_uuid    TEXT NOT NULL DEFAULT '',
  from_tool_call_id      TEXT NOT NULL DEFAULT '',
  to_conversation_uuid   TEXT NOT NULL,
  group_uuid             TEXT NOT NULL DEFAULT '',
  parent_request_uuid    TEXT NOT NULL DEFAULT '',
  chain_json             TEXT NOT NULL DEFAULT '[]',
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'queued', -- queued|delivered|working|needs_input|completed|rejected|failed|cancelled|limit_reached
  input_rounds           INTEGER NOT NULL DEFAULT 0,
  pending_input          TEXT NOT NULL DEFAULT '',
  question               TEXT NOT NULL DEFAULT '',
  result_text            TEXT NOT NULL DEFAULT '',
  note                   TEXT NOT NULL DEFAULT '',
  target_root_turn_uuid  TEXT NOT NULL DEFAULT '',
  declaration_json       TEXT NOT NULL DEFAULT '',
  late_result_json       TEXT NOT NULL DEFAULT '',
  created_at_ms          INTEGER NOT NULL,
  updated_at_ms          INTEGER NOT NULL,
  delivered_at_ms        INTEGER NOT NULL DEFAULT 0,
  finished_at_ms         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_collab_requests_from
  ON collab_requests(from_conversation_uuid, from_root_turn_uuid, state);
CREATE INDEX IF NOT EXISTS idx_collab_requests_to
  ON collab_requests(to_conversation_uuid, state, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_collab_requests_open
  ON collab_requests(state, created_at_ms);

CREATE TABLE IF NOT EXISTS collab_request_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_uuid  TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- sent|delivered|needs_input|input|result|cancelled|late
  body          TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collab_request_events_request
  ON collab_request_events(request_uuid, id);

CREATE TABLE IF NOT EXISTS collab_groups (
  group_uuid             TEXT PRIMARY KEY,
  owner_chat_id          INTEGER NOT NULL,
  lead_conversation_uuid TEXT NOT NULL,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  prompt_json            TEXT NOT NULL DEFAULT '{}',
  workspace_dir          TEXT NOT NULL DEFAULT '',
  revision               INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collab_groups_lead
  ON collab_groups(lead_conversation_uuid, created_at);

CREATE TABLE IF NOT EXISTS collab_members (
  conversation_uuid  TEXT PRIMARY KEY,
  group_uuid         TEXT NOT NULL,
  member_key         TEXT NOT NULL,
  name               TEXT NOT NULL,
  prompt_json        TEXT NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'active', -- active|removed
  sort               INTEGER NOT NULL DEFAULT 0,
  revision           INTEGER NOT NULL DEFAULT 1,
  applied_revision   TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(group_uuid, member_key)
);
CREATE INDEX IF NOT EXISTS idx_collab_members_group
  ON collab_members(group_uuid, status, sort);

-- Facts a conversation must learn at its next model boundary: human edits for
-- the lead or an edited member, human words inside a member conversation.
-- Delivered once, never replayed.
CREATE TABLE IF NOT EXISTS collab_notes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_uuid TEXT NOT NULL,
  group_uuid        TEXT NOT NULL DEFAULT '',
  kind              TEXT NOT NULL,
  body              TEXT NOT NULL,
  created_at_ms     INTEGER NOT NULL,
  delivered_at_ms   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_collab_notes_pending
  ON collab_notes(conversation_uuid, delivered_at_ms, id);
