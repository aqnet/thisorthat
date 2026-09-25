/**
 * Concurrency against a real Postgres server (§14.2).
 *
 * PGlite serves one connection at a time, so two transactions can't contend
 * for a lock there. This one test needs a real server with the migrations
 * applied, and runs only when one is configured:
 *
 *   TEST_DATABASE_URL  as this_or_that_app
 *   TEST_ADMIN_URL     as a superuser (creates auth users, holds the lock)
 *
 * Without them it is reported as skipped -- by name, so a green run never
 * hides that it didn't happen. It deletes the rooms and users it creates.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appUrl = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_ADMIN_URL;

describe.skipIf(!appUrl || !adminUrl)('concurrency on a real Postgres (needs TEST_DATABASE_URL + TEST_ADMIN_URL)', () => {
  let admin: postgres.Sql;
  let runner: typeof import('../runner');
  let repo: typeof import('../repo');
  const users = [randomUUID(), randomUUID()];
  const sessions: string[] = [];
  const globalForDb = globalThis as unknown as { totSql?: postgres.Sql };

  beforeAll(async () => {
    admin = postgres(adminUrl!, { onnotice: () => {} });
    globalForDb.totSql = postgres(appUrl!, { max: 5, prepare: false, onnotice: () => {} });
    for (const id of users) await admin`insert into auth.users (id) values (${id})`;
    runner = await import('../runner');
    repo = await import('../repo');
  });

  afterAll(async () => {
    if (admin) {
      if (sessions.length) await admin`delete from this_or_that.sessions where id = any(${sessions}::uuid[])`;
      await admin`delete from auth.users where id = any(${users}::uuid[])`;
      await admin.end();
    }
    await globalForDb.totSql?.end();
    delete globalForDb.totSql;
  });

  /** Wait until `count` other sessions are blocked waiting on a lock. */
  async function waitForBlocked(count: number) {
    for (let i = 0; i < 100; i++) {
      // Polled from outside any transaction: pg_stat_activity is a frozen
      // snapshot for the rest of the transaction that first reads it.
      const [{ n }] = await admin`
        select count(*)::int as n from pg_stat_activity
         where wait_event_type = 'Lock' and datname = current_database()`;
      if (n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected ${count} blocked transactions`);
  }

  it('resolves a round when two votes land at the same moment', async () => {
    const run = async (code: string, build: Parameters<typeof runner.runIntent>[1]) => {
      const outcome = await runner.runIntent({ roomCode: code }, build);
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.state;
    };
    const created = await runner.createRoom(users[0], 'Hal');
    sessions.push(created.id);
    const code = created.roomCode;
    const host = created.players.find((p) => !p.isComputer)!;
    let state = await run(code, () => ({ type: 'join', playerId: randomUUID(), userId: users[1], name: 'Ivy' }));
    const ivy = state.players.find((p) => p.name === 'Ivy')!;
    await run(code, () => ({ type: 'start_game', actorId: host.id }));
    const fruit = (await repo.loadCategories(globalForDb.totSql!)).find((c) => c.slug === 'fruit')!;
    await run(code, () => ({ type: 'confirm_setup', actorId: host.id, categoryId: fruit.id, listLength: 5 }));
    await admin`update this_or_that.sessions set phase_deadline = now() - interval '1 second' where id = ${created.id}`;
    state = await run(code, () => ({ type: 'advance' }));
    expect(state.status).toBe('matchup_voting');

    const matchup = state.game!.matchups[0];
    const pick = (voterId: string) =>
      matchup.cards.find(
        (c) => !c.ownerFavoriteIds.some((id) => state.game!.favorites.find((f) => f.id === id)?.playerId === voterId),
      )!.id;

    // Force the overlap: hold the room's lock so both votes start and queue
    // behind it, then release. Left to chance, two millisecond-long
    // transactions almost never overlap, and this test passed with the bug in
    // place (checked: 0 of 10 runs caught it). Gated like this, it catches the
    // bug every time.
    let votes: Promise<Awaited<ReturnType<typeof runner.runIntent>>>[] = [];
    await admin.begin(async (gate) => {
      await gate`select id from this_or_that.sessions where id = ${created.id} for update`;
      votes = [host.id, ivy.id].map((voter) =>
        runner.runIntent({ roomCode: code }, () => ({ type: 'cast_vote', playerId: voter, ballotCardId: pick(voter) })),
      );
      await waitForBlocked(2);
    });
    const results = await Promise.all(votes);
    expect(results.every((r) => r.ok)).toBe(true);

    const after = await repo.loadByCode(globalForDb.totSql!, code, false);
    expect(Object.keys(after!.state.game!.matchups[0].votes)).toHaveLength(2);
    expect(after!.state.status).toBe('matchup_reveal');
  });
});
