# This or That — Custom Categories and Kids' Categories

**Status:** Draft v0.6 · **Date:** 2026-10-13 · **Owner:** Anderson
**Builds on:** [Game Mechanics Spec v0.8](this-or-that-game-mechanics.md) (the "original spec") and [Pick and fwd v0.3](this-or-that-mode-pick-and-fwd.md). Everything there applies unless this document changes it. Section references (§) point to the original spec; references to this document say "this spec".

This spec has two parts:
- **Part A — Custom categories** (§1–§13): the host types their own category.
- **Part B — Kids' categories** (§B1–§B11): new built-in categories for players aged 6–12.

**Changelog**
- v0.6 (2026-10-13) — **Category step layout.** Setup shows the 5 most-played built-in categories for the selected mode as chips, beside 🎲 Random and ✏️ Custom; every other category, the room's custom ones included, is in a "More categories" dropdown grouped as Everyone, Kids' favorites and Your custom categories. Plays are counted across all rooms, per mode; ties fall back to plays in either mode, then the default order. This replaces the grouped chip list in this spec §B6.
- v0.5 (2026-10-13) — **Every category offers 5, 10 and 15 items per player.** The §7 size classes no longer cap the list length; they set a *suggested* maximum, and Setup warns past it ("Sport has 51 items — at 15, players may run out of ideas"). Lists that come up short sit out rounds (this spec §4.1), the same rule as thin categories. The setup timer's auto-pick still uses a comfortable length (the suggested maximum, up to 10).
- v0.4 (2026-10-13) — **Borrowed suggestions and learning from players.** A custom category whose dictionary is short can borrow from the closest built-in category, picked by the server and changeable by the host (this spec §4.5). The Computer, Surprise me and auto-fill use the category's own items first and top up from the borrowed ones, instead of sitting out. And every finished game in a custom category teaches it: the items players typed join its dictionary (this spec §5.4), so it relies less on borrowing each time. Also: a champion card doesn't save a round from being dropped (§4.1), as built.
- v0.3 (2026-10-13) — **Part B: Kids' categories.** 18 new built-in categories for ages 6–12 (TV shows, characters, toys, games and more), grouped in setup under "Kids' favorites". Content rules for age-appropriateness and freshness, retiring stale items without deleting them, and display labels for built-in categories.
- v0.2 (2026-10-13) — **Only profanity refuses a category.** The relevance gate (vague, too narrow, nonsense, unsafe) is gone, and so is the minimum dictionary size. Any category name that passes the profanity filter can be played. A category with few or no generated items becomes a **thin category** (this spec §4): Surprise me, auto-fill and the Computer use what exists, and lists that come up short sit out rounds instead of being padded with off-topic items. A failed or unavailable build also becomes a thin category instead of a dead end. Games where some ballots had fewer than 3 cards don't count for high scores.
- v0.1 (2026-10-13) — First draft.

---

## 1. Summary

The host can type their own category, such as "Board games", "90s cartoons" or "Pizza toppings", instead of picking a built-in one. This works in **both modes**, Pick your fav and Pick and fwd, and is chosen in Host Setup like any other category.

This lifts "Custom/user-created categories" from Out of Scope (§16).

**Only profanity refuses a category.** Any name that passes the profanity filter is playable, however broad, narrow or strange. The host knows their group, and "Things in my fridge" or "Ben's worst ideas" can make a great round even when the game can't help with suggestions.

To help where it can, the server **builds a dictionary** for the category. That dictionary powers the same features built-in categories have:

| Feature | Built-in category | Custom category |
|---|---|---|
| Spell check / "Did you mean…?" (§8) | Always on | On by default; the host can switch it off (this spec §5.3) |
| Surprise me (§8) | Dictionary items | Items from **this category's** dictionary only, while they last (this spec §6) |
| Auto-fill on timer expiry (§8) | Dictionary items | Same, from the custom dictionary, while they last (this spec §4.2) |
| The Computer's picks (§9.1) | Dictionary, weighted by `item_stats` | Same, from the custom dictionary, while they last (this spec §4.3) |
| Allowed lengths (§7) | Declared, capped by dictionary size | Derived from the dictionary size, with 5 always allowed (this spec §3.4) |

### The relevance rule
**Every item the game itself puts forward (a spell-check suggestion, a Surprise me pick, an auto-fill or a Computer pick) must belong to the category the host typed.** An off-topic Surprise me pick reads as a broken game, and on a ballot it gives away the Computer. The game would rather offer **nothing** than offer something irrelevant:
1. Generated items go through a separate check that drops off-topic ones (this spec §3.3).
2. A dictionary that comes up short is never padded with generic or neighbouring items. The game plays a **thin category** instead (this spec §4).
3. Items are never taken from another category, except when the host chooses to borrow one for a category with no dictionary (this spec §4.5).

So the category itself is never refused for being odd; only the game's own suggestions are held to a relevance standard.

### Non-goals (v1)
- Custom categories in the optional category vote (§7). Only the host can make one.
- A public gallery or browser of other rooms' custom categories.
- Letting players edit the generated dictionary.

---

## 2. Game flow changes

```
[3 Host Setup: Mode → Category (built-in · 🎲 Random · ✏️ Custom) → Length → Confirm]
                                          │
                                          └─ Custom: type name → build dictionary (≤30s) → ready card
```

Only Phase 3 (Host Setup) changes for players. Phase 4 (Enter Items) reads the custom dictionary through the existing code paths. Match-ups (Phase 5) change only for thin categories (this spec §4).

---

## 3. Phase 3 — Host Setup (changes to §7 and Pick and fwd §3)

### 3.1 The Custom option
The category step gets a **✏️ Custom** chip after 🎲 Random. Tapping it opens a text field: *"Name a category — e.g. Board games"*.

**Name rules:**
- **Profanity is the only reason a category is refused.** The name runs through the same filter as player names and entries. A refusal says *"Let's keep it friendly — try another"*.
- **Length** is an input rule, not a judgment of the category: 2–24 characters after trimming and collapsing whitespace. The name appears in the round header ("Round 3 of 10 · Board Games"), and 24 characters still fit on a phone. The field enforces this as the host types and states the reason inline.
- Shown in Title Case, like the built-in category names.

**Already a built-in?** If the name closely matches a built-in category ("Fruits", "fruit"), the host sees: *"We already have **Fruit** — use it?"* with **Use Fruit** and **Make my own**. It's a suggestion, not a refusal. "Close" is trigram similarity ≥ 0.6 on the name or slug, the same threshold as spell check.

**Already built before?** If a custom category with the same normalized name exists from an earlier game in any room (this spec §7.2), it's reused at once and nothing is generated.

### 3.2 Building the dictionary
After the host taps **Build**, the server asks Claude for two things (this spec §8):
- **Labels:** a singular and a plural form ("Board game" / "board games"). The entry prompt (§8) needs both: "List 10 board games you'll defend" and the placeholder "A board game…". If generation returns none, the existing `plural()` guess in `Entry.tsx` is used.
- **Items:** as many real members of the category as it can name, up to **150**. For a broad category that's 150. For "Beatles albums" it's about 13. For "asdf" or "Things in my fridge" it may be **zero**, and that's a valid answer, not an error. The prompt tells the model never to invent or stretch items to reach a count.

The model doesn't judge whether the category is a good one. It only lists what clearly belongs.

### 3.3 Filtering and the relevance check
- **Server-side filtering** (deterministic, after the model returns), in this order:
  1. Normalize with the §8 rules (trim, collapse whitespace, Title Case).
  2. Drop items over 30 characters (the §8 limit), empty items, and items that fail the profanity filter.
  3. Drop duplicates by `dedupeKey`, both between items and between an alias and another item.
- **Each item** has a canonical name, optional aliases ("Settlers of Catan" → `Catan`), and a `popular` flag for about the 20 most widely loved items. Those 20 become the Computer's cold-start tier (§9.1).
- **Relevance check** (a second, separate request; decision C3). The model gets the category name and the surviving list, and returns the items that **don't** belong. That covers off-topic items, items from a neighbouring category, made-up items, jokes, and the same thing listed under two names. Those are dropped. This second request runs with a fresh context and no stake in the list it's checking. That's why it catches drift the generating request won't flag in its own output. It's skipped when nothing survived filtering.

### 3.4 Allowed lengths
The surviving item count decides the **suggested** lengths, never whether the category is allowed. Since v0.5 every category offers 5, 10 and 15; past the suggested maximum, Setup warns that players may run out of ideas:

| Surviving items | Allowed lengths | Category type |
|---|---|---|
| ≥ 113 | 5 · 10 · 15 | Full |
| 75–112 | 5 · 10 | Full |
| 38–74 | 5 | Full |
| 1–37 | 5 | **Thin** (this spec §4) |
| 0 | 5 · 10 · 15 | **Thin, no dictionary** (this spec §4) |

- **Full** categories meet the §7 size requirement for their longest length, so Surprise me, auto-fill and the Computer can never run out. They play exactly like a built-in category.
- **1–37 items** (a narrow category, like "Beatles albums") allows 5 only. The thresholds exist so nobody runs out of ideas, and a category with few known members is exactly the one where players run out.
- **0 items** means the game knows nothing about the category, so it can't say how big it is. The host picks any length; it's their group's call. The ready card warns them (this spec §3.5).
- The existing `categoryOption()` in `lib/server/view.ts` already handles 38 and up; this spec adds the two thin rows.

### 3.5 The ready card
Once the build finishes, the host sees one of these:

**Full category:**
> **✏️ Board Games** · 128 items · up to 15 per player
> Examples: CATAN · TICKET TO RIDE · CHESS
> Spell check **On** ⟷ Off
> [**Use this category**] [Try another]

**Thin category** (1–37 items):
> **✏️ Beatles Albums** · 13 items · 5 per player
> Examples: ABBEY ROAD · REVOLVER · HELP!
> ⚠️ *Surprise me and the Computer may run short. Players with short lists sit out some rounds.*
> [**Use this category**] [Try another]

**Thin, no dictionary** (0 items):
> **✏️ Things In My Fridge** · no suggestions
> ⚠️ *Players will need to fill their own lists. No spell check or Surprise me, and the Computer sits out.*
> (2 players only: *"With 2 players and no Computer, rounds can tie. This game won't count for high scores."*)
> [**Use this category**] [Try another]

- The examples are 3 random items from the `popular` tier (or any items, if fewer than 3 are popular), so the host can see what the game will suggest. They're shown on the host's phone only, and only during setup.
- **Use this category** selects it like any category chip. The host then picks the length and confirms as in §7: *"Pick and fwd · Board Games · 10 items — Start?"*
- **Try another** goes back to the text field.
- The spell-check switch appears only when the dictionary has items.

### 3.6 Timers and waiting
- **Generation budget:** 30s in total, covering both requests (this spec §8.3). The host sees *"Building Board Games…"* with a progress shimmer and a **Cancel** button.
- **Setup timer.** When a build starts, the setup deadline is extended once per game to at least **30s from now**. This uses a new server-only intent (this spec §9.1), so the 45s setup timer (§7) can't run out partway through a build the host is waiting on. Only the first build gets an extension; a host who keeps retrying still runs into the timer.
- **On timer expiry** the existing §7 rule applies unchanged: Random built-in category, longest length up to 10, auto-confirm. A build that finishes afterwards is still saved for next time (this spec §7.2).
- **Non-hosts** see *"Maya is building a custom category: Board Games…"* while it builds, then *"Maya is choosing…"* as today.
- **When the build can't run** (timeout, API error, model refusal, rate limit, or no API key configured), the category is **still playable**. The host sees *"Couldn't find suggestions for Board Games"* with **Retry** and **Play without suggestions**, which goes to the no-dictionary ready card (this spec §3.5). With no API key configured, there's no Retry and the build step is skipped. Nothing is saved for reuse when the build didn't run, so a later build tries again.

### 3.7 Play Again
A custom category used in this room stays available as a chip ("✏️ Board Games") on later Play Agains in the same room (§11), so groups can rematch without rebuilding it.

---

## 4. Thin categories

A category with fewer than enough dictionary items for its list length is **thin**. The game never pads its dictionary (the relevance rule, this spec §1). Instead, every list (human or Computer) is allowed to come up short, and a short list **sits out** some rounds.

### 4.1 One rule for short lists
**A list may hold fewer items than the list length. A list with *k* items appears in *k* rounds and sits out the rest.**
- Match-up *i* takes item *i* from every list that has one (§9.2), so a short list simply has no card in some rounds.
- **Spreading the gaps.** When building match-ups, a short list's items go to the rounds that would otherwise have the **fewest cards**, with ties broken by the seeded shuffle (§14.8). That keeps ballots as full as possible.
- **Rounds with fewer than 2 cards are dropped.** A 1-card ballot has nothing to choose between. The game then has fewer rounds than the list length, and the header shows the real count ("Round 3 of 4"). The Final Showdown (§9.6) applies to the last rounds actually played, using the list length's showdown size.
- **Voting is unchanged.** A player with no card in a round can vote for any card (§9.4).
- **Pick and fwd:** the champion carries forward as usual (Pick and fwd §4.1). Rounds are dropped at list lock, before any champion exists, so a champion can't save one.

This rule never applies to full categories or built-in ones, where the dictionary always fills every list.

### 4.2 Human lists: auto-fill
On entry timeout (§8), unfilled slots are filled from the custom dictionary while it has items the player doesn't already have. When it runs out, the rest stay empty and that player's list is short (this spec §4.1).

The entry screen says so on thin categories: *"Fill your whole list — the game can't fill it for you."* **Submit** still requires a full list (§8); short lists come only from the timer.

### 4.3 The Computer
- The Computer picks from the custom dictionary as usual (§9.1). That excludes items on human lists, so it can end up with **fewer items than the list length**, or none.
- A short Computer list follows this spec §4.1 like any other.
- **Zero items:** the Computer sits out this game, as if the host had switched it off (§5, v0.8). With 2 humans this happens even though the Computer normally always plays. The results screen treats the game as one without the Computer (§10, v0.8).

### 4.4 Scoring and high scores
- **Scoring is unchanged** (§9.5). `max_possible` (§12) is summed over the rounds actually played.
- **High-score eligibility (§12) gains one rule:** a game is eligible only if **every ballot had at least 3 cards**. That's the condition the Computer exists to guarantee (§9.1). In a 2-card round each voter has one choice, so every round ties and percentages are meaningless. A full category always meets the rule. A thin one meets it only when every list was full enough.
- The results screen says why when the rule applies: *"Some rounds had only 2 cards, so this game doesn't count for high scores."*

### 4.5 Borrowed suggestions
A custom category with a **short dictionary** (fewer than 38 items: the build found little or nothing, didn't run, there's no API key, or it has only learned a few items so far, this spec §5.4) can **borrow** the dictionary of a built-in category for one game. The Computer then plays, and Surprise me and auto-fill work, instead of everyone filling lists alone.

- **The closest built-in is suggested.** The server compares the custom name with each built-in category's name and labels, and with every item and alias in its dictionary, using the spell-check similarity (≥ 0.6). "Pizza toppings" finds **Meal** because its dictionary holds "Pizza". When nothing matches, there's no suggestion; the host can still pick one.
- **The host decides.** The ready card (and the custom chip in setup) shows *"Borrow suggestions from: [Meal ▾]"*, with the suggestion pre-selected and **None** available. With None, the game plays as in this spec §4.
- **Own items first.** The Computer's list, Surprise me, and auto-fill on timeout draw from the custom category's own items first, and from the borrowed category's active items only for what's left.
- **Spell check never borrows.** A borrowed category's "Did you mean…?" would push its own items ("Did you mean Slinky?" while listing Jellycats), so spell check only ever runs against the custom category's own items.
- **Stats stay clean:** votes on borrowed items don't update `item_stats`, since they were cast in a different category's context. Typed entries still log to `unmatched_entries` under the custom category, which is how it grows.
- **Relevance:** borrowed items are as relevant as the host's choice. The Computer's cards may stand out more than usual; that's the host's call, and the ready card says which category it'll play from.
- Stored per game (`games.borrow_category_id`), frozen at Start like the mode.

---

## 5. Phase 4 — Enter Items (changes to §8)

### 5.1 Prompt copy
"List [plural] you'll defend" uses the generated plural ("List 10 board games you'll defend."), or the `plural()` guess when there's no dictionary. The subtext is unchanged.

### 5.2 Spell check with a custom dictionary
With spell check **on**, it works exactly as §8 describes, against the custom dictionary and its aliases. `match_item()` is unchanged because it takes a category id. With an empty dictionary there's simply never a match, so everything is accepted as typed.

### 5.3 Spell check off
The host can switch spell check off on the ready card (this spec §3.5). Generated dictionaries are good, but in niche categories ("Indie video games") a "Did you mean…?" for a correct but uncommon spelling gets annoying.

With spell check **off**:
- No "Did you mean…?" prompts. Everything is accepted as typed (after the §8 validation).
- **Exact matches (score 1.0) still link silently** to their dictionary item. That keeps duplicate detection across players (§9.2.4), the Pick and fwd champion merge (Pick and fwd §4.1), the Computer's exclusion list (§9.1) and `item_stats` working. The player sees nothing different.
- The setting is frozen at Start, like the mode, and stored on the game.

Built-in categories always have spell check on. The switch appears only for custom categories that have a dictionary (decision C5).

### 5.4 Learning from players
**Every finished game in a custom category teaches it.** When the game reaches results, each item a human typed joins the custom category's dictionary as a player-originated item. That includes games that ended early, as long as the lists had locked. It's the one exception to manual promotion (§8), and only for custom categories.
- **What counts:** items humans typed themselves, which already passed the §8 filters (length, profanity). Auto-filled and Surprise me items are left out, since the game picked those, and so is everything the Computer played.
- **No duplicates:** an item already in the dictionary (by text, ignoring case) isn't added twice.
- **Effect:** the next game in that category has more of its own items, so spell check, Surprise me, auto-fill and the Computer rely less on borrowing (§4.5). Learned items are player-originated, so they also feed the Computer's wildcard picks (§9.1).
- **Where it applies:** the custom category row the game played, which travels with the room on Play Again (§3.7). A room that builds the same name again reuses its own row rather than starting empty.
- **Trust:** learned items come from the group's own entries, so they're as relevant as the group made them. A troll entry can join the list; the profanity filter is the guard, as it is for entries.
- Entries are still logged to `unmatched_entries` as today (§8).

---

## 6. Surprise me (changes to §8)

- Surprise me draws **only** from the custom category's own dictionary, excluding items already on the player's list, exactly as the current `surpriseMe` action does. Because the custom dictionary is stored as an ordinary category, the action doesn't change.
- **Relevance:** every item it can return has passed the relevance check (this spec §3.3). It never falls back to another category, a generic list, or a live model call. Live generation would be slow, cost money on every tap, and skip the relevance check.
- **When it runs out:** the button disables with "Out of surprises for this category", the existing copy. On a category with no dictionary, the button isn't shown at all.
- Surprise me picks are still tagged 🎲 in the player's own list only (§8).

---

## 7. Data

### 7.1 A custom category is an ordinary category
A custom category is stored as a row in `this_or_that.categories`, with its items in `dictionary` and `dictionary_aliases`. Spell check, Surprise me, auto-fill, the Computer, `item_stats`, high scores and the Pick and fwd champion merge all key on `category_id`, so **none of those code paths change**. This is the main design choice of this spec (decision C1). A category with no dictionary is still a row; it just has no `dictionary` rows.

### 7.2 Reuse across games
- Custom categories are keyed by a normalized name (`dedupeKey`, so "board games", "Board Games!" and "BOARD  GAMES" are the same key).
- A later build with the same key in **any** room reuses the row and makes no API call. Repeats are free and instant, and the Computer gets stronger in popular custom categories as `item_stats` builds up.
- **A build that came back with zero items is reused too.** That's a real answer, not a failure. A build that **didn't run** (this spec §3.6) is never saved as a reusable row, so the next attempt tries again.
- Other rooms never see a custom category listed. They only get it by typing the same name.

### 7.3 Schema (one migration)
```sql
-- categories: custom rows
alter table this_or_that.categories
  add column is_custom       boolean not null default false,
  add column custom_key      text,         -- dedupeKey of the name; null for built-ins
  add column singular_label  text,         -- "Board game"; null = use plural() guess
  add column plural_label    text,         -- "board games"
  add column generated       boolean not null default false,  -- false = build didn't run; not reusable
  add column created_by_session uuid references this_or_that.sessions (id) on delete set null,
  add column generator_model text,         -- for audit and regeneration
  add column created_at      timestamptz not null default now(),
  add column last_used_at    timestamptz not null default now();
create unique index categories_custom_key_uq
  on this_or_that.categories (custom_key) where is_custom and generated;

-- games: the per-game spell-check switch (this spec §5.3)
alter table this_or_that.games add column spell_check boolean not null default true;
```
- **Custom rows have `is_active = false`**, so `loadCategories()` keeps offering only built-ins. The setup snapshot gets a separate list: built-ins plus this room's own custom categories.
- **Widen `categories.id` from `smallint` to `integer`.** Custom categories can number in the thousands, and smallint stops at 32,767. The same change applies to every column that references it (`dictionary`, `unmatched_entries`, `games`, `category_votes`, `high_scores`) and to `match_item(smallint, …)`. The function is dropped and recreated with its `security definer` and grant re-applied, as in `20260925120000_match_item_definer.sql`.
- **Retention.** A nightly job deletes custom categories unused for 90 days that no `games` or `high_scores` row references; their dictionary and stats cascade. Categories with high-score entries are kept, since boards show the category name.

### 7.4 High scores
Boards are split by mode and length, not by category (§12, Pick and fwd §7). An entry shows its category name, custom or not. Custom names have passed the profanity filter, so they can appear on global boards. A flagged one can be hidden with the existing `hidden` flag. Eligibility gains the 3-card rule (this spec §4.4).

---

## 8. Generation service

### 8.1 Interface
```ts
// lib/server/categoryGen.ts
interface CategoryGenerator {
  generate(name: string): Promise<GeneratedCategory>;              // labels + items, this spec §3.2
  checkRelevance(name: string, items: string[]): Promise<string[]>; // returns items to drop, §3.3
}
```
- The production implementation calls the Claude API through `@anthropic-ai/sdk` from a Server Action.
- Tests use a **fixture generator** (a lookup table of canned responses) chosen by environment, so no test touches the network (this spec §11).
- If `ANTHROPIC_API_KEY` isn't set, the **✏️ Custom** chip is still shown, but every custom category plays with no dictionary (this spec §3.6). `env.ts` reads the key lazily, like the other server settings.

### 8.2 Request shape
- **Model:** `claude-opus-5-5` at `effort: "low"`. The task needs broad world knowledge, not deep reasoning, and low effort keeps it fast. The model id is one constant (decision C4).
- **Structured outputs** (`output_config.format` with a JSON schema) for both requests, so the response is always parseable. The schema enforces the item fields and the 150-item cap, and allows an empty item list. The server still re-validates everything (this spec §3.3), because the model's output is data, not something to trust.
- **The prompt asks for accuracy, not volume:** only items that clearly belong, none invented, and an empty list is a fine answer. That's what keeps thin categories honest instead of padded.
- **The category name is untrusted user input.** It goes into the prompt as clearly delimited data, never as instructions. The 24-character limit, the profanity filter, the fixed output schema and the server-side filtering together limit what a hostile name can do.
- **Refusals:** a `refusal` stop reason means the build didn't run (this spec §3.6). The category is still playable without suggestions.

### 8.3 Limits
- **Time:** 20s per request, at most 1 retry, and 30s in total. Past that, the build didn't run (this spec §3.6).
- **Rate:** at most **3 builds per game** and **10 per room per hour**, counted only for builds that call the API (reuse is free). Past that, new custom categories play without suggestions, with the note *"That's a lot of new categories — this one's without suggestions."*
- **Cost:** roughly 4–6k output tokens per new full category across both requests, less for thin ones. Reuse (this spec §7.2) means a popular name is paid for once.

---

## 9. Architecture (changes to §14)

### 9.1 Engine (`lib/engine`)
- `Game.spellCheck: boolean`, set by `confirm_setup`, whose intent gains an optional `spellCheck` (default `true`).
- `Game.buildingCategory: string | null`, so non-hosts can see "building Board Games…" (this spec §3.6).
- A new **server-only** intent, `hold_setup { name }`. In `setup` it sets `buildingCategory` and, once per game, extends `phaseDeadline` to at least `now + 30s`. `confirm_setup` and the timer's auto-confirm clear `buildingCategory`.
- **Short lists (this spec §4.1)**, the one real engine change:
  - `buildMatchups` accepts lists shorter than `listLength`, places their items in the rounds with the fewest cards (seeded tie-break), and drops rounds with fewer than 2 cards.
  - `Game.roundCount` (rounds actually built) replaces `listLength` wherever the engine counts rounds: advancing after a reveal, the showdown rounds (§9.6), and `max_possible` (§12).
  - `lock_lists` sets `withComputer = false` when the Computer's list is empty (this spec §4.3).
  - `Game.everyBallotHadThree: boolean`, derived from the built match-ups and read by the high-score write (this spec §4.4).
- For full and built-in categories, every list is full, `roundCount === listLength`, and behaviour is unchanged.

### 9.2 Server
- New Server Actions:
  - `buildCustomCategory(token, room, name)`: host only, setup only. Runs §3.1–§3.4 and returns the ready-card data. It refuses only for profanity.
  - `useCustomCategoryWithoutSuggestions(token, room, name)`: creates an ungenerated row (this spec §3.6).
  - `cancelCustomCategory`: clears `buildingCategory`.
- `confirmSetup` checks that a custom `categoryId` was built or reused **by this room's session**, or was used by an earlier game in this room. A client can't confirm another room's custom category by guessing its id.
- `addItem` skips the "Did you mean…?" branch when `game.spellCheck` is false, but keeps exact-match linking (this spec §5.3).
- `lockListsIntent` already stops auto-filling and picking when the pool runs dry (`pool.pop()` returns nothing); it now passes short lists on instead of assuming they're full.
- The dictionary rows are written in their own transaction, **outside the room lock**. A 30s build must never hold the session row.

### 9.3 Client
- `Setup.tsx`: the ✏️ Custom chip, the name field, the building state, the three ready cards (this spec §3.5) with the spell-check switch, the "already a built-in" prompt, and the **Play without suggestions** path.
- `Entry.tsx`: uses `singularLabel` / `pluralLabel` from the snapshot when present, falling back to `plural()`. It hides Surprise me when there's no dictionary and shows the thin-category note (this spec §4.2).
- `Matchup.tsx`: "Round *r* of *roundCount*". `Results.tsx`: the high-score note (this spec §4.4).

---

## 10. The Computer (changes to §9.1)

Unchanged for full categories, run against the custom dictionary:
- **Cold start:** a new custom category has no `item_stats`, so the Computer picks from the generated `popular` tier, the same path as a launch-day built-in.
- **Camouflage:** custom dictionaries hold canonical spellings just like built-ins, so ALL CAPS (§9.1) hides the Computer equally well.
- **Wildcards:** there are no promoted player-originated items yet, so wildcard picks fall back to the regular pool. `pickComputerItems` already handles an empty wildcard pool.
- **Thin categories:** see this spec §4.3.

---

## 11. Testing (additions to §14.10)

All database tests run on in-process PGlite, as today. Tests never call the Claude API; the fixture generator (this spec §8.1) stands in.
- **Unit (refusal):** a profane name is refused. Vague, nonsense and very narrow names are **not** refused.
- **Unit (server filtering):** over-length, profane and duplicate items are dropped, including duplicates via an alias. Allowed lengths follow the surviving count at each boundary: 0, 1, 37, 38, 75, 113.
- **Unit (build didn't run):** an API error, a timeout, a refusal, the rate limit and a missing API key each produce a playable no-dictionary category that isn't saved for reuse.
- **Unit (relevance):** items flagged by `checkRelevance` never reach `dictionary`.
- **Engine (short lists):** short lists fill the emptiest rounds first; rounds with fewer than 2 cards are dropped; `roundCount`, the showdown rounds and `max_possible` follow the rounds played; the Computer sits out with an empty list, even with 2 humans.
- **Engine:** `hold_setup` extends the deadline once and only in `setup`; on expiry the auto-confirm still happens.
- **DB:** a built category, including a zero-item one, is reused by key across rooms with no generator call. `confirmSetup` refuses another room's custom category id. Retention keeps categories that high scores reference. A game with a 2-card ballot writes no high scores.
- **Property:** for any custom game, every Surprise me, auto-fill and Computer item belongs to that game's `category_id`. This is the relevance rule (this spec §1) as a mechanical check.
- **Property:** for any mix of list lengths, every played round has at least 2 cards, and no human score exceeds `max_possible`.
- **Property:** with spell check off, two players typing the exact canonical name still share a card (§9.2.4).
- **Browser smoke test:** with the fixture generator, a full custom category in each mode (build, ready card, Surprise me, Start), and one no-dictionary game where a player times out with a short list.

---

## 12. Open decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| C1 | Where custom dictionaries live | Rows in `categories` / `dictionary` · separate `custom_*` tables · in memory per game | **Rows in the existing tables.** Every downstream feature keys on `category_id` and works unchanged. Separate tables would mean a second code path for spell check, Surprise me, auto-fill and the Computer. |
| C2 | Short lists in thin categories | Sit out rounds (this spec §4.1) · shrink the game to the shortest list · pad with placeholder cards | **Sit out rounds.** Only the player who didn't finish loses chances, and nothing off-topic reaches a ballot. Shrinking punishes everyone for one slow player, and placeholder cards are noise that also gives away whose list is short. |
| C3 | Separate relevance-check request | Yes · no (trust the generating request) | **Yes.** With no gate on the category itself, it's the one defence for the relevance rule. It costs one short request and runs only on a category's first build. |
| C4 | Generation model | `claude-opus-5-5` at low effort · a smaller, faster model | **`claude-opus-5-5` at low effort**, as one constant. Measure build times in playtests; if the 30s budget is tight, trying a faster model is a one-line change. |
| C5 | Who controls spell check | Host switch on custom categories only · host switch for every category · always on | **Custom only.** Built-in dictionaries are curated and their "Did you mean…?" prompts are trustworthy. |
| C6 | Can other rooms see custom categories? | Private (reuse by typed name only) · public "popular custom categories" list | **Private in v1.** With only a profanity filter on names, a public list would need real moderation. Reuse by key already gets the cost and quality benefits. |
| C7 | Setup timer during a build | Extend once to ≥30s · pause while building · no change | **Extend once.** Pausing lets a host stall the room indefinitely. With no change, the 45s timer often runs out during a build. |
| C8 | High scores for thin games | Require every ballot to have 3+ cards · count every game · exclude all thin games | **3+ cards.** It's the exact condition that makes percentages meaningful (§9.1, §12), and a thin category whose lists all filled still counts. |
| C10 | Computer with no dictionary | Sit out · borrow the closest built-in (host can change) · random items from any category | **Borrow, host's choice** (v0.4). Random items from any category give the Computer away at once; a host-picked neighbour stays plausible. |
| C11 | Promote players' entries in custom categories | Manual review, as for built-ins (§8) · automatically after each finished game | **Automatically** (v0.4). Custom categories are room-scoped and small; waiting for review means they never grow. |
| C9 | Promote popular custom categories to built-in | Manual review · automatic past N games · never | **Manual review**, matching dictionary-item promotion (§8). |

---

## 13. Acceptance criteria

- [ ] Host Setup offers ✏️ Custom in both modes. **Profanity is the only reason a category name is refused.** Vague, narrow and nonsense names are all playable.
- [ ] A name close to a built-in category offers that category first, without forcing it. A name built before is reused instantly, with no API call.
- [ ] Generated items are filtered (length, profanity, duplicates via aliases) and relevance-checked. Off-topic items never reach the dictionary, and a short dictionary is never padded.
- [ ] Allowed lengths follow the surviving item count: thin categories with 1–37 items allow 5, and no-dictionary categories allow any length.
- [ ] The ready card shows the item count, allowed lengths and examples, plus the thin-category or no-dictionary warning where it applies, and the spell-check switch when there's a dictionary.
- [ ] A failed, refused, rate-limited or unconfigured build still leads to a playable category via **Play without suggestions**. The game never dead-ends in setup.
- [ ] Every Surprise me, auto-fill and Computer item in a custom game comes from that game's custom dictionary. Surprise me is hidden when there's no dictionary.
- [ ] Short lists sit out rounds; rounds with fewer than 2 cards are dropped; the round count, showdown and `max_possible` follow the rounds played. With an empty Computer list the Computer sits out, even with 2 humans.
- [ ] A game with any 2-card ballot doesn't count for high scores, and the results screen says why.
- [ ] With spell check on, "Did you mean…?" works against the custom dictionary and its aliases. With it off, there are no prompts, but exact matches still link so duplicates merge.
- [ ] The entry prompt uses the generated plural and singular forms, falling back to the `plural()` guess.
- [ ] A build never takes more than 30s, and the setup timer is extended once and never stalls the room.
- [ ] A custom category can't be confirmed by a room that didn't build it or use it before.
- [ ] Custom categories stay available on Play Again in the same room.
- [ ] Full and built-in categories play exactly as before: every list is full, and the round count equals the list length.
- [ ] `categories.id` and every column and function that references it are widened to `integer` in one tested migration.
- [ ] No test calls the Claude API.
- [ ] Setup shows the top 5 built-in categories for the selected mode as chips with Random and Custom, and the rest in a grouped dropdown (v0.6).
- [ ] Every category offers 5, 10 and 15 (v0.5). Past its suggested maximum, Setup warns; the setup timer's auto-pick never goes past it.
- [ ] A custom category with a short dictionary suggests the closest built-in to borrow from (or none), and the host can change it. The Computer, Surprise me and auto-fill then use the category's own items first and the borrowed items for the rest. Spell check never uses borrowed items, and votes on them don't update `item_stats`.
- [ ] Items players typed in a finished custom-category game join its dictionary (not auto-fills, Surprise me picks, or the Computer's), and the room's next game in that category uses them.

---
---

# Part B — Kids' categories

## B1. Summary

The launch categories (§7) are all-ages but adult-leaning: Tourist Destination, Meal, Drink. This part adds **18 built-in categories** about things players aged **6–12** care about: TV shows, characters, toys, games, candy and more. They work in both modes, and in custom-category rooms too, since they're ordinary built-in categories.

The game itself doesn't change. These are new rows in `categories` and new `dictionary` seed files, plus a few rules that matter more for kids' content:
- **Age-appropriate** items only (this spec §B3).
- **Recognizable** items in the popular tier, since that tier is what the Computer plays (this spec §B4).
- **Fresh:** kids' pop culture dates fast, so stale items can be retired without breaking history (this spec §B5).
- **Easy to find:** a "Kids' favorites" group in setup (this spec §B6).

They aren't a separate mode, and they aren't hidden from adults. Plenty of grown-ups have strong opinions about SpongeBob.

---

## B2. The categories

Size classes follow the §7 dictionary requirement: Large needs 113 items, Medium 75, Small 38. Counts are of **active** items (this spec §B5).

| Category | Slug | Size class | Entry prompt (plural label) | Example items |
|---|---|---|---|---|
| Cartoon Character | `cartoon-character` | Large | cartoon characters | SpongeBob, Bluey, Pikachu, Mickey Mouse, Elsa |
| Kids' TV Show | `kids-tv-show` | Large | TV shows | Bluey, SpongeBob SquarePants, Paw Patrol, Pokémon, The Loud House |
| Animated Movie | `animated-movie` | Large | animated movies | Frozen, Toy Story, Moana, Encanto, Shrek |
| Video Game | `video-game` | Large | video games | Minecraft, Mario Kart, Animal Crossing, Pokémon Scarlet, Kirby |
| Toy | `toy` | Large | toys | Lego, Hot Wheels, Slime, Nerf Blaster, Rubik's Cube |
| Dream Job | `dream-job` | Large | dream jobs | Astronaut, Vet, YouTuber, Chef, Firefighter |
| Pokémon | `pokemon` | Large | Pokémon | Pikachu, Eevee, Charizard, Snorlax, Mewtwo |
| Candy | `candy` | Medium | candies | Skittles, Gummy Bears, Kit Kat, Lollipop, Cotton Candy |
| Ice Cream Flavor | `ice-cream-flavor` | Medium | ice cream flavors | Cookie Dough, Mint Chip, Cotton Candy, Rocky Road, Superman |
| Breakfast Cereal | `breakfast-cereal` | Medium | breakfast cereals | Lucky Charms, Froot Loops, Cheerios, Cinnamon Toast Crunch |
| Superhero | `superhero` | Medium | superheroes | Spider-Man, Batman, Wonder Woman, Black Panther, Miles Morales |
| Dinosaur | `dinosaur` | Medium | dinosaurs | T. Rex, Triceratops, Velociraptor, Stegosaurus, Brachiosaurus |
| Book Series | `book-series` | Medium | book series | Dog Man, Diary of a Wimpy Kid, Harry Potter, Wings of Fire, Magic Tree House |
| Vehicle | `vehicle` | Medium | vehicles | Monster Truck, Fire Truck, Rocket, Submarine, Helicopter |
| Superpower | `superpower` | Small | superpowers | Flying, Invisibility, Super Speed, Teleporting, Time Travel |
| Mythical Creature | `mythical-creature` | Small | mythical creatures | Dragon, Unicorn, Mermaid, Phoenix, Yeti |
| Pet | `pet` | Small | pets | Dog, Cat, Hamster, Guinea Pig, Axolotl |
| Playground Game | `playground-game` | Small | playground games | Tag, Hide and Seek, Four Square, Hopscotch, Red Light Green Light |

- Items name **jobs, flavors and things**, never real people (this spec §B3). "YouTuber" is a Dream Job; no actual YouTuber appears anywhere.
- Overlap between categories is fine (Pikachu is a Cartoon Character and a Pokémon). Each category's dictionary stands alone.
- **Pokémon** is the only single-franchise category. It's in because 6–12-year-olds care about it more than almost anything, it has 1,000+ well-known names, and its spell-check benefit is huge (decision K4).
- **Dropped candidates:** School Subject and Holiday (too few items even for Small); YouTuber / Streamer and Singer (real people, this spec §B3); Song (dates too fast and is hard to keep age-appropriate).

---

## B3. Content rules

Every item in a kids' dictionary must meet all of these. They apply to the dictionary, which is what the game **suggests and plays**. Players can still type anything that passes the §8 filters, as in every category.

1. **Age-appropriate.** Media items must carry an age rating suitable for 6–12 (decision K1):
   - TV: TV-Y, TV-Y7, TV-G or TV-PG.
   - Films: G or PG.
   - Games: ESRB E or E10+ (or PEGI 3/7).

   A franchise item takes the rating of what kids actually watch or play. Spider-Man is fine as a Superhero because of the many kid-rated Spider-Man shows and games, even though some Spider-Man films are PG-13.
2. **No real people.** No YouTubers, streamers, athletes, singers or actors. Their content and reputations change without notice, and the game can't review them continuously. Fictional characters are fine.
3. **Widely known.** An item belongs if a typical 6–12-year-old in the US could plausibly name it, or would recognize it on a card. That's a stricter bar than "a real member of the category", because an obscure item on a kids' ballot reads as the Computer (§9.1).
4. **Canonical name = official title** in its common form ("SpongeBob SquarePants", "Paw Patrol"), ≤30 characters (§8).
5. **Aliases for how kids type** (§8 spell check):
   - Short forms: `SpongeBob` → SpongeBob SquarePants, `TMNT` → Teenage Mutant Ninja Turtles.
   - Unaccented forms: `Pokemon` → Pokémon, `Flabebe` → Flabébé. This matters because `dedupeKey` currently drops accented letters instead of folding them, so "POKÉMON" and "POKEMON" don't match (this spec §B8).
   - Common misspellings are mostly left to fuzzy matching (§8); add an alias only for misspellings too far for it to catch.
6. **Names only.** Items are plain text. No logos, images or character art, since the game only ever shows ALL CAPS text (§9.1).

---

## B4. The popular tier and the Computer

The popular tier (about 20 items per category) is what the Computer plays before `item_stats` exists (§9.1). In kids' categories it carries extra weight:
- **It must be what kids know now**, not what was big a decade ago. The Computer playing a cartoon from 2009 is an instant giveaway.
- **Mix evergreen and current:** roughly half evergreen (SpongeBob, Mario, Lego) and half current, refreshed at each review (this spec §B5).
- **Every popular item meets rule 3 (§B3) with room to spare.**

Once `item_stats` builds up, the Computer's picks follow what players actually vote for, as with every category.

---

## B5. Freshness and retirement

Kids' pop culture moves fast, so kids' categories get a **review every 6 months**: add what's new, update the popular tier, and **retire** what's faded.

**Retiring is not deleting.** Old `favorites` rows and `item_stats` point at dictionary items, so deleting them would break history. Instead:
- `dictionary.retired_at timestamptz` (null = active).
- **Retired items** are excluded from Surprise me, auto-fill, the Computer's picks and the popular tier.
- **Retired items still count for spell check and duplicate detection**, so a player typing a faded show still gets its canonical spelling, and two players typing it still share a card.
- **Size requirements count active items only.** `categoryOption()`'s dictionary count adds `retired_at is null`, so retiring too much automatically caps a category's lengths (§7) until it's topped up.

The rule applies to every category, built-in or custom, though in practice only kids' categories will use it in v1.

---

## B6. Setup (changes to §7)

With 28 built-in categories, one row of chips gets crowded. The category step groups them:

```
Pick a category
  Everyone          Fruit · Meal · Animal · Dessert · Snack · Drink · Color · …
  Kids' favorites   Cartoon Character · Kids' TV Show · Toy · Video Game · Candy · …
  🎲 Random  ·  ✏️ Custom
```

- A category belongs to one group, set by a new `categories.audience` column (`'everyone'` or `'kids'`).
- **Random** picks from both groups (decision K3).
- **The setup timer's auto-pick** (§7) also picks from both groups.
- **Optional category vote** (§7): its 3 random offers draw from both groups.
- The groups are only about layout. Nothing restricts who can pick a category.

---

## B7. Labels (shared with Part A)

Part A adds `singular_label` and `plural_label` to `categories` (this spec §7.3). Kids' categories set them, because the current `plural()` guess in `Entry.tsx` (lowercase, add "s") gets them wrong:

| Category | `plural()` today | Label |
|---|---|---|
| Kids' TV Show | "kids' tv shows" | "TV shows" |
| Pokémon | "pokémons" | "Pokémon" |
| Candy | "candys" | "candies" |
| Superhero | "superheros" | "superheroes" |
| Dream Job | "dream jobs" | "dream jobs" (unchanged) |

Labels keep their capitalization in the prompt ("List 10 TV shows you'll defend"). The existing built-ins get labels too where they read better ("Tourist Destination" → "tourist destinations" is already right; no change needed there).

---

## B8. Data and how the dictionaries are built

### B8.1 Schema (in the same migration as Part A)
```sql
alter table this_or_that.categories
  add column audience text not null default 'everyone' check (audience in ('everyone', 'kids'));
alter table this_or_that.dictionary
  add column retired_at timestamptz;   -- this spec §B5
```
- The 18 categories are inserted by slug in the migration, as the launch categories are, with `audience = 'kids'` and their labels.
- `loadCategories()` returns `audience`; the setup snapshot uses it for grouping.

### B8.2 Seed files
- Items go in a new seed file, `db/seed/kids.sql`, in the same format as `dictionary.sql`: canonical items, the popular tier, and aliases, all `on conflict do nothing`. `npm run db:seed` already applies every `.sql` file in `db/seed/`.
- **Retirements** go in a separate file, `db/seed/retirements.sql`, as idempotent updates (`set retired_at = coalesce(retired_at, now())`). This is a small, deliberate exception to "seed never updates a row".

### B8.3 Building the lists
- Each list is **drafted with the generation service** from Part A (this spec §8), run offline with a kids' prompt that includes the content rules (this spec §B3), then **reviewed by hand** before it's committed. The draft saves typing; the review is what makes it trustworthy.
- The reviewer checks every item against §B3, picks the popular tier, and adds aliases.
- Each category's file section starts with a comment recording its review date, e.g. `-- kids-tv-show: 131 items, 20 popular, reviewed 2026-10-13`.

### B8.4 Accent folding
`dedupeKey` (`lib/engine/text.ts`) uppercases and then keeps only `A–Z` and `0–9`, so "É" is **dropped**: "POKÉMON" → `POKMON`, but "POKEMON" → `POKEMON`. Duplicate detection (§8, §9.2) then misses the match. Fix it at the source by folding accents first (`normalize('NFD')` and stripping combining marks), so both become `POKEMON`. The aliases in §B3 rule 5 remain as a second layer for spell check. This is a general fix that changes the key of every accented item. Today that's safe, because `dedupeKey` is only ever computed on the fly and never stored. Part A's `categories.custom_key` (this spec §7.3) is the first stored use, so the fix must ship **before or with** Part A.

---

## B9. Testing

- **Seed checks** (a test over the seed files, on PGlite):
  - Every kids' category meets its size class with **active** items.
  - Every canonical name and alias is ≤30 characters, passes the profanity filter, and is unique by `dedupeKey` within its category.
  - Every category has at least 20 popular items, all active.
  - Every kids' category has its labels set.
- **Retirement:** retired items never come from Surprise me, auto-fill or the Computer, still match spell check exactly, and don't count toward allowed lengths.
- **Accent folding:** `dedupeKey("Pokémon") === dedupeKey("Pokemon")`, and two players typing those share a card.
- **Setup:** categories are grouped by audience; Random and the timer's auto-pick can choose from both groups.

---

## B10. Open decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| K1 | Rating bar for media items | E/E10+, G/PG, TV-Y–TV-PG only · also allow T-rated games kids overwhelmingly play (Roblox, Fortnite) | **The strict bar, owner's call on exceptions.** Roblox and Fortnite are among the most-played games for this age group, and leaving them out will look odd to kids. But they're rated T, and parents are part of the audience. If allowed, list each exception by name in the seed file with the reason. |
| K2 | Regional bias | US-centric lists · international mix | **US-centric in v1**, matching the existing dictionaries (localization is out of scope, §16). Players elsewhere can still type their own items, and those are accepted as typed. |
| K3 | Random and auto-pick | Draw from all groups · from the group the host last browsed · a room setting for "Kids' favorites only" | **All groups in v1.** A kids-only room setting is cheap to add later if families ask for it. |
| K4 | Single-franchise categories | Pokémon only · more (Minecraft Mob, Disney Princess, Mario Character) · none | **Pokémon only** to start. Watch play counts; add franchises that kids pick often. |
| K5 | Review cadence | Every 6 months · yearly · when someone notices | **Every 6 months**, with the date recorded in each seed section (this spec §B8.3). |

---

## B11. Acceptance criteria

- [ ] The 18 kids' categories exist, each meeting its size class with active items, with at least 20 popular items and display labels.
- [ ] Every dictionary item meets the content rules in this spec §B3: age-appropriate rating, no real people, widely known, official name ≤30 characters, aliases for common short and unaccented forms.
- [ ] Setup groups categories into "Everyone" and "Kids' favorites". Random, the timer's auto-pick and the category vote draw from both.
- [ ] The entry prompt reads correctly for every category ("List 10 TV shows you'll defend", "List 5 Pokémon you'll defend").
- [ ] Retired items are never suggested or played by the game, still match spell check, and don't count toward allowed lengths.
- [ ] "Pokémon" and "Pokemon" count as the same item for duplicates.
- [ ] Each kids' seed section records its item count, popular count and review date.
