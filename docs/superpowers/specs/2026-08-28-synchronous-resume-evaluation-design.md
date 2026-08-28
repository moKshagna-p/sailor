# Synchronous resume evaluation

## Goal

Add an independent review pass to Sailor's existing tailoring turn. After the
first evidence-backed edits, a reviewer scores the current immutable resume
version against the selected job, returns actionable comments, and gives Sailor
one chance to improve the resume before a final score is shown.

The design adapts the evidence-first, category-scored approach from HackerRank's
MIT-licensed [`interviewstreet/hiring-agent`](https://github.com/interviewstreet/hiring-agent).
It does not run that project's Python CLI or reuse its HackerRank software-intern
rubric, because Sailor is Bun-only and supports arbitrary job targets. Any
substantially copied prompt language must retain HackerRank's MIT notice.

## User flow

For a tailoring prompt with a job target:

1. Sailor performs its normal gap analysis and approval-gated edits. Every
   accepted edit compiles and creates an immutable version as it does today.
2. If the turn emitted a gap analysis or committed a version, the evaluator
   reviews the latest saved version synchronously.
3. Sailor shows the interim score and reviewer comments in chat.
4. The tailoring agent receives the structured review as trusted, hidden turn
   context and performs at most one correction pass. All edits still use
   `edit_resume`, require permission, compile, and create new versions.
5. The evaluator reviews the resulting latest version once more. Sailor shows
   the final score, category evidence, strengths, and remaining improvements.

A normal question that neither records a gap analysis nor edits the resume does
not trigger evaluation. The correction pass never recursively starts another
review cycle.

## Evaluation contract

The evaluator receives the real job target and the content-bearing `.tex` files
from the latest saved resume version. It runs as a separate model call with a
review-only prompt and no mutation tools. The selected session model and existing
provider gateway are reused; there is no second credential path or provider SDK.

The LLM output is parsed at the boundary with a bounded Zod schema from
`@sailor/core`. It contains five scored categories, evidence for each category,
one to five strengths, and one to three actionable improvements. Evidence and
comment strings are capped at 500 characters so reviewer output cannot
unexpectedly dominate the correction prompt:

| Category | Maximum | Meaning |
| --- | ---: | --- |
| Job alignment | 35 | Evidence for the target's important responsibilities and requirements |
| Demonstrated impact | 25 | Specific, defensible outcomes and scope already present in the resume |
| Relevant skills | 20 | Skills supported by projects or experience and relevant to the target |
| Clarity | 10 | Concise, readable, unambiguous presentation |
| Verifiability | 10 | Claims, links, dates, and context that can be checked or defended |

Application code clamps each category to its maximum and sums the five values to
produce the 0–100 total. The model does not supply or calculate the total.

The evaluation prompt must:

- judge only the resume and job-description evidence;
- ignore name, gender, demographics, school prestige, grades, and location;
- distinguish missing evidence from a negative fact;
- never suggest inventing metrics, technologies, titles, dates, or employers;
- phrase a missing potentially useful fact as a question for the user; and
- describe the result as guidance, not an ATS score or hiring prediction.

## Review-driven correction

The first structured review is added only as delimited, hidden review data for
the correction phase. It is explicitly lower priority than Sailor's honesty,
permission, and compilation rules and cannot supply new resume facts. The agent
may reword, reorder, remove, or re-emphasize supported content. If a
recommendation needs a fact that is absent, the agent uses `ask_user`; it cannot
fill the gap itself.

The cycle stops after one correction pass and one final evaluation. It does not
retry toward a target score, because repeated optimization against one noisy
judge adds latency, cost, and incentive to game the rubric.

## Presentation and persistence

Reviewer results are formatted as ordinary assistant Markdown and streamed into
the existing chat. The same text is appended to the session's persisted model
messages, so it survives reload without a new table or UI subsystem. Each report
names whether it is the interim or final review and includes the evaluated
version ID, preventing a historical score from appearing to describe a later
manual edit.

No resume content is updated in place. Evaluations do not create resume versions;
only accepted `edit_resume` calls do.

## Failure and cancellation

- A malformed reviewer response is rejected by the core Zod schema. Sailor
  reports that no reliable score was produced and leaves every accepted version
  untouched.
- Provider, credential, or network failures follow the same rule: do not invent
  a score and do not roll back valid edits.
- Cancellation aborts the active tailoring or evaluation model call and does not
  begin the next phase.
- If a correction edit fails compilation, `edit_resume` returns its existing
  structured error and the agent may fix it within that one correction pass.
- If the user rejects every suggested correction, the final evaluator scores the
  unchanged latest version honestly.

## Implementation boundaries

- `packages/core` owns the evaluation Zod schemas and inferred types.
- `packages/agent` owns evaluation prompting, structured model output, total
  calculation, report formatting, and the bounded two-phase orchestration.
- `apps/api` continues to supply the selected model, persistence callback, abort
  signal, and ACP event sink. It does not learn provider-specific behavior.
- `apps/web`, `packages/db`, `packages/acp`, and provider drivers require no new
  domain concepts for the first version.

## Verification

The smallest useful automated coverage is:

1. A core/agent unit test proves category clamping and deterministic total
   calculation.
2. A scripted-model loop test proves the order `tailor -> review -> correction ->
   final review`, proves the correction cannot bypass `edit_resume`, and proves
   the final report is included in persisted messages.
3. A failure test proves malformed evaluation output yields no fabricated score
   and preserves the latest version.
4. The repository definition of done runs in order: `bun run check`,
   `bun run typecheck`, and `bun test`.
5. Manual verification drives a real job-target tailoring turn, approves an
   edit, observes interim comments, approves or rejects a correction, confirms
   the final score after reload, and checks that the downloaded resume still
   comes from the server-compiled version.
