import 'server-only';

/**
 * Server configuration. Read lazily so `next build` doesn't need database
 * credentials, and so a missing value fails with a message that says which
 * one and where it comes from.
 */
function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

export const env = {
  /** The app role through the transaction pooler (§14.1): port 6543, as this_or_that_app. */
  get databaseUrl() {
    return required(
      'DATABASE_URL',
      'Use postgresql://this_or_that_app.<project-ref>:<password>@<pooler-host>:6543/postgres',
    );
  },
  get supabaseUrl() {
    return required('SUPABASE_URL', 'Supabase dashboard -> Project Settings -> API.');
  },
  get supabasePublishableKey() {
    return required('SUPABASE_PUBLISHABLE_KEY', 'Supabase dashboard -> Project Settings -> API Keys.');
  },
  /** Shared with the pg_cron dispatcher through Vault (this_or_that_advance_secret). */
  get advanceSecret() {
    return required('ADVANCE_SECRET', 'Copy this_or_that_advance_secret from vault.decrypted_secrets.');
  },
};
