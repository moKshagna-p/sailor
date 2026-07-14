import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ResolvedCredential } from '@sailor/core';
import type { LanguageModel } from 'ai';
import { assertSupports, type ProviderDriver, readOAuthTokens } from '../driver.ts';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

/**
 * Gemini takes an API key in the `x-goog-api-key` header, which the SDK sets from
 * `apiKey`. For OAuth (a Google account rather than an AI Studio key) the same
 * endpoint accepts `Authorization: Bearer`, so we send the token as a header and
 * pass an empty apiKey — the SDK omits the key header when apiKey is empty.
 */
export const googleDriver: ProviderDriver = {
  id: 'google',
  label: 'Google Gemini',
  supports: ['api_key', 'oauth'],
  models: [
    {
      provider: 'google',
      modelId: 'gemini-3-pro-preview',
      label: 'Gemini 3 Pro',
      contextWindow: 1_000_000,
      supportsTools: true,
      tier: 'frontier',
    },
    {
      provider: 'google',
      modelId: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      contextWindow: 1_000_000,
      supportsTools: true,
      tier: 'fast',
    },
  ],

  createModel(credential: ResolvedCredential, modelId: string): LanguageModel {
    assertSupports(googleDriver, credential);

    const provider =
      credential.kind === 'oauth'
        ? createGoogleGenerativeAI({
            apiKey: '',
            headers: { Authorization: `Bearer ${credential.accessToken}` },
          })
        : createGoogleGenerativeAI({ apiKey: credential.apiKey });

    return provider(modelId);
  },

  ...(CLIENT_ID && CLIENT_SECRET
    ? {
        oauth: {
          clientId: CLIENT_ID,
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          scopes: ['https://www.googleapis.com/auth/generative-language'],
          authorizationParams: {
            access_type: 'offline',
            include_granted_scopes: 'true',
            prompt: 'consent',
          },
          usesPkce: true,
          async exchangeCode({ code, redirectUri, codeVerifier }) {
            const body = new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              client_id: CLIENT_ID,
              client_secret: CLIENT_SECRET,
              redirect_uri: redirectUri,
            });
            if (codeVerifier) body.set('code_verifier', codeVerifier);

            const res = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body,
            });
            const token = await readOAuthTokens(res, 'google');
            return {
              accessToken: token.accessToken,
              refreshToken: token.refreshToken,
              expiresAt: Date.now() + token.expiresInSeconds * 1000,
            };
          },
        },
      }
    : {}),

  async refresh(refreshToken: string) {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must both be set');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });

    const token = await readOAuthTokens(res, 'google');

    return {
      accessToken: token.accessToken,
      // Google does not rotate refresh tokens on refresh; keep the one we have.
      refreshToken,
      expiresAt: Date.now() + token.expiresInSeconds * 1000,
    };
  },
};
