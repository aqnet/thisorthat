/**
 * Shared setup for the database tests: one PGlite per test file, the app's
 * postgres.js client pointed at it, running as this_or_that_app.
 *
 * PGlite is a single backend, so the role is one setting for everything.
 * App code runs as this_or_that_app -- the same rights it has on Supabase,
 * which is what makes the permission tests meaningful. `admin` switches to the
 * superuser for setup and assertions, and switches back.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { startTestDatabase, type TestDatabase } from './pglite';

export interface Harness {
  /** The app's client (what lib/server/db.ts returns), as this_or_that_app. */
  sql: postgres.Sql;
  /** Run as the superuser: seeding auth.users, back-dating clocks, assertions. */
  admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T>;
  /** A fresh auth identity, as Supabase anonymous sign-in would create. */
  newUser(): Promise<string>;
  stop(): Promise<void>;
}

const globalForDb = globalThis as unknown as { totSql?: postgres.Sql };

export async function startHarness(): Promise<Harness> {
  const database: TestDatabase = await startTestDatabase();
  const sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`set role this_or_that_app`;
  // lib/server/db.ts reuses this pool rather than opening its own.
  globalForDb.totSql = sql;
  process.env.DATABASE_URL = database.url;

  const admin = async <T,>(fn: (s: postgres.Sql) => Promise<T>): Promise<T> => {
    await sql`reset role`;
    try {
      return await fn(sql);
    } finally {
      await sql`set role this_or_that_app`;
    }
  };

  return {
    sql,
    admin,
    async newUser() {
      const id = randomUUID();
      await admin((s) => s`insert into auth.users (id) values (${id})`);
      return id;
    },
    async stop() {
      delete globalForDb.totSql;
      await sql.end();
      await database.stop();
    },
  };
}
