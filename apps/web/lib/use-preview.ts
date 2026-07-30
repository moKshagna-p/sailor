'use client';

import type { LatexDiagnostic, ResumeTree, SyncTexMap } from '@sailor/core';
import { useEffect, useRef, useState } from 'react';
import type { CompileResponse } from './preview.worker.ts';

export type PreviewState = {
  /**
   * Bytes of the last PDF that compiled. Survives a failing edit on purpose.
   *
   * Bytes rather than a Blob URL because the viewer renders to a canvas and
   * needs the document itself — a URL would only get us back to an iframe, which
   * exposes no text selection or page coordinates.
   */
  pdf: ArrayBuffer | null;
  /**
   * Source map for exactly the PDF in `pdf` — they are replaced together, so a
   * click is never resolved against a document the user is no longer looking at.
   * Null before the first compile, or if the engine cannot emit one.
   */
  synctex: SyncTexMap | null;
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

  const [state, setState] = useState<PreviewState>({
    pdf: null,
    synctex: null,
    compiling: false,
    error: null,
    durationMs: null,
    cached: false,
  });

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

      // A new buffer identity is what tells the viewer to re-render, so the
      // previous one is replaced rather than mutated.
      setState({
        pdf: message.pdf,
        synctex: message.synctex,
        compiling: false,
        error: null,
        durationMs: message.durationMs,
        cached: message.cached,
      });
    };

    return () => worker.terminate();
  }, []);

  useEffect(() => {
    if (!tree || !workerRef.current) return;
    const seq = ++seqRef.current;
    workerRef.current.postMessage({ type: 'compile', seq, tree });
  }, [tree]);

  return state;
}
