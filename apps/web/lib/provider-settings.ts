import type { PublicCredential } from '@sailor/core';
import type { ProviderInfo } from './api.ts';

export const prefersOAuth = (provider: ProviderInfo): boolean =>
  provider.oauthFlow !== null && provider.oauthMissingEnv.length === 0;

export function providerStatus(
  provider: ProviderInfo,
  credential: PublicCredential | undefined,
): string {
  if (credential)
    return credential.kind === 'oauth' ? 'Connected · Account' : 'Connected · API key';
  return provider.available ? 'Environment key' : 'Not connected';
}
