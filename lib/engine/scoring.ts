/**
 * Scoring (spec §9.5), Final Showdown multipliers (§9.6) and percentage
 * scoring (§12).
 *
 * Scores are DERIVED from the match-up record, never accumulated into a
 * counter. That makes the §14.10 property "total points equal the sum of votes
 * and bonuses" true by construction rather than by careful bookkeeping, and it
 * means a replayed or repaired game recomputes to the same numbers.
 */

import type { Favorite, Matchup, Player, SessionState } from './types';
import type { ListLength } from './constants';

export interface RoundOutcome {
  roundNumber: number;
  multiplier: 1 | 2;
  /** playerId -> points earned this round (votes + any win bonus). */
  points: Record<string, number>;
  /** Owners of the most-voted card. Empty when nobody voted. */
  winnerPlayerIds: string[];
  /** ballotCardId -> raw vote count, before the multiplier. */
  votesByCard: Record<string, number>;
  totalVotes: number;
}

export interface PlayerScore {
  playerId: string;
  isComputer: boolean;
  name: string;
  score: number;
  roundWins: number;
  /** Null for the Computer: the board formula is defined for humans (§12). */
  maxPossible: number | null;
  pct: number | null;
  rank: number;
}

/** Owners of a card, as player ids. Shared duplicates have several (§9.5). */
function ownersOfCard(
  cardOwnerFavoriteIds: readonly string[],
  favoritesById: ReadonlyMap<string, Favorite>,
): string[] {
  const owners: string[] = [];
  for (const favoriteId of cardOwnerFavoriteIds) {
    const favorite = favoritesById.get(favoriteId);
    // A missing favorite means a corrupt game record; skip rather than crash
    // mid-reveal, and let the property tests catch it in CI.
    if (favorite && !owners.includes(favorite.playerId)) owners.push(favorite.playerId);
  }
  return owners;
}

/**
 * Score one match-up.
 *
 * Every owner of a card receives the FULL vote count, multiplied. For shared
 * duplicate items that means both owners get the full amount rather than half
 * each -- the spec is explicit, and halving would punish players for a
 * collision they can't see coming during entry.
 */
export function scoreMatchup(
  matchup: Matchup,
  favorites: readonly Favorite[],
): RoundOutcome {
  const favoritesById = new Map(favorites.map((f) => [f.id, f]));
  const points: Record<string, number> = {};
  const votesByCard: Record<string, number> = {};

  for (const card of matchup.cards) votesByCard[card.id] = 0;
  for (const cardId of Object.values(matchup.votes)) {
    if (cardId in votesByCard) votesByCard[cardId] += 1;
  }

  const totalVotes = Object.values(votesByCard).reduce((a, b) => a + b, 0);

  // §9.5.5: everyone timed out. No points, no winner, no bonus.
  if (totalVotes === 0) {
    return {
      roundNumber: matchup.roundNumber,
      multiplier: matchup.multiplier,
      points,
      winnerPlayerIds: [],
      votesByCard,
      totalVotes: 0,
    };
  }

  // 1 point per vote, scaled by the Final Showdown multiplier.
  for (const card of matchup.cards) {
    const voteCount = votesByCard[card.id];
    if (voteCount === 0) continue;
    for (const playerId of ownersOfCard(card.ownerFavoriteIds, favoritesById)) {
      points[playerId] = (points[playerId] ?? 0) + voteCount * matchup.multiplier;
    }
  }

  // §9.5.3-4: the most-voted card wins the round. Ties make co-winners, and
  // each co-winner takes the full bonus.
  const topVotes = Math.max(...matchup.cards.map((c) => votesByCard[c.id]));
  const winnerPlayerIds: string[] = [];
  for (const card of matchup.cards) {
    if (votesByCard[card.id] !== topVotes) continue;
    for (const playerId of ownersOfCard(card.ownerFavoriteIds, favoritesById)) {
      if (winnerPlayerIds.includes(playerId)) continue;
      winnerPlayerIds.push(playerId);
      points[playerId] = (points[playerId] ?? 0) + 1 * matchup.multiplier;
    }
  }

  return {
    roundNumber: matchup.roundNumber,
    multiplier: matchup.multiplier,
    points,
    winnerPlayerIds,
    votesByCard,
    totalVotes,
  };
}

/**
 * §12: the most a human can earn in a round is (humans - 1) votes -- they
 * can't vote for themselves -- plus the 1-point win bonus, so exactly
 * `humans`, scaled by the round multiplier.
 *
 * Note this ceiling does NOT hold for the Computer, which can collect a vote
 * from every human plus the bonus (humans + 1). That is why the boards are
 * humans-only, and why pct is null for the Computer.
 */
export function maxPossibleForHuman(
  listLength: ListLength,
  humanCount: number,
  multiplierForRound: (round: number) => 1 | 2,
): number {
  let total = 0;
  for (let round = 1; round <= listLength; round++) {
    total += multiplierForRound(round) * humanCount;
  }
  return total;
}

export function percentage(score: number, maxPossible: number): number {
  if (maxPossible <= 0) return 0;
  return Math.round((100 * score) / maxPossible);
}

/** Every revealed round, scored. Rounds still in progress are ignored. */
export function scoreGame(state: SessionState): RoundOutcome[] {
  const game = state.game;
  if (!game) return [];
  return game.matchups
    .filter((m) => m.status === 'revealed')
    .map((m) => scoreMatchup(m, game.favorites));
}

/**
 * Final standings (§10).
 *
 * Ranking: points, then round wins as the tiebreaker. Players still level
 * after both share a rank -- "shared victory" in the spec.
 */
export function standings(state: SessionState): PlayerScore[] {
  const game = state.game;
  const outcomes = scoreGame(state);

  const totals = new Map<string, { score: number; roundWins: number }>();
  for (const player of state.players) {
    if (player.queued) continue;
    totals.set(player.id, { score: 0, roundWins: 0 });
  }
  for (const outcome of outcomes) {
    for (const [playerId, pts] of Object.entries(outcome.points)) {
      const entry = totals.get(playerId);
      if (entry) entry.score += pts;
    }
    for (const playerId of outcome.winnerPlayerIds) {
      const entry = totals.get(playerId);
      if (entry) entry.roundWins += 1;
    }
  }

  const humanCount = game?.humanCount ?? null;
  const listLength = game?.listLength ?? null;

  const rows = state.players
    .filter((p) => !p.queued && totals.has(p.id))
    .map((player): Omit<PlayerScore, 'rank'> => {
      const entry = totals.get(player.id)!;
      const maxPossible =
        player.isComputer || humanCount === null || listLength === null
          ? null
          : maxPossibleForHuman(listLength, humanCount, (round) =>
              game!.matchups.find((m) => m.roundNumber === round)?.multiplier ?? 1,
            );
      return {
        playerId: player.id,
        isComputer: player.isComputer,
        name: player.name,
        score: entry.score,
        roundWins: entry.roundWins,
        maxPossible,
        pct: maxPossible === null ? null : percentage(entry.score, maxPossible),
      };
    });

  rows.sort((a, b) => b.score - a.score || b.roundWins - a.roundWins);

  // Equal score AND equal round wins share a rank (§10 "shared victory").
  const ranked: PlayerScore[] = [];
  rows.forEach((row, index) => {
    const previous = ranked[index - 1];
    const tiedWithPrevious =
      previous && previous.score === row.score && previous.roundWins === row.roundWins;
    ranked.push({ ...row, rank: tiedWithPrevious ? previous.rank : index + 1 });
  });
  return ranked;
}

/** §9.5.8: who leads after each round, so the reveal can call out changes. */
export function leaderAfterEachRound(state: SessionState): (string | null)[] {
  const game = state.game;
  if (!game) return [];
  const outcomes = scoreGame(state);
  const running = new Map<string, number>();
  const leaders: (string | null)[] = [];

  for (const outcome of outcomes) {
    for (const [playerId, pts] of Object.entries(outcome.points)) {
      running.set(playerId, (running.get(playerId) ?? 0) + pts);
    }
    let leader: string | null = null;
    let best = -1;
    let tied = false;
    for (const [playerId, total] of running) {
      if (total > best) {
        best = total;
        leader = playerId;
        tied = false;
      } else if (total === best) {
        tied = true;
      }
    }
    // A tie at the top is nobody's lead, so the callout doesn't fire twice.
    leaders.push(tied || best <= 0 ? null : leader);
  }
  return leaders;
}

/** The best-placed human, used for "Top Human" when the Computer wins (§10). */
export function topHuman(rows: readonly PlayerScore[]): PlayerScore | null {
  return rows.find((row) => !row.isComputer) ?? null;
}

export function computerWon(rows: readonly PlayerScore[]): boolean {
  return rows.length > 0 && rows[0].isComputer && rows[0].rank === 1;
}

/** §10: a badge for every human who finished above the Computer. */
export function beatTheComputer(rows: readonly PlayerScore[]): string[] {
  const computer = rows.find((row) => row.isComputer);
  if (!computer) return rows.filter((r) => !r.isComputer).map((r) => r.playerId);
  return rows
    .filter((row) => !row.isComputer && row.rank < computer.rank)
    .map((row) => row.playerId);
}

export function activeHumans(players: readonly Player[]): Player[] {
  return players.filter((p) => !p.isComputer && !p.queued && p.leftAt === null);
}

export function connectedHumans(players: readonly Player[], now: number, staleMs: number): Player[] {
  return activeHumans(players).filter((p) => now - p.lastSeenAt < staleMs);
}
