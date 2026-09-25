import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/server/env';
import { runIntent } from '@/lib/server/runner';

/**
 * Phase advance (§14.3). Called only by the pg_cron dispatcher (or, in local
 * development, scripts/dev-dispatch.mjs), authenticated with the shared secret
 * held in Supabase Vault. No client can end, extend or shorten a phase.
 *
 * The engine re-checks everything against the database clock, so a stale or
 * duplicate request is a harmless no-op.
 */
function authorized(request: Request): boolean {
  const header = request.headers.get('authorization') ?? '';
  const expected = Buffer.from(`Bearer ${env.advanceSecret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response('unauthorized', { status: 401 });

  const body = (await request.json().catch(() => null)) as { session_id?: unknown } | null;
  const sessionId = typeof body?.session_id === 'string' ? body.session_id : null;
  if (!sessionId) return new Response('session_id required', { status: 400 });

  try {
    const outcome = await runIntent({ sessionId }, () => ({ type: 'advance' }));
    if (!outcome.ok) return Response.json({ ok: false, code: outcome.code }, { status: 404 });
    return Response.json({ ok: true, version: outcome.state.version, status: outcome.state.status });
  } catch (error) {
    console.error('advance failed', error);
    return new Response('advance failed', { status: 500 });
  }
}
