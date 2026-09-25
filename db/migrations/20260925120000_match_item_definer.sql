-- =============================================================================
-- This or That — spell check runs with its owner's rights
--
-- match_item() calls pg_trgm and fuzzystrmatch, which Supabase installs in the
-- `extensions` schema. this_or_that_app has no USAGE on that schema, and
-- granting it would open every extension function to the app role. Instead
-- the function runs as its owner, like broadcast() and can_join_topic(): it
-- only reads the dictionary, and search_path is pinned to ''.
-- =============================================================================

alter function this_or_that.match_item(smallint, text, integer) security definer;
revoke all on function this_or_that.match_item(smallint, text, integer) from public;
grant execute on function this_or_that.match_item(smallint, text, integer) to this_or_that_app;
