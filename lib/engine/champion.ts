/**
 * Pick and fwd: the champion (mode spec §4.2).
 *
 * Each round's winner carries onto the next ballot as the champion, until a
 * fresh card beats it outright or it retires at CHAMPION_REIGN_CAP.
 *
 * The champion is DERIVED from the match-up record, never stored as state --
 * the same principle as scoring.ts. Replaying the revealed rounds in order
 * gives the champion and its reign at any point, so a replayed or repaired
 * game always agrees with itself. The coin flip for tied fresh cards is
 * seeded from the game seed and the round number alone, so it replays exactly
 * and doesn't depend on how many other random draws the game made.
 */

import { createRng } from './rng';
import { scoreMatchup } from './scoring';
import { itemKey } from './matchups';
import type { BallotCard, Favorite, Game, Matchup } from './types';

export const CHAMPION_REIGN_CAP = 3;

export interface Champion {
  /** The favorites the winning card belonged to. */
  favoriteIds: string[];
  /** ALL CAPS ballot text. */
  displayText: string;
  /** Rounds won in a row (mode spec §4.2). */
  reign: number;
}

export type CrownOutcome =
  /** Rule 1: nobody voted; the champion (if any) holds, reign unchanged. */
  | 'no_votes'
  /** Rule 2: the champion won or tied. */
  | 'defended'
  /** Rule 3: one fresh card won outright. */
  | 'new'
  /** Rule 4: fresh cards tied; a seeded coin flip chose one. */
  | 'coin_flip';

export interface RoundCrown {
  roundNumber: number;
  outcome: CrownOutcome;
  /** The champion that was on this round's ballot, if any. */
  previous: Champion | null;
  /** Who holds the crown after this round, before retirement. */
  holder: Champion | null;
  /** Step 2: the holder reached the cap and retired. */
  retired: boolean;
  /** The champion carried onto the next ballot (null after retirement or on the last round). */
  next: Champion | null;
}

/** A card is the champion card when it continues the previous round's winner. */
export function isChampionCard(card: BallotCard): boolean {
  return card.championReign !== null && card.championReign !== undefined;
}

/**
 * The coin flip (mode spec §4.2 rule 4). Seeded from the game seed and the
 * round number only; tied cards are ordered by display slot so the draw is
 * stable across reloads.
 */
function coinFlip(tied: BallotCard[], seed: number, roundNumber: number): BallotCard {
  const ordered = [...tied].sort((a, b) => a.sortOrder - b.sortOrder);
  const rng = createRng((seed ^ Math.imul(roundNumber, 0x9e3779b1)) >>> 0);
  return ordered[rng.int(ordered.length)];
}

function asChampion(card: BallotCard, reign: number): Champion {
  return { favoriteIds: [...card.ownerFavoriteIds].sort(), displayText: card.displayText, reign };
}

/** Decide the crown for one revealed round, given the champion that was on its ballot. */
export function crownForRound(
  matchup: Matchup,
  favorites: readonly Favorite[],
  previous: Champion | null,
  seed: number,
  isLastRound: boolean,
): RoundCrown {
  const outcome = scoreMatchup(matchup, favorites);
  const championCard = matchup.cards.find(isChampionCard) ?? null;
  const top = Math.max(0, ...Object.values(outcome.votesByCard));
  const leaders = matchup.cards.filter((c) => (outcome.votesByCard[c.id] ?? 0) === top);

  let kind: CrownOutcome;
  let holder: Champion | null;

  if (outcome.totalVotes === 0) {
    // Rule 1: the champion holds with its reign unchanged; no champion, none.
    kind = 'no_votes';
    holder = previous;
  } else if (championCard && leaders.includes(championCard) && previous) {
    // Rule 2: a champion has to be beaten outright to lose the crown.
    kind = 'defended';
    holder = { ...previous, favoriteIds: [...championCard.ownerFavoriteIds].sort(), reign: previous.reign + 1 };
  } else if (leaders.length === 1) {
    kind = 'new';
    holder = asChampion(leaders[0], 1);
  } else {
    kind = 'coin_flip';
    holder = asChampion(coinFlip(leaders, seed, matchup.roundNumber), 1);
  }

  // Step 2: retirement, then the end of the game.
  const retired = holder !== null && holder.reign >= CHAMPION_REIGN_CAP;
  const next = retired || isLastRound ? null : holder;
  return { roundNumber: matchup.roundNumber, outcome: kind, previous, holder, retired, next };
}

/** Every revealed round's crown, in order. Empty for Pick your fav. */
export function crownHistory(game: Game, seed: number): RoundCrown[] {
  if (game.mode !== 'pick_and_fwd') return [];
  const history: RoundCrown[] = [];
  let carried: Champion | null = null;
  const revealed = game.matchups
    .filter((m) => m.status === 'revealed')
    .sort((a, b) => a.roundNumber - b.roundNumber);
  for (const matchup of revealed) {
    const isLast = game.listLength !== null && matchup.roundNumber >= game.listLength;
    const crown = crownForRound(matchup, game.favorites, carried, seed, isLast);
    history.push(crown);
    carried = crown.next;
  }
  return history;
}

/** The champion to put on round `roundNumber`'s ballot, if any. */
export function championForRound(game: Game, roundNumber: number, seed: number): Champion | null {
  if (game.mode !== 'pick_and_fwd' || roundNumber <= 1) return null;
  const previous = crownHistory(game, seed).find((c) => c.roundNumber === roundNumber - 1);
  return previous?.next ?? null;
}

/**
 * Put the champion on a round's ballot (mode spec §4.1): a new card with a
 * new id, pinned at display slot 0. A fresh card that is the same item merges
 * into it, crediting both owners like any shared duplicate.
 */
export function addChampionCard(
  matchup: Matchup,
  champion: Champion,
  favorites: readonly Favorite[],
  newId: () => string,
): void {
  const byId = new Map(favorites.map((f) => [f.id, f]));
  const championKeys = new Set(
    champion.favoriteIds.map((id) => byId.get(id)).filter((f): f is Favorite => !!f).map(itemKey),
  );

  const merged: string[] = [];
  matchup.cards = matchup.cards.filter((card) => {
    const keys = card.ownerFavoriteIds.map((id) => byId.get(id)).filter((f): f is Favorite => !!f).map(itemKey);
    if (!keys.some((key) => championKeys.has(key))) return true;
    merged.push(...card.ownerFavoriteIds);
    return false;
  });

  matchup.cards.unshift({
    id: newId(),
    displayText: champion.displayText,
    sortOrder: 0,
    ownerFavoriteIds: [...new Set([...champion.favoriteIds, ...merged])].sort(),
    championReign: champion.reign,
  });
}

/**
 * The champion card's owners everyone may see before the reveal (mode spec
 * §4.3): the owners of the card that won the previous round. An owner merged
 * in from a fresh duplicate is one whose item was dealt into THIS round, and
 * stays hidden until the reveal, like any fresh card's owner.
 */
export function publicChampionFavoriteIds(
  card: BallotCard,
  roundNumber: number,
  favorites: readonly Favorite[],
): string[] {
  const byId = new Map(favorites.map((f) => [f.id, f]));
  return card.ownerFavoriteIds.filter((id) => byId.get(id)?.shuffledPosition !== roundNumber);
}
