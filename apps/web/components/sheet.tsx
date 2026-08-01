'use client';

import type { SourceLocation } from '@sailor/latex/synctex';
import type { PreviewState } from '../lib/use-preview.ts';
import { PdfView } from './pdf-view.tsx';

/**
 * The PDF, presented as an actual sheet of paper on the desk. This is the only
 * bright surface in the app, and that is deliberate — everything else is chrome
 * around the document.
 *
 * It NEVER goes blank. A failing compile keeps the last good render on screen and
 * annotates it; that is why `error` and `url` coexist rather than being a union.
 */
export function Sheet({
  state,
  onPickSource,
  onAskAgent,
}: {
  state: PreviewState;
  onPickSource?: (location: SourceLocation) => void;
  onAskAgent?: (selection: { renderedText: string; location: SourceLocation | null }) => void;
}) {
  return (
    <div className="relative flex h-full flex-col bg-ink-850">
      <header className="rule-b flex items-center justify-between px-4 py-2.5">
        <span className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] tracking-widest text-ink-500 uppercase">
            Preview
          </span>
          {state.synctex && onPickSource && (
            <span className="font-mono text-[10.5px] text-ink-600">click to find the source</span>
          )}
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
        {state.pdf ? (
          <PdfView
            data={state.pdf}
            synctex={state.synctex}
            onPickSource={onPickSource}
            onAskAgent={onAskAgent}
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
