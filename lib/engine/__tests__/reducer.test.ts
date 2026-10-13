import { describe, it, expect } from 'vitest';
import { apply, publicState } from '../reducer';
import { ownCardId } from '../matchups';
import { simulateGame } from './simulate';
import { everyBallotHadThree, roundCount, standings } from '../scoring';
import { session, player } from './fixtures';
import {
  DEPART_AFTER_MS,
  DISCONNECT_AFTER_MS,
  ENTRY_MS_BY_LENGTH,
  PAUSE_GRACE_MS,
  REVEAL_HOLD_MS,
  ROOM_IDLE_EXPIRY_MS,
  SETUP_HOLD_MS,
  HOST_SETUP_MS,
  VOTE_MS,
} from '../constants';
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

describe('§5 / §11 closing the room', () => {
  const lobby = () =>
    session({
      hostPlayerId: 'p1',
      players: [player('p1', { isHost: true }), player('p2', { colorSlot: 2 })],
    });

  it('lets the host close the room from any phase', () => {
    const closed = ok(lobby(), { type: 'close_room', actorId: 'p1' }, 1_000);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toBe(1_000);
    expect(closed.phaseDeadline).toBeNull();
  });

  it('refuses anyone but the host', () => {
    const result = apply(lobby(), { type: 'close_room', actorId: 'p2' }, ctx(1_000));
    expect(result).toMatchObject({ ok: false, error: 'not_host' });
  });

  it('refuses every intent once the room is closed', () => {
    const closed = ok(lobby(), { type: 'close_room', actorId: 'p1' }, 1_000);
    const result = apply(closed, { type: 'start_game', actorId: 'p1' }, ctx(2_000));
    expect(result).toMatchObject({ ok: false, error: 'room_closed' });
  });
});

describe('§5 lobby settings', () => {
  const lobby = () =>
    session({
      hostPlayerId: 'p1',
      players: [player('p1', { isHost: true }), player('p2', { colorSlot: 2 })],
    });

  it('lets the host turn on relaxed timers in the lobby', () => {
    const next = ok(lobby(), { type: 'update_settings', actorId: 'p1', relaxedTimers: true }, 1_000);
    expect(next.relaxedTimers).toBe(true);
  });

  it('refuses non-hosts, and refuses once the game has started', () => {
    expect(apply(lobby(), { type: 'update_settings', actorId: 'p2', relaxedTimers: true }, ctx(1)))
      .toMatchObject({ ok: false, error: 'not_host' });
    const started = ok(lobby(), { type: 'start_game', actorId: 'p1' }, 1_000);
    expect(apply(started, { type: 'update_settings', actorId: 'p1', relaxedTimers: true }, ctx(2_000)))
      .toMatchObject({ ok: false, error: 'wrong_phase' });
  });
});

/** A lobby with a host (p1), two more humans and the Computer, all heart-beating at `now`. */
function lobbyOf3(now = 1_000) {
  return session({
    hostPlayerId: 'p1',
    lastActivityAt: now,
    players: [
      player('cpu', { isComputer: true, colorSlot: 0, name: 'Computer', userId: null, lastSeenAt: now }),
      player('p1', { isHost: true, colorSlot: 1, joinedAt: 1, lastSeenAt: now }),
      player('p2', { colorSlot: 2, joinedAt: 2, lastSeenAt: now }),
      player('p3', { colorSlot: 3, joinedAt: 3, lastSeenAt: now }),
    ],
  });
}

describe('§5 removing a player', () => {
  it('lets the host remove a player in the lobby, freeing the seat', () => {
    const next = ok(lobbyOf3(), { type: 'remove_player', actorId: 'p1', targetPlayerId: 'p2' }, 2_000);
    const removed = next.players.find((p) => p.id === 'p2')!;
    expect(removed.leftAt).toBe(2_000);
    expect(removed.colorSlot).toBeNull();
  });

  it('refuses non-hosts, the Computer as a target, and removal mid-game', () => {
    expect(apply(lobbyOf3(), { type: 'remove_player', actorId: 'p2', targetPlayerId: 'p3' }, ctx(2_000)))
      .toMatchObject({ ok: false, error: 'not_host' });
    expect(apply(lobbyOf3(), { type: 'remove_player', actorId: 'p1', targetPlayerId: 'cpu' }, ctx(2_000)))
      .toMatchObject({ ok: false, error: 'unknown_player' });
    const started = ok(lobbyOf3(), { type: 'start_game', actorId: 'p1' }, 2_000);
    expect(apply(started, { type: 'remove_player', actorId: 'p1', targetPlayerId: 'p2' }, ctx(3_000)))
      .toMatchObject({ ok: false, error: 'wrong_phase' });
  });
});

describe('§6 host transfer', () => {
  it('passes the host role to the longest-seated connected player when the host leaves', () => {
    const next = ok(lobbyOf3(), { type: 'leave', playerId: 'p1' }, 2_000);
    expect(next.hostPlayerId).toBe('p2');
    expect(next.players.find((p) => p.id === 'p2')!.isHost).toBe(true);
    expect(next.players.find((p) => p.id === 'p1')!.isHost).toBe(false);
  });

  it('skips a disconnected player when choosing the new host', () => {
    let state = lobbyOf3(1_000);
    state = { ...state, players: state.players.map((p) => (p.id === 'p2' ? { ...p, lastSeenAt: 0 } : p)) };
    const next = ok(state, { type: 'leave', playerId: 'p1' }, DISCONNECT_AFTER_MS + 500);
    expect(next.hostPlayerId).toBe('p3');
  });

  it('transfers the host when the host departs after 60s of silence', () => {
    const started = ok(lobbyOf3(), { type: 'start_game', actorId: 'p1' }, 1_000);
    // p2 and p3 keep heart-beating; the host goes quiet past DEPART_AFTER_MS.
    let state = started;
    const later = 1_000 + DEPART_AFTER_MS + 1;
    for (const id of ['p2', 'p3']) state = ok(state, { type: 'heartbeat', playerId: id }, later);
    const next = ok(state, { type: 'advance' }, later);
    expect(next.players.find((p) => p.id === 'p1')!.leftAt).toBe(later);
    expect(next.hostPlayerId).toBe('p2');
  });
});

describe('§6 rejoining a seat', () => {
  it('lets a new device take over a disconnected seat', () => {
    let state = lobbyOf3();
    state = { ...state, players: state.players.map((p) => (p.id === 'p2' ? { ...p, disconnectedAt: 500 } : p)) };
    const next = ok(state, { type: 'rejoin_seat', playerId: 'p2', userId: 'new-phone' }, 2_000);
    const seat = next.players.find((p) => p.id === 'p2')!;
    expect(seat.userId).toBe('new-phone');
    expect(seat.disconnectedAt).toBeNull();
    expect(seat.lastSeenAt).toBe(2_000);
  });

  it('brings a departed player back, so they vote from the next match-up (§9.7)', () => {
    const left = ok(lobbyOf3(), { type: 'leave', playerId: 'p3' }, 2_000);
    const back = ok(left, { type: 'rejoin_seat', playerId: 'p3', userId: 'user-p3' }, 3_000);
    expect(back.players.find((p) => p.id === 'p3')!.leftAt).toBeNull();
  });

  it('refuses to hand over a seat whose owner is still connected', () => {
    expect(apply(lobbyOf3(), { type: 'rejoin_seat', playerId: 'p2', userId: 'thief' }, ctx(2_000)))
      .toMatchObject({ ok: false, error: 'not_seated' });
  });
});

describe('§14.3 advancing on the server clock', () => {
  it('resolves a round when the only missing voter has disconnected', () => {
    const { state, matchup } = gameAtRound1();
    const now = 100_000 + DISCONNECT_AFTER_MS + 1;
    let next = state;
    // p1 and p2 are still heart-beating; p3 has gone quiet.
    for (const id of ['p1', 'p2']) next = ok(next, { type: 'heartbeat', playerId: id }, now);
    for (const voter of ['p1', 'p2']) {
      const card = matchup.cards.find((c) => c.id !== ownCardId(matchup, voter, state.game!.favorites))!;
      next = ok(next, { type: 'cast_vote', playerId: voter, ballotCardId: card.id }, now);
    }
    // The vote itself resolves the round: p3 is no longer waited on.
    expect(next.status).toBe('matchup_reveal');
    const advanced = ok(next, { type: 'advance' }, now);
    // The dispatcher's advance then records the disconnect.
    expect(advanced.players.find((p) => p.id === 'p3')!.disconnectedAt).toBe(now);
  });

  it('moves on from the reveal when its hold runs out, without the host', () => {
    const { state } = gameAtRound1();
    const now = 100_000;
    let next = state;
    const matchup = state.game!.matchups[0];
    for (const voter of ['p1', 'p2', 'p3']) {
      const card = matchup.cards.find((c) => c.id !== ownCardId(matchup, voter, state.game!.favorites))!;
      next = ok(next, { type: 'cast_vote', playerId: voter, ballotCardId: card.id }, now);
    }
    expect(next.status).toBe('matchup_reveal');
    const early = apply(next, { type: 'advance' }, ctx(now + REVEAL_HOLD_MS - 1));
    expect(early.ok && early.state.status).toBe('matchup_reveal');
    const moved = ok(next, { type: 'advance' }, now + REVEAL_HOLD_MS);
    expect(moved.status).toBe('matchup_voting');
    expect(moved.game!.currentRound).toBe(2);
  });

  it('closes a room idle for 2 hours', () => {
    const lobby = lobbyOf3(1_000);
    const closed = ok(lobby, { type: 'advance' }, 1_000 + ROOM_IDLE_EXPIRY_MS);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toBe(1_000 + ROOM_IDLE_EXPIRY_MS);
  });

  it('resumes entry with a fresh entry timer after a pause', () => {
    let state = ok(lobbyOf3(), { type: 'start_game', actorId: 'p1' }, 1_000);
    state = ok(state, { type: 'confirm_setup', actorId: 'p1', categoryId: 1, listLength: 5 }, 1_000);
    const quiet = 1_000 + DISCONNECT_AFTER_MS + 1;
    state = ok(state, { type: 'heartbeat', playerId: 'p1' }, quiet);
    const paused = ok(state, { type: 'advance' }, quiet);
    expect(paused.status).toBe('paused');
    expect(paused.pausedFrom).toBe('entering');

    const back = quiet + 5_000;
    let returning = paused;
    for (const id of ['p1', 'p2', 'p3']) returning = ok(returning, { type: 'heartbeat', playerId: id }, back);
    const resumed = ok(returning, { type: 'advance' }, back);
    expect(resumed.status).toBe('entering');
    expect(resumed.phaseDeadline).toBe(back + ENTRY_MS_BY_LENGTH[5]);
  });
});

describe('§8 edit after submit', () => {
  const entering = () => {
    let state = ok(lobbyOf3(), { type: 'start_game', actorId: 'p1' }, 1_000);
    state = ok(state, { type: 'confirm_setup', actorId: 'p1', categoryId: 1, listLength: 5 }, 1_000);
    for (let i = 1; i <= 5; i++) {
      state = ok(state, {
        type: 'add_item', playerId: 'p1',
        favorite: {
          id: `f${i}`, playerId: 'p1', entryPosition: i, displayText: `Item ${i}`, ballotText: `ITEM ${i}`,
          canonicalItemId: null, autoPicked: false, surprisePicked: false, shuffledPosition: null,
        },
      }, 1_000);
    }
    return ok(state, { type: 'submit_list', playerId: 'p1' }, 1_000);
  };

  it('reopens a submitted list with Edit', () => {
    const edited = ok(entering(), { type: 'edit_list', playerId: 'p1' }, 2_000);
    expect(edited.game!.submitted.p1).toBe(false);
  });

  it('un-submits a list when an item is removed', () => {
    const removed = ok(entering(), { type: 'remove_item', playerId: 'p1', favoriteId: 'f3' }, 2_000);
    expect(removed.game!.submitted.p1).toBe(false);
    expect(removed.game!.favorites.filter((f) => f.playerId === 'p1')).toHaveLength(4);
  });

  it('refuses a sixth item on a full list', () => {
    const result = apply(entering(), {
      type: 'add_item', playerId: 'p1',
      favorite: {
        id: 'f6', playerId: 'p1', entryPosition: 6, displayText: 'Item 6', ballotText: 'ITEM 6',
        canonicalItemId: null, autoPicked: false, surprisePicked: false, shuffledPosition: null,
      },
    }, ctx(2_000));
    expect(result).toMatchObject({ ok: false });
  });
});

describe('§11 play again with a full room', () => {
  it('leaves a queued joiner queued when no seat is free', () => {
    const { state } = simulateGame({ humanCount: 4, listLength: 5, seed: 5 });
    const withQueue: SessionState = structuredClone(state);
    withQueue.players.push(player('q1', { colorSlot: null, queued: true, name: 'Queued' }));
    const again = ok(withQueue, { type: 'play_again', actorId: withQueue.hostPlayerId! }, 900_000);
    const queued = again.players.find((p) => p.id === 'q1')!;
    expect(queued.queued).toBe(true);
    expect(queued.colorSlot).toBeNull();
  });
});

describe('§5 / §9.1 the Computer sitting out (spec v0.8)', () => {
  const lobbyOf = (humans: number, computerPlayer: boolean) =>
    session({
      hostPlayerId: 'p1',
      computerPlayer,
      players: [
        player('cpu', { isComputer: true, colorSlot: 0, name: 'Computer', userId: null }),
        ...Array.from({ length: humans }, (_, i) =>
          player(`p${i + 1}`, { colorSlot: i + 1, isHost: i === 0, joinedAt: i }),
        ),
      ],
    });

  it('lets the host switch the Computer off in the lobby, and only the host', () => {
    const off = ok(lobbyOf(3, true), { type: 'update_settings', actorId: 'p1', computerPlayer: false }, 1_000);
    expect(off.computerPlayer).toBe(false);
    // Changing one setting leaves the other alone.
    expect(off.relaxedTimers).toBe(false);
    expect(apply(lobbyOf(3, true), { type: 'update_settings', actorId: 'p2', computerPlayer: false }, ctx(1)))
      .toMatchObject({ ok: false, error: 'not_host' });
  });

  it('freezes the choice at Start: off with 3+ humans, forced on with 2', () => {
    const three = ok(lobbyOf(3, false), { type: 'start_game', actorId: 'p1' }, 1_000);
    expect(three.game!.withComputer).toBe(false);
    const two = ok(lobbyOf(2, false), { type: 'start_game', actorId: 'p1' }, 1_000);
    expect(two.game!.withComputer).toBe(true);
    const on = ok(lobbyOf(4, true), { type: 'start_game', actorId: 'p1' }, 1_000);
    expect(on.game!.withComputer).toBe(true);
  });

  it('keeps the Computer out for the whole game even if a player leaves', () => {
    let state = ok(lobbyOf(3, false), { type: 'start_game', actorId: 'p1' }, 1_000);
    state = ok(state, { type: 'leave', playerId: 'p3' }, 2_000);
    expect(state.game!.withComputer).toBe(false);
  });

  it('builds ballots from human lists only, and leaves the Computer off the scoreboard', () => {
    const { state } = simulateGame({ humanCount: 3, listLength: 5, seed: 4, computerPlayer: false });
    expect(state.status).toBe('results');
    for (const m of state.game!.matchups) {
      expect(m.cards).toHaveLength(3);
      const owners = m.cards.flatMap((c) => c.ownerFavoriteIds.map((id) => state.game!.favorites.find((f) => f.id === id)!.playerId));
      expect(owners).not.toContain('cpu');
    }
    expect(standings(state).some((r) => r.isComputer)).toBe(false);
  });
});

describe('custom-category spec §3.6 / §5.3 setup holds and spell check', () => {
  const twoUp = () =>
    session({
      hostPlayerId: 'p1',
      players: [
        player('cpu', { isComputer: true, colorSlot: 0, name: 'Computer', userId: null }),
        player('p1', { colorSlot: 1, isHost: true }),
        player('p2', { colorSlot: 2, joinedAt: 1 }),
      ],
    });

  it('extends the setup timer once a game while a custom category builds', () => {
    let state = ok(twoUp(), { type: 'start_game', actorId: 'p1' }, 1_000);
    expect(state.phaseDeadline).toBe(1_000 + HOST_SETUP_MS);
    // 40s in, only 5s left: the build gets a full 30s.
    state = ok(state, { type: 'hold_setup', actorId: 'p1', name: 'Board Games' }, 41_000);
    expect(state.game!.buildingCategory).toBe('Board Games');
    expect(state.phaseDeadline).toBe(41_000 + SETUP_HOLD_MS);
    state = ok(state, { type: 'hold_setup', actorId: 'p1', name: null }, 50_000);
    expect(state.game!.buildingCategory).toBeNull();
    // A second build doesn't get another extension.
    state = ok(state, { type: 'hold_setup', actorId: 'p1', name: 'Pizza Toppings' }, 60_000);
    expect(state.phaseDeadline).toBe(41_000 + SETUP_HOLD_MS);
  });

  it('only lets the host hold setup, and only in setup', () => {
    const lobby = twoUp();
    expect(apply(lobby, { type: 'hold_setup', actorId: 'p1', name: 'X' }, ctx(1))).toMatchObject({ ok: false, error: 'wrong_phase' });
    const setup = ok(lobby, { type: 'start_game', actorId: 'p1' }, 1_000);
    expect(apply(setup, { type: 'hold_setup', actorId: 'p2', name: 'X' }, ctx(2_000))).toMatchObject({ ok: false, error: 'not_host' });
  });

  it('freezes spell check at Start and clears the build banner', () => {
    let state = ok(twoUp(), { type: 'start_game', actorId: 'p1' }, 1_000);
    state = ok(state, { type: 'hold_setup', actorId: 'p1', name: 'Board Games' }, 2_000);
    state = ok(state, { type: 'confirm_setup', actorId: 'p1', categoryId: 99, listLength: 5, spellCheck: false }, 3_000);
    expect(state.game!.spellCheck).toBe(false);
    expect(state.game!.buildingCategory).toBeNull();
    const plain = ok(ok(twoUp(), { type: 'start_game', actorId: 'p1' }, 1_000), {
      type: 'confirm_setup', actorId: 'p1', categoryId: 1, listLength: 5,
    }, 2_000);
    expect(plain.game!.spellCheck).toBe(true);
  });
});

describe('custom-category spec §4 thin categories', () => {
  const item = (playerId: string, i: number) => ({
    id: `${playerId}-${i}`, playerId, entryPosition: i, displayText: `${playerId} ${i}`, ballotText: `${playerId} ${i}`.toUpperCase(),
    canonicalItemId: null, autoPicked: false, surprisePicked: false, shuffledPosition: null,
  });

  /** Both humans heart-beat, so the advance doesn't pause the game for them. */
  const beat = (state: SessionState, at: number) =>
    ['p1', 'p2'].reduce((s, playerId) => ok(s, { type: 'heartbeat', playerId }, at), state);

  /** Two humans at list lock: p1 filled 5, p2 only `p2Count`, and the Computer got `cpuCount`. */
  function locked(p2Count: number, cpuCount: number) {
    let state = ok(
      session({
        hostPlayerId: 'p1',
        players: [
          player('cpu', { isComputer: true, colorSlot: 0, name: 'Computer', userId: null }),
          player('p1', { colorSlot: 1, isHost: true, lastSeenAt: 1_000 }),
          player('p2', { colorSlot: 2, joinedAt: 1, lastSeenAt: 1_000 }),
        ],
      }),
      { type: 'start_game', actorId: 'p1' },
      1_000,
    );
    state = ok(state, { type: 'confirm_setup', actorId: 'p1', categoryId: 99, listLength: 5 }, 1_000);
    for (let i = 1; i <= 5; i++) state = ok(state, { type: 'add_item', playerId: 'p1', favorite: item('p1', i) }, 1_000);
    for (let i = 1; i <= p2Count; i++) state = ok(state, { type: 'add_item', playerId: 'p2', favorite: item('p2', i) }, 1_000);
    // The entry timer runs out with p2's list short.
    state = beat(state, 1_000 + ENTRY_MS_BY_LENGTH[5]);
    state = ok(state, { type: 'advance' }, 1_000 + ENTRY_MS_BY_LENGTH[5]);
    expect(state.status).toBe('computer_picking');
    const computerFavorites = Array.from({ length: cpuCount }, (_, i) => item('cpu', i + 1));
    return ok(state, { type: 'lock_lists', autoFill: [], computerFavorites, computerItemIds: [] }, 1_000 + ENTRY_MS_BY_LENGTH[5]);
  }

  it('sits the Computer out when a thin category leaves it nothing, even with 2 humans', () => {
    const state = locked(5, 0);
    expect(state.game!.withComputer).toBe(false);
    expect(state.game!.matchups.every((m) => m.cards.length === 2)).toBe(true);
    expect(everyBallotHadThree({ matchups: state.game!.matchups.map((m) => ({ ...m, status: 'revealed' as const })) })).toBe(false);
    expect(standings(state).some((r) => r.isComputer)).toBe(false);
  });

  it('plays fewer rounds when short lists leave rounds without a choice, and ends after the last', () => {
    const now = 1_000 + ENTRY_MS_BY_LENGTH[5];
    let state = locked(2, 0);
    expect(roundCount(state.game!)).toBe(2);
    expect(publicState(state).totalRounds).toBe(2);
    // Showdown moves to the last round actually played.
    expect(state.game!.matchups.map((m) => m.multiplier)).toEqual([1, 2]);
    let at = now;
    for (let round = 1; round <= 2; round++) {
      at += VOTE_MS;
      state = ok(beat(state, at), { type: 'advance' }, at);
      expect(state.status).toBe('matchup_reveal');
      at += REVEAL_HOLD_MS;
      state = ok(beat(state, at), { type: 'advance' }, at);
    }
    expect(state.status).toBe('results');
    // max_possible follows the 2 rounds played: (1 + 2) x 2 humans.
    expect(standings(state).find((r) => r.playerId === 'p1')!.maxPossible).toBe(6);
  });
});

describe('mode spec v0.4 champion reign cap setting', () => {
  const lobby = () =>
    session({
      hostPlayerId: 'p1',
      players: [
        player('cpu', { isComputer: true, colorSlot: 0, name: 'Computer', userId: null }),
        player('p1', { colorSlot: 1, isHost: true }),
        player('p2', { colorSlot: 2, joinedAt: 1 }),
      ],
    });

  it('only the host changes it, and it freezes at Start', () => {
    expect(apply(lobby(), { type: 'update_settings', actorId: 'p2', championReignCap: 3 }, ctx(1)))
      .toMatchObject({ ok: false, error: 'not_host' });
    const three = ok(lobby(), { type: 'update_settings', actorId: 'p1', championReignCap: 3 }, 1_000);
    expect(three.championReignCap).toBe(3);
    const started = ok(three, { type: 'start_game', actorId: 'p1' }, 2_000);
    expect(started.game!.championReignCap).toBe(3);
    // Changing the lobby setting can't happen mid-game.
    expect(apply(started, { type: 'update_settings', actorId: 'p1', championReignCap: null }, ctx(3_000)))
      .toMatchObject({ ok: false, error: 'wrong_phase' });
  });
});
