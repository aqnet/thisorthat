-- =============================================================================
-- This or That — runtime state the engine carries that the first schema missed
--
--   * sessions.paused_until / paused_from: §9.7 pause. Resuming restores the
--     interrupted phase, so the phase has to survive between requests.
--   * games.submitted_player_ids: §8 submit / edit-after-submit. Lists lock
--     when every connected human has submitted.
--   * players.released_at: Play Again (§11) frees departed seats. The row stays
--     so earlier games keep their owners, but the room no longer loads it.
--   * Covering indexes for foreign keys the performance advisor flagged. The
--     ones on player ids matter most: the nightly purge deletes closed rooms,
--     and every cascade through players would otherwise scan these tables.
--
-- Idempotent, like the first migration: a retry is a no-op.
-- =============================================================================

alter table this_or_that.sessions
  add column if not exists paused_until timestamptz,
  add column if not exists paused_from  this_or_that.session_status;

alter table this_or_that.games
  add column if not exists submitted_player_ids uuid[] not null default '{}';

alter table this_or_that.players
  add column if not exists released_at timestamptz;

create index if not exists players_user_idx            on this_or_that.players (user_id);
create index if not exists favorites_player_idx        on this_or_that.favorites (player_id);
create index if not exists favorites_canonical_idx     on this_or_that.favorites (canonical_item_id);
create index if not exists votes_voter_idx             on this_or_that.votes (voter_player_id);
create index if not exists votes_card_idx              on this_or_that.votes (ballot_card_id, matchup_id);
create index if not exists category_votes_player_idx   on this_or_that.category_votes (player_id);
create index if not exists category_votes_category_idx on this_or_that.category_votes (category_id);
create index if not exists game_results_player_idx     on this_or_that.game_results (player_id);
create index if not exists ballot_card_owners_fav_idx  on this_or_that.ballot_card_owners (favorite_id);
create index if not exists games_category_idx          on this_or_that.games (category_id);
create index if not exists high_scores_game_idx        on this_or_that.high_scores (game_id);
create index if not exists high_scores_category_idx    on this_or_that.high_scores (category_id);
create index if not exists sessions_host_idx           on this_or_that.sessions (host_player_id);
create index if not exists sessions_current_game_idx   on this_or_that.sessions (current_game_id);
