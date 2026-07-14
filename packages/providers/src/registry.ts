import type { ModelInfo, ProviderId, ResolvedCredential } from '@sailor/core';
import type { LanguageModel } from 'ai';
import type { ProviderDriver } from './driver.ts';
import { anthropicDriver } from './drivers/anthropic.ts';
import { googleDriver } from './drivers/google.ts';
import { openaiDriver } from './drivers/openai.ts';
import { openrouterDriver } from './drivers/openrouter.ts';

const DRIVERS: Record<ProviderId, ProviderDriver> = {
  anthropic: anthropicDriver,
  openai: openaiDriver,
  google: googleDriver,
  openrouter: openrouterDriver,
};

export function getDriver(provider: ProviderId): ProviderDriver {
  return DRIVERS[provider];
}

export function allDrivers(): ProviderDriver[] {
  return Object.values(DRIVERS);
}

export function allModels(): ModelInfo[] {
  return allDrivers().flatMap((d) => [...d.models]);
}

/** Refresh this far *before* actual expiry — a token that dies mid-stream is worse
 *  than one refreshed a minute early. */
const REFRESH_SKEW_MS = 60_000;

export type CredentialStore = {
  load(
    userId: string,
    provider: ProviderId,
  ): Promise<(ResolvedCredential & { refreshToken: string | null }) | null>;
  save(
    userId: string,
    provider: ProviderId,
    next: {
      accessToken: string;
      refreshToken: string | null;
      expiresAt: number;
    },
  ): Promise<void>;
};

/**
 * Resolves a usable credential, refreshing an expiring OAuth token first.
 *
 * Environment keys are the fallback, not the primary: a signed-in user's own
 * stored credential always wins. That ordering is what lets the operator run
 * Sailor with their own key for themselves while other users bring their own.
 */
export async function resolveCredential(args: {
  userId: string;
  provider: ProviderId;
  store: CredentialStore;
}): Promise<ResolvedCredential | null> {
  const { userId, provider, store } = args;
  const stored = await store.load(userId, provider);

  if (stored) {
    if (stored.kind !== 'oauth') return stored;

    const stillFresh = stored.expiresAt - REFRESH_SKEW_MS > Date.now();
    if (stillFresh) return stored;

    const driver = getDriver(provider);
    if (!driver.refresh || !stored.refreshToken) {
      // Expired, and nothing we can do about it. Surfacing null sends the user
      // back through sign-in, which is the correct outcome — far better than
      // firing a request we know will 401 mid-stream.
      return null;
    }

    const next = await driver.refresh(stored.refreshToken);
    await store.save(userId, provider, next);
    return {
      kind: 'oauth',
      provider,
      accessToken: next.accessToken,
      expiresAt: next.expiresAt,
    };
  }

  const envKey = envApiKey(provider);
  return envKey ? { kind: 'api_key', provider, apiKey: envKey } : null;
}

function envApiKey(provider: ProviderId): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'google':
      return process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY;
  }
}

export class NoCredentialError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(
      `No usable credential for "${provider}". Add an API key or connect the ` +
        `account in Settings, or set the provider's key in the environment.`,
    );
    this.name = 'NoCredentialError';
  }
}

/** The single entry point the agent uses to get a model. */
export async function getModel(args: {
  userId: string;
  provider: ProviderId;
  modelId: string;
  store: CredentialStore;
}): Promise<LanguageModel> {
  const credential = await resolveCredential(args);
  if (!credential) throw new NoCredentialError(args.provider);
  return getDriver(args.provider).createModel(credential, args.modelId);
}

/** Which providers are usable right now — drives the model picker in the UI. */
export async function availableProviders(
  userId: string,
  store: CredentialStore,
): Promise<ProviderId[]> {
  const checks = await Promise.all(
    allDrivers().map(async (d) => {
      const credential = await resolveCredential({
        userId,
        provider: d.id,
        store,
      }).catch(
        // A refresh failure must not take down the whole picker; that provider
        // is simply unavailable until the user reconnects it.
        () => null,
      );
      return credential ? d.id : null;
    }),
  );
  return checks.filter((id): id is ProviderId => id !== null);
}
