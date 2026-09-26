/** Remembering the player's name once they've played a game through. */
import { afterEach, describe, expect, it } from 'vitest';
import { nameToRemember, rememberName, rememberedName } from '../playerName';
import type { RoomSnapshot } from '@/lib/game/snapshot';

function snapshot(overrides: Partial<RoomSnapshot> & { me?: RoomSnapshot['me'] } = {}): RoomSnapshot {
  return {
    version: 1, serverNow: 0, roomCode: 'KZPW', status: 'results', phaseDeadline: null,
    pausedFrom: null, hostPlayerId: 'p1', relaxedTimers: false, computerPlayer: true, computerPlays: true,
    categories: [], game: null,
    me: { playerId: 'p2', isHost: false, queued: false, left: false },
    players: [
      { id: 'p1', name: 'Ana', colorSlot: 1, isComputer: false, isHost: true, queued: false, left: false, connected: true },
      { id: 'p2', name: 'Ben', colorSlot: 2, isComputer: false, isHost: false, queued: false, left: false, connected: true },
    ],
    ...overrides,
  };
}

describe('nameToRemember', () => {
  it('is the viewer’s own name once they reach the results', () => {
    expect(nameToRemember(snapshot())).toBe('Ben');
  });

  it('is the host’s name for the host', () => {
    expect(nameToRemember(snapshot({ me: { playerId: 'p1', isHost: true, queued: false, left: false } }))).toBe('Ana');
  });

  it('is nothing before the results', () => {
    for (const status of ['lobby', 'entering', 'matchup_voting', 'matchup_reveal'] as const) {
      expect(nameToRemember(snapshot({ status }))).toBeUndefined();
    }
  });

  it('is nothing for a queued joiner, who only watched', () => {
    expect(nameToRemember(snapshot({ me: { playerId: 'p2', isHost: false, queued: true, left: false } }))).toBeUndefined();
  });

  it('is nothing for a player who left before the end', () => {
    expect(nameToRemember(snapshot({ me: { playerId: 'p2', isHost: false, queued: false, left: true } }))).toBeUndefined();
  });

  it('is nothing without a seat or a snapshot', () => {
    expect(nameToRemember(snapshot({ me: null }))).toBeUndefined();
    expect(nameToRemember(null)).toBeUndefined();
  });
});

describe('storage', () => {
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => {
    delete g.window;
  });

  it('round-trips the name through localStorage', () => {
    const store = new Map<string, string>();
    g.window = {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    };
    expect(rememberedName()).toBe('');
    rememberName('Ana');
    expect(rememberedName()).toBe('Ana');
  });

  it('copes with blocked storage (private browsing) instead of breaking the page', () => {
    g.window = {
      localStorage: {
        getItem: () => { throw new Error('SecurityError'); },
        setItem: () => { throw new Error('QuotaExceededError'); },
      },
    };
    expect(() => rememberName('Ana')).not.toThrow();
    expect(rememberedName()).toBe('');
  });
});
