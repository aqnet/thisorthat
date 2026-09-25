import type { ListLength, SessionStatus } from '@/lib/engine';

/**
 * What one player's phone is allowed to know (§14.5), built per viewer by the
 * getSnapshot Server Action. Other players' lists and votes never appear
 * here; card owners appear only after reveal.
 */
export interface RoomSnapshot {
  version: number;
  /** The server clock when this was built, for the client's clock offset (§14.3.6). */
  serverNow: number;
  roomCode: string;
  status: SessionStatus;
  phaseDeadline: number | null;
  pausedFrom: SessionStatus | null;
  hostPlayerId: string | null;
  relaxedTimers: boolean;
  me: SnapshotMe | null;
  players: SnapshotPlayer[];
  /** Only for the host during setup. */
  categories: CategoryOption[];
  game: SnapshotGame | null;
}

export interface SnapshotMe {
  playerId: string;
  isHost: boolean;
  queued: boolean;
  left: boolean;
}

export interface SnapshotPlayer {
  id: string;
  name: string;
  /** 0 = Computer, 1-4 = seats, null = queued. */
  colorSlot: number | null;
  isComputer: boolean;
  isHost: boolean;
  queued: boolean;
  left: boolean;
  connected: boolean;
}

export interface CategoryOption {
  id: number;
  name: string;
  /** Already narrowed by dictionary size (§7). */
  allowedLengths: ListLength[];
}

export interface MyItem {
  id: string;
  displayText: string;
  surprise: boolean;
  auto: boolean;
}

export interface SnapshotCard {
  id: string;
  /** ALL CAPS, from the server (§9.1). */
  displayText: string;
  /** The viewer's own card, shown but disabled ("Yours", §9.4). */
  mine: boolean;
  /** After reveal only. */
  ownerIds: string[] | null;
  votes: number | null;
  winner: boolean;
  /** Timer-filled item, tagged on reveal (§8). */
  auto: boolean;
}

export interface StandingRow {
  playerId: string;
  name: string;
  isComputer: boolean;
  colorSlot: number | null;
  score: number;
  roundWins: number;
  pct: number | null;
  rank: number;
  left: boolean;
}

export interface SnapshotGame {
  number: number;
  categoryName: string | null;
  listLength: ListLength | null;
  round: number;
  totalRounds: number;
  multiplier: 1 | 2;
  showdownRounds: number[];
  endedEarly: boolean;
  myList: MyItem[];
  mySubmitted: boolean;
  entryProgress: { playerId: string; count: number; submitted: boolean }[];
  cards: SnapshotCard[];
  myVote: string | null;
  votedPlayerIds: string[];
  standings: StandingRow[];
  /** The round just revealed: points by player. */
  roundPoints: Record<string, number> | null;
  /** §9.5.8: set on the reveal where the leader changed. */
  leadChange: string | null;
  results: SnapshotResults | null;
}

export interface FunStat {
  label: string;
  detail: string;
}

export interface SnapshotResults {
  computerWon: boolean;
  topHumanId: string | null;
  beatComputerIds: string[];
  funStats: FunStat[];
}

/** Every Server Action returns this shape: errors are copy, ready to show. */
export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; message: string; code?: string };

export interface JoinInfo {
  status: 'not_found' | 'closed' | 'full' | 'in_progress' | 'open' | 'seated';
  roomCode: string;
  /** "Rejoin as Maya?" (§6): disconnected seats a new device can claim. */
  rejoinable: { playerId: string; name: string }[];
}

export interface AddItemResult {
  /** "Did you mean Pomegranate?" (§8). Nothing was added. */
  suggestion?: { dictionaryId: number; name: string };
}
