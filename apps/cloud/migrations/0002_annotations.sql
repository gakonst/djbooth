-- Widen the kind constraint without changing any existing operation or cursor.
CREATE TABLE sync_changes_annotations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('track', 'collection', 'favorite', 'annotation')),
  entity_id TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  payload TEXT,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((deleted = 1 AND payload IS NULL) OR (deleted = 0 AND payload IS NOT NULL))
);
INSERT INTO sync_changes_annotations
  (sequence, operation_id, kind, entity_id, base_version, payload, deleted, created_at)
SELECT sequence, operation_id, kind, entity_id, base_version, payload, deleted, created_at
FROM sync_changes ORDER BY sequence;
DROP TABLE sync_changes;
ALTER TABLE sync_changes_annotations RENAME TO sync_changes;
CREATE INDEX sync_changes_entity ON sync_changes(kind, entity_id, sequence DESC);
