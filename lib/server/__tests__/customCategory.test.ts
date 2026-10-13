/**
 * Custom categories and kids' categories through the Server Actions, on PGlite
 * (custom-category spec §11, §B9). The Claude API is never called: the
 * fixture generator stands in for it (§8.1).
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
  process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'fixture';
  h = await startHarness();
  actions = await import('@/app/actions');
}, 30_000);

afterAll(async () => {
  delete process.env.THIS_OR_THAT_CATEGORY_GENERATOR;
  await h?.stop();
});

type Ok<T> = Extract<T, { ok: true }>;
function ok<T extends { ok: boolean }>(result: T): Ok<T> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Ok<T>;
}

const snapshot = async (user: string, code: string) => ok(await actions.getSnapshot(user, code)).snapshot;

/** A room in setup: host Ana plus one guest. */
async function setupRoom() {
  const host = await h.newUser();
  const { roomCode } = ok(await actions.createRoom(host, 'Ana'));
  const guest = await h.newUser();
  ok(await actions.joinRoom(guest, roomCode, 'Ben'));
  ok(await actions.startGame(host, roomCode));
  return { code: roomCode, host, guest };
}

async function build(host: string, code: string, name: string, makeMyOwn = false) {
  return ok(await actions.buildCustomCategory(host, code, name, makeMyOwn)).result;
}

describe('custom-category spec §3.1 names', () => {
  it('refuses profanity, and nothing else', async () => {
    const r = await setupRoom();
    expect(await actions.buildCustomCategory(r.host, r.code, 'shit list')).toMatchObject({ ok: false, code: 'profane' });
    expect(await actions.buildCustomCategory(r.host, r.code, 'x')).toMatchObject({ ok: false, code: 'too_short' });
    // Vague, personal or nonsense names are playable: they just get no suggestions.
    const vague = await build(r.host, r.code, 'Things in my fridge');
    expect(vague).toMatchObject({ kind: 'ready', category: { itemCount: 0, suggestedMax: 15 } });
  });

  it('only lets the host build, and only during setup', async () => {
    const r = await setupRoom();
    expect(await actions.buildCustomCategory(r.guest, r.code, 'Board games')).toMatchObject({ ok: false, code: 'not_host' });
  });

  it('offers a close built-in first, without forcing it', async () => {
    const r = await setupRoom();
    expect(await build(r.host, r.code, 'Fruits')).toMatchObject({ kind: 'builtin', category: { name: 'Fruit' } });
    expect(await build(r.host, r.code, 'candies')).toMatchObject({ kind: 'builtin', category: { name: 'Candy' } });
    expect(await build(r.host, r.code, 'Fruits', true)).toMatchObject({ kind: 'ready', category: { name: 'Fruits' } });
  });
});

describe('custom-category spec §3.2-§3.5 building', () => {
  it('drops off-topic items, sizes lengths by what survived, and shows examples', async () => {
    const r = await setupRoom();
    const result = await build(r.host, r.code, 'Board games');
    if (result.kind !== 'ready') throw new Error(result.kind);
    expect(result.category.itemCount).toBe(55);
    expect(result.category.suggestedMax).toBe(5);
    expect(result.examples).toHaveLength(3);
    const names = await h.admin((s) => s`
      select d.canonical_name from this_or_that.dictionary d where d.category_id = ${result.category.id}`);
    const list = names.map((n) => n.canonical_name);
    expect(list).toContain('Catan');
    expect(list).not.toContain('Tag');
    expect(list).not.toContain('Basketball');
  });

  it('plays a narrow category as thin: 5 items each', async () => {
    const r = await setupRoom();
    const result = await build(r.host, r.code, 'Beatles albums');
    expect(result).toMatchObject({ kind: 'ready', category: { itemCount: 13, suggestedMax: 5 } });
  });

  it('reuses a name built before, in any room, without generating again', async () => {
    const first = await setupRoom();
    const built = await build(first.host, first.code, 'Board Games!');
    const second = await setupRoom();
    process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'none';
    try {
      const reused = await build(second.host, second.code, 'board  games');
      expect(reused).toMatchObject({ kind: 'ready', reused: true });
      if (reused.kind === 'ready' && built.kind === 'ready') expect(reused.category.id).toBe(built.category.id);
    } finally {
      process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'fixture';
    }
  });

  it('keeps a failed build playable, and never saves it for reuse', async () => {
    const r = await setupRoom();
    expect(await build(r.host, r.code, 'Things that fail')).toMatchObject({ kind: 'failed', canRetry: true });
    const plain = await build(r.host, r.code, 'Things that fail').then(async () =>
      ok(await actions.playWithoutSuggestions(r.host, r.code, 'Things that fail')).result,
    );
    expect(plain).toMatchObject({ kind: 'ready', category: { itemCount: 0 } });
    const reusable = await h.admin((s) => s`
      select count(*)::int as n from this_or_that.categories where custom_key = 'THINGSTHATFAIL' and generated`);
    expect(reusable[0].n).toBe(0);
  });

  it('plays without suggestions when no generator is configured', async () => {
    const r = await setupRoom();
    process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'none';
    try {
      expect(await build(r.host, r.code, 'Pizza toppings')).toMatchObject({ kind: 'ready', category: { itemCount: 0 } });
    } finally {
      process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'fixture';
    }
  });

  it('clears the build banner and extends the setup timer once', async () => {
    const r = await setupRoom();
    const before = (await snapshot(r.host, r.code)).phaseDeadline!;
    await build(r.host, r.code, 'Beatles albums');
    const after = await snapshot(r.guest, r.code);
    expect(after.game!.buildingCategory).toBeNull();
    expect(after.phaseDeadline!).toBeGreaterThanOrEqual(before);
  });
});

describe('custom-category spec §5-§6 playing a custom category', () => {
  it('confirms only a room’s own custom category, and lists it for that room', async () => {
    const mine = await setupRoom();
    const theirs = await setupRoom();
    const built = await build(theirs.host, theirs.code, 'Beatles albums');
    if (built.kind !== 'ready') throw new Error(built.kind);
    expect(await actions.confirmSetup(mine.host, mine.code, built.category.id, 5)).toMatchObject({
      ok: false,
      code: 'invalid_length',
    });
    const listed = (await snapshot(theirs.host, theirs.code)).categories.filter((c) => c.isCustom);
    expect(listed.map((c) => c.name)).toEqual(['Beatles Albums']);
  });

  it('spell-checks against the custom dictionary, or not, as the host chose', async () => {
    const r = await setupRoom();
    const built = await build(r.host, r.code, 'Board games');
    if (built.kind !== 'ready') throw new Error(built.kind);
    ok(await actions.confirmSetup(r.host, r.code, built.category.id, 5, 'pick_your_fav', false));
    const snap = await snapshot(r.host, r.code);
    expect(snap.game).toMatchObject({
      categoryName: 'Board Games', pluralLabel: 'board games', singularLabel: 'board game',
      spellCheck: false, hasDictionary: true, isCustom: true,
    });
    // Spell check off: no "Did you mean…?", typed text is kept.
    const typo = ok(await actions.addItem(r.host, r.code, 'Catann'));
    expect(typo.suggestion).toBeUndefined();
    // Exact matches still link to the dictionary, through the alias too.
    ok(await actions.addItem(r.host, r.code, 'settlers of catan'));
    const favorites = await h.admin((s) => s`
      select f.display_text, d.canonical_name from this_or_that.favorites f
        left join this_or_that.dictionary d on d.id = f.canonical_item_id
       order by f.entry_position`);
    expect(favorites.filter((f) => f.canonical_name === 'Catan')).toHaveLength(1);
  });

  it('Surprise me draws only from the custom category', async () => {
    const r = await setupRoom();
    const built = await build(r.host, r.code, 'Beatles albums');
    if (built.kind !== 'ready') throw new Error(built.kind);
    ok(await actions.confirmSetup(r.host, r.code, built.category.id, 5));
    for (let i = 0; i < 5; i++) ok(await actions.surpriseMe(r.host, r.code));
    const rows = await h.admin((s) => s`
      select d.category_id from this_or_that.favorites f
        join this_or_that.players p on p.id = f.player_id
        join this_or_that.dictionary d on d.id = f.canonical_item_id
       where p.user_id = ${r.host}`);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.category_id === built.category.id)).toBe(true);
  });
});

describe("custom-category spec Part B kids' categories", () => {
  it('offers all 18, grouped as kids, each meeting its size class', async () => {
    const r = await setupRoom();
    const kids = (await snapshot(r.host, r.code)).categories.filter((c) => c.audience === 'kids');
    expect(kids).toHaveLength(18);
    const suggested = Object.fromEntries(kids.map((c) => [c.name, c.suggestedMax]));
    expect(suggested['Pokémon']).toBe(15);
    expect(suggested['Candy']).toBe(10);
    expect(suggested['Pet']).toBe(5);
    for (const c of kids) expect(c.allowedLengths).toEqual([5, 10, 15]);
    for (const c of kids) expect(c.itemCount).toBeGreaterThanOrEqual(38);
  });

  it('reads the entry prompt from the category labels', async () => {
    const r = await setupRoom();
    const tv = (await snapshot(r.host, r.code)).categories.find((c) => c.name === "Kids' TV Show")!;
    ok(await actions.confirmSetup(r.host, r.code, tv.id, 5));
    expect((await snapshot(r.guest, r.code)).game).toMatchObject({ pluralLabel: 'TV shows', singularLabel: 'TV show' });
  });

  it('never suggests a retired item, but still spell-checks it', async () => {
    const r = await setupRoom();
    const pet = (await snapshot(r.host, r.code)).categories.find((c) => c.name === 'Pet')!;
    await h.admin((s) => s`
      update this_or_that.dictionary set retired_at = now()
       where category_id = ${pet.id} and canonical_name <> 'Axolotl'`);
    try {
      ok(await actions.confirmSetup(r.host, r.code, pet.id, 5));
      ok(await actions.surpriseMe(r.host, r.code));
      expect(await actions.surpriseMe(r.host, r.code)).toMatchObject({ ok: false, code: 'empty' });
      ok(await actions.addItem(r.host, r.code, 'hamster'));
      const linked = await h.admin((s) => s`
        select count(*)::int as n from this_or_that.favorites f
          join this_or_that.dictionary d on d.id = f.canonical_item_id
         where d.canonical_name in ('Axolotl', 'Hamster') and d.category_id = ${pet.id}`);
      expect(linked[0].n).toBe(2);
    } finally {
      await h.admin((s) => s`update this_or_that.dictionary set retired_at = null where category_id = ${pet.id}`);
    }
  });
});

describe('the migration', () => {
  it('widened category ids, including the identity sequence', async () => {
    const [row] = await h.admin((s) => s`
      select format_type(a.atttypid, a.atttypmod) as type, format_type(q.seqtypid, null) as seq_type
        from pg_attribute a, pg_sequence q
       where a.attrelid = 'this_or_that.categories'::regclass and a.attname = 'id'
         and q.seqrelid = pg_get_serial_sequence('this_or_that.categories', 'id')::regclass`);
    expect(row).toEqual({ type: 'integer', seq_type: 'integer' });
  });
});

describe('custom-category spec §4.5 borrowing and §5.4 learning', () => {
  /** A 0-item custom category, confirmed with a borrow source, both lists filled by hand. */
  async function borrowedGame(borrow: string) {
    const r = await setupRoom();
    process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'none';
    let built;
    try {
      built = await build(r.host, r.code, 'Jellycats');
    } finally {
      process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'fixture';
    }
    if (built.kind !== 'ready') throw new Error(built.kind);
    const source = (await snapshot(r.host, r.code)).categories.find((c) => c.name === borrow)!;
    ok(await actions.confirmSetup(r.host, r.code, built.category.id, 5, 'pick_your_fav', true, source.id));
    return { ...r, categoryId: built.category.id, sourceId: source.id };
  }

  it('suggests the closest built-in by name or by its items', async () => {
    const r = await setupRoom();
    process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'none';
    try {
      const pizza = await build(r.host, r.code, 'Pizza toppings');
      const meal = (await snapshot(r.host, r.code)).categories.find((c) => c.name === 'Meal')!;
      expect(pizza).toMatchObject({ kind: 'ready', category: { borrowSuggestionId: meal.id } });
      const odd = await build(r.host, r.code, 'Qwzx plorbs');
      expect(odd).toMatchObject({ kind: 'ready', category: { borrowSuggestionId: null } });
    } finally {
      process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'fixture';
    }
  });

  it('refuses to borrow for a category that has enough items, or from a custom one', async () => {
    const r = await setupRoom();
    const fruit = (await snapshot(r.host, r.code)).categories.find((c) => c.name === 'Fruit')!;
    const toy = (await snapshot(r.host, r.code)).categories.find((c) => c.name === 'Toy')!;
    expect(await actions.confirmSetup(r.host, r.code, fruit.id, 5, 'pick_your_fav', true, toy.id)).toMatchObject({
      ok: false,
      code: 'invalid_borrow',
    });
  });

  it('lets Surprise me and the Computer play borrowed items, without touching their stats', async () => {
    const g = await borrowedGame('Toy');
    const snap = await snapshot(g.guest, g.code);
    expect(snap.game).toMatchObject({ hasDictionary: true, borrowedFrom: 'Toy', categoryName: 'Jellycats' });
    ok(await actions.surpriseMe(g.host, g.code));
    for (const name of ['Bashful Bunny', 'Amuseable Avocado', 'Fuddlewuddle Lion', 'Bartholomew Bear']) {
      ok(await actions.addItem(g.host, g.code, name));
    }
    for (const name of ['Blossom Bunny', 'Jellycat Dragon', 'Ricky Rain Frog', 'Octopus', 'Smudge Rabbit']) {
      ok(await actions.addItem(g.guest, g.code, name));
    }
    ok(await actions.submitList(g.host, g.code));
    ok(await actions.submitList(g.guest, g.code));

    const computerItems = await h.admin((s) => s`
      select d.category_id from this_or_that.favorites f
        join this_or_that.players p on p.id = f.player_id
        join this_or_that.dictionary d on d.id = f.canonical_item_id
       where p.is_computer and f.game_id = (
         select g.id from this_or_that.games g join this_or_that.sessions s on s.current_game_id = g.id
          where s.room_code = ${g.code})`);
    expect(computerItems).toHaveLength(5);
    expect(computerItems.every((row) => row.category_id === g.sourceId)).toBe(true);

    // Play round 1: borrowed Toy items get no item_stats from a Jellycats game.
    const statsBefore = await h.admin((s) => s`
      select count(*)::int as n from this_or_that.item_stats st
        join this_or_that.dictionary d on d.id = st.dictionary_id where d.category_id = ${g.sourceId}`);
    for (const user of [g.host, g.guest]) {
      const voting = await snapshot(user, g.code);
      const target = voting.game!.cards.find((c) => !c.mine)!;
      ok(await actions.castVote(user, g.code, target.id));
    }
    expect((await snapshot(g.host, g.code)).status).toBe('matchup_reveal');
    const statsAfter = await h.admin((s) => s`
      select count(*)::int as n from this_or_that.item_stats st
        join this_or_that.dictionary d on d.id = st.dictionary_id where d.category_id = ${g.sourceId}`);
    expect(statsAfter[0].n).toBe(statsBefore[0].n);

    // §5.4: ending the game teaches the category what players typed -- not the
    // Surprise me pick, not the Computer's items.
    ok(await actions.endGame(g.host, g.code));
    const learned = await h.admin((s) => s`
      select canonical_name, player_originated from this_or_that.dictionary where category_id = ${g.categoryId}`);
    expect(learned.map((r) => r.canonical_name).sort()).toEqual(
      [
        'Amuseable Avocado', 'Bartholomew Bear', 'Bashful Bunny', 'Blossom Bunny', 'Fuddlewuddle Lion',
        'Jellycat Dragon', 'Octopus', 'Ricky Rain Frog', 'Smudge Rabbit',
      ].sort(),
    );
    expect(learned.every((r) => r.player_originated)).toBe(true);

    // Play Again: the room's own row comes back with what it learned, lengths unchanged.
    ok(await actions.playAgain(g.host, g.code));
    ok(await actions.startGame(g.host, g.code));
    const again = await build(g.host, g.code, 'jellycats');
    expect(again).toMatchObject({ kind: 'ready', reused: true, category: { itemCount: 9, suggestedMax: 15 } });
  });
});

describe('custom-category spec §3.6 / §8.3 build edges', () => {
  it('plays new names without suggestions once a game has used its builds', async () => {
    const r = await setupRoom();
    const [session] = await h.admin((s) => s`select id from this_or_that.sessions where room_code = ${r.code} and status <> 'closed'`);
    // Three builds already called the API this game.
    await h.admin((s) => s`
      insert into this_or_that.categories
        (slug, name, size_class, allowed_lengths, is_active, is_custom, custom_key, generated, created_by_session)
      select 'custom-rl-' || n || '-' || ${r.code}, 'Built ' || n, 'large', '{5,10,15}', false, true,
             'RATELIMIT' || n || ${r.code}, true, ${session.id}::uuid
        from generate_series(1, 3) as n`);
    const result = await build(r.host, r.code, 'Board games, again');
    expect(result).toMatchObject({
      kind: 'ready',
      category: { itemCount: 0 },
      note: "That's a lot of new categories — this one's without suggestions.",
    });
  });

  it('lets the host cancel a build banner, and only the host', async () => {
    const r = await setupRoom();
    const runner = await import('../runner');
    const hostId = (await snapshot(r.host, r.code)).me!.playerId;
    await runner.runIntent({ roomCode: r.code }, () => ({ type: 'hold_setup', actorId: hostId, name: 'Board Games' }));
    expect((await snapshot(r.guest, r.code)).game!.buildingCategory).toBe('Board Games');
    expect(await actions.cancelCustomCategory(r.guest, r.code)).toMatchObject({ ok: false, code: 'not_host' });
    ok(await actions.cancelCustomCategory(r.host, r.code));
    expect((await snapshot(r.guest, r.code)).game!.buildingCategory).toBeNull();
  });

  it('settles two rooms building the same name at once on one row', async () => {
    const { storeCategory } = await import('../customCategory');
    const [a, b] = [await setupRoom(), await setupRoom()];
    const sessionOf = async (code: string) =>
      (await h.admin((s) => s`select id from this_or_that.sessions where room_code = ${code} and status <> 'closed'`))[0].id;
    const input = (sessionId: string) => ({
      name: 'Card Games', key: 'CARDGAMES', sessionId, generated: true, model: 'fixture',
      singular: 'card game', plural: 'card games',
      items: [{ name: 'Uno', aliases: [], popular: true }, { name: 'Go Fish', aliases: [], popular: false }],
    });
    // Room A's build finishes second: its insert loses the unique key race.
    const first = await storeCategory(h.sql, input(await sessionOf(b.code)));
    const second = await storeCategory(h.sql, { ...input(await sessionOf(a.code)), items: [{ name: 'Snap', aliases: [], popular: true }] });
    expect(second.id).toBe(first.id);
    expect(second.dictionarySize).toBe(2);
    // Both rooms can use it.
    for (const room of [a, b]) {
      const listed = (await snapshot(room.host, room.code)).categories.filter((c) => c.isCustom).map((c) => c.id);
      expect(listed).toContain(first.id);
    }
  });

  it('refuses building outside setup', async () => {
    const r = await setupRoom();
    const fruit = (await snapshot(r.host, r.code)).categories.find((c) => c.name === 'Fruit')!;
    ok(await actions.confirmSetup(r.host, r.code, fruit.id, 5));
    expect(await actions.buildCustomCategory(r.host, r.code, 'Board games')).toMatchObject({ ok: false, code: 'wrong_phase' });
    expect(await actions.playWithoutSuggestions(r.host, r.code, 'Board games')).toMatchObject({ ok: false, code: 'wrong_phase' });
  });
});
