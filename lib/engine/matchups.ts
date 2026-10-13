/**
 * Building the match-ups (spec §9.2).
 *
 * Every list -- each human's and the Computer's -- is shuffled independently,
 * then match-up i takes item i from each list. With N items per player that is
 * exactly N match-ups, each holding one card per active list.
 *
 * In a thin custom category a list can be short (custom-category spec §4.1):
 * it sits some rounds out, and a round left with fewer than 2 cards is
 * dropped, so the game can have fewer rounds than the list length.
 */

import type { BallotCard, Favorite, Matchup } from './types';
import { dedupeKey } from './text';
import { multiplierForPlayedRound, type ListLength } from './constants';
import type { Rng } from './rng';

export interface BuildMatchupsInput {
  gameId: string;
  listLength: ListLength;
  /** Ordered player ids whose lists take part: seated humans plus the Computer. */
  playerIds: readonly string[];
  /** Every favorite in the game, keyed by player in `playerIds`. */
  favorites: readonly Favorite[];
  rng: Rng;
  /** Injected: real ids come from a CSPRNG outside the engine (§14.8). */
  newId: () => string;
}

export interface BuildMatchupsResult {
  matchups: Matchup[];
  /** Favorites with shuffledPosition filled in; persisted at list lock. */
  favorites: Favorite[];
  /** Rounds where a duplicate survived and produced a shared card. */
  sharedCardRounds: number[];
}

/** What makes two items "the same": canonical id first, else normalized text. */
export function itemKey(favorite: Favorite): string {
  // Prefer the canonical dictionary id: "NYC" and "New York City" are the same
  // item even though their text differs.
  return favorite.canonicalItemId !== null
    ? `c:${favorite.canonicalItemId}`
    : `t:${dedupeKey(favorite.ballotText)}`;
}

/** A list slot: an item, or a hole where a short list sits a round out. */
type Slot = Favorite | null;

/**
 * Try to separate a collision by swapping within one player's list.
 *
 * Swapping inside a single list is safe because a list is already in a random
 * order -- position carries no meaning. Only item-for-item swaps are tried, so
 * a short list's holes stay where they were placed. It can fail when the same
 * item sits in every candidate slot, which is why the caller falls back to a
 * shared card.
 */
function trySeparate(
  lists: Map<string, Slot[]>,
  playerId: string,
  round: number,
  keyAt: (playerId: string, round: number) => string | null,
  listLength: number,
): boolean {
  const list = lists.get(playerId);
  if (!list) return false;

  const collidingKey = keyAt(playerId, round);
  const keysAtRound = (r: number): Set<string | null> => {
    const keys = new Set<string | null>();
    for (const otherId of lists.keys()) {
      if (otherId === playerId) continue;
      const key = keyAt(otherId, r);
      if (key !== null) keys.add(key);
    }
    return keys;
  };

  const othersHere = keysAtRound(round);
  for (let candidate = 0; candidate < listLength; candidate++) {
    if (candidate === round) continue;
    const candidateKey = keyAt(playerId, candidate);
    if (candidateKey === null) continue;
    // The swap must fix this round without breaking the one we swap with.
    if (othersHere.has(candidateKey)) continue;
    if (keysAtRound(candidate).has(collidingKey)) continue;

    [list[round], list[candidate]] = [list[candidate], list[round]];
    return true;
  }
  return false;
}

/**
 * Lay each player's shuffled items into `listLength` slots.
 *
 * A full list fills every slot, exactly as before. A short list -- only
 * possible in a thin custom category (custom-category spec §4.1) -- goes into
 * the rounds with the fewest cards so far, ties broken by the seeded shuffle,
 * and sits the other rounds out. Longer lists are placed first so the short
 * ones see the real gaps. Full lists make no extra RNG draws, so built-in
 * games replay exactly as they always did.
 */
function placeLists(
  playerIds: readonly string[],
  own: Map<string, Favorite[]>,
  listLength: number,
  rng: Rng,
): Map<string, Slot[]> {
  const counts = new Array<number>(listLength).fill(0);
  const placed = new Map<string, Slot[]>();
  const longestFirst = [...playerIds].sort((a, b) => own.get(b)!.length - own.get(a)!.length);
  for (const playerId of longestFirst) {
    const items = own.get(playerId)!;
    const slots: Slot[] = new Array<Slot>(listLength).fill(null);
    if (items.length === listLength) {
      items.forEach((favorite, i) => (slots[i] = favorite));
    } else if (items.length > 0) {
      const emptiest = rng
        .shuffle([...Array(listLength).keys()])
        .sort((a, b) => counts[a] - counts[b])
        .slice(0, items.length)
        .sort((a, b) => a - b);
      emptiest.forEach((round, i) => (slots[round] = items[i]));
    }
    slots.forEach((slot, round) => {
      if (slot) counts[round] += 1;
    });
    placed.set(playerId, slots);
  }
  // Keep the caller's player order: card merging walks lists in that order.
  return new Map(playerIds.map((id) => [id, placed.get(id)!]));
}

/** A round needs two cards to be a choice; fewer and it's dropped (§4.1). */
export const MIN_CARDS_PER_ROUND = 2;

export function buildMatchups(input: BuildMatchupsInput): BuildMatchupsResult {
  const { listLength, playerIds, favorites, rng, newId } = input;

  // One independently shuffled list per participating player (§9.2.1).
  const own = new Map<string, Favorite[]>();
  for (const playerId of playerIds) {
    const items = favorites
      .filter((f) => f.playerId === playerId)
      .sort((a, b) => a.entryPosition - b.entryPosition);
    // Short lists are allowed (thin categories); long ones are a bug.
    if (items.length > listLength) {
      throw new Error(`player ${playerId} has ${items.length} items, expected at most ${listLength}`);
    }
    own.set(playerId, rng.shuffle(items));
  }
  const lists = placeLists(playerIds, own, listLength, rng);

  const keyAt = (playerId: string, round: number): string | null => {
    const slot = lists.get(playerId)![round];
    return slot ? itemKey(slot) : null;
  };

  // §9.2.4: separate same-item collisions where we can.
  for (let round = 0; round < listLength; round++) {
    let guard = 0;
    for (;;) {
      const seen = new Map<string, string>(); // key -> first playerId
      let collidedPlayer: string | null = null;
      for (const playerId of playerIds) {
        const key = keyAt(playerId, round);
        if (key === null) continue;
        if (seen.has(key)) {
          collidedPlayer = playerId;
          break;
        }
        seen.set(key, playerId);
      }
      if (!collidedPlayer) break;
      if (!trySeparate(lists, collidedPlayer, round, keyAt, listLength)) break;
      // A swap can expose a different collision in the same round.
      if (++guard > listLength) break;
    }
  }

  // Build every round's cards, then keep the ones with a real choice.
  const built: { cards: BallotCard[]; shared: boolean; favoriteIds: string[] }[] = [];
  for (let round = 0; round < listLength; round++) {
    // Merge any duplicate that survived: one card, several owners (§9.5.6).
    const byKey = new Map<string, { favorite: Favorite; owners: string[] }>();
    let shared = false;
    for (const playerId of playerIds) {
      const favorite = lists.get(playerId)![round];
      if (!favorite) continue;
      const key = itemKey(favorite);
      const existing = byKey.get(key);
      if (existing) {
        existing.owners.push(favorite.id);
        shared = true;
      } else {
        byKey.set(key, { favorite, owners: [favorite.id] });
      }
    }

    // §9.3: order is randomized so position never reveals the Computer.
    const entries = rng.shuffle([...byKey.values()]);
    const cards: BallotCard[] = entries.map((entry, index) => ({
      id: newId(),
      displayText: entry.favorite.ballotText,
      sortOrder: index + 1,
      ownerFavoriteIds: entry.owners,
    }));
    built.push({ cards, shared, favoriteIds: entries.flatMap((e) => e.owners) });
  }

  // Custom-category spec §4.1: a 1-card ballot has nothing to choose between.
  // Full lists never produce one, so built-in games keep every round.
  const kept = built.filter((round) => round.cards.length >= MIN_CARDS_PER_ROUND);
  const roundCount = kept.length;

  const sharedCardRounds: number[] = [];
  const positionOf = new Map<string, number>();
  const matchups: Matchup[] = kept.map((round, index) => {
    const roundNumber = index + 1;
    if (round.shared) sharedCardRounds.push(roundNumber);
    for (const favoriteId of round.favoriteIds) positionOf.set(favoriteId, roundNumber);
    return {
      id: newId(),
      roundNumber,
      multiplier: multiplierForPlayedRound(listLength, roundCount, roundNumber),
      status: 'pending',
      cards: round.cards,
      votes: {},
      openedAt: null,
      revealedAt: null,
    };
  });

  // Record where each item landed, so a game can be replayed from the record.
  // An item in a dropped round never plays: its position stays null.
  const positioned: Favorite[] = [];
  for (const playerId of playerIds) {
    for (const favorite of own.get(playerId)!) {
      positioned.push({ ...favorite, shuffledPosition: positionOf.get(favorite.id) ?? null });
    }
  }

  return { matchups, favorites: positioned, sharedCardRounds };
}

/**
 * Every card a player owns in a match-up. Usually one; in Pick and fwd a
 * player can own the champion AND a fresh card, and may vote for neither.
 */
export function ownCardIds(
  matchup: Matchup,
  playerId: string,
  favorites: readonly Favorite[],
): string[] {
  const ownFavoriteIds = new Set(
    favorites.filter((f) => f.playerId === playerId).map((f) => f.id),
  );
  return matchup.cards
    .filter((c) => c.ownerFavoriteIds.some((id) => ownFavoriteIds.has(id)))
    .map((c) => c.id);
}

/** The first card a player owns in a match-up, if any. */
export function ownCardId(
  matchup: Matchup,
  playerId: string,
  favorites: readonly Favorite[],
): string | null {
  return ownCardIds(matchup, playerId, favorites)[0] ?? null;
}
