/**
 * Every intent's refusals, in one table (§14.2: clients send intents, the
 * engine decides). Each row is a state, an intent, and the error it must get.
 * A refusal must never change the state, so each row also checks that.
 */
import { describe, expect, it } from 'vitest';
import { apply } from '../reducer';
import { simulateGame } from './simulate';
import { player, session } from './fixtures';
import {
  CATEGORY_VOTE_MS,
  DISCONNECT_AFTER_MS,
  HOST_SETUP_MS,
  REVEAL_HOLD_MS,
} from '../constants';
import type { EngineContext, EngineErrorCode, Intent, SessionState } from '../types';

let ids = 0;
const ctx = (now: number): EngineContext => ({ now, seed: 1, newId: () => `r-${ids++}` });
const NOW = 5_000;

const ok = (state: SessionState, intent: Intent, now = NOW) => {
  const result = apply(state, intent, ctx(now));
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error}`);
  return result.state;
};

const cpu = () => player('cpu', { isComputer: true, colorSlot: 0, name: 'Computer', userId: null, lastSeenAt: NOW });
const human = (id: string, slot: number, extra = {}) =>
  player(id, { colorSlot: slot, isHost: slot === 1, joinedAt: slot, lastSeenAt: NOW, ...extra });

/** p1 (host), p2, p3 seated; q1 queued. */
const lobby = (extra: Partial<SessionState> = {}) =>
  session({
    hostPlayerId: 'p1',
    players: [cpu(), human('p1', 1), human('p2', 2), human('p3', 3), player('q1', { colorSlot: null, queued: true, lastSeenAt: NOW })],
    lastActivityAt: NOW,
    ...extra,
  });
const setup = () => ok(lobby(), { type: 'start_game', actorId: 'p1' });
const entering = () => ok(setup(), { type: 'confirm_setup', actorId: 'p1', categoryId: 1, listLength: 5 });

/** A finished 3-player game, rewound to round 1's vote or its reveal. */
function inPlay(status: 'matchup_voting' | 'matchup_reveal'): SessionState {
  const state = structuredClone(simulateGame({ humanCount: 3, listLength: 5, seed: 9 }).state);
  state.status = status;
  state.game!.currentRound = 1;
  const first = state.game!.matchups[0];
  first.status = status === 'matchup_voting' ? 'voting' : 'revealed';
  if (status === 'matchup_voting') first.votes = {};
  state.phaseDeadline = NOW + 10_000;
  for (const p of state.players) p.lastSeenAt = NOW;
  state.lastActivityAt = NOW;
  return state;
}
const results = () => {
  const state = simulateGame({ humanCount: 3, listLength: 5, seed: 9 }).state;
  for (const p of state.players) p.lastSeenAt = NOW;
  return state;
};

const favorite = (playerId: string, n: number) => ({
  id: `x-${playerId}-${n}`, playerId, entryPosition: n, displayText: `Thing ${n}`, ballotText: `THING ${n}`,
  canonicalItemId: null, autoPicked: false, surprisePicked: false, shuffledPosition: null,
});

const fullRoom = () =>
  session({
    hostPlayerId: 'p1',
    players: [cpu(), human('p1', 1), human('p2', 2), human('p3', 3), human('p4', 4)],
    lastActivityAt: NOW,
  });

type Row = [string, () => SessionState, Intent, EngineErrorCode];

const rows: Row[] = [
  // Seats
  ['join a full lobby', fullRoom, { type: 'join', playerId: 'p5', userId: 'u5', name: 'Eve' }, 'room_full'],
  ['rejoin a connected seat', lobby, { type: 'rejoin_seat', playerId: 'p2', userId: 'other' }, 'not_seated'],
  ['rejoin an unknown seat', lobby, { type: 'rejoin_seat', playerId: 'nobody', userId: 'other' }, 'unknown_player'],
  ['leave as nobody', lobby, { type: 'leave', playerId: 'nobody' }, 'unknown_player'],
  ['make the Computer leave', lobby, { type: 'leave', playerId: 'cpu' }, 'unknown_player'],
  ['heartbeat for nobody', lobby, { type: 'heartbeat', playerId: 'nobody' }, 'unknown_player'],
  ['remove a player as a guest', lobby, { type: 'remove_player', actorId: 'p2', targetPlayerId: 'p3' }, 'not_host'],
  ['remove a player mid-game', setup, { type: 'remove_player', actorId: 'p1', targetPlayerId: 'p3' }, 'wrong_phase'],
  ['remove the Computer', lobby, { type: 'remove_player', actorId: 'p1', targetPlayerId: 'cpu' }, 'unknown_player'],
  // Lobby and setup
  ['start as a guest', lobby, { type: 'start_game', actorId: 'p2' }, 'not_host'],
  ['start twice', setup, { type: 'start_game', actorId: 'p1' }, 'wrong_phase'],
  [
    'start alone',
    () => session({ hostPlayerId: 'p1', players: [cpu(), human('p1', 1)], lastActivityAt: NOW }),
    { type: 'start_game', actorId: 'p1' },
    'need_more_players',
  ],
  ['change settings as a guest', lobby, { type: 'update_settings', actorId: 'p2', relaxedTimers: true }, 'not_host'],
  ['change settings mid-game', setup, { type: 'update_settings', actorId: 'p1', relaxedTimers: true }, 'wrong_phase'],
  ['close the room as a guest', lobby, { type: 'close_room', actorId: 'p2' }, 'not_host'],
  ['vote on a category with the vote off', setup, { type: 'category_vote', playerId: 'p2', categoryId: 1 }, 'wrong_phase'],
  [
    'vote on a category while queued',
    () => ok(lobby({ categoryVoteEnabled: true }), { type: 'start_game', actorId: 'p1' }),
    { type: 'category_vote', playerId: 'q1', categoryId: 1 },
    'not_seated',
  ],
  ['pick the mode as a guest', setup, { type: 'select_mode', actorId: 'p2', mode: 'pick_and_fwd' }, 'not_host'],
  ['pick the mode in the lobby', lobby, { type: 'select_mode', actorId: 'p1', mode: 'pick_and_fwd' }, 'wrong_phase'],
  ['confirm as a guest', setup, { type: 'confirm_setup', actorId: 'p2', categoryId: 1, listLength: 5 }, 'not_host'],
  ['confirm in the lobby', lobby, { type: 'confirm_setup', actorId: 'p1', categoryId: 1, listLength: 5 }, 'wrong_phase'],
  // Entering items
  ['add an item during setup', setup, { type: 'add_item', playerId: 'p1', favorite: favorite('p1', 1) }, 'wrong_phase'],
  ['add an item while queued', entering, { type: 'add_item', playerId: 'q1', favorite: favorite('q1', 1) }, 'not_seated'],
  ['remove an item during setup', setup, { type: 'remove_item', playerId: 'p1', favoriteId: 'x' }, 'wrong_phase'],
  ['submit during setup', setup, { type: 'submit_list', playerId: 'p1' }, 'wrong_phase'],
  ['submit an empty list', entering, { type: 'submit_list', playerId: 'p1' }, 'list_incomplete'],
  ['edit during setup', setup, { type: 'edit_list', playerId: 'p1' }, 'wrong_phase'],
  ['lock lists while entering', entering, { type: 'lock_lists', autoFill: [], computerFavorites: [], computerItemIds: [] }, 'wrong_phase'],
  // Voting and reveals
  ['vote while entering', entering, { type: 'cast_vote', playerId: 'p1', ballotCardId: 'x' }, 'wrong_phase'],
  ['vote while queued', () => {
    const state = inPlay('matchup_voting');
    state.players.push(player('q1', { colorSlot: null, queued: true, lastSeenAt: NOW }));
    return state;
  }, { type: 'cast_vote', playerId: 'q1', ballotCardId: 'x' }, 'not_seated'],
  ['vote after leaving', () => {
    const state = inPlay('matchup_voting');
    state.players.find((p) => p.id === 'p3')!.leftAt = NOW;
    return state;
  }, { type: 'cast_vote', playerId: 'p3', ballotCardId: 'x' }, 'not_seated'],
  ['skip the reveal as a guest', () => inPlay('matchup_reveal'), { type: 'next', actorId: 'p2' }, 'not_host'],
  ['skip during the vote', () => inPlay('matchup_voting'), { type: 'next', actorId: 'p1' }, 'wrong_phase'],
  // Ending and replaying
  ['end the game as a guest', () => inPlay('matchup_voting'), { type: 'end_game', actorId: 'p2' }, 'not_host'],
  ['end a game from the lobby', lobby, { type: 'end_game', actorId: 'p1' }, 'wrong_phase'],
  ['end a game twice', results, { type: 'end_game', actorId: 'p1' }, 'wrong_phase'],
  ['play again as a guest', results, { type: 'play_again', actorId: 'p2' }, 'not_host'],
  ['play again mid-game', () => inPlay('matchup_voting'), { type: 'play_again', actorId: 'p1' }, 'wrong_phase'],
  // A closed room refuses everything but the dispatcher.
  ['join a closed room', () => lobby({ status: 'closed' }), { type: 'join', playerId: 'z', userId: 'z', name: 'Zed' }, 'room_closed'],
];

describe('§14.2 every refusal', () => {
  it.each(rows)('refuses to %s', (_label, build, intent, error) => {
    const state = build();
    const before = structuredClone(state);
    const result = apply(state, intent, ctx(NOW));
    expect(result).toMatchObject({ ok: false, error });
    // The engine never mutates its input, refused or not.
    expect(state).toEqual(before);
  });

  it('records a category vote when the vote is on', () => {
    const state = ok(ok(lobby({ categoryVoteEnabled: true }), { type: 'start_game', actorId: 'p1' }), {
      type: 'category_vote', playerId: 'p2', categoryId: 7,
    });
    expect(state.game!.categoryVotes).toEqual({ p2: 7 });
  });

  it('lets the dispatcher look at a closed room without changing it', () => {
    const closed = lobby({ status: 'closed' });
    expect(apply(closed, { type: 'advance' }, ctx(NOW))).toMatchObject({ ok: true, events: [] });
  });
});

describe('§9.7 resuming a pause restores the interrupted phase', () => {
  /** Two of three humans go quiet, the dispatcher pauses, then they come back. */
  function pauseAndResume(state: SessionState) {
    const quiet = NOW + DISCONNECT_AFTER_MS;
    const paused = ok(
      ok(state, { type: 'heartbeat', playerId: 'p1' }, quiet),
      { type: 'advance' },
      quiet,
    );
    expect(paused.status).toBe('paused');
    const back = quiet + 1_000;
    const returned = ['p1', 'p2', 'p3'].reduce((s, id) => ok(s, { type: 'heartbeat', playerId: id }, back), paused);
    return { resumed: ok(returned, { type: 'advance' }, back), back };
  }

  it('resumes a reveal with a fresh hold', () => {
    const { resumed, back } = pauseAndResume(inPlay('matchup_reveal'));
    expect(resumed.status).toBe('matchup_reveal');
    expect(resumed.phaseDeadline).toBe(back + REVEAL_HOLD_MS);
  });

  it('resumes setup with a fresh timer, the category-vote one when the vote is on', () => {
    const plain = pauseAndResume(setup());
    expect(plain.resumed.status).toBe('setup');
    expect(plain.resumed.phaseDeadline).toBe(plain.back + HOST_SETUP_MS);
    const voting = pauseAndResume(ok(lobby({ categoryVoteEnabled: true }), { type: 'start_game', actorId: 'p1' }));
    expect(voting.resumed.phaseDeadline).toBe(voting.back + CATEGORY_VOTE_MS);
  });
});
