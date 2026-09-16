ALTER TABLE import_requests ADD COLUMN workflow_id TEXT;
CREATE UNIQUE INDEX import_workflow ON import_requests(workflow_id) WHERE workflow_id IS NOT NULL;
