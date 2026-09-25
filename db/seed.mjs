#!/usr/bin/env node
/**
 * Loads the launch dictionary (db/seed/*.sql) in one transaction.
 *
 * Plain inserts with "on conflict do nothing", so re-running is a no-op and
 * never overwrites a row. The app role can write the dictionary, so this runs
 * on the app's own DATABASE_URL, pooler included -- unlike migrations, which
 * need the direct connection.
 *
 *   npm run db:seed
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));

try {
  for (const line of readFileSync(join(HERE, '..', '.env.local'), 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // .env.local is optional; the URL may come from the environment.
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const files = readdirSync(join(HERE, 'seed')).filter((f) => f.endsWith('.sql')).sort();
  await sql.begin(async (tx) => {
    for (const file of files) {
      await tx.unsafe(readFileSync(join(HERE, 'seed', file), 'utf8'));
      console.log(`applied ${file}`);
    }
  });
  const rows = await sql`
    select c.slug, count(d.id)::int as items, count(d.id) filter (where d.popular_tier)::int as popular
      from this_or_that.categories c
      left join this_or_that.dictionary d on d.category_id = c.id
     group by c.slug order by c.slug`;
  for (const r of rows) console.log(`  ${r.slug.padEnd(20)} ${r.items} items, ${r.popular} popular`);
} catch (error) {
  console.error('seed failed:', error.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
