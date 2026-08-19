'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { authClient } from '../lib/auth-client.ts';

export function SessionGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data, isPending } = authClient.useSession();
  const signingIn = pathname === '/sign-in';

  useEffect(() => {
    if (isPending) return;
    if (signingIn && data) router.replace('/');
    if (!signingIn && !data) router.replace('/sign-in');
  }, [data, isPending, router, signingIn]);

  if (signingIn) return children;
  if (isPending || !data) {
    return (
      <main className="grid h-full place-items-center font-mono text-xs text-ink-500">
        Checking session…
      </main>
    );
  }
  return children;
}
