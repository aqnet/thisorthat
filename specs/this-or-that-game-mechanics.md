# This or That — Game Mechanics Spec

**Status:** Draft v0.6 · **Date:** 2026-09-24 · **Owner:** Anderson
**Depends on:** This or That Design System (themes: Duel, Candy Pop)

**Changelog**
- v0.6 — **Ballot cards are always ALL CAPS**, uppercased server-side, so casing and typing style can't reveal who wrote an item (§9.1, §9.3).
- v0.5:
  - Dedicated **`this_or_that`** schema, with a tested migration.
  - **Timers fully server-driven:** a pg_cron job every 1s drives `/api/advance`; clients no longer trigger anything.
  - Direct Postgres access via the transaction pooler.
  - Transactional Realtime broadcasts.
  - `games` table split out of `sessions`.
- v0.4 — Architecture & runtime (§14):
  - Next.js full-stack app on Vercel; connected Supabase for Postgres, Realtime, anonymous auth, and pg_cron.
  - Pure TypeScript game engine behind Server Actions, with optimistic concurrency.
  - Timers stored as deadlines; RLS-enforced hidden information.
  - Testing and ops plan.
- v0.3 — Dead-end and fun review folded in:
  - Category size classes cap list length.
  - Leave / End Game exits and a player-departure policy.
  - Error screens for joining; Play Again returns to the lobby.
  - Rejoin by seat; Final Showdown rounds.
  - Percentage-based high scores with weekly and room boards.
  - Crowd-pleaser framing; setup timer and confirm step; category vote.
  - Surprise-me fill, list editing, rejection reasons, relaxed timers, home screen.
- v0.2 — Added the **Computer** player: always present, contributes one item to every match-up, scores like a player, never votes. Resolves the 2-player tie problem.
- v0.1 — Initial draft.

---

## 1. Summary

A Jackbox-style party game for 2–4 human players on their own phones, plus an always-present **Computer** player. The host creates a session, players join via QR code or URL, everyone enters items they'll defend in a chosen category, and then those items, plus one Computer-picked item, are pitted against each other in match-ups. Players vote on each match-up; the owner of the winning item scores. The last round is a double-points Final Showdown. Highest total wins, and top scores go on high-score boards.

The Computer guarantees every ballot has at least 3 items, so no game is ever a degenerate 2-way vote, and it gives every game a shared opponent: **beat the Computer.**

### What the game rewards
The game rewards **picking items other people will love**, not listing your personal favorites. The UI says so plainly ("List fruits you'll defend"), so players who figure out the strategy feel clever rather than misled.

### Design principles
- **Phone-first, no install.** Join from a browser in under 10 seconds.
- **One screen, one job.** Each phase shows exactly one primary action per player.
- **No dead ends.** Every screen has a forward action and a way out. Every wait has a timer and shows who you're waiting on.
- **Trailing players stay invested.** Escalating stakes at the end mean the game is never decided early.
- **The theme is the game's personality.** All screens are built from design-system tokens so Duel and Candy Pop swap without layout changes.

---

## 2. Game Flow Overview

```
[Home] → [1 Create Session] → [2 Lobby: Join & Name] → [3 Host Setup] → [4 Enter Items]
     → [5 Match-ups: Vote → Reveal → Score] × N (last = Final Showdown)
     → [6 Final Results] → [7 High Scores] → Play Again ⟲ Lobby
```

| # | Phase | Who acts | Ends when | Exits |
|---|-------|----------|-----------|-------|
| 0 | Home | Anyone | Choice made | — |
| 1 | Create Session | Host | Session created | Cancel Room |
| 2 | Lobby | All players | Host taps **Start** (≥2 humans) | Leave · Cancel Room |
| 3 | Host Setup | Host (+ optional category vote) | Confirmed, or 45s timer | Leave · End Game |
| 4 | Enter Items | All players | All lists locked, or timer | Leave · End Game |
| 5 | Match-ups | All players | All N match-ups played | Leave · End Game |
| 6 | Final Results | Host decides next | Play Again / New Room / Exit | Leave |
| 7 | High Scores | — | Qualifying scores recorded | Back |

**Universal rules**
- Every in-game screen has a menu with **Leave Game** (all players) and **End Game** (host only, with a confirmation).
- Every waiting state names who is being waited on ("Waiting on Maya…") and shows the remaining time.

---

## 3. Home Screen

Four actions: **New Game · Join · High Scores · Settings**.

- **Join** accepts a room code. Deep links (`/join/KZPW`) skip straight to the name step.
- **Settings** holds theme choice (Duel / Candy Pop), sound, and reduced motion.

---

## 4. Phase 1 — Create Session

1. Host taps **New Game**.
2. Server creates a session with:
   - **Room code:** 4 uppercase letters, excluding ambiguous characters (no `I`, `O`) and filtered against an offensive-word list. Example: `KZPW`.
   - **Join URL:** `https://<domain>/join/KZPW`
   - **QR code** encoding the join URL.
3. Host screen shows the room code (large, display font), QR code, and a **Share** button (native share sheet / copy link).
4. The host is automatically seated as Player 1, and the Computer is seated alongside.

**Rules**
- Room codes are unique among active sessions and expire after 2 hours of inactivity.
- Session state lives server-side; clients are views of that state (see §14).

---

## 5. Phase 2 — Lobby: Join & Player Name

1. Player opens the URL, scans the QR code, or enters the room code on Home.
2. Player enters a **player name**.
3. Lobby shows all seated players (and the Computer), updating live.

**Name rules**
- 1–12 characters, trimmed.
- Unique within the session (case-insensitive). On collision: "That name's taken — try another."
- **Reserved:** "Computer" and close variants ("C0mputer", "The Computer", "CPU", "Bot", "AI") → "That name belongs to the Computer."
- Profanity-filtered. Rejections always state the reason.
- Each human is auto-assigned a **player color** from the active theme's player palette (4 slots).

**Capacity**
- Min 2, max 4 human players (host included).
- The **Computer** is seated automatically in every lobby as a fixed extra seat. It doesn't count toward the 4-player cap, can't be removed, and is shown with its own icon and color (§13).

**Host controls in the lobby**
- **Start** is disabled with fewer than 2 humans, and labelled with the reason: "Need 1 more player."
- **Remove player** (tap a player → Remove, with a confirmation). A removed player sees "You were removed from the room" with **Home**.
- **Cancel Room** closes the session. Everyone sees "The host closed the room" with **Home** and **Start your own**.
- **Game settings:** relaxed timers (1.5× setup, category-vote, and entry timers; the 15s vote timer is fixed; default off) and category vote (default off).

**Leaving the lobby:** any player can tap **Leave**, which frees their seat.

---

## 6. Join Errors & Recovery

Every failed join lands on a screen with a clear next step.

| Situation | Screen | Actions |
|---|---|---|
| Code invalid or expired | "Room not found" | Code field (retry) · **New Game** |
| Room closed by host | "This room was closed" | **Home** · **Start your own** |
| Room full (4 humans) | "Room is full" | **Start your own** · **Home** |
| Game in progress | "Game in progress — you'll join the next game" | Wait (queued) · **Start your own** |

**Queued joiners**
- A queued joiner enters their name now and sees a live, read-only scoreboard while waiting.
- They are seated automatically when the room returns to the lobby (Play Again, §11), if a seat is free.
- If no seat frees up, they see "Room is still full" with **Start your own**.

### Reconnect & rejoin
- **Same device:** the Supabase anonymous-auth session persisted on the device resumes the seat automatically, at the current phase.
- **Different device or cleared browser:** the join screen lists disconnected seats as "Rejoin as Maya?" Rejoining takes over the seat and its score. A seat can only be claimed while it is disconnected.
- **Host disconnects for more than 60s:** the host role transfers to the longest-seated connected player, who gets a toast: "You're the host now."

---

## 7. Phase 3 — Host Setup

### 3a. Category
Categories have a **size class**, which limits the list lengths available (§3b). This is what stops players from running out of ideas at item 9 of 15.

| Category | Size class | Allowed lengths | Example items |
|----------|-----------|-----------------|---------------|
| Fruit | Large | 5 · 10 · 15 | Mango, Strawberry, Pineapple |
| Meal | Large | 5 · 10 · 15 | Tacos, Ramen, Pizza |
| Tourist Destination | Large | 5 · 10 · 15 | Paris, Tokyo, Grand Canyon |
| Animal | Large | 5 · 10 · 15 | Otter, Red Panda, Dolphin |
| Dessert | Large | 5 · 10 · 15 | Tiramisu, Brownie, Gelato |
| Snack | Medium | 5 · 10 | Popcorn, Pretzels, Chips |
| Drink | Medium | 5 · 10 | Lemonade, Cold Brew, Boba |
| Color | Medium | 5 · 10 | Teal, Crimson, Gold |
| Sport | Small | 5 | Soccer, Tennis, Basketball |
| Movie Genre | Small | 5 | Horror, Rom-com, Sci-fi |

**Dictionary size requirement:** each category's dictionary must hold at least **1.5 × (4 × max length + max length)** canonical items. That's 113 for Large, 75 for Medium, and 38 for Small. The requirement leaves headroom for human lists, auto-fill, and a strong Computer pick. A category whose dictionary falls short is capped at the next size down until it's grown.

A **Random** option picks any category, then shows it for confirmation. Custom categories are out of scope for v1 (see §16).

**Optional category vote (lobby setting):**
1. Host taps **Let everyone vote**, and 3 random categories are shown to all players.
2. Every human votes, with a 15s timer. The top vote wins; ties are broken randomly.
3. The host then picks the length.

This gives non-hosts something to do during setup.

### 3b. List length
The host picks **5, 10, or 15** items per player, limited to the category's allowed lengths. This equals the number of match-ups (rounds) in the game.

### 3c. Confirm
A confirmation card: **"Fruit · 10 items — Start?"** with **Start** and **Back**. This is the undo point; there's no changing the category after Start.

### Timers & waiting
- Host setup timer: **45s**. On expiry, the game picks a Random category, the longest allowed length up to 10, and auto-confirms.
- Non-host players see "Host is choosing…", with the selections appearing live as the host makes them, plus the countdown.

---

## 8. Phase 4 — Enter Items

Each player privately enters items in the chosen category, up to the chosen list length.

**Prompt copy:** "List [category] you'll defend." For example, *"List 10 fruits you'll defend."* Subtext: *"Points go to the picks everyone else loves."*

**Entry UX**
- One text field, **Add** button, list of entries below with remove (×).
- **Surprise me** button fills the next empty slot with a random dictionary item, excluding items already on this player's list. The item is tagged 🎲 in the player's own list only.
- Counter: "7 / 10".
- **Submit** is enabled only when the list is full.
- **Edit after submit:** a submitted player can tap **Edit** to reopen their list until all lists lock.
- Timer: 60s (5 items) / 120s (10) / 180s (15), or 1.5× with relaxed timers. Visible countdown.
- Other players' progress is shown as counters only ("Maya 6/10 · Ben ✓"), never their items.

**Validation & normalization**
- Trim, collapse whitespace, Title Case in the player's **own list** (`"  mango " → "Mango"`). Ballots use a separate ALL CAPS form (§9.1).
- 1–30 characters. Profanity-filtered.
- **No duplicates within a player's own list** (case- and spelling-insensitive after normalization).
- **Every rejection shows its reason inline** under the field:
  - "Already on your list"
  - "Keep it under 30 characters"
  - "Let's keep it friendly — try another"
  - "Type something first"

**Spell check (the favorites dictionary)**
- Each category has a **dictionary** of known items with canonical spellings, e.g. Fruit → `Pineapple`, `Pomegranate`, `Kiwi`.
- On **Add**, the entry is fuzzy-matched against the dictionary (edit distance / trigram similarity):
  - Exact match → accept, use canonical spelling.
  - Close match → suggest inline: *"Did you mean **Pomegranate**?"* [Yes] [Keep mine].
  - No match → accept as typed.
- Synonyms/aliases map to one canonical item where it matters for duplicate detection (e.g. `NYC` → `New York City`).
- **Dictionary growth:** entries accepted as-typed are logged. An item entered by N distinct players (suggested N = 5) becomes a promotion candidate. Promotion is manual-review in v1 to keep junk out.

**Lock & timer expiry**
- Lists lock when every connected human has submitted, or when the timer expires.
- Unfilled slots are auto-filled with random dictionary items, which are tagged 🎲 on reveal. The game never stalls.

---

## 9. Phase 5 — Match-ups

### 9.1 The Computer player

The Computer is a full scoring participant that **plays items but never votes**.

**Why it doesn't vote:** it has no taste, so its votes would be random, and in a 2-player game a random tiebreaker would decide most rounds. Human votes decide the game. Every point the Computer earns comes from humans preferring its pick.

**How the Computer picks items**
- After human lists lock, the server builds the Computer's list of N items from the category dictionary.
- **Excluded:** any canonical item already on a human list in this session, including auto-filled ones.
- **Weighted by strength:** selection is weighted toward items with high historical win rates (`item_stats`, §14). A weak Computer turns 2-player games back into 1–1 ties, because both players skip its card, so strength is load-bearing, not cosmetic.
- **Cold start:** before enough stats exist, use a hand-curated "popular" tier per category (~20 items) seeded at launch.
- **Occasional wildcards:** about 10% of Computer picks come from promoted, player-originated dictionary entries. That makes it harder to spot the Computer by its "generic" picks.
- **Variety:** the same Computer item is not repeated for the same group of players within 3 consecutive games.
- Tunable knob: `computer.strength` (0–1), mixing uniform-random vs win-rate-weighted selection. Default 0.7, tuned from play data.

**Camouflage rules**
- **Ballot text is ALL CAPS, always.** Every card, human- or Computer-entered, is shown uppercase: `Mango`, `mango`, and `MANGO` all become **MANGO**. That removes casing as a tell ("Ben never capitalizes", "the Computer always title-cases").
- **Ballot normalization** (applied to every card, in this order):
  1. Trim, and collapse whitespace.
  2. Straighten curly quotes and apostrophes (`’` → `'`).
  3. Strip trailing punctuation (`Mango!!` → `Mango`).
  4. Uppercase with a fixed locale (`en-US`).
- **Done on the server, not in CSS.** The card text is uppercased before it's stored in `ballot_cards` and broadcast. CSS `text-transform: uppercase` would leave the original casing in the payload and the DOM, readable by anyone with dev tools.
- **Where caps apply:** ballot cards during voting, the reveal, the fun stats, and results, so an item looks the same everywhere it's shown publicly. A player's own entry list keeps Title Case, because that's private and easier to proofread.
- Card order is randomized, so position never reveals the Computer.
- Ownership is revealed only after voting, like every other card.
- **Accepted leaks:**
  - Caps mask casing and punctuation, but not spelling. A kept misspelling (`POMEGRANITE`, via "Keep mine") or a quirky homemade item (`GRANDMA'S LASAGNA`) still reads as human.
  - Spell-check suggestions shrink the first leak. The second one is part of the bluff.

### 9.2 Building match-ups
When all human lists are locked and the Computer's list is generated:
1. Each list (humans and Computer) is **shuffled independently** (server-side, seeded RNG logged for debugging).
2. Match-up *i* contains item *i* from every shuffled list.
3. With N items per player there are exactly **N match-ups** (5, 10, or 15).
4. **Collision handling:** if two human players' items in the same match-up are the same canonical item, the server swaps positions within one player's list to separate them. If duplicates can't be separated (rare), the shared item appears once with both owners credited (§9.5). The Computer never collides, because its items are excluded from human lists (§9.1).

Each match-up shows **one item per human player plus one Computer item**:

| Human players | Cards per ballot | Choices per voter (excluding own) |
|---|---|---|
| 2 | 3 | 2 — a true "this or that" |
| 3 | 4 | 3 |
| 4 | 5 | 4 |

### 9.3 Match-up screen
- Items displayed as cards in **ALL CAPS** (§9.1), with the **owner hidden** during voting.
- Card type uses `font.display` (Big Shoulders Display / Lilita One), which both read well in caps. Wrap long items onto a second line; never truncate, since a 30-character item must fit. No letter-spacing tweaks per card, so every card looks identical.
- Card order randomized per match-up so position doesn't reveal ownership.
- Header: "Round 3 of 10 · Fruit".
- Vote timer: **15s flat**, for every round, player count, and setting.
- Layout must fit 5 cards on a phone screen without scrolling (2-column grid + 1 centered, or stacked list). Designed against the 5-card worst case.
- After voting: "Vote locked ✓ · Waiting on Ben…" with the countdown.

### 9.4 Voting rules
- Every human player votes for exactly **one** item.
- **Players cannot vote for their own item** — their own card is shown but disabled ("Yours"). Without this, every player votes for themselves and every round ties.
- Players may vote for the Computer's item — they just don't know which card it is.
- The Computer does not vote.
- Players who don't vote before the timer expires cast no vote.
- Votes are locked on tap (no changes), keeping reveals fast.
- The server waits only for **connected** players. When the last connected vote arrives, the round resolves immediately.

### 9.5 Reveal & scoring
After all connected votes are in or the timer expires:
1. Reveal vote counts per item with an animation, then reveal each item's owner (player color + name; Computer card gets its icon).
2. **Round points:** each item's owner earns **1 point per vote their item received**. This includes the Computer.
3. **Round winner:** the owner of the item with the most votes. Winner gets a highlight treatment plus a **+1 round-win bonus**. The Computer can win rounds.
4. **Ties** for most votes: all tied owners are round co-winners and each gets the +1 bonus.
5. **No votes cast** (everyone timed out): no points, no winner.
6. Shared duplicate items: each owner receives the full vote count.
7. **Final Showdown multiplier** applies to the last round(s) (§9.6).
8. **Lead-change callout:** if the scoreboard leader changes, the reveal ends with a callout ("Maya takes the lead!" / "The Computer takes the lead!").
9. The running scoreboard (Computer included) updates, then auto-advances after 4s. The host can tap **Next** to skip.

**Scoring example (3 players, round 1):** Ana's *Mango* gets 2 votes, the Computer's *Pineapple* gets 1, Ben's *Kiwi* and Cy's *Plum* get 0 → Ana +2 +1 bonus = 3, Computer +1, Ben 0, Cy 0.

**2-player outcomes.** Each voter chooses between the opponent's item and the Computer's:

| Ana votes | Ben votes | Result |
|---|---|---|
| Ben's item | Ana's item | Ana and Ben tie: each +1 +1 bonus = 2 |
| Computer | Ana's item | Ana and Computer tie: each +1 +1 bonus = 2; Ben 0 |
| Ben's item | Computer | Ben and Computer tie: each +1 +1 bonus = 2; Ana 0 |
| Computer | Computer | Computer wins outright: +2 +1 bonus = 3 |

In 2-player games, only the Computer can win a round outright; every other outcome is a two-way tie. That's fine: the scoring still separates players, because the player whose item got passed over scores 0. The round-win bonus matters less in 2-player games and more in 3–4 player games, where votes spread across more items.

### 9.6 Final Showdown
The last round(s) are worth **double points** (votes and bonus both ×2):

| List length | Final Showdown rounds |
|---|---|
| 5 | Round 5 |
| 10 | Round 10 |
| 15 | Rounds 13–15 |

- Final Showdown rounds get a distinct intro card ("FINAL SHOWDOWN · ×2") and theme-driven treatment (`motion.showdown`, `color.showdown`).
- Before the first showdown round, show the standings with the gap to the leader ("Ben is 4 behind — still in it"). This makes it clear trailing players can still win.

### 9.7 Player departure mid-game
- A player who **leaves** (taps Leave, or is disconnected for more than 60s):
  - Their items stay on every remaining ballot and can keep earning points.
  - They no longer vote, and the server stops waiting for them.
  - Their score is frozen on the scoreboard, marked "left".
- If a departed player rejoins (§6), they resume voting from the next match-up.
- **Fewer than 2 connected humans:** the game pauses with "Waiting for players…" and a 60s countdown. The remaining host sees **End Game** and **Keep Waiting**. On timeout, the game ends automatically (see below).
- **End Game** (host, any phase) goes straight to Final Results with current scores, labelled "Game ended early." Early-ended games are **not eligible** for high scores.

---

## 10. Phase 6 — Final Results

- Total score = sum of round points + round-win bonuses (with Final Showdown multipliers) across all N match-ups.
- Podium screen: all players plus the Computer, ranked, with player colors. Each human's **percentage score** (§12) is shown alongside their points.
- **Tiebreaker for the win:** most round wins; if still tied, shared victory.
- **If the Computer finishes first:** "The Computer wins." Nobody gets a victory, but the best-placed human is shown as "Top Human."
- **Beat the Computer:** every human who finished above the Computer gets a badge on the results screen.
- **Fun stats** (low cost, high replay value):
  - *Crowd Favorite* — single item with the most votes all game
  - *Hidden Gem* — item that won with the fewest votes
  - *Taste Twins* — the two players who voted the same way most often
  - *Fooled by the Computer* — the player who voted for Computer items most often

---

## 11. After the Game

| Who | Actions |
|---|---|
| Host | **Play Again** · **New Room** · **Exit** |
| Non-host | "Waiting for host…" · **Leave** |

- **Play Again** returns everyone to the **lobby** (Phase 2) with seats, names, and colors kept. Departed players' seats are freed, queued joiners are seated, and new players can join. Scores reset.
- **New Room** closes this session and opens a fresh one with a new code.
- **Exit** closes the room. Non-hosts see "The host closed the room" with **Home** and **Start your own**.
- If the host leaves from Results, the host role transfers (§6) so remaining players aren't stranded.

---

## 12. Phase 7 — High Scores

### Percentage scoring
Raw points aren't comparable across player counts: in a round, a player can earn at most (humans − 1) votes plus the 1-point bonus. That means 4 human players can score 4 points a round, while 2 human players max out at 2. Boards therefore rank by **percentage of maximum possible**:

```
max_possible = Σ over rounds of multiplier × humans      // (humans − 1) votes + 1 bonus
pct          = round(100 × score / max_possible)
```

Boards show both values, ranked by percentage: **"87% · 52 pts"**. Ties in percentage are broken by raw points, then by earliest date.

### Boards
All boards are split by list length (5 / 10 / 15).

| Board | Scope | Size | Purpose |
|---|---|---|---|
| **This Week** | Global, resets Monday 00:00 PT | Top 10 | Always reachable; the main aspiration |
| **All Time** | Global | Top 10 | Spectacle |
| **This Room** | Players sharing a device-group token across Play Agains and New Rooms | Top 10 | Friends/family rivalry |

- Entry: player name, percentage, points, category, list length, human player count, date.
- A qualifying player sees "New high score! #4 this week."
- **Eligibility:** human players only, and completed games only (no End Game, no games paused out). The Computer is never on any board.
- **Integrity:** scores are computed server-side only. Clients never submit scores.
- **Moderation:** names on global boards pass the same profanity filter; flagged entries can be hidden.

---

## 13. Theming Integration

All game screens consume design-system tokens; no hardcoded colors or fonts.

| Element | Token source | Duel | Candy Pop |
|---------|--------------|------|-----------|
| Display type (room code, round header, scores) | `font.display` | Big Shoulders Display | Lilita One |
| Player colors (4 slots) | `color.player.1–4` | Theme palette | Theme palette |
| Computer color + icon | `color.player.computer`, `icon.computer` | Theme palette | Theme palette |
| Match-up cards | `card.*` | Theme | Theme |
| Winner highlight / reveal motion | `motion.reveal`, `color.accent` | Theme | Theme |
| Final Showdown intro and accents | `motion.showdown`, `color.showdown` | Theme | Theme |

- Theme is chosen in **Settings** and applies per device (each player can use their own theme).
- Player colors must remain distinguishable within each theme, including for common color-vision deficiencies. Always pair color with the player's name/initial.
- **Design system changes:**
  - Each theme needs a **5th player color** (Computer), visually distinct from the 4 human slots and ideally neutral or "mechanical" in feel, plus a Computer icon. It's used only after reveal, never on ballot cards.
  - Each theme needs **showdown** tokens.
- Respect the **reduced motion** setting: reveals and showdown intros fall back to fades.

---

## 14. Architecture & Runtime

### 14.1 Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime / framework | **Next.js (App Router), TypeScript**, deployed on Vercel | One full-stack app: UI, Server Actions, and route handlers |
| Database | **Supabase Postgres** (existing connected project) | System of record for all game state |
| Realtime | **Supabase Realtime** — Broadcast (state events) + Presence (who's online, UI only) | One channel per room |
| Identity | **Supabase anonymous sign-in** | Every device gets a real `auth.uid()` without an account; this replaces the ad-hoc device token |
| Data access | **Direct Postgres** from the server (postgres.js or Drizzle) through the Supavisor **transaction pooler** (port 6543, `prepare: false`), as role `this_or_that_app` | Real multi-statement transactions for the version check; supabase-js REST can't do that |
| Schema | **`this_or_that`** — a dedicated schema, **not exposed** to the Data API | Clients can't query game tables at all |
| Timers | **pg_cron every 1s → `pg_net` → `/api/advance`** | The server is the only thing that ends a phase (§14.3) |
| Fuzzy matching | **pg_trgm** + **fuzzystrmatch** Postgres extensions | Spell check and dedupe run in the database |
| Profanity filter | Server-side word-list library | Names and entries; never trust the client |
| QR codes | Generated client-side from the join URL | No server round trip |
| Fonts / theming | `next/font` (Big Shoulders Display, Lilita One); CSS variables under `[data-theme]` | Theme swap is attribute-only, no re-render of layout |

**Region:** co-locate the Vercel functions and the Supabase project (e.g. both US West). Every game action is a function-to-database round trip, so cross-region latency shows up directly in how snappy votes feel.

### 14.2 Authority model: server-authoritative, database-as-truth

Clients never write game state. They send **intents**; the server validates them, applies them, and broadcasts the result.

```
Client ──intent──▶ Server Action ──▶ engine.apply(state, intent) ──▶ Postgres txn (version check)
                                                                        │
Clients ◀──broadcast (public projection)──── Realtime channel ◀─────────┘
```

- **Game engine = pure TypeScript module** (`lib/engine`). It is a reducer: `(state, intent, now, rng) → { state, events } | error`, with no I/O. All rules live here: phase transitions, validation, Computer picks, shuffles, scoring, and Final Showdown multipliers.
- **Server Actions** load the session, call the engine, and persist the result in a single transaction guarded by **optimistic concurrency** (`sessions.version`). On a version conflict the action reloads state and retries once. Concurrent votes landing in the same instant are the main case.
- **Clients have no database access to game tables.** Only the server reads and writes them, as `this_or_that_app`. Clients use Supabase for exactly two things: anonymous auth and Realtime (§14.5).
- **Why the pure engine matters:** it's unit- and property-testable without a database. It's also the escape hatch: if Next.js + Postgres ever proves too slow, the same engine moves unchanged into a dedicated room server (D12).

**Intents:** `create_room`, `join`, `rejoin_seat`, `leave`, `remove_player`, `start_game`, `category_vote`, `confirm_setup`, `add_item`, `remove_item`, `submit_list`, `edit_list`, `cast_vote`, `next`, `end_game`, `play_again`, plus the server-only `advance`.

### 14.3 Timers: server-driven

**The server owns the clock.** Phones display the countdown, but nothing a phone does can end, extend, or shorten a phase.

Serverless functions can't hold a 15-second timer in memory, so the clock is split in two:
- **The deadline is data.** Every timed phase writes `sessions.phase_deadline`.
- **The trigger is Postgres.** A pg_cron job fires the advance.

How it works:
1. **Deadline set.** A phase transition writes `phase_deadline = now() + duration`, using the database clock, in the same transaction as the state change.
2. **Dispatcher (every 1s).** pg_cron runs `this_or_that.dispatch_due()`, which finds sessions where any of these is true:
   - the deadline has passed;
   - a player's heartbeat is stale (>20s);
   - a disconnected player is due to depart (>60s);
   - the room has been idle for more than 2h.

   For each session found, it POSTs `{session_id, version}` to `/api/advance` via `pg_net`, authenticated with a shared secret stored in Supabase Vault. The dispatcher contains no game rules; it only decides that the engine should look at a session.
3. **Advance.** `/api/advance` loads the session, runs the engine with the server's `now()`, and commits the transition and its broadcast in one transaction. It also clears `advance_requested_at`.
4. **Exactly-once.** The dispatcher sets `advance_requested_at` before firing and skips sessions with a request under 3s old. If an HTTP call is lost, the next sweep after 3s retries it. The engine is idempotent under the version check: a stale or duplicate advance is a no-op.
5. **Early resolve stays server-side.** `cast_vote` / `submit_list` check whether every connected human has acted, and advance in the same transaction if so. Most rounds end this way, well before the timer.
6. **Clients only display.** Clients render `phase_deadline` against a server-clock offset measured on connect. At zero they show "Time's up…" and wait for the `state` broadcast. Refreshing never resets a timer.

**Precision:** a phase ends within 1s of its deadline, plus one function round trip (typically 100–300ms). On a 15s round that lag is invisible, and it's the same for every player.

**Why not have phones trigger the advance?** It's faster by up to a second, but it gives clients a role in game flow and adds a second code path. The server-only design is simpler and can't be gamed; the 1s cost doesn't matter.

**Ops:** a 1-second job writes about 86k rows a day to `cron.job_run_details`. The nightly purge job trims them.

### 14.4 Presence & disconnects

- **Supabase Presence** drives the UI only: the "Maya is back" dot and the "Waiting on Ben…" labels.
- **The authoritative connection signal is a heartbeat:**
  - Clients call a lightweight `heartbeat` route every 10s, which updates `players.last_seen_at`.
  - A player whose `last_seen_at` is more than 20s old counts as **disconnected** for vote-waiting purposes.
  - After 60s disconnected, a player counts as **departed** (§9.7) and host transfer kicks in (§6).
- This split exists because Presence state lives in the Realtime service, not in Postgres, so the engine can't rely on it for rules.

### 14.5 Hidden information & RLS

Information hiding is part of the game design, so it's enforced in the database, not just in the UI.

| Data | Who can read it | When |
|---|---|---|
| Your own list | You | Always |
| Other players' lists | Nobody | Never as lists, only as ballot cards |
| Ballot cards (item text, card id) | Everyone in the room | When the match-up opens |
| Card ownership and vote counts | Everyone in the room | After reveal |
| Who has voted (not what) | Everyone in the room | Live |
| Other players' votes | Nobody | Not even after reveal; only counts are shown |

- **Broadcast payloads are public projections.** The engine emits a `publicState` view with owners stripped from unrevealed cards and never includes lists.
- **Private state** (your list, your vote) comes from a `getSnapshot` Server Action, which returns the engine's projection for the caller's seat, identified by `auth.uid()`. No client ever queries a game table.
- **Defense in depth:**
  - The `this_or_that` schema isn't exposed to the Data API.
  - RLS is enabled on every table with no client policies (deny-all).
  - `anon` and `authenticated` have no table grants.
- Ballot card ids are random per match-up, not favorite ids, so a client can't join a card id back to its owner.

### 14.6 Realtime channel design

- Channel: `room:{room_code}`, **private**. Policies on `realtime.messages` let a user receive broadcasts and track presence only if they hold a seat, or a queued spot, in that room. No client can broadcast.
- **Broadcasts are sent from inside the game transaction** with `realtime.send()`, wrapped as `this_or_that.broadcast()`. They're delivered only if the transaction commits, so state and broadcast can never disagree. There's no separate "write then publish" step to fail halfway.
- Server-sent broadcast events:
  - `state` — full public projection plus `version`, sent on every transition
  - `progress` — lightweight "Maya 6/10" and "Ben voted" updates
  - `reveal` — vote counts and owners, sent once per match-up
- Clients apply a `state` event only if its `version` is higher than their current one. After a gap or on reconnect, the client refetches the snapshot.
- Queued joiners subscribe read-only.

### 14.7 Data model — schema `this_or_that`

The full DDL is in `supabase/migrations/20260924120000_this_or_that_schema.sql`. It has been tested against Postgres 16.

```
-- content
categories         (id, slug, name, size_class, allowed_lengths[], is_active)
dictionary         (id, category_id, canonical_name, popular_tier, player_originated)
dictionary_aliases (dictionary_id, alias)                      -- "NYC" → New York City
item_stats         (dictionary_id, appearances, votes_received, round_wins)
unmatched_entries  (category_id, normalized_text, distinct_player_count, …)

-- rooms & games
sessions           (id, room_code, status, version, host_player_id, current_game_id,
                    phase_deadline, advance_requested_at, relaxed_timers,
                    category_vote, device_group_id, last_activity_at, closed_at)
players            (id, session_id, user_id → auth.users, is_computer, name,
                    color_slot 0–4, is_host, queued, last_seen_at,
                    disconnected_at, left_at)
games              (id, session_id, number, offered_category_ids[], category_id,
                    list_length, human_count, current_round, rng_seed, ended_early,
                    started_at, ended_at)                      -- one per Play Again
category_votes     (game_id, player_id, category_id)

-- play
favorites          (id, game_id, player_id, entry_position, raw_text, display_text,
                    canonical_item_id, auto_picked, surprise_picked, shuffled_position)
matchups           (id, game_id, round_number, multiplier 1|2, status, opened_at, revealed_at)
ballot_cards       (id random, matchup_id, display_text ALL CAPS, sort_order)
ballot_card_owners (ballot_card_id, favorite_id)               -- >1 row only for shared duplicates
votes              (matchup_id, voter_player_id, ballot_card_id)
game_results       (game_id, player_id, score, max_possible, pct, round_wins, rank)

-- log & boards
session_events     (id, session_id, version, intent, actor_player_id, payload)
high_scores        (id, game_id, player_name, score, max_possible, pct, list_length,
                    human_count, category_id, device_group_id, board_week, hidden)
```

**Changes from v0.4:** `games` is split out of `sessions`, so Play Again starts a new game in the same room without mutating history; category, length, and seed move to `games`. Ballot ownership moves to a join table, which handles shared duplicate items cleanly. `game_results` holds final standings.

**Rules the database enforces (not just the engine):**
- **Room codes:** exclude `I`/`O`, and are unique among open rooms.
- **Seats and names:**
  - exactly one Computer per room;
  - player names unique per room (case-insensitive);
  - seat colors 1–4 unique, which hard-caps a room at 4 seated humans;
  - at most one host;
  - one seat per device identity.
- **Lists:** no duplicate items within a player's list, whether matched by canonical item or by text.
- **Votes:** one vote per player per match-up, and a vote must reference a card in that match-up (composite foreign key).
- **Ballot text:** stored uppercase (`display_text = upper(display_text)`).
- **Field limits:** name ≤ 12 characters, item ≤ 30, list length ∈ {5, 10, 15}, Showdown multiplier ∈ {1, 2}.

**Rules only the engine enforces:** no voting for your own card, since ownership crosses tables; phase legality; and scoring.

**Database functions:**
- `match_item(category, text)` — spell check. Scores dictionary names and aliases by trigram similarity and Levenshtein distance. A score of 1.0 is an exact match; 0.6–0.99 prompts "Did you mean…?"
- `dispatch_due()` — the timer dispatcher (§14.3).
- `can_join_topic(topic)` — Realtime channel authorization.
- `broadcast(room, event, payload)` — transactional broadcast.

**Access:** the server connects as `this_or_that_app`, a dedicated role with rights only on this schema, and an explicit allow-all RLS policy. **One-time setup, outside version control:**
- enable login on that role;
- add the two Vault secrets (the `/api/advance` URL and the shared secret).

**Retention:** a nightly job purges closed rooms after 7 days; games, votes, and events cascade with them. `high_scores` (with `game_id` set to null), `item_stats`, and the dictionary are kept.

### 14.8 Session status machine

```
lobby → setup → entering → computer_picking → matchup_voting ⇄ matchup_reveal → results → lobby
  ↑                                                  ↓ (<2 connected humans)
  └──────────── (Play Again) ──────────── paused ──→ results (ended early)
any state → closed (Cancel Room / Exit / expiry)
any in-game state → results (End Game, ended_early = true)
```

- `computer_picking` is a server-only step (under 1s) between list lock and the first match-up.
- `item_stats` counts every item, human- and Computer-entered, so the Computer learns from what humans actually vote for. It's updated in the same transaction as each reveal.
- Randomness (shuffles, Computer picks, card ids, room codes) uses a CSPRNG on the server. The per-session seed is stored for replay.

### 14.9 App structure

```
app/
  page.tsx                      Home
  join/[code]/page.tsx          Join + name / error screens
  room/[code]/page.tsx          Single game shell; renders by phase
  scores/page.tsx               High-score boards
  api/advance/route.ts          Phase advance; called only by the pg_cron dispatcher
  api/heartbeat/route.ts
lib/
  engine/                       Pure reducer, rules, scoring, Computer AI
  actions/                      Server Actions (one per intent)
  db/                           Typed queries (generated Supabase types)
  realtime/                     Channel client, version-gated state store
  theme/                        Tokens, [data-theme] switching
supabase/
  migrations/                   this_or_that schema, RLS, functions, pg_cron jobs
  seed/                         Dictionaries per category (meets §7 size requirement)
```

The room page is **one route with phase-driven rendering**, not a route per phase. The server owns the phase, so URL-per-phase would fight the state machine and break on refresh.

### 14.10 Testing & quality

- **Engine unit tests:** every rule in §7–§12, including the 2-player outcome table in §9.5.
- **Property tests** (fast-check):
  - Total points equal Σ votes + bonuses.
  - Scores never exceed `max_possible`.
  - Every match-up has exactly one card per active list.
  - The Computer never duplicates a human item.
  - No state is reachable from which no transition exists. This is the "no dead ends" guarantee, tested mechanically.
- **Simulation:** bot players run thousands of full games through the engine to tune `computer.strength` toward the 20–30% Computer win target (D7) before launch.
- **E2E:** Playwright with 4 browser contexts per test, covering join, a full game, disconnect/rejoin, host transfer, and End Game.
- **Load check:** 200 concurrent rooms × 5 clients against staging, watching the Realtime connection count and p95 action latency (target < 300ms).

### 14.11 Operational limits to watch

- **Realtime connections:** each player holds one connection, and there are ~5 per room. Check the Supabase plan's concurrent-connection and message quotas against expected peak rooms.
- **Function cold starts:** keep Server Actions lean and in the same region. `/api/advance` gets steady traffic from the dispatcher, so it stays warm.
- **Connection pooling:** always use the transaction pooler (6543) from Vercel, never direct connections. Serverless bursts will exhaust Postgres connections otherwise.
- **Dispatcher load:** `dispatch_due()` is an indexed scan every second, capped at 200 sessions per sweep. Past a few hundred concurrent rooms, watch its runtime in `cron.job_run_details`.
- **Room expiry:** the dispatcher sends idle rooms (>2h) to the engine to be closed; the nightly purge deletes them after 7 days.

---

## 15. Open Decisions

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| ~~D1~~ | ~~2-player scoring~~ | — | **Resolved (v0.2):** always-on Computer player (§9.1). |
| D2 | Self-vote | Block vs allow | **Block.** Otherwise every round is a self-vote tie. |
| ~~D3~~ | ~~High-score fairness~~ | — | **Resolved (v0.3):** percentage scoring, plus weekly / all-time / room boards (§12). |
| D4 | Duplicate items across players | Allow (shared credit) · block at entry ("someone already has that") | **Allow.** Blocking leaks information about others' lists during entry. |
| D5 | Vote reveal | Show owners during voting vs after | **After.** Hidden ownership prevents alliance/pity voting. |
| D6 | Ballot size (3–5 cards) | Keep multi-item ballots vs pairwise 1v1 match-ups | Multi-item ballots for v1. With the Computer, 4 humans means 5 cards; watch vote-time and readability in playtests. Pairwise brackets are a candidate v2 mode. |
| D7 | Computer strength | Uniform random · win-rate weighted · adaptive to group skill | Win-rate weighted, `computer.strength` = 0.7 at launch. Target: the Computer wins roughly 20–30% of games. Much higher feels unfair; much lower and it stops mattering. |
| D8 | Computer voting | Never · only as a 2-player tiebreaker | **Never.** Revisit only if 2-player tie rates feel bad in playtests. |
| D9 | Crowd-pleaser vs self-expression | Keep the crowd-pleaser scoring with honest framing · add a self-expression mechanic (e.g. "guess whose item this is") | Crowd-pleaser for v1 (§1). A "guess the owner" bonus round is a strong v2 candidate. |
| D12 | Room server escape hatch | Stay on Next.js + Supabase · move the engine into a dedicated realtime room server (e.g. PartyKit / Durable Objects) | **Stay** for v1. Revisit if p95 action latency exceeds 300ms or Realtime quotas bind; the pure engine makes the move mechanical. |
| D10 | Final Showdown size | Last round only · last 20% of rounds · ×3 final | As specified in §9.6. Tune if trailing players still disengage, or if showdowns decide too many games. |

---

## 16. Out of Scope (v1)

- Custom/user-created categories
- More than 4 human players, audience mode, spectators beyond queued joiners
- Accounts/login (names are per-session; the room board uses a device-group token)
- Chat or reactions
- Localization

---

## 17. Acceptance Criteria (v1)

**Session & lobby**
- [ ] Home offers New Game, Join, High Scores, and Settings.
- [ ] Host can create a room and share it by code, URL, and QR.
- [ ] 2–4 humans can join; names are unique, filtered, and can't impersonate the Computer.
- [ ] Every join failure (invalid, closed, full, in progress) lands on a screen with a forward action.
- [ ] Queued joiners are seated on Play Again when a seat is free.
- [ ] A player on a new device can reclaim a disconnected seat.
- [ ] Host can remove players and cancel the room; Start explains why it's disabled.

**Setup & entry**
- [ ] Host sees only the list lengths the category's size class allows; every category's dictionary meets the size requirement.
- [ ] Setup has a 45s timer, a confirm step, and an optional category vote.
- [ ] Players enter items with spell-check suggestions, Surprise me, edit-after-submit, and an inline reason for every rejection.
- [ ] Timer expiry auto-fills missing items; the game never stalls.

**Match-ups & scoring**
- [ ] Every session has exactly one Computer player, contributing one item per match-up, never duplicating a human's item, and never voting.
- [ ] Computer items are visually indistinguishable from player items until reveal.
- [ ] Every ballot card is ALL CAPS in the stored text and the broadcast payload, not only on screen; curly quotes are straightened and trailing punctuation stripped.
- [ ] N match-ups are generated server-side with one item per player and no same-item collisions.
- [ ] Players can't vote for their own item; votes lock on tap; rounds resolve when all connected players have voted.
- [ ] Round points, bonuses, and Final Showdown multipliers match §9.5–9.6; totals match the final screen.
- [ ] Lead changes are called out on reveal.
- [ ] 5-card ballots fit on a phone screen without scrolling.

**Exits & results**
- [ ] Leave (all players) and End Game (host) are available in every in-game phase.
- [ ] Departed players' items stay in play; the game pauses below 2 connected humans and never hangs.
- [ ] Results handle a Computer win ("The Computer wins" + Top Human) and early endings.
- [ ] Play Again returns to the lobby with seats kept; non-hosts always have Leave.

**Architecture**
- [ ] All game tables live in the `this_or_that` schema, which isn't exposed to the Data API; `anon` and `authenticated` can't read any game table.
- [ ] Every phase advance is triggered by the server (dispatcher or early resolve). No client request can end or extend a phase.
- [ ] A phase ends within 1.5s of its deadline, even when every phone is locked.
- [ ] State changes and their broadcasts commit atomically. A client never sees a broadcast for a rolled-back transition.

**High scores & theming**
- [ ] High scores rank by percentage across This Week / All Time / This Room boards per list length.
- [ ] High scores exclude the Computer and early-ended games.
- [ ] Every screen renders correctly in both Duel and Candy Pop themes, including the Computer color, showdown tokens, and reduced motion.
