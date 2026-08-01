'use client';

// Geometry for `.textLayer` — the transforms that sit invisible text exactly on
// top of the painted glyphs. Version-locked to the package on purpose: these
// rules depend on internals (`--total-scale-factor`, per-span scaling) that move
// between releases, so hand-copying them would drift on the next upgrade. The
// stylesheet's own `:root` blocks only declare pdf.js-namespaced custom
// properties, so importing it does not restyle anything of ours.
import 'pdfjs-dist/web/pdf_viewer.css';
import type { SyncTexMap } from '@sailor/core';
// The browser-safe half of the LaTeX package: pure geometry, no `node:` imports.
// The map is made where the compiler is; the hit-testing happens where the
// clicks are.
import { locateSource, type SourceLocation } from '@sailor/latex/synctex';
import { useCallback, useEffect, useRef, useState } from 'react';

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

type SelectionPopover = {
  renderedText: string;
  location: SourceLocation | null;
  /**
   * Collapsed at the selection's *start*, and kept rather than reduced to
   * coordinates: the pane scrolls under the toolbar, so its position has to be
   * re-derived from the document, not remembered from when the drag ended.
   */
  anchor: Range;
};

/** Gap between the selected text and the toolbar floating above it. */
const POPOVER_GAP = 8;

/**
 * Convert a browser coordinate on a rendered page back to the PDF point that
 * SyncTeX understands. Selections and clicks deliberately share this path: a
 * separate conversion for one of them would eventually drift from the other.
 */
function locateSourceAtClientPoint(
  synctex: SyncTexMap,
  page: HTMLElement,
  point: { x: number; y: number },
): SourceLocation | null {
  const number = Number(page.dataset.page);
  const scale = Number(page.dataset.scale);
  if (!Number.isInteger(number) || !(scale > 0)) return null;

  const box = page.getBoundingClientRect();
  return locateSource(synctex, {
    page: number,
    x: (point.x - box.left) / scale,
    y: (point.y - box.top) / scale,
  });
}

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
export function PdfView({
  data,
  synctex,
  onPickSource,
  onAskAgent,
}: {
  data: ArrayBuffer;
  /** The map for exactly these bytes. Without it the sheet is simply not clickable. */
  synctex: SyncTexMap | null;
  onPickSource?: (location: SourceLocation) => void;
  /** Rendered PDF text only — it is never source text for an exact edit match. */
  onAskAgent?: (selection: { renderedText: string; location: SourceLocation | null }) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [popover, setPopover] = useState<SelectionPopover | null>(null);
  /** Null while the toolbar has not been measured, or when its anchor is out of view. */
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

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

    // The new render invalidates DOM Ranges into the old text layer.
    setPopover(null);

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
        // What a click needs to become a source line. On the element rather than
        // in a parallel array, so it cannot go stale relative to the DOM.
        sheet.dataset.page = String(number);
        sheet.dataset.scale = String(scale);
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

  // The text layer is assembled by pdf.js outside React, so selection changes
  // are observed at the document boundary. A range's own geometry is the only
  // reliable source here — the mouse-up event may be nowhere near its anchor.
  useEffect(() => {
    const updatePopover = () => {
      const selection = window.getSelection();
      const host = hostRef.current;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !host) {
        setPopover(null);
        return;
      }

      // The *range*, not the selection's anchor. `anchorNode` is where the drag
      // began, so a selection made right-to-left or bottom-to-top anchors on its
      // last character — and "jump to source" would land on the wrong end of what
      // the user highlighted. A range is always in document order.
      const range = selection.getRangeAt(0);
      const start =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement;
      const page = start?.closest('[data-page]');
      if (!(page instanceof HTMLElement) || !host.contains(page)) {
        setPopover(null);
        return;
      }

      const renderedText = selection.toString().trim();
      if (!renderedText) {
        setPopover(null);
        return;
      }

      // Collapse to the first character rather than using the whole range's
      // bounding box: a selection may span pages, and only its start is
      // guaranteed to sit on the page we just resolved.
      const anchor = range.cloneRange();
      anchor.collapse(true);
      const anchorBox = anchor.getBoundingClientRect();
      const location = synctex
        ? locateSourceAtClientPoint(synctex, page, {
            x: anchorBox.left,
            // The vertical middle of the caret, not its top edge, which sits on
            // the boundary of the glyph box we are trying to hit.
            y: anchorBox.top + anchorBox.height / 2,
          })
        : null;

      setPopover({ renderedText, location, anchor });
    };

    document.addEventListener('selectionchange', updatePopover);
    return () => document.removeEventListener('selectionchange', updatePopover);
  }, [synctex]);

  /**
   * A click on the page becomes a source line.
   *
   * React's listener sits on the host, so it still sees clicks from the pages
   * below even though those are built imperatively. A drag that selected text is
   * not a click and must not scroll the editor out from under the user — that is
   * what the collapsed-selection check is for.
   */
  const pick = useCallback(
    (event: MouseEvent) => {
      if (!synctex || !onPickSource) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      const page = event.target instanceof Element ? event.target.closest('[data-page]') : null;
      if (!(page instanceof HTMLElement)) return;

      const located = locateSourceAtClientPoint(synctex, page, {
        x: event.clientX,
        y: event.clientY,
      });
      if (located) onPickSource(located);
    },
    [onPickSource, synctex],
  );

  // The pages are a document, not a keyboard control. Keep this native listener
  // rather than giving that document a fake interactive role just to satisfy a
  // JSX event rule.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.addEventListener('click', pick);
    return () => host.removeEventListener('click', pick);
  }, [pick]);

  const dismissSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setPopover(null);
  }, []);

  /**
   * Places the toolbar above its anchor, every time anything could have moved it.
   *
   * The pane scrolls, so a position computed once at mouse-up drifts off the text
   * it belongs to and ends up floating over unrelated chrome. Measuring the
   * toolbar rather than assuming its width keeps the clamp honest when the labels
   * change, and an anchor scrolled out of the pane hides it outright — a toolbar
   * pointing at text nobody can see is worse than no toolbar.
   */
  useEffect(() => {
    if (!popover) {
      setPlacement(null);
      return;
    }

    const place = () => {
      const host = hostRef.current;
      const toolbar = toolbarRef.current;
      if (!host || !toolbar) return;

      const anchorBox = popover.anchor.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      if (anchorBox.bottom < hostBox.top || anchorBox.top > hostBox.bottom) {
        setPlacement(null);
        return;
      }

      const left = Math.min(
        Math.max(anchorBox.left, hostBox.left + POPOVER_GAP),
        Math.max(hostBox.right - toolbar.offsetWidth - POPOVER_GAP, hostBox.left + POPOVER_GAP),
      );
      const top = Math.max(
        anchorBox.top - toolbar.offsetHeight - POPOVER_GAP,
        hostBox.top + POPOVER_GAP,
      );
      setPlacement({ left, top });
    };

    place();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissSelection();
    };

    // Capture, because the pane that scrolls is below this listener and scroll
    // does not bubble.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', onKey);
    };
  }, [popover, dismissSelection]);

  return (
    <>
      <div ref={hostRef} className="h-full space-y-6 overflow-y-auto" />

      {popover && (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label="Selection actions"
          className="fixed z-20 flex border border-ink-600 bg-ink-900 p-1 shadow-xl shadow-black/40"
          // Rendered before it is placed so it can be measured, and hidden until
          // it has been — otherwise it flashes at the top-left corner first.
          style={{
            left: placement?.left ?? 0,
            top: placement?.top ?? 0,
            visibility: placement ? 'visible' : 'hidden',
          }}
          // Keep the browser selection alive long enough for the click handler
          // to use its snapshot. Keyboard activation still works normally.
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            disabled={!popover.location || !onPickSource}
            onClick={() => {
              if (popover.location) onPickSource?.(popover.location);
              dismissSelection();
            }}
            className="px-2.5 py-1.5 font-mono text-[10.5px] text-chalk-300 hover:bg-ink-800 hover:text-chalk-100 disabled:cursor-not-allowed disabled:opacity-35"
          >
            Jump to source
          </button>
          <button
            type="button"
            disabled={!onAskAgent}
            onClick={() => {
              onAskAgent?.({
                renderedText: popover.renderedText,
                location: popover.location,
              });
              dismissSelection();
            }}
            className="px-2.5 py-1.5 font-mono text-[10.5px] text-ochre hover:bg-ochre/[0.1] disabled:cursor-not-allowed disabled:opacity-35"
          >
            Ask agent
          </button>
        </div>
      )}
    </>
  );
}
