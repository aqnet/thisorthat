import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

/**
 * The browser needs the project URL and the publishable key for anonymous
 * sign-in and Realtime (§14.1). Both are public by design, and both are baked
 * into the bundle at BUILD time -- so a build without them deploys a site
 * that only fails later, in the player's browser ("supabaseUrl is required").
 * A production build refuses to start instead.
 *
 * The server-only values (DATABASE_URL, ADVANCE_SECRET) are read at runtime
 * by lib/server/env.ts, which names whichever one is missing.
 */
const BUILD_TIME_VARS = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'] as const;

export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const missing = BUILD_TIME_VARS.filter((name) => !process.env[name]);
    if (missing.length) {
      throw new Error(
        `Missing ${missing.join(' and ')} at build time. The browser bundle needs ` +
          `${missing.length > 1 ? 'them' : 'it'} baked in. On Vercel: Settings -> ` +
          'Environment Variables, add for Production (and Preview), then redeploy. ' +
          'See .env.example.',
      );
    }
  }

  return {
    // Mapped here so .env.local keeps the names the server already uses.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? '',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
    },
  };
}
