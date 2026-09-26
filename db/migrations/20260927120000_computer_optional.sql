-- =============================================================================
-- This or That — the Computer can sit out with 3+ humans (spec v0.8, §5, §9.1)
--
--   * sessions.computer_player: the lobby setting. On by default; the host can
--     switch it off only with 3+ humans, and below that it plays regardless.
--   * games.with_computer: frozen at Start, so a player leaving mid-game
--     doesn't bring the Computer back. Existing games had it.
--   * high_scores.with_computer: recorded so boards can be split later if
--     scores without the Computer turn out not to be comparable (D13).
--
-- Idempotent, like the earlier migrations.
-- =============================================================================

alter table this_or_that.sessions
  add column if not exists computer_player boolean not null default true;

alter table this_or_that.games
  add column if not exists with_computer boolean not null default true;

alter table this_or_that.high_scores
  add column if not exists with_computer boolean not null default true;
