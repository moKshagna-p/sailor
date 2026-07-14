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
keeps the last good Blob URL visible during an in-flight or failing build. This
is why an invalid keystroke shows diagnostics without flashing a blank sheet.

The worker exposes a `CompileEngine` seam for the planned browser WASM compiler.
At present its sole engine calls the server's Tectonic endpoint, so the preview
already has server-authoritative behavior while avoiding a half-supported WASM
package resolver. When a browser engine is added, it must stay in the worker,
retain the debounce/cache/last-good-PDF contract, and defer to the server on any
disagreement. The server PDF remains the one a user downloads.
