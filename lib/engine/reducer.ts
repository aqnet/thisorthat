/**
 * The game engine (spec §14.2).
 *
 * A pure reducer: (state, intent, ctx) -> { state, events } | error. No I/O,
 * no clock of its own, no randomness of its own. Everything time-dependent
 * arrives as ctx.now, and everything random derives from ctx.seed, so a game
 * can be replayed exactly from its event log.
 *
 * This purity is the point. It makes every rule in §7-§12 unit-testable
 * without a database, and it is the escape hatch in D12: if Next.js plus
 * Postgres proves too slow, this module moves into a dedicated room server
 * unchanged.
 */

import {
  DEPART_AFTER_MS,
  DISCONNECT_AFTER_MS,
  ENTRY_MS_BY_LENGTH,
  HOST_SETUP_MS,
  CATEGORY_VOTE_MS,
  MAX_HUMANS,
  MIN_HUMANS,
  PAUSE_GRACE_MS,
  REVEAL_HOLD_MS,
  ROOM_IDLE_EXPIRY_MS,
  VOTE_MS,
  applyRelaxed,
  multiplierForRound,
  type ListLength,
} from './constants';
import { createRng } from './rng';
import { buildMatchups, ownCardId } from './matchups';
import { activeHumans, leaderAfterEachRound, scoreGame } from './scoring';
import type {
  EngineContext,
  EngineErrorCode,
  EngineEvent,
  EngineResult,
  Favorite,
  Game,
  Intent,
  Matchup,
  Player,
  SessionState,
} from './types';

const ERROR_COPY: Record<EngineErrorCode, string> = {
  wrong_phase: "That action isn't available right now",
  not_host: 'Only the host can do that',
  not_seated: "You don't have a seat in this room",
  room_full: 'Room is full',
  room_closed: 'This room was closed',
  need_more_players: 'Need 1 more player',
  already_voted: 'Your vote is already locked',
  own_card: "You can't vote for your own item",
  unknown_card: "That card isn't in this match-up",
  list_incomplete: 'Fill your whole list first',
  invalid_length: 'That list length is not allowed for this category',
  duplicate_vote_target: 'That vote was already counted',
  unknown_player: 'Unknown player',
};

function fail(error: EngineErrorCode): EngineResult {
  return { ok: false, error, message: ERROR_COPY[error] };
}

function clone(state: SessionState): SessionState {
  return structuredClone(state);
}

function commit(state: SessionState, now: number, events: EngineEvent[]): EngineResult {
  state.version += 1;
  state.lastActivityAt = now;
  return { ok: true, state, events };
}

const findPlayer = (state: SessionState, id: string): Player | undefined =>
  state.players.find((p) => p.id === id);

const isHost = (state: SessionState, id: string): boolean => state.hostPlayerId === id;

/** Humans still in the room whose heartbeat is fresh (§14.4). */
function connected(state: SessionState, now: number): Player[] {
  return activeHumans(state.players).filter(
    (p) => now - p.lastSeenAt < DISCONNECT_AFTER_MS,
  );
}

function currentMatchup(state: SessionState): Matchup | null {
  const game = state.game;
  if (!game) return null;
  return game.matchups.find((m) => m.roundNumber === game.currentRound) ?? null;
}

// --- Phase transitions ----------------------------------------------------

function openRound(state: SessionState, roundNumber: number, now: number): void {
  const game = state.game!;
  const matchup = game.matchups.find((m) => m.roundNumber === roundNumber)!;
  game.currentRound = roundNumber;
  matchup.status = 'voting';
  matchup.openedAt = now;
  state.status = 'matchup_voting';
  // §9.3: 15s flat. Relaxed timers deliberately do not stretch this.
  state.phaseDeadline = now + VOTE_MS;
}

function revealRound(state: SessionState, now: number, events: EngineEvent[]): void {
  const game = state.game!;
  const matchup = currentMatchup(state);
  if (!matchup) return;

  matchup.status = 'revealed';
  matchup.revealedAt = now;
  state.status = 'matchup_reveal';
  state.phaseDeadline = now + REVEAL_HOLD_MS;
  events.push({ type: 'reveal', roundNumber: matchup.roundNumber });

  // §9.5.8: call out a change at the top of the scoreboard.
  const leaders = leaderAfterEachRound(state);
  if (leaders.length >= 2) {
    const [previous, latest] = [leaders[leaders.length - 2], leaders[leaders.length - 1]];
    if (latest && latest !== previous) events.push({ type: 'lead_change', playerId: latest });
  } else if (leaders.length === 1 && leaders[0]) {
    events.push({ type: 'lead_change', playerId: leaders[0] });
  }

  void game;
}

function finishGame(state: SessionState, now: number, endedEarly: boolean, events: EngineEvent[]): void {
  if (state.game) {
    state.game.endedEarly = endedEarly;
    state.game.endedAt = now;
  }
  state.status = 'results';
  state.phaseDeadline = null;
  state.pausedUntil = null;
  state.pausedFrom = null;
  events.push({ type: 'game_over' });
}

function advanceAfterReveal(state: SessionState, now: number, events: EngineEvent[]): void {
  const game = state.game!;
  const next = game.currentRound + 1;
  if (game.listLength !== null && next <= game.listLength) {
    openRound(state, next, now);
  } else {
    finishGame(state, now, false, events);
  }
}

/**
 * Resolve the round as soon as every connected human has voted (§14.3.5).
 * Returns whether the phase moved on, so callers never have to re-read a
 * status that was mutated behind TypeScript's back.
 */
function maybeResolveRound(state: SessionState, now: number, events: EngineEvent[]): boolean {
  const matchup = currentMatchup(state);
  if (!matchup || state.status !== 'matchup_voting') return false;
  const waitingOn = connected(state, now).filter((p) => !(p.id in matchup.votes));
  if (waitingOn.length > 0) return false;
  revealRound(state, now, events);
  return true;
}

/**
 * Lists lock when every connected human has submitted, or the timer runs out.
 * Returns whether the phase moved on.
 */
function maybeLockLists(state: SessionState, now: number, events: EngineEvent[]): boolean {
  const game = state.game;
  if (!game || state.status !== 'entering') return false;
  const pending = connected(state, now).filter((p) => !game.submitted[p.id]);
  if (pending.length > 0) return false;
  // Hand off to the server for dictionary work (§14.8), then lock_lists.
  state.status = 'computer_picking';
  state.phaseDeadline = null;
  events.push({ type: 'state' });
  return true;
}

// --- The reducer ----------------------------------------------------------

export function apply(input: SessionState, intent: Intent, ctx: EngineContext): EngineResult {
  const { now } = ctx;
  if (input.status === 'closed' && intent.type !== 'advance') return fail('room_closed');

  const state = clone(input);
  const events: EngineEvent[] = [{ type: 'state' }];

  switch (intent.type) {
    case 'heartbeat': {
      const player = findPlayer(state, intent.playerId);
      if (!player) return fail('unknown_player');
      player.lastSeenAt = now;
      // A heartbeat after a silence un-disconnects the seat.
      if (player.disconnectedAt !== null && player.leftAt === null) {
        player.disconnectedAt = null;
      }
      return { ok: true, state, events: [] };
    }

    case 'join': {
      if (state.status !== 'lobby') {
        // §6: joining mid-game queues you for the next one.
        state.players.push({
          id: intent.playerId,
          userId: intent.userId,
          isComputer: false,
          name: intent.name,
          colorSlot: null,
          isHost: false,
          queued: true,
          joinedAt: now,
          lastSeenAt: now,
          disconnectedAt: null,
          leftAt: null,
        });
        return commit(state, now, events);
      }

      const seated = activeHumans(state.players);
      if (seated.length >= MAX_HUMANS) return fail('room_full');

      const usedSlots = new Set(seated.map((p) => p.colorSlot));
      let slot = 1;
      while (usedSlots.has(slot)) slot += 1;

      state.players.push({
        id: intent.playerId,
        userId: intent.userId,
        isComputer: false,
        name: intent.name,
        colorSlot: slot,
        isHost: state.hostPlayerId === null,
        queued: false,
        joinedAt: now,
        lastSeenAt: now,
        disconnectedAt: null,
        leftAt: null,
      });
      if (state.hostPlayerId === null) state.hostPlayerId = intent.playerId;
      return commit(state, now, events);
    }

    case 'rejoin_seat': {
      const player = findPlayer(state, intent.playerId);
      if (!player) return fail('unknown_player');
      // §6: a seat can only be claimed while it is disconnected.
      if (player.leftAt === null && player.disconnectedAt === null) return fail('not_seated');
      player.userId = intent.userId;
      player.leftAt = null;
      player.disconnectedAt = null;
      player.lastSeenAt = now;
      return commit(state, now, events);
    }

    case 'leave': {
      const player = findPlayer(state, intent.playerId);
      if (!player || player.isComputer) return fail('unknown_player');
      // §9.7: the seat empties but the player's items stay on every ballot.
      player.leftAt = now;
      player.colorSlot = state.status === 'lobby' ? null : player.colorSlot;
      if (isHost(state, player.id)) transferHost(state, now);
      checkQuorum(state, now, events);
      maybeResolveRound(state, now, events);
      return commit(state, now, events);
    }

    case 'remove_player': {
      if (!isHost(state, intent.actorId)) return fail('not_host');
      if (state.status !== 'lobby') return fail('wrong_phase');
      const target = findPlayer(state, intent.targetPlayerId);
      if (!target || target.isComputer) return fail('unknown_player');
      target.leftAt = now;
      target.colorSlot = null;
      return commit(state, now, events);
    }

    case 'start_game': {
      if (!isHost(state, intent.actorId)) return fail('not_host');
      if (state.status !== 'lobby') return fail('wrong_phase');
      if (activeHumans(state.players).length < MIN_HUMANS) return fail('need_more_players');

      const previous = state.game;
      state.game = {
        id: ctx.newId(),
        number: (previous?.number ?? 0) + 1,
        offeredCategoryIds: [],
        categoryId: null,
        listLength: null,
        humanCount: null,
        currentRound: 0,
        endedEarly: false,
        favorites: [],
        matchups: [],
        categoryVotes: {},
        submitted: {},
        computerItemIds: [],
        startedAt: now,
        endedAt: null,
      };
      state.status = 'setup';
      state.phaseDeadline =
        now +
        applyRelaxed(
          state.categoryVoteEnabled ? CATEGORY_VOTE_MS : HOST_SETUP_MS,
          state.relaxedTimers,
        );
      return commit(state, now, events);
    }

    case 'category_vote': {
      if (state.status !== 'setup' || !state.categoryVoteEnabled) return fail('wrong_phase');
      const player = findPlayer(state, intent.playerId);
      if (!player || player.isComputer || player.queued) return fail('not_seated');
      state.game!.categoryVotes[intent.playerId] = intent.categoryId;
      return commit(state, now, events);
    }

    case 'confirm_setup': {
      if (!isHost(state, intent.actorId)) return fail('not_host');
      if (state.status !== 'setup') return fail('wrong_phase');
      const game = state.game!;
      game.categoryId = intent.categoryId;
      game.listLength = intent.listLength;
      state.status = 'entering';
      state.phaseDeadline =
        now + applyRelaxed(ENTRY_MS_BY_LENGTH[intent.listLength], state.relaxedTimers);
      return commit(state, now, events);
    }

    case 'add_item': {
      if (state.status !== 'entering') return fail('wrong_phase');
      const game = state.game!;
      const player = findPlayer(state, intent.playerId);
      if (!player || player.queued) return fail('not_seated');
      const own = game.favorites.filter((f) => f.playerId === intent.playerId);
      if (game.listLength !== null && own.length >= game.listLength) {
        return fail('list_incomplete');
      }
      game.favorites.push(intent.favorite);
      return commit(state, now, [{ type: 'progress', detail: 'entry' }]);
    }

    case 'remove_item': {
      if (state.status !== 'entering') return fail('wrong_phase');
      const game = state.game!;
      game.favorites = game.favorites.filter(
        (f) => !(f.id === intent.favoriteId && f.playerId === intent.playerId),
      );
      game.submitted[intent.playerId] = false;
      return commit(state, now, [{ type: 'progress', detail: 'entry' }]);
    }

    case 'submit_list': {
      if (state.status !== 'entering') return fail('wrong_phase');
      const game = state.game!;
      const own = game.favorites.filter((f) => f.playerId === intent.playerId);
      if (game.listLength === null || own.length !== game.listLength) {
        return fail('list_incomplete');
      }
      game.submitted[intent.playerId] = true;
      maybeLockLists(state, now, events);
      return commit(state, now, events);
    }

    case 'edit_list': {
      // §8: a submitted player can reopen their list until all lists lock.
      if (state.status !== 'entering') return fail('wrong_phase');
      state.game!.submitted[intent.playerId] = false;
      return commit(state, now, events);
    }

    case 'lock_lists': {
      if (state.status !== 'computer_picking') return fail('wrong_phase');
      const game = state.game!;
      const listLength = game.listLength!;

      game.favorites.push(...intent.autoFill, ...intent.computerFavorites);
      game.computerItemIds = intent.computerItemIds;

      const computer = state.players.find((p) => p.isComputer);
      const seated = activeHumans(state.players);
      game.humanCount = seated.length;

      const playerIds = [...seated.map((p) => p.id)];
      if (computer) playerIds.push(computer.id);

      const built = buildMatchups({
        gameId: game.id,
        listLength,
        playerIds,
        favorites: game.favorites,
        rng: createRng(ctx.seed),
        newId: ctx.newId,
      });
      game.matchups = built.matchups;
      game.favorites = built.favorites;

      openRound(state, 1, now);
      return commit(state, now, events);
    }

    case 'cast_vote': {
      if (state.status !== 'matchup_voting') return fail('wrong_phase');
      const matchup = currentMatchup(state);
      if (!matchup) return fail('wrong_phase');

      const player = findPlayer(state, intent.playerId);
      if (!player || player.isComputer || player.queued || player.leftAt !== null) {
        return fail('not_seated');
      }
      // §9.4: votes lock on tap, so a second vote is refused rather than replacing.
      if (intent.playerId in matchup.votes) return fail('already_voted');
      if (!matchup.cards.some((c) => c.id === intent.ballotCardId)) return fail('unknown_card');
      // §9.4: without this every player votes for themselves and every round ties.
      if (ownCardId(matchup, intent.playerId, state.game!.favorites) === intent.ballotCardId) {
        return fail('own_card');
      }

      player.lastSeenAt = now;
      matchup.votes[intent.playerId] = intent.ballotCardId;
      maybeResolveRound(state, now, events);
      return commit(state, now, [...events, { type: 'progress', detail: 'vote' }]);
    }

    case 'next': {
      if (!isHost(state, intent.actorId)) return fail('not_host');
      if (state.status !== 'matchup_reveal') return fail('wrong_phase');
      advanceAfterReveal(state, now, events);
      return commit(state, now, events);
    }

    case 'end_game': {
      if (!isHost(state, intent.actorId)) return fail('not_host');
      if (state.status === 'lobby' || state.status === 'results') return fail('wrong_phase');
      // §9.7: straight to results, labelled early, and not eligible for boards.
      finishGame(state, now, true, events);
      return commit(state, now, events);
    }

    case 'play_again': {
      if (!isHost(state, intent.actorId)) return fail('not_host');
      if (state.status !== 'results') return fail('wrong_phase');

      // §11: seats, names and colors are kept; departed seats free up and
      // queued joiners are seated if there is room.
      state.players = state.players.filter((p) => p.leftAt === null || p.isComputer);
      const usedSlots = new Set(
        state.players.filter((p) => !p.queued && !p.isComputer).map((p) => p.colorSlot),
      );
      for (const player of state.players) {
        if (!player.queued) continue;
        if (usedSlots.size >= MAX_HUMANS) continue;
        let slot = 1;
        while (usedSlots.has(slot)) slot += 1;
        player.queued = false;
        player.colorSlot = slot;
        usedSlots.add(slot);
      }
      state.status = 'lobby';
      state.phaseDeadline = null;
      state.pausedUntil = null;
      state.pausedFrom = null;
      return commit(state, now, events);
    }

    case 'advance':
      return advance(state, now, events);

    default: {
      const exhaustive: never = intent;
      void exhaustive;
      return fail('wrong_phase');
    }
  }
}

// --- Server-driven advance (§14.3) ---------------------------------------

function transferHost(state: SessionState, now: number): void {
  const candidates = activeHumans(state.players)
    .filter((p) => now - p.lastSeenAt < DISCONNECT_AFTER_MS)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  for (const player of state.players) player.isHost = false;
  const next = candidates[0] ?? null;
  state.hostPlayerId = next?.id ?? null;
  if (next) next.isHost = true;
}

/** §9.7: below 2 connected humans the game pauses rather than hanging. */
function checkQuorum(state: SessionState, now: number, events: EngineEvent[]): boolean {
  const inGame =
    state.status === 'setup' ||
    state.status === 'entering' ||
    state.status === 'matchup_voting' ||
    state.status === 'matchup_reveal';
  if (!inGame) return false;

  if (connected(state, now).length < MIN_HUMANS) {
    // Remember the phase so resuming puts players back where they were,
    // rather than dropping them into whatever phase happens to be next.
    state.pausedFrom = state.status;
    state.status = 'paused';
    state.pausedUntil = now + PAUSE_GRACE_MS;
    state.phaseDeadline = now + PAUSE_GRACE_MS;
    events.push({ type: 'state' });
    return true;
  }
  return false;
}

/** A fresh deadline for the phase being resumed after a pause (§9.7). */
function resumeDeadline(state: SessionState, status: SessionState['status'], now: number): number | null {
  const listLength = state.game?.listLength;
  switch (status) {
    case 'matchup_voting':
      return now + VOTE_MS;
    case 'matchup_reveal':
      return now + REVEAL_HOLD_MS;
    case 'entering':
      return listLength
        ? now + applyRelaxed(ENTRY_MS_BY_LENGTH[listLength], state.relaxedTimers)
        : null;
    case 'setup':
      return now + applyRelaxed(
        state.categoryVoteEnabled ? CATEGORY_VOTE_MS : HOST_SETUP_MS,
        state.relaxedTimers,
      );
    default:
      return null;
  }
}

function advance(state: SessionState, now: number, events: EngineEvent[]): EngineResult {
  // Mark stale heartbeats before any rule reads "connected" (§14.4).
  for (const player of state.players) {
    if (player.isComputer || player.leftAt !== null) continue;
    const silentFor = now - player.lastSeenAt;
    if (silentFor >= DEPART_AFTER_MS) {
      player.leftAt = now;
      if (isHost(state, player.id)) transferHost(state, now);
    } else if (silentFor >= DISCONNECT_AFTER_MS && player.disconnectedAt === null) {
      player.disconnectedAt = now;
    }
  }

  if (state.status === 'closed') return { ok: true, state, events: [] };

  // §4: rooms expire after 2h of inactivity.
  if (now - state.lastActivityAt >= ROOM_IDLE_EXPIRY_MS) {
    state.status = 'closed';
    state.closedAt = now;
    state.phaseDeadline = null;
    return commit(state, now, events);
  }

  if (state.status === 'paused') {
    if (connected(state, now).length >= MIN_HUMANS) {
      // Enough players came back; restore the interrupted phase with a fresh
      // timer, so nobody returns to a countdown that already expired.
      const resumeTo = state.pausedFrom ?? 'matchup_voting';
      state.pausedUntil = null;
      state.pausedFrom = null;
      state.status = resumeTo;
      state.phaseDeadline = resumeDeadline(state, resumeTo, now);
      return commit(state, now, events);
    }
    if (state.pausedUntil !== null && now >= state.pausedUntil) {
      finishGame(state, now, true, events);
      return commit(state, now, events);
    }
    return { ok: true, state, events: [] };
  }

  if (checkQuorum(state, now, events)) return commit(state, now, events);

  const deadline = state.phaseDeadline;
  const expired = deadline !== null && now >= deadline;

  switch (state.status) {
    case 'entering':
      if (expired) {
        // §8: the game never stalls; the server fills what's missing.
        state.status = 'computer_picking';
        state.phaseDeadline = null;
        return commit(state, now, events);
      }
      return maybeLockLists(state, now, events)
        ? commit(state, now, events)
        : { ok: true, state, events: [] };

    case 'matchup_voting':
      if (expired) {
        revealRound(state, now, events);
        return commit(state, now, events);
      }
      return maybeResolveRound(state, now, events)
        ? commit(state, now, events)
        : { ok: true, state, events: [] };

    case 'matchup_reveal':
      if (expired) {
        advanceAfterReveal(state, now, events);
        return commit(state, now, events);
      }
      return { ok: true, state, events: [] };

    case 'setup':
      if (expired) {
        // §7: auto-confirm Random category at the longest length up to 10.
        return { ok: true, state, events: [] };
      }
      return { ok: true, state, events: [] };

    default:
      return { ok: true, state, events: [] };
  }
}

// --- Public projection (§14.5) -------------------------------------------

export interface PublicCard {
  id: string;
  displayText: string;
  sortOrder: number;
  /** Only after reveal. Hidden ownership is what stops alliance voting (D5). */
  ownerPlayerIds: string[] | null;
  voteCount: number | null;
}

/**
 * What goes on the wire. Owners are stripped from unrevealed cards and lists
 * are never included -- the broadcast payload is the thing a player can read
 * with dev tools, so hiding in the UI alone would not be hiding at all.
 */
export function publicState(state: SessionState) {
  const game = state.game;
  const matchup = currentMatchup(state);
  const revealed = matchup?.status === 'revealed';

  const cards: PublicCard[] =
    matchup?.cards.map((card) => {
      const voteCount = Object.values(matchup.votes).filter((id) => id === card.id).length;
      return {
        id: card.id,
        displayText: card.displayText,
        sortOrder: card.sortOrder,
        ownerPlayerIds: revealed
          ? card.ownerFavoriteIds
              .map((fid) => game?.favorites.find((f) => f.id === fid)?.playerId)
              .filter((id): id is string => Boolean(id))
          : null,
        voteCount: revealed ? voteCount : null,
      };
    }) ?? [];

  return {
    version: state.version,
    roomCode: state.roomCode,
    status: state.status,
    phaseDeadline: state.phaseDeadline,
    hostPlayerId: state.hostPlayerId,
    round: game?.currentRound ?? 0,
    totalRounds: game?.listLength ?? 0,
    multiplier: matchup?.multiplier ?? 1,
    categoryId: game?.categoryId ?? null,
    players: state.players
      .filter((p) => p.leftAt === null || !p.queued)
      .map((p) => ({
        id: p.id,
        name: p.name,
        colorSlot: p.colorSlot,
        isComputer: p.isComputer,
        isHost: p.isHost,
        queued: p.queued,
        left: p.leftAt !== null,
      })),
    cards,
    /** Who has voted, never what they voted for (§14.5). */
    votedPlayerIds: matchup ? Object.keys(matchup.votes) : [],
    entryProgress:
      state.status === 'entering' && game
        ? state.players
            .filter((p) => !p.isComputer && !p.queued && p.leftAt === null)
            .map((p) => ({
              playerId: p.id,
              count: game.favorites.filter((f) => f.playerId === p.id).length,
              submitted: Boolean(game.submitted[p.id]),
            }))
        : [],
  };
}

export { scoreGame, multiplierForRound };
export type { ListLength, Favorite, Game, SessionState };
