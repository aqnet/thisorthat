-- =============================================================================
-- This or That — Pick and fwd reign cap as a lobby setting
-- Spec: this-or-that-mode-pick-and-fwd.md v0.4 (§4.2, decision F2)
--
--   * sessions.champion_reign_cap: the lobby setting. 3 (the default), 5, or
--     null for "never": a champion holds until a fresh card beats it.
--   * games.champion_reign_cap: frozen at Start, so the cap can't change
--     mid-game and the champion still derives from the game's own record.
--     Existing games keep the fixed cap they were played with, 3.
--
-- Idempotent, like the earlier migrations.
-- =============================================================================

alter table this_or_that.sessions
  add column if not exists champion_reign_cap smallint default 3;

alter table this_or_that.games
  add column if not exists champion_reign_cap smallint default 3;

do $guard$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_champion_reign_cap_valid') then
    alter table this_or_that.sessions
      add constraint sessions_champion_reign_cap_valid
        check (champion_reign_cap is null or champion_reign_cap in (3, 5));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'games_champion_reign_cap_valid') then
    alter table this_or_that.games
      add constraint games_champion_reign_cap_valid
        check (champion_reign_cap is null or champion_reign_cap in (3, 5));
  end if;
end
$guard$;
