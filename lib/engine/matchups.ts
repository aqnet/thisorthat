/**
 * Building the match-ups (spec §9.2).
 *
 * Every list -- each human's and the Computer's -- is shuffled independently,
 * then match-up i takes item i from each list. With N items per player that is
 * exactly N match-ups, each holding one card per active list.
 */

import type { BallotCard, Favorite, Matchup } from './types';
import { dedupeKey } from './text';
import { multiplierForRound, type ListLength } from './constants';
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

function keyOf(favorite: Favorite): string {
  // Prefer the canonical dictionary id: "NYC" and "New York City" are the same
  // item even though their text differs.
  return favorite.canonicalItemId !== null
    ? `c:${favorite.canonicalItemId}`
    : `t:${dedupeKey(favorite.ballotText)}`;
}

/**
 * Try to separate a collision by swapping within one player's list.
 *
 * Swapping inside a single list is safe because a list is already in a random
 * order -- position carries no meaning. It can fail when the same item sits in
 * every candidate slot, which is why the caller falls back to a shared card.
 */
function trySeparate(
  lists: Map<string, Favorite[]>,
  playerId: string,
  round: number,
  keyAt: (playerId: string, round: number) => string,
  listLength: number,
): boolean {
  const list = lists.get(playerId);
  if (!list) return false;

  const collidingKey = keyAt(playerId, round);
  const keysAtRound = (r: number): Set<string> => {
    const keys = new Set<string>();
    for (const otherId of lists.keys()) {
      if (otherId === playerId) continue;
      keys.add(keyAt(otherId, r));
    }
    return keys;
  };

  const othersHere = keysAtRound(round);
  for (let candidate = 0; candidate < listLength; candidate++) {
    if (candidate === round) continue;
    const candidateKey = keyAt(playerId, candidate);
    // The swap must fix this round without breaking the one we swap with.
    if (othersHere.has(candidateKey)) continue;
    if (keysAtRound(candidate).has(collidingKey)) continue;

    [list[round], list[candidate]] = [list[candidate], list[round]];
    return true;
  }
  return false;
}

export function buildMatchups(input: BuildMatchupsInput): BuildMatchupsResult {
  const { listLength, playerIds, favorites, rng, newId } = input;

  // One independently shuffled list per participating player (§9.2.1).
  const lists = new Map<string, Favorite[]>();
  for (const playerId of playerIds) {
    const own = favorites
      .filter((f) => f.playerId === playerId)
      .sort((a, b) => a.entryPosition - b.entryPosition);
    if (own.length !== listLength) {
      throw new Error(
        `player ${playerId} has ${own.length} items, expected ${listLength}`,
      );
    }
    lists.set(playerId, rng.shuffle(own));
  }

  const keyAt = (playerId: string, round: number): string => keyOf(lists.get(playerId)![round]);

  // §9.2.4: separate same-item collisions where we can.
  for (let round = 0; round < listLength; round++) {
    let guard = 0;
    for (;;) {
      const seen = new Map<string, string>(); // key -> first playerId
      let collidedPlayer: string | null = null;
      for (const playerId of playerIds) {
        const key = keyAt(playerId, round);
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

  const sharedCardRounds: number[] = [];
  const matchups: Matchup[] = [];

  for (let round = 0; round < listLength; round++) {
    const roundNumber = round + 1;

    // Merge any duplicate that survived: one card, several owners (§9.5.6).
    const byKey = new Map<string, { favorite: Favorite; owners: string[] }>();
    for (const playerId of playerIds) {
      const favorite = lists.get(playerId)![round];
      const key = keyOf(favorite);
      const existing = byKey.get(key);
      if (existing) {
        existing.owners.push(favorite.id);
        if (!sharedCardRounds.includes(roundNumber)) sharedCardRounds.push(roundNumber);
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

    matchups.push({
      id: newId(),
      roundNumber,
      multiplier: multiplierForRound(listLength, roundNumber),
      status: 'pending',
      cards,
      votes: {},
      openedAt: null,
      revealedAt: null,
    });
  }

  // Record where each item landed, so a game can be replayed from the record.
  const positioned: Favorite[] = [];
  for (const [, list] of lists) {
    list.forEach((favorite, index) => {
      positioned.push({ ...favorite, shuffledPosition: index + 1 });
    });
  }

  return { matchups, favorites: positioned, sharedCardRounds };
}

/** The card a player owns in a match-up, if any. Used to disable "Yours". */
export function ownCardId(
  matchup: Matchup,
  playerId: string,
  favorites: readonly Favorite[],
): string | null {
  const ownFavoriteIds = new Set(
    favorites.filter((f) => f.playerId === playerId).map((f) => f.id),
  );
  const card = matchup.cards.find((c) => c.ownerFavoriteIds.some((id) => ownFavoriteIds.has(id)));
  return card?.id ?? null;
}
