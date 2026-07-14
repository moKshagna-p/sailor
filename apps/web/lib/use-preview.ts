'use client';

import type { LatexDiagnostic, ResumeTree } from '@sailor/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompileResponse } from './preview.worker.ts';

export type PreviewState = {
  /** Blob URL of the last PDF that compiled. Survives a failing edit on purpose. */
  url: string | null;
  compiling: boolean;
  /** Set when the *current* source does not compile. `url` still shows the last good one. */
  error: { summary: string; diagnostics: LatexDiagnostic[] } | null;
  durationMs: number | null;
  cached: boolean;
};

/**
 * Drives the preview worker and owns the rule that matters most: **never blank
 * the sheet.** A failed or in-flight compile keeps the previous PDF on screen.
 * Flashing an empty pane between renders is what makes a live preview feel
 * broken, far more than the compile taking a couple of seconds.
 */
export function usePreview(tree: ResumeTree | null): PreviewState {
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0);
  // Tracked separately from state so revoke() can run without re-rendering.
  const urlRef = useRef<string | null>(null);

  const [state, setState] = useState<PreviewState>({
    url: null,
    compiling: false,
    error: null,
    durationMs: null,
    cached: false,
  });

  const swap = useCallback((pdf: ArrayBuffer) => {
    const next = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    // Revoke the *old* url only after the new one exists, so there is never an
    // instant where the iframe has nothing to show.
    const previous = urlRef.current;
    urlRef.current = next;
    if (previous) URL.revokeObjectURL(previous);
    return next;
  }, []);

  useEffect(() => {
    // Pre-warm: instantiate the worker the moment the editor mounts, not on the
    // first keystroke, so the user's first edit does not pay for setup.
    const worker = new Worker(new URL('./preview.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<CompileResponse>) => {
      const message = event.data;
      // Ignore anything from a superseded compile.
      if (message.seq !== seqRef.current) return;

      if (message.type === 'status') {
        setState((s) => ({ ...s, compiling: true }));
        return;
      }

      if (message.type === 'error') {
        setState((s) => ({
          ...s,
          compiling: false,
          error: { summary: message.summary, diagnostics: message.diagnostics },
        }));
        return;
      }

      setState({
        url: swap(message.pdf),
        compiling: false,
        error: null,
        durationMs: message.durationMs,
        cached: message.cached,
      });
    };

    return () => {
      worker.terminate();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [swap]);

  useEffect(() => {
    if (!tree || !workerRef.current) return;
    const seq = ++seqRef.current;
    workerRef.current.postMessage({ type: 'compile', seq, tree });
  }, [tree]);

  return state;
}
