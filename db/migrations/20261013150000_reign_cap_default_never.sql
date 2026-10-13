-- =============================================================================
-- This or That — Pick and fwd champions hold until beaten by default
-- Spec: this-or-that-mode-pick-and-fwd.md v0.5
--
--   * sessions.champion_reign_cap defaults to null ("never"). The app always
--     writes the value for a new room; this keeps the column honest about it.
--     Rooms already open keep their setting, and games keep what they froze.
--
-- Idempotent, like the earlier migrations.
-- =============================================================================

alter table this_or_that.sessions
  alter column champion_reign_cap set default null;
