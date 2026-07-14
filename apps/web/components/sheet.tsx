'use client';

import type { PreviewState } from '../lib/use-preview.ts';

/**
 * The PDF, presented as an actual sheet of paper on the desk. This is the only
 * bright surface in the app, and that is deliberate — everything else is chrome
 * around the document.
 *
 * It NEVER goes blank. A failing compile keeps the last good render on screen and
 * annotates it; that is why `error` and `url` coexist rather than being a union.
 */
export function Sheet({ state }: { state: PreviewState }) {
  return (
    <div className="relative flex h-full flex-col bg-ink-850">
      <header className="rule-b flex items-center justify-between px-4 py-2.5">
        <span className="font-mono text-[11px] tracking-widest text-ink-500 uppercase">
          Preview
        </span>
        <span className="flex items-center gap-2 font-mono text-[11px]">
          {state.compiling && <span className="breathe text-ochre">compiling…</span>}
          {!state.compiling && state.error && <span className="text-strike">stale</span>}
          {!state.compiling && !state.error && state.durationMs !== null && (
            <span className="text-ink-500">
              {state.cached ? 'cached' : `${state.durationMs}ms`}
            </span>
          )}
        </span>
      </header>

      <div className="relative flex-1 overflow-hidden p-6">
        {state.url ? (
          <iframe
            key="sheet"
            src={`${state.url}#toolbar=0&navpanes=0&view=FitH`}
            title="Résumé preview"
            className="h-full w-full bg-sheet shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)]"
            style={{ borderRadius: 'var(--radius-sheet)' }}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-xs text-ink-500">
              {state.compiling ? 'Setting type…' : 'No preview yet'}
            </p>
          </div>
        )}
      </div>

      {state.error && (
        <div className="rule-b max-h-44 overflow-auto border-t border-strike/30 bg-strike/[0.06] px-4 py-3">
          <p className="font-mono text-[11px] tracking-widest text-strike uppercase">
            Does not compile — showing the last good version
          </p>
          <ul className="mt-2 space-y-1">
            {state.error.diagnostics
              .filter((d) => d.severity === 'error')
              .slice(0, 4)
              .map((d, i) => (
                <li
                  // Two identical messages on different lines are distinct
                  // diagnostics; the index disambiguates them.
                  // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics may repeat
                  key={`${d.message}-${i}`}
                  className="font-mono text-xs leading-relaxed text-chalk-300"
                >
                  {d.line !== null && <span className="text-strike">L{d.line} </span>}
                  {d.message}
                </li>
              ))}
            {state.error.diagnostics.length === 0 && (
              <li className="font-mono text-xs text-chalk-300">{state.error.summary}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
