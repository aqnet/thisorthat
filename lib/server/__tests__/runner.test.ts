/**
 * The runner, repository and advance route against real Postgres (PGlite).
 *
 * Plays whole games through the normalized tables, and after every intent
 * reloads the room from the database and checks it matches what the engine
 * returned. That round trip is the thing most likely to drift as the schema
 * and the engine evolve.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState } from '@/lib/engine';
import { startHarness, type Harness } from './harness';

let h: Harness;
let runner: typeof import('../runner');
let repo: typeof import('../repo');
let view: typeof import('../view');

beforeAll(async () => {
  h = await startHarness();
  runner = await import('../runner');
  repo = await import('../repo');
  view = await import('../view');
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

/** Apply an intent, then prove the database holds exactly the engine's state. */
async function act(code: string, build: Parameters<typeof runner.runIntent>[1]) {
  const outcome = await runner.runIntent({ roomCode: code }, build);
  if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
  const reloaded = await repo.loadByCode(h.sql, code, false);
  expect(normalize(reloaded!.state)).toEqual(normalize(outcome.state));
  return outcome.state;
}

/** Move a phase's deadline into the past, as if the timer ran out. */
const expire = (code: string) =>
  h.admin((s) => s`
    update this_or_that.sessions set phase_deadline = now() - interval '1 second'
     where room_code = ${code} and status <> 'closed'`);

/** Heartbeat every human now, so a slow run never looks like a disconnect. */
const touch = (code: string) =>
  h.admin((s) => s`
    update this_or_that.players p set last_seen_at = now()
      from this_or_that.sessions s
     where s.id = p.session_id and s.room_code = ${code} and s.status <> 'closed' and not p.is_computer`);

/** A room at round 1 of a 5-item Fruit game, with 2 humans (or 3 with `withCy`). */
async function roomAtRound1({ withCy = false } = {}) {
  const [u1, u2] = [await h.newUser(), await h.newUser()];
  const created = await runner.createRoom(u1, 'Ana');
  const code = created.roomCode;
  const host = created.players.find((p) => !p.isComputer)!;
  let state = await act(code, () => ({ type: 'join', playerId: randomUUID(), userId: u2, name: 'Ben' }));
  const ben = state.players.find((p) => p.name === 'Ben')!;
  if (withCy) {
    const u3 = await h.newUser();
    await act(code, () => ({ type: 'join', playerId: randomUUID(), userId: u3, name: 'Cy' }));
  }
  await act(code, () => ({ type: 'start_game', actorId: host.id }));
  const fruit = (await repo.loadCategories(h.sql)).find((c) => c.slug === 'fruit')!;
  await act(code, () => ({ type: 'confirm_setup', actorId: host.id, categoryId: fruit.id, listLength: 5 }));
  await expire(code);
  await touch(code);
  state = await act(code, () => ({ type: 'advance' }));
  expect(state.status).toBe('matchup_voting');
  return { code, host, ben, state, users: [u1, u2] };
}

/** The first card in the round this player may vote for. */
function votable(state: SessionState, round: number, voterId: string): string {
  const matchup = state.game!.matchups.find((m) => m.roundNumber === round)!;
  return matchup.cards.find(
    (c) => !c.ownerFavoriteIds.some((id) => state.game!.favorites.find((f) => f.id === id)?.playerId === voterId),
  )!.id;
}

describe('a full game through the database', () => {
  it('plays a 2-player game and round-trips every state', async () => {
    const [u1, u2] = [await h.newUser(), await h.newUser()];
    const created = await runner.createRoom(u1, 'Ana');
    const code = created.roomCode;
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    const host = created.players.find((p) => !p.isComputer)!;
    expect(created.hostPlayerId).toBe(host.id);

    let state = await act(code, () => ({ type: 'join', playerId: randomUUID(), userId: u2, name: 'Ben' }));
    const ben = state.players.find((p) => p.name === 'Ben')!;
    expect(ben.colorSlot).toBe(2);

    state = await act(code, () => ({ type: 'start_game', actorId: host.id }));
    expect(state.status).toBe('setup');

    const fruit = (await repo.loadCategories(h.sql)).find((c) => c.slug === 'fruit')!;
    state = await act(code, () => ({ type: 'confirm_setup', actorId: host.id, categoryId: fruit.id, listLength: 5 }));
    expect(state.status).toBe('entering');

    // Ana types three items and removes one; everything else is auto-filled at lock.
    for (const [i, text] of ['Mango', 'Kiwi', 'Grandma Plum'].entries()) {
      state = await act(code, () => ({
        type: 'add_item',
        playerId: host.id,
        favorite: {
          id: randomUUID(), playerId: host.id, entryPosition: i + 1, displayText: text,
          ballotText: text.toUpperCase(), canonicalItemId: null, autoPicked: false,
          surprisePicked: false, shuffledPosition: null,
        },
      }));
    }
    const kiwi = state.game!.favorites.find((f) => f.displayText === 'Kiwi')!;
    state = await act(code, () => ({ type: 'remove_item', playerId: host.id, favoriteId: kiwi.id }));
    expect(state.game!.favorites.some((f) => f.id === kiwi.id)).toBe(false);

    // The timer runs out: the dispatcher's advance locks the lists.
    await expire(code);
    await touch(code);
    state = await act(code, () => ({ type: 'advance' }));
    expect(state.status).toBe('matchup_voting');
    expect(state.game!.humanCount).toBe(2);
    expect(state.game!.matchups).toHaveLength(5);
    for (const m of state.game!.matchups) expect(m.cards).toHaveLength(3);
    const computer = state.players.find((p) => p.isComputer)!;
    expect(state.game!.favorites.filter((f) => f.playerId === computer.id)).toHaveLength(5);
    expect(state.game!.favorites.filter((f) => f.playerId === ben.id && f.autoPicked)).toHaveLength(5);

    // Every ballot card is stored in caps (§9.1) -- the constraint, not just the engine.
    const [{ lower }] = await h.admin((s) => s`
      select count(*)::int as lower from this_or_that.ballot_cards where display_text <> upper(display_text)`);
    expect(lower).toBe(0);

    for (let round = 1; round <= 5; round++) {
      for (const voter of [host, ben]) {
        const card = votable(state, round, voter.id);
        state = await act(code, () => ({ type: 'cast_vote', playerId: voter.id, ballotCardId: card }));
      }
      expect(state.status).toBe('matchup_reveal');
      state = await act(code, () => ({ type: 'next', actorId: host.id }));
    }
    expect(state.status).toBe('results');

    const gameId = state.game!.id;
    const results = await h.admin((s) => s`select * from this_or_that.game_results where game_id = ${gameId}`);
    expect(results).toHaveLength(3);
    const scores = await h.admin((s) => s`select * from this_or_that.high_scores where game_id = ${gameId}`);
    expect(scores.map((r) => r.player_name).sort()).toEqual(['Ana', 'Ben']);

    // item_stats: one appearance per round an item was on the ballot. Usually
    // once, but two players can list the same item (D4 allows it), and if the
    // shuffle puts them in different rounds it appears twice.
    const favoritesById = new Map(state.game!.favorites.map((f) => [f.id, f]));
    const expected = new Map<number, number>();
    for (const matchup of state.game!.matchups) {
      const inRound = new Set(
        matchup.cards.flatMap((c) => c.ownerFavoriteIds.map((id) => favoritesById.get(id)?.canonicalItemId ?? null)),
      );
      for (const itemId of inRound) if (itemId !== null) expected.set(itemId, (expected.get(itemId) ?? 0) + 1);
    }
    const stats = await h.admin((s) => s`
      select dictionary_id, appearances from this_or_that.item_stats
       where dictionary_id = any(${[...expected.keys()]}::bigint[])`);
    expect(new Map(stats.map((r) => [Number(r.dictionary_id), r.appearances]))).toEqual(expected);

    const events = await h.admin((s) => s`
      select version from this_or_that.session_events where session_id = ${state.id} order by id`);
    const versions = events.map((e) => e.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    // One broadcast per request that changed the room. A request can apply
    // several intents (an advance that also locks the lists), so there can be
    // fewer broadcasts than events -- but each one names a logged version,
    // and the last one is the room's final state.
    const sent = await h.admin((s) => s`
      select (payload->>'version')::int as version from realtime.messages
       where topic = ${'room:' + code} order by id`);
    const sentVersions = sent.map((r) => r.version);
    expect(sentVersions.every((v) => versions.includes(v))).toBe(true);
    expect(sentVersions.at(-1)).toBe(state.version);

    // The snapshot never carries another player's list or vote (§14.5).
    const snapshot = view.buildSnapshot(state, u2, await repo.loadCategories(h.sql), Date.now());
    const benFavorites = new Set(state.game!.favorites.filter((f) => f.playerId === ben.id).map((f) => f.id));
    expect(snapshot.game!.myList.every((item) => benFavorites.has(item.id))).toBe(true);
    expect(snapshot.game!.results!.funStats.length).toBeGreaterThan(0);

    // Play Again: back to the lobby with seats kept, then a fresh game.
    state = await act(code, () => ({ type: 'play_again', actorId: host.id }));
    expect(state.status).toBe('lobby');
    state = await act(code, () => ({ type: 'start_game', actorId: host.id }));
    expect(state.game!.number).toBe(2);

    state = await act(code, () => ({ type: 'close_room', actorId: host.id }));
    expect(state.status).toBe('closed');
  });

  it('queues a mid-game joiner and releases departed seats on Play Again', async () => {
    const [u1, u2, u3] = [await h.newUser(), await h.newUser(), await h.newUser()];
    const created = await runner.createRoom(u1, 'Cy');
    const code = created.roomCode;
    const host = created.players.find((p) => !p.isComputer)!;
    let state = await act(code, () => ({ type: 'join', playerId: randomUUID(), userId: u2, name: 'Dee' }));
    const dee = state.players.find((p) => p.name === 'Dee')!;
    state = await act(code, () => ({ type: 'start_game', actorId: host.id }));

    state = await act(code, () => ({ type: 'join', playerId: randomUUID(), userId: u3, name: 'Eve' }));
    expect(state.players.find((p) => p.name === 'Eve')!.queued).toBe(true);

    state = await act(code, () => ({ type: 'leave', playerId: dee.id }));
    state = await act(code, () => ({ type: 'end_game', actorId: host.id }));
    expect(state.game!.endedEarly).toBe(true);
    const gameId = state.game!.id;
    const scores = await h.admin((s) => s`select * from this_or_that.high_scores where game_id = ${gameId}`);
    expect(scores).toHaveLength(0);

    state = await act(code, () => ({ type: 'play_again', actorId: host.id }));
    expect(state.players.some((p) => p.id === dee.id)).toBe(false);
    const eve = state.players.find((p) => p.name === 'Eve')!;
    expect(eve.queued).toBe(false);
    expect(eve.colorSlot).not.toBeNull();
    const [row] = await h.admin((s) => s`select released_at from this_or_that.players where id = ${dee.id}`);
    expect(row.released_at).not.toBeNull();
  });

  it('auto-confirms setup when the host lets the timer run out', async () => {
    const [u1, u2] = [await h.newUser(), await h.newUser()];
    const created = await runner.createRoom(u1, 'Fay');
    const code = created.roomCode;
    const host = created.players.find((p) => !p.isComputer)!;
    await act(code, () => ({ type: 'join', playerId: randomUUID(), userId: u2, name: 'Gus' }));
    await act(code, () => ({ type: 'start_game', actorId: host.id }));
    await expire(code);
    await touch(code);
    const state = await act(code, () => ({ type: 'advance' }));
    expect(state.status).toBe('entering');
    expect(state.game!.categoryId).not.toBeNull();
    expect(state.game!.listLength).toBeLessThanOrEqual(10);
  });
});

describe('§14.3 the dispatcher and /api/advance', () => {
  const secret = 'test-advance-secret';
  let POST: typeof import('@/app/api/advance/route').POST;

  beforeAll(async () => {
    process.env.ADVANCE_SECRET = secret;
    ({ POST } = await import('@/app/api/advance/route'));
  });

  const advanceRequest = (sessionId: string, auth = `Bearer ${secret}`) =>
    new Request('http://test/api/advance', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });

  it('refuses a request without the shared secret', async () => {
    const { state } = await roomAtRound1();
    const response = await POST(advanceRequest(state.id, 'Bearer wrong'));
    expect(response.status).toBe(401);
  });

  it('resolves a round when the last missing voter has gone quiet', async () => {
    // Three players: losing one still leaves the 2 the game needs (§9.7).
    const { code, host, ben, state } = await roomAtRound1({ withCy: true });
    const cy = state.players.find((p) => p.name === 'Cy')!;
    for (const voter of [host, ben]) {
      await act(code, () => ({ type: 'cast_vote', playerId: voter.id, ballotCardId: votable(state, 1, voter.id) }));
    }

    // Cy's phone stops heart-beating; after 20s he's no longer waited on (§14.4).
    await h.admin((s) => s`
      update this_or_that.players set last_seen_at = now() - interval '25 seconds' where id = ${cy.id}`);
    const response = await POST(advanceRequest(state.id));
    expect(response.status).toBe(200);

    const after = (await repo.loadByCode(h.sql, code, false))!.state;
    expect(after.status).toBe('matchup_reveal');
    expect(after.players.find((p) => p.id === cy.id)!.disconnectedAt).not.toBeNull();
  });

  it('pauses instead when losing the quiet voter leaves fewer than 2 players', async () => {
    const { code, host, ben, state } = await roomAtRound1();
    await act(code, () => ({ type: 'cast_vote', playerId: host.id, ballotCardId: votable(state, 1, host.id) }));
    await h.admin((s) => s`
      update this_or_that.players set last_seen_at = now() - interval '25 seconds' where id = ${ben.id}`);
    await POST(advanceRequest(state.id));
    const after = (await repo.loadByCode(h.sql, code, false))!.state;
    expect(after.status).toBe('paused');
    expect(after.pausedFrom).toBe('matchup_voting');
  });

  it('auto-advances from the reveal when its 4s hold runs out', async () => {
    const { code, host, ben, state } = await roomAtRound1();
    for (const voter of [host, ben]) {
      await act(code, () => ({ type: 'cast_vote', playerId: voter.id, ballotCardId: votable(state, 1, voter.id) }));
    }
    await expire(code);
    await touch(code);
    await POST(advanceRequest(state.id));
    const after = (await repo.loadByCode(h.sql, code, false))!.state;
    expect(after.status).toBe('matchup_voting');
    expect(after.game!.currentRound).toBe(2);
  });

  it('clears the in-flight marker even when there is nothing to do', async () => {
    const { code, state } = await roomAtRound1();
    await h.admin((s) => s`update this_or_that.sessions set advance_requested_at = now() where room_code = ${code}`);
    const response = await POST(advanceRequest(state.id));
    expect(response.status).toBe(200);
    const [row] = await h.admin((s) => s`
      select version, advance_requested_at from this_or_that.sessions where id = ${state.id}`);
    expect(row.advance_requested_at).toBeNull();
    // Nothing was due, so nothing moved and nothing was broadcast.
    expect(row.version).toBe(state.version);
  });

  it('pauses the game when a player departs and fewer than 2 remain', async () => {
    const { code, ben, state } = await roomAtRound1();
    await h.admin((s) => s`
      update this_or_that.players set last_seen_at = now() - interval '65 seconds' where id = ${ben.id}`);
    await POST(advanceRequest(state.id));
    const after = (await repo.loadByCode(h.sql, code, false))!.state;
    expect(after.players.find((p) => p.id === ben.id)!.leftAt).not.toBeNull();
    expect(after.status).toBe('paused');
    expect(after.pausedFrom).toBe('matchup_voting');
  });
});

/**
 * The database stores timestamps at microsecond precision and returns rows
 * in its own order; neither is a real difference.
 */
function normalize(state: SessionState) {
  const copy = structuredClone(state);
  copy.players.sort((a, b) => a.id.localeCompare(b.id));
  if (copy.game) {
    copy.game.favorites.sort((a, b) => a.id.localeCompare(b.id));
    for (const m of copy.game.matchups) for (const c of m.cards) c.ownerFavoriteIds.sort();
    copy.game.computerItemIds.sort((a, b) => a - b);
    for (const key of Object.keys(copy.game.submitted)) if (!copy.game.submitted[key]) delete copy.game.submitted[key];
  }
  return copy;
}
