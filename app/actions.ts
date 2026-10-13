'use server';

import { randomUUID } from 'node:crypto';
import {
  MAX_HUMANS,
  dedupeKey,
  toBallotText,
  validateEntry,
  validateName,
  GAME_MODES,
  isChampionReignCap,
  type GameMode,
  type Intent,
  type ListLength,
  type SessionState,
} from '@/lib/engine';
import type {
  ActionResult,
  AddItemResult,
  CategoryOption,
  CustomCategoryResult,
  JoinInfo,
  RoomSnapshot,
} from '@/lib/game/snapshot';
import { AuthError, verifyUser } from '@/lib/server/auth';
import { db, type Tx } from '@/lib/server/db';
import { isProfane } from '@/lib/server/profanity';
import {
  loadByCode,
  loadCategories,
  loadCategoryUsage,
  loadRoomCategories,
  type CategoryRow,
  type CategoryUsage,
  type LoadedRoom,
} from '@/lib/server/repo';
import { GenerationUnavailable, categoryGenerator } from '@/lib/server/categoryGen';
import {
  BORROW_BELOW,
  BUILDS_PER_GAME,
  BUILDS_PER_HOUR,
  loadDictionaryIndex,
  suggestBorrow,
  type DictionaryIndex,
  attachToRoom,
  checkCategoryName,
  closestBuiltin,
  examplesFor,
  findGenerated,
  generateItems,
  recentBuilds,
  storeCategory,
} from '@/lib/server/customCategory';
import {
  createRoom as createRoomRow,
  dictionaryFavorite,
  runIntent,
  seedFor,
  type RunOutcome,
} from '@/lib/server/runner';
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

let categoryCache: { at: number; rows: CategoryRow[]; usage: CategoryUsage } | null = null;
async function loadCategoryCache() {
  if (!categoryCache || Date.now() - categoryCache.at > 5 * 60_000) {
    const [rows, usage] = await Promise.all([loadCategories(db()), loadCategoryUsage(db())]);
    categoryCache = { at: Date.now(), rows, usage };
  }
  return categoryCache;
}
async function categories(): Promise<CategoryRow[]> {
  return (await loadCategoryCache()).rows;
}
/** Plays per category and mode, for the top-5 chips in setup. Refreshed with the categories. */
async function categoryUsage(): Promise<CategoryUsage> {
  return (await loadCategoryCache()).usage;
}

/**
 * Built-ins plus the room's own custom categories (custom-category spec §3.7),
 * and whatever its current game is playing.
 */
async function roomCategories(state: SessionState): Promise<CategoryRow[]> {
  const custom = await loadRoomCategories(db(), state.id, state.game?.categoryId ?? null);
  const builtins = await categories();
  const index = custom.some((c) => c.dictionarySize < BORROW_BELOW) ? await dictionaryIndex() : null;
  return [
    ...builtins,
    ...custom.map((row) =>
      index && row.dictionarySize < BORROW_BELOW
        ? { ...row, borrowSuggestionId: suggestBorrow(row.name, builtins, index)?.id ?? null }
        : row,
    ),
  ];
}

let indexCache: { at: number; index: DictionaryIndex } | null = null;
/** Every built-in item and alias, for the closest-category guess (§4.5). */
async function dictionaryIndex(): Promise<DictionaryIndex> {
  if (!indexCache || Date.now() - indexCache.at > 5 * 60_000) {
    indexCache = { at: Date.now(), index: await loadDictionaryIndex(db()) };
  }
  return indexCache.index;
}

/**
 * Run an intent on behalf of the caller's seat. The builder sees the locked,
 * freshly loaded room, so its checks can't go stale before the write.
 */
async function asSeat(
  token: string,
  roomCode: string,
  build: (seatId: string, loaded: LoadedRoom, tx: Tx) => Intent | Refusal | Promise<Intent | Refusal>,
): Promise<ActionResult<{ snapshot: RoomSnapshot }>> {
  try {
    const userId = await verifyUser(token);
    const outcome = await runIntent({ roomCode: normalizeCode(roomCode) }, (loaded, tx) => {
      const seat = viewerSeat(loaded.state, userId);
      if (!seat) return { refuse: "You don't have a seat in this room", code: 'not_seated' };
      return build(seat.id, loaded, tx);
    });
    if (!outcome.ok) return { ok: false, message: outcome.message, code: outcome.code };
    return { ok: true, snapshot: await snapshotFor(outcome, userId) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * The caller's view of the room right after their own action, from the state
 * the action just committed. The phone applies it at once, instead of
 * depending on a second request (or a broadcast) to see what it just did.
 */
async function snapshotFor(outcome: Extract<RunOutcome, { ok: true }>, userId: string): Promise<RoomSnapshot> {
  return buildSnapshot(
    outcome.state,
    userId,
    await roomCategories(outcome.state),
    outcome.loaded.dbNow,
    seedFor(outcome.loaded.seedHex),
    await categoryUsage(),
  );
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
    return {
      ok: true,
      snapshot: buildSnapshot(
        loaded.state,
        userId,
        await roomCategories(loaded.state),
        loaded.dbNow,
        seedFor(loaded.seedHex),
        await categoryUsage(),
      ),
    };
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

/** §5 lobby setting: the Computer can sit out when there are 3+ humans. */
export async function setComputerPlayer(token: string, roomCode: string, computerPlayer: boolean) {
  return asSeat(token, roomCode, (seatId) => ({ type: 'update_settings', actorId: seatId, computerPlayer }));
}

/** Mode spec v0.4 lobby setting: Pick and fwd champions retire after 3, 5, or never. */
export async function setChampionReignCap(token: string, roomCode: string, championReignCap: number | null) {
  return asSeat(token, roomCode, (seatId) => {
    if (!isChampionReignCap(championReignCap)) return { refuse: 'Choose 3, 5 or never', code: 'invalid_cap' };
    return { type: 'update_settings', actorId: seatId, championReignCap };
  });
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

/** Mode spec §3: the first setup step, so the server knows the mode if the timer runs out. */
export async function selectMode(token: string, roomCode: string, mode: GameMode) {
  return asSeat(token, roomCode, (seatId) => {
    if (!GAME_MODES.includes(mode)) return { refuse: 'Unknown game mode', code: 'invalid_mode' };
    return { type: 'select_mode', actorId: seatId, mode };
  });
}

export async function confirmSetup(
  token: string,
  roomCode: string,
  categoryId: number,
  listLength: number,
  mode?: GameMode,
  spellCheck?: boolean,
  borrowCategoryId?: number | null,
) {
  const builtins = await categories();
  return asSeat(token, roomCode, async (seatId, loaded, tx) => {
    if (mode !== undefined && !GAME_MODES.includes(mode)) return { refuse: 'Unknown game mode', code: 'invalid_mode' };
    // Custom-category spec §9.2: a custom category must be this room's own --
    // built or reused here -- so another room's can't be confirmed by its id.
    const option =
      builtins.find((c) => c.id === categoryId) ??
      (await loadRoomCategories(tx, loaded.state.id, null)).find((c) => c.id === categoryId);
    const allowed = option ? categoryOption(option) : null;
    // §7: only the lengths the category's size class (and dictionary) allow.
    if (!allowed || !allowed.allowedLengths.includes(listLength as ListLength)) {
      return { refuse: 'That list length is not allowed for this category', code: 'invalid_length' };
    }
    // §4.5: only a short custom category borrows, and only from a built-in.
    let borrow: number | null = null;
    if (borrowCategoryId != null) {
      const source = builtins.find((c) => c.id === borrowCategoryId);
      if (!option?.isCustom || option.dictionarySize >= BORROW_BELOW || !source) {
        return { refuse: "That category can't borrow suggestions", code: 'invalid_borrow' };
      }
      borrow = source.id;
    }
    if (option?.isCustom) await tx`update this_or_that.categories set last_used_at = now() where id = ${categoryId}`;
    return {
      type: 'confirm_setup',
      actorId: seatId,
      categoryId,
      listLength: listLength as ListLength,
      mode,
      // Built-in categories always spell-check (§5.3, decision C5).
      spellCheck: option?.isCustom ? spellCheck !== false : true,
      borrowCategoryId: borrow,
    };
  });
}

// --- Custom categories (custom-category spec, Part A) ---------------------------------

type CustomResult = ActionResult<{ result: CustomCategoryResult }>;

/** The host, in setup, in this room: the only one who can build a category. */
async function hostInSetup(token: string, roomCode: string) {
  const userId = await verifyUser(token);
  const loaded = await loadByCode(db(), normalizeCode(roomCode), false);
  if (!loaded) return { error: { ok: false as const, message: 'Room not found', code: 'not_found' } };
  const seat = viewerSeat(loaded.state, userId);
  if (!seat || loaded.state.hostPlayerId !== seat.id) {
    return { error: { ok: false as const, message: 'Only the host can do that', code: 'not_host' } };
  }
  if (loaded.state.status !== 'setup' || !loaded.state.game) {
    return { error: { ok: false as const, message: "That action isn't available right now", code: 'wrong_phase' } };
  }
  return { userId, seatId: seat.id, loaded };
}

async function readyResult(row: CategoryRow, reused: boolean, note: string | null): Promise<CustomCategoryResult> {
  const borrowSuggestionId =
    row.dictionarySize < BORROW_BELOW ? (suggestBorrow(row.name, await categories(), await dictionaryIndex())?.id ?? null) : null;
  return {
    kind: 'ready',
    category: categoryOption({ ...row, borrowSuggestionId }) as CategoryOption,
    examples: row.dictionarySize > 0 ? await examplesFor(db(), row.id) : [],
    reused,
    note,
  };
}

/** §3.6: tell everyone a build is running (and extend the timer once), or clear it. */
async function holdSetup(roomCode: string, seatId: string, name: string | null) {
  return runIntent({ roomCode: normalizeCode(roomCode) }, () => ({ type: 'hold_setup', actorId: seatId, name }));
}

/**
 * §3.1-§3.6: build a custom category, or reuse one built before. `makeMyOwn`
 * skips the "we already have Fruit" suggestion.
 */
export async function buildCustomCategory(
  token: string,
  roomCode: string,
  rawName: string,
  makeMyOwn = false,
): Promise<CustomResult> {
  try {
    const host = await hostInSetup(token, roomCode);
    if ('error' in host) return host.error!;
    const { loaded, seatId } = host;
    const checked = checkCategoryName(rawName);
    if (!checked.ok) return { ok: false, message: checked.message, code: checked.code };

    // §5.4: the room's own row, with whatever it has learned, before anything else.
    const ownRow = (await loadRoomCategories(db(), loaded.state.id, null)).find(
      (c) => dedupeKey(c.name) === checked.key,
    );
    if (ownRow) return { ok: true, result: await readyResult(ownRow, true, null) };

    const builtins = await categories();
    if (!makeMyOwn) {
      const builtin = closestBuiltin(checked.name, builtins);
      const option = builtin ? categoryOption(builtin) : null;
      if (option) return { ok: true, result: { kind: 'builtin', category: option } };
    }

    // §7.2: built before, here or in any room -- reuse it, no API call.
    const existing = await findGenerated(db(), checked.key);
    if (existing) {
      await attachToRoom(db(), loaded.state.id, existing.id);
      return { ok: true, result: await readyResult(existing, true, null) };
    }

    const generator = categoryGenerator();
    const sessionId = loaded.state.id;
    const withoutSuggestions = async (note: string | null) => {
      const row = await storeCategory(db(), {
        name: checked.name, key: checked.key, sessionId, generated: false, model: null,
        singular: null, plural: null, items: [],
      });
      return { ok: true as const, result: await readyResult(row, false, note) };
    };

    // §8.1: no API key means no build at all; the category plays without suggestions.
    if (!generator) return withoutSuggestions(null);

    // §8.3: rate limits count only builds that called the API.
    const builds = await recentBuilds(db(), sessionId, loaded.state.game!.startedAt);
    if (builds.thisGame >= BUILDS_PER_GAME || builds.lastHour >= BUILDS_PER_HOUR) {
      return withoutSuggestions("That's a lot of new categories — this one's without suggestions.");
    }

    await holdSetup(roomCode, seatId, checked.name);
    try {
      const built = await generateItems(generator, checked.name);
      const row = await storeCategory(db(), {
        name: checked.name, key: checked.key, sessionId, generated: true, model: generator.model,
        singular: built.singular, plural: built.plural, items: built.items,
      });
      return { ok: true, result: await readyResult(row, false, null) };
    } catch (error) {
      if (!(error instanceof GenerationUnavailable)) throw error;
      return {
        ok: true,
        result: {
          kind: 'failed',
          name: checked.name,
          message: `Couldn't find suggestions for ${checked.name}`,
          canRetry: true,
        },
      };
    } finally {
      await holdSetup(roomCode, seatId, null);
    }
  } catch (error) {
    return failure(error);
  }
}

/** §3.6: the build couldn't run; play the category without suggestions. */
export async function playWithoutSuggestions(
  token: string,
  roomCode: string,
  rawName: string,
): Promise<CustomResult> {
  try {
    const host = await hostInSetup(token, roomCode);
    if ('error' in host) return host.error!;
    const checked = checkCategoryName(rawName);
    if (!checked.ok) return { ok: false, message: checked.message, code: checked.code };
    const row = await storeCategory(db(), {
      name: checked.name, key: checked.key, sessionId: host.loaded.state.id, generated: false, model: null,
      singular: null, plural: null, items: [],
    });
    return { ok: true, result: await readyResult(row, false, null) };
  } catch (error) {
    return failure(error);
  }
}

/** §3.6 Cancel: stop showing "building…" to everyone. A late result is still saved for reuse. */
export async function cancelCustomCategory(token: string, roomCode: string) {
  return asSeat(token, roomCode, (seatId, loaded) => {
    if (loaded.state.hostPlayerId !== seatId) return { refuse: 'Only the host can do that', code: 'not_host' };
    return { type: 'hold_setup', actorId: seatId, name: null };
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
): Promise<ActionResult<AddItemResult & { snapshot?: RoomSnapshot }>> {
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
          from this_or_that.match_item(${categoryId}::int, ${text}, 1)`;
      const best = matches[0];
      if (best && Number(best.score) >= 0.999) {
        canonical = { id: Number(best.dictionary_id), canonicalName: best.canonical_name };
      } else if (best && choice?.kind !== 'mine' && peek.state.game?.spellCheck !== false) {
        // Custom-category spec §5.3: with spell check off there's no "Did you
        // mean…?", but exact matches above still link so duplicates merge.
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
    return { ok: true, snapshot: await snapshotFor(outcome, userId) };
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
    // Custom-category spec §4.5: a custom category's own items come first,
    // then the built-in it borrows from, if any.
    const borrow = game.borrowCategoryId ?? game.categoryId;
    const candidates = await tx`
      select id, canonical_name from this_or_that.dictionary
       where category_id in (${game.categoryId}, ${borrow}) and not (id = any(${ids}::bigint[]))
         and retired_at is null   -- retired items are never suggested (custom-category spec §B5)
       order by (category_id = ${game.categoryId}) desc, random() limit 20`;
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
