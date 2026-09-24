import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { simulateGame, makeDictionary } from './simulate';
import { scoreGame, standings, maxPossibleForHuman } from '../scoring';
import { pickComputerItems } from '../computer';
import { createRng } from '../rng';
import { multiplierForRound, LIST_LENGTHS, type ListLength } from '../constants';

const humanCounts = [2, 3, 4];

/** §14.10 calls these out by name as the properties worth testing mechanically. */
describe('§14.10 engine properties', () => {
  it('total points equal the sum of votes and bonuses', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...humanCounts),
        fc.constantFrom(...LIST_LENGTHS),
        fc.integer({ min: 1, max: 5000 }),
        (humanCount, listLength, seed) => {
          const { state } = simulateGame({ humanCount, listLength: listLength as ListLength, seed });
          const outcomes = scoreGame(state);

          const awarded = outcomes.reduce(
            (sum, o) => sum + Object.values(o.points).reduce((a, b) => a + b, 0),
            0,
          );
          const expected = outcomes.reduce((sum, o) => {
            const voteShare = Object.values(o.votesByCard).reduce((a, b) => a + b, 0) * o.multiplier;
            // Shared cards credit each owner in full, so bonuses and votes both
            // scale with the number of owners, not the number of cards.
            const sharedExtra = o.totalVotes === 0 ? 0 : sharedOwnerExtra(state, o.roundNumber);
            return sum + voteShare + sharedExtra + o.winnerPlayerIds.length * o.multiplier;
          }, 0);
          expect(awarded).toBe(expected);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('no human score ever exceeds max_possible', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...humanCounts),
        fc.constantFrom(...LIST_LENGTHS),
        fc.integer({ min: 1, max: 5000 }),
        (humanCount, listLength, seed) => {
          const { state } = simulateGame({ humanCount, listLength: listLength as ListLength, seed });
          const rows = standings(state);
          const ceiling = maxPossibleForHuman(listLength as ListLength, humanCount, (r) =>
            multiplierForRound(listLength as ListLength, r),
          );
          for (const row of rows) {
            if (row.isComputer) continue;
            expect(row.score).toBeLessThanOrEqual(ceiling);
            expect(row.pct!).toBeLessThanOrEqual(100);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('every match-up holds exactly one entry per active list', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...humanCounts),
        fc.constantFrom(...LIST_LENGTHS),
        fc.integer({ min: 1, max: 5000 }),
        (humanCount, listLength, seed) => {
          const { state } = simulateGame({ humanCount, listLength: listLength as ListLength, seed });
          const listCount = humanCount + 1; // humans plus the Computer
          for (const matchup of state.game!.matchups) {
            const owners = matchup.cards.flatMap((c) => c.ownerFavoriteIds);
            expect(owners).toHaveLength(listCount);
            expect(new Set(owners).size).toBe(listCount);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('a game always reaches results -- no phase is a dead end', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...humanCounts),
        fc.constantFrom(...LIST_LENGTHS),
        fc.integer({ min: 1, max: 5000 }),
        (humanCount, listLength, seed) => {
          const { state, statuses } = simulateGame({
            humanCount, listLength: listLength as ListLength, seed,
          });
          expect(state.status).toBe('results');
          expect(statuses).toContain('computer_picking');
          expect(statuses).toContain('matchup_voting');
          expect(statuses).toContain('matchup_reveal');
        },
      ),
      { numRuns: 30 },
    );
  });

  it('reaches results even when every player times out on every round', () => {
    const { state } = simulateGame({
      humanCount: 3, listLength: 5, seed: 7, silentPlayerIds: ['p1', 'p2', 'p3'],
    });
    expect(state.status).toBe('results');
    // §9.5.5: no votes means no points for anyone.
    expect(standings(state).every((row) => row.score === 0)).toBe(true);
  });
});

describe('§9.1 the Computer never duplicates a human item', () => {
  it('excludes every canonical id already in play', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.constantFrom(...LIST_LENGTHS),
        (seed, listLength) => {
          const dictionary = makeDictionary(200);
          const excluded = new Set(dictionary.slice(0, 60).map((e) => e.id));
          const { items } = pickComputerItems({
            dictionary, listLength: listLength as ListLength,
            excludedItemIds: excluded, rng: createRng(seed),
          });
          expect(items).toHaveLength(listLength);
          for (const item of items) expect(excluded.has(item.id)).toBe(false);
          // And never repeats itself within one list.
          expect(new Set(items.map((i) => i.id)).size).toBe(listLength);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('refuses to build a list from a dictionary that is too small', () => {
    const dictionary = makeDictionary(6);
    expect(() =>
      pickComputerItems({
        dictionary, listLength: 15, excludedItemIds: new Set(), rng: createRng(1),
      }),
    ).toThrow(/need 15/);
  });
});

/**
 * Extra credit paid out when a card has more than one owner: each owner gets
 * the full vote count, so the round's total exceeds the raw vote count.
 */
function sharedOwnerExtra(state: ReturnType<typeof simulateGame>['state'], roundNumber: number): number {
  const game = state.game!;
  const matchup = game.matchups.find((m) => m.roundNumber === roundNumber)!;
  let extra = 0;
  for (const cardEntry of matchup.cards) {
    const owners = new Set(
      cardEntry.ownerFavoriteIds
        .map((fid) => game.favorites.find((f) => f.id === fid)?.playerId)
        .filter(Boolean),
    );
    if (owners.size <= 1) continue;
    const votes = Object.values(matchup.votes).filter((id) => id === cardEntry.id).length;
    extra += votes * (owners.size - 1) * matchup.multiplier;
  }
  return extra;
}
