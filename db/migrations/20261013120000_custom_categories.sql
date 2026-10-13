-- =============================================================================
-- This or That — custom categories and kids' categories
-- Spec: this-or-that-custom-category.md (§7.3, §B8.1)
--
--   * categories.id and every column that references it widen from smallint
--     to integer: custom categories can number in the thousands.
--     match_item() takes an integer category id to match.
--   * categories gains the custom-category columns (key, labels, who built
--     it, whether generation ran) and an audience for setup grouping.
--   * dictionary.retired_at: stale items stop being suggested or played, but
--     still match spell check and keep their history (§B5).
--   * games: the per-game spell-check switch, and the custom build shown to
--     everyone during setup, with its once-a-game timer extension.
--   * session_categories: the custom categories a room has built or reused,
--     so a room can only confirm its own (§9.2) and keeps them on Play Again.
--   * The 18 kids' categories (§B2). Their items ship in db/seed/kids.sql.
--   * A nightly job that purges unused custom categories after 90 days (§7.3).
--
-- Idempotent, like the earlier migrations: a retry is a no-op.
-- =============================================================================

-- --- Widen category ids ------------------------------------------------------
-- Referencing columns first, then the key itself. smallint and integer compare
-- directly, so the foreign keys hold at every step.
alter table this_or_that.dictionary        alter column category_id type integer;
alter table this_or_that.unmatched_entries alter column category_id type integer;
alter table this_or_that.games             alter column category_id type integer;
alter table this_or_that.games             alter column offered_category_ids type integer[];
alter table this_or_that.category_votes    alter column category_id type integer;
alter table this_or_that.high_scores       alter column category_id type integer;
alter table this_or_that.categories        alter column id type integer;

-- The identity sequence keeps its own type; widen it too, or ids still stop
-- at 32,767.
do $widen$
declare v_seq text := pg_get_serial_sequence('this_or_that.categories', 'id');
begin
  if v_seq is not null then
    execute format('alter sequence %s as integer', v_seq);
  end if;
end
$widen$;

-- match_item() took a smallint. Replace it with the integer form, keeping the
-- owner's-rights setup from 20260925120000_match_item_definer.sql.
drop function if exists this_or_that.match_item(smallint, text, integer);
create or replace function this_or_that.match_item(
  p_category_id integer,
  p_text        text,
  p_limit       integer default 3
)
returns table (dictionary_id bigint, canonical_name text, matched_term text, score real)
language sql stable
security definer
set search_path = ''
as $$
  with terms as (
    select d.id, d.canonical_name, d.canonical_name as term
    from this_or_that.dictionary d
    where d.category_id = p_category_id
    union all
    select d.id, d.canonical_name, a.alias
    from this_or_that.dictionary d
    join this_or_that.dictionary_aliases a on a.dictionary_id = d.id
    where d.category_id = p_category_id
  ),
  scored as (
    select
      t.id, t.canonical_name, t.term,
      greatest(
        extensions.similarity(lower(t.term), lower(p_text)),
        1 - extensions.levenshtein(lower(t.term), lower(p_text))::real
            / greatest(char_length(t.term), char_length(p_text), 1)
      )::real as score
    from terms t
  ),
  best as (
    select distinct on (id) id, canonical_name, term, score
    from scored
    order by id, score desc
  )
  select id, canonical_name, term, score
  from best
  where score >= 0.6          -- 1.0 = exact; 0.6-0.99 = "Did you mean…?"
  order by score desc
  limit p_limit;
$$;
revoke all on function this_or_that.match_item(integer, text, integer) from public;
grant execute on function this_or_that.match_item(integer, text, integer) to this_or_that_app;

-- --- Categories: custom rows, labels, audience ----------------------------------
alter table this_or_that.categories
  add column if not exists is_custom          boolean not null default false,
  add column if not exists custom_key         text,
  add column if not exists singular_label     text,
  add column if not exists plural_label       text,
  add column if not exists generated          boolean not null default false,
  add column if not exists created_by_session uuid,
  add column if not exists generator_model    text,
  add column if not exists audience           text not null default 'everyone',
  add column if not exists created_at         timestamptz not null default now(),
  add column if not exists last_used_at       timestamptz not null default now();

do $guard$
begin
  if not exists (select 1 from pg_constraint where conname = 'categories_audience_valid') then
    alter table this_or_that.categories
      add constraint categories_audience_valid check (audience in ('everyone', 'kids'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'categories_created_by_session_fk') then
    alter table this_or_that.categories
      add constraint categories_created_by_session_fk foreign key (created_by_session)
        references this_or_that.sessions (id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'categories_custom_key_valid') then
    alter table this_or_that.categories
      add constraint categories_custom_key_valid check (not is_custom or custom_key is not null);
  end if;
end
$guard$;

-- A name is generated once, then reused by every room that types it (§7.2).
-- Rows whose build didn't run aren't reusable, so they're outside the index.
create unique index if not exists categories_custom_key_uq
  on this_or_that.categories (custom_key) where is_custom and generated;
create index if not exists categories_created_by_session_idx
  on this_or_that.categories (created_by_session);

-- --- Dictionary: retirement --------------------------------------------------------
alter table this_or_that.dictionary
  add column if not exists retired_at timestamptz;

-- --- Games: spell check and the custom build in progress -------------------------
alter table this_or_that.games
  add column if not exists spell_check       boolean not null default true,
  add column if not exists building_category text,
  add column if not exists setup_held        boolean not null default false;

-- --- The custom categories each room can use ---------------------------------------
create table if not exists this_or_that.session_categories (
  session_id  uuid    not null references this_or_that.sessions (id) on delete cascade,
  category_id integer not null references this_or_that.categories (id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (session_id, category_id)
);
create index if not exists session_categories_category_idx on this_or_that.session_categories (category_id);
alter table this_or_that.session_categories enable row level security;
grant select, insert, update, delete on this_or_that.session_categories to this_or_that_app;
do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'this_or_that' and tablename = 'session_categories' and policyname = 'app_all'
  ) then
    create policy app_all on this_or_that.session_categories
      for all to this_or_that_app using (true) with check (true);
  end if;
end
$policy$;

-- --- Kids' categories (§B2) -----------------------------------------------------------
insert into this_or_that.categories
  (slug, name, size_class, allowed_lengths, audience, singular_label, plural_label) values
  ('cartoon-character', 'Cartoon Character', 'large',  '{5,10,15}', 'kids', 'cartoon character', 'cartoon characters'),
  ('kids-tv-show',      'Kids'' TV Show',    'large',  '{5,10,15}', 'kids', 'TV show',           'TV shows'),
  ('animated-movie',    'Animated Movie',    'large',  '{5,10,15}', 'kids', 'animated movie',    'animated movies'),
  ('video-game',        'Video Game',        'large',  '{5,10,15}', 'kids', 'video game',        'video games'),
  ('toy',               'Toy',               'large',  '{5,10,15}', 'kids', 'toy',               'toys'),
  ('dream-job',         'Dream Job',         'large',  '{5,10,15}', 'kids', 'dream job',         'dream jobs'),
  ('pokemon',           'Pokémon',           'large',  '{5,10,15}', 'kids', 'Pokémon',           'Pokémon'),
  ('candy',             'Candy',             'medium', '{5,10}',    'kids', 'candy',             'candies'),
  ('ice-cream-flavor',  'Ice Cream Flavor',  'medium', '{5,10}',    'kids', 'ice cream flavor',  'ice cream flavors'),
  ('breakfast-cereal',  'Breakfast Cereal',  'medium', '{5,10}',    'kids', 'breakfast cereal',  'breakfast cereals'),
  ('superhero',         'Superhero',         'medium', '{5,10}',    'kids', 'superhero',         'superheroes'),
  ('dinosaur',          'Dinosaur',          'medium', '{5,10}',    'kids', 'dinosaur',          'dinosaurs'),
  ('book-series',       'Book Series',       'medium', '{5,10}',    'kids', 'book series',       'book series'),
  ('vehicle',           'Vehicle',           'medium', '{5,10}',    'kids', 'vehicle',           'vehicles'),
  ('superpower',        'Superpower',        'small',  '{5}',       'kids', 'superpower',        'superpowers'),
  ('mythical-creature', 'Mythical Creature', 'small',  '{5}',       'kids', 'mythical creature', 'mythical creatures'),
  ('pet',               'Pet',               'small',  '{5}',       'kids', 'pet',               'pets'),
  ('playground-game',   'Playground Game',   'small',  '{5}',       'kids', 'playground game',   'playground games')
on conflict (slug) do nothing;

-- Labels for the launch categories, where the plural guess reads wrong.
update this_or_that.categories set singular_label = 'fruit', plural_label = 'fruits'
 where slug = 'fruit' and plural_label is null;
update this_or_that.categories set singular_label = 'movie genre', plural_label = 'movie genres'
 where slug = 'movie-genre' and plural_label is null;

-- --- Retention (§7.3) ------------------------------------------------------------------
-- Custom categories unused for 90 days, that no game or high score points at,
-- are deleted with their dictionary. Built-in categories are never touched.
create or replace function this_or_that.purge_custom_categories()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  create temporary table purge_ids on commit drop as
    select c.id from this_or_that.categories c
     where c.is_custom
       and c.last_used_at < now() - interval '90 days'
       and not exists (select 1 from this_or_that.games g where g.category_id = c.id)
       and not exists (select 1 from this_or_that.high_scores h where h.category_id = c.id);
  delete from this_or_that.unmatched_entries where category_id in (select id from purge_ids);
  delete from this_or_that.dictionary where category_id in (select id from purge_ids);
  delete from this_or_that.categories where id in (select id from purge_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function this_or_that.purge_custom_categories() from public;

select cron.schedule('this_or_that_custom_purge', '29 11 * * *',
  $$select this_or_that.purge_custom_categories()$$);
