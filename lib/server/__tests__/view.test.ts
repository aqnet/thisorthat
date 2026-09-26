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

describe('Pick and fwd in the snapshot (mode spec §4.3-§6)', () => {
  const always = (pick: 'champion' | 'first') => ({
    mode: 'pick_and_fwd' as const,
    chooseCard: ({ options }: { options: { id: string; championReign?: number | null }[] }) =>
      (pick === 'champion' ? options.find((c) => c.championReign != null) : undefined)?.id ?? options[0].id,
  });

  it('calls out a defended crown, then a retirement at reign 3', () => {
    // Backing the champion every time keeps it until it retires.
    const { state } = simulateGame({ humanCount: 3, listLength: 10, seed: 12, ...always('champion') });
    const kinds: string[] = [];
    for (let round = 1; round <= 10; round++) {
      const crown = buildSnapshot(atReveal(state, round), 'u-p1', categories, 0, 12).game!.crown;
      if (crown) kinds.push(crown.kind);
    }
    expect(kinds).toContain('defended');
    expect(kinds).toContain('retired');
  });

  it('marks the champion card, with its reign and public owner, pinned first', () => {
    const { state } = simulateGame({ humanCount: 3, listLength: 5, seed: 12, ...always('champion') });
    const voting = atReveal(state, 2);
    voting.status = 'matchup_voting';
    voting.game!.matchups[1].status = 'voting';
    const cards = buildSnapshot(voting, 'u-p1', categories, 0, 12).game!.cards;
    expect(cards[0].champion?.reign).toBeGreaterThanOrEqual(1);
    expect(cards[0].champion?.ownerIds.length).toBeGreaterThan(0);
    expect(cards.slice(1).every((c) => c.champion === null)).toBe(true);
  });

  it('adds Longest Reign to the results', () => {
    const { state } = simulateGame({ humanCount: 3, listLength: 10, seed: 12, ...always('champion') });
    const labels = buildSnapshot(state, 'u-p1', categories, 0, 12).game!.results!.funStats.map((s) => s.label);
    expect(labels).toContain('Longest Reign');
  });

  it('adds nothing for Pick your fav', () => {
    const { state } = simulateGame({ humanCount: 3, listLength: 10, seed: 12 });
    const game = buildSnapshot(atReveal(state, 3), 'u-p1', categories, 0, 12).game!;
    expect(game.crown).toBeNull();
    expect(game.cards.every((c) => c.champion === null)).toBe(true);
  });
});

describe('mutation-hardened snapshot rules (test gap review)', () => {
  /**
   * A Pick and fwd game at round 2's voting, with a fresh round-2 card merged
   * into the champion -- as happens when another player dealt the champion's
   * twin into this round (mode spec §4.1).
   */
  function mergedAtRound2() {
    const { state } = simulateGame({ humanCount: 3, listLength: 5, seed: 12, mode: 'pick_and_fwd' });
    const s = atReveal(state, 2);
    s.status = 'matchup_voting';
    const m = s.game!.matchups[1];
    m.status = 'voting';
    m.votes = {};
    const champion = m.cards.find((c) => c.championReign != null)!;
    const championOwners = new Set(
      champion.ownerFavoriteIds.map((id) => s.game!.favorites.find((f) => f.id === id)!.playerId),
    );
    // Merge in a fresh card from a player who doesn't already own the champion.
    const fresh = m.cards.find((c) => {
      if (c === champion) return false;
      const owner = s.game!.favorites.find((f) => f.id === c.ownerFavoriteIds[0])!.playerId;
      return !championOwners.has(owner) && owner !== 'cpu';
    })!;
    const mergedOwner = s.game!.favorites.find((f) => f.id === fresh.ownerFavoriteIds[0])!.playerId;
    champion.ownerFavoriteIds = [...champion.ownerFavoriteIds, ...fresh.ownerFavoriteIds];
    m.cards = m.cards.filter((c) => c !== fresh);
    return { s, m, championOwners, mergedOwner };
  }

  it('hides a merged-in owner of the champion until the reveal (§4.3)', () => {
    const { s, championOwners, mergedOwner } = mergedAtRound2();
    const viewer = ['p1', 'p2', 'p3'].find((p) => p !== mergedOwner)!;
    const card = buildSnapshot(s, `u-${viewer}`, categories, 0, 12).game!.cards.find((c) => c.champion)!;
    expect(new Set(card.champion!.ownerIds)).toEqual(championOwners);
    expect(card.champion!.ownerIds).not.toContain(mergedOwner);
    // The merged-in owner sees "Yours" on their own phone.
    const theirs = buildSnapshot(s, `u-${mergedOwner}`, categories, 0, 12).game!.cards.find((c) => c.champion)!;
    expect(theirs.mine).toBe(true);
  });

  it('shows every owner of the champion once the round is revealed', () => {
    const { s, m, mergedOwner } = mergedAtRound2();
    s.status = 'matchup_reveal';
    m.status = 'revealed';
    const card = buildSnapshot(s, 'u-p1', categories, 0, 12).game!.cards.find((c) => c.champion)!;
    expect(card.champion!.ownerIds).toContain(mergedOwner);
  });

  it('reports a Giant Slayer when a long reign is broken', () => {
    let found: string | undefined;
    for (let seed = 1; seed <= 400 && !found; seed++) {
      const { state } = simulateGame({
        humanCount: 3, listLength: 10, seed, mode: 'pick_and_fwd',
        chooseCard: ({ options, rng }) => options[rng.int(options.length)].id,
      });
      found = buildSnapshot(state, 'u-p1', categories, 0, seed).game!.results!.funStats
        .find((s) => s.label === 'Giant Slayer')?.detail;
    }
    expect(found).toMatch(/ended .+'s reign$/);
  });
});
