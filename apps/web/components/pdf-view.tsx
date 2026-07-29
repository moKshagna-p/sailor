'use client';

// Geometry for `.textLayer` — the transforms that sit invisible text exactly on
// top of the painted glyphs. Version-locked to the package on purpose: these
// rules depend on internals (`--total-scale-factor`, per-span scaling) that move
// between releases, so hand-copying them would drift on the next upgrade. The
// stylesheet's own `:root` blocks only declare pdf.js-namespaced custom
// properties, so importing it does not restyle anything of ours.
import 'pdfjs-dist/web/pdf_viewer.css';
import { useEffect, useRef, useState } from 'react';

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjs: Promise<Pdfjs> | null = null;

/**
 * Loads pdf.js in the browser, once.
 *
 * It cannot be a static import. `'use client'` marks where hydration begins, not
 * where the module runs — Next still evaluates this file on the server to render
 * the initial HTML, and pdf.js touches `DOMMatrix` at module scope, which does
 * not exist there. Importing it from inside an effect keeps it off the server
 * entirely, and the memoised promise means a re-render does not re-parse it.
 *
 * The *legacy* build, not the default one: pdf.js 6 calls
 * `Map.prototype.getOrInsertComputed`, which current Chrome does not implement —
 * the default build throws on the first `page.render()`. The legacy bundle ships
 * the polyfill. It is the build for "browsers people actually have", not for
 * ancient ones.
 */
function loadPdfjs(): Promise<Pdfjs> {
  pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
    // Resolved by the bundler so the worker ships with the app. The default is a
    // CDN fetch, which would make the preview depend on the network to render a
    // document we already have in memory.
    module.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/legacy/build/pdf.worker.mjs',
      import.meta.url,
    ).toString();
    return module;
  });
  return pdfjs;
}

/** Past 2x, a denser backing store costs memory and buys nothing visible. */
const MAX_DEVICE_SCALE = 2;

/**
 * The PDF, rendered to canvas with a selectable text layer over it.
 *
 * This replaces a native `<iframe>`, which rendered fine but was a black box:
 * no selection, no coordinates, no way to ask "what source line is under this
 * click?". Everything downstream — jump-to-source, asking the agent about a
 * specific bullet — needs the document to be ours to inspect.
 *
 * **It never blanks.** Pages are rendered into a detached fragment and swapped
 * in only once every one of them has painted, so the previous render stays on
 * screen for the whole of the next compile. That is the same contract the
 * iframe had by accident; here it has to be deliberate.
 */
export function PdfView({ data }: { data: ArrayBuffer }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  // Re-render on resize rather than letting the browser stretch a fixed bitmap,
  // which would go soft as soon as the pane moved.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Whole pixels only — sub-pixel jitter would re-render on every frame of
      // a drag.
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || width === 0) return;

    let cancelled = false;
    const running: Array<{ cancel: () => void }> = [];
    let loading: { destroy: () => Promise<void> } | null = null;

    const render = async () => {
      const { getDocument, setLayerDimensions, TextLayer } = await loadPdfjs();
      if (cancelled) return;

      // pdf.js takes ownership of the buffer it is handed, and this one has to
      // survive for the next resize, so it gets a copy.
      const documentTask = getDocument({ data: new Uint8Array(data) });
      loading = documentTask;
      const doc = await documentTask.promise;
      if (cancelled) return;

      const staged = document.createDocumentFragment();

      for (let number = 1; number <= doc.numPages; number++) {
        const page = await doc.getPage(number);
        if (cancelled) return;

        const unscaled = page.getViewport({ scale: 1 });
        const scale = width / unscaled.width;
        // Two viewports, so the canvas can be denser than the layout without a
        // transform: CSS pixels position the text layer, device pixels paint.
        const cssViewport = page.getViewport({ scale });
        const deviceScale = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_SCALE);
        const deviceViewport = page.getViewport({ scale: scale * deviceScale });

        const sheet = document.createElement('div');
        sheet.className = 'relative mx-auto bg-sheet shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)]';
        sheet.style.width = `${cssViewport.width}px`;
        sheet.style.height = `${cssViewport.height}px`;
        sheet.style.borderRadius = 'var(--radius-sheet)';
        // setLayerDimensions sizes the text layer in terms of these, so they
        // have to exist on an ancestor of it.
        sheet.style.setProperty('--total-scale-factor', String(scale));
        sheet.style.setProperty('--scale-round-x', '1px');
        sheet.style.setProperty('--scale-round-y', '1px');

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(deviceViewport.width);
        canvas.height = Math.floor(deviceViewport.height);
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        canvas.style.borderRadius = 'var(--radius-sheet)';
        sheet.append(canvas);

        const task = page.render({ canvas, viewport: deviceViewport });
        running.push(task);
        await task.promise;
        if (cancelled) return;

        const text = document.createElement('div');
        text.className = 'textLayer';
        setLayerDimensions(text, cssViewport);

        const textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: text,
          viewport: cssViewport,
        });
        running.push(textLayer);
        await textLayer.render();
        if (cancelled) return;

        sheet.append(text);
        staged.append(sheet);
      }

      if (cancelled) return;
      // The one moment anything reaches the screen.
      host.replaceChildren(staged);
    };

    render().catch((cause: unknown) => {
      // Superseded work aborts by design — a fast typist cancels several of
      // these per edit, and none of them is a fault worth reporting.
      if (cancelled) return;
      // Anything else keeps the last good render up, matching what a failed
      // compile does, but must not disappear silently.
      console.error('[preview] could not render the PDF:', cause);
    });

    return () => {
      cancelled = true;
      for (const task of running) task.cancel();
      void loading?.destroy();
    };
  }, [data, width]);

  return <div ref={hostRef} className="h-full space-y-6 overflow-y-auto" />;
}
