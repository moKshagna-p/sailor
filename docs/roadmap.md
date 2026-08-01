# Roadmap and current state

This file exists so someone — human or agent — arriving cold can tell what is
built, what is next, and why the next thing is shaped the way it is. The other
docs describe the system as it *is*; this one is the only place that describes
what it is *not yet*.

Keep it honest. A feature is listed as shipped only when it has been driven in
the real app, per the definition of done in [AGENTS.md](../AGENTS.md). "Typechecks"
is not "shipped".

Last verified against `main` at `7abef91` (2026-08-01).

---

## Shipped

**Model access.** Four provider drivers (Anthropic, OpenAI, Google, OpenRouter)
behind one gateway. API keys are verified with the provider before they are
stored. OAuth works generically per driver, including two awkward shapes worth
knowing about: Anthropic's code-paste flow, and OpenRouter's exchange that
returns a durable API key rather than a token. OpenRouter needs no operator
setup at all, which is the only path from "brand new user, no key" to a working
agent. See [providers.md](providers.md).

**The agent turn.** A bounded AI SDK tool loop with a 40-step ceiling, streamed
to the browser over ACP. `edit_resume` is gated behind a blocking permission
request carrying a diff, compiles with Tectonic before it commits, and produces
an immutable version row. Job targets are records, not chat messages, so the
posting survives a refresh. See [agent.md](agent.md).

**Compilation.** A semaphore-limited Tectonic pool run `--untrusted`, with a
warm CTAN cache prewarmed at boot against the real template. Parsed diagnostics
on failure. See [latex.md](latex.md).

**PDF → source, stages 1–3 of 4.** This was the last body of work, built in
stages because each one needed the real UI driven to verify:

1. SyncTeX emitted and parsed in `packages/latex` (`4f9b23a`).
2. pdf.js replaced the `<iframe>` preview — canvas per page plus a selectable
   text layer (`19fec75`). An iframe rendered fine but exposed no selection and
   no page coordinates, which made everything downstream impossible.
3. The map travels with the PDF (`0d5c86c`, `f9d0ea0`), and a click on the sheet
   moves the CodeMirror cursor to the line that produced it (`7433e27`),
   narrowing a box hit to the nearest glyph so bullets do not land one line low
   (`7abef91`).

---

## Next: stage 4 — the selection popover

**The gap.** You can click the sheet and land on the source. You cannot yet
*select* a phrase on the sheet and do something with it. Selection already works
(that is what the text layer is for) and it is currently used only as a negative
signal — `PdfView.pick()` ignores a click when the selection is not collapsed,
so a drag does not yank the editor out from under you.

**The shape.** On a non-collapsed selection inside the sheet, float a small
popover near the selection with two actions:

- **Jump to source** — the same `onPickSource` path a click takes, resolved from
  the selection's anchor rather than a click point.
- **Ask agent** — send the selected text, with its source line, into the chat as
  the next prompt: *"About line 34 — «…selected text…» — "* and let the user
  finish the sentence. It must land in the composer, not send itself. A one-click
  path from a stray double-click to a billed agent turn is a bad trade.

**Where it goes.** `apps/web/components/pdf-view.tsx` owns the geometry, so the
popover is positioned there; the actions are props, like `onPickSource` already
is. The workbench (`apps/web/app/r/[id]/page.tsx`) wires **Ask agent** to the
chat composer, which means `Chat` needs a way to be handed draft text — today
`onSend` is the only channel and the composer owns its own state. Prefer an
imperative handle on `Chat`, matching `EditorHandle`: "put this in the box and
focus it" is a command, not state, and asking about the same line twice must
work twice.

**Traps, in the order you will hit them.**

- A selection's coordinates come from `Range.getBoundingClientRect()`, not from
  the mouse event. It can span pages; take the start.
- Resolving the selection anchor to a source line still goes through
  `locateSource`, which wants PDF points on one page. Convert with the page's own
  `data-scale`, exactly as `pick()` does — do not introduce a second conversion
  path that can drift from that one.
- The map belongs to the last *successful* compile. During a failing build the
  sheet deliberately shows stale pixels, so a stage-4 action can name a line that
  no longer exists. `revealLine` already clamps; the quoted text in an agent
  prompt should say which version it came from, or say nothing about lines at all.
- pdf.js's text layer breaks a visual line into many spans. `selection.toString()`
  is fine for a bullet; it is not fine as a claim about the LaTeX source. Quote it
  to the agent as *rendered output*, never as source to match against — the exact,
  unique old-text match that `edit_resume` needs is the model's job to find with
  `read_resume`.

**Verifying it.** `bun run dev`, open a resume, select a bullet on the sheet.
Both actions must work with the agent disconnected (jump) and connected (ask),
and a plain click must still behave as it does today.

---

## After that, in rough priority order

### Real auth

`apps/api/src/auth.ts` mints one dev user and caches it. That file is deliberately
a one-function stub: every route and query downstream already takes a `userId` and
scopes by it, so swapping in Better Auth is a change to `currentUserId()` plus a
mounted handler, not an audit of the codebase. The file's own comment carries the
four steps. Until this lands, Sailor is single-user, and the OAuth state store
being in API memory is fine; after it lands, a multi-instance deployment needs a
shared TTL store instead (noted in [providers.md](providers.md)).

### A free-text model slug for OpenRouter

The model picker is a `<select>` over each driver's curated list
(`apps/web/app/r/[id]/page.tsx`). OpenRouter proxies hundreds of models and the
curated four are a starting point, not a ceiling. What makes this more than a
text input: a typo'd slug must fail legibly at pick time rather than mid-turn,
and the constraint that matters is **tool support** — a model that cannot call
tools is useless to this agent no matter how cheap it is, and most free ones
cannot.

### The browser WASM compile engine

`apps/web/lib/preview.worker.ts` already has the seam: `CompileEngine` is an
interface with one implementation, the server's Tectonic. Everything that makes
the preview feel fast — 400 ms debounce, content-addressed cache, cancellation of
superseded work, never blanking the sheet — is engine-independent and already
there, so a second engine is one implementation plus a choice between them.

The reason it is not built: SwiftLaTeX is not a package you install. It ships
prebuilt `.wasm` blobs and needs its own TeX package server to resolve
`\usepackage` at runtime. A WASM engine that silently fails on a user's
`Awesome-CV` class file is worse than no WASM engine. Whatever lands must stay in
the worker, keep the debounce/cache/last-good-PDF contract, defer to the server on
any disagreement, and report `synctex: null` if it cannot emit a map — in which
case the sheet is simply not clickable, which is where this all started.

---

## Standing constraints on anything new

These are not roadmap items; they are the walls. Full text in
[AGENTS.md](../AGENTS.md).

- The agent may reword, reorder, cut, and re-emphasise. It may not manufacture a
  metric, technology, date, title, or employer. Missing facts are questions.
- Every edit is a new immutable version. An `UPDATE` against resume content is a
  modelling error.
- A stored document compiles, because it was compiled before it was stored.
- `apps/web` never imports `@sailor/db`, `@sailor/agent`, or a provider SDK.
- No `any`, no `!`, no silent `catch {}`. Everything crossing a process boundary
  is parsed with a Zod schema from `@sailor/core`.
