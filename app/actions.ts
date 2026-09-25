'use server';

import { randomUUID } from 'node:crypto';
import {
  MAX_HUMANS,
  dedupeKey,
  toBallotText,
  validateEntry,
  validateName,
  type Intent,
  type ListLength,
  type SessionState,
} from '@/lib/engine';
import type { ActionResult, AddItemResult, JoinInfo, RoomSnapshot } from '@/lib/game/snapshot';
import { AuthError, verifyUser } from '@/lib/server/auth';
import { db, type Tx } from '@/lib/server/db';
import { isProfane } from '@/lib/server/profanity';
import { loadByCode, loadCategories, type CategoryRow, type LoadedRoom } from '@/lib/server/repo';
import { createRoom as createRoomRow, dictionaryFavorite, runIntent } from '@/lib/server/runner';
import { buildSnapshot, categoryOption, viewerSeat } from '@/lib/server/view';

/**
 * Server Actions, one per intent (§14.2). Every one is a public POST endpoint,
 * so each verifies the caller's token and seat before building an intent.
 * Clients send intents only; the engine decides what they mean.
 */

type Refusal = { refuse: string; code?: string };

const normalizeCode = (code: string) => code.trim().toUpperCase();

function failure(error: unknown): { ok: false; message: string; code?: string } {
  if (error instanceof AuthError) return { ok: false, message: error.message, code: 'auth' };
  console.error(error);
  return { ok: false, message: 'Something went wrong. Try again.', code: 'server' };
}

let categoryCache: { at: number; rows: CategoryRow[] } | null = null;
async function categories(): Promise<CategoryRow[]> {
  if (!categoryCache || Date.now() - categoryCache.at > 5 * 60_000) {
    categoryCache = { at: Date.now(), rows: await loadCategories(db()) };
  }
  return categoryCache.rows;
}

/**
 * Run an intent on behalf of the caller's seat. The builder sees the locked,
 * freshly loaded room, so its checks can't go stale before the write.
 */
async function asSeat(
  token: string,
  roomCode: string,
  build: (seatId: string, loaded: LoadedRoom, tx: Tx) => Intent | Refusal | Promise<Intent | Refusal>,
): Promise<ActionResult> {
  try {
    const userId = await verifyUser(token);
    const outcome = await runIntent({ roomCode: normalizeCode(roomCode) }, (loaded, tx) => {
      const seat = viewerSeat(loaded.state, userId);
      if (!seat) return { refuse: "You don't have a seat in this room", code: 'not_seated' };
      return build(seat.id, loaded, tx);
    });
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message, code: outcome.code };
  } catch (error) {
    return failure(error);
  }
}

// --- Rooms and seats ------------------------------------------------------------

function checkName(raw: string, state: SessionState | null) {
  const takenLower = new Set(
    (state?.players ?? []).filter((p) => p.leftAt === null).map((p) => p.name.toLocaleLowerCase('en-US')),
  );
  return validateName(raw, { takenLower, isProfane });
}

/** §4: New Game. The host is seated as Player 1, the Computer beside them. */
export async function createRoom(token: string, name: string): Promise<ActionResult<{ roomCode: string }>> {
  try {
    const userId = await verifyUser(token);
    const checked = checkName(name, null);
    if (!checked.ok) return { ok: false, message: checked.message, code: checked.reason };
    const state = await createRoomRow(userId, checked.name);
    return { ok: true, roomCode: state.roomCode };
  } catch (error) {
    return failure(error);
  }
}

/** §6: what a joiner sees before they pick a name. */
export async function lookupRoom(token: string, roomCode: string): Promise<ActionResult<{ info: JoinInfo }>> {
  try {
    const userId = await verifyUser(token);
    const code = normalizeCode(roomCode);
    const loaded = /^[A-Z]{4}$/.test(code) ? await loadByCode(db(), code, false) : null;
    const info: JoinInfo = { status: 'not_found', roomCode: code, rejoinable: [] };
    if (!loaded) return { ok: true, info };

    const { state } = loaded;
    if (state.status === 'closed') return { ok: true, info: { ...info, status: 'closed' } };

    const seat = viewerSeat(state, userId);
    if (seat && seat.leftAt === null) return { ok: true, info: { ...info, status: 'seated' } };

    const seatedHumans = state.players.filter((p) => !p.isComputer && !p.queued && p.leftAt === null);
    info.rejoinable = state.players
      .filter(
        (p) =>
          !p.isComputer &&
          !p.queued &&
          (p.disconnectedAt !== null || (p.leftAt !== null && state.status !== 'lobby')),
      )
      .map((p) => ({ playerId: p.id, name: p.name }));

    if (state.status !== 'lobby') info.status = 'in_progress';
    else info.status = seatedHumans.length >= MAX_HUMANS ? 'full' : 'open';
    return { ok: true, info };
  } catch (error) {
    return failure(error);
  }
}

/** §5: join with a name; mid-game joiners are queued for the next game (§6). */
export async function joinRoom(token: string, roomCode: string, name: string): Promise<ActionResult> {
  try {
    const userId = await verifyUser(token);
    const outcome = await runIntent({ roomCode: normalizeCode(roomCode) }, ({ state }) => {
      if (state.status === 'closed') return { refuse: 'This room was closed', code: 'room_closed' };
      const seat = viewerSeat(state, userId);
      if (seat && seat.leftAt === null) return { refuse: 'already seated', code: 'already_seated' };
      const checked = checkName(name, state);
      if (!checked.ok) return { refuse: checked.message, code: checked.reason };
      return { type: 'join', playerId: randomUUID(), userId, name: checked.name };
    });
    if (!outcome.ok && outcome.code === 'already_seated') return { ok: true };
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message, code: outcome.code };
  } catch (error) {
    return failure(error);
  }
}

/** §6: "Rejoin as Maya?" -- take over a disconnected seat and its score. */
export async function rejoinSeat(token: string, roomCode: string, playerId: string): Promise<ActionResult> {
  try {
    const userId = await verifyUser(token);
    const outcome = await runIntent({ roomCode: normalizeCode(roomCode) }, ({ state }) => {
      const seat = viewerSeat(state, userId);
      if (seat && seat.leftAt === null) return { refuse: 'You already have a seat here', code: 'already_seated' };
      return { type: 'rejoin_seat', playerId, userId };
    });
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message, code: outcome.code };
  } catch (error) {
    return failure(error);
  }
}

export async function getSnapshot(token: string, roomCode: string): Promise<ActionResult<{ snapshot: RoomSnapshot }>> {
  try {
    const userId = await verifyUser(token);
    const loaded = await loadByCode(db(), normalizeCode(roomCode), false);
    if (!loaded) return { ok: false, message: 'Room not found', code: 'not_found' };
    return { ok: true, snapshot: buildSnapshot(loaded.state, userId, await categories(), loaded.dbNow) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * §14.4: the authoritative connection signal. It also returns the room
 * version, so a client that missed a broadcast notices and refetches.
 */
export async function heartbeat(token: string, roomCode: string): Promise<ActionResult<{ version: number }>> {
  try {
    const userId = await verifyUser(token);
    const [row] = await db()`
      with room as (
        select id, version from this_or_that.sessions
         where room_code = ${normalizeCode(roomCode)} and status <> 'closed'
         order by created_at desc limit 1
      ), seen as (
        update this_or_that.players p
           set last_seen_at = now(), disconnected_at = null
          from room
         where p.session_id = room.id and p.user_id = ${userId}
           and p.left_at is null and p.released_at is null
      )
      select version from room`;
    return { ok: true, version: row ? row.version : -1 };
  } catch (error) {
    return failure(error);
  }
}

export async function leaveRoom(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'leave', playerId: seatId }));
}

export async function removePlayer(token: string, roomCode: string, targetPlayerId: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'remove_player', actorId: seatId, targetPlayerId }));
}

export async function setRelaxedTimers(token: string, roomCode: string, relaxedTimers: boolean) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'update_settings', actorId: seatId, relaxedTimers }));
}

export async function startGame(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'start_game', actorId: seatId }));
}

export async function closeRoom(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'close_room', actorId: seatId }));
}

/** §11 New Room: close this one and open a fresh one with a new code. */
export async function newRoom(token: string, roomCode: string): Promise<ActionResult<{ roomCode: string }>> {
  try {
    const userId = await verifyUser(token);
    let hostName = '';
    const outcome = await runIntent({ roomCode: normalizeCode(roomCode) }, ({ state }) => {
      const seat = viewerSeat(state, userId);
      if (!seat) return { refuse: "You don't have a seat in this room" };
      hostName = seat.name;
      return { type: 'close_room', actorId: seat.id };
    });
    if (!outcome.ok) return { ok: false, message: outcome.message, code: outcome.code };
    const state = await createRoomRow(userId, hostName);
    return { ok: true, roomCode: state.roomCode };
  } catch (error) {
    return failure(error);
  }
}

// --- Setup -------------------------------------------------------------------------

export async function confirmSetup(token: string, roomCode: string, categoryId: number, listLength: number) {
  const rows = await categories();
  return asSeat(token, roomCode, (seatId) => {
    const option = rows.find((c) => c.id === categoryId);
    const allowed = option ? categoryOption(option) : null;
    // §7: only the lengths the category's size class (and dictionary) allow.
    if (!allowed || !allowed.allowedLengths.includes(listLength as ListLength)) {
      return { refuse: 'That list length is not allowed for this category', code: 'invalid_length' };
    }
    return { type: 'confirm_setup', actorId: seatId, categoryId, listLength: listLength as ListLength };
  });
}

// --- Entering items ---------------------------------------------------------------

/**
 * §8 Add. Validates, then spell-checks against the category dictionary:
 * an exact match takes the canonical spelling, a close match asks "Did you
 * mean…?", and anything else is accepted as typed.
 *
 * `choice` answers a suggestion: 'suggestion' takes the dictionary item,
 * 'mine' keeps what was typed.
 */
export async function addItem(
  token: string,
  roomCode: string,
  text: string,
  choice?: { kind: 'suggestion'; dictionaryId: number } | { kind: 'mine' },
): Promise<ActionResult<AddItemResult>> {
  try {
    const userId = await verifyUser(token);
    const code = normalizeCode(roomCode);

    // The spell check reads outside the room lock; the write re-validates inside it.
    const peek = await loadByCode(db(), code, false);
    const categoryId = peek?.state.game?.categoryId;
    if (!peek || categoryId == null || peek.state.status !== 'entering') {
      return { ok: false, message: "That action isn't available right now", code: 'wrong_phase' };
    }

    let canonical: { id: number; canonicalName: string } | null = null;
    if (choice?.kind === 'suggestion') {
      const [row] = await db()`
        select id, canonical_name from this_or_that.dictionary
         where id = ${choice.dictionaryId} and category_id = ${categoryId}`;
      if (row) canonical = { id: Number(row.id), canonicalName: row.canonical_name };
    } else {
      const matches = await db()`
        select dictionary_id, canonical_name, score
          from this_or_that.match_item(${categoryId}::smallint, ${text}, 1)`;
      const best = matches[0];
      if (best && Number(best.score) >= 0.999) {
        canonical = { id: Number(best.dictionary_id), canonicalName: best.canonical_name };
      } else if (best && choice?.kind !== 'mine') {
        const checked = validateEntry(text, { existingKeys: new Set(), isProfane });
        if (!checked.ok) return { ok: false, message: checked.message, code: checked.reason };
        return { ok: true, suggestion: { dictionaryId: Number(best.dictionary_id), name: best.canonical_name } };
      }
    }

    let acceptedAsTyped: string | null = null;
    const outcome = await runIntent({ roomCode: code }, ({ state }) => {
      const seat = viewerSeat(state, userId);
      if (!seat || seat.queued) return { refuse: "You don't have a seat in this room", code: 'not_seated' };
      const own = state.game?.favorites.filter((f) => f.playerId === seat.id) ?? [];
      const existingKeys = new Set(own.map((f) => dedupeKey(f.displayText)));
      const position = (() => {
        const used = new Set(own.map((f) => f.entryPosition));
        let p = 1;
        while (used.has(p)) p += 1;
        return p;
      })();

      if (canonical) {
        if (own.some((f) => f.canonicalItemId === canonical!.id) || existingKeys.has(dedupeKey(canonical.canonicalName))) {
          return { refuse: 'Already on your list', code: 'duplicate' };
        }
        return { type: 'add_item', playerId: seat.id, favorite: dictionaryFavorite(canonical, seat.id, position) };
      }

      const checked = validateEntry(text, { existingKeys, isProfane });
      if (!checked.ok) return { refuse: checked.message, code: checked.reason };
      acceptedAsTyped = checked.displayText;
      return {
        type: 'add_item',
        playerId: seat.id,
        favorite: {
          id: randomUUID(),
          playerId: seat.id,
          entryPosition: position,
          displayText: checked.displayText,
          ballotText: toBallotText(checked.displayText),
          canonicalItemId: null,
          autoPicked: false,
          surprisePicked: false,
          shuffledPosition: null,
        },
      };
    });
    if (!outcome.ok) return { ok: false, message: outcome.message, code: outcome.code };

    // §8 dictionary growth: log what was accepted as typed, for manual promotion.
    if (acceptedAsTyped) {
      await db()`
        insert into this_or_that.unmatched_entries (category_id, normalized_text)
        values (${categoryId}, ${toBallotText(acceptedAsTyped)})
        on conflict (category_id, normalized_text) do update
          set distinct_player_count = this_or_that.unmatched_entries.distinct_player_count + 1,
              last_seen_at = now()`;
    }
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** §8 Surprise me: a random dictionary item not already on this list, tagged 🎲. */
export async function surpriseMe(token: string, roomCode: string) {
  // The lookup runs on the room's own transaction. Asking the pool for a
  // second connection while holding one can exhaust it under load.
  return asSeat(token, roomCode, async (seatId, loaded, tx) => {
    const game = loaded.state.game;
    if (!game?.categoryId || loaded.state.status !== 'entering') {
      return { refuse: "That action isn't available right now", code: 'wrong_phase' };
    }
    const own = game.favorites.filter((f) => f.playerId === seatId);
    const ids = own.map((f) => f.canonicalItemId).filter((id): id is number => id !== null);
    const keys = own.map((f) => dedupeKey(f.displayText));
    const candidates = await tx`
      select id, canonical_name from this_or_that.dictionary
       where category_id = ${game.categoryId} and not (id = any(${ids}::bigint[]))
       order by random() limit 20`;
    const pick = candidates.find((c) => !keys.includes(dedupeKey(c.canonical_name)));
    if (!pick) return { refuse: 'Out of surprises for this category', code: 'empty' };
    const used = new Set(own.map((f) => f.entryPosition));
    let position = 1;
    while (used.has(position)) position += 1;
    return {
      type: 'add_item',
      playerId: seatId,
      favorite: dictionaryFavorite({ id: Number(pick.id), canonicalName: pick.canonical_name }, seatId, position, {
        surprisePicked: true,
      }),
    };
  });
}

export async function removeItem(token: string, roomCode: string, favoriteId: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'remove_item', playerId: seatId, favoriteId }));
}

export async function submitList(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'submit_list', playerId: seatId }));
}

export async function editList(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'edit_list', playerId: seatId }));
}

// --- Match-ups and results -----------------------------------------------------

export async function castVote(token: string, roomCode: string, ballotCardId: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'cast_vote', playerId: seatId, ballotCardId }));
}

export async function nextRound(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'next', actorId: seatId }));
}

export async function endGame(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'end_game', actorId: seatId }));
}

export async function playAgain(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'play_again', actorId: seatId }));
}
