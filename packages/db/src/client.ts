import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
  return url;
}

/**
 * One pool per process. Bun's hot reload re-evaluates modules, so we stash the
 * client on globalThis — otherwise every save leaks a pool and Postgres starts
 * refusing connections after a few dozen edits.
 */
const globalForDb = globalThis as unknown as {
  __sailorSql?: ReturnType<typeof postgres>;
};

const sql = globalForDb.__sailorSql ?? postgres(connectionString(), { max: 10 });
if (process.env.NODE_ENV !== 'production') globalForDb.__sailorSql = sql;

export const db = drizzle(sql, { schema });
export type Db = typeof db;
export { schema, sql };
