import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Identity is Supabase anonymous sign-in (§14.1): every device gets a real
 * auth.uid() without an account. Clients pass their access token to each
 * Server Action, and it is verified here against the project's signing keys.
 * A Server Action is a public POST endpoint, so nothing about the caller is
 * trusted until this returns.
 */
let verifier: SupabaseClient | null = null;

function client(): SupabaseClient {
  verifier ??= createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return verifier;
}

export class AuthError extends Error {}

export async function verifyUser(accessToken: string): Promise<string> {
  if (!accessToken) throw new AuthError('Not signed in');
  const { data, error } = await client().auth.getClaims(accessToken);
  const sub = data?.claims?.sub;
  if (error || !sub) throw new AuthError('Your session expired. Reload to continue.');
  return sub;
}
