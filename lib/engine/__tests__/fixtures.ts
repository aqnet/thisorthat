import type { BallotCard, Favorite, Matchup, Player, SessionState } from '../types';

export function player(id: string, overrides: Partial<Player> = {}): Player {
  return {
    id,
    userId: `user-${id}`,
    isComputer: false,
    name: id,
    colorSlot: 1,
    isHost: false,
    queued: false,
    joinedAt: 0,
    lastSeenAt: 0,
    disconnectedAt: null,
    leftAt: null,
    ...overrides,
  };
}

export function favorite(id: string, playerId: string, text: string, position = 1): Favorite {
  return {
    id,
    playerId,
    entryPosition: position,
    displayText: text,
    ballotText: text.toUpperCase(),
    canonicalItemId: null,
    autoPicked: false,
    surprisePicked: false,
    shuffledPosition: position,
  };
}

export function card(id: string, text: string, ownerFavoriteIds: string[], sortOrder: number): BallotCard {
  return { id, displayText: text.toUpperCase(), sortOrder, ownerFavoriteIds };
}

export function matchup(overrides: Partial<Matchup> = {}): Matchup {
  return {
    id: 'm1',
    roundNumber: 1,
    multiplier: 1,
    status: 'revealed',
    cards: [],
    votes: {},
    openedAt: 0,
    revealedAt: 0,
    ...overrides,
  };
}

export function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    roomCode: 'KZPW',
    status: 'lobby',
    version: 0,
    hostPlayerId: null,
    phaseDeadline: null,
    relaxedTimers: false,
    categoryVoteEnabled: false,
    players: [],
    game: null,
    lastActivityAt: 0,
    closedAt: null,
    pausedUntil: null,
    pausedFrom: null,
    ...overrides,
  };
}
