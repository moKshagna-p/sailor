# Provider Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove discontinued Gemini choices and make encrypted model credential setup minimal and legible.

**Architecture:** Keep the existing provider gateway and credential storage. Change only the curated registry and Settings presentation; provider OAuth remains distinct from login OAuth.

**Tech Stack:** Bun, AI SDK provider gateway, Elysia, React 19, Tailwind v4

**Spec:** `docs/superpowers/specs/2026-08-19-auth-provider-access-resizable-workbench-design.md`

## Global Constraints

- Provider SDK imports remain inside `packages/providers/src/drivers`.
- Every advertised model must support agent tools.
- API keys are verified and encrypted by the existing server path.
- Login Google OAuth is never reused as a Gemini credential.

---

### Task 1: Current Gemini registry

**Files:**
- Modify: `packages/providers/src/drivers/google.ts`
- Modify: `packages/providers/src/registry.test.ts`

- [ ] Write a failing registry test that rejects discontinued Gemini slugs and expects current tool-capable Flash/Pro entries.
- [ ] Run the focused test and confirm it fails on `gemini-2.5-flash`.
- [ ] Replace only the stale curated slugs and labels.
- [ ] Run provider tests, check, and typecheck.
- [ ] Commit as `fix(providers): replace retired gemini models`.

### Task 2: Minimal provider cards

**Files:**
- Modify: `apps/web/app/settings/page.tsx`
- Create: `apps/web/lib/provider-settings.ts`
- Create: `apps/web/lib/provider-settings.test.ts`

- [ ] Write failing tests for pure presentation rules covering connected status, preferred OAuth action, and API-key fallback.
- [ ] Run it and confirm the intended failure.
- [ ] Reduce each provider to its name, short capability line, status, one primary OAuth action when available, and a native disclosure containing the password API-key form.
- [ ] Preserve code-paste OAuth only for providers that require it and preserve safe error messages.
- [ ] Run focused tests, check, typecheck, and all tests.
- [ ] Commit as `refactor(web): simplify model access settings`.

### Task 3: Provider flow verification

- [ ] Start the real app, add and remove a testable provider API key, confirm the secret is never redisplayed, and verify the model picker no longer offers retired Gemini models.
- [ ] Run `bun run check`, `bun run typecheck`, and `bun test`.
- [ ] Commit any flow-discovered repair separately.
