-- Short-lived, read-only media capabilities for local network speakers.
CREATE TABLE playback_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  media_json TEXT NOT NULL
);
CREATE INDEX playback_sessions_expiry ON playback_sessions(expires_at);
