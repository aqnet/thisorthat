/**
 * Drives a complete game through the reducer. Used by the property tests, and
 * it doubles as the mechanical check that no phase is a dead end (§14.10).
 */

import { apply } from '../reducer';
import { ownCardId } from '../matchups';
import { createRng } from '../rng';
import { pickComputerItems, type DictionaryEntry } from '../computer';
import { toBallotText, toDisplayText } from '../text';
import type { EngineContext, Favorite, Intent, SessionState } from '../types';
import type { ListLength } from '../constants';
import { session } from './fixtures';

export function makeDictionary(size: number, prefix = 'Item'): DictionaryEntry[] {
  return Array.from({ length: size }, (_, i) => ({
    id: i + 1,
    canonicalName: `${prefix}${i + 1}`,
    popularTier: i < 20,
    playerOriginated: i % 17 === 0,
    appearances: i % 5,
    votesReceived: i % 3,
    roundWins: i % 4,
  }));
}

export interface SimulationOptions {
  humanCount: number;
  listLength: ListLength;
  seed: number;
  /** Humans who never vote, to exercise the timeout paths. */
  silentPlayerIds?: string[];
}

export interface SimulationResult {
  state: SessionState;
  /** Every status the session passed through, in order. */
  statuses: string[];
}

export function simulateGame(options: SimulationOptions): SimulationResult {
  const { humanCount, listLength, seed, silentPlayerIds = [] } = options;
  const rng = createRng(seed);
  let idCounter = 0;
  let now = 1_000;

  const ctx = (): EngineContext => ({ now, seed, newId: () => `id-${idCounter++}` });
  const statuses: string[] = [];

  let state = session({
    players: [
      {
        id: 'cpu', userId: null, isComputer: true, name: 'Computer', colorSlot: 0,
        isHost: false, queued: false, joinedAt: 0, lastSeenAt: now,
        disconnectedAt: null, leftAt: null,
      },
    ],
    lastActivityAt: now,
  });

  const step = (intent: Intent): void => {
    const result = apply(state, intent, ctx());
    if (!result.ok) {
      throw new Error(`intent ${intent.type} rejected: ${result.error}`);
    }
    state = result.state;
    if (statuses[statuses.length - 1] !== state.status) statuses.push(state.status);
  };

  const humanIds = Array.from({ length: humanCount }, (_, i) => `p${i + 1}`);
  for (const id of humanIds) {
    step({ type: 'join', playerId: id, userId: `u-${id}`, name: id.toUpperCase() });
  }

  step({ type: 'start_game', actorId: humanIds[0] });
  step({ type: 'confirm_setup', actorId: humanIds[0], categoryId: 1, listLength });

  // Each human enters a full, distinct list.
  const dictionary = makeDictionary(200);
  const usedItemIds = new Set<number>();
  humanIds.forEach((playerId, playerIndex) => {
    for (let i = 0; i < listLength; i++) {
      const entry = dictionary[playerIndex * listLength + i];
      usedItemIds.add(entry.id);
      const favorite: Favorite = {
        id: `f-${playerId}-${i}`,
        playerId,
        entryPosition: i + 1,
        displayText: toDisplayText(entry.canonicalName),
        ballotText: toBallotText(entry.canonicalName),
        canonicalItemId: entry.id,
        autoPicked: false,
        surprisePicked: false,
        shuffledPosition: null,
      };
      step({ type: 'add_item', playerId, favorite });
    }
    step({ type: 'submit_list', playerId });
  });

  // The server does the dictionary work, then hands the result back (§14.8).
  const picks = pickComputerItems({
    dictionary,
    listLength,
    excludedItemIds: usedItemIds,
    rng,
  });
  const computerFavorites: Favorite[] = picks.items.map((entry, i) => ({
    id: `f-cpu-${i}`,
    playerId: 'cpu',
    entryPosition: i + 1,
    displayText: toDisplayText(entry.canonicalName),
    ballotText: toBallotText(entry.canonicalName),
    canonicalItemId: entry.id,
    autoPicked: false,
    surprisePicked: false,
    shuffledPosition: null,
  }));
  step({
    type: 'lock_lists',
    autoFill: [],
    computerFavorites,
    computerItemIds: picks.items.map((e) => e.id),
  });

  // Play every round.
  for (let round = 1; round <= listLength; round++) {
    const matchup = state.game!.matchups.find((m) => m.roundNumber === round)!;
    for (const playerId of humanIds) {
      if (silentPlayerIds.includes(playerId)) continue;
      const own = ownCardId(matchup, playerId, state.game!.favorites);
      const target = matchup.cards.find((c) => c.id !== own);
      if (!target) continue;
      now += 100;
      step({ type: 'cast_vote', playerId, ballotCardId: target.id });
    }

    if (state.status === 'matchup_voting') {
      // Nobody voted. Clients still heartbeat every 10s while the player just
      // sits there (§14.4), so run the clock forward in heartbeat-sized steps
      // rather than jumping it -- otherwise silence looks like a disconnect.
      const deadline = state.phaseDeadline ?? now;
      while (now < deadline) {
        now = Math.min(now + 10_000, deadline + 1);
        for (const playerId of humanIds) step({ type: 'heartbeat', playerId });
      }
      step({ type: 'advance' });
    }
    if (state.status === 'matchup_reveal') {
      step({ type: 'next', actorId: state.hostPlayerId! });
    }
  }

  return { state, statuses };
}
