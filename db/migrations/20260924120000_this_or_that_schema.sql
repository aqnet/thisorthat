-- =============================================================================
-- This or That — initial schema
-- Spec: this-or-that-game-mechanics-spec.md v0.5, §14
--
-- Design notes
--   * Everything lives in its own schema, `this_or_that`, isolated from the
--     rest of the Supabase project.
--   * The schema is NOT exposed through the Data API. Clients never touch
--     these tables. The Next.js server connects directly to Postgres as
--     `this_or_that_app`, through the Supavisor transaction pooler.
--   * RLS is enabled everywhere with no client policies: deny-all is the
--     defense in depth.
--   * Timers are server-driven. pg_cron runs dispatch_due() every second, and
--     it POSTs to /api/advance for any session that is past its deadline or
--     has a player to mark disconnected.
--
-- One-time setup after this migration (not in version control)
--   select vault.create_secret('https://<your-domain>/api/advance', 'this_or_that_advance_url');
--   select vault.create_secret('<long random string>',               'this_or_that_advance_secret');
--   alter role this_or_that_app with login password '<strong password>';
-- =============================================================================

create schema if not exists this_or_that;

create extension if not exists pg_trgm       with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;
create extension if not exists pg_net        with schema extensions;
create extension if not exists pg_cron;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------
do $guard$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'this_or_that' and t.typname = 'session_status'
  ) then
    create type this_or_that.session_status as enum ('lobby', 'setup', 'entering', 'computer_picking', 'matchup_voting', 'matchup_reveal', 'paused', 'results', 'closed');
  end if;
end
$guard$;

do $guard$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'this_or_that' and t.typname = 'size_class'
  ) then
    create type this_or_that.size_class as enum ('small', 'medium', 'large');
  end if;
end
$guard$;
do $guard$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'this_or_that' and t.typname = 'matchup_status'
  ) then
    create type this_or_that.matchup_status as enum ('pending', 'voting', 'revealed');
  end if;
end
$guard$;

-- -----------------------------------------------------------------------------
-- Content: categories and the dictionary
-- -----------------------------------------------------------------------------
create table if not exists this_or_that.categories (
  id              smallint generated always as identity primary key,
  slug            text not null unique,
  name            text not null,
  size_class      this_or_that.size_class not null,
  allowed_lengths smallint[] not null,
  is_active       boolean not null default true,
  constraint categories_allowed_lengths_valid
    check (cardinality(allowed_lengths) > 0 and allowed_lengths <@ array[5, 10, 15]::smallint[])
);

create table if not exists this_or_that.dictionary (
  id                bigint generated always as identity primary key,
  category_id       smallint not null references this_or_that.categories (id),
  canonical_name    text not null check (char_length(canonical_name) between 1 and 30),
  popular_tier      boolean not null default false,  -- cold-start pool for the Computer
  player_originated boolean not null default false,  -- promoted from unmatched_entries
  created_at        timestamptz not null default now()
);
create unique index if not exists dictionary_category_name_uq
  on this_or_that.dictionary (category_id, lower(canonical_name));

-- Aliases map to one canonical item (e.g. "NYC" -> "New York City")
create table if not exists this_or_that.dictionary_aliases (
  dictionary_id bigint not null references this_or_that.dictionary (id) on delete cascade,
  alias         text   not null check (char_length(alias) between 1 and 30),
  primary key (dictionary_id, alias)
);

-- Rolling performance per item. Drives the Computer's picks.
create table if not exists this_or_that.item_stats (
  dictionary_id  bigint primary key references this_or_that.dictionary (id) on delete cascade,
  appearances    integer not null default 0,
  votes_received integer not null default 0,
  round_wins     integer not null default 0,
  updated_at     timestamptz not null default now()
);

-- Player entries that didn't match the dictionary: the promotion pipeline
create table if not exists this_or_that.unmatched_entries (
  category_id           smallint not null references this_or_that.categories (id),
  normalized_text       text not null,
  distinct_player_count integer not null default 1,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  primary key (category_id, normalized_text)
);

-- -----------------------------------------------------------------------------
-- Rooms, players, games
-- -----------------------------------------------------------------------------
create table if not exists this_or_that.sessions (
  id                   uuid primary key default gen_random_uuid(),
  room_code            char(4) not null check (room_code ~ '^[A-HJ-NP-Z]{4}$'),  -- no I or O
  status               this_or_that.session_status not null default 'lobby',
  version              integer not null default 0,        -- optimistic concurrency
  host_player_id       uuid,                              -- FK added below
  current_game_id      uuid,                              -- FK added below
  phase_deadline       timestamptz,                       -- null = phase has no timer
  advance_requested_at timestamptz,                       -- dispatch dedupe; cleared by the engine
  relaxed_timers       boolean not null default false,
  category_vote        boolean not null default false,
  device_group_id      uuid not null default gen_random_uuid(),  -- "This Room" board
  created_at           timestamptz not null default now(),
  last_activity_at     timestamptz not null default now(),
  closed_at            timestamptz
);
create unique index if not exists sessions_active_room_code_uq
  on this_or_that.sessions (room_code) where status <> 'closed';
create index if not exists sessions_due_idx
  on this_or_that.sessions (phase_deadline) where status <> 'closed' and phase_deadline is not null;

create table if not exists this_or_that.players (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references this_or_that.sessions (id) on delete cascade,
  user_id         uuid references auth.users (id) on delete set null,  -- anonymous auth uid
  is_computer     boolean not null default false,
  name            text not null check (char_length(name) between 1 and 12),
  color_slot      smallint,           -- 0 = Computer, 1-4 = seated humans, null = queued
  is_host         boolean not null default false,
  queued          boolean not null default false,
  joined_at       timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),  -- heartbeat
  disconnected_at timestamptz,
  left_at         timestamptz,
  constraint players_shape check (
    (is_computer and user_id is null and color_slot = 0 and not is_host and not queued)
    or (not is_computer and queued and color_slot is null and not is_host)
    or (not is_computer and not queued and color_slot between 1 and 4)
  )
);
-- Exactly one Computer per room
create unique index if not exists players_one_computer_uq
  on this_or_that.players (session_id) where is_computer;
-- Unique names (case-insensitive) among players still in the room
create unique index if not exists players_name_uq
  on this_or_that.players (session_id, lower(name)) where left_at is null;
-- Unique seat colors; slots 1-4 also hard-cap the room at 4 seated humans
create unique index if not exists players_color_uq
  on this_or_that.players (session_id, color_slot) where left_at is null and color_slot is not null;
-- At most one host
create unique index if not exists players_one_host_uq
  on this_or_that.players (session_id) where is_host and left_at is null;
-- One active seat per device identity
create unique index if not exists players_user_seat_uq
  on this_or_that.players (session_id, user_id) where left_at is null and user_id is not null;
create index if not exists players_heartbeat_idx
  on this_or_that.players (session_id, last_seen_at) where left_at is null and not is_computer;

-- One row per game played in a room (Play Again creates a new one)
create table if not exists this_or_that.games (
  id                     uuid primary key default gen_random_uuid(),
  session_id             uuid not null references this_or_that.sessions (id) on delete cascade,
  number                 smallint not null,
  offered_category_ids   smallint[],   -- category-vote options
  category_id            smallint references this_or_that.categories (id),  -- null until confirmed
  list_length            smallint check (list_length in (5, 10, 15)),
  human_count            smallint check (human_count between 2 and 4),
  current_round          smallint not null default 0,
  rng_seed               bytea not null,  -- replay/debug
  ended_early            boolean not null default false,
  started_at             timestamptz not null default now(),
  ended_at               timestamptz,
  unique (session_id, number)
);

do $guard$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_host_fk') then
    alter table this_or_that.sessions
      add constraint sessions_host_fk foreign key (host_player_id)
        references this_or_that.players (id) on delete set null deferrable initially deferred;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sessions_current_game_fk') then
    alter table this_or_that.sessions
      add constraint sessions_current_game_fk foreign key (current_game_id)
        references this_or_that.games (id) on delete set null deferrable initially deferred;
  end if;
end
$guard$;

create table if not exists this_or_that.category_votes (
  game_id     uuid not null references this_or_that.games (id) on delete cascade,
  player_id   uuid not null references this_or_that.players (id) on delete cascade,
  category_id smallint not null references this_or_that.categories (id),
  cast_at     timestamptz not null default now(),
  primary key (game_id, player_id)
);

-- -----------------------------------------------------------------------------
-- Items, match-ups, votes
-- -----------------------------------------------------------------------------
create table if not exists this_or_that.favorites (
  id                uuid primary key default gen_random_uuid(),
  game_id           uuid not null references this_or_that.games (id) on delete cascade,
  player_id         uuid not null references this_or_that.players (id) on delete cascade,
  entry_position    smallint not null check (entry_position between 1 and 15),
  raw_text          text not null,
  display_text      text not null check (char_length(display_text) between 1 and 30),
  canonical_item_id bigint references this_or_that.dictionary (id),
  auto_picked       boolean not null default false,   -- timer fill; tagged on reveal
  surprise_picked   boolean not null default false,   -- "Surprise me"; tagged in own list only
  shuffled_position smallint check (shuffled_position between 1 and 15),  -- set at list lock
  unique (game_id, player_id, entry_position),
  unique (game_id, player_id, shuffled_position)
);
-- No duplicate canonical items within one player's list
create unique index if not exists favorites_no_dupe_canonical_uq
  on this_or_that.favorites (game_id, player_id, canonical_item_id) where canonical_item_id is not null;
create unique index if not exists favorites_no_dupe_text_uq
  on this_or_that.favorites (game_id, player_id, lower(display_text));

create table if not exists this_or_that.matchups (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references this_or_that.games (id) on delete cascade,
  round_number smallint not null check (round_number between 1 and 15),
  multiplier   smallint not null default 1 check (multiplier in (1, 2)),  -- 2 = Final Showdown
  status       this_or_that.matchup_status not null default 'pending',
  opened_at    timestamptz,
  revealed_at  timestamptz,
  unique (game_id, round_number)
);

-- Card ids are random and unrelated to favorite ids, so a card can't be joined back to its owner
create table if not exists this_or_that.ballot_cards (
  id           uuid primary key default gen_random_uuid(),
  matchup_id   uuid not null references this_or_that.matchups (id) on delete cascade,
  -- Ballot text is always ALL CAPS so casing can't reveal the author (spec §9.1).
  -- The engine uppercases it; this constraint guarantees it.
  display_text text not null
    check (char_length(display_text) between 1 and 30 and display_text = upper(display_text)),
  sort_order   smallint not null,   -- randomized display order
  unique (id, matchup_id),          -- target for the votes composite FK
  unique (matchup_id, sort_order)
);

-- Usually one owner per card. Shared duplicate items credit several owners.
create table if not exists this_or_that.ballot_card_owners (
  ballot_card_id uuid not null references this_or_that.ballot_cards (id) on delete cascade,
  favorite_id    uuid not null references this_or_that.favorites (id) on delete cascade,
  primary key (ballot_card_id, favorite_id)
);

create table if not exists this_or_that.votes (
  matchup_id      uuid not null references this_or_that.matchups (id) on delete cascade,
  voter_player_id uuid not null references this_or_that.players (id) on delete cascade,
  ballot_card_id  uuid not null,
  cast_at         timestamptz not null default now(),
  primary key (matchup_id, voter_player_id),  -- one vote per player per match-up
  -- The card must belong to this match-up
  foreign key (ballot_card_id, matchup_id)
    references this_or_that.ballot_cards (id, matchup_id) on delete cascade
);
-- Own-card voting is blocked in the engine: ownership crosses favorites -> players,
-- so it can't be expressed as a plain constraint.

-- Final standings per game (written once, at results)
create table if not exists this_or_that.game_results (
  game_id      uuid not null references this_or_that.games (id) on delete cascade,
  player_id    uuid not null references this_or_that.players (id) on delete cascade,
  score        integer not null,
  max_possible integer not null,
  pct          smallint not null check (pct between 0 and 100),
  round_wins   smallint not null,
  rank         smallint not null,
  primary key (game_id, player_id)
);

-- -----------------------------------------------------------------------------
-- Event log and high scores
-- -----------------------------------------------------------------------------
create table if not exists this_or_that.session_events (
  id              bigint generated always as identity primary key,
  session_id      uuid not null references this_or_that.sessions (id) on delete cascade,
  version         integer not null,
  intent          text not null,
  actor_player_id uuid,   -- null = server (advance, sweeper)
  payload         jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  unique (session_id, version)
);

create table if not exists this_or_that.high_scores (
  id              bigint generated always as identity primary key,
  game_id         uuid references this_or_that.games (id) on delete set null,  -- sessions purge after 7d
  player_name     text not null,
  score           integer not null,
  max_possible    integer not null,
  pct             smallint not null check (pct between 0 and 100),
  list_length     smallint not null check (list_length in (5, 10, 15)),
  human_count     smallint not null check (human_count between 2 and 4),
  category_id     smallint not null references this_or_that.categories (id),
  device_group_id uuid not null,
  board_week      date not null,   -- Monday of the week, America/Los_Angeles
  hidden          boolean not null default false,   -- moderation
  created_at      timestamptz not null default now()
);
create index if not exists high_scores_weekly_idx
  on this_or_that.high_scores (list_length, board_week, pct desc, score desc, created_at) where not hidden;
create index if not exists high_scores_all_time_idx
  on this_or_that.high_scores (list_length, pct desc, score desc, created_at) where not hidden;
create index if not exists high_scores_room_idx
  on this_or_that.high_scores (device_group_id, list_length, pct desc, score desc, created_at) where not hidden;

-- -----------------------------------------------------------------------------
-- Spell check: fuzzy dictionary lookup
-- Categories hold ~40-150 items, so a per-category scan is cheap; no trigram index needed.
-- -----------------------------------------------------------------------------
create or replace function this_or_that.match_item(
  p_category_id smallint,
  p_text        text,
  p_limit       integer default 3
)
returns table (dictionary_id bigint, canonical_name text, matched_term text, score real)
language sql stable
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

-- -----------------------------------------------------------------------------
-- Server-driven timers: dispatcher
-- Finds sessions that need the engine to run, and POSTs each one to /api/advance.
-- It holds no game rules; it only decides that the engine should look at a session.
-- -----------------------------------------------------------------------------
create or replace function this_or_that.dispatch_due()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
  v_count  integer := 0;
  r        record;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'this_or_that_advance_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'this_or_that_advance_secret';
  if v_url is null or v_secret is null then
    return 0;   -- not configured yet
  end if;

  for r in
    select s.id, s.version
    from this_or_that.sessions s
    where s.status <> 'closed'
      -- don't re-fire while a request is in flight; retries after 3s if it was lost
      and (s.advance_requested_at is null or s.advance_requested_at < now() - interval '3 seconds')
      and (
        -- (a) a phase timer ran out
        s.phase_deadline <= now()
        -- (b) a human stopped heart-beating and hasn't been marked disconnected
        or exists (
          select 1 from this_or_that.players p
          where p.session_id = s.id and not p.is_computer and p.left_at is null
            and p.disconnected_at is null and p.last_seen_at < now() - interval '20 seconds'
        )
        -- (c) a disconnected human is due to be marked departed
        or exists (
          select 1 from this_or_that.players p
          where p.session_id = s.id and not p.is_computer and p.left_at is null
            and p.disconnected_at < now() - interval '60 seconds'
        )
        -- (d) the room has been idle long enough to expire
        or s.last_activity_at < now() - interval '2 hours'
      )
    order by s.phase_deadline nulls last
    limit 200
    for update skip locked
  loop
    update this_or_that.sessions
       set advance_requested_at = now()
     where id = r.id;

    perform net.http_post(
      url                  := v_url,
      body                 := jsonb_build_object('session_id', r.id, 'version', r.version),
      headers              := jsonb_build_object(
                                'Content-Type', 'application/json',
                                'Authorization', 'Bearer ' || v_secret),
      timeout_milliseconds := 5000
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function this_or_that.dispatch_due() from public;

-- Every second (requires pg_cron >= 1.5, which Supabase provides)
select cron.schedule('this_or_that_dispatch', '1 seconds',
  $$select this_or_that.dispatch_due()$$);

-- Nightly: purge closed rooms after 7 days, and trim pg_cron's run log
-- (a 1-second job writes ~86k rows a day)
-- This database is shared with other applications, so the run-log trim is
-- scoped to this app's own jobs. An unscoped delete would wipe the cron
-- history of anything else scheduled here.
select cron.schedule('this_or_that_purge', '17 11 * * *', $$
  delete from this_or_that.sessions
   where status = 'closed' and closed_at < now() - interval '7 days';
  delete from cron.job_run_details
   where end_time < now() - interval '1 day'
     and jobid in (select jobid from cron.job where jobname like 'this_or_that\_%');
$$);

-- -----------------------------------------------------------------------------
-- Realtime authorization (private channels: room:<ROOM_CODE>)
-- Only the server broadcasts, via realtime.send() inside the game transaction.
-- Clients may only receive broadcasts and track presence for rooms they're in.
-- -----------------------------------------------------------------------------
create or replace function this_or_that.can_join_topic(p_topic text)
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from this_or_that.players p
    join this_or_that.sessions s on s.id = p.session_id
    where p.user_id = auth.uid()
      and p.left_at is null
      and s.status <> 'closed'
      and 'room:' || s.room_code = p_topic
  );
$$;

revoke all on function this_or_that.can_join_topic(text) from public;
grant usage on schema this_or_that to authenticated;   -- needed to call the function; no table grants
grant execute on function this_or_that.can_join_topic(text) to authenticated;

drop policy if exists "this_or_that: room members receive broadcasts and presence" on realtime.messages;
create policy "this_or_that: room members receive broadcasts and presence"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and this_or_that.can_join_topic(realtime.topic())
  );

drop policy if exists "this_or_that: room members track presence" on realtime.messages;
create policy "this_or_that: room members track presence"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and this_or_that.can_join_topic(realtime.topic())
  );

-- -----------------------------------------------------------------------------
-- Access control
-- -----------------------------------------------------------------------------
-- RLS on, and no policies for anon/authenticated: deny-all, even if this
-- schema is ever exposed to the Data API by mistake.
alter table this_or_that.categories         enable row level security;
alter table this_or_that.dictionary         enable row level security;
alter table this_or_that.dictionary_aliases enable row level security;
alter table this_or_that.item_stats         enable row level security;
alter table this_or_that.unmatched_entries  enable row level security;
alter table this_or_that.sessions           enable row level security;
alter table this_or_that.players            enable row level security;
alter table this_or_that.games              enable row level security;
alter table this_or_that.category_votes     enable row level security;
alter table this_or_that.favorites          enable row level security;
alter table this_or_that.matchups           enable row level security;
alter table this_or_that.ballot_cards       enable row level security;
alter table this_or_that.ballot_card_owners enable row level security;
alter table this_or_that.votes              enable row level security;
alter table this_or_that.game_results       enable row level security;
alter table this_or_that.session_events     enable row level security;
alter table this_or_that.high_scores        enable row level security;

revoke all on all tables in schema this_or_that from anon, authenticated;

-- The app role: the Next.js server connects as this role (login enabled out of band).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'this_or_that_app') then
    create role this_or_that_app nologin;
  end if;
end
$$;

grant usage on schema this_or_that to this_or_that_app;
grant select, insert, update, delete on all tables in schema this_or_that to this_or_that_app;
grant usage, select on all sequences in schema this_or_that to this_or_that_app;
grant execute on function this_or_that.match_item(smallint, text, integer) to this_or_that_app;
alter default privileges in schema this_or_that
  grant select, insert, update, delete on tables to this_or_that_app;
-- The app role is the only writer: give it an allow-all policy on every table.
-- (Explicit policies instead of BYPASSRLS, which Supabase doesn't let non-superusers grant.)
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'this_or_that' loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'this_or_that' and tablename = t and policyname = 'app_all'
    ) then
      execute format(
        'create policy app_all on this_or_that.%I for all to this_or_that_app using (true) with check (true)', t);
    end if;
  end loop;
end
$$;

-- Broadcast from inside game transactions. Delivered only if the transaction
-- commits, so state and broadcast can never disagree.
create or replace function this_or_that.broadcast(p_room_code text, p_event text, p_payload jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  select realtime.send(p_payload, p_event, 'room:' || p_room_code, true);
$$;

revoke all on function this_or_that.broadcast(text, text, jsonb) from public;
grant execute on function this_or_that.broadcast(text, text, jsonb) to this_or_that_app;

-- -----------------------------------------------------------------------------
-- Seed: launch categories (dictionary items ship in a separate seed file)
-- -----------------------------------------------------------------------------
insert into this_or_that.categories (slug, name, size_class, allowed_lengths) values
  ('fruit',               'Fruit',               'large',  '{5,10,15}'),
  ('meal',                'Meal',                'large',  '{5,10,15}'),
  ('tourist-destination', 'Tourist Destination', 'large',  '{5,10,15}'),
  ('animal',              'Animal',              'large',  '{5,10,15}'),
  ('dessert',             'Dessert',             'large',  '{5,10,15}'),
  ('snack',               'Snack',               'medium', '{5,10}'),
  ('drink',               'Drink',               'medium', '{5,10}'),
  ('color',               'Color',               'medium', '{5,10}'),
  ('sport',               'Sport',               'small',  '{5}'),
  ('movie-genre',         'Movie Genre',         'small',  '{5}')
on conflict (slug) do nothing;
