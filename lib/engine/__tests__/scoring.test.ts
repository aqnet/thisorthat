import { describe, it, expect } from 'vitest';
import { scoreMatchup, maxPossibleForHuman, percentage, standings, computerWon, topHuman, beatTheComputer } from '../scoring';
import { multiplierForRound, SHOWDOWN_ROUNDS } from '../constants';
import { card, favorite, matchup, player, session } from './fixtures';

/**
 * The 2-player table from §9.5. This is the case the Computer exists to fix,
 * so it gets tested value by value rather than in aggregate.
 */
describe('§9.5 two-player outcomes', () => {
  const favorites = [
    favorite('f-ana', 'ana', 'Mango'),
    favorite('f-ben', 'ben', 'Kiwi'),
    favorite('f-cpu', 'cpu', 'Pineapple'),
  ];
  const cards = [
    card('c-ana', 'Mango', ['f-ana'], 1),
    card('c-ben', 'Kiwi', ['f-ben'], 2),
    card('c-cpu', 'Pineapple', ['f-cpu'], 3),
  ];

  const run = (anaVote: string, benVote: string) =>
    scoreMatchup(matchup({ cards, votes: { ana: anaVote, ben: benVote } }), favorites);

  it('each voting for the other ties them at 2 apiece', () => {
    const out = run('c-ben', 'c-ana');
    expect(out.points).toEqual({ ana: 2, ben: 2 });
    expect(out.winnerPlayerIds.sort()).toEqual(['ana', 'ben']);
  });

  it('Ana picks the Computer: Ana and the Computer tie, Ben scores nothing', () => {
    const out = run('c-cpu', 'c-ana');
    expect(out.points).toEqual({ ana: 2, cpu: 2 });
    expect(out.points.ben).toBeUndefined();
  });

  it('Ben picks the Computer: Ben and the Computer tie, Ana scores nothing', () => {
    const out = run('c-ben', 'c-cpu');
    expect(out.points).toEqual({ ben: 2, cpu: 2 });
    expect(out.points.ana).toBeUndefined();
  });

  it('both pick the Computer: it wins outright with 3', () => {
    const out = run('c-cpu', 'c-cpu');
    expect(out.points).toEqual({ cpu: 3 });
    expect(out.winnerPlayerIds).toEqual(['cpu']);
  });

  it('only the Computer can win a 2-player round outright', () => {
    const humanOutright = [
      run('c-ben', 'c-ana'),
      run('c-cpu', 'c-ana'),
      run('c-ben', 'c-cpu'),
    ].some((out) => out.winnerPlayerIds.length === 1 && out.winnerPlayerIds[0] !== 'cpu');
    expect(humanOutright).toBe(false);
  });
});

describe('§9.5 scoring rules', () => {
  const favorites = [
    favorite('f-ana', 'ana', 'Mango'),
    favorite('f-ben', 'ben', 'Kiwi'),
    favorite('f-cy', 'cy', 'Plum'),
    favorite('f-cpu', 'cpu', 'Pineapple'),
  ];
  const cards = [
    card('c-ana', 'Mango', ['f-ana'], 1),
    card('c-ben', 'Kiwi', ['f-ben'], 2),
    card('c-cy', 'Plum', ['f-cy'], 3),
    card('c-cpu', 'Pineapple', ['f-cpu'], 4),
  ];

  it('matches the worked example in the spec', () => {
    // Ana's Mango 2 votes, Computer 1, Kiwi and Plum 0.
    const out = scoreMatchup(
      matchup({ cards, votes: { ben: 'c-ana', cy: 'c-ana', ana: 'c-cpu' } }),
      favorites,
    );
    expect(out.points).toEqual({ ana: 3, cpu: 1 });
    expect(out.winnerPlayerIds).toEqual(['ana']);
  });

  it('awards no points and no winner when nobody votes', () => {
    const out = scoreMatchup(matchup({ cards, votes: {} }), favorites);
    expect(out.points).toEqual({});
    expect(out.winnerPlayerIds).toEqual([]);
    expect(out.totalVotes).toBe(0);
  });

  it('gives every owner of a shared duplicate the full vote count', () => {
    const shared = [card('c-shared', 'Mango', ['f-ana', 'f-ben'], 1), card('c-cpu', 'Pineapple', ['f-cpu'], 2)];
    const out = scoreMatchup(
      matchup({ cards: shared, votes: { cy: 'c-shared', ana: 'c-shared' } }),
      favorites,
    );
    // 2 votes each, not 1 each, plus the win bonus each.
    expect(out.points).toEqual({ ana: 3, ben: 3 });
  });

  it('doubles both votes and bonus in a Final Showdown round', () => {
    const normal = scoreMatchup(matchup({ cards, votes: { ben: 'c-ana', cy: 'c-ana' } }), favorites);
    const showdown = scoreMatchup(
      matchup({ multiplier: 2, cards, votes: { ben: 'c-ana', cy: 'c-ana' } }),
      favorites,
    );
    expect(normal.points.ana).toBe(3); // 2 votes + 1 bonus
    expect(showdown.points.ana).toBe(6); // (2 votes + 1 bonus) x2
  });
});

describe('§9.6 Final Showdown rounds', () => {
  it('marks the rounds the spec lists', () => {
    expect(SHOWDOWN_ROUNDS[5]).toEqual([5]);
    expect(SHOWDOWN_ROUNDS[10]).toEqual([10]);
    expect(SHOWDOWN_ROUNDS[15]).toEqual([13, 14, 15]);
  });

  it('doubles only those rounds', () => {
    expect(multiplierForRound(15, 12)).toBe(1);
    expect(multiplierForRound(15, 13)).toBe(2);
    expect(multiplierForRound(10, 10)).toBe(2);
    expect(multiplierForRound(10, 9)).toBe(1);
  });
});

describe('§12 percentage scoring', () => {
  it('uses (humans - 1) votes + 1 bonus per round, so `humans` per round', () => {
    // 10 rounds, 4 humans, round 10 doubled: 9x4 + 1x8 = 44
    expect(maxPossibleForHuman(10, 4, (r) => multiplierForRound(10, r))).toBe(44);
    // 2 humans is a lower ceiling, which is why boards rank by percentage.
    expect(maxPossibleForHuman(10, 2, (r) => multiplierForRound(10, r))).toBe(22);
  });

  it('rounds to a whole percent', () => {
    expect(percentage(52, 60)).toBe(87);
    expect(percentage(0, 44)).toBe(0);
    expect(percentage(44, 44)).toBe(100);
  });

  it('never divides by zero', () => {
    expect(percentage(5, 0)).toBe(0);
  });
});

describe('§10 final results', () => {
  const build = () => {
    const favorites = [
      favorite('f-ana', 'ana', 'Mango'),
      favorite('f-ben', 'ben', 'Kiwi'),
      favorite('f-cpu', 'cpu', 'Pineapple'),
    ];
    const cards = [
      card('c-ana', 'Mango', ['f-ana'], 1),
      card('c-ben', 'Kiwi', ['f-ben'], 2),
      card('c-cpu', 'Pineapple', ['f-cpu'], 3),
    ];
    return session({
      players: [
        player('ana'),
        player('ben', { colorSlot: 2 }),
        player('cpu', { isComputer: true, colorSlot: 0, name: 'Computer' }),
      ],
      game: {
        id: 'g1', number: 1, offeredCategoryIds: [], categoryId: 1, listLength: 5,
        humanCount: 2, currentRound: 5, endedEarly: false, favorites,
        matchups: [
          matchup({ id: 'm1', roundNumber: 1, cards, votes: { ana: 'c-cpu', ben: 'c-cpu' } }),
          matchup({ id: 'm2', roundNumber: 2, cards, votes: { ana: 'c-cpu', ben: 'c-cpu' } }),
        ],
        categoryVotes: {}, submitted: {}, computerItemIds: [], startedAt: 0, endedAt: null,
      },
    });
  };

  it('reports a Computer win with a Top Human', () => {
    const rows = standings(build());
    expect(computerWon(rows)).toBe(true);
    expect(rows[0].name).toBe('Computer');
    expect(topHuman(rows)!.isComputer).toBe(false);
  });

  it('gives the Computer no percentage, since the board formula is humans-only', () => {
    const rows = standings(build());
    expect(rows.find((r) => r.isComputer)!.pct).toBeNull();
    expect(rows.find((r) => !r.isComputer)!.pct).not.toBeNull();
  });

  it('badges nobody when the Computer finishes first', () => {
    expect(beatTheComputer(standings(build()))).toEqual([]);
  });
});
