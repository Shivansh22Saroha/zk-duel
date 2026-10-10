-- 003_player_audit: per-player audit result (owner decision after Phase 3 review).
-- The match result is never changed; a loser whose audit fails is recorded here as audited_failed,
-- matches.overturned stays reserved for a failed winner.
ALTER TABLE match_players ADD COLUMN audit_status TEXT
  CHECK (audit_status IN ('audited_clean','audited_failed','audit_incomplete'));
