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

The worker exposes a `CompileEngine` seam for the planned browser WASM compiler.
At present its sole engine calls the server's Tectonic endpoint, so the preview
already has server-authoritative behavior while avoiding a half-supported WASM
package resolver. When a browser engine is added, it must stay in the worker,
retain the debounce/cache/last-good-PDF contract, and defer to the server on any
disagreement. The server PDF remains the one a user downloads.
