import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The browser needs the project URL and the publishable key for anonymous
  // sign-in and Realtime (§14.1). Both are public by design; mapping them here
  // keeps .env.local on the names the server already uses.
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? '',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
  },
};

export default nextConfig;
