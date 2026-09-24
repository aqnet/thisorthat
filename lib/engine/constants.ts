/** Timers, sizes, and tuning knobs. Every number here traces to the spec. */

export const LIST_LENGTHS = [5, 10, 15] as const;
export type ListLength = (typeof LIST_LENGTHS)[number];

export const MIN_HUMANS = 2;
export const MAX_HUMANS = 4;

/** Seat 0 is always the Computer; 1-4 are the human seats (schema: color_slot). */
export const COMPUTER_COLOR_SLOT = 0;

export type SizeClass = 'small' | 'medium' | 'large';

export const ALLOWED_LENGTHS_BY_SIZE_CLASS: Record<SizeClass, readonly ListLength[]> = {
  large: [5, 10, 15],
  medium: [5, 10],
  small: [5],
};

/**
 * §7: a category's dictionary needs 1.5 x (4 x maxLength + maxLength) items,
 * leaving headroom for four human lists, auto-fill, and a strong Computer pick.
 * A category that falls short is capped at the next size class down.
 */
export function requiredDictionarySize(sizeClass: SizeClass): number {
  const maxLength = Math.max(...ALLOWED_LENGTHS_BY_SIZE_CLASS[sizeClass]);
  return Math.ceil(1.5 * (MAX_HUMANS * maxLength + maxLength));
}

/** 113 / 75 / 38 for large / medium / small. */
export const REQUIRED_DICTIONARY_SIZE: Record<SizeClass, number> = {
  large: requiredDictionarySize('large'),
  medium: requiredDictionarySize('medium'),
  small: requiredDictionarySize('small'),
};

// --- Timers (milliseconds) ------------------------------------------------

export const HOST_SETUP_MS = 45_000;
export const CATEGORY_VOTE_MS = 15_000;

/** §8: longer lists get proportionally more time. */
export const ENTRY_MS_BY_LENGTH: Record<ListLength, number> = {
  5: 60_000,
  10: 120_000,
  15: 180_000,
};

/**
 * §9.3: 15s flat, "for every round, player count, and setting". Deliberately
 * excluded from the relaxed-timers multiplier -- a slow vote phase kills pace.
 */
export const VOTE_MS = 15_000;

/** §9.5: reveal holds before auto-advancing; the host can skip with Next. */
export const REVEAL_HOLD_MS = 4_000;

/** §5: relaxed timers stretch setup, category vote, and entry only. */
export const RELAXED_MULTIPLIER = 1.5;

// --- Connection lifecycle (§14.4) -----------------------------------------

export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Past this, a player stops being waited on for votes. */
export const DISCONNECT_AFTER_MS = 20_000;
/** Past this, the player has departed: score frozen, host transfers. */
export const DEPART_AFTER_MS = 60_000;
/** §9.7: grace period when fewer than 2 humans remain connected. */
export const PAUSE_GRACE_MS = 60_000;
/** §4: rooms expire after 2h of inactivity. */
export const ROOM_IDLE_EXPIRY_MS = 2 * 60 * 60 * 1000;

// --- Computer (§9.1) ------------------------------------------------------

/**
 * Mixes uniform-random against win-rate-weighted selection. A weak Computer
 * turns 2-player games back into 1-1 ties, because both players skip its card,
 * so this is load-bearing. D7 targets a 20-30% Computer win rate.
 */
export const DEFAULT_COMPUTER_STRENGTH = 0.7;
/** Share of Computer picks drawn from promoted, player-originated items. */
export const WILDCARD_PICK_RATE = 0.1;
/** The same Computer item is not reused for a group within this many games. */
export const COMPUTER_VARIETY_WINDOW = 3;

// --- Final Showdown (§9.6) ------------------------------------------------

export const SHOWDOWN_MULTIPLIER = 2;

/** Which round numbers are double-points, per list length. */
export const SHOWDOWN_ROUNDS: Record<ListLength, readonly number[]> = {
  5: [5],
  10: [10],
  15: [13, 14, 15],
};

export function multiplierForRound(listLength: ListLength, roundNumber: number): 1 | 2 {
  // Defensive: a bad length should score as a normal round, not crash a live
  // reveal. TypeScript blocks this, but the value also arrives from the DB.
  const showdownRounds = SHOWDOWN_ROUNDS[listLength] ?? [];
  return showdownRounds.includes(roundNumber) ? SHOWDOWN_MULTIPLIER : 1;
}

// --- Room codes (§4) ------------------------------------------------------

/** I and O are excluded so they can't be misread as 1 and 0. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z]{4}$/;

export function applyRelaxed(baseMs: number, relaxed: boolean): number {
  return relaxed ? Math.round(baseMs * RELAXED_MULTIPLIER) : baseMs;
}
