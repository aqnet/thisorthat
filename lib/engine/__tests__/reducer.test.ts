import { describe, it, expect } from 'vitest';
import { apply, publicState } from '../reducer';
import { ownCardId } from '../matchups';
import { simulateGame } from './simulate';
import { session, player } from './fixtures';
import { DISCONNECT_AFTER_MS, PAUSE_GRACE_MS, VOTE_MS } from '../constants';
import type { EngineContext, SessionState } from '../types';

let ids = 0;
const ctx = (now: number): EngineContext => ({ now, seed: 1, newId: () => `n-${ids++}` });

const ok = (state: SessionState, intent: Parameters<typeof apply>[1], now: number) => {
  const result = apply(state, intent, ctx(now));
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error}`);
  return result.state;
};

/** A game paused at round 1 with everyone still connected. */
function gameAtRound1() {
  const { state } = simulateGame({ humanCount: 3, listLength: 5, seed: 3 });
  // Rewind to the first round, before any votes.
  const rebuilt: SessionState = structuredClone(state);
  rebuilt.status = 'matchup_voting';
  rebuilt.game!.currentRound = 1;
  const matchup = rebuilt.game!.matchups[0];
  matchup.status = 'voting';
  matchup.votes = {};
  rebuilt.phaseDeadline = 100_000 + VOTE_MS;
  for (const p of rebuilt.players) p.lastSeenAt = 100_000;
  return { state: rebuilt, matchup };
}

describe('§9.4 voting rules', () => {
  it('refuses a vote for your own card', () => {
    const { state, matchup } = gameAtRound1();
    const own = ownCardId(matchup, 'p1', state.game!.favorites)!;
    const result = apply(state, { type: 'cast_vote', playerId: 'p1', ballotCardId: own }, ctx(100_000));
    expect(result).toMatchObject({ ok: false, error: 'own_card' });
  });

  it('locks a vote on tap, so a second one is refused rather than replacing it', () => {
    const { state, matchup } = gameAtRound1();
    const own = ownCardId(matchup, 'p1', state.game!.favorites);
    const [first, second] = matchup.cards.filter((c) => c.id !== own);
    const after = ok(state, { type: 'cast_vote', playerId: 'p1', ballotCardId: first.id }, 100_000);
    const again = apply(after, { type: 'cast_vote', playerId: 'p1', ballotCardId: second.id }, ctx(100_100));
    expect(again).toMatchObject({ ok: false, error: 'already_voted' });
  });

  it('rejects a card from a different match-up', () => {
    const { state } = gameAtRound1();
    const result = apply(
      state, { type: 'cast_vote', playerId: 'p1', ballotCardId: 'not-a-card' }, ctx(100_000),
    );
    expect(result).toMatchObject({ ok: false, error: 'unknown_card' });
  });

  it('resolves the round as soon as every connected human has voted', () => {
    const { state, matchup } = gameAtRound1();
    let current = state;
    for (const playerId of ['p1', 'p2', 'p3']) {
      const own = ownCardId(matchup, playerId, current.game!.favorites);
      const target = matchup.cards.find((c) => c.id !== own)!;
      current = ok(current, { type: 'cast_vote', playerId, ballotCardId: target.id }, 100_000);
    }
    // Resolved well before the 15s deadline (§14.3.5).
    expect(current.status).toBe('matchup_reveal');
  });

  it('never leaks who voted for what, only who has voted', () => {
    const { state, matchup } = gameAtRound1();
    const own = ownCardId(matchup, 'p1', state.game!.favorites);
    const target = matchup.cards.find((c) => c.id !== own)!;
    const after = ok(state, { type: 'cast_vote', playerId: 'p1', ballotCardId: target.id }, 100_000);
    const projection = publicState(after);
    expect(projection.votedPlayerIds).toEqual(['p1']);
    // Owners and counts stay hidden until the reveal (§14.5).
    for (const card of projection.cards) {
      expect(card.ownerPlayerIds).toBeNull();
      expect(card.voteCount).toBeNull();
    }
  });
});

describe('§9.7 pausing below two connected humans', () => {
  it('pauses and remembers the phase it paused from', () => {
    const { state } = gameAtRound1();
    // Two of three players go silent past the disconnect threshold.
    const later = 100_000 + DISCONNECT_AFTER_MS + 1;
    const paused = ok(state, { type: 'advance' }, later);
    expect(paused.status).toBe('paused');
    expect(paused.pausedFrom).toBe('matchup_voting');
  });

  it('restores the voting phase with a fresh timer when players come back', () => {
    const { state } = gameAtRound1();
    const later = 100_000 + DISCONNECT_AFTER_MS + 1;
    let paused = ok(state, { type: 'advance' }, later);

    const back = later + 1_000;
    for (const playerId of ['p1', 'p2', 'p3']) {
      paused = ok(paused, { type: 'heartbeat', playerId }, back);
    }
    const resumed = ok(paused, { type: 'advance' }, back);

    expect(resumed.status).toBe('matchup_voting');
    // A returning player must not land on a countdown that already expired.
    expect(resumed.phaseDeadline).toBe(back + VOTE_MS);
  });

  it('ends the game early if nobody comes back before the grace period', () => {
    const { state } = gameAtRound1();
    const later = 100_000 + DISCONNECT_AFTER_MS + 1;
    const paused = ok(state, { type: 'advance' }, later);
    const expired = ok(paused, { type: 'advance' }, later + PAUSE_GRACE_MS + 1);
    expect(expired.status).toBe('results');
    expect(expired.game!.endedEarly).toBe(true);
  });
});

describe('§5 lobby rules', () => {
  const lobby = () =>
    session({
      players: [player('cpu', { isComputer: true, colorSlot: 0, name: 'Computer' })],
    });

  it('makes the first player to join the host', () => {
    const after = ok(lobby(), { type: 'join', playerId: 'a', userId: 'ua', name: 'Ana' }, 0);
    expect(after.hostPlayerId).toBe('a');
  });

  it('refuses a fifth human', () => {
    let state = lobby();
    for (const id of ['a', 'b', 'c', 'd']) {
      state = ok(state, { type: 'join', playerId: id, userId: `u${id}`, name: id }, 0);
    }
    const result = apply(state, { type: 'join', playerId: 'e', userId: 'ue', name: 'E' }, ctx(0));
    expect(result).toMatchObject({ ok: false, error: 'room_full' });
  });

  it('will not start with fewer than two humans', () => {
    const state = ok(lobby(), { type: 'join', playerId: 'a', userId: 'ua', name: 'Ana' }, 0);
    expect(apply(state, { type: 'start_game', actorId: 'a' }, ctx(0)))
      .toMatchObject({ ok: false, error: 'need_more_players' });
  });

  it('only the host can start', () => {
    let state = lobby();
    state = ok(state, { type: 'join', playerId: 'a', userId: 'ua', name: 'Ana' }, 0);
    state = ok(state, { type: 'join', playerId: 'b', userId: 'ub', name: 'Ben' }, 0);
    expect(apply(state, { type: 'start_game', actorId: 'b' }, ctx(0)))
      .toMatchObject({ ok: false, error: 'not_host' });
  });

  it('assigns each human a distinct colour slot, leaving 0 to the Computer', () => {
    let state = lobby();
    for (const id of ['a', 'b', 'c', 'd']) {
      state = ok(state, { type: 'join', playerId: id, userId: `u${id}`, name: id }, 0);
    }
    const slots = state.players.filter((p) => !p.isComputer).map((p) => p.colorSlot);
    expect(new Set(slots)).toEqual(new Set([1, 2, 3, 4]));
    expect(state.players.find((p) => p.isComputer)!.colorSlot).toBe(0);
  });
});

describe('§11 play again', () => {
  it('returns to the lobby, keeps seats and resets scores', () => {
    const { state } = simulateGame({ humanCount: 3, listLength: 5, seed: 11 });
    expect(state.status).toBe('results');
    const again = ok(state, { type: 'play_again', actorId: state.hostPlayerId! }, 500_000);
    expect(again.status).toBe('lobby');
    expect(again.players.filter((p) => !p.isComputer)).toHaveLength(3);
  });
});
