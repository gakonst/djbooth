-- This is a replication log. Rekordbox master.db and each native offline cache
-- remain the local source of truth; no provider credentials or local paths live here.
CREATE TABLE sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('track', 'collection', 'favorite')),
  entity_id TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  payload TEXT,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((deleted = 1 AND payload IS NULL) OR (deleted = 0 AND payload IS NOT NULL))
);
CREATE INDEX sync_changes_entity ON sync_changes(kind, entity_id, sequence DESC);
