import { expect, test } from 'bun:test';
import { requireUserId, UnauthorizedError } from './session.ts';

test('a valid Better Auth session resolves to its user id', async () => {
  const headers = new Headers({ cookie: 'better-auth.session_token=token' });
  const userId = await requireUserId(headers, async (input) => {
    expect(input.headers).toBe(headers);
    return { user: { id: 'usr_signed_in' } };
  });
  expect(userId).toBe('usr_signed_in');
});

test('a missing session is unauthorized and never creates a user', async () => {
  await expect(requireUserId(new Headers(), async () => null)).rejects.toBeInstanceOf(
    UnauthorizedError,
  );
});
