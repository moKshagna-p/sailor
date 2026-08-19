import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { db } from './client.ts';
import * as schema from './schema.ts';

export const authDatabase = drizzleAdapter(db, {
  provider: 'pg',
  schema,
  usePlural: true,
});
