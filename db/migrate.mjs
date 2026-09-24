#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Applies every file in db/migrations in filename order, each inside a single
 * transaction, and records what it applied in this_or_that.schema_migrations.
 *
 * Use the DIRECT connection (port 5432), not the Supavisor transaction pooler
 * (6543). The pooler is right for app traffic, but migrations create
 * extensions, schedule pg_cron jobs and run multi-statement DDL, none of which
 * belong on a pooled connection.
 *
 *   node db/migrate.mjs --check    inspect only; changes nothing
 *   node db/migrate.mjs            apply pending migrations
 *
 * Connection string comes from DATABASE_URL, or SUPABASE_DB_URL.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

const checkOnly = process.argv.includes('--check');

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(HERE, '..', '.env.local'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (!process.env[key]) process.env[key] = value.replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env.local is optional; the URL may come from the environment.
  }
}

loadEnvLocal();

const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!url) {
  console.error(
    'No DATABASE_URL (or SUPABASE_DB_URL) set.\n\n' +
      'Supabase dashboard -> Project Settings -> Database -> Connection string -> URI,\n' +
      'and use the direct connection on port 5432, not the pooler on 6543.',
  );
  process.exit(1);
}

if (url.includes(':6543')) {
  console.error(
    'That is the transaction pooler (port 6543). Migrations need the direct\n' +
      'connection on port 5432: CREATE EXTENSION and cron.schedule do not work\n' +
      'through the pooler.',
  );
  process.exit(1);
}

/** Redact the password before anything reaches a log. */
function safeUrl(value) {
  return value.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function ensureLedger() {
  await sql.unsafe(`
    create schema if not exists this_or_that;
    create table if not exists this_or_that.schema_migrations (
      filename    text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    );
  `);
}

async function main() {
  console.log(`connecting to ${safeUrl(url)}`);
  const [{ version }] = await sql`select version()`;
  console.log(version.split(',')[0]);

  // Report what already lives here. This database is shared with other
  // applications, so it is worth seeing before changing anything.
  const schemas = await sql`
    select nspname from pg_namespace
     where nspname in ('public', 'this_or_that') order by 1`;
  const existing = await sql`
    select table_schema, count(*)::int as n
      from information_schema.tables
     where table_schema in ('public', 'this_or_that')
     group by 1 order by 1`;
  console.log('\nschemas present:', schemas.map((r) => r.nspname).join(', ') || '(none)');
  for (const row of existing) console.log(`  ${row.table_schema}: ${row.n} tables`);

  await ensureLedger();
  const applied = new Map(
    (await sql`select filename, checksum from this_or_that.schema_migrations`).map((r) => [
      r.filename,
      r.checksum,
    ]),
  );

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const pending = [];
  console.log('\nmigrations:');
  for (const file of files) {
    const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = digest(body);
    const previous = applied.get(file);
    if (!previous) {
      console.log(`  PENDING  ${file}`);
      pending.push({ file, body, checksum });
    } else if (previous !== checksum) {
      // The file changed after it was applied. The migration is idempotent, so
      // re-applying is safe, but say so rather than doing it silently.
      console.log(`  CHANGED  ${file} (applied ${previous}, now ${checksum}) -- will re-apply`);
      pending.push({ file, body, checksum });
    } else {
      console.log(`  applied  ${file}`);
    }
  }

  if (pending.length === 0) {
    console.log('\nnothing to do.');
    return;
  }
  if (checkOnly) {
    console.log(`\n--check: ${pending.length} migration(s) would run. Nothing was changed.`);
    return;
  }

  for (const { file, body, checksum } of pending) {
    process.stdout.write(`\napplying ${file} ... `);
    // One transaction per migration: a failure leaves nothing behind.
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        insert into this_or_that.schema_migrations (filename, checksum)
        values (${file}, ${checksum})
        on conflict (filename) do update
          set checksum = excluded.checksum, applied_at = now()`;
    });
    console.log('ok');
  }

  const tables = await sql`
    select count(*)::int as n from pg_tables where schemaname = 'this_or_that'`;
  const jobs = await sql`
    select jobname, schedule from cron.job where jobname like 'this_or_that%' order by 1`;
  console.log(`\nthis_or_that: ${tables[0].n} tables`);
  for (const job of jobs) console.log(`  cron ${job.jobname}: ${job.schedule}`);
}

try {
  await main();
} catch (error) {
  console.error('\nmigration failed:', error.message);
  if (error.hint) console.error('hint:', error.hint);
  process.exitCode = 1;
} finally {
  await sql.end();
}
