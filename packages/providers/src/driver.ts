import type { CredentialKind, ModelInfo, ProviderId, ResolvedCredential } from '@sailor/core';
import type { LanguageModel } from 'ai';
import { z } from 'zod';

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

/**
 * Everything the API needs to run an OAuth authorization-code flow, while the
 * driver retains ownership of provider-specific URLs, scopes, and token calls.
 * `clientId` is public; secrets never leave the driver process environment.
 */
export type OAuthConfig = {
  clientId: string;
  authorizationUrl: string;
  scopes: readonly string[];
  authorizationParams?: Readonly<Record<string, string>>;
  usesPkce: boolean;
  /**
   * Present when the provider's OAuth client refuses third-party redirect URIs
   * (Anthropic's public client allows only its own console page). The consent
   * screen then lands on `redirectUri` — a page the provider owns that displays
   * a `code#state` string — and the user pastes that string into Settings
   * instead of being redirected back to Sailor.
   */
  codePaste?: { redirectUri: string };
  exchangeCode(args: {
    code: string;
    /** Echoed by code-paste providers and required in their token exchange. */
    state: string | null;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthTokens>;
};

/**
 * Everything the rest of Sailor is allowed to know about a model provider.
 *
 * Adding a provider means adding ONE file under drivers/ and listing it in
 * registry.ts. It must not require touching the agent, the API, or the UI —
 * if it does, this abstraction has failed and the leak should be fixed here
 * rather than worked around at the call site.
 */
export type ProviderDriver = {
  id: ProviderId;
  label: string;
  /** Which auth kinds this provider actually supports. */
  supports: readonly CredentialKind[];
  /** Models we are willing to run the resume agent on. All must support tools. */
  models: readonly ModelInfo[];

  /** Build an AI SDK model bound to this credential. */
  createModel(credential: ResolvedCredential, modelId: string): LanguageModel;

  /**
   * Ask the provider whether this API key actually works, with a cheap
   * authenticated request. Returns false only when the provider definitively
   * rejected the key; a network fault or provider outage throws instead, so a
   * flaky connection is never reported to the user as "wrong key".
   */
  verifyApiKey(apiKey: string): Promise<boolean>;

  /** Omit this for API-key-only drivers or OAuth clients not configured here. */
  oauth?: OAuthConfig;

  /**
   * Exchange a refresh token for a new access token. Only meaningful for
   * providers whose `supports` includes 'oauth'.
   */
  refresh?(refreshToken: string): Promise<OAuthTokens>;
};

/** Bound how long a key-verification probe may hang before we call it a fault. */
export const KEY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Maps a key-probe response to "does this key work". `invalidStatuses` are the
 * codes this provider uses for a bad key (401/403 for most; Google adds 400).
 * Anything else non-OK is the provider's fault, not the key's, and throws.
 */
export function keyProbeResult(
  response: Response,
  provider: ProviderId,
  invalidStatuses: readonly number[] = [401, 403],
): boolean {
  if (response.ok) return true;
  if (invalidStatuses.includes(response.status)) return false;
  throw new Error(`${provider} API key verification failed (${response.status})`);
}

const OAuthTokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().finite(),
});

/** Parse token responses at the provider boundary; tokens themselves are never logged. */
export async function readOAuthTokens(
  response: Response,
  provider: ProviderId,
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
}> {
  if (!response.ok) {
    throw new Error(`${provider} OAuth token request failed (${response.status})`);
  }

  const result = OAuthTokenResponse.safeParse(await response.json());
  if (!result.success) {
    throw new Error(`${provider} OAuth token response was malformed`);
  }

  return {
    accessToken: result.data.access_token,
    refreshToken: result.data.refresh_token ?? null,
    expiresInSeconds: result.data.expires_in,
  };
}

/**
 * Thrown when a credential does not match what the driver can use — e.g. an
 * OAuth token handed to OpenRouter, which only takes API keys. Callers turn this
 * into a 400, never a 500: it is a configuration mistake, not a server fault.
 */
export class CredentialMismatchError extends Error {
  constructor(provider: ProviderId, kind: CredentialKind) {
    super(`Provider "${provider}" does not support ${kind} credentials`);
    this.name = 'CredentialMismatchError';
  }
}

export function assertSupports(driver: ProviderDriver, credential: ResolvedCredential): void {
  if (!driver.supports.includes(credential.kind)) {
    throw new CredentialMismatchError(driver.id, credential.kind);
  }
}
