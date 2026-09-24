/**
 * The Computer player (spec §9.1).
 *
 * It plays items but never votes. It has no taste, so random votes from it
 * would decide most rounds in a 2-player game -- humans decide the game, and
 * every point the Computer earns comes from a human preferring its pick.
 *
 * Its strength is load-bearing, not cosmetic: a weak Computer gets skipped by
 * both players in a 2-player game, which puts the 1-1 tie problem straight
 * back. D7 targets a 20-30% Computer win rate.
 */

import type { Rng } from './rng';
import {
  DEFAULT_COMPUTER_STRENGTH,
  WILDCARD_PICK_RATE,
  type ListLength,
} from './constants';

export interface DictionaryEntry {
  id: number;
  canonicalName: string;
  /** Hand-curated launch pool, used before item_stats has data. */
  popularTier: boolean;
  /** Promoted from unmatched_entries; the source of wildcard picks. */
  playerOriginated: boolean;
  appearances: number;
  votesReceived: number;
  roundWins: number;
}

export interface ComputerPickInput {
  dictionary: readonly DictionaryEntry[];
  listLength: ListLength;
  /** Canonical ids already on a human list, auto-filled ones included. */
  excludedItemIds: ReadonlySet<number>;
  /** Items this group has already faced, for the 3-game variety window. */
  recentItemIds?: ReadonlySet<number>;
  strength?: number;
  rng: Rng;
}

/**
 * How often an item wins when it appears, smoothed toward the mean so a
 * 1-appearance item that happened to win doesn't outrank a proven one.
 */
export function itemStrength(entry: DictionaryEntry): number {
  const PRIOR_WEIGHT = 5;
  const PRIOR_RATE = 0.25;
  const wins = entry.roundWins + PRIOR_WEIGHT * PRIOR_RATE;
  const plays = entry.appearances + PRIOR_WEIGHT;
  return wins / plays;
}

/**
 * Mix uniform-random against win-rate weighting.
 *
 * strength 0 is uniform, strength 1 is fully win-rate driven. Everything stays
 * above zero so no eligible item is ever unreachable -- that keeps variety up
 * and stops the Computer from playing the same five items forever.
 */
function selectionWeight(entry: DictionaryEntry, strength: number): number {
  const clamped = Math.min(1, Math.max(0, strength));
  return (1 - clamped) + clamped * (itemStrength(entry) * 4);
}

export interface ComputerPickResult {
  items: DictionaryEntry[];
  /** True when item_stats was too thin and the popular tier carried the pick. */
  usedColdStart: boolean;
}

export function pickComputerItems(input: ComputerPickInput): ComputerPickResult {
  const {
    dictionary,
    listLength,
    excludedItemIds,
    recentItemIds = new Set<number>(),
    strength = DEFAULT_COMPUTER_STRENGTH,
    rng,
  } = input;

  // §9.1: the Computer never duplicates a human's item. This is what makes the
  // "Computer never collides" guarantee in §9.2 hold.
  const eligible = dictionary.filter((entry) => !excludedItemIds.has(entry.id));
  if (eligible.length < listLength) {
    throw new Error(
      `category dictionary has ${eligible.length} eligible items, need ${listLength}`,
    );
  }

  const hasStats = eligible.some((entry) => entry.appearances > 0);
  const usedColdStart = !hasStats;

  // Cold start: lean on the curated popular tier until real stats exist.
  const mainPool = usedColdStart
    ? (eligible.filter((e) => e.popularTier).length >= listLength
        ? eligible.filter((e) => e.popularTier)
        : eligible)
    : eligible;

  const wildcardPool = eligible.filter((e) => e.playerOriginated);

  const chosen: DictionaryEntry[] = [];
  const takenIds = new Set<number>();

  const drawFrom = (pool: readonly DictionaryEntry[]): DictionaryEntry | null => {
    // Honour the variety window first, but never fail a pick because of it.
    const fresh = pool.filter((e) => !takenIds.has(e.id) && !recentItemIds.has(e.id));
    const candidates = fresh.length > 0
      ? fresh
      : pool.filter((e) => !takenIds.has(e.id));
    if (candidates.length === 0) return null;
    return rng.weighted(candidates, (entry) => selectionWeight(entry, strength));
  };

  for (let i = 0; i < listLength; i++) {
    // ~10% of picks are player-originated, so the Computer can't be spotted by
    // its uniformly "generic" taste.
    const wantWildcard = wildcardPool.length > 0 && rng.next() < WILDCARD_PICK_RATE;
    const entry = (wantWildcard ? drawFrom(wildcardPool) : null) ?? drawFrom(mainPool) ?? drawFrom(eligible);
    if (!entry) throw new Error('ran out of eligible dictionary items');
    chosen.push(entry);
    takenIds.add(entry.id);
  }

  return { items: chosen, usedColdStart };
}

/**
 * Cards per ballot, and how many a given voter can actually choose from.
 * From the table in §9.2: with 2 humans a voter picks between the opponent's
 * card and the Computer's -- a true "this or that".
 */
export function ballotShape(humanCount: number): { cards: number; choices: number } {
  return { cards: humanCount + 1, choices: humanCount };
}
