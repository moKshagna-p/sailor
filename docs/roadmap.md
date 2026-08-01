# Roadmap and current state

This file exists so someone — human or agent — arriving cold can tell what is
built, what is next, and why the next thing is shaped the way it is. The other
docs describe the system as it *is*; this one is the only place that describes
what it is *not yet*.

Keep it honest. A feature is listed as shipped only when it has been driven in
the real app, per the definition of done in [AGENTS.md](../AGENTS.md). "Typechecks"
is not "shipped".

Last verified against `main` at `cbec358` (2026-08-01), with stage 4 below in
flight in the working tree.

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

## In progress: stage 4 — the selection popover

**Being built right now, by another agent, in the working tree.** Do not start a
second implementation. As of 2026-08-01 the uncommitted work already has the
popover in `pdf-view.tsx`, a `ChatHandle` imperative handle mirroring
`EditorHandle`, and a single shared client-point → source-line conversion used by
both clicks and selections.

**The shape.** On a non-collapsed selection inside the sheet, float a small
popover at the selection's own rect — LeetCode's "Ask Leet" is the reference —
with two actions:

- **Jump to source** — the same `onPickSource` path a click takes, resolved from
  the selection's anchor rather than a click point.
- **Ask agent** — put the selection in the chat composer and focus it, so the
  user types their question and sends. It must never send itself: a one-click
  path from a stray double-click to a billed agent turn is a bad trade.

**Traps, in the order you will hit them.**

- A selection's coordinates come from `Range.getBoundingClientRect()`, not from
  the mouse event, which may be nowhere near the anchor. It can span pages; take
  the start.
- Resolving the anchor still goes through `locateSource`, which wants PDF points
  on one page. Convert with the page's own `data-scale`, through the *same*
  function the click path uses — a second conversion will drift from the first.
- pdf.js assembles the text layer outside React, so selection changes are
  observed at the document boundary, and a re-render (resize, new compile)
  invalidates every Range into the old layer. Clear the popover when that happens.
- The map belongs to the last *successful* compile. During a failing build the
  sheet deliberately shows stale pixels, so an action can name a line that no
  longer exists. `revealLine` already clamps.
- `selection.toString()` is **rendered output, not source**. Quote it to the
  agent as such and never as text to match against — the exact, unique old-text
  match `edit_resume` needs is the model's job to find with `read_resume`. A
  bullet that wrapped across two visual lines does not stringify back to the
  LaTeX that made it.

---

## Next: the prompt carries attachments, not a string

This is the piece to pick up, and it is what makes the composer look like the
reference: the quoted excerpt appears as a **chip** above the input —
`▤ Player 1 and player 2 take turns, with p…` — removable with an ×, with the
user's typed question next to it, rather than the quote being pasted into the
text field as prose.

**Why it is not just styling.** Stage 4 hands the excerpt over as draft text,
which is the right first cut and a dead end for three reasons: the user can edit
half the quote away and the agent receives a mangled excerpt with nothing marking
what was quoted; there is no structure to render a chip from; and an image can
never be a string. All three are the same missing thing.

**The change.** `session/prompt` currently carries `{ sessionId, text }`
(`packages/acp/src/protocol.ts`). Make it `{ sessionId, content: ContentBlock[] }`,
where `ContentBlock` is a domain-neutral union in `@sailor/acp`, shaped like
ACP's own:

```ts
| { type: 'text';     text: string }
| { type: 'resource'; uri: string; text: string }   // an excerpt, with provenance in the uri
| { type: 'image';    mimeType: string; data: string }
```

A resume excerpt is a `resource` block whose `uri` names the version and line —
so `packages/acp` still does not know what a resume is, which is the rule that
package exists to keep. `runTurn` takes `userMessage: string` today
(`packages/agent/src/loop.ts`) and builds one `{ role: 'user', content }`
message; blocks map onto AI SDK message parts there, which is the natural shape
for the same reason. Change both sides at once — there is no external client to
keep compatible.

**The framing rule survives the refactor.** An excerpt block is presented to the
model as *rendered PDF output from line N of version V*, and the prompt says so.
It is context for the question, never a quotation the model may treat as source.

---

## Then: media in — drop a JD in whatever form you have it

People do not have job descriptions as clean text. They have a PDF, a screenshot,
a deck. Today the only way in is pasting text into the dialog's textarea. Three
stages, in this order, because each one is worth shipping alone:

### a. A PDF job description

Drop or paste a PDF into the job-target dialog; its text fills the description
field, which the user reads and edits before saving. **Extraction happens in the
browser** with pdf.js's `getTextContent()` — already in the bundle for the
preview, so this adds no dependency, no upload route, and no file storage.
Provenance stays `pasted`: the user supplied it and vouches for it by reading it
before saving. `fetched` still means only what the agent pulled from a URL itself.

Traps: a scanned PDF has no text layer and yields an empty string — say "this PDF
has no selectable text, paste the description instead" rather than saving an
empty JD past the 20-character floor. Join pages with a blank line or the last
requirement of one page runs into the first of the next. And pdf.js must still be
imported inside an effect, from the `legacy/` build — see [web.md](web.md).

### b. Screenshots and images into a turn

The common case is a screenshot of a posting. This needs the content blocks
above, plus three things:

- **A capability flag.** `ModelInfo` (`packages/core/src/provider.ts`) declares
  `supportsTools`; it needs `supportsImages`, set per driver. The gateway must
  refuse an image for a model that cannot take one *at pick time, with a legible
  message*, not halfway through a turn.
- **A persistence decision, made deliberately.** The API persists model messages
  after a turn so a refresh can rehydrate the session. Base64 images in that
  column will bloat Postgres fast. v1: images are turn-scoped and rehydrate as a
  `[image omitted]` text part. Storing them properly is an object-store project
  and should not be smuggled in behind this feature.
- **An invariant boundary.** An image may establish *the job description*, which
  the user confirms in the dialog before it is saved. It is never evidence about
  the user. Resume facts come from the resume and from answers the user typed —
  a model reading a number off a screenshot of someone's old CV is exactly the
  fabrication the first invariant forbids.

### c. Decks, DOCX, everything else

Do not write parsers for these. Reject them legibly — "export this to PDF and
drop it here" — and stop. A DOCX reader that silently drops list content
produces a job description quietly missing half its requirements, and the agent
will then tailor confidently against it. Not supporting a format is visible;
mis-reading one is not.

Cross-cutting, for all three: cap the file size at ingest, and **never store the
raw file**. Extract, show the user, discard. That is what keeps this from
requiring object storage at all.

**Verifying all of it.** `bun run dev`, open a resume. Select a bullet on the
sheet: both popover actions must work with the agent disconnected (jump) and
connected (ask), and a plain click must still behave as it does today. Drop a
real posting PDF into the job dialog and read what comes out before you call the
extractor done. Then run an actual turn against the resulting target — a
compiling document and a green test run say nothing about whether the agent got
usable context.

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
