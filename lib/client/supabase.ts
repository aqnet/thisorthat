'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The browser's only uses of Supabase (§14.2): anonymous auth and Realtime.
 * It never queries a game table -- the this_or_that schema isn't exposed to
 * the Data API, and anon/authenticated hold no grants on it.
 */
let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: true, autoRefreshToken: true } },
  );
  return client;
}

let signingIn: Promise<string> | null = null;

/**
 * The access token for this device, signing in anonymously the first time.
 * The session persists in localStorage, which is what lets a refresh on the
 * same device resume the same seat (§6).
 */
export async function accessToken(): Promise<string> {
  const { data } = await supabase().auth.getSession();
  if (data.session) return data.session.access_token;
  signingIn ??= supabase()
    .auth.signInAnonymously()
    .then(({ data: signedIn, error }) => {
      if (error || !signedIn.session) {
        throw new Error(
          error?.message.includes('Anonymous sign-ins are disabled')
            ? 'Anonymous sign-ins are turned off for this Supabase project.'
            : "Couldn't connect. Check your connection and try again.",
        );
      }
      return signedIn.session.access_token;
    })
    .finally(() => {
      signingIn = null;
    });
  return signingIn;
}
