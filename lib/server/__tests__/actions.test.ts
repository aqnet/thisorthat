/**
 * The Server Actions against real Postgres (PGlite), as this_or_that_app.
 *
 * Only the Supabase sign-in check is stubbed: the "token" a test passes is the
 * user id itself. Everything after that -- seat checks, validation, the spell
 * check's SQL, the heartbeat's SQL, the event log -- runs for real, with the
 * same grants the app has on Supabase. The spell-check permission bug found in
 * the first browser test is exactly the kind of thing this layer catches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './harness';

vi.mock('@/lib/server/auth', () => {
  class AuthError extends Error {}
  return {
    AuthError,
    verifyUser: async (token: string) => {
      if (!token) throw new AuthError('Not signed in');
      return token;
    },
  };
});

let h: Harness;
let actions: typeof import('@/app/actions');

beforeAll(async () => {
  h = await startHarness();
  actions = await import('@/app/actions');
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

type Ok<T> = Extract<T, { ok: true }>;
function ok<T extends { ok: boolean }>(result: T): Ok<T> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Ok<T>;
}

async function snapshot(user: string, code: string) {
  return ok(await actions.getSnapshot(user, code)).snapshot;
}

/** A room with a host and `guests` more players, returning everyone's user id. */
async function room(guests = 1) {
  const host = await h.newUser();
  const { roomCode } = ok(await actions.createRoom(host, 'Ana'));
  const others: string[] = [];
  for (const name of ['Ben', 'Cy', 'Dee', 'Eve'].slice(0, guests)) {
    const user = await h.newUser();
    ok(await actions.joinRoom(user, roomCode, name));
    others.push(user);
  }
  return { code: roomCode, host, guests: others };
}

/** A room in the Enter Items phase for Fruit, 5 items each. */
async function entering() {
  const r = await room(1);
  ok(await actions.startGame(r.host, r.code));
  const fruit = (await snapshot(r.host, r.code)).categories.find((c) => c.name === 'Fruit')!;
  ok(await actions.confirmSetup(r.host, r.code, fruit.id, 5));
  return r;
}

const myList = async (user: string, code: string) =>
  (await snapshot(user, code)).game!.myList.map((item) => item.displayText);

describe('auth', () => {
  it('refuses a caller without a session', async () => {
    const result = await actions.createRoom('', 'Ana');
    expect(result).toMatchObject({ ok: false, code: 'auth' });
  });
});

describe('§4-§6 rooms, names and joining', () => {
  it('creates a room with the host seated and the Computer alongside', async () => {
    const { code, host } = await room(0);
    const snap = await snapshot(host, code);
    expect(snap.me?.isHost).toBe(true);
    expect(snap.players.map((p) => p.name).sort()).toEqual(['Ana', 'Computer']);
    expect((ok(await actions.lookupRoom(host, code))).info.status).toBe('seated');
  });

  it('applies the name rules, with a reason for every rejection', async () => {
    const { code } = await room(0);
    const user = await h.newUser();
    expect(await actions.joinRoom(user, code, 'ana')).toMatchObject({ ok: false, code: 'taken' });
    expect(await actions.joinRoom(user, code, 'CPU')).toMatchObject({ ok: false, code: 'reserved' });
    expect(await actions.joinRoom(user, code, 'The Computer')).toMatchObject({ ok: false, code: 'reserved' });
    expect(await actions.joinRoom(user, code, '   ')).toMatchObject({ ok: false, code: 'empty' });
    expect(await actions.joinRoom(user, code, 'Bartholomew13')).toMatchObject({ ok: false, code: 'too_long' });
    expect(await actions.joinRoom(user, code, 'shithead')).toMatchObject({ ok: false, code: 'profane' });
    expect((await actions.joinRoom(user, code, 'Ben')).ok).toBe(true);
    // Joining again from the same device is a no-op, not a second seat.
    expect((await actions.joinRoom(user, code, 'Ben2')).ok).toBe(true);
    expect((await snapshot(user, code)).players.filter((p) => !p.isComputer)).toHaveLength(2);
  });

  it('reports every join outcome the join screen handles (§6)', async () => {
    const outsider = await h.newUser();
    expect(ok(await actions.lookupRoom(outsider, 'ZZZZ')).info.status).toBe('not_found');
    expect(ok(await actions.lookupRoom(outsider, 'ab')).info.status).toBe('not_found');

    const full = await room(3);
    expect(ok(await actions.lookupRoom(outsider, full.code)).info.status).toBe('full');
    expect(await actions.joinRoom(outsider, full.code, 'Fin')).toMatchObject({ ok: false, code: 'room_full' });

    const open = await room(1);
    expect(ok(await actions.lookupRoom(outsider, open.code)).info.status).toBe('open');
    ok(await actions.startGame(open.host, open.code));
    expect(ok(await actions.lookupRoom(outsider, open.code)).info.status).toBe('in_progress');
    // A mid-game joiner is queued for the next game, not refused.
    ok(await actions.joinRoom(outsider, open.code, 'Fin'));
    expect((await snapshot(outsider, open.code)).me?.queued).toBe(true);

    ok(await actions.endGame(open.host, open.code));
    ok(await actions.closeRoom(open.host, open.code));
    const later = await h.newUser();
    expect(ok(await actions.lookupRoom(later, open.code)).info.status).toBe('closed');
  });

  it('lets a new device reclaim a disconnected seat, and only a disconnected one', async () => {
    const r = await room(1);
    ok(await actions.startGame(r.host, r.code));
    const benId = (await snapshot(r.guests[0], r.code)).me!.playerId;
    const newPhone = await h.newUser();

    expect((await actions.rejoinSeat(newPhone, r.code, benId)).ok).toBe(false);

    await h.admin((s) => s`update this_or_that.players set disconnected_at = now() where id = ${benId}`);
    const info = ok(await actions.lookupRoom(newPhone, r.code)).info;
    expect(info.rejoinable).toEqual([{ playerId: benId, name: 'Ben' }]);
    ok(await actions.rejoinSeat(newPhone, r.code, benId));
    expect((await snapshot(newPhone, r.code)).me?.playerId).toBe(benId);
  });

  it('New Room closes this one and seats the host in a fresh one', async () => {
    const r = await room(1);
    const { roomCode: next } = ok(await actions.newRoom(r.host, r.code));
    expect(next).not.toBe(r.code);
    expect((await snapshot(r.guests[0], r.code)).status).toBe('closed');
    const fresh = await snapshot(r.host, next);
    expect(fresh.me?.isHost).toBe(true);
    expect(fresh.players.find((p) => !p.isComputer)?.name).toBe('Ana');
  });
});

describe('§7 host setup', () => {
  it('offers categories to the host only, and enforces each size class', async () => {
    const r = await room(1);
    ok(await actions.startGame(r.host, r.code));
    const hostView = await snapshot(r.host, r.code);
    expect((await snapshot(r.guests[0], r.code)).categories).toEqual([]);

    const sport = hostView.categories.find((c) => c.name === 'Sport')!;
    expect(sport.allowedLengths).toEqual([5]);
    expect(await actions.confirmSetup(r.host, r.code, sport.id, 15)).toMatchObject({ ok: false, code: 'invalid_length' });
    expect(await actions.confirmSetup(r.guests[0], r.code, sport.id, 5)).toMatchObject({ ok: false, code: 'not_host' });
    ok(await actions.confirmSetup(r.host, r.code, sport.id, 5));
  });
});

describe('§8 entering items and the spell check', () => {
  it('takes the canonical spelling on an exact match', async () => {
    const r = await entering();
    ok(await actions.addItem(r.host, r.code, '  mango '));
    expect(await myList(r.host, r.code)).toEqual(['Mango']);
  });

  it('suggests a close match without adding anything, then takes the suggestion', async () => {
    const r = await entering();
    const result = ok(await actions.addItem(r.host, r.code, 'strawbery'));
    expect(result.suggestion?.name).toBe('Strawberry');
    expect(await myList(r.host, r.code)).toEqual([]);

    ok(await actions.addItem(r.host, r.code, 'strawbery', { kind: 'suggestion', dictionaryId: result.suggestion!.dictionaryId }));
    expect(await myList(r.host, r.code)).toEqual(['Strawberry']);
  });

  it('keeps what was typed on "Keep mine", and logs it for promotion', async () => {
    const r = await entering();
    ok(await actions.addItem(r.host, r.code, 'strawbery', { kind: 'mine' }));
    expect(await myList(r.host, r.code)).toEqual(['Strawbery']);
    const [row] = await h.admin((s) => s`
      select distinct_player_count from this_or_that.unmatched_entries where normalized_text = 'STRAWBERY'`);
    expect(row.distinct_player_count).toBeGreaterThanOrEqual(1);
  });

  it('rejects duplicates by text, by punctuation, and by alias', async () => {
    const r = await entering();
    ok(await actions.addItem(r.host, r.code, 'Kiwi'));
    expect(await actions.addItem(r.host, r.code, 'KIWI!!')).toMatchObject({ ok: false, message: 'Already on your list' });
    // "Kiwifruit" is an alias of Kiwi in the dictionary.
    expect(await actions.addItem(r.host, r.code, 'kiwifruit')).toMatchObject({ ok: false, message: 'Already on your list' });
  });

  it('states the reason for other rejections inline', async () => {
    const r = await entering();
    expect(await actions.addItem(r.host, r.code, '   ')).toMatchObject({ ok: false, code: 'empty' });
    expect(await actions.addItem(r.host, r.code, 'x'.repeat(31))).toMatchObject({ ok: false, code: 'too_long' });
  });

  it('refuses items outside the entry phase', async () => {
    const r = await room(1);
    expect(await actions.addItem(r.host, r.code, 'Mango')).toMatchObject({ ok: false, code: 'wrong_phase' });
  });

  it('Surprise me adds a tagged dictionary item that is not already listed', async () => {
    const r = await entering();
    ok(await actions.addItem(r.host, r.code, 'Mango'));
    for (let i = 0; i < 4; i++) ok(await actions.surpriseMe(r.host, r.code));
    const list = (await snapshot(r.host, r.code)).game!.myList;
    expect(list).toHaveLength(5);
    expect(list.filter((item) => item.surprise)).toHaveLength(4);
    expect(new Set(list.map((item) => item.displayText.toLowerCase())).size).toBe(5);
    // The list is full now.
    expect((await actions.surpriseMe(r.host, r.code)).ok).toBe(false);
  });

  it('submits, reopens with Edit, and removing an item un-submits', async () => {
    const r = await entering();
    for (let i = 0; i < 5; i++) ok(await actions.surpriseMe(r.host, r.code));
    ok(await actions.submitList(r.host, r.code));
    expect((await snapshot(r.host, r.code)).game!.mySubmitted).toBe(true);
    ok(await actions.editList(r.host, r.code));
    expect((await snapshot(r.host, r.code)).game!.mySubmitted).toBe(false);

    ok(await actions.submitList(r.host, r.code));
    const first = (await snapshot(r.host, r.code)).game!.myList[0];
    // Submitted lists are locked in the UI; the server accepts the edit path only.
    ok(await actions.editList(r.host, r.code));
    ok(await actions.removeItem(r.host, r.code, first.id));
    const after = (await snapshot(r.host, r.code)).game!;
    expect(after.myList).toHaveLength(4);
    expect(after.mySubmitted).toBe(false);
  });

  it('never shows one player another player’s list (§14.5)', async () => {
    const r = await entering();
    ok(await actions.addItem(r.host, r.code, 'Mango'));
    const guestView = await snapshot(r.guests[0], r.code);
    expect(guestView.game!.myList).toEqual([]);
    expect(guestView.game!.entryProgress.find((p) => p.count === 1)).toBeTruthy();
    expect(JSON.stringify(guestView)).not.toContain('Mango');
  });
});

describe('§9 voting through the actions', () => {
  it('locks lists when both submit, then refuses own-card and double votes', async () => {
    const r = await entering();
    for (const user of [r.host, r.guests[0]]) {
      for (let i = 0; i < 5; i++) ok(await actions.surpriseMe(user, r.code));
      ok(await actions.submitList(user, r.code));
    }
    const snap = await snapshot(r.host, r.code);
    expect(snap.status).toBe('matchup_voting');
    const mine = snap.game!.cards.find((c) => c.mine)!;
    const other = snap.game!.cards.find((c) => !c.mine)!;
    expect(await actions.castVote(r.host, r.code, mine.id)).toMatchObject({ ok: false, code: 'own_card' });
    ok(await actions.castVote(r.host, r.code, other.id));
    expect(await actions.castVote(r.host, r.code, other.id)).toMatchObject({ ok: false, code: 'already_voted' });
    expect((await snapshot(r.host, r.code)).game!.myVote).toBe(other.id);
  });
});

describe('§14.4 heartbeat', () => {
  it('marks the seat seen, clears a disconnect, and returns the room version', async () => {
    const r = await room(1);
    const benId = (await snapshot(r.guests[0], r.code)).me!.playerId;
    await h.admin((s) => s`
      update this_or_that.players set last_seen_at = now() - interval '30 seconds', disconnected_at = now()
       where id = ${benId}`);

    const beat = ok(await actions.heartbeat(r.guests[0], r.code));
    expect(beat.version).toBe((await snapshot(r.host, r.code)).version);
    const [row] = await h.admin((s) => s`
      select disconnected_at, now() - last_seen_at < interval '5 seconds' as fresh
        from this_or_that.players where id = ${benId}`);
    expect(row.disconnected_at).toBeNull();
    expect(row.fresh).toBe(true);
  });

  it('answers -1 for a room that no longer exists', async () => {
    const user = await h.newUser();
    expect(ok(await actions.heartbeat(user, 'ZZZZ')).version).toBe(-1);
  });
});

describe('the app role is limited to its own schema', () => {
  it('can spell-check, because match_item runs as its owner', async () => {
    const rows = await h.sql`select canonical_name from this_or_that.match_item(1::smallint, 'mango', 1)`;
    expect(rows[0].canonical_name).toBe('Mango');
  });

  it('cannot call extension functions directly', async () => {
    await expect(h.sql`select extensions.similarity('a', 'b')`).rejects.toThrow(/permission denied/);
  });

  it('cannot read another schema’s tables', async () => {
    await expect(h.sql`select * from vault.decrypted_secrets`).rejects.toThrow(/permission denied/);
  });
});
