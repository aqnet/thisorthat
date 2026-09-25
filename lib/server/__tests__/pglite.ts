/**
 * An in-process Postgres for the database tests (§14.10).
 *
 * PGlite is Postgres compiled to WASM: it starts inside the test run, needs no
 * Docker or server, and disappears when the run ends. It runs the REAL
 * migrations and dictionary seed, so the tests exercise the actual tables,
 * constraints, grants and SQL functions -- nothing here mocks game data.
 *
 * What it can't provide are the Supabase platform pieces the migrations assume
 * exist. Those get minimal stand-ins, applied before the migrations:
 *   - auth.users and auth.uid()          so players.user_id has a target
 *   - realtime.send / messages / topic() recording broadcasts for assertions
 *   - cron.schedule, net.http_post        pg_cron and pg_net are not in PGlite
 *   - vault.decrypted_secrets             empty, so dispatch_due() is a no-op
 *   - the anon and authenticated roles    so the grants apply as on Supabase
 *
 * The app's own code talks to it over a local socket with postgres.js, as it
 * would to Supabase. PGlite serves ONE connection at a time, so tests that
 * need two transactions contending for a lock can't run here; see
 * concurrency.db.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const ROOT = join(__dirname, '..', '..', '..');

const PLATFORM_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema extensions;
  create schema auth;
  create schema realtime;
  create schema vault;
  create schema cron;
  create schema net;

  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table realtime.messages (
    id bigserial primary key, topic text, extension text, event text,
    payload jsonb, private boolean, inserted_at timestamptz default now());
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text language sql stable
    as $$ select current_setting('realtime.topic', true) $$;
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
    returns void language sql
    as $$ insert into realtime.messages (topic, extension, event, payload, private)
          values (topic, 'broadcast', event, payload, private) $$;

  create view vault.decrypted_secrets as
    select null::text as name, null::text as decrypted_secret where false;

  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
  create table cron.job_run_details (jobid bigint, end_time timestamptz);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint
    language sql as $$
      insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
      on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
      returning jobid $$;

  create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int)
    returns bigint language sql as $$ select 0::bigint $$;
`;

/**
 * pg_cron and pg_net are platform extensions PGlite doesn't ship; their
 * functions are stubbed above, so only the CREATE EXTENSION lines are removed.
 * Everything else in the migration runs exactly as written.
 */
function forPGlite(sql: string): string {
  return sql.replace(/^create extension if not exists (pg_net|pg_cron)\b.*$/gim, '-- (stubbed for PGlite) $&');
}

export interface TestDatabase {
  db: PGlite;
  /** postgres:// URL for the app's own client (postgres.js). */
  url: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const db = await PGlite.create({ extensions: { pg_trgm, fuzzystrmatch } });
  await db.exec(PLATFORM_STUBS);

  const migrations = join(ROOT, 'db', 'migrations');
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(forPGlite(readFileSync(join(migrations, file), 'utf8')));
  }
  const seeds = join(ROOT, 'db', 'seed');
  for (const file of readdirSync(seeds).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(seeds, file), 'utf8'));
  }

  const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' });
  await server.start();
  const address = server.getServerConn();
  return {
    db,
    url: `postgres://postgres@${address}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
