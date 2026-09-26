import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CHAMPION_REIGN_CAP,
  addChampionCard,
  crownForRound,
  crownHistory,
  isChampionCard,
  publicChampionFavoriteIds,
  type Champion,
} from '../champion';
import { scoreMatchup, standings, maxPossibleForHuman } from '../scoring';
import { multiplierForRound, LIST_LENGTHS, type ListLength } from '../constants';
import { apply } from '../reducer';
import { ownCardIds } from '../matchups';
import { simulateGame } from './simulate';
import { card, favorite, matchup } from './fixtures';
import type { BallotCard, Favorite } from '../types';

/** Pick and fwd mode spec §4. */

const favorites: Favorite[] = [
  favorite('fa', 'ana', 'Mango', 1),
  favorite('fb', 'ben', 'Kiwi', 1),
  favorite('fc', 'cpu', 'Plum', 1),
  favorite('fa2', 'ana', 'Fig', 2),
];

const champ = (reign: number, favoriteIds = ['fa2']): Champion => ({ favoriteIds, displayText: 'FIG', reign });
const championCard = (reign: number): BallotCard => ({ ...card('ch', 'Fig', ['fa2'], 0), championReign: reign });

/** A round with Ana, Ben and the Computer's fresh cards, plus an optional champion. */
function round(votes: Record<string, string>, withChampion: number | null = null) {
  const cards = [card('a', 'Mango', ['fa'], 1), card('b', 'Kiwi', ['fb'], 2), card('c', 'Plum', ['fc'], 3)];
  if (withChampion !== null) cards.unshift(championCard(withChampion));
  return matchup({ roundNumber: 2, status: 'revealed', cards, votes });
}

describe('§4.2 step 1: who holds the crown', () => {
  it('rule 1: with nobody voting, the champion holds and its reign is unchanged', () => {
    const crown = crownForRound(round({}, 2), favorites, champ(2), 1, false);
    expect(crown.outcome).toBe('no_votes');
    expect(crown.next?.reign).toBe(2);
  });

  it('rule 1: with nobody voting and no champion, there is still none', () => {
    const crown = crownForRound(round({}), favorites, null, 1, false);
    expect(crown.next).toBeNull();
  });

  it('rule 2: the champion holds when it ties, and its reign goes up', () => {
    const crown = crownForRound(round({ u1: 'ch', u2: 'b' }, 1), favorites, champ(1), 1, false);
    expect(crown.outcome).toBe('defended');
    expect(crown.next?.reign).toBe(2);
    // The tied fresh card still takes the round-win bonus (§9.5.4).
    expect(scoreMatchup(round({ u1: 'ch', u2: 'b' }, 1), favorites).winnerPlayerIds).toContain('ben');
  });

  it('rule 3: a fresh card that wins outright takes the crown at reign 1', () => {
    const crown = crownForRound(round({ u1: 'b', u2: 'b', u3: 'ch' }, 2), favorites, champ(2), 1, false);
    expect(crown.outcome).toBe('new');
    expect(crown.next).toMatchObject({ displayText: 'KIWI', reign: 1, favoriteIds: ['fb'] });
  });

  it('rule 4: tied fresh cards go to a coin flip that replays exactly', () => {
    const tied = round({ u1: 'a', u2: 'b' });
    const first = crownForRound(tied, favorites, null, 42, false);
    expect(first.outcome).toBe('coin_flip');
    expect(['MANGO', 'KIWI']).toContain(first.next?.displayText);
    for (let i = 0; i < 5; i++) {
      expect(crownForRound(tied, favorites, null, 42, false).next).toEqual(first.next);
    }
  });

  it('rule 4: the coin flip is fair enough to land both ways across seeds', () => {
    const tied = round({ u1: 'a', u2: 'b' });
    const winners = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) winners.add(crownForRound(tied, favorites, null, seed, false).next!.displayText);
    expect(winners).toEqual(new Set(['MANGO', 'KIWI']));
  });
});

describe('§4.2 step 2: retirement and the last round', () => {
  it(`retires a champion when it reaches reign ${CHAMPION_REIGN_CAP}`, () => {
    const crown = crownForRound(round({ u1: 'ch', u2: 'ch' }, 2), favorites, champ(2), 1, false);
    expect(crown.holder?.reign).toBe(3);
    expect(crown.retired).toBe(true);
    expect(crown.next).toBeNull();
  });

  it('retires on a tie too, and the tied fresh card does not take the crown', () => {
    const crown = crownForRound(round({ u1: 'ch', u2: 'b' }, 2), favorites, champ(2), 1, false);
    expect(crown.retired).toBe(true);
    expect(crown.next).toBeNull();
  });

  it('carries nothing past the last round', () => {
    const crown = crownForRound(round({ u1: 'b' }), favorites, null, 1, true);
    expect(crown.holder?.displayText).toBe('KIWI');
    expect(crown.next).toBeNull();
  });
});

describe('§4.1 putting the champion on the ballot', () => {
  const fresh = () =>
    matchup({
      roundNumber: 3,
      status: 'pending',
      cards: [card('x1', 'Kiwi', ['fb3'], 1), card('x2', 'Fig', ['fdup'], 2), card('x3', 'Plum', ['fc3'], 3)],
    });
  const pool: Favorite[] = [
    { ...favorite('fa2', 'ana', 'Fig', 2), shuffledPosition: 2 },
    { ...favorite('fb3', 'ben', 'Kiwi', 3), shuffledPosition: 3 },
    { ...favorite('fdup', 'ben', 'Fig', 4), shuffledPosition: 3 },
    { ...favorite('fc3', 'cpu', 'Plum', 3), shuffledPosition: 3 },
  ];

  it('pins the champion first with a new card id and its reign', () => {
    const m = fresh();
    addChampionCard(m, champ(1), pool, () => 'new-id');
    expect(m.cards[0]).toMatchObject({ id: 'new-id', sortOrder: 0, championReign: 1, displayText: 'FIG' });
    expect(m.cards.filter(isChampionCard)).toHaveLength(1);
  });

  it('merges a fresh duplicate into the champion, crediting both owners', () => {
    const m = fresh();
    addChampionCard(m, champ(1), pool, () => 'new-id');
    expect(m.cards.map((c) => c.displayText)).toEqual(['FIG', 'KIWI', 'PLUM']);
    expect(m.cards[0].ownerFavoriteIds).toEqual(['fa2', 'fdup']);
  });

  it('shows only the original owner before the reveal (§4.3)', () => {
    const m = fresh();
    addChampionCard(m, champ(1), pool, () => 'new-id');
    expect(publicChampionFavoriteIds(m.cards[0], 3, pool)).toEqual(['fa2']);
  });

  it('refuses a vote for either card when a player owns two', () => {
    const m = fresh();
    addChampionCard(m, champ(1), pool, () => 'new-id');
    // Ben owns KIWI and, through the merged duplicate, the champion.
    expect(ownCardIds(m, 'ben', pool).sort()).toEqual(['new-id', 'x1']);
  });
});

describe('§4.4 scoring', () => {
  it('gives one round-win bonus to a player whose two cards tie for the win', () => {
    const m = matchup({
      status: 'revealed',
      cards: [
        { ...card('ch', 'Fig', ['fa2'], 0), championReign: 1 },
        card('a', 'Mango', ['fa'], 1),
        card('b', 'Kiwi', ['fb'], 2),
      ],
      votes: { ben: 'ch', cy: 'a' },
    });
    const outcome = scoreMatchup(m, favorites);
    // Ana: 1 vote + 1 vote + ONE bonus.
    expect(outcome.points.ana).toBe(3);
  });
});

describe('Pick and fwd, whole games (§14.10 properties)', () => {
  const arbitraries = [
    fc.constantFrom(2, 3, 4),
    fc.constantFrom(...LIST_LENGTHS),
    fc.integer({ min: 1, max: 5000 }),
  ] as const;

  /** Voters pick at random, so champions win, lose and tie in every pattern. */
  const play = (humanCount: number, listLength: ListLength, seed: number) =>
    simulateGame({
      humanCount, listLength, seed, mode: 'pick_and_fwd',
      chooseCard: ({ options, rng }) => options[rng.int(options.length)].id,
    }).state;

  it('never puts more than one champion on a ballot, and none on round 1', () => {
    fc.assert(
      fc.property(...arbitraries, (humanCount, listLength, seed) => {
        const state = play(humanCount, listLength as ListLength, seed);
        for (const m of state.game!.matchups) {
          const champions = m.cards.filter(isChampionCard);
          expect(champions.length).toBeLessThanOrEqual(1);
          if (m.roundNumber === 1) expect(champions).toHaveLength(0);
          expect(m.cards.length).toBeLessThanOrEqual(humanCount + 2);
        }
      }),
      { numRuns: 60 },
    );
  });

  it(`never lets a champion reign past ${CHAMPION_REIGN_CAP} or outlive the game`, () => {
    fc.assert(
      fc.property(...arbitraries, (humanCount, listLength, seed) => {
        const state = play(humanCount, listLength as ListLength, seed);
        for (const m of state.game!.matchups) {
          for (const c of m.cards.filter(isChampionCard)) {
            expect(c.championReign!).toBeGreaterThanOrEqual(1);
            expect(c.championReign!).toBeLessThan(CHAMPION_REIGN_CAP);
          }
        }
        expect(crownHistory(state.game!, seed).at(-1)?.next ?? null).toBeNull();
      }),
      { numRuns: 60 },
    );
  });

  it('carries exactly the champion the round record derives, every round', () => {
    fc.assert(
      fc.property(...arbitraries, (humanCount, listLength, seed) => {
        const state = play(humanCount, listLength as ListLength, seed);
        const history = crownHistory(state.game!, seed);
        // Deriving twice gives the same answer, coin flips included.
        expect(crownHistory(state.game!, seed)).toEqual(history);
        for (const crown of history) {
          const nextRound = state.game!.matchups.find((m) => m.roundNumber === crown.roundNumber + 1);
          const onBallot = nextRound?.cards.find(isChampionCard) ?? null;
          if (!crown.next) {
            expect(onBallot).toBeNull();
          } else {
            expect(onBallot?.championReign).toBe(crown.next.reign);
            expect(onBallot?.displayText).toBe(crown.next.displayText);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it('keeps every human score within max_possible (§12 still holds)', () => {
    fc.assert(
      fc.property(...arbitraries, (humanCount, listLength, seed) => {
        const state = play(humanCount, listLength as ListLength, seed);
        const ceiling = maxPossibleForHuman(listLength as ListLength, humanCount, (r) =>
          multiplierForRound(listLength as ListLength, r),
        );
        for (const row of standings(state)) {
          if (row.isComputer) continue;
          expect(row.score).toBeLessThanOrEqual(ceiling);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('actually exercises champions, defenses, retirements and coin flips', () => {
    // Guards the properties above against passing vacuously.
    const seen = { champions: 0, defended: 0, retired: 0, coinFlips: 0, merged: 0 };
    for (let seed = 1; seed <= 120; seed++) {
      const listLength = LIST_LENGTHS[seed % 3];
      const state = play(2 + (seed % 3), listLength, seed);
      for (const m of state.game!.matchups) {
        const c = m.cards.find(isChampionCard);
        if (c) seen.champions += 1;
        if (c && c.ownerFavoriteIds.length > 1) seen.merged += 1;
      }
      for (const crown of crownHistory(state.game!, seed)) {
        if (crown.outcome === 'defended') seen.defended += 1;
        if (crown.outcome === 'coin_flip') seen.coinFlips += 1;
        if (crown.retired) seen.retired += 1;
      }
    }
    expect(seen.champions).toBeGreaterThan(100);
    expect(seen.defended).toBeGreaterThan(10);
    expect(seen.retired).toBeGreaterThan(0);
    expect(seen.coinFlips).toBeGreaterThan(10);
  });

  it('always reaches results', () => {
    fc.assert(
      fc.property(...arbitraries, (humanCount, listLength, seed) => {
        expect(play(humanCount, listLength as ListLength, seed).status).toBe('results');
      }),
      { numRuns: 30 },
    );
  });
});

describe('§3 choosing the mode', () => {
  const setup = () => {
    const { state } = simulateGame({ humanCount: 2, listLength: 5, seed: 3, mode: 'pick_and_fwd' });
    return apply(state, { type: 'play_again', actorId: state.hostPlayerId! }, { now: 1e9, seed: 1, newId: () => 'g2' });
  };

  it('pre-selects the previous game’s mode on Play Again', () => {
    const lobby = setup();
    if (!lobby.ok) throw new Error(lobby.error);
    const started = apply(lobby.state, { type: 'start_game', actorId: lobby.state.hostPlayerId! }, { now: 1e9, seed: 1, newId: () => 'g2' });
    expect(started.ok && started.state.game!.mode).toBe('pick_and_fwd');
  });

  it('lets only the host change the mode, and only during setup', () => {
    const lobby = setup();
    if (!lobby.ok) throw new Error(lobby.error);
    const host = lobby.state.hostPlayerId!;
    const other = lobby.state.players.find((p) => !p.isComputer && p.id !== host)!.id;
    expect(apply(lobby.state, { type: 'select_mode', actorId: host, mode: 'pick_your_fav' }, { now: 1e9, seed: 1, newId: () => 'x' }))
      .toMatchObject({ ok: false, error: 'wrong_phase' });
    const started = apply(lobby.state, { type: 'start_game', actorId: host }, { now: 1e9, seed: 1, newId: () => 'g2' });
    if (!started.ok) throw new Error(started.error);
    expect(apply(started.state, { type: 'select_mode', actorId: other, mode: 'pick_your_fav' }, { now: 1e9, seed: 1, newId: () => 'x' }))
      .toMatchObject({ ok: false, error: 'not_host' });
    const switched = apply(started.state, { type: 'select_mode', actorId: host, mode: 'pick_your_fav' }, { now: 1e9, seed: 1, newId: () => 'x' });
    expect(switched.ok && switched.state.game!.mode).toBe('pick_your_fav');
  });
});

describe('mutation-hardened rules (test gap review)', () => {
  it('seeds the coin flip from the round number, not the game seed alone', () => {
    // Same seed, same tie, different rounds: a flip that ignored the round
    // would resolve every tie in a game the same way.
    const outcomes = new Set<string>();
    for (let r = 1; r <= 30; r++) {
      const tied = { ...round({ u1: 'a', u2: 'b' }), roundNumber: r };
      outcomes.add(crownForRound(tied, favorites, null, 7, false).next!.displayText);
    }
    expect(outcomes).toEqual(new Set(['MANGO', 'KIWI']));
  });

  it('holds the reveal for 5s in Pick and fwd and 4s in Pick your fav', () => {
    for (const [mode, hold] of [['pick_and_fwd', 5_000], ['pick_your_fav', 4_000]] as const) {
      const { state } = simulateGame({ humanCount: 2, listLength: 5, seed: 9, mode });
      // Rewind to round 1's voting, then let everyone vote.
      const s = structuredClone(state);
      s.status = 'matchup_voting';
      s.game!.currentRound = 1;
      const m = s.game!.matchups[0];
      m.status = 'voting';
      m.votes = {};
      for (const p of s.players) p.lastSeenAt = 50_000;
      let next = s;
      for (const voter of ['p1', 'p2']) {
        const own = ownCardIds(m, voter, s.game!.favorites);
        const target = m.cards.find((c) => !own.includes(c.id))!;
        const result = apply(next, { type: 'cast_vote', playerId: voter, ballotCardId: target.id }, { now: 50_000, seed: 9, newId: () => 'x' });
        if (!result.ok) throw new Error(result.error);
        next = result.state;
      }
      expect(next.status).toBe('matchup_reveal');
      expect(next.phaseDeadline).toBe(50_000 + hold);
    }
  });
});
