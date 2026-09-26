-- =============================================================================
-- This or That — game modes: Pick your fav and Pick and fwd
-- Spec: this-or-that-mode-pick-and-fwd.md §8
--
--   * games.mode: chosen first in setup. Existing games read as Pick your fav,
--     so nothing already stored changes meaning.
--   * ballot_cards.champion_reign: set on a Pick and fwd champion card, the
--     reign it carried onto that ballot. History only; the engine derives the
--     champion from the round record.
--   * high_scores.mode: boards are split by mode, then by list length.
--
-- Idempotent, like the earlier migrations: a retry is a no-op.
-- =============================================================================

alter table this_or_that.games
  add column if not exists mode text not null default 'pick_your_fav';

alter table this_or_that.ballot_cards
  add column if not exists champion_reign smallint;

alter table this_or_that.high_scores
  add column if not exists mode text not null default 'pick_your_fav';

do $guard$
begin
  if not exists (select 1 from pg_constraint where conname = 'games_mode_valid') then
    alter table this_or_that.games
      add constraint games_mode_valid check (mode in ('pick_your_fav', 'pick_and_fwd'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'high_scores_mode_valid') then
    alter table this_or_that.high_scores
      add constraint high_scores_mode_valid check (mode in ('pick_your_fav', 'pick_and_fwd'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ballot_cards_champion_reign_valid') then
    alter table this_or_that.ballot_cards
      add constraint ballot_cards_champion_reign_valid check (champion_reign is null or champion_reign >= 1);
  end if;
end
$guard$;

-- The three boards now lead with the mode.
drop index if exists this_or_that.high_scores_weekly_idx;
drop index if exists this_or_that.high_scores_all_time_idx;
drop index if exists this_or_that.high_scores_room_idx;
create index if not exists high_scores_mode_weekly_idx
  on this_or_that.high_scores (mode, list_length, board_week, pct desc, score desc, created_at) where not hidden;
create index if not exists high_scores_mode_all_time_idx
  on this_or_that.high_scores (mode, list_length, pct desc, score desc, created_at) where not hidden;
create index if not exists high_scores_mode_room_idx
  on this_or_that.high_scores (device_group_id, mode, list_length, pct desc, score desc, created_at) where not hidden;
