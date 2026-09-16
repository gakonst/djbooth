-- Completed imports from older container images resume once to publish their
-- existing analysis. Completion is acknowledged only by the new pipeline.
ALTER TABLE import_requests ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0;
