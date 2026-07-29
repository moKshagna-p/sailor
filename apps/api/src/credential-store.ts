import type { ProviderId } from '@sailor/core';
import { getDecryptedCredential, upsertCredential } from '@sailor/db';
import type { CredentialStore } from '@sailor/providers';

/**
 * Bridges the provider gateway to the database. The gateway defines the shape it
 * needs; the db owns the storage. Neither imports the other — this is the seam.
 */
export const credentialStore: CredentialStore = {
  async load(userId: string, provider: ProviderId) {
    return getDecryptedCredential(userId, provider);
  },

  async save(userId, provider, next) {
    // A sign-in flow does not imply a token. OpenRouter's consent screen ends by
    // minting a durable API key, so what gets stored follows the credential's
    // own kind rather than the shape of the flow that produced it.
    if (next.kind === 'api_key') {
      await upsertCredential({
        userId,
        provider,
        kind: 'api_key',
        label: `${provider} (connected)`,
        secret: next.apiKey,
      });
      return;
    }

    await upsertCredential({
      userId,
      provider,
      kind: 'oauth',
      label: `${provider} (connected)`,
      secret: next.accessToken,
      refreshSecret: next.refreshToken ?? undefined,
      expiresAt: new Date(next.expiresAt),
    });
  },
};
