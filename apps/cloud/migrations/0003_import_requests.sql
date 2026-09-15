-- Delivery inbox and progress receipts only. The processor resumes acquisition and
-- analysis from master.db; this table never contains track workflow checkpoints.
CREATE TABLE import_requests (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed')),
  phase TEXT NOT NULL DEFAULT 'queued',
  current INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 1,
  message TEXT NOT NULL DEFAULT 'Waiting for playlist container',
  collection_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX import_requests_delivery ON import_requests(status, created_at);
