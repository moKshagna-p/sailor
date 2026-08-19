import { expect, test } from 'bun:test';
import { json } from './api.ts';

test('every API request carries the Better Auth session cookie', async () => {
  const result = await json('/test', undefined, async (_url, init) => {
    expect(init?.credentials).toBe('include');
    return Response.json({ ok: true });
  });
  expect(result).toEqual({ ok: true });
});
