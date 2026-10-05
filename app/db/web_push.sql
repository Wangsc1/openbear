-- Per-browser opt-in. Bind deliveries to a live authenticated session so logout,
-- expiry and remote session revocation also stop device notifications.
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  owner_chat_id INTEGER NOT NULL,
  session_token_hash TEXT NOT NULL,
  subscription_json TEXT NOT NULL,
  origin TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_push_owner ON web_push_subscriptions(owner_chat_id);
CREATE TABLE IF NOT EXISTS web_push_runs (
  root_uuid TEXT PRIMARY KEY,
  conversation_uuid TEXT NOT NULL,
  owner_chat_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_push_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  last_status INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(subscription_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_web_push_pending ON web_push_deliveries(state, next_attempt_at);
