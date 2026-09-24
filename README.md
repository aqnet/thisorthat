# This or That

A Jackbox-style party game for 2&ndash;4 players on their own phones, plus an
always-present **Computer** player. Everyone enters items in a chosen category,
those items are pitted against each other in match-ups, and players vote. The
owner of the winning item scores. The last round is a double-points Final
Showdown.

The game rewards picking items *other people* will love, not listing your own
favourites &mdash; and it gives every game a shared opponent: beat the Computer.

## Specs

| Document | Covers |
|---|---|
| [`specs/this-or-that-game-mechanics.md`](specs/this-or-that-game-mechanics.md) | Game rules, phases, scoring, architecture (v0.6) |
| [`specs/this-or-that-design.md`](specs/this-or-that-design.md) | Design system: themes, colour, type (v0.1) |

Section references in the code (`§9.5`, `§14.3`) point at the game mechanics
spec unless they name the design system.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # engine unit + property tests
npm run typecheck
npm run lint
```

## Layout

```
app/                 Next.js App Router pages; globals.css holds the design tokens
components/          Presentational components, built only from tokens
lib/engine/          Pure game engine: the reducer, scoring, match-ups, Computer
lib/theme/           Theme and mode switching (attribute-only, per device)
db/migrations/       Postgres schema for the `this_or_that` schema
specs/               The two specs above
```

### The engine

`lib/engine` is a pure reducer: `(state, intent, ctx) -> { state, events } | error`.
It has no I/O, no clock of its own and no randomness of its own &mdash; time
arrives as `ctx.now` and randomness derives from `ctx.seed`. That makes every
rule testable without a database, and it is the escape hatch in decision D12: if
Next.js plus Postgres proves too slow, the engine moves into a dedicated room
server unchanged.

Because it is pure, the two dictionary-dependent steps (auto-filling unfinished
lists, and choosing the Computer's items) are done by the caller and handed back
in through the server-only `lock_lists` intent.

## Status

Foundations only. The engine, scoring, theming and home screen exist; the game
screens, the database wiring and Realtime do not. See **Not built yet** below.

### Built

- Pure game engine &mdash; phases, voting, scoring, Final Showdown, pause/resume
- Ballot normalization and the ALL-CAPS camouflage rule (§9.1)
- Match-up construction with duplicate-collision handling (§9.2)
- Computer item selection with win-rate weighting (§9.1)
- Design tokens for both themes in light and dark; theme switching
- Home screen with a live choice-card preview
- 69 unit and property tests, including the §9.5 two-player outcome table

### Not built yet

- Every game screen after Home: lobby, setup, entry, match-up, results, boards
- Server Actions, the database layer, and Supabase Realtime
- Anonymous auth, the pg_cron dispatcher, and `/api/advance`
- Category dictionaries (`db/seed/`) and the spell-check pipeline
- Profanity filtering (the engine takes an injected `isProfane`; nothing implements it)

## Known gaps

- **Candy Pop dark is provisional.** The design spec lists it as an open item
  and required before the theme ships. The values in `globals.css` keep the
  warm/cool mapping but have not had a contrast pass.
- **Player-colour palettes are proposed, not specified.** The design spec says
  "theme palette" without fixing values for the four seats and the Computer.
- **No contrast audit.** Design spec §6 requires WCAG AA or better across all
  fill/on-colour pairs; that has not been done.
