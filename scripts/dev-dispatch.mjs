#!/usr/bin/env node
/**
 * Local stand-in for the pg_cron dispatcher (§14.3).
 *
 * pg_cron runs on Supabase's servers and can't reach localhost, so during
 * development this script does its job: once a second it finds sessions that
 * are due -- the same conditions as this_or_that.dispatch_due() -- and POSTs
 * each to the local /api/advance with the shared secret.
 *
 * Leave this_or_that_advance_url unset in Vault while you use it, so the real
 * dispatcher stays a no-op and the two don't both fire.
 *
 *   node scripts/dev-dispatch.mjs            (default target http://localhost:3000)
 *   ADVANCE_TARGET=http://localhost:3001 node scripts/dev-dispatch.mjs
 */

import { readFileSync } from 'node:fs';
import postgres from 'postgres';

for (const line of (() => {
  try {
    return readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n');
  } catch {
    return [];
  }
})()) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

const { DATABASE_URL, ADVANCE_SECRET } = process.env;
const target = `${process.env.ADVANCE_TARGET ?? 'http://localhost:3000'}/api/advance`;
if (!DATABASE_URL || !ADVANCE_SECRET) {
  console.error('DATABASE_URL and ADVANCE_SECRET must be set (in .env.local).');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

async function sweep() {
  // Mirrors dispatch_due(): claim due sessions, then fire outside the transaction.
  const due = await sql`
    update this_or_that.sessions s
       set advance_requested_at = now()
     where s.id in (
       select s2.id from this_or_that.sessions s2
        where s2.status <> 'closed'
          and (s2.advance_requested_at is null or s2.advance_requested_at < now() - interval '3 seconds')
          and (
            s2.phase_deadline <= now()
            or exists (select 1 from this_or_that.players p
                        where p.session_id = s2.id and not p.is_computer and p.left_at is null
                          and p.released_at is null and p.disconnected_at is null
                          and p.last_seen_at < now() - interval '20 seconds')
            or exists (select 1 from this_or_that.players p
                        where p.session_id = s2.id and not p.is_computer and p.left_at is null
                          and p.released_at is null
                          and p.disconnected_at < now() - interval '60 seconds')
            or s2.last_activity_at < now() - interval '2 hours'
          )
        limit 200
        for update skip locked)
    returning s.id, s.version, s.room_code`;

  await Promise.all(
    due.map(async (row) => {
      try {
        const res = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADVANCE_SECRET}` },
          body: JSON.stringify({ session_id: row.id, version: row.version }),
        });
        const text = await res.text();
        console.log(`${new Date().toISOString().slice(11, 19)} ${row.room_code} v${row.version} -> ${res.status} ${text}`);
      } catch (error) {
        console.error(`${row.room_code}: ${error.message} (is next dev running at ${target}?)`);
      }
    }),
  );
}

console.log(`dispatching due sessions to ${target} every second (Ctrl+C to stop)`);
for (;;) {
  const started = Date.now();
  try {
    await sweep();
  } catch (error) {
    console.error('sweep failed:', error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1000 - (Date.now() - started))));
}
