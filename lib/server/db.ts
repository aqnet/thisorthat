import 'server-only';
import postgres from 'postgres';
import { env } from './env';

/**
 * One pool per server instance, as this_or_that_app through the Supavisor
 * transaction pooler (§14.1). `prepare: false` is required there: a pooled
 * connection can't hold a prepared statement across transactions.
 *
 * Cached on globalThis so dev-mode hot reloads don't open a new pool each time.
 */
const globalForDb = globalThis as unknown as { totSql?: postgres.Sql };

export function db(): postgres.Sql {
  if (!globalForDb.totSql) {
    globalForDb.totSql = postgres(env.databaseUrl, {
      prepare: false,
      max: 5,
      idle_timeout: 20,
      onnotice: () => {},
    });
  }
  return globalForDb.totSql;
}

export type Tx = postgres.TransactionSql;
