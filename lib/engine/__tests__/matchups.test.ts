import { describe, it, expect } from 'vitest';
import { buildMatchups, ownCardId } from '../matchups';
import { createRng } from '../rng';
import { favorite } from './fixtures';
import { multiplierForRound, type ListLength } from '../constants';
import type { Favorite } from '../types';

const listFor = (playerId: string, items: string[]): Favorite[] =>
  items.map((text, i) => favorite(`${playerId}-${i}`, playerId, text, i + 1));

const build = (lists: Record<string, string[]>, seed = 42) => {
  const playerIds = Object.keys(lists);
  const favorites = playerIds.flatMap((id) => listFor(id, lists[id]));
  let counter = 0;
  return buildMatchups({
    gameId: 'g1',
    listLength: lists[playerIds[0]].length as 5,
    playerIds,
    favorites,
    rng: createRng(seed),
    newId: () => `id-${counter++}`,
  });
};

describe('§9.2 building match-ups', () => {
  it('produces exactly N match-ups for a list length of N', () => {
    const { matchups } = build({
      ana: ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear'],
      ben: ['Apple', 'Grape', 'Melon', 'Peach', 'Cherry'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    });
    expect(matchups).toHaveLength(5);
    expect(matchups.map((m) => m.roundNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('puts one card per list in every match-up when nothing collides', () => {
    const { matchups } = build({
      ana: ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear'],
      ben: ['Apple', 'Grape', 'Melon', 'Peach', 'Cherry'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    });
    for (const m of matchups) expect(m.cards).toHaveLength(3);
  });

  it('uses every item exactly once across the game', () => {
    const { matchups } = build({
      ana: ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear'],
      ben: ['Apple', 'Grape', 'Melon', 'Peach', 'Cherry'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    });
    const owners = matchups.flatMap((m) => m.cards.flatMap((c) => c.ownerFavoriteIds));
    expect(new Set(owners).size).toBe(15);
  });

  it('shows ballot text in ALL CAPS', () => {
    const { matchups } = build({
      ana: ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear'],
      ben: ['Apple', 'Grape', 'Melon', 'Peach', 'Cherry'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    });
    for (const m of matchups) {
      for (const c of m.cards) expect(c.displayText).toBe(c.displayText.toUpperCase());
    }
  });

  it('applies the Final Showdown multiplier to the right rounds', () => {
    const { matchups } = build({
      ana: ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear'],
      ben: ['Apple', 'Grape', 'Melon', 'Peach', 'Cherry'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    });
    expect(matchups.map((m) => m.multiplier)).toEqual([1, 1, 1, 1, 2]);
  });

  it('separates a collision by swapping within one list', () => {
    // Ana and Ben share Mango. It should be moved apart, not merged.
    const { matchups, sharedCardRounds } = build({
      ana: ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear'],
      ben: ['Mango', 'Grape', 'Melon', 'Peach', 'Cherry'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    });
    expect(sharedCardRounds).toEqual([]);
    for (const m of matchups) expect(m.cards).toHaveLength(3);
  });

  it('falls back to one shared card when a duplicate cannot be separated', () => {
    // Both lists are entirely Mango, so no swap can help.
    const { matchups, sharedCardRounds } = build({
      ana: ['Mango', 'Mango', 'Mango', 'Mango', 'Mango'],
      ben: ['Mango', 'Mango', 'Mango', 'Mango', 'Mango'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    });
    expect(sharedCardRounds).toHaveLength(5);
    for (const m of matchups) {
      expect(m.cards).toHaveLength(2);
      const shared = m.cards.find((c) => c.ownerFavoriteIds.length === 2);
      expect(shared).toBeDefined();
    }
  });

  it('treats the same canonical item as a duplicate even when the text differs', () => {
    // Every slot is the same canonical item under different names, so no swap
    // can separate them and each round must collapse to one shared card.
    const alias = (id: string, player: string, text: string, pos: number): Favorite => ({
      ...favorite(id, player, text, pos),
      canonicalItemId: 7,
    });
    const favorites: Favorite[] = [
      ...['NYC', 'N.Y.C.', 'New York', 'Big Apple', 'NY City'].map((t, i) =>
        alias(`a-${i}`, 'ana', t, i + 1)),
      ...['New York City', 'NYC', 'N Y C', 'New York', 'NY'].map((t, i) =>
        alias(`b-${i}`, 'ben', t, i + 1)),
    ];
    let n = 0;
    const { matchups } = buildMatchups({
      gameId: 'g', listLength: 5, playerIds: ['ana', 'ben'], favorites,
      rng: createRng(1), newId: () => `id-${n++}`,
    });
    for (const m of matchups) {
      expect(m.cards).toHaveLength(1);
      expect(m.cards[0].ownerFavoriteIds).toHaveLength(2);
    }
  });

  it('scores an unknown list length as a normal round instead of crashing', () => {
    expect(multiplierForRound(7 as ListLength, 7)).toBe(1);
  });

  it('is deterministic for a given seed, so games can be replayed', () => {
    const lists = {
      ana: ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear'],
      ben: ['Apple', 'Grape', 'Melon', 'Peach', 'Cherry'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    };
    const a = build(lists, 99);
    const b = build(lists, 99);
    expect(JSON.stringify(a.matchups)).toBe(JSON.stringify(b.matchups));
  });

  it('rejects a list of the wrong length rather than building a broken game', () => {
    expect(() =>
      buildMatchups({
        gameId: 'g', listLength: 5, playerIds: ['ana'],
        favorites: listFor('ana', ['Mango']), rng: createRng(1), newId: () => 'x',
      }),
    ).toThrow(/expected 5/);
  });
});

describe('§9.4 own card', () => {
  it('finds the card a player owns, so the UI can disable it', () => {
    const { matchups } = build({
      ana: ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear'],
      ben: ['Apple', 'Grape', 'Melon', 'Peach', 'Cherry'],
      cpu: ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya'],
    });
    const favorites = ['ana', 'ben', 'cpu'].flatMap((id) =>
      listFor(id, id === 'ana'
        ? ['Mango', 'Kiwi', 'Plum', 'Fig', 'Pear']
        : id === 'ben'
          ? ['Apple', 'Grape', 'Melon', 'Peach', 'Cherry']
          : ['Banana', 'Lemon', 'Lime', 'Guava', 'Papaya']),
    );
    for (const m of matchups) {
      expect(ownCardId(m, 'ana', favorites)).not.toBeNull();
    }
  });
});
