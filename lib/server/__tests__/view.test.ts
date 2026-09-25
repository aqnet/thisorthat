/**
 * The per-viewer snapshot (§14.5): what one phone is allowed to see, plus the
 * reveal and results details built from the match-up record.
 */
import { describe, expect, it } from 'vitest';
import { leaderAfterEachRound, type SessionState } from '@/lib/engine';
import { simulateGame } from '@/lib/engine/__tests__/simulate';
import { buildSnapshot, categoryOption } from '../view';
import type { CategoryRow } from '../repo';

const categories: CategoryRow[] = [
  { id: 1, slug: 'fruit', name: 'Fruit', sizeClass: 'large', allowedLengths: [5, 10, 15], dictionarySize: 140 },
];

/** Rewind a finished game to the reveal of `round`, as the room would show it then. */
function atReveal(state: SessionState, round: number): SessionState {
  const copy = structuredClone(state);
  copy.status = 'matchup_reveal';
  copy.game!.currentRound = round;
  for (const m of copy.game!.matchups) {
    if (m.roundNumber > round) {
      m.status = 'pending';
      m.votes = {};
    }
  }
  return copy;
}

describe('§7 category size classes', () => {
  const category = (dictionarySize: number): CategoryRow => ({
    id: 9, slug: 'x', name: 'X', sizeClass: 'large', allowedLengths: [5, 10, 15], dictionarySize,
  });

  it('offers every length when the dictionary meets its size class', () => {
    expect(categoryOption(category(113))?.allowedLengths).toEqual([5, 10, 15]);
  });

  it('caps a short dictionary at the next size down', () => {
    expect(categoryOption(category(112))?.allowedLengths).toEqual([5, 10]);
    expect(categoryOption(category(74))?.allowedLengths).toEqual([5]);
  });

  it('hides a category too small for even the smallest class', () => {
    expect(categoryOption(category(37))).toBeNull();
  });
});

describe('§14.5 hidden information in the snapshot', () => {
  it('hides card owners and counts while voting, and shows them after reveal', () => {
    const { state } = simulateGame({ humanCount: 3, listLength: 5, seed: 21 });
    const voting = atReveal(state, 1);
    voting.status = 'matchup_voting';
    voting.game!.matchups[0].status = 'voting';
    const during = buildSnapshot(voting, 'u-p2', categories, 0).game!;
    expect(during.cards.every((c) => c.ownerIds === null && c.votes === null)).toBe(true);
    // The viewer knows which card is theirs, and only that one.
    expect(during.cards.filter((c) => c.mine)).toHaveLength(1);

    const after = buildSnapshot(atReveal(state, 1), 'u-p2', categories, 0).game!;
    expect(after.cards.every((c) => c.ownerIds !== null && c.votes !== null)).toBe(true);
  });

  it('shows your own vote, and never anyone else’s', () => {
    const { state } = simulateGame({ humanCount: 3, listLength: 5, seed: 21 });
    const snap = buildSnapshot(atReveal(state, 1), 'u-p2', categories, 0);
    const matchup = state.game!.matchups[0];
    expect(snap.game!.myVote).toBe(matchup.votes.p2);
    const json = JSON.stringify(snap);
    for (const [voter, card] of Object.entries(matchup.votes)) {
      if (voter !== 'p2') expect(json).not.toContain(`"${voter}":"${card}"`);
    }
  });
});

describe('§9.5.8 lead-change callout', () => {
  it('names the new leader on the reveal where the lead changed, and only then', () => {
    let found = false;
    for (let seed = 1; seed < 200 && !found; seed++) {
      const { state } = simulateGame({ humanCount: 3, listLength: 10, seed });
      const leaders = leaderAfterEachRound(state);
      for (let round = 2; round <= leaders.length; round++) {
        const [previous, latest] = [leaders[round - 2], leaders[round - 1]];
        const snap = buildSnapshot(atReveal(state, round), 'u-p1', categories, 0);
        if (latest && latest !== previous) {
          expect(snap.game!.leadChange).toBe(latest);
          found = true;
        } else {
          expect(snap.game!.leadChange).toBeNull();
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe('§10 results', () => {
  it('computes the fun stats, Taste Twins included', () => {
    const { state } = simulateGame({ humanCount: 3, listLength: 10, seed: 4 });
    const results = buildSnapshot(state, 'u-p1', categories, 0).game!.results!;
    const labels = results.funStats.map((s) => s.label);
    expect(labels).toContain('Crowd Favorite');
    expect(labels).toContain('Taste Twins');
    expect(results.funStats.every((s) => s.detail.length > 0)).toBe(true);
  });

  it('marks a finished game with a winner, and no results before the end', () => {
    const { state } = simulateGame({ humanCount: 2, listLength: 5, seed: 8 });
    expect(buildSnapshot(state, 'u-p1', categories, 0).game!.results).not.toBeNull();
    expect(buildSnapshot(atReveal(state, 3), 'u-p1', categories, 0).game!.results).toBeNull();
  });
});
