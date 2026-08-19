'use client';

import { useState } from 'react';
import { authClient } from '../../lib/auth-client.ts';

type LoginProvider = 'google' | 'github';

export default function SignInPage() {
  const [busy, setBusy] = useState<LoginProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (provider: LoginProvider) => {
    setBusy(provider);
    setError(null);
    const result = await authClient.signIn.social({
      provider,
      callbackURL: window.location.origin,
    });
    if (result.error) {
      setError(result.error.message ?? 'Sign-in could not be started.');
      setBusy(null);
    }
  };

  return (
    <main className="grid min-h-full place-items-center px-6">
      <section className="w-full max-w-sm border border-ink-700 bg-ink-850 p-7">
        <p className="font-mono text-[10.5px] tracking-[0.18em] text-ochre uppercase">Sailor</p>
        <h1
          className="mt-2 text-3xl text-chalk-100"
          style={{ fontFamily: 'var(--font-display)', fontWeight: 500 }}
        >
          Sign in
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-chalk-400">
          Your résumés, versions, and model credentials stay tied to your account.
        </p>

        <div className="mt-7 grid gap-3">
          {(['google', 'github'] as const).map((provider) => (
            <button
              key={provider}
              type="button"
              disabled={busy !== null}
              onClick={() => void signIn(provider)}
              className="border border-ink-600 px-4 py-2.5 text-sm text-chalk-200 hover:border-ochre hover:text-chalk-100 disabled:opacity-40"
            >
              {busy === provider
                ? 'Opening…'
                : `Continue with ${provider === 'google' ? 'Google' : 'GitHub'}`}
            </button>
          ))}
        </div>

        {error && <p className="mt-4 border-l-2 border-strike pl-3 text-sm text-strike">{error}</p>}
      </section>
    </main>
  );
}
