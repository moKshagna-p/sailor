import { createOpenAI } from '@ai-sdk/openai';
import type { ResolvedCredential } from '@sailor/core';
import type { LanguageModel } from 'ai';
import {
  assertSupports,
  KEY_PROBE_TIMEOUT_MS,
  keyProbeResult,
  type ProviderDriver,
  readOAuthTokens,
} from '../driver.ts';

const CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OPENAI_OAUTH_CLIENT_SECRET;

/**
 * OpenAI authenticates with `Authorization: Bearer <token>` in both modes, so an
 * OAuth access token slots into the same place an API key does — no custom fetch
 * needed. The difference is only in how we *obtain* and *refresh* the token.
 */
export const openaiDriver: ProviderDriver = {
  id: 'openai',
  label: 'OpenAI',
  supports: ['api_key', 'oauth'],
  oauthRequires: ['OPENAI_OAUTH_CLIENT_ID'],
  models: [
    {
      provider: 'openai',
      modelId: 'gpt-5.1',
      label: 'GPT-5.1',
      contextWindow: 400_000,
      supportsTools: true,
      tier: 'frontier',
    },
    {
      provider: 'openai',
      modelId: 'gpt-5.1-mini',
      label: 'GPT-5.1 mini',
      contextWindow: 400_000,
      supportsTools: true,
      tier: 'fast',
    },
  ],

  createModel(credential: ResolvedCredential, modelId: string): LanguageModel {
    assertSupports(openaiDriver, credential);

    const token = credential.kind === 'oauth' ? credential.accessToken : credential.apiKey;
    return createOpenAI({ apiKey: token })(modelId);
  },

  async verifyApiKey(apiKey: string): Promise<boolean> {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(KEY_PROBE_TIMEOUT_MS),
    });
    return keyProbeResult(res, 'openai');
  },

  ...(CLIENT_ID
    ? {
        oauth: {
          clientId: CLIENT_ID,
          authorizationUrl: 'https://auth.openai.com/oauth/authorize',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          usesPkce: true,
          async exchangeCode({ code, redirectUri, codeVerifier }) {
            const body = new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              client_id: CLIENT_ID,
              redirect_uri: redirectUri,
            });
            if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);
            if (codeVerifier) body.set('code_verifier', codeVerifier);

            const res = await fetch('https://auth.openai.com/oauth/token', {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body,
            });
            const token = await readOAuthTokens(res, 'openai');
            return {
              kind: 'oauth',
              accessToken: token.accessToken,
              refreshToken: token.refreshToken,
              expiresAt: Date.now() + token.expiresInSeconds * 1000,
            };
          },
        },
      }
    : {}),

  async refresh(refreshToken: string) {
    if (!CLIENT_ID) throw new Error('OPENAI_OAUTH_CLIENT_ID is not set');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
    if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);

    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const token = await readOAuthTokens(res, 'openai');

    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? refreshToken,
      expiresAt: Date.now() + token.expiresInSeconds * 1000,
    };
  },
};
