/// <reference lib="webworker" />
import type { LatexDiagnostic, ResumeTree } from '@sailor/core';

/**
 * The preview engine, in a Web Worker.
 *
 * It lives off the main thread so a compile can never stall typing or scrolling —
 * that is the whole reason this file exists rather than a `useEffect` doing a
 * fetch.
 *
 * ## The engine is pluggable, and today it is the server
 *
 * The plan was an in-browser WASM engine (SwiftLaTeX) for previews. That is real,
 * but it is not a package you install: it ships as prebuilt .wasm blobs and it
 * needs its own TeX *package server* to resolve \usepackage at runtime. Shipping
 * it is a project, not an import, and a half-working WASM engine that silently
 * fails on the user's Awesome-CV class file is worse than no WASM engine.
 *
 * So `CompileEngine` is an interface with one implementation today — the server's
 * Tectonic (authoritative, ~3s, correct for every template). Dropping SwiftLaTeX
 * in later means writing a second implementation of this one interface and
 * choosing between them. Nothing else in the app changes.
 *
 * Everything that makes the preview *feel* fast is engine-independent and is
 * already here: debounce, content-addressed caching (undo/redo and revisits are
 * instant), cancellation of superseded compiles, and never blanking the sheet.
 */

const API = (self as unknown as { __API__?: string }).__API__ ?? 'http://localhost:3001';

const DEBOUNCE_MS = 400;
/** Bounded so a long session cannot grow the worker heap without limit. */
const CACHE_LIMIT = 24;

export type CompileRequest = { type: 'compile'; seq: number; tree: ResumeTree };
export type CompileResponse =
  | {
      type: 'ok';
      seq: number;
      pdf: ArrayBuffer;
      durationMs: number;
      cached: boolean;
    }
  | {
      type: 'error';
      seq: number;
      summary: string;
      diagnostics: LatexDiagnostic[];
    }
  | { type: 'status'; seq: number; state: 'compiling' };

type CompileEngine = {
  compile(
    tree: ResumeTree,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; pdf: ArrayBuffer; durationMs: number }
    | { ok: false; summary: string; diagnostics: LatexDiagnostic[] }
  >;
};

const serverEngine: CompileEngine = {
  async compile(tree, signal) {
    const started = performance.now();
    const res = await fetch(`${API}/api/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree }),
      signal,
    });

    if (res.ok) {
      return {
        ok: true,
        pdf: await res.arrayBuffer(),
        durationMs: Math.round(performance.now() - started),
      };
    }

    const body = (await res.json().catch(() => ({}))) as {
      summary?: string;
      diagnostics?: LatexDiagnostic[];
    };
    return {
      ok: false,
      summary: body.summary ?? `Compile failed (${res.status})`,
      diagnostics: body.diagnostics ?? [],
    };
  },
};

const engine: CompileEngine = serverEngine;

const cache = new Map<string, ArrayBuffer>();

async function hash(tree: ResumeTree): Promise<string> {
  const files = [...tree.files].sort((a, b) => a.path.localeCompare(b.path));
  const canonical = JSON.stringify({ entry: tree.entry, files });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: AbortController | undefined;

const post = (message: CompileResponse, transfer?: Transferable[]) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer ?? []);

self.onmessage = (event: MessageEvent<CompileRequest>) => {
  const { seq, tree } = event.data;
  if (event.data.type !== 'compile') return;

  // A newer keystroke supersedes the pending one, and any compile already in
  // flight is now producing a PDF nobody wants. Kill both.
  clearTimeout(timer);
  inFlight?.abort();

  timer = setTimeout(async () => {
    const key = await hash(tree);

    // The user hit undo, or edited and reverted. We already have that PDF —
    // serving it instantly is the single biggest perceived-speed win here.
    const hit = cache.get(key);
    if (hit) {
      post({ type: 'ok', seq, pdf: hit.slice(0), durationMs: 0, cached: true });
      return;
    }

    post({ type: 'status', seq, state: 'compiling' });

    const controller = new AbortController();
    inFlight = controller;

    try {
      const result = await engine.compile(tree, controller.signal);
      if (controller.signal.aborted) return;

      if (!result.ok) {
        post({
          type: 'error',
          seq,
          summary: result.summary,
          diagnostics: result.diagnostics,
        });
        return;
      }

      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, result.pdf.slice(0));

      post(
        {
          type: 'ok',
          seq,
          pdf: result.pdf,
          durationMs: result.durationMs,
          cached: false,
        },
        [result.pdf],
      );
    } catch (cause) {
      // An abort is the expected outcome of fast typing, not an error worth
      // showing anyone.
      if (controller.signal.aborted) return;
      post({
        type: 'error',
        seq,
        summary: cause instanceof Error ? cause.message : 'Compile failed',
        diagnostics: [],
      });
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  }, DEBOUNCE_MS);
};
