# Resizable Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Source, Preview, and Agent adjustable on desktop and usable as full-width tabs on narrow screens.

**Architecture:** One pure clamp function owns pane math. The existing workbench uses CSS grid track sizes, native pointer capture, and two accessible separators; a CSS breakpoint swaps the same mounted panes into a tabbed narrow layout.

**Tech Stack:** React 19, CSS Grid, Pointer Events, Tailwind v4, localStorage

**Spec:** `docs/superpowers/specs/2026-08-19-auth-provider-access-resizable-workbench-design.md`

## Global Constraints

- No resizing dependency.
- Source, Preview, and Agent state must survive responsive changes.
- Separators support pointer and keyboard input.
- Each pane retains a usable minimum width.

---

### Task 1: Pane sizing rules

**Files:**
- Create: `apps/web/lib/pane-layout.ts`
- Create: `apps/web/lib/pane-layout.test.ts`

**Interfaces:**
- Produces: pure clamping and keyboard-step functions returning three pixel widths.

- [ ] Write failing Bun tests for left/right drag clamping, narrow containers, and arrow-key steps.
- [ ] Run them and confirm the module is missing.
- [ ] Implement the minimum pure arithmetic needed by both separators.
- [ ] Run focused tests, check, and typecheck.
- [ ] Commit as `feat(web): add pane sizing rules`.

### Task 2: Accessible desktop resizing

**Files:**
- Modify: `apps/web/app/r/[id]/page.tsx`

- [ ] Wire the pure rules into two `role="separator"` controls with pointer capture, keyboard arrows, ARIA values, and local-storage restoration.
- [ ] Render grid tracks from state and disable document selection only while dragging.
- [ ] Run check, typecheck, focused tests, and all tests.
- [ ] Commit as `feat(web): make workbench panes resizable`.

### Task 3: Narrow-screen pane tabs

**Files:**
- Modify: `apps/web/app/r/[id]/page.tsx`

- [ ] Add a three-button tablist visible at the narrow breakpoint and hide inactive panes with CSS while leaving their React instances mounted.
- [ ] Ensure active-tab, tabpanel, focus, and selected-state semantics are present.
- [ ] Run check, typecheck, and all tests.
- [ ] Commit as `feat(web): add responsive workbench tabs`.

### Task 4: Real layout verification

- [ ] Drive both separators by mouse and keyboard at desktop width.
- [ ] Reload and confirm proportions restore without crushing a pane.
- [ ] Resize to phone/tablet widths and exercise Source, Preview, and Agent tabs without losing editor, PDF, or chat state.
- [ ] Run `bun run check`, `bun run typecheck`, and `bun test`.
- [ ] Commit any flow-discovered repair separately.
