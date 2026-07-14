import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './client.ts';

await migrate(db, {
  migrationsFolder: new URL('../drizzle', import.meta.url).pathname,
});
console.warn('✓ migrations applied');
await sql.end();
