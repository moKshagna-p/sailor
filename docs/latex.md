# LaTeX compilation

Sailor treats compilation as a correctness boundary: a broken document is never
stored as the result of an agent edit. A resume is a `ResumeTree` with a named
entry file and relative source files; path validation and a second scratch-dir
check prevent writes outside the compiler workspace.

## Authoritative server compiler

`@sailor/latex` invokes Tectonic in a temporary directory with `--untrusted`,
which disables shell escape for user-supplied TeX. A semaphore limits concurrent
processes, each normal compile has a strict timeout, and a persistent Tectonic
cache avoids repeatedly downloading CTAN packages. The API prewarms that cache
at boot.

The server compiler is authoritative for:

- creating a resume,
- saving a manual version,
- each `edit_resume` tool call, and
- downloadable PDFs.

On failure, it returns parsed diagnostics and a bounded log tail. `edit_resume`
returns a model-legible failure and does not commit. On success, only then is a
new version row created.

## Live preview

The editor owns a dedicated Web Worker. It debounces edits by 400 ms, hashes a
canonicalized tree, caches recent successful PDFs, cancels superseded work, and
hands the main thread the bytes of the last good PDF during an in-flight or
failing build. This is why an invalid keystroke shows diagnostics without
flashing a blank sheet.

The PDF is drawn by pdf.js — a canvas per page with a selectable text layer over
it — not a native `<iframe>`. An iframe rendered fine but exposed no selection
and no page coordinates, which made mapping a click back to a source line
impossible. Two constraints came out of building it:

- pdf.js must be imported *inside* an effect. `'use client'` marks where
  hydration starts, not where a module runs; Next still evaluates the component
  on the server, where pdf.js's module-scope `DOMMatrix` does not exist.
- It must be the `legacy/` build. pdf.js 6 calls
  `Map.prototype.getOrInsertComputed`, which current Chrome does not implement,
  so the default build throws on the first `page.render()`.

Keeping the sheet from flashing is deliberate here rather than incidental: pages
are rendered into a detached fragment and attached in a single
`replaceChildren`, so the previous render stays on screen for the whole of the
next compile.

## The source map crossing to the browser

A preview compile asks Tectonic for SyncTeX and returns the parsed map with the
PDF: `POST /api/compile` with `synctex: true` answers JSON carrying base64 bytes
and a `SyncTexMap`, instead of streaming the PDF raw. Two decisions are load
bearing here.

The map travels **with** the document rather than being fetched when someone
clicks. A map from a different compile than the pixels on screen would silently
point at the wrong lines, and the preview deliberately keeps a stale PDF visible
during a failing build — so "fetch the map on demand" would be wrong precisely
when the user is most likely to click. The worker caches and replaces the two
together, and `PreviewState` exposes them as one pair.

The cost of shipping both in one JSON body is base64: measured at 21KB of PDF and
5KB of map for the starter resume. That is cheaper than inventing a length-prefixed
wire format for two payloads, and the raw-PDF path is untouched for saves,
exports, and downloads.

`SyncTexMap` therefore lives in `@sailor/core`, like everything else that crosses
a process boundary, and its `files` is an array of tag/path pairs rather than a
`Map` keyed by tag — a document has one or two input files, so a linear lookup
costs nothing, and a `Map` would need a serialise/deserialise pair that can drift
from the schema.

The hit-testing runs where the clicks are. `@sailor/latex/synctex` is a subpath
export containing only the parser and the geometry, with no `node:` imports, so
`apps/web` can import it; the Tectonic half of the package must never reach the
browser bundle. A click on a page converts CSS pixels back to PDF points using
the page's own scale — recorded in `data-page` and `data-scale` on the element,
not a parallel array that could go stale — and `locateSource` returns the tightest
enclosing box, or the nearest one, since clicks land in margins constantly.

SyncTeX names files by their absolute path inside the compiler's scratch
directory, which no longer exists by the time anyone clicks. The workbench matches
on the tail of that path and jumps only when the hit belongs to the entry file:
sending the cursor to the same line number in a different document is worse than
doing nothing.

The worker exposes a `CompileEngine` seam for the planned browser WASM compiler.
At present its sole engine calls the server's Tectonic endpoint, so the preview
already has server-authoritative behavior while avoiding a half-supported WASM
package resolver. When a browser engine is added, it must stay in the worker,
retain the debounce/cache/last-good-PDF contract, and defer to the server on any
disagreement. The server PDF remains the one a user downloads. An engine that
cannot emit SyncTeX reports `synctex: null` and the sheet is simply not clickable
— which is what it was before any of this existed.
