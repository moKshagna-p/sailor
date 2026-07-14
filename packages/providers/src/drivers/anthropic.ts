import { createAnthropic } from '@ai-sdk/anthropic';
import type { ResolvedCredential } from '@sailor/core';
import type { LanguageModel } from 'ai';
import { assertSupports, type ProviderDriver, readOAuthTokens } from '../driver.ts';

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
// secret — PKCE exists precisely so a public client needs none.
const CLIENT_ID = process.env.ANTHROPIC_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

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

  oauth: {
    clientId: CLIENT_ID,
    authorizationUrl: 'https://claude.ai/oauth/authorize',
    scopes: ['user:profile', 'user:inference', 'org:create_api_key'],
    // Anthropic's public client asks for the authorization-code response explicitly.
    authorizationParams: { code: 'true' },
    usesPkce: true,
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      if (!codeVerifier) throw new Error('Anthropic OAuth requires a PKCE verifier');

      const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      const token = await readOAuthTokens(res, 'anthropic');
      return {
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
