import { createAnthropic } from '@ai-sdk/anthropic';
import type { ResolvedCredential } from '@sailor/core';
import type { LanguageModel } from 'ai';
import {
  assertSupports,
  KEY_PROBE_TIMEOUT_MS,
  keyProbeResult,
  type ProviderDriver,
  readOAuthTokens,
} from '../driver.ts';

/**
 * Anthropic accepts either an `x-api-key` (API key) or an `Authorization: Bearer`
 * (OAuth, i.e. a Claude subscription). The SDK models this as `apiKey` vs
 * `authToken`, so both paths are first-class and we do not need a custom fetch.
 *
 * The OAuth beta header is required for subscription tokens; without it the API
 * rejects the token even though it is valid.
 */
const OAUTH_BETA = 'oauth-2025-04-20';

// Public PKCE client id used by Anthropic's own first-party OAuth flow. Not a
// secret — PKCE exists precisely so a public client needs none. `||`, not `??`:
// a blank ANTHROPIC_OAUTH_CLIENT_ID= line in .env must mean "use the default",
// not "send an empty client_id to the provider".
const CLIENT_ID = process.env.ANTHROPIC_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export const anthropicDriver: ProviderDriver = {
  id: 'anthropic',
  label: 'Anthropic',
  supports: ['api_key', 'oauth'],
  models: [
    {
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      contextWindow: 200_000,
      supportsTools: true,
      tier: 'frontier',
    },
    {
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      contextWindow: 200_000,
      supportsTools: true,
      tier: 'frontier',
    },
    {
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      contextWindow: 200_000,
      supportsTools: true,
      tier: 'fast',
    },
  ],

  createModel(credential: ResolvedCredential, modelId: string): LanguageModel {
    assertSupports(anthropicDriver, credential);

    const provider =
      credential.kind === 'oauth'
        ? createAnthropic({
            authToken: credential.accessToken,
            headers: { 'anthropic-beta': OAUTH_BETA },
          })
        : createAnthropic({ apiKey: credential.apiKey });

    return provider(modelId);
  },

  async verifyApiKey(apiKey: string): Promise<boolean> {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(KEY_PROBE_TIMEOUT_MS),
    });
    return keyProbeResult(res, 'anthropic');
  },

  oauth: {
    clientId: CLIENT_ID,
    authorizationUrl: 'https://claude.ai/oauth/authorize',
    scopes: ['user:profile', 'user:inference', 'org:create_api_key'],
    // Anthropic's public client asks for the authorization-code response explicitly.
    authorizationParams: { code: 'true' },
    usesPkce: true,
    // This public client rejects any redirect URI that is not Anthropic's own —
    // pointing it at Sailor's /callback fails with "Redirect URI … is not
    // supported by client". Consent therefore lands on Anthropic's code page,
    // and the user pastes the displayed `code#state` into Settings.
    codePaste: { redirectUri: 'https://console.anthropic.com/oauth/code/callback' },
    async exchangeCode({ code, state, redirectUri, codeVerifier }) {
      if (!codeVerifier) throw new Error('Anthropic OAuth requires a PKCE verifier');

      const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          // The code-paste exchange requires the state that came glued to the code.
          ...(state ? { state } : {}),
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      const token = await readOAuthTokens(res, 'anthropic');
      return {
        kind: 'oauth',
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: Date.now() + token.expiresInSeconds * 1000,
      };
    },
  },

  async refresh(refreshToken: string) {
    const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    const token = await readOAuthTokens(res, 'anthropic');

    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? refreshToken,
      expiresAt: Date.now() + token.expiresInSeconds * 1000,
    };
  },
};
