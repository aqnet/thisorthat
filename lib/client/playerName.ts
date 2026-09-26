'use client';

/**
 * The player's name, remembered in this browser once they've played a game
 * through to the results (as host or player). New Game and Join pre-fill it,
 * and it stays editable: finishing a game under a new name remembers that one.
 *
 * Per browser only, like the theme; nothing is stored on the server. Storage
 * can be unavailable (private browsing, blocked site data), so every access is
 * guarded and a missing name just means an empty field.
 */
import type { RoomSnapshot } from '@/lib/game/snapshot';

const KEY = 'tot.playerName';

/**
 * The name to remember from this snapshot, if any: only once the viewer has
 * reached the results as a seated player. A queued joiner only watched, and a
 * player who left didn't play it through.
 */
export function nameToRemember(snap: RoomSnapshot | null): string | undefined {
  if (!snap || snap.status !== 'results' || !snap.me || snap.me.queued || snap.me.left) return undefined;
  return snap.players.find((p) => p.id === snap.me!.playerId)?.name;
}

export function rememberedName(): string {
  try {
    return window.localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberName(name: string): void {
  try {
    window.localStorage.setItem(KEY, name);
  } catch {
    // Not remembering is fine; the player types their name next time.
  }
}
