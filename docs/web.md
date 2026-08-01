# The browser app

`apps/web` is a Next.js App Router UI and nothing else. It reaches the rest of
the system over HTTP and one ACP WebSocket, and it must never import
`@sailor/db`, `@sailor/agent`, or a provider SDK — that boundary is what keeps
API keys and OAuth tokens out of the client bundle. The only server package it
imports is `@sailor/latex/synctex`, a subpath export containing pure geometry
with no `node:` imports; the Tectonic half of that package must never reach the
bundle.

## The map

```text
app/page.tsx            resume list, create
app/r/[id]/page.tsx     the workbench — owns all state, three panes
app/settings/page.tsx   providers: API keys, OAuth, code-paste

components/editor.tsx   CodeMirror + stex mode. Imperative `revealLine`.
components/sheet.tsx    preview chrome: status, diagnostics, the never-blank rule
components/pdf-view.tsx pdf.js canvas + text layer, and click → source geometry
components/chat.tsx     transcript, composer, permission and elicit prompts
components/diff-view.tsx  the diff inside a permission request

lib/api.ts              typed fetch wrappers over the HTTP API
lib/acp-client.ts       JSON-RPC peer over one WebSocket
lib/use-preview.ts      owns the worker, exposes PreviewState
lib/preview.worker.ts   debounce, cache, cancel, CompileEngine
```

Everything stateful lives in `Workbench`. The components below it take props and
return elements; two of them (`Editor`, and `Chat` once stage 4 lands) also
expose an imperative handle, for the same reason in both cases — see below.

## The document

`Workbench` holds `tree` (the working buffer), `versionId` (the tip it was loaded
from), and `dirty`. `reload()` pulls the tip from the server and is called on
mount and on every `version_committed` event, so an agent edit replaces the
user's buffer with what was actually saved rather than leaving a stale one on
screen. Saving posts the whole tree with the parent version id; the server
compiles it before it persists, and returns a new version id.

⌘S saves. History opens a dialog listing immutable versions; restoring commits a
new version copied from the selected one, so rollback is itself reversible.

## The preview pipeline

```text
tree ──▶ usePreview ──▶ Worker ──▶ POST /api/compile {synctex:true}
                          │           └─▶ { pdf: base64, synctex: SyncTexMap }
                          ▼
                    PreviewState { pdf, synctex, compiling, error, … }
                          │
                          ▼
                    Sheet ──▶ PdfView ──▶ canvas + text layer
```

Four properties are load bearing, and each one is the answer to a specific way
this felt broken:

- **The worker.** A compile can never stall typing or scrolling. That is why this
  is a worker and not a `useEffect` doing a fetch.
- **Never blank the sheet.** A failing or in-flight compile keeps the last good
  PDF on screen and annotates it. `PreviewState` therefore has `pdf` *and*
  `error` as separate fields rather than a union, and `PdfView` renders pages
  into a detached fragment attached in one `replaceChildren`.
- **The map travels with the bytes.** `pdf` and `synctex` are replaced together,
  so a click is never resolved against a compile the user is no longer looking
  at — which matters most precisely when the sheet is deliberately stale.
- **Superseded work is cancelled and ignored.** The worker aborts the in-flight
  fetch on a new keystroke; `usePreview` drops any message whose `seq` is not the
  current one. An abort is the expected outcome of fast typing, not an error.

The engine behind `CompileEngine` is the server today. See
[latex.md](latex.md) and [roadmap.md](roadmap.md) for the WASM seam.

## Click to source

`PdfView` converts a click from CSS pixels back to PDF points using the page's
own scale, read from `data-page` / `data-scale` on the element — on the DOM
rather than in a parallel array, which could go stale against it. `locateSource`
takes the tightest box containing the point (or the nearest box on that page,
because clicks land in margins constantly) and then narrows to the nearest glyph
inside it, because a paragraph's hbox is tagged with the line TeX *broke* it on.

The workbench drops a hit that does not belong to the entry file: SyncTeX names
files by their absolute path in a scratch directory that no longer exists, so
only the tail can be matched, and sending the cursor to the same line number in a
different document is worse than doing nothing.

`revealLine` is an imperative handle rather than a prop, because asking for the
same line twice must scroll twice — a prop would swallow the second ask. It also
clamps: the map belongs to the last successful compile, so the buffer may already
be shorter than the line it names.

## The agent connection

`AcpClient` is a JSON-RPC **peer**, not a stream reader. The agent calls
`session/request_permission` and `session/elicit` on the browser and blocks for
an answer, which is why this cannot be SSE. `Workbench` turns those into
`permission` / `elicit` state, which `Chat` renders as blocking UI; a disconnect
is a deny.

The session is created lazily on the first prompt, carrying `resumeId`, the
serialized model reference, and `jobTargetId`. **Changing the job target clears
`sessionRef` and the transcript**, so the next turn cannot quietly run against a
session built for a different posting.

Streamed events are folded into `ChatItem[]` by `reduceEvent`. `version_committed`
also triggers a reload; `turn_end` clears the busy flag.

## House rules for UI work

- Parse anything crossing the boundary with a `@sailor/core` schema, including
  responses from our own API — the worker does this even for `/api/compile`.
- Server Components by default; `'use client'` marks where hydration begins, not
  where a module stops running on the server. Browser-only libraries (pdf.js)
  must be imported inside an effect.
- Tailwind v4, and the ink/chalk/ochre palette in `app/globals.css`. The sheet is
  the only bright surface in the app; everything else is chrome around the
  document.
- `bun run check` and `bun run typecheck` are not evidence a feature works. Drive
  it.
