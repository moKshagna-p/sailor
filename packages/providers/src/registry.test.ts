import { expect, test } from 'bun:test';
import type { ProviderId, ResolvedCredential } from '@sailor/core';
import type { CredentialStore } from './registry.ts';
import { allModels, getDriver, resolveCredential } from './registry.ts';

type Stored = ResolvedCredential & { refreshToken: string | null };

function fakeStore(initial: Stored | null): CredentialStore & { saved: unknown[] } {
  const saved: unknown[] = [];
  let current = initial;
  return {
    saved,
    async load() {
      return current;
    },
    async save(_userId: string, provider: ProviderId, next) {
      saved.push(next);
      current = {
        kind: 'oauth',
        provider,
        accessToken: next.accessToken,
        expiresAt: next.expiresAt,
        refreshToken: next.refreshToken,
      };
    },
  };
}

test('an unexpired OAuth token is used as-is, without a refresh round-trip', async () => {
  const store = fakeStore({
    kind: 'oauth',
    provider: 'anthropic',
    accessToken: 'live-token',
    expiresAt: Date.now() + 3_600_000,
    refreshToken: 'refresh-me',
  });

  const credential = await resolveCredential({
    userId: 'u1',
    provider: 'anthropic',
    store,
  });
  expect(credential).toMatchObject({
    kind: 'oauth',
    accessToken: 'live-token',
  });
  expect(store.saved).toHaveLength(0);
});

test('an OAuth token inside the skew window is refreshed and persisted', async () => {
  const store = fakeStore({
    kind: 'oauth',
    provider: 'anthropic',
    accessToken: 'stale-token',
    // Not yet expired, but within REFRESH_SKEW_MS — must still refresh, or it
    // dies mid-stream.
    expiresAt: Date.now() + 10_000,
    refreshToken: 'refresh-me',
  });

  const driver = getDriver('anthropic');
  const original = driver.refresh;
  driver.refresh = async (refreshToken: string) => {
    expect(refreshToken).toBe('refresh-me');
    return {
      accessToken: 'fresh-token',
      refreshToken: 'next-refresh',
      expiresAt: Date.now() + 3_600_000,
    };
  };

  try {
    const credential = await resolveCredential({
      userId: 'u1',
      provider: 'anthropic',
      store,
    });
    expect(credential).toMatchObject({
      kind: 'oauth',
      accessToken: 'fresh-token',
    });
    expect(store.saved).toHaveLength(1);
  } finally {
    driver.refresh = original;
  }
});

test('an expired OAuth token with no refresh token resolves to null, not a doomed request', async () => {
  const store = fakeStore({
    kind: 'oauth',
    provider: 'anthropic',
    accessToken: 'dead-token',
    expiresAt: Date.now() - 1000,
    refreshToken: null,
  });

  expect(await resolveCredential({ userId: 'u1', provider: 'anthropic', store })).toBeNull();
});

test('with no stored credential, the environment key is the fallback', async () => {
  const store = fakeStore(null);
  process.env.OPENROUTER_API_KEY = 'sk-or-from-env';

  const credential = await resolveCredential({
    userId: 'u1',
    provider: 'openrouter',
    store,
  });
  expect(credential).toEqual({
    kind: 'api_key',
    provider: 'openrouter',
    apiKey: 'sk-or-from-env',
  });

  process.env.OPENROUTER_API_KEY = '';
  expect(await resolveCredential({ userId: 'u1', provider: 'openrouter', store })).toBeNull();
});

test('OpenRouter refuses an OAuth credential rather than silently misusing it', () => {
  const driver = getDriver('openrouter');
  expect(driver.supports).not.toContain('oauth');
  expect(() =>
    driver.createModel(
      { kind: 'oauth', provider: 'openrouter', accessToken: 'x', expiresAt: 0 },
      'openai/gpt-5.1',
    ),
  ).toThrow(/does not support oauth/);
});

test('every advertised model supports tools — the agent cannot run without them', () => {
  const models = allModels();
  expect(models.length).toBeGreaterThan(0);
  expect(models.every((m) => m.supportsTools)).toBe(true);
});
