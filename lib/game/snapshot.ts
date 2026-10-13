import type { GameMode, ListLength, SessionStatus } from '@/lib/engine';

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
  /** Lobby setting (§5): the host wants the Computer to play. */
  computerPlayer: boolean;
  /** Whether it will play the next game: the setting, or forced on below 3 humans. */
  computerPlays: boolean;
  /** Lobby setting (mode spec v0.4): Pick and fwd champions retire after this many wins; null = never. */
  championReignCap: number | null;
  me: SnapshotMe | null;
  players: SnapshotPlayer[];
  /** Only for the host during setup. */
  categories: CategoryOption[];
  /** The most-played built-ins for the selected mode, shown as chips; the rest go in a dropdown. */
  topCategoryIds: number[];
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
  /** Every category offers 5, 10 and 15 (custom-category spec v0.5). */
  allowedLengths: ListLength[];
  /**
   * The longest length the dictionary comfortably supports (§7 size classes).
   * Longer is allowed, with a warning: players may run out of ideas, and short
   * lists sit out rounds (custom-category spec §4.1).
   */
  suggestedMax: ListLength;
  /** Setup grouping (custom-category spec §B6). */
  audience: 'everyone' | 'kids';
  /** This room's own custom category (§3.7). */
  isCustom: boolean;
  /** Active dictionary items. */
  itemCount: number;
  /**
   * Custom categories with a short dictionary (custom-category spec §4.5): the
   * closest built-in to borrow from, pre-selected for the host. Null = no guess.
   */
  borrowSuggestionId: number | null;
}

/**
 * Custom-category spec §3.5: the ready card after a build. Shown to the host
 * only, during setup.
 */
export type CustomCategoryResult =
  | {
      kind: 'ready';
      category: CategoryOption;
      /** Up to 3 items the game will suggest, ALL CAPS like ballots. */
      examples: string[];
      /** True when the name was built before, here or in another room: no API call. */
      reused: boolean;
      /** Set when the build couldn't run and the category plays without suggestions. */
      note: string | null;
    }
  /** "We already have Fruit — use it?" A suggestion, never a refusal (§3.1). */
  | { kind: 'builtin'; category: CategoryOption }
  /** The build couldn't run; the host can retry or play without suggestions (§3.6). */
  | { kind: 'failed'; name: string; message: string; canRetry: boolean };

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
  /**
   * Pick and fwd: the champion card, pinned first. Its original owners are
   * public before the reveal (mode spec §4.3); an owner merged in from a
   * fresh duplicate is not.
   */
  champion: { reign: number; ownerIds: string[] } | null;
}

/** Pick and fwd: what happened to the crown on the round just revealed (mode spec §4.4). */
export interface CrownCallout {
  kind: 'defended' | 'new' | 'coin_flip' | 'retired';
  /** The item now holding (or retiring with) the crown. */
  text: string;
  reign: number;
  /** Set when a new champion took the crown from an old one. */
  dethroned: string | null;
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
  mode: GameMode;
  /** False when the Computer sat this game out. */
  withComputer: boolean;
  categoryName: string | null;
  /** "List 10 board games you'll defend" / "A board game…" (custom-category spec §5.1). */
  singularLabel: string | null;
  pluralLabel: string | null;
  isCustom: boolean;
  /** Custom categories only: false when the host switched "Did you mean…?" off. */
  spellCheck: boolean;
  /** False when the category has no dictionary: Surprise me is hidden (§6). */
  hasDictionary: boolean;
  /** Custom-category spec §4.5: the built-in this game tops up from. */
  borrowedFrom: string | null;
  /** The dictionary is smaller than a list: the timer can't fill short lists (§4.2). */
  thin: boolean;
  /** The custom category the host is building, during setup (§3.6). */
  buildingCategory: string | null;
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
  /** Pick and fwd: shown before the lead-change callout. */
  crown: CrownCallout | null;
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
  /** Custom-category spec §4.4: some rounds had only 2 cards, so no high scores. */
  unrankedTwoCards: boolean;
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
