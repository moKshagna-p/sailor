import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ResolvedCredential } from '@sailor/core';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import {
  assertSupports,
  type ExchangedCredential,
  KEY_PROBE_TIMEOUT_MS,
  keyProbeResult,
  type ProviderDriver,
} from '../driver.ts';

/** OpenRouter ends its consent flow by minting a key, not by issuing a token. */
const AuthKeyResponse = z.object({ key: z.string().min(8) });

/**
 * OpenRouter is the escape hatch: one credential, hundreds of models across
 * every major lab.
 *
 * It is also the only provider here whose sign-in needs no setup from the
 * operator. There is no client to register and no secret to configure —
 * OpenRouter identifies the app by the callback URL alone and accepts localhost
 * on any port. That makes it the one path where a brand-new user with no API
 * key anywhere can get to a working model by clicking one button, which is why
 * the Settings page leads with it.
 *
 * Its flow is OAuth-shaped but ends somewhere different: instead of an expiring
 * access token it mints a durable API key scoped to the user. So `supports` is
 * still api_key-only — the OAuth part is how the key is *obtained*, not what
 * gets stored.
 */
export const openrouterDriver: ProviderDriver = {
  id: 'openrouter',
  label: 'OpenRouter',
  supports: ['api_key'],
  models: [
    {
      provider: 'openrouter',
      modelId: 'anthropic/claude-opus-4.8',
      label: 'Claude Opus 4.8 (via OpenRouter)',
      contextWindow: 200_000,
      supportsTools: true,
      tier: 'frontier',
    },
    {
      provider: 'openrouter',
      modelId: 'openai/gpt-5.1',
      label: 'GPT-5.1 (via OpenRouter)',
      contextWindow: 400_000,
      supportsTools: true,
      tier: 'frontier',
    },
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3-pro-preview',
      label: 'Gemini 3 Pro (via OpenRouter)',
      contextWindow: 1_000_000,
      supportsTools: true,
      tier: 'frontier',
    },
    // Free tiers, so that connecting an account with no credit still reaches a
    // working agent. Both are tool-capable, which most free slugs are not — an
    // agent model that cannot call tools is useless here, however cheap it is.
    {
      provider: 'openrouter',
      modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      label: 'Nemotron 3 Ultra — free (via OpenRouter)',
      contextWindow: 1_000_000,
      supportsTools: true,
      tier: 'frontier',
    },
    {
      provider: 'openrouter',
      modelId: 'openai/gpt-oss-20b:free',
      label: 'GPT-OSS 20B — free (via OpenRouter)',
      contextWindow: 131_072,
      supportsTools: true,
      tier: 'fast',
    },
  ],

  createModel(credential: ResolvedCredential, modelId: string): LanguageModel {
    assertSupports(openrouterDriver, credential);
    if (credential.kind !== 'api_key') {
      // Unreachable given `supports`, but the type narrowing has to be earned.
      throw new Error('OpenRouter requires an API key');
    }

    return createOpenRouter({ apiKey: credential.apiKey })(modelId) as LanguageModel;
  },

  async verifyApiKey(apiKey: string): Promise<boolean> {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(KEY_PROBE_TIMEOUT_MS),
    });
    return keyProbeResult(res, 'openrouter');
  },

  oauth: {
    // Nothing to register, so nothing to configure. This descriptor is always
    // present, unlike OpenAI's and Google's, which appear only once an operator
    // has supplied client credentials.
    clientId: null,
    authorizationUrl: 'https://openrouter.ai/auth',
    scopes: [],
    usesPkce: true,

    /**
     * OpenRouter's consent URL takes `callback_url` rather than `redirect_uri`,
     * and has no `state` parameter of its own. We therefore carry state inside
     * the callback URL's query string, which OpenRouter preserves when it
     * appends `?code=`. The callback route still gets the state it requires to
     * bind the response to the user who started the flow.
     */
    buildAuthorizationUrl({ redirectUri, state, codeChallenge }): string {
      const callback = new URL(redirectUri);
      callback.searchParams.set('state', state);

      const url = new URL('https://openrouter.ai/auth');
      url.searchParams.set('callback_url', callback.toString());
      if (codeChallenge) {
        url.searchParams.set('code_challenge', codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier }): Promise<ExchangedCredential> {
      const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          ...(codeVerifier ? { code_verifier: codeVerifier, code_challenge_method: 'S256' } : {}),
        }),
        signal: AbortSignal.timeout(KEY_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`openrouter OAuth key exchange failed (${res.status})`);
      }

      const result = AuthKeyResponse.safeParse(await res.json());
      if (!result.success) {
        throw new Error('openrouter OAuth key exchange returned a malformed response');
      }

      // A key, not a token: no expiry to fake and no refresh to schedule.
      return { kind: 'api_key', apiKey: result.data.key };
    },
  },
};
