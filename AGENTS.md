# AGENTS.md — Sailor

Sailor is a resume editor where an agent tailors a user's LaTeX resume to a
specific company and job description, verifying claims against the real posting
before it rewrites anything. It must be **fast**, **honest**, and **reversible**.

These are rules, not suggestions. If a rule blocks you, say so and stop — do not
route around it.

---

## The three invariants

Everything below is downstream of these. Violating one is a bug even if tests pass.

1. **Never invent a fact about the user.** The agent may reword, reorder, cut, and
   re-emphasize what is already in the resume or what the user explicitly told it.
   It may **not** manufacture a metric, a technology, a date, a title, or an
   employer. If a bullet would be stronger with a number, the agent **asks** —
   it does not guess. A resume that lies is worse than a resume that is weak,
   because the user has to defend it in an interview.

2. **Every edit is reversible.** Resume content is content-addressed and every
   agent turn produces a new immutable version row. Nothing is edited in place.
   If you find yourself writing an `UPDATE` against resume content, you are
   modelling it wrong.

3. **The document must always compile.** An edit that produces a resume that
   does not build is not a partial success, it is a failure. The `edit_resume`
   tool compiles before it commits, and rolls back on a LaTeX error.

---

## Stack

- **Runtime / package manager: Bun.** Only Bun. `bun add`, `bun run`, `bun test`.
  Never `npm`/`yarn`/`pnpm`, never a `package-lock.json`.
- **Frontend:** Next.js 16 (App Router, React 19, Server Components by default),
  Tailwind v4.
- **Backend:** Elysia on Bun.
- **DB:** Postgres + Drizzle. Migrations are generated, never hand-edited.
- **Lint/format:** Biome. `bun run check:fix` before you call anything done.
- **Models:** provider-agnostic gateway over the AI SDK. See @docs/providers.md.

## Layout

```
apps/web     Next.js. UI only. Talks to the API over HTTP + one ACP WebSocket.
apps/api     Elysia. HTTP routes + the ACP bridge. Thin — logic lives in packages.
packages/core       Zod schemas + types shared by every other package. No deps.
packages/db         Drizzle schema, migrations, queries. The only place SQL exists.
packages/latex      Tectonic pool (server) + WASM engine (browser). Compile only.
packages/providers  Model gateway. The only place a provider SDK is imported.
packages/agent      Tools, the agent loop, and the MCP server. The brain.
packages/acp        Agent Client Protocol types + transport. Protocol only, no logic.
```

**The dependency graph points one way**, and there are no cycles:

```
core ← db ← agent → providers
core ← latex ← agent
core ← acp
       agent + acp + db + latex → api
                                  web → (http/ws only, never imports agent/db)
```

`apps/web` **never** imports `@sailor/db`, `@sailor/agent`, or a provider SDK.
If the browser needs something from those, it goes through the API. This is what
keeps API keys and OAuth tokens out of the client bundle.

---

## Hard rules

### Boundaries
- A provider SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`, …) may be imported **only**
  inside `packages/providers/src/drivers/`. Everywhere else uses the gateway.
  Adding a provider must not require touching the agent.
- Raw SQL and Drizzle imports live **only** in `packages/db`. The API and the agent
  call query functions, they do not build queries.
- `packages/acp` describes the protocol. It must not know what a resume is.

### Types
- **`any` is a lint error and it is not disableable.** If a type is genuinely
  unknown, it is `unknown` and you narrow it.
- **No non-null assertion (`!`).** Narrow it or handle the null.
- Everything crossing a process boundary — HTTP body, WebSocket frame, tool input,
  LLM output — is parsed with a Zod schema from `@sailor/core` at the boundary.
  Inside the boundary it is a real type. Do not cast.

### Secrets
- API keys and OAuth tokens are **never** returned by an API route, never logged,
  never put in a Zod schema that a client sees. `packages/db` exposes credentials
  through `getDecryptedCredential()` only; the public resolvers return
  `{ provider, kind, label, expiresAt }` and nothing more.
- Never log a full prompt or a full resume at `info`. Both contain PII.

### Errors
- No silent `catch {}`. Either handle it, or wrap it with context and rethrow.
- A tool that fails returns a **structured, model-legible error** (`{ ok: false,
  error, hint }`) — never a thrown exception that kills the turn. The agent is
  expected to read the error and try again; give it enough to do that.

---

## The agent's tools

Defined once, in `packages/agent/src/tools/`. Each tool is a `defineTool()` call
with a Zod input schema, and each is exposed **twice**: in-process to our own loop,
and over MCP by `packages/agent/src/mcp/server.ts`. **Never fork them.** If you add
a tool, it appears in both surfaces automatically — that is the whole point.

Tools that mutate the resume are **gated**: they emit an ACP permission request and
block until the client answers. `read_*` and `search_*` tools are not gated. When
you add a tool, classify it, and default to gated if you are unsure.

## LaTeX

Two compile paths, one source of truth:
- **Browser (WASM, Web Worker):** every keystroke, debounced 400 ms. Optimistic.
  Never blocks the main thread. Keeps the last good PDF on screen while the next
  builds — **never** flash a blank frame.
- **Server (Tectonic, warm pool):** on save, on export, and inside `edit_resume`
  before it commits. Authoritative. The PDF a user downloads is always this one.

If the two disagree, the server is right and the client is stale. Never resolve a
disagreement by trusting the browser.

---

## Definition of done

A change is not done until, in this order:

1. `bun run check` passes (Biome, zero warnings).
2. `bun run typecheck` passes (zero errors, and you did not reach that state by
   adding `any`, `!`, or `@ts-expect-error`).
3. `bun test` passes.
4. **You drove the actual flow.** Compiled a real resume, ran a real agent turn,
   clicked the real button. Typecheck passing is not evidence that a feature works.

If you could not do step 4, say exactly that. Do not describe unverified work as
working — an honest "I couldn't verify this" is far more useful than a confident
wrong claim, and it is never punished here.
