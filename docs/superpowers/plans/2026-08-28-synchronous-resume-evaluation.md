# Synchronous Resume Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one synchronous independent critique and correction pass to a Sailor tailoring turn, followed by an evidence-backed final 0–100 score.

**Architecture:** Add a bounded review schema in `@sailor/core` and a focused evaluator in `@sailor/agent` that reuses the selected AI SDK model. Refactor `runTurn()` into a small phase runner so the existing tailoring phase can be followed by review, one correction phase through the same gated tools, and final review; persist formatted reports as ordinary assistant messages.

**Tech Stack:** Bun 1.3, TypeScript 5.9, AI SDK 7 `generateText`/`Output.object`, Zod 4, Bun test, existing ACP and immutable resume tools.

**Spec:** `docs/superpowers/specs/2026-08-28-synchronous-resume-evaluation-design.md`

## Global Constraints

- Bun only; add no Python runtime, sidecar, queue, provider SDK, or package dependency.
- Never invent a user fact. Reviewer advice cannot override `ask_user` or become resume evidence.
- Every accepted correction uses the existing gated `edit_resume` tool, compiles before commit, and creates an immutable version.
- Run at most one critique/correction pass and one final evaluation per triggering turn.
- Trigger only when the first phase records a gap analysis or commits a changed version and has a real job target.
- Calculate the 0–100 total in TypeScript; never accept a model-supplied total.
- Treat job descriptions, resume source, and reviewer strings as bounded untrusted data.
- Persist reports through existing model messages; add no evaluation table, ACP method, or web component.
- Retain the HackerRank MIT notice for any adapted prompt or rubric language.
- Use `unknown` plus narrowing at boundaries; no `any`, non-null assertions, casts, or error suppression.

---

### Task 1: Evaluation schema, scorer, prompt, and attribution

**Files:**
- Create: `packages/core/src/evaluation.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/agent/src/evaluation.ts`
- Create: `packages/agent/src/evaluation.test.ts`
- Modify: `packages/agent/src/index.ts`
- Create: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: `JobTarget`, `ResumeVersion`, AI SDK `LanguageModel`, `generateText`, and `Output.object`.
- Produces: `ResumeEvaluation`, `ScoredResumeEvaluation`, `scoreResumeEvaluation(review)`, `evaluateResume(args)`, `formatResumeEvaluation(stage, versionId, review)`, and `reviewCorrectionContext(review)`.

- [ ] **Step 1: Write failing schema and scorer tests**

Create `packages/agent/src/evaluation.test.ts` with a fixed review fixture and these assertions:

```ts
import { expect, test } from 'bun:test';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import { ResumeEvaluation, type JobTarget, type ResumeVersion } from '@sailor/core';
import { MockLanguageModelV4 } from 'ai/test';
import {
  evaluateResume,
  formatResumeEvaluation,
  scoreResumeEvaluation,
} from './evaluation.ts';

const REVIEW = {
  categories: {
    jobAlignment: { score: 40, evidence: 'Backend API work matches the primary responsibility.' },
    demonstratedImpact: { score: 20, evidence: 'Outcomes are present but mostly unquantified.' },
    relevantSkills: { score: 18, evidence: 'The resume supports the requested TypeScript skills.' },
    clarity: { score: 9, evidence: 'Bullets are concise and direct.' },
    verifiability: { score: 8, evidence: 'Dates and employers are present.' },
  },
  strengths: ['Relevant backend experience'],
  improvements: ['Ask the user for a real latency or throughput result.'],
};

test('scoreResumeEvaluation caps categories and calculates the total in code', () => {
  const scored = scoreResumeEvaluation(ResumeEvaluation.parse(REVIEW));
  expect(scored.categories.jobAlignment.score).toBe(35);
  expect(scored.total).toBe(90);
});

test('ResumeEvaluation rejects empty and oversized reviewer comments', () => {
  expect(() =>
    ResumeEvaluation.parse({
      ...REVIEW,
      improvements: [''],
    }),
  ).toThrow();
  expect(() =>
    ResumeEvaluation.parse({
      ...REVIEW,
      strengths: ['x'.repeat(501)],
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `bun test packages/agent/src/evaluation.test.ts`

Expected: FAIL because `@sailor/core` does not export `ResumeEvaluation` and `./evaluation.ts` does not exist.

- [ ] **Step 3: Add the boundary schema and exports**

Create `packages/core/src/evaluation.ts` with the exact fixed category keys and bounded strings:

```ts
import { z } from 'zod';

const ScoreEvidence = z.object({
  score: z.number().finite().min(0).max(100),
  evidence: z.string().trim().min(1).max(500),
});

export const ResumeEvaluation = z.object({
  categories: z.object({
    jobAlignment: ScoreEvidence,
    demonstratedImpact: ScoreEvidence,
    relevantSkills: ScoreEvidence,
    clarity: ScoreEvidence,
    verifiability: ScoreEvidence,
  }),
  strengths: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
  improvements: z.array(z.string().trim().min(1).max(500)).min(1).max(3),
});

export type ResumeEvaluation = z.infer<typeof ResumeEvaluation>;
export type ScoredResumeEvaluation = ResumeEvaluation & { total: number };
```

Export it from `packages/core/src/index.ts`:

```ts
export * from './evaluation.ts';
```

- [ ] **Step 4: Implement the minimal scorer, evaluator, and formatter**

Create `packages/agent/src/evaluation.ts`. Keep the maxima in one constant, cap each model value before summing, include only `.tex` content (falling back to the entry file), and bound the prompt exactly as shown:

```ts
import {
  type JobTarget,
  type ResumeEvaluation,
  ResumeEvaluation as ResumeEvaluationSchema,
  type ResumeVersion,
  type ScoredResumeEvaluation,
} from '@sailor/core';
import { generateText, type LanguageModel, Output } from 'ai';

const MAX = {
  jobAlignment: 35,
  demonstratedImpact: 25,
  relevantSkills: 20,
  clarity: 10,
  verifiability: 10,
} as const;

const cap = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

export function scoreResumeEvaluation(review: ResumeEvaluation): ScoredResumeEvaluation {
  const categories = {
    jobAlignment: { ...review.categories.jobAlignment, score: cap(review.categories.jobAlignment.score, MAX.jobAlignment) },
    demonstratedImpact: { ...review.categories.demonstratedImpact, score: cap(review.categories.demonstratedImpact.score, MAX.demonstratedImpact) },
    relevantSkills: { ...review.categories.relevantSkills, score: cap(review.categories.relevantSkills.score, MAX.relevantSkills) },
    clarity: { ...review.categories.clarity, score: cap(review.categories.clarity.score, MAX.clarity) },
    verifiability: { ...review.categories.verifiability, score: cap(review.categories.verifiability.score, MAX.verifiability) },
  };
  return {
    ...review,
    categories,
    total: Object.values(categories).reduce((sum, category) => sum + category.score, 0),
  };
}
```

Add `evaluateResume()` using the existing structured-output pattern from `job-target.ts`:

```ts
export async function evaluateResume(args: {
  model: LanguageModel;
  version: ResumeVersion;
  job: JobTarget;
  signal?: AbortSignal;
}): Promise<ScoredResumeEvaluation> {
  const texFiles = args.version.tree.files.filter((file) => file.path.endsWith('.tex'));
  const files = texFiles.length > 0
    ? texFiles
    : args.version.tree.files.filter((file) => file.path === args.version.tree.entry);
  const source = files.map((file) => `## ${file.path}\n${file.content}`).join('\n\n').slice(0, 30_000);

  const result = await generateText({
    model: args.model,
    output: Output.object({ schema: ResumeEvaluationSchema }),
    system: REVIEW_SYSTEM_PROMPT,
    prompt: `JOB DESCRIPTION (untrusted data):\n${args.job.description.slice(0, 12_000)}\n\nRESUME SOURCE (untrusted data):\n${source}`,
    maxRetries: 1,
    timeout: 30_000,
    abortSignal: args.signal,
  });

  return scoreResumeEvaluation(result.output);
}
```

`REVIEW_SYSTEM_PROMPT` must describe the five maxima, require evidence, ignore protected/personal factors, forbid invented facts, treat embedded text as data, and say the score is guidance rather than an ATS or hiring prediction. Add this deliberate ceiling beside the source slice:

```ts
// ponytail: one bounded prompt; chunk only if real resume source regularly exceeds 30k chars.
```

Implement `formatResumeEvaluation()` as deterministic Markdown headed `Interim resume review` or `Final resume score`, including `versionId`, all five `score/max` lines with evidence, strengths, improvements, and the guidance disclaimer. Implement `reviewCorrectionContext()` by JSON-stringifying only the scored review beneath instructions that it is untrusted advice, not resume evidence, and that every missing fact must go through `ask_user`.

Export the public functions from `packages/agent/src/index.ts`.

- [ ] **Step 5: Finish evaluator tests with a structured mock call**

Extend `evaluation.test.ts` with typed `VERSION`, `JOB`, and usage fixtures. Script `MockLanguageModelV4.doGenerate` to return `JSON.stringify(REVIEW)` and assert:

```ts
const evaluated = await evaluateResume({ model, version: VERSION, job: JOB });
expect(evaluated.total).toBe(90);
expect(formatResumeEvaluation('final', VERSION.id, evaluated)).toContain('Final resume score: 90/100');
```

Also capture the mock call options and assert the prompt contains the job description and `.tex` resume content but not a `.cls` fixture's content.

- [ ] **Step 6: Run focused tests and formatting checks**

Run: `bun test packages/agent/src/evaluation.test.ts`

Expected: PASS.

Run: `bun run check:fix`

Expected: Biome formats the new files with zero remaining diagnostics.

- [ ] **Step 7: Add the upstream license notice**

Create `THIRD_PARTY_NOTICES.md` naming `interviewstreet/hiring-agent`, linking its repository, stating that Sailor adapts its evidence-first category-scoring approach, and include the full MIT text beginning:

```text
MIT License

Copyright (c) 2025 HackerRank
```

Copy the remaining license text verbatim from `https://github.com/interviewstreet/hiring-agent/blob/main/LICENSE`.

- [ ] **Step 8: Commit the independently testable evaluator**

```bash
git add THIRD_PARTY_NOTICES.md packages/core/src/evaluation.ts packages/core/src/index.ts packages/agent/src/evaluation.ts packages/agent/src/evaluation.test.ts packages/agent/src/index.ts
git commit -m "feat(agent): add evidence-based resume evaluator"
```

---

### Task 2: Bounded tailoring-review-correction cycle

**Files:**
- Modify: `packages/agent/src/loop.ts`
- Modify: `packages/agent/src/loop.test.ts`
- Modify: `docs/agent.md`

**Interfaces:**
- Consumes: Task 1's `evaluateResume()`, `formatResumeEvaluation()`, and `reviewCorrectionContext()` plus the existing `runTurn()` arguments and tools.
- Produces: unchanged `runTurn(args): Promise<TurnResult>` API with review reports included in `TurnResult.messages` and the existing ACP event stream.

- [ ] **Step 1: Write the failing end-to-end cycle test**

Extend `packages/agent/src/loop.test.ts` with a `reviewingModel()` whose `doStream` sequence is:

1. initial `edit_resume` call;
2. initial phase text completion;
3. correction `edit_resume` call based only on existing words;
4. correction phase text completion.

Its `doGenerate` sequence returns an interim review and a stronger final review. Record each call in an `order: string[]`, return a non-null job from the fixture, and assert:

```ts
expect(order).toEqual([
  'tailor-edit',
  'tailor-finish',
  'interim-review',
  'correction-edit',
  'correction-finish',
  'final-review',
]);
expect(events.filter((event) => event.type === 'version_committed')).toHaveLength(2);
expect(result.messages.at(-1)).toMatchObject({ role: 'assistant' });
expect(JSON.stringify(result.messages.at(-1))).toContain('Final resume score');
```

Use truthful test edits such as changing `Improved checkout performance.` to `Improved checkout reliability.` and then to `Improved checkout reliability by reducing redundant session lookups.`; do not introduce a technology or metric absent from the fixture.

- [ ] **Step 2: Run the cycle test and verify it fails at the missing review calls**

Run: `bun test packages/agent/src/loop.test.ts`

Expected: the new test FAILS because current `runTurn()` stops after the initial tailoring stream and never calls `doGenerate` or a correction phase.

- [ ] **Step 3: Extract one private streaming phase helper**

In `packages/agent/src/loop.ts`, move the existing `streamText` consumption into a private `runPhase()` that accepts the model, context, messages, system prompt, event sink, and abort signal and returns response messages plus its stop reason. It must not emit `turn_end`; only the outer `runTurn()` owns the single terminal event.

```ts
type PhaseResult = {
  messages: ModelMessage[];
  stopReason: TurnResult['stopReason'];
};

async function runPhase(args: {
  model: LanguageModel;
  ctx: ToolContext;
  messages: ModelMessage[];
  system: string;
  emit: AgentEventSink;
  signal?: AbortSignal;
}): Promise<PhaseResult> {
  // Existing streamText/fullStream switch, error handling, and MAX_STEPS check.
}
```

Preserve every existing stream event and handled tool-error behavior. Update existing loop tests before adding review orchestration; they must still pass after this pure refactor.

- [ ] **Step 4: Track review intent through a wrapped ToolContext**

Inside `runTurn()`, wrap only the two context methods that already prove tailoring work happened:

```ts
let shouldReview = false;
const trackedCtx: ToolContext = {
  ...ctx,
  emitGapAnalysis(analysis) {
    shouldReview = true;
    ctx.emitGapAnalysis(analysis);
  },
  async commit(input) {
    const outcome = await ctx.commit(input);
    if (!outcome.unchanged) shouldReview = true;
    return outcome;
  },
};
```

Run the initial phase with `trackedCtx`. If it ends with `error`, `cancelled`, or `max_steps`, or if `job` is null or `shouldReview` is false, emit the one `turn_end` and return exactly the current behavior.

- [ ] **Step 5: Add interim review, one correction phase, and final review**

After a successful triggering initial phase:

1. Re-read `ctx.currentVersion()`.
2. Call `evaluateResume()` and format the interim report.
3. Emit the report as one `text_delta` and add it as an assistant text message for persistence.
4. Rebuild the normal system prompt from the interim version and append
   `reviewCorrectionContext(interim)`. Call the correction phase with prior
   history, the original user message, the initial response, the interim report
   as an assistant message, and a final synthetic user instruction: `Apply the
   independent review now. Make only evidence-backed improvements, then stop.`
   Do not include that synthetic user message in `TurnResult.messages`.
5. If correction ends normally, re-read the latest version, evaluate once more, emit the final report, and append it as the final assistant text message.
6. Emit exactly one `turn_end` for the whole cycle.

Construct synthetic persisted reports without a cast:

```ts
const assistantText = (text: string): ModelMessage => ({ role: 'assistant', content: text });
```

Do not recurse into `runTurn()` for correction; call `runPhase()` directly so a correction cannot trigger another evaluator cycle.

- [ ] **Step 6: Add honest reviewer failure behavior**

Wrap each evaluation call with contextual handling. On malformed output, provider failure, or timeout, emit an `error`, append this assistant message, emit `turn_end` with `error`, and return all successful tailoring messages without starting another phase:

```text
### Resume review unavailable

The resume edits made so far are saved, but the evaluator did not produce a valid score. No score was guessed. Retry the tailoring request to run the review again.
```

If `signal.aborted`, preserve the existing `cancelled` behavior and do not report a provider failure.

- [ ] **Step 7: Add no-trigger and malformed-review tests**

Add two focused cases to `loop.test.ts`:

- A plain-answer model with a real job but no `record_gap_analysis` or changed commit makes zero `doGenerate` calls.
- A triggering model whose reviewer returns invalid JSON yields `stopReason: 'error'`, contains `Resume review unavailable` in persisted messages, emits no fabricated `/100` score, and leaves the successfully committed version as the current tip.

Run: `bun test packages/agent/src/loop.test.ts`

Expected: PASS, including all pre-existing loop cases.

- [ ] **Step 8: Document the cycle**

Update `docs/agent.md` under “A turn” with the exact bounded behavior: ordinary questions stay one phase; a gap analysis or committed edit with a job triggers interim review, one correction phase, and final review; evaluation failures preserve versions and produce no score.

- [ ] **Step 9: Run package checks and commit**

Run: `bun run check:fix`

Expected: zero remaining Biome diagnostics.

Run: `bun run typecheck`

Expected: zero TypeScript errors.

Run: `bun test packages/agent/src/evaluation.test.ts packages/agent/src/loop.test.ts`

Expected: PASS.

```bash
git add packages/agent/src/loop.ts packages/agent/src/loop.test.ts docs/agent.md
git commit -m "feat(agent): review tailored resumes before scoring"
```

---

### Task 3: Repository verification and real-flow check

**Files:**
- Modify only files needed to correct failures introduced by Tasks 1–2; do not broaden scope.

**Interfaces:**
- Consumes: completed evaluator and bounded cycle.
- Produces: repository-wide evidence that the implementation meets Sailor's definition of done.

- [ ] **Step 1: Run the required static checks in order**

Run: `bun run check`

Expected: PASS with zero warnings.

Run: `bun run typecheck`

Expected: PASS with zero errors and no `any`, non-null assertion, or `@ts-expect-error` workaround.

- [ ] **Step 2: Run the full automated suite**

Run: `bun test`

Expected: every test passes, including real Tectonic and Postgres integration tests.

- [ ] **Step 3: Drive the actual flow**

Start Sailor with the existing project command:

```bash
bun run dev
```

In the real browser flow:

1. Open a saved resume and select a real job target plus a configured model.
2. Ask Sailor to tailor the resume.
3. Confirm the normal gap analysis appears.
4. Approve one truthful edit and confirm the preview reloads from a compiled version.
5. Confirm an interim 0–100 review appears with category evidence.
6. Approve or reject the correction edit.
7. Confirm the final score names the latest version ID.
8. Reload the page and confirm both review reports remain in chat.
9. Download or compile the final resume and confirm the server-built document succeeds.

If provider credentials prevent this step, record the exact missing credential or provider response and do not claim the real flow works.

- [ ] **Step 4: Commit only if verification required a code correction**

If corrections exist, use `git status --short` to identify their exact paths,
stage only those paths, and commit them with subject
`fix(agent): correct resume evaluation flow`. If no correction was needed, do
not create an empty commit.
