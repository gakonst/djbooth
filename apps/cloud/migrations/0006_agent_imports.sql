-- Delivery authorization, not track workflow state. Track state remains in master.db.
ALTER TABLE import_requests ADD COLUMN agent_grant_id TEXT;
ALTER TABLE import_requests ADD COLUMN agent_id TEXT;
ALTER TABLE import_requests ADD COLUMN agent_turn_id TEXT;
