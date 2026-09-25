import 'server-only';
import type postgres from 'postgres';
import {
  toBallotText,
  type BallotCard,
  type Favorite,
  type Game,
  type ListLength,
  type Matchup,
  type Player,
  type SessionState,
  type SessionStatus,
} from '@/lib/engine';

/**
 * The bridge between the engine's SessionState and the normalized tables in
 * the this_or_that schema (§14.7).
 *
 * Loading is one round trip: the room and its current game come back as a
 * single JSON document. Saving diffs the state before and after the intent
 * and writes only the rows that changed, so a vote costs one insert, not a
 * rewrite of the whole room.
 */

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;

export interface LoadedRoom {
  state: SessionState;
  /** games.rng_seed of the current game, hex. Null before the first game. */
  seedHex: string | null;
  deviceGroupId: string;
  /** The database clock at load, in ms. The engine's `now` (§14.3). */
  dbNow: number;
}

// --- Loading ----------------------------------------------------------------

const LOAD_COLUMNS = `
  s.*,
  floor(extract(epoch from now()) * 1000)::float8 as db_now,
  (select coalesce(json_agg(p order by p.joined_at), '[]')
     from this_or_that.players p
    where p.session_id = s.id and p.released_at is null) as players,
  (select row_to_json(g) from this_or_that.games g where g.id = s.current_game_id) as game,
  (select coalesce(json_agg(f), '[]')
     from this_or_that.favorites f where f.game_id = s.current_game_id) as favorites,
  (select coalesce(json_agg(m), '[]')
     from this_or_that.matchups m where m.game_id = s.current_game_id) as matchups,
  (select coalesce(json_agg(c), '[]')
     from this_or_that.ballot_cards c
     join this_or_that.matchups m on m.id = c.matchup_id
    where m.game_id = s.current_game_id) as cards,
  (select coalesce(json_agg(o), '[]')
     from this_or_that.ballot_card_owners o
     join this_or_that.ballot_cards c on c.id = o.ballot_card_id
     join this_or_that.matchups m on m.id = c.matchup_id
    where m.game_id = s.current_game_id) as owners,
  (select coalesce(json_agg(v), '[]')
     from this_or_that.votes v
     join this_or_that.matchups m on m.id = v.matchup_id
    where m.game_id = s.current_game_id) as votes,
  (select coalesce(json_agg(cv), '[]')
     from this_or_that.category_votes cv where cv.game_id = s.current_game_id) as category_votes
`;

/**
 * The room a code points at. Codes are only unique among open rooms, so this
 * prefers the open one and otherwise returns the most recent closed one --
 * which is what lets a late joiner see "This room was closed" rather than
 * "Room not found".
 */
export async function loadByCode(sql: Sql, roomCode: string, lock: boolean): Promise<LoadedRoom | null> {
  const [found] = await sql.unsafe(
    `select s.id from this_or_that.sessions s
      where s.room_code = $1
      order by (s.status <> 'closed') desc, s.created_at desc
      limit 1`,
    [roomCode],
  );
  return found ? loadById(sql, found.id as string, lock) : null;
}

/**
 * With `lock`, the session row is locked in its own statement BEFORE the room
 * is read. Under READ COMMITTED a statement reads from the snapshot taken when
 * it started: a single "select ... for update" that waits behind another
 * action would lock the fresh session row but read that action's votes and
 * items from before it committed. Two votes landing together would then each
 * miss the other, and the round would never resolve early.
 */
export async function loadById(sql: Sql, sessionId: string, lock: boolean): Promise<LoadedRoom | null> {
  if (lock) {
    const locked = await sql.unsafe(`select id from this_or_that.sessions where id = $1 for update`, [sessionId]);
    if (locked.length === 0) return null;
  }
  const rows = await sql.unsafe(`select ${LOAD_COLUMNS} from this_or_that.sessions s where s.id = $1`, [sessionId]);
  return rows.length ? toLoaded(rows[0]) : null;
}

/**
 * Top-level timestamptz columns arrive as Date objects; values nested in the
 * JSON aggregates arrive as ISO strings. String(date) would drop the
 * milliseconds, so the two are handled separately.
 */
const ms = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
};

function toLoaded(row: Row): LoadedRoom {
  const players = (row.players as Row[]).map(
    (p): Player => ({
      id: p.id as string,
      userId: (p.user_id as string | null) ?? null,
      isComputer: p.is_computer as boolean,
      name: p.name as string,
      colorSlot: (p.color_slot as number | null) ?? null,
      isHost: p.is_host as boolean,
      queued: p.queued as boolean,
      joinedAt: ms(p.joined_at)!,
      lastSeenAt: ms(p.last_seen_at)!,
      disconnectedAt: ms(p.disconnected_at),
      leftAt: ms(p.left_at),
    }),
  );

  const g = row.game as Row | null;
  let game: Game | null = null;
  if (g) {
    const favorites = (row.favorites as Row[])
      .map(
        (f): Favorite => ({
          id: f.id as string,
          playerId: f.player_id as string,
          entryPosition: f.entry_position as number,
          displayText: f.display_text as string,
          ballotText: toBallotText(f.display_text as string),
          canonicalItemId: (f.canonical_item_id as number | null) ?? null,
          autoPicked: f.auto_picked as boolean,
          surprisePicked: f.surprise_picked as boolean,
          shuffledPosition: (f.shuffled_position as number | null) ?? null,
        }),
      )
      .sort((a, b) => a.playerId.localeCompare(b.playerId) || a.entryPosition - b.entryPosition);

    const ownersByCard = new Map<string, string[]>();
    for (const o of row.owners as Row[]) {
      const list = ownersByCard.get(o.ballot_card_id as string) ?? [];
      list.push(o.favorite_id as string);
      ownersByCard.set(o.ballot_card_id as string, list);
    }
    const cardsByMatchup = new Map<string, BallotCard[]>();
    for (const c of row.cards as Row[]) {
      const list = cardsByMatchup.get(c.matchup_id as string) ?? [];
      list.push({
        id: c.id as string,
        displayText: c.display_text as string,
        sortOrder: c.sort_order as number,
        ownerFavoriteIds: (ownersByCard.get(c.id as string) ?? []).sort(),
      });
      cardsByMatchup.set(c.matchup_id as string, list);
    }
    const votesByMatchup = new Map<string, Record<string, string>>();
    for (const v of row.votes as Row[]) {
      const map = votesByMatchup.get(v.matchup_id as string) ?? {};
      map[v.voter_player_id as string] = v.ballot_card_id as string;
      votesByMatchup.set(v.matchup_id as string, map);
    }
    const matchups = (row.matchups as Row[])
      .map(
        (m): Matchup => ({
          id: m.id as string,
          roundNumber: m.round_number as number,
          multiplier: m.multiplier as 1 | 2,
          status: m.status as Matchup['status'],
          cards: (cardsByMatchup.get(m.id as string) ?? []).sort((a, b) => a.sortOrder - b.sortOrder),
          votes: votesByMatchup.get(m.id as string) ?? {},
          openedAt: ms(m.opened_at),
          revealedAt: ms(m.revealed_at),
        }),
      )
      .sort((a, b) => a.roundNumber - b.roundNumber);

    const computer = players.find((p) => p.isComputer);
    const categoryVotes: Record<string, number> = {};
    for (const cv of row.category_votes as Row[]) {
      categoryVotes[cv.player_id as string] = cv.category_id as number;
    }
    const submitted: Record<string, boolean> = {};
    for (const id of (g.submitted_player_ids as string[] | null) ?? []) submitted[id] = true;

    game = {
      id: g.id as string,
      number: g.number as number,
      offeredCategoryIds: (g.offered_category_ids as number[] | null) ?? [],
      categoryId: (g.category_id as number | null) ?? null,
      listLength: (g.list_length as ListLength | null) ?? null,
      humanCount: (g.human_count as number | null) ?? null,
      currentRound: g.current_round as number,
      endedEarly: g.ended_early as boolean,
      favorites,
      matchups,
      categoryVotes,
      submitted,
      computerItemIds: favorites
        .filter((f) => f.playerId === computer?.id && f.canonicalItemId !== null)
        .map((f) => f.canonicalItemId!),
      startedAt: ms(g.started_at)!,
      endedAt: ms(g.ended_at),
    };
  }

  const state: SessionState = {
    id: row.id as string,
    roomCode: String(row.room_code).trim(),
    status: row.status as SessionStatus,
    version: row.version as number,
    hostPlayerId: (row.host_player_id as string | null) ?? null,
    phaseDeadline: ms(row.phase_deadline),
    relaxedTimers: row.relaxed_timers as boolean,
    categoryVoteEnabled: row.category_vote as boolean,
    players,
    game,
    lastActivityAt: ms(row.last_activity_at)!,
    closedAt: ms(row.closed_at),
    pausedUntil: ms(row.paused_until),
    pausedFrom: (row.paused_from as SessionStatus | null) ?? null,
  };

  const seed = g?.rng_seed as string | null | undefined;
  return {
    state,
    seedHex: seed ? seed.replace(/^\\x/, '') : null,
    deviceGroupId: row.device_group_id as string,
    dbNow: Number(row.db_now),
  };
}

// --- Saving -----------------------------------------------------------------

const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());

interface TableSpec {
  table: string;
  key: string[];
  /** Columns never rewritten after insert. */
  immutable?: string[];
  /** Rows are never updated once written (votes, card owners). */
  insertOnly?: boolean;
}

const TABLES = {
  players: { table: 'players', key: ['id'], immutable: ['session_id', 'is_computer', 'joined_at'] },
  games: { table: 'games', key: ['id'], immutable: ['session_id', 'number', 'rng_seed', 'started_at'] },
  category_votes: { table: 'category_votes', key: ['game_id', 'player_id'] },
  favorites: { table: 'favorites', key: ['id'], immutable: ['game_id', 'player_id'] },
  matchups: { table: 'matchups', key: ['id'], immutable: ['game_id', 'round_number'] },
  ballot_cards: { table: 'ballot_cards', key: ['id'], insertOnly: true },
  ballot_card_owners: { table: 'ballot_card_owners', key: ['ballot_card_id', 'favorite_id'], insertOnly: true },
  votes: { table: 'votes', key: ['matchup_id', 'voter_player_id'], insertOnly: true },
} satisfies Record<string, TableSpec>;

type TableName = keyof typeof TABLES;

function rowsOf(state: SessionState | null, seedHex: string | null): Record<TableName, Row[]> {
  const out: Record<TableName, Row[]> = {
    players: [],
    games: [],
    category_votes: [],
    favorites: [],
    matchups: [],
    ballot_cards: [],
    ballot_card_owners: [],
    votes: [],
  };
  if (!state) return out;

  out.players = state.players.map((p) => ({
    id: p.id,
    session_id: state.id,
    user_id: p.userId,
    is_computer: p.isComputer,
    name: p.name,
    color_slot: p.colorSlot,
    is_host: p.isHost,
    queued: p.queued,
    joined_at: iso(p.joinedAt),
    last_seen_at: iso(p.lastSeenAt),
    disconnected_at: iso(p.disconnectedAt),
    left_at: iso(p.leftAt),
  }));

  const game = state.game;
  if (!game) return out;

  out.games = [
    {
      id: game.id,
      session_id: state.id,
      number: game.number,
      offered_category_ids: game.offeredCategoryIds,
      category_id: game.categoryId,
      list_length: game.listLength,
      human_count: game.humanCount,
      current_round: game.currentRound,
      rng_seed: seedHex ? `\\x${seedHex}` : null,
      ended_early: game.endedEarly,
      started_at: iso(game.startedAt),
      ended_at: iso(game.endedAt),
      submitted_player_ids: Object.entries(game.submitted)
        .filter(([, submitted]) => submitted)
        .map(([id]) => id)
        .sort(),
    },
  ];
  out.category_votes = Object.entries(game.categoryVotes).map(([playerId, categoryId]) => ({
    game_id: game.id,
    player_id: playerId,
    category_id: categoryId,
  }));
  out.favorites = game.favorites.map((f) => ({
    id: f.id,
    game_id: game.id,
    player_id: f.playerId,
    entry_position: f.entryPosition,
    raw_text: f.displayText,
    display_text: f.displayText,
    canonical_item_id: f.canonicalItemId,
    auto_picked: f.autoPicked,
    surprise_picked: f.surprisePicked,
    shuffled_position: f.shuffledPosition,
  }));
  for (const m of game.matchups) {
    out.matchups.push({
      id: m.id,
      game_id: game.id,
      round_number: m.roundNumber,
      multiplier: m.multiplier,
      status: m.status,
      opened_at: iso(m.openedAt),
      revealed_at: iso(m.revealedAt),
    });
    for (const c of m.cards) {
      out.ballot_cards.push({ id: c.id, matchup_id: m.id, display_text: c.displayText, sort_order: c.sortOrder });
      for (const favoriteId of c.ownerFavoriteIds) {
        out.ballot_card_owners.push({ ballot_card_id: c.id, favorite_id: favoriteId });
      }
    }
    for (const [voter, cardId] of Object.entries(m.votes)) {
      out.votes.push({ matchup_id: m.id, voter_player_id: voter, ballot_card_id: cardId });
    }
  }
  return out;
}

const keyOf = (spec: TableSpec, row: Row) => spec.key.map((k) => String(row[k])).join('|');

async function upsert(sql: Sql, spec: TableSpec, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const list = columns.map((c) => `"${c}"`).join(', ');
  const updatable = columns.filter((c) => !spec.key.includes(c) && !(spec.immutable ?? []).includes(c));
  const onConflict =
    spec.insertOnly || updatable.length === 0
      ? 'do nothing'
      : `do update set ${updatable.map((c) => `"${c}" = excluded."${c}"`).join(', ')}`;
  await sql.unsafe(
    `insert into this_or_that.${spec.table} (${list})
     select ${list} from jsonb_populate_recordset(null::this_or_that.${spec.table}, $1::text::jsonb)
     on conflict (${spec.key.map((k) => `"${k}"`).join(', ')}) ${onConflict}`,
    [JSON.stringify(rows)],
  );
}

/**
 * Write the difference between `before` and `after`.
 *
 * Order follows the foreign keys: the session row first (it is the parent),
 * then players and the game, then the play tables. The session's own host and
 * current-game keys are deferrable, so they can point at rows written later in
 * the same transaction.
 */
export async function saveState(
  sql: Sql,
  before: SessionState | null,
  after: SessionState,
  seedHex: string | null,
  options: { clearAdvanceRequest?: boolean } = {},
): Promise<void> {
  const session = {
    status: after.status,
    version: after.version,
    host_player_id: after.hostPlayerId,
    current_game_id: after.game?.id ?? null,
    phase_deadline: iso(after.phaseDeadline),
    relaxed_timers: after.relaxedTimers,
    category_vote: after.categoryVoteEnabled,
    last_activity_at: iso(after.lastActivityAt),
    closed_at: iso(after.closedAt),
    paused_until: iso(after.pausedUntil),
    paused_from: after.pausedFrom,
  };

  if (!before) {
    await sql.unsafe(
      `insert into this_or_that.sessions (id, room_code, status, version, relaxed_timers, category_vote, last_activity_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [after.id, after.roomCode, after.status, after.version, after.relaxedTimers, after.categoryVoteEnabled, session.last_activity_at],
    );
  }

  const oldRows = rowsOf(before, seedHex);
  const newRows = rowsOf(after, seedHex);

  for (const name of Object.keys(TABLES) as TableName[]) {
    const spec: TableSpec = TABLES[name];
    const previous = new Map(oldRows[name].map((row) => [keyOf(spec, row), JSON.stringify(row)]));
    const changed = newRows[name].filter((row) => previous.get(keyOf(spec, row)) !== JSON.stringify(row));
    await upsert(sql, spec, changed);
  }

  // remove_item is the only intent that deletes a favorite.
  const keptFavorites = new Set(newRows.favorites.map((r) => r.id as string));
  const removed = oldRows.favorites.map((r) => r.id as string).filter((id) => !keptFavorites.has(id));
  if (removed.length) {
    await sql.unsafe(`delete from this_or_that.favorites where id = any($1::uuid[])`, [removed]);
  }

  // Play Again drops departed players from the room (§11). Their rows stay so
  // earlier games keep their owners; released_at hides them from the room.
  const keptPlayers = new Set(after.players.map((p) => p.id));
  const released = (before?.players ?? []).map((p) => p.id).filter((id) => !keptPlayers.has(id));
  if (released.length) {
    await sql.unsafe(
      `update this_or_that.players set released_at = now() where id = any($1::uuid[]) and released_at is null`,
      [released],
    );
  }

  const assignments = Object.keys(session).map((c, i) => `"${c}" = $${i + 2}`);
  if (options.clearAdvanceRequest) assignments.push('advance_requested_at = null');
  const updated = await sql.unsafe(
    `update this_or_that.sessions set ${assignments.join(', ')}
      where id = $1 and version = $${Object.keys(session).length + 2}`,
    [after.id, ...Object.values(session), before?.version ?? after.version] as never[],
  );
  if (updated.count !== 1) throw new VersionConflict();
}

/** The optimistic-concurrency guard tripped (§14.2). */
export class VersionConflict extends Error {
  constructor() {
    super('The room changed while this action was running');
  }
}

// --- Reference data -----------------------------------------------------------

export interface CategoryRow {
  id: number;
  slug: string;
  name: string;
  sizeClass: 'small' | 'medium' | 'large';
  allowedLengths: ListLength[];
  dictionarySize: number;
}

export async function loadCategories(sql: Sql): Promise<CategoryRow[]> {
  const rows = await sql`
    select c.id, c.slug, c.name, c.size_class, c.allowed_lengths,
           (select count(*)::int from this_or_that.dictionary d where d.category_id = c.id) as dictionary_size
      from this_or_that.categories c
     where c.is_active
     order by c.id`;
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    sizeClass: r.size_class,
    allowedLengths: r.allowed_lengths,
    dictionarySize: r.dictionary_size,
  }));
}
