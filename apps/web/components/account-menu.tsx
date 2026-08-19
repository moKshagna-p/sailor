'use client';

import Link from 'next/link';
import { authClient } from '../lib/auth-client.ts';

export function AccountMenu() {
  const { data } = authClient.useSession();
  if (!data) return null;

  return (
    <details className="relative">
      <summary className="cursor-pointer list-none font-mono text-[11px] text-ink-500 hover:text-ochre">
        {data.user.name || data.user.email}
      </summary>
      <div className="absolute right-0 z-40 mt-2 min-w-36 border border-ink-600 bg-ink-850 p-2 shadow-xl">
        <Link
          href="/settings"
          className="block px-2 py-1.5 font-mono text-[11px] text-chalk-300 hover:text-ochre"
        >
          Settings
        </Link>
        <button
          type="button"
          onClick={() =>
            void authClient.signOut({
              fetchOptions: { onSuccess: () => location.assign('/sign-in') },
            })
          }
          className="block w-full px-2 py-1.5 text-left font-mono text-[11px] text-chalk-300 hover:text-strike"
        >
          Sign out
        </button>
      </div>
    </details>
  );
}
