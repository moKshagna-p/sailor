'use client';

import type { PublicCredential } from '@sailor/core';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type ProviderInfo } from '../../lib/api.ts';

const PROVIDER_HELP: Record<string, string> = {
  anthropic: 'Claude models',
  openai: 'GPT models',
  google: 'Gemini models',
  openrouter: 'OpenRouter models',
};

export default function SettingsPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [credentials, setCredentials] = useState<PublicCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [modelResult, credentialResult] = await Promise.all([
        api.models(),
        api.listCredentials(),
      ]);
      setProviders(modelResult.providers);
      setCredentials(credentialResult.credentials);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load provider settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveKey = async (provider: string, apiKey: string) => {
    await api.addKey(provider, apiKey);
    await reload();
  };

  const removeKey = async (provider: string) => {
    setError(null);
    try {
      await api.deleteKey(provider);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove this key.');
    }
  };

  return (
    <main className="mx-auto min-h-full max-w-3xl px-8 py-14">
      <Link href="/" className="font-mono text-[11px] text-ink-500 hover:text-ochre">
        ← Your résumés
      </Link>
      <header className="mt-10 max-w-xl">
        <p className="font-mono text-[11px] tracking-[0.18em] text-ochre uppercase">Settings</p>
        <h1
          className="mt-2 text-4xl text-chalk-100"
          style={{ fontFamily: 'var(--font-display)', fontWeight: 500 }}
        >
          Model access
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-chalk-400">
          Add a provider key to this Sailor account. It is encrypted on the server, never shown
          again, and is used only to run the model you select.
        </p>
      </header>

      {error && (
        <p className="mt-7 border-l-2 border-strike py-1 pl-3 text-sm text-strike">{error}</p>
      )}

      <section className="mt-12">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-500 uppercase">Providers</h2>
        <div className="mt-4 divide-y divide-ink-700 border-y border-ink-700">
          {loading && <p className="py-5 text-sm text-ink-500">Loading providers…</p>}
          {providers.map((provider) => {
            const credential = credentials.find((item) => item.provider === provider.id);
            return (
              <ProviderRow
                key={provider.id}
                provider={provider}
                credential={credential}
                onSave={saveKey}
                onRemove={removeKey}
              />
            );
          })}
        </div>
      </section>
    </main>
  );
}

function ProviderRow({
  provider,
  credential,
  onSave,
  onRemove,
}: {
  provider: ProviderInfo;
  credential: PublicCredential | undefined;
  onSave: (provider: string, apiKey: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(provider.id, apiKey);
      setApiKey('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="py-5">
      <div className="flex items-start justify-between gap-5">
        <div>
          <h3 className="text-[15px] text-chalk-200">{provider.label}</h3>
          <p className="mt-1 font-mono text-[11px] text-ink-500">
            {PROVIDER_HELP[provider.id] ?? provider.id}
          </p>
        </div>
        {credential ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10.5px] tracking-wider text-added uppercase">
              Connected
            </span>
            <button
              type="button"
              onClick={() => void onRemove(provider.id)}
              className="font-mono text-[11px] text-ink-500 hover:text-strike"
            >
              Remove
            </button>
          </div>
        ) : provider.available ? (
          <span className="font-mono text-[10.5px] tracking-wider text-ochre uppercase">
            Env key
          </span>
        ) : (
          <span className="font-mono text-[10.5px] tracking-wider text-ink-500 uppercase">
            Not connected
          </span>
        )}
      </div>

      {!credential && (
        <form onSubmit={submit} className="mt-4 flex max-w-xl gap-2">
          <label className="sr-only" htmlFor={`${provider.id}-key`}>
            {provider.label} API key
          </label>
          <input
            id={`${provider.id}-key`}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            minLength={8}
            required
            autoComplete="off"
            placeholder="Paste API key"
            className="min-w-0 flex-1 border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-[12px] text-chalk-100 placeholder:text-ink-500 focus:border-ochre focus:outline-none"
          />
          <button
            type="submit"
            disabled={saving || apiKey.length < 8}
            className="shrink-0 border border-ochre px-3 py-2 font-mono text-[11px] text-ochre hover:bg-ochre hover:text-ink-900 disabled:opacity-30"
          >
            {saving ? 'Saving…' : 'Save key'}
          </button>
        </form>
      )}
      {error && <p className="mt-3 text-[12px] text-strike">{error}</p>}
    </article>
  );
}
