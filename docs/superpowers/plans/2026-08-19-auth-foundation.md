# Authentication Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the development user with Google/GitHub Better Auth sessions across HTTP and ACP.

**Architecture:** Better Auth is configured in the Elysia API, while its Drizzle adapter and schema remain in `@sailor/db`. The web client sends cookies and renders a minimal sign-in/session UI.

**Tech Stack:** Bun, Better Auth, Elysia, Drizzle/Postgres, Next.js 16, React 19

**Spec:** `docs/superpowers/specs/2026-08-19-auth-provider-access-resizable-workbench-design.md`

## Global Constraints

- Google and GitHub OAuth only; no passwords.
- Drizzle imports stay inside `packages/db`.
- Secrets never cross a public API boundary or enter logs.
- Existing development-user data is not reassigned.
- Every commit passes check, typecheck, and its focused tests.

---

### Task 1: Better Auth database schema

**Files:**
- Modify: `packages/db/package.json`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/auth-adapter.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/drizzle/*.sql` through `bun run db:generate`

**Interfaces:**
- Produces: `authDatabase`, a configured Better Auth Drizzle adapter.
- Produces: plural `users`, `accounts`, `sessions`, and `verifications` tables.

- [ ] Add Better Auth's Drizzle adapter with Bun.
- [ ] Generate the required Drizzle schema from the configured auth instance, merge the required fields/tables into `schema.ts`, and keep existing app foreign keys intact.
- [ ] Generate, never hand-edit, the SQL migration with `bun run db:generate`.
- [ ] Run `bun run check`, `bun run typecheck`, and DB tests.
- [ ] Commit as `feat(db): add better auth schema`.

### Task 2: API session enforcement

**Files:**
- Modify: `apps/api/package.json`
- Replace: `apps/api/src/auth.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `.env.example`
- Test: `apps/api/src/auth.test.ts`

**Interfaces:**
- Consumes: `authDatabase`.
- Produces: `auth`, `currentUserId(headers): Promise<string>`, and `/api/auth/*`.

- [ ] Write a failing test proving missing session headers produce an unauthorized error and valid session lookup returns the user ID.
- [ ] Run the focused test and confirm the missing implementation failure.
- [ ] Configure Better Auth with explicit base URL, secret, trusted web origin, and only Google/GitHub social providers; validate required environment variables at startup.
- [ ] Mount `auth.handler`, replace dev-user minting with `auth.api.getSession`, and authenticate ACP from the WebSocket upgrade headers.
- [ ] Run focused tests, check, and typecheck.
- [ ] Commit as `feat(api): enforce oauth sessions`.

### Task 3: Browser sign-in and cookie transport

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/lib/auth-client.ts`
- Modify: `apps/web/lib/api.ts`
- Create: `apps/web/app/sign-in/page.tsx`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/settings/page.tsx`

**Interfaces:**
- Consumes: `/api/auth/*` and Better Auth's public session.
- Produces: Google/GitHub sign-in, session gate, user menu, and sign-out.

- [ ] Write a failing browser/helper test proving API requests include cookies and 401s lead to `/sign-in`.
- [ ] Run the focused test and confirm failure.
- [ ] Add the Better Auth browser client pointed at `NEXT_PUBLIC_API_URL`, with a two-button sign-in page.
- [ ] Add the smallest shared session gate/user menu that preserves App Router boundaries and signs out through Better Auth.
- [ ] Run focused tests, check, typecheck, and the full test suite.
- [ ] Commit as `feat(web): add oauth sign-in flow`.

### Task 4: Real authentication verification

**Files:**
- Modify only if the driven flow exposes a defect.

- [ ] Apply the generated migration to local Postgres.
- [ ] Run `bun run check`, `bun run typecheck`, and `bun test`.
- [ ] Start API and web, verify unauthenticated redirects and authenticated cookie transport; complete Google or GitHub only if operator OAuth credentials are available.
- [ ] Commit any verified repair separately with a scoped conventional subject.

