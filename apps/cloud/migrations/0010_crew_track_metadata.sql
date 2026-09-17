-- A shared item references existing media, with the normal portable track metadata.
-- No audio copying, acquisition or reanalysis is necessary.
ALTER TABLE crew_crate_items ADD COLUMN track_json TEXT;
ALTER TABLE crew_crate_items ADD COLUMN media_owner_id TEXT;
CREATE INDEX crew_items_media ON crew_crate_items(asset_hash, crew_id);

UPDATE crew_crate_items SET
  track_json = (SELECT payload FROM sync_changes s WHERE s.account_id=crew_crate_items.added_by
    AND s.kind='track' AND s.entity_id=crew_crate_items.recording_id ORDER BY s.sequence DESC LIMIT 1),
  media_owner_id = added_by
WHERE EXISTS (SELECT 1 FROM sync_changes s WHERE s.account_id=crew_crate_items.added_by
  AND s.kind='track' AND s.entity_id=crew_crate_items.recording_id AND s.deleted=0
  AND json_extract(s.payload,'$.mediaHash')=crew_crate_items.asset_hash
  AND s.sequence=(SELECT MAX(t.sequence) FROM sync_changes t WHERE t.account_id=s.account_id AND t.kind=s.kind AND t.entity_id=s.entity_id));
