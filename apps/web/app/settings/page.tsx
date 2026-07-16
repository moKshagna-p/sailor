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
  const [oauthNotice, setOauthNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // The OAuth callback lands here as `/settings?oauth=connected|error`. Read it
  // once, show a banner, and scrub the query so a refresh does not re-announce it.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const outcome = query.get('oauth');
    if (!outcome) return;
    setOauthNotice(
      outcome === 'connected'
        ? { ok: true, text: 'Account connected. Its models are ready to use.' }
        : { ok: false, text: query.get('reason') ?? 'The connection could not be completed.' },
    );
    window.history.replaceState(null, '', '/settings');
  }, []);

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

  const exchangeCode = async (provider: string, code: string) => {
    await api.exchangeOAuthCode(provider, code);
    setOauthNotice({ ok: true, text: 'Account connected. Its models are ready to use.' });
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
          Connect a provider account, or paste an API key — keys are verified with the provider
          before they are saved. Credentials are encrypted on the server, never shown again, and
          used only to run the model you select.
        </p>
      </header>

      {oauthNotice && (
        <p
          className={`mt-7 border-l-2 py-1 pl-3 text-sm ${
            oauthNotice.ok ? 'border-added text-added' : 'border-strike text-strike'
          }`}
        >
          {oauthNotice.text}
        </p>
      )}
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
                onExchangeCode={exchangeCode}
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
  onExchangeCode,
}: {
  provider: ProviderInfo;
  credential: PublicCredential | undefined;
  onSave: (provider: string, apiKey: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
  onExchangeCode: (provider: string, code: string) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState('');
  const [exchanging, setExchanging] = useState(false);

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

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setExchanging(true);
    setError(null);
    try {
      await onExchangeCode(provider.id, pastedCode);
      setPastedCode('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not complete the connection.');
    } finally {
      setExchanging(false);
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
              {credential.kind === 'oauth' ? 'Connected · Account' : 'Connected · API key'}
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

      {!credential && provider.oauthFlow === 'redirect' && (
        <div className="mt-4 flex max-w-xl items-center gap-3">
          {/* A plain navigation on purpose: the API answers with a 302 straight
              to the provider's consent screen. */}
          <a
            href={api.oauthAuthorizeUrl(provider.id)}
            className="shrink-0 border border-ochre px-3 py-2 font-mono text-[11px] text-ochre hover:bg-ochre hover:text-ink-900"
          >
            Connect {provider.label} account
          </a>
          <span className="font-mono text-[11px] text-ink-500">or paste an API key below</span>
        </div>
      )}

      {!credential && provider.oauthFlow === 'code-paste' && (
        <div className="mt-4 max-w-xl">
          <div className="flex items-center gap-3">
            {/* This provider's consent page cannot send the browser back to
                Sailor. It opens in a new tab, displays a code after approval,
                and the user pastes that code below. */}
            <a
              href={api.oauthAuthorizeUrl(provider.id)}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 border border-ochre px-3 py-2 font-mono text-[11px] text-ochre hover:bg-ochre hover:text-ink-900"
            >
              Connect {provider.label} account ↗
            </a>
            <span className="font-mono text-[11px] text-ink-500">
              approve there, then paste the code it shows
            </span>
          </div>
          {provider.id === 'anthropic' && (
            <p className="mt-2 max-w-xl font-mono text-[11px] leading-relaxed text-ochre">
              Heads up: this connects a Claude <em>subscription</em>, which Anthropic only permits
              inside Claude Code — Sailor cannot run the model with it. For Sailor, add an API key
              below instead (create one at console.anthropic.com).
            </p>
          )}
          <form onSubmit={submitCode} className="mt-2 flex gap-2">
            <label className="sr-only" htmlFor={`${provider.id}-oauth-code`}>
              {provider.label} authorization code
            </label>
            <input
              id={`${provider.id}-oauth-code`}
              type="text"
              value={pastedCode}
              onChange={(event) => setPastedCode(event.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the code here (looks like xxxx#xxxx)"
              className="min-w-0 flex-1 border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-[12px] text-chalk-100 placeholder:text-ink-500 focus:border-ochre focus:outline-none"
            />
            <button
              type="submit"
              disabled={exchanging || pastedCode.trim().length === 0}
              className="shrink-0 border border-ochre px-3 py-2 font-mono text-[11px] text-ochre hover:bg-ochre hover:text-ink-900 disabled:opacity-30"
            >
              {exchanging ? 'Connecting…' : 'Finish connecting'}
            </button>
          </form>
          <p className="mt-2 font-mono text-[11px] text-ink-500">or paste an API key below</p>
        </div>
      )}

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
