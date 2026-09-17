CREATE TABLE crews (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE crew_members (
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','dj','viewer')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(crew_id, account_id)
);
CREATE INDEX crew_members_account ON crew_members(account_id, joined_at DESC);

CREATE TABLE crew_invites (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin','dj','viewer')),
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT
);
CREATE INDEX crew_invites_crew ON crew_invites(crew_id, expires_at DESC);

CREATE TABLE crew_crates (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(crew_id, name)
);
CREATE INDEX crew_crates_crew ON crew_crates(crew_id, updated_at DESC);

CREATE TABLE crew_crate_items (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  crate_id TEXT NOT NULL REFERENCES crew_crates(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  asset_hash TEXT CHECK(asset_hash IS NULL OR length(asset_hash) = 64),
  local_track_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 512),
  artist TEXT,
  bpm REAL,
  musical_key TEXT,
  duration_seconds REAL,
  note TEXT,
  sort_key REAL NOT NULL,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX crew_crate_items_order ON crew_crate_items(crate_id, sort_key, id);
CREATE INDEX crew_crate_items_recording ON crew_crate_items(crew_id, recording_id);
