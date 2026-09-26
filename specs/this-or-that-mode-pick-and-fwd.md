# This or That — Game Mode: Pick and fwd

**Status:** v0.3, implemented · **Date:** 2026-09-26 · **Owner:** Anderson
**Builds on:** [Game Mechanics Spec v0.7](this-or-that-game-mechanics.md) (the "original spec"). Everything there applies unless this document changes it. Section references (§) point to the original spec; references to this document say "this spec".

**Changelog**
- v0.3 — Implemented, with the recommended answer to every open decision (F1–F7). Each is isolated in the code, so a different call is a small change: F2 is `CHAMPION_REIGN_CAP` in `lib/engine/champion.ts`; F6 is the fresh-appearance check in the runner's `item_stats` update.
- v0.2 — Review fixes: the champion rules split into "who holds the crown" and "retirement", so they no longer contradict each other; a champion card no longer reveals the owner of a merged duplicate; "reign" defined; the champion is derived from the round record rather than stored; the coin flip is seeded per round; champion rounds don't feed `item_stats`; Computer tuning and reveal pacing per mode; consistent mode names; acceptance criteria and decision F6 added.
- v0.1 — First draft.

---

## 1. Summary

The game gets **two modes**, chosen by the host before the category. Mode names are written in sentence case everywhere, in the UI as here:

| Mode | Pitch (shown in the picker) | Rules |
|---|---|---|
| **Pick your fav** | "Every round is a fresh ballot." | The game as the original spec describes it. Unchanged. |
| **Pick and fwd** | "Round winners stay on the ballot until someone beats them." | This spec. |

In **Pick and fwd**, each round's winning item **carries forward** onto the next round's ballot as the **champion**. It keeps carrying forward until a fresh item beats it, or until it retires after 3 wins (this spec §4.2). Every round becomes "can anything beat the champion?", and a strong pick keeps earning its owner votes.

### What this mode rewards
Same as the original (§1): picks everyone else will love. A genuinely great pick is worth more here, because it can win several rounds instead of one. That makes a single dominant pick the mode's main balance risk. The reign cap (this spec §4.2 rule 6, decision F2) is the counterweight.

---

## 2. Game flow changes

```
[Home] → [1 Create Session] → [2 Lobby] → [3 Host Setup: Mode → Category → Length → Confirm]
     → [4 Enter Items] → [5 Match-ups ×N, champion carried forward] → [6 Final Results] → …
```

Phases 1, 2 and 4 are unchanged. Phase 6 gains two fun stats (this spec §6), and Phase 7 splits the boards by mode (this spec §7).

---

## 3. Phase 3 — Host Setup (changes to §7)

Setup gains a first step. The order becomes:

**3a. Mode (new).** Two large cards, **Pick your fav** and **Pick and fwd**, each with its pitch from this spec §1. Selecting one moves the host on to the category.
- **Default:** the mode of the room's previous game (Play Again, §11), otherwise **Pick your fav**. The default is pre-selected, so there is always a mode chosen, and a host in a hurry just taps on.
- Non-hosts see "Host is choosing a mode…" and the countdown, like the rest of setup.

**3b. Category** (was 3a). Unchanged.
- **With the optional category vote** (§7): the host confirms the mode, then taps **Let everyone vote** as today. Since a mode is always pre-selected, nothing ever waits on it.

**3c. List length** (was 3b). Unchanged: N rounds equals the list length.

**3d. Confirm** (was 3c). The card names the mode first: **"Pick and fwd · Fruit · 10 items — Start?"** It's still the undo point; the mode can't change after Start.

**Timer.** One 45s setup timer still covers every step (§7). On expiry the server uses the mode currently selected (the default, if the host never changed it), then, as today, picks a Random category at the longest allowed length up to 10.

---

## 4. Phase 5 — Match-ups (changes to §9)

### 4.1 Building match-ups
Unchanged at list lock (§9.2): each list is shuffled, and match-up *i* takes item *i* from every list. These are the round's **fresh cards**, numbered 1…n for display order as today.

The champion is **added when a round opens**, not at list lock, because it depends on the previous round's result:
- **Round 1** never has a champion.
- **Round *r* + 1** = its fresh cards **+ the champion after round *r***, if there is one (this spec §4.2). The champion card takes display slot 0, pinned first.

Each round the champion is **a new card** with a new random card id (§14.5), owned by the same favorite(s) as the winning card it continues.

Ballot size is **fresh cards + 1** whenever a champion is carried:

| Human players | Fresh cards | With champion |
|---|---|---|
| 2 | 3 | 4 |
| 3 | 4 | 5 |
| 4 | 5 | **6** |

The layout must fit **6 cards** on a phone without scrolling: 2 columns × 3 rows. §9.3 was designed for 5.

**Duplicate of the champion.** Sometimes a fresh card is the same item as the champion: the same canonical item, or the same text after normalization. The two **merge into the champion card**, crediting both owners like any shared duplicate (§9.2.4, §9.5.6). The merged-in owner **stays hidden until the reveal** (this spec §4.3), so the merge leaks nothing about their list.

### 4.2 The champion
**Reign** means the number of rounds in a row an item has won:
- A fresh card that wins starts at **reign 1**.
- Each round the champion **wins or ties for most votes** adds 1.
- A round where **nobody votes** doesn't count either way.

After each reveal, the next round's champion is decided in two steps.

**Step 1 — who holds the crown.** The first rule that applies:
1. **Nobody voted** (everyone timed out, §9.5.5). The champion, if any, **holds** with its reign unchanged. If there's no champion, there's still none.
2. **The champion is among the most-voted cards** (it won, or tied). It **holds**, and its reign goes up by 1. A champion has to be beaten outright to lose the crown.
3. **One fresh card has strictly the most votes.** It becomes the **new champion** at reign 1, and the old champion is dethroned.
4. **Several fresh cards tie for most votes, and the champion isn't among them.** A **coin flip** picks one of them as the new champion at reign 1, and the reveal says so: "KIWI wins the coin flip." The flip is seeded from the game's seed plus the round number (§14.8), so it replays exactly and doesn't depend on how many other random draws the game made.

**Step 2 — retirement and the end of the game.**
- **Reign cap.** If the crown-holder has now reached **reign 3**, it retires: "MANGO retires undefeated." The next round has **no champion**, even if a fresh card tied with it that round; that tied card keeps its round-win bonus, but not the crown. A champion therefore appears on at most 2 more ballots after its first win (decision F2).
- **The last round** has no next round. Its winner is simply the winner.

**The champion is derived, never stored as state.** The engine already computes scores from the match-up record rather than keeping running totals (`lib/engine/scoring.ts`), and the champion works the same way. Replaying the revealed rounds in order through steps 1 and 2 gives the champion and its reign at any point. A replayed or repaired game therefore always agrees with itself.

Choosing the champion doesn't change **scoring**. The round-win bonus still goes to every co-winner (§9.5.4), including tied fresh cards that lose the coin flip.

### 4.3 Match-up screen (changes to §9.3)
- **The champion card is pinned first** and marked **👑 Champion**, with its reign ("👑 ×2") and **its owner's name and colour**.
- **Only the champion's original owner is shown**, meaning the owner(s) of the card that won the previous round. An owner merged in from a duplicate (this spec §4.1) appears only at the reveal, like any fresh card's owner.
- **Your own champion** also says **"Yours"** and is disabled for you, like your fresh card (§9.4). That applies to the merged-in owner too, but only on their own phone.
- Fresh cards stay anonymous and in random order, as today.
- **Exception to hidden ownership (D5):** the champion's original owner was already revealed when it won, so hiding them would be pretend secrecy. It's shown openly, a deliberate trade-off of this mode (decision F4).
- **Voting rules (§9.4) are unchanged.** A player who owns the champion and a fresh card can vote for neither. At the 6-card worst case that still leaves them 4 choices.
- Ballot text stays ALL CAPS, server-side (§9.1). The 15s vote timer is unchanged (§9.3); see decision F7.

### 4.4 Reveal & scoring (changes to §9.5)
Scoring is **unchanged**: 1 point per vote, a +1 round-win bonus, and Final Showdown ×2. The champion earns votes for its owner like any card.
- **One bonus per player per round.** A player can now own two cards in one round, the champion and a fresh card. If both tie for the win, they still get one +1 bonus. The engine already de-duplicates co-winners by player.
- **Percentage scoring still holds (§12).** A player still receives at most (humans − 1) votes, since nobody votes for their own cards, plus one bonus. So `max_possible` is unchanged.
- **Final Showdown (§9.6):** the multiplier applies to the whole ballot, champion included.

**Reveal order and callouts.** The reveal runs: vote counts → owners → **crown callout** → lead-change callout (§9.5.8) → scoreboard. The crown callout is one of:
- "MANGO defends the crown! 👑 ×2"
- "KIWI takes the crown from MANGO!"
- "KIWI wins the coin flip."
- "MANGO retires undefeated."

In Pick and fwd the reveal holds for **5s** instead of 4s (§9.5.9), to fit the extra callout. The host can still skip with **Next**.

### 4.5 Departures (changes to §9.7)
None. A departed player's items stay in play, and that includes a champion they own.

---

## 5. The Computer (changes to §9.1)
- **Its picks are unchanged.** The Computer doesn't pick with the champion in mind, and it never votes (decision F5).
- **A Computer item can be champion.** Once it has won a round its owner is public, so the Computer's camouflage only applies to fresh cards. That's consistent with how reveals already work.
- **`item_stats` counts fresh appearances only** (decision F6). A champion's later rounds are correlated repeats of the same win, and the stats are shared by both modes. Counting them would pull Pick your fav's Computer toward yesterday's champions. An item still earns its appearance, votes and win in the round it first appears. That includes a fresh duplicate merged into the champion (this spec §4.1): it's that item's fresh appearance, so it's recorded with the champion card's votes and result.
- **Computer strength is tuned per mode.** The target is the Computer winning roughly 20–30% of games (D7), but a strong Computer item can now reign for several rounds. The pre-launch simulation (§14.10) runs each mode separately, and `computer.strength` gets a value per mode.

---

## 6. Final Results (additions to §10)
Pick and fwd adds two fun stats:
- **Longest Reign:** the champion that reached the highest reign, and its owner.
- **Giant Slayer:** the fresh item that dethroned the longest-reigning champion.

Pick your fav's results are unchanged.

---

## 7. High Scores (changes to §12)
Scores aren't comparable across modes, so **every board is split by mode**, and within a mode by list length, as before. The percentage formula is the same, since `max_possible` is unchanged (this spec §4.4). A high-score entry records its mode.

---

## 8. Architecture & data (changes to §14)

**Engine (`lib/engine`):**
- `Game.mode: 'pick_your_fav' | 'pick_and_fwd'`, set by `confirm_setup`, whose intent gains `mode`.
- A pure function derives the champion and its reign from the revealed match-ups (this spec §4.2), alongside `scoreGame`. Nothing about the champion is stored in the engine state.
- `openRound` adds the champion card for Pick and fwd, at display slot 0 with a new card id. The reveal hold is 5s in this mode.
- The public projection marks the champion card, and before the reveal includes only its original owners (this spec §4.3).

**Schema (`this_or_that`), one migration:**
- `games.mode text not null default 'pick_your_fav'`, checked against the two modes. Existing games read as Pick your fav, so nothing stored changes meaning.
- `ballot_cards.champion_reign smallint`: null for a fresh card, otherwise the champion's reign when that round opened. It's a **history record** for results and replays, not engine state.
- `high_scores.mode`, and `mode` added to the three board indexes.

**Server:** at each reveal, `item_stats` is updated for fresh cards only (this spec §5).

**Testing (additions to §14.10):**
- **Property:** every ballot holds one card per active list plus **at most one** champion.
- **Property:** no human score exceeds `max_possible` in either mode.
- **Property:** a champion never passes reign 3, and never outlives the game.
- **Property:** deriving the champion from the round record twice gives the same result, coin flips included.
- **Unit:** each rule in this spec §4.2, including retiring on a tie; the one-bonus-per-player rule; merging a duplicate into the champion without exposing the merged-in owner before the reveal.
- **Simulation:** each mode is tuned separately toward the 20–30% Computer win rate.
- **Browser smoke test:** one Pick and fwd game, checking the champion card, "Yours" on your own champion, and the crown callouts.

---

## 9. Open decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| F1 | Fresh cards tie and the champion isn't among them | Coin flip · nobody carries · all tied cards carry | **Coin flip.** "Nobody carries" means 2-player games almost never have a champion, because most 2-player rounds are ties (§9.5). "All carry" can push the ballot past 6 cards. |
| F2 | Reign cap | None · 3 · 5 | **3.** Without a cap one great pick can hold a 15-round game, and the leader snowballs. Tune from playtests. |
| F3 | Reward for defending the crown | None · +1 per defense | **None in v1.** Staying on the ballot is already the reward: more rounds to earn votes. A defense bonus would also break `max_possible` (this spec §4.4). |
| F4 | Show the champion's owner during voting | Show · hide | **Show.** Everyone saw the owner at the last reveal; hiding it would be pretend secrecy. |
| F5 | Does the Computer pick with the champion in mind? | No · pick items likely to beat it | **No in v1.** Revisit if champions reign too easily in playtests. |
| F6 | Do a champion's later rounds feed `item_stats`? | Fresh appearances only · every round on the ballot · separate stats per mode | **Fresh only.** Repeats are correlated and would skew the Computer in both modes. Per-mode stats would split an already thin data set. |
| F7 | Vote timer with 6 cards | Keep 15s · 15s + 1s per card over 5 | **Keep 15s** (§9.3 fixes it on purpose, for pace). Watch 4-player Pick and fwd rounds in playtests; the champion is already known, so reading time grows less than the card count suggests. |

---

## 10. Acceptance criteria

- [ ] Setup offers Mode before Category. The default is the room's last mode, otherwise Pick your fav. The confirm card names the mode, and the mode can't change after Start.
- [ ] A mode is always pre-selected, so the setup timer and the category vote never wait on the mode step.
- [ ] Pick your fav plays exactly as the original spec, with no regressions. Its `item_stats` aren't affected by Pick and fwd games beyond fresh appearances.
- [ ] In Pick and fwd, each round's winner appears on the next ballot as the champion, pinned first with its reign and original owner, until a fresh card beats it outright or it retires at reign 3.
- [ ] Ties, no-vote rounds, the reign cap (including retiring on a tie) and the last round follow this spec §4.2. Each has its reveal callout, in the order this spec §4.4 gives, within a 5s reveal hold.
- [ ] Coin flips replay exactly from the game seed and round number.
- [ ] Re-deriving the champion from the round record always matches what players saw.
- [ ] A fresh duplicate of the champion merges into it, and its owner isn't shown until the reveal.
- [ ] A 6-card ballot fits on a phone without scrolling.
- [ ] The champion shows "Yours" to its owner(s) and can't be voted for by them. A player owning two winning cards gets one bonus.
- [ ] Final Showdown doubles the champion's votes too.
- [ ] High-score boards are split by mode. Results show Longest Reign and Giant Slayer in Pick and fwd.
