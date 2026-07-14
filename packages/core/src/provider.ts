import { z } from 'zod';

export const providerIds = ['anthropic', 'openai', 'google', 'openrouter'] as const;
export const ProviderId = z.enum(providerIds);
export type ProviderId = z.infer<typeof ProviderId>;

/** How we authenticate to a provider. Not every provider supports every kind. */
export const CredentialKind = z.enum(['api_key', 'oauth']);
export type CredentialKind = z.infer<typeof CredentialKind>;

/**
 * A resolved credential, ready to sign a request. This type never leaves the
 * server — see `PublicCredential` for what the client is allowed to see.
 */
export type ResolvedCredential =
  | { kind: 'api_key'; provider: ProviderId; apiKey: string }
  | {
      kind: 'oauth';
      provider: ProviderId;
      accessToken: string;
      /** Epoch ms. The gateway refreshes when within `REFRESH_SKEW_MS` of this. */
      expiresAt: number;
    };

/** The only credential shape an API route may return. Contains no secret. */
export const PublicCredential = z.object({
  provider: ProviderId,
  kind: CredentialKind,
  label: z.string(),
  expiresAt: z.number().nullable(),
});
export type PublicCredential = z.infer<typeof PublicCredential>;

export const ModelRef = z.object({
  provider: ProviderId,
  /** Provider-native model id, e.g. `claude-opus-4-8`, `gpt-5.1`, `openai/gpt-5.1`. */
  modelId: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRef>;

export type ModelInfo = ModelRef & {
  label: string;
  /** Rough capability hints used to pick a sane default, not billing-accurate. */
  contextWindow: number;
  supportsTools: boolean;
  /** Our judgement of fitness for multi-step editing work. */
  tier: 'frontier' | 'fast';
};

export const modelRefToString = (m: ModelRef): string => `${m.provider}:${m.modelId}`;

export function parseModelRef(value: string): ModelRef {
  const idx = value.indexOf(':');
  if (idx === -1) throw new Error(`Malformed model ref "${value}", expected "provider:modelId"`);
  return ModelRef.parse({
    provider: value.slice(0, idx),
    modelId: value.slice(idx + 1),
  });
}
