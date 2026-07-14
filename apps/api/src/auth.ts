import { ensureUser } from '@sailor/db';

/**
 * AUTH STUB — deliberately a body, per the plan. Better Auth (GitHub/Google
 * OAuth) drops in here and this file is the only thing that changes.
 *
 * Everything downstream already takes a `userId` and scopes its queries by it,
 * so swapping this for a real session lookup is a one-function change rather
 * than an audit of every route. That was the point of writing it this way now.
 *
 * When Better Auth lands:
 *   1. `bun add better-auth`, mount its handler at /api/auth/*
 *   2. Replace the body of `currentUserId()` with a session lookup
 *   3. Throw a 401 instead of minting the dev user
 *   4. Delete DEV_EMAIL
 */
const DEV_EMAIL = 'dev@sailor.local';

let cached: string | null = null;

export async function currentUserId(_headers: Record<string, string | undefined>): Promise<string> {
  if (cached) return cached;
  cached = await ensureUser(DEV_EMAIL, 'Dev User');
  return cached;
}
