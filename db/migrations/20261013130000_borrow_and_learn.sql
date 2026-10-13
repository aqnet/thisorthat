-- =============================================================================
-- This or That — borrowed suggestions for custom categories
-- Spec: this-or-that-custom-category.md §4.5
--
--   * games.borrow_category_id: the built-in category a custom one borrows
--     from for this game, chosen by the host at setup. Null = no borrowing.
--
-- Learning from players (§5.4) needs no schema: learned items are ordinary
-- dictionary rows with player_originated = true.
--
-- Idempotent, like the earlier migrations.
-- =============================================================================

alter table this_or_that.games
  add column if not exists borrow_category_id integer;

do $guard$
begin
  if not exists (select 1 from pg_constraint where conname = 'games_borrow_category_fk') then
    alter table this_or_that.games
      add constraint games_borrow_category_fk foreign key (borrow_category_id)
        references this_or_that.categories (id) on delete set null;
  end if;
end
$guard$;

create index if not exists games_borrow_category_idx on this_or_that.games (borrow_category_id);
