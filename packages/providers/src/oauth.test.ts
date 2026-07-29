import { afterEach, expect, test } from 'bun:test';
import { getDriver } from './registry.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch for one call and records what the driver actually sent. */
function captureFetch(response: Response): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
  return { calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('openrouter offers OAuth with nothing for an operator to configure', () => {
  const driver = getDriver('openrouter');
  expect(driver.oauth).toBeDefined();
  // The whole point: no client registration, so no env vars to be missing.
  expect(driver.oauth?.clientId).toBeNull();
  expect(driver.oauthRequires).toBeUndefined();
});

test('openrouter carries state through the callback URL, since its consent URL has no state param', () => {
  const oauth = getDriver('openrouter').oauth;
  if (!oauth?.buildAuthorizationUrl) throw new Error('expected a custom authorize URL builder');

  const url = new URL(
    oauth.buildAuthorizationUrl({
      redirectUri: 'http://localhost:3001/api/oauth/openrouter/callback',
      state: 'state-token',
      codeChallenge: 'challenge-value',
    }),
  );

  expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
  // It spells the redirect `callback_url`, and takes no `state` of its own...
  expect(url.searchParams.get('state')).toBeNull();
  expect(url.searchParams.get('redirect_uri')).toBeNull();

  // ...so state has to survive inside the callback URL or the callback route
  // has no way to bind the response to the user who started the flow.
  const callback = new URL(url.searchParams.get('callback_url') ?? '');
  expect(callback.origin + callback.pathname).toBe(
    'http://localhost:3001/api/oauth/openrouter/callback',
  );
  expect(callback.searchParams.get('state')).toBe('state-token');

  expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
});

test('openrouter exchange yields an API key, not a token with a fabricated expiry', async () => {
  const oauth = getDriver('openrouter').oauth;
  if (!oauth) throw new Error('expected openrouter to expose oauth');
  const { calls } = captureFetch(json({ key: 'sk-or-v1-issued-by-openrouter' }));

  const credential = await oauth.exchangeCode({
    code: 'auth-code',
    state: null,
    redirectUri: 'http://localhost:3001/api/oauth/openrouter/callback',
    codeVerifier: 'verifier',
  });

  expect(credential).toEqual({ kind: 'api_key', apiKey: 'sk-or-v1-issued-by-openrouter' });

  const [call] = calls;
  expect(call?.url).toBe('https://openrouter.ai/api/v1/auth/keys');
  expect(call?.init?.method).toBe('POST');
  expect(JSON.parse(String(call?.init?.body))).toEqual({
    code: 'auth-code',
    code_verifier: 'verifier',
    code_challenge_method: 'S256',
  });
});

test('a malformed or rejected exchange throws rather than storing a junk credential', async () => {
  const oauth = getDriver('openrouter').oauth;
  if (!oauth) throw new Error('expected openrouter to expose oauth');
  const args = {
    code: 'auth-code',
    state: null,
    redirectUri: 'http://localhost:3001/api/oauth/openrouter/callback',
    codeVerifier: 'verifier',
  };

  captureFetch(json({ notAKey: true }));
  expect(oauth.exchangeCode(args)).rejects.toThrow(/malformed/i);

  captureFetch(json({ error: 'bad code' }, 400));
  expect(oauth.exchangeCode(args)).rejects.toThrow(/400/);
});

test('token-issuing providers still tag their result as oauth', async () => {
  const oauth = getDriver('anthropic').oauth;
  if (!oauth) throw new Error('expected anthropic to expose oauth');
  captureFetch(json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));

  const credential = await oauth.exchangeCode({
    code: 'code',
    state: 'state',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    codeVerifier: 'verifier',
  });

  expect(credential.kind).toBe('oauth');
  if (credential.kind !== 'oauth') throw new Error('unreachable');
  expect(credential.accessToken).toBe('at');
  expect(credential.expiresAt).toBeGreaterThan(Date.now());
});

test('providers whose OAuth needs operator setup say which variables are missing', () => {
  // Without this the UI cannot tell "no OAuth support" from "not set up here",
  // and a missing Connect button just looks like a bug.
  expect(getDriver('openai').oauthRequires).toEqual(['OPENAI_OAUTH_CLIENT_ID']);
  expect(getDriver('google').oauthRequires).toEqual([
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
  ]);
});
