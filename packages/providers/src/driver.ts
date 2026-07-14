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
  exchangeCode(args: {
    code: string;
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

  /** Omit this for API-key-only drivers or OAuth clients not configured here. */
  oauth?: OAuthConfig;

  /**
   * Exchange a refresh token for a new access token. Only meaningful for
   * providers whose `supports` includes 'oauth'.
   */
  refresh?(refreshToken: string): Promise<OAuthTokens>;
};

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
