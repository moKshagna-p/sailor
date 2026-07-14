import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ResolvedCredential } from '@sailor/core';
import type { LanguageModel } from 'ai';
import { assertSupports, type ProviderDriver } from '../driver.ts';

/**
 * OpenRouter is the escape hatch: one API key, hundreds of models. It is
 * deliberately API-key-only — it has no user-facing OAuth, and pretending
 * otherwise would just produce a confusing dead button in the UI.
 *
 * The model list here is a curated starting point, not a limit. `modelId` is a
 * free string, so any OpenRouter slug works if the user types it.
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
  ],

  createModel(credential: ResolvedCredential, modelId: string): LanguageModel {
    assertSupports(openrouterDriver, credential);
    if (credential.kind !== 'api_key') {
      // Unreachable given `supports`, but the type narrowing has to be earned.
      throw new Error('OpenRouter requires an API key');
    }

    return createOpenRouter({ apiKey: credential.apiKey })(modelId) as LanguageModel;
  },
};
