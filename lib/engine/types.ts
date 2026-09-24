import type { ListLength } from './constants';

/** Mirrors this_or_that.session_status (§14.8). */
export type SessionStatus =
  | 'lobby'
  | 'setup'
  | 'entering'
  | 'computer_picking'
  | 'matchup_voting'
  | 'matchup_reveal'
  | 'paused'
  | 'results'
  | 'closed';

export type MatchupStatus = 'pending' | 'voting' | 'revealed';

export interface Player {
  id: string;
  /** null for the Computer, which has no auth identity. */
  userId: string | null;
  isComputer: boolean;
  name: string;
  /** 0 = Computer, 1-4 = seated humans, null = queued joiner. */
  colorSlot: number | null;
  isHost: boolean;
  queued: boolean;
  joinedAt: number;
  /** Heartbeat. Staleness, not Presence, decides who the server waits for. */
  lastSeenAt: number;
  disconnectedAt: number | null;
  /** Set on Leave or after DEPART_AFTER_MS. Items stay in play (§9.7). */
  leftAt: number | null;
}

export interface Favorite {
  id: string;
  playerId: string;
  /** 1-based position in the order the player entered items. */
  entryPosition: number;
  /** Title Case, private to the owner. */
  displayText: string;
  /** ALL CAPS, what a ballot card shows (§9.1). */
  ballotText: string;
  canonicalItemId: number | null;
  /** Filled by the timer, tagged on reveal. */
  autoPicked: boolean;
  /** "Surprise me", tagged in the owner's own list only. */
  surprisePicked: boolean;
  /** Assigned at list lock; decides which round the item appears in. */
  shuffledPosition: number | null;
}

export interface BallotCard {
  /** Random and unrelated to favorite ids, so it can't be joined to an owner. */
  id: string;
  /** ALL CAPS. The constraint in the migration enforces this at rest too. */
  displayText: string;
  sortOrder: number;
  /** More than one owner only for shared duplicate items (§9.5). */
  ownerFavoriteIds: string[];
}

export interface Matchup {
  id: string;
  roundNumber: number;
  multiplier: 1 | 2;
  status: MatchupStatus;
  cards: BallotCard[];
  /** voterPlayerId -> ballotCardId. One vote per player (§9.4). */
  votes: Record<string, string>;
  openedAt: number | null;
  revealedAt: number | null;
}

export interface Game {
  id: string;
  /** 1-based; Play Again starts game 2 in the same room. */
  number: number;
  offeredCategoryIds: number[];
  categoryId: number | null;
  listLength: ListLength | null;
  /** Frozen at list lock: the divisor for percentage scoring (§12). */
  humanCount: number | null;
  currentRound: number;
  endedEarly: boolean;
  favorites: Favorite[];
  matchups: Matchup[];
  /** playerId -> categoryId, for the optional category vote (§7). */
  categoryVotes: Record<string, number>;
  /** playerId -> submitted. Edit-after-submit flips it back (§8). */
  submitted: Record<string, boolean>;
  /** Canonical ids the Computer played, for the 3-game variety window. */
  computerItemIds: number[];
  startedAt: number;
  endedAt: number | null;
}

export interface SessionState {
  id: string;
  roomCode: string;
  status: SessionStatus;
  /** Optimistic concurrency guard (§14.2). Bumped on every applied intent. */
  version: number;
  hostPlayerId: string | null;
  /** null = this phase has no timer. Absolute ms, on the server clock. */
  phaseDeadline: number | null;
  relaxedTimers: boolean;
  categoryVoteEnabled: boolean;
  players: Player[];
  game: Game | null;
  lastActivityAt: number;
  closedAt: number | null;
  /** Set when the room drops below 2 connected humans (§9.7). */
  pausedUntil: number | null;
  /** The phase to restore on resume. Null unless status is 'paused'. */
  pausedFrom: SessionStatus | null;
}

// --- Intents (§14.2) ------------------------------------------------------

export type Intent =
  | { type: 'join'; playerId: string; userId: string; name: string }
  | { type: 'rejoin_seat'; playerId: string; userId: string }
  | { type: 'leave'; playerId: string }
  | { type: 'remove_player'; actorId: string; targetPlayerId: string }
  | { type: 'start_game'; actorId: string }
  | { type: 'category_vote'; playerId: string; categoryId: number }
  | { type: 'confirm_setup'; actorId: string; categoryId: number; listLength: ListLength }
  | { type: 'add_item'; playerId: string; favorite: Favorite }
  | { type: 'remove_item'; playerId: string; favoriteId: string }
  | { type: 'submit_list'; playerId: string }
  | { type: 'edit_list'; playerId: string }
  | { type: 'cast_vote'; playerId: string; ballotCardId: string }
  | { type: 'next'; actorId: string }
  | { type: 'end_game'; actorId: string }
  | { type: 'play_again'; actorId: string }
  | { type: 'heartbeat'; playerId: string }
  /**
   * Server-only. Completes the `computer_picking` step (§14.8): the engine is
   * pure, so the dictionary lookups for auto-fill and the Computer's list
   * happen in the caller and arrive here as data.
   */
  | { type: 'lock_lists'; autoFill: Favorite[]; computerFavorites: Favorite[]; computerItemIds: number[] }
  /** Server-only. The pg_cron dispatcher is the only caller (§14.3). */
  | { type: 'advance' };

// --- Events (broadcast on the room channel, §14.6) ------------------------

export type EngineEvent =
  | { type: 'state' }
  | { type: 'progress'; detail: 'entry' | 'vote' }
  | { type: 'reveal'; roundNumber: number }
  | { type: 'lead_change'; playerId: string }
  | { type: 'game_over' };

export interface EngineSuccess {
  ok: true;
  state: SessionState;
  events: EngineEvent[];
}

export interface EngineFailure {
  ok: false;
  error: EngineErrorCode;
  message: string;
}

export type EngineErrorCode =
  | 'wrong_phase'
  | 'not_host'
  | 'not_seated'
  | 'room_full'
  | 'room_closed'
  | 'need_more_players'
  | 'already_voted'
  | 'own_card'
  | 'unknown_card'
  | 'list_incomplete'
  | 'invalid_length'
  | 'duplicate_vote_target'
  | 'unknown_player';

export type EngineResult = EngineSuccess | EngineFailure;

export interface EngineContext {
  /** Server clock, in ms. Never the client's. */
  now: number;
  /** Seeded per game so shuffles and Computer picks replay (§14.8). */
  seed: number;
  /** Ids come from a CSPRNG outside the engine: card ids must be unguessable. */
  newId: () => string;
}
