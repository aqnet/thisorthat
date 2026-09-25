import 'server-only';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  COMPUTER_COLOR_SLOT,
  COMPUTER_VARIETY_WINDOW,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  activeHumans,
  apply,
  createRng,
  dedupeKey,
  pickComputerItems,
  scoreMatchup,
  seedFromBytes,
  standings,
  toBallotText,
  type DictionaryEntry,
  type EngineEvent,
  type Favorite,
  type Intent,
  type ListLength,
  type SessionState,
} from '@/lib/engine';
import { db, type Tx } from './db';
import { isProfane } from './profanity';
import { loadById, loadByCode, loadCategories, saveState, VersionConflict, type LoadedRoom } from './repo';
import { categoryOption } from './view';

/**
 * The server side of §14.2: load the room, run the pure engine, persist the
 * result and its broadcast in one transaction.
 *
 * The session row is locked for the length of the transaction, so two
 * actions on the same room run one after the other rather than racing. The
 * version check in saveState stays as a second guard.
 */

export type RunOutcome =
  | { ok: true; state: SessionState; loaded: LoadedRoom }
  | { ok: false; code: string; message: string };

/** Build the intent from the freshly loaded room, or refuse with copy. */
export type IntentBuilder = (
  loaded: LoadedRoom,
  tx: Tx,
) => Promise<Intent | { refuse: string; code?: string }> | Intent | { refuse: string; code?: string };

interface Target {
  roomCode?: string;
  sessionId?: string;
}

export async function runIntent(target: Target, build: IntentBuilder): Promise<RunOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db().begin((tx) => runOnce(tx, target, build));
    } catch (error) {
      // One retry on a version conflict (§14.2); anything else is a real error.
      if (!(error instanceof VersionConflict) || attempt === 1) throw error;
    }
  }
  throw new Error('unreachable');
}

async function runOnce(tx: Tx, target: Target, build: IntentBuilder): Promise<RunOutcome> {
  const loaded = target.sessionId
    ? await loadById(tx, target.sessionId, true)
    : await loadByCode(tx, target.roomCode!, true);
  if (!loaded) return { ok: false, code: 'not_found', message: 'Room not found' };

  const built = await build(loaded, tx);
  if ('refuse' in built) return { ok: false, code: built.code ?? 'refused', message: built.refuse };

  const before = loaded.state;
  const now = loaded.dbNow;
  let seedHex = loaded.seedHex;
  const newId = () => randomUUID();

  const applied: { intent: Intent; version: number }[] = [];
  const events: EngineEvent[] = [];

  const step = (state: SessionState, intent: Intent): SessionState | { code: string; message: string } => {
    // A new game gets a fresh seed, stored with it for replay (§14.8).
    if (intent.type === 'start_game') seedHex = randomBytes(16).toString('hex');
    const result = apply(state, intent, { now, seed: seedFor(seedHex), newId });
    if (!result.ok) return { code: result.error, message: result.message };
    if (result.state.version !== state.version) applied.push({ intent, version: result.state.version });
    events.push(...result.events);
    return result.state;
  };

  let state = step(before, built);
  if ('code' in state) return { ok: false, code: state.code, message: state.message };

  // Server steps the pure engine hands back to its caller.
  for (let guard = 0; guard < 4; guard++) {
    if (state.status === 'computer_picking') {
      const intent = await lockListsIntent(tx, state, seedHex);
      const next = step(state, intent);
      if ('code' in next) throw new Error(`lock_lists refused: ${next.message}`);
      state = next;
      continue;
    }
    if (state.status === 'setup' && state.phaseDeadline !== null && now >= state.phaseDeadline) {
      const intent = await autoConfirmIntent(tx, state, seedHex);
      if (!intent) break;
      const next = step(state, intent);
      if ('code' in next) break;
      state = next;
      continue;
    }
    break;
  }

  // The engine always returns a copy, so compare content. An advance can mark a
  // seat disconnected without bumping the version, and that still has to land.
  if (JSON.stringify(state) === JSON.stringify(before)) {
    // Nothing moved (a no-op advance). Still record that the request landed.
    if (built.type === 'advance') {
      await tx`update this_or_that.sessions set advance_requested_at = null where id = ${state.id}`;
    }
    return { ok: true, state, loaded };
  }

  await saveState(tx, before, state, seedHex, { clearAdvanceRequest: built.type === 'advance' });
  await recordSideEffects(tx, before, state, events, loaded);

  for (const { intent, version } of applied) {
    await tx`
      insert into this_or_that.session_events (session_id, version, intent, actor_player_id, payload)
      values (${state.id}, ${version}, ${intent.type}, ${actorOf(intent)}, ${tx.json(logPayload(intent))})`;
  }

  if (state.version !== before.version) {
    // Sent from inside the transaction: delivered only if it commits (§14.6).
    await tx`select this_or_that.broadcast(${state.roomCode}, 'state', ${tx.json({ version: state.version, status: state.status })})`;
  }

  return { ok: true, state, loaded };
}

function seedFor(seedHex: string | null): number {
  return seedHex ? seedFromBytes(Buffer.from(seedHex, 'hex')) : 1;
}

function actorOf(intent: Intent): string | null {
  if ('actorId' in intent) return intent.actorId;
  if ('playerId' in intent) return intent.playerId;
  return null;
}

/** The event log keeps the intent, minus bulky server-built lists. */
function logPayload(intent: Intent): postgres.JSONValue {
  if (intent.type === 'lock_lists') {
    return { autoFill: intent.autoFill.length, computer: intent.computerItemIds };
  }
  return intent as unknown as postgres.JSONValue;
}

// --- Server steps ---------------------------------------------------------------

async function loadDictionary(tx: Tx, categoryId: number): Promise<DictionaryEntry[]> {
  const rows = await tx`
    select d.id, d.canonical_name, d.popular_tier, d.player_originated,
           coalesce(s.appearances, 0) as appearances,
           coalesce(s.votes_received, 0) as votes_received,
           coalesce(s.round_wins, 0) as round_wins
      from this_or_that.dictionary d
      left join this_or_that.item_stats s on s.dictionary_id = d.id
     where d.category_id = ${categoryId}
     order by d.id`;
  return rows.map((r) => ({
    id: Number(r.id),
    canonicalName: r.canonical_name,
    popularTier: r.popular_tier,
    playerOriginated: r.player_originated,
    appearances: r.appearances,
    votesReceived: r.votes_received,
    roundWins: r.round_wins,
  }));
}

function nextPosition(favorites: readonly Favorite[], playerId: string): number {
  const used = new Set(favorites.filter((f) => f.playerId === playerId).map((f) => f.entryPosition));
  let position = 1;
  while (used.has(position)) position += 1;
  return position;
}

export function dictionaryFavorite(
  entry: { id: number; canonicalName: string },
  playerId: string,
  entryPosition: number,
  flags: { autoPicked?: boolean; surprisePicked?: boolean } = {},
): Favorite {
  return {
    id: randomUUID(),
    playerId,
    entryPosition,
    displayText: entry.canonicalName,
    ballotText: toBallotText(entry.canonicalName),
    canonicalItemId: entry.id,
    autoPicked: flags.autoPicked ?? false,
    surprisePicked: flags.surprisePicked ?? false,
    shuffledPosition: null,
  };
}

/**
 * §8 and §9.1: fill every short human list from the dictionary, then build the
 * Computer's list from what's left. The Computer never plays an item that is
 * on a human list, auto-filled ones included.
 */
async function lockListsIntent(tx: Tx, state: SessionState, seedHex: string | null): Promise<Intent> {
  const game = state.game!;
  const listLength = game.listLength as ListLength;
  const dictionary = await loadDictionary(tx, game.categoryId!);
  const rng = createRng(seedFor(seedHex) ^ 0x9e3779b9);

  const all = [...game.favorites];
  const autoFill: Favorite[] = [];
  for (const player of activeHumans(state.players)) {
    const own = all.filter((f) => f.playerId === player.id);
    const takenIds = new Set(own.map((f) => f.canonicalItemId).filter((id) => id !== null));
    const takenKeys = new Set(own.map((f) => dedupeKey(f.displayText)));
    const pool = rng.shuffle(
      dictionary.filter((d) => !takenIds.has(d.id) && !takenKeys.has(dedupeKey(d.canonicalName))),
    );
    for (let missing = listLength - own.length; missing > 0; missing--) {
      const entry = pool.pop();
      if (!entry) break;
      const favorite = dictionaryFavorite(entry, player.id, nextPosition(all, player.id), { autoPicked: true });
      autoFill.push(favorite);
      all.push(favorite);
    }
  }

  const computer = state.players.find((p) => p.isComputer)!;
  const humanKeys = new Set(all.map((f) => dedupeKey(f.displayText)));
  const excluded = new Set<number>(
    dictionary
      .filter((d) => humanKeys.has(dedupeKey(d.canonicalName)))
      .map((d) => d.id)
      .concat(all.map((f) => f.canonicalItemId).filter((id): id is number => id !== null)),
  );

  // §9.1 variety: skip items this room's Computer played in its last few games.
  const recent = await tx`
    select distinct f.canonical_item_id as id
      from this_or_that.favorites f
      join this_or_that.games g on g.id = f.game_id
     where g.session_id = ${state.id}
       and g.id <> ${game.id}
       and g.number >= ${game.number - COMPUTER_VARIETY_WINDOW}
       and f.player_id = ${computer.id}
       and f.canonical_item_id is not null`;

  const picked = pickComputerItems({
    dictionary,
    listLength,
    excludedItemIds: excluded,
    recentItemIds: new Set(recent.map((r) => Number(r.id))),
    rng,
  });
  const computerFavorites = picked.items.map((entry, i) => dictionaryFavorite(entry, computer.id, i + 1));

  return {
    type: 'lock_lists',
    autoFill,
    computerFavorites,
    computerItemIds: picked.items.map((e) => e.id),
  };
}

/** §7: when the setup timer runs out, pick Random at the longest length up to 10. */
async function autoConfirmIntent(tx: Tx, state: SessionState, seedHex: string | null): Promise<Intent | null> {
  if (!state.hostPlayerId) return null;
  const options = (await loadCategories(tx)).map(categoryOption).filter((c) => c !== null);
  if (options.length === 0) return null;
  const rng = createRng(seedFor(seedHex) ^ 0x51ed270b);
  const category = options[rng.int(options.length)];
  const listLength = Math.max(...category.allowedLengths.filter((l) => l <= 10)) as ListLength;
  return { type: 'confirm_setup', actorId: state.hostPlayerId, categoryId: category.id, listLength };
}

// --- Side effects -----------------------------------------------------------------

async function recordSideEffects(
  tx: Tx,
  before: SessionState,
  after: SessionState,
  events: EngineEvent[],
  loaded: LoadedRoom,
): Promise<void> {
  const game = after.game;
  if (!game) return;

  // item_stats in the same transaction as each reveal (§14.8), so the
  // Computer learns from what humans actually vote for.
  for (const event of events) {
    if (event.type !== 'reveal') continue;
    const matchup = game.matchups.find((m) => m.roundNumber === event.roundNumber);
    if (!matchup) continue;
    const outcome = scoreMatchup(matchup, game.favorites);
    const top = Math.max(0, ...Object.values(outcome.votesByCard));
    const rows: { dictionary_id: number; votes: number; won: number }[] = [];
    for (const card of matchup.cards) {
      const votes = outcome.votesByCard[card.id] ?? 0;
      for (const favoriteId of card.ownerFavoriteIds) {
        const itemId = game.favorites.find((f) => f.id === favoriteId)?.canonicalItemId;
        if (itemId == null || rows.some((r) => r.dictionary_id === itemId)) continue;
        rows.push({ dictionary_id: itemId, votes, won: top > 0 && votes === top ? 1 : 0 });
      }
    }
    if (rows.length) {
      await tx`
        insert into this_or_that.item_stats as s (dictionary_id, appearances, votes_received, round_wins, updated_at)
        select r.dictionary_id, 1, r.votes, r.won, now()
          from jsonb_to_recordset(${tx.json(rows)}) as r(dictionary_id bigint, votes int, won int)
        on conflict (dictionary_id) do update
          set appearances = s.appearances + 1,
              votes_received = s.votes_received + excluded.votes_received,
              round_wins = s.round_wins + excluded.round_wins,
              updated_at = now()`;
    }
  }

  if (before.status === 'results' || after.status !== 'results') return;

  // Final standings, written once (§14.7).
  const rows = standings(after);
  const humanMax = rows.find((r) => r.maxPossible !== null)?.maxPossible ?? 0;
  const results = rows.map((r) => ({
    game_id: game.id,
    player_id: r.playerId,
    score: r.score,
    max_possible: r.maxPossible ?? humanMax,
    pct: r.pct ?? (humanMax > 0 ? Math.min(100, Math.round((100 * r.score) / humanMax)) : 0),
    round_wins: r.roundWins,
    rank: r.rank,
  }));
  if (results.length) {
    await tx`
      insert into this_or_that.game_results
      select * from jsonb_populate_recordset(null::this_or_that.game_results, ${tx.json(results)})
      on conflict do nothing`;
  }

  // §12: humans only, completed games only, computed here and never by a client.
  if (game.endedEarly || game.listLength === null || game.humanCount === null || game.categoryId === null) return;
  const players = new Map(after.players.map((p) => [p.id, p]));
  const scores = rows
    .filter((r) => !r.isComputer && r.maxPossible !== null && players.get(r.playerId)?.leftAt === null)
    .map((r) => ({
      game_id: game.id,
      player_name: r.name,
      score: r.score,
      max_possible: r.maxPossible,
      pct: r.pct,
      list_length: game.listLength,
      human_count: game.humanCount,
      category_id: game.categoryId,
      device_group_id: loaded.deviceGroupId,
    }));
  if (scores.length) {
    await tx`
      insert into this_or_that.high_scores
        (game_id, player_name, score, max_possible, pct, list_length, human_count, category_id, device_group_id, board_week)
      select r.game_id, r.player_name, r.score, r.max_possible, r.pct, r.list_length, r.human_count,
             r.category_id, r.device_group_id,
             date_trunc('week', now() at time zone 'America/Los_Angeles')::date
        from jsonb_to_recordset(${tx.json(scores)}) as r(
          game_id uuid, player_name text, score int, max_possible int, pct smallint,
          list_length smallint, human_count smallint, category_id smallint, device_group_id uuid)`;
  }
}

// --- Creating a room -------------------------------------------------------------

/** §4: 4 letters, no I or O, never an offensive word, unique among open rooms. */
function roomCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!isProfane(code)) return code;
  }
}

/**
 * §4: a new session with the Computer seated, then the host joins through the
 * engine like anyone else -- which is what makes them the host.
 */
export async function createRoom(userId: string, name: string): Promise<SessionState> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db().begin(async (tx) => {
        const [{ now }] = await tx`select floor(extract(epoch from now()) * 1000)::float8 as now`;
        const nowMs = Number(now);
        const empty: SessionState = {
          id: randomUUID(),
          roomCode: roomCode(),
          status: 'lobby',
          version: 0,
          hostPlayerId: null,
          phaseDeadline: null,
          relaxedTimers: false,
          categoryVoteEnabled: false,
          players: [
            {
              id: randomUUID(),
              userId: null,
              isComputer: true,
              name: 'Computer',
              colorSlot: COMPUTER_COLOR_SLOT,
              isHost: false,
              queued: false,
              joinedAt: nowMs,
              lastSeenAt: nowMs,
              disconnectedAt: null,
              leftAt: null,
            },
          ],
          game: null,
          lastActivityAt: nowMs,
          closedAt: null,
          pausedUntil: null,
          pausedFrom: null,
        };
        const result = apply(
          empty,
          { type: 'join', playerId: randomUUID(), userId, name },
          { now: nowMs, seed: 1, newId: randomUUID },
        );
        if (!result.ok) throw new Error(result.message);
        await saveState(tx, null, result.state, null);
        return result.state;
      });
    } catch (error) {
      // A code collision with an open room: draw another.
      const unique = (error as { code?: string }).code === '23505';
      if (!unique || attempt >= 5) throw error;
    }
  }
}
