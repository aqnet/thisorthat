/**
 * Whole games through the Server Actions and the runner, on PGlite: the
 * combinations that only appear once a game is played to the end. Each test
 * drives the room the way phones and the dispatcher would -- actions for
 * players, an expired deadline plus an advance for the timer.
 *
 * The Claude API is never called; the fixture generator stands in (§8.1 of
 * the custom-category spec).
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
let runner: typeof import('../runner');

beforeAll(async () => {
  process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'fixture';
  h = await startHarness();
  actions = await import('@/app/actions');
  runner = await import('../runner');
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

/** Host Ana and guest Ben in a fresh lobby. */
async function lobby() {
  const host = await h.newUser();
  const { roomCode: code } = ok(await actions.createRoom(host, 'Ana'));
  const guest = await h.newUser();
  ok(await actions.joinRoom(guest, code, 'Ben'));
  return { code, host, guest, users: [host, guest] };
}

/** The timer runs out: expire the deadline, keep everyone connected, and advance. */
async function timerRunsOut(code: string) {
  await h.admin((s) => s`
    update this_or_that.sessions set phase_deadline = now() - interval '1 second'
     where room_code = ${code} and status <> 'closed'`);
  await h.admin((s) => s`
    update this_or_that.players p set last_seen_at = now()
      from this_or_that.sessions s
     where s.id = p.session_id and s.room_code = ${code} and s.status <> 'closed' and not p.is_computer`);
  const outcome = await runner.runIntent({ roomCode: code }, () => ({ type: 'advance' }));
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.state;
}

/** Add an item as typed, answering "Keep mine" if spell check suggests something. */
async function type(user: string, code: string, text: string) {
  const first = ok(await actions.addItem(user, code, text));
  if (first.suggestion) ok(await actions.addItem(user, code, text, { kind: 'mine' }));
}

/** Everyone votes for the first card that isn't theirs; then the host moves on. */
async function playToResults(code: string, users: string[], host: string) {
  for (let guard = 0; guard < 40; guard++) {
    const status = (await snapshot(host, code)).status;
    if (status === 'results') return;
    if (status === 'matchup_voting') {
      for (const user of users) {
        const snap = await snapshot(user, code);
        if (snap.status !== 'matchup_voting' || snap.game!.myVote) continue;
        const card = snap.game!.cards.find((c) => !c.mine);
        if (card) ok(await actions.castVote(user, code, card.id));
      }
      // Anyone who couldn't vote (every card theirs) leaves the round to the timer.
      if ((await snapshot(host, code)).status === 'matchup_voting') await timerRunsOut(code);
    } else if (status === 'matchup_reveal') {
      ok(await actions.nextRound(host, code));
    } else {
      throw new Error(`unexpected status ${status}`);
    }
  }
  throw new Error('game never reached results');
}

const currentGame = async (code: string) => {
  const [game] = await h.admin((s) => s`
    select g.* from this_or_that.games g
      join this_or_that.sessions s on s.current_game_id = g.id
     where s.room_code = ${code} and s.status <> 'closed'`);
  return game;
};

/** A no-suggestions custom category, as when there's no API key. */
async function emptyCustom(host: string, code: string, name: string) {
  process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'none';
  try {
    const result = ok(await actions.buildCustomCategory(host, code, name)).result;
    if (result.kind !== 'ready') throw new Error(result.kind);
    return result.category;
  } finally {
    process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'fixture';
  }
}

describe('custom-category spec §4.4: 2-card games and high scores', () => {
  it('plays a 2-player game with no Computer to the end, and keeps it off the boards', async () => {
    const r = await lobby();
    ok(await actions.startGame(r.host, r.code));
    const category = await emptyCustom(r.host, r.code, 'Things in my fridge');
    ok(await actions.confirmSetup(r.host, r.code, category.id, 5));
    for (const [user, prefix] of [[r.host, 'Ana'], [r.guest, 'Ben']] as const) {
      for (let i = 1; i <= 5; i++) await type(user, r.code, `${prefix} item ${i}`);
      ok(await actions.submitList(user, r.code));
    }
    const playing = await snapshot(r.host, r.code);
    // Nothing for the Computer to play, so it sits out even with 2 humans (§4.3).
    expect(playing.game!.withComputer).toBe(false);
    expect(playing.game!.cards).toHaveLength(2);

    await playToResults(r.code, r.users, r.host);
    const results = await snapshot(r.host, r.code);
    expect(results.game!.results).toMatchObject({ unrankedTwoCards: true, computerWon: false });
    const game = await currentGame(r.code);
    const scores = await h.admin((s) => s`select count(*)::int as n from this_or_that.high_scores where game_id = ${game.id}`);
    expect(scores[0].n).toBe(0);
    // Standings were still written: only the boards skip it.
    const standings = await h.admin((s) => s`select count(*)::int as n from this_or_that.game_results where game_id = ${game.id}`);
    expect(standings[0].n).toBe(2);
  });
});

describe('Pick and fwd with dropped rounds and no reign cap', () => {
  it('plays the rounds that survive, carries the champion, and stores the cap with the game', async () => {
    const r = await lobby();
    ok(await actions.setChampionReignCap(r.host, r.code, null));
    ok(await actions.startGame(r.host, r.code));
    ok(await actions.selectMode(r.host, r.code, 'pick_and_fwd'));
    const category = await emptyCustom(r.host, r.code, 'Weird hobbies');
    ok(await actions.confirmSetup(r.host, r.code, category.id, 5, 'pick_and_fwd'));
    for (let i = 1; i <= 5; i++) await type(r.host, r.code, `Ana hobby ${i}`);
    for (let i = 1; i <= 2; i++) await type(r.guest, r.code, `Ben hobby ${i}`);
    // Ben's list is short when the timer runs out; nothing can fill it (§4.2).
    await timerRunsOut(r.code);

    const first = await snapshot(r.host, r.code);
    expect(first.status).toBe('matchup_voting');
    // 5 + 2 items, no Computer: only 2 rounds have a choice (§4.1).
    expect(first.game!.totalRounds).toBe(2);
    expect(first.game!.showdownRounds).toEqual([2]);
    expect((await currentGame(r.code)).champion_reign_cap).toBeNull();

    for (const user of r.users) {
      const card = (await snapshot(user, r.code)).game!.cards.find((c) => !c.mine)!;
      ok(await actions.castVote(user, r.code, card.id));
    }
    ok(await actions.nextRound(r.host, r.code));
    const second = await snapshot(r.guest, r.code);
    expect(second.game!.round).toBe(2);
    expect(second.game!.cards.some((c) => c.champion !== null)).toBe(true);

    await playToResults(r.code, r.users, r.host);
    expect((await snapshot(r.host, r.code)).status).toBe('results');
  });
});

describe('§9.1 Computer variety across games', () => {
  it("never repeats the Computer's items from the room's previous game", async () => {
    const r = await lobby();
    const fruitGame = async () => {
      ok(await actions.startGame(r.host, r.code));
      const fruit = (await snapshot(r.host, r.code)).categories.find((c) => c.name === 'Fruit')!;
      ok(await actions.confirmSetup(r.host, r.code, fruit.id, 5));
      // Nobody types: the timer auto-fills every list, then the Computer picks.
      await timerRunsOut(r.code);
      const game = await currentGame(r.code);
      return h.admin((s) => s`
        select f.canonical_item_id from this_or_that.favorites f
          join this_or_that.players p on p.id = f.player_id
         where f.game_id = ${game.id} and p.is_computer`);
    };
    const first = (await fruitGame()).map((row) => Number(row.canonical_item_id));
    expect(first).toHaveLength(5);
    await playToResults(r.code, r.users, r.host);
    ok(await actions.playAgain(r.host, r.code));
    const second = (await fruitGame()).map((row) => Number(row.canonical_item_id));
    expect(second).toHaveLength(5);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
  });

  it('keeps every earlier game’s record when Play Again starts the next one', async () => {
    const r = await lobby();
    ok(await actions.startGame(r.host, r.code));
    const fruit = (await snapshot(r.host, r.code)).categories.find((c) => c.name === 'Fruit')!;
    ok(await actions.confirmSetup(r.host, r.code, fruit.id, 5));
    await timerRunsOut(r.code);
    await playToResults(r.code, r.users, r.host);
    const first = await currentGame(r.code);
    const record = () =>
      h.admin((s) => s`
        select (select count(*)::int from this_or_that.favorites where game_id = ${first.id}) as favorites,
               (select count(*)::int from this_or_that.ballot_cards c join this_or_that.matchups m on m.id = c.matchup_id
                 where m.game_id = ${first.id}) as cards,
               (select count(*)::int from this_or_that.votes v join this_or_that.matchups m on m.id = v.matchup_id
                 where m.game_id = ${first.id}) as votes`);
    const [before] = await record();
    expect(before.favorites).toBe(15);
    ok(await actions.playAgain(r.host, r.code));
    ok(await actions.startGame(r.host, r.code));
    const [after] = await record();
    expect(after).toEqual(before);
  });
});

describe('custom-category spec §5.4: learning into an existing dictionary', () => {
  it('adds only new items, once each, and links ones it already knows', async () => {
    const r = await lobby();
    ok(await actions.startGame(r.host, r.code));
    const built = ok(await actions.buildCustomCategory(r.host, r.code, 'Board games')).result;
    if (built.kind !== 'ready') throw new Error(built.kind);
    ok(await actions.confirmSetup(r.host, r.code, built.category.id, 5));
    const before = await h.admin((s) => s`
      select count(*)::int as n from this_or_that.dictionary where category_id = ${built.category.id}`);

    // Known items (exact, by alias, by case) and new ones -- one new item typed by both.
    // (An alias of an item already on your own list is a duplicate, so Catan's alias goes to Ben.)
    for (const text of ['Catan', 'CHESS', 'Brass Birmingham', 'Heat', 'Risk']) await type(r.host, r.code, text);
    for (const text of ['settlers of catan', 'Brass: Birmingham', 'Ark Nova', 'Cascadia', 'Everdell']) await type(r.guest, r.code, text);
    ok(await actions.submitList(r.host, r.code));
    ok(await actions.submitList(r.guest, r.code));
    ok(await actions.endGame(r.host, r.code));

    const learned = await h.admin((s) => s`
      select canonical_name from this_or_that.dictionary
       where category_id = ${built.category.id} and player_originated order by canonical_name`);
    expect(learned.map((row) => row.canonical_name)).toEqual(['Ark Nova', 'Brass Birmingham', 'Cascadia', 'Everdell', 'Heat']);
    const after = await h.admin((s) => s`
      select count(*)::int as n from this_or_that.dictionary where category_id = ${built.category.id}`);
    expect(after[0].n).toBe(before[0].n + 5);
  });

  it('teaches nothing when the game ends before the lists lock', async () => {
    const r = await lobby();
    ok(await actions.startGame(r.host, r.code));
    const category = await emptyCustom(r.host, r.code, 'Unfinished business');
    ok(await actions.confirmSetup(r.host, r.code, category.id, 5));
    await type(r.host, r.code, 'Taxes');
    ok(await actions.endGame(r.host, r.code));
    const learned = await h.admin((s) => s`
      select count(*)::int as n from this_or_that.dictionary where category_id = ${category.id}`);
    expect(learned[0].n).toBe(0);
  });
});
