-- Unowned pre-login data is retained for an explicit operator migration. Never
-- assign it to the first person who signs in, or expose it to every account.
ALTER TABLE sync_changes RENAME TO legacy_sync_changes;
ALTER TABLE import_requests RENAME TO legacy_import_requests;
CREATE TABLE sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('track','collection','favorite','annotation')),
  entity_id TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK(base_version >= 0),
  payload TEXT,
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(account_id, operation_id),
  CHECK ((deleted=1 AND payload IS NULL) OR (deleted=0 AND payload IS NOT NULL))
);
CREATE INDEX account_changes_cursor ON sync_changes(account_id, sequence);
CREATE INDEX account_changes_entity ON sync_changes(account_id, kind, entity_id, sequence DESC);
CREATE TABLE import_requests (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  container_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed')),
  phase TEXT NOT NULL DEFAULT 'queued',
  current INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 1,
  message TEXT NOT NULL DEFAULT 'Waiting for playlist container',
  collection_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, id),
  UNIQUE(account_id, source)
);
CREATE INDEX account_import_delivery ON import_requests(account_id, status, created_at);
CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  credential TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
