import { expect, test } from 'bun:test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { GapAnalysis, JobTarget, ResumeTree, ResumeVersion } from '@sailor/core';
import { commitVersion, createResume, ensureUser, getCurrentVersion } from '@sailor/db';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { AgentEvent } from './events.ts';
import { runTurn } from './loop.ts';
import type { ToolContext } from './tools/context.ts';

/**
 * End-to-end through the REAL loop, the REAL tools, a REAL Tectonic compile and a
 * REAL Postgres commit. Only the model is scripted — so this proves everything
 * except the model's judgement, which is the one thing a test cannot assert.
 */

const RESUME: ResumeTree = {
  entry: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: String.raw`\documentclass{article}
\begin{document}
\section{Experience}
\begin{itemize}
  \item Improved checkout performance.
  \item Reduced redundant session lookups.
\end{itemize}
\end{document}`,
    },
  ],
};

/** Token accounting is irrelevant here, but the shape is not optional. */
const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const JOB: JobTarget = {
  id: 'job_test',
  company: 'Acme',
  role: 'Backend Engineer',
  description: 'Build reliable checkout services and improve backend performance.',
  sourceUrl: null,
  provenance: 'pasted',
  createdAt: new Date('2026-08-29T00:00:00Z'),
};

/** A model that calls edit_resume once, then says it is done. */
function scriptedModel(edit: { oldText: string; newText: string; summary: string }) {
  let step = 0;

  // Annotated separately rather than inline in a ternary: a ternary of two array
  // literals widens `finishReason` to `string` before the annotation can pin it.
  const callsTheTool: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'edit_resume',
      input: JSON.stringify(edit),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls' as const, raw: undefined },
      usage: USAGE,
    },
  ];

  const wrapsUp: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Done — I sharpened that bullet.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE },
  ];

  return new MockLanguageModelV4({
    doStream: async () => {
      step++;
      return { stream: simulateReadableStream({ chunks: step === 1 ? callsTheTool : wrapsUp }) };
    },
  });
}

async function fixture(approve: boolean, job: JobTarget | null = null) {
  const userId = await ensureUser(`loop-${crypto.randomUUID()}@sailor.local`);
  const { resumeId } = await createResume({
    userId,
    title: 'Loop test',
    tree: RESUME,
  });

  const events: AgentEvent[] = [];
  const ctx: ToolContext = {
    userId,
    sessionId: 'ses_test',
    resumeId,
    async currentVersion(): Promise<ResumeVersion> {
      const version = await getCurrentVersion(resumeId);
      if (!version) throw new Error('no version');
      return version;
    },
    async jobTarget() {
      return job;
    },
    async requestPermission() {
      return approve;
    },
    async askUser() {
      return '';
    },
    emitGapAnalysis(analysis: GapAnalysis) {
      events.push({ type: 'gap_analysis', analysis });
    },
    async commit({ tree, summary, parentId }) {
      const outcome = await commitVersion({
        resumeId,
        tree,
        summary,
        createdBy: 'agent',
        parentId,
      });
      if (outcome.status === 'committed') {
        events.push({
          type: 'version_committed',
          versionId: outcome.version.id,
          summary,
          diff: '',
        });
      }
      return {
        versionId: outcome.version.id,
        unchanged: outcome.status === 'unchanged',
      };
    },
  };

  return { ctx, events, resumeId };
}

function reviewingModel(order: string[]) {
  let streamStep = 0;
  let reviewStep = 0;
  const edits = [
    {
      oldText: '\\item Improved checkout performance.',
      newText: '\\item Improved checkout reliability.',
      summary: 'Emphasise checkout reliability',
    },
    {
      oldText: '\\item Improved checkout reliability.',
      newText: '\\item Improved checkout reliability by reducing redundant session lookups.',
      summary: 'Connect reliability to supported implementation detail',
    },
  ];
  const reviews = [
    {
      categories: {
        jobAlignment: { score: 28, evidence: 'Checkout work aligns with the target.' },
        demonstratedImpact: { score: 17, evidence: 'Impact is present but not quantified.' },
        relevantSkills: { score: 15, evidence: 'Backend experience is supported.' },
        clarity: { score: 8, evidence: 'The bullets are concise.' },
        verifiability: { score: 8, evidence: 'The claims remain defensible.' },
      },
      strengths: ['Relevant checkout experience'],
      improvements: ['Connect the reliability claim to the supported session lookup work.'],
    },
    {
      categories: {
        jobAlignment: { score: 31, evidence: 'The revised checkout bullet aligns strongly.' },
        demonstratedImpact: { score: 19, evidence: 'The method now makes the impact clearer.' },
        relevantSkills: { score: 16, evidence: 'Backend work remains well supported.' },
        clarity: { score: 9, evidence: 'The revised bullet is direct.' },
        verifiability: { score: 9, evidence: 'Every claim is present in the resume.' },
      },
      strengths: ['Clear, evidence-backed checkout experience'],
      improvements: ['Ask the user whether a defensible outcome metric exists.'],
    },
  ];

  return new MockLanguageModelV4({
    doStream: async () => {
      const phaseStep = streamStep % 2;
      const edit = edits[Math.floor(streamStep / 2)];
      order.push(
        streamStep === 0
          ? 'tailor-edit'
          : streamStep === 1
            ? 'tailor-finish'
            : streamStep === 2
              ? 'correction-edit'
              : 'correction-finish',
      );
      streamStep++;

      const chunks: LanguageModelV4StreamPart[] =
        phaseStep === 0 && edit
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: `call_${streamStep}`,
                toolName: 'edit_resume',
                input: JSON.stringify(edit),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: USAGE,
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: `text_${streamStep}` },
              { type: 'text-delta', id: `text_${streamStep}`, delta: 'Phase complete.' },
              { type: 'text-end', id: `text_${streamStep}` },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: USAGE,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
    doGenerate: async () => {
      order.push(reviewStep === 0 ? 'interim-review' : 'final-review');
      const review = reviews[reviewStep];
      reviewStep++;
      return {
        content: [{ type: 'text', text: JSON.stringify(review) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

function malformedReviewModel() {
  let step = 0;
  const edit = {
    oldText: '\\item Improved checkout performance.',
    newText: '\\item Improved checkout reliability.',
    summary: 'Emphasise checkout reliability',
  };

  return new MockLanguageModelV4({
    doStream: async () => {
      step++;
      const chunks: LanguageModelV4StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'malformed_review_edit',
                toolName: 'edit_resume',
                input: JSON.stringify(edit),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: USAGE,
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'malformed_review_finish' },
              {
                type: 'text-delta',
                id: 'malformed_review_finish',
                delta: 'Tailoring complete.',
              },
              { type: 'text-end', id: 'malformed_review_finish' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: USAGE,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
    doGenerate: async () => ({
      content: [{ type: 'text', text: '{not valid json' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

test('an approved edit flows model → tool → compile → Postgres, and the document changes', async () => {
  const { ctx, events, resumeId } = await fixture(true);

  const result = await runTurn({
    model: scriptedModel({
      oldText: '\\item Improved checkout performance.',
      newText: '\\item Cut checkout latency by moving session state to Redis.',
      summary: 'Sharpen the checkout bullet',
    }),
    ctx,
    history: [],
    userMessage: 'Tailor this for a backend role at Stripe.',
    emit: (event) => events.push(event),
  });

  expect(result.stopReason).toBe('end_turn');

  const toolEnd = events.find((e) => e.type === 'tool_end');
  expect(toolEnd).toMatchObject({ name: 'edit_resume', ok: true });

  // The resume actually changed in the database — not just in the event stream.
  const tip = await getCurrentVersion(resumeId);
  expect(tip?.tree.files[0]?.content).toContain('Redis');
  expect(tip?.summary).toBe('Sharpen the checkout bullet');
  expect(tip?.createdBy).toBe('agent');

  // And the model got the last word.
  const text = events
    .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');
  expect(text).toContain('sharpened');
}, 120_000);

test('a denied edit leaves the document untouched', async () => {
  const { ctx, events, resumeId } = await fixture(false);

  await runTurn({
    model: scriptedModel({
      oldText: '\\item Improved checkout performance.',
      newText: '\\item Improved checkout performance by 40\\%.',
      summary: 'Add a metric',
    }),
    ctx,
    history: [],
    userMessage: 'Make it punchier.',
    emit: (event) => events.push(event),
  });

  const toolEnd = events.find((e) => e.type === 'tool_end');
  expect(toolEnd).toMatchObject({ name: 'edit_resume', ok: false });

  const tip = await getCurrentVersion(resumeId);
  expect(tip?.tree.files[0]?.content).not.toContain('40');
  expect(tip?.createdBy).toBe('user'); // still the original upload
}, 120_000);

test('a tailoring edit gets one review, one correction pass, and a final score', async () => {
  const { ctx, events } = await fixture(true, JOB);
  const order: string[] = [];

  const result = await runTurn({
    model: reviewingModel(order),
    ctx,
    history: [],
    userMessage: 'Tailor this resume for the selected backend role.',
    emit: (event) => events.push(event),
  });

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
}, 180_000);

test('an ordinary answer with a job target does not invoke the evaluator', async () => {
  const { ctx, events } = await fixture(true, JOB);
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'plain_answer' },
    { type: 'text-delta', id: 'plain_answer', delta: 'Here is the answer.' },
    { type: 'text-end', id: 'plain_answer' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
  ];
  const model = new MockLanguageModelV4({
    doStream: { stream: simulateReadableStream({ chunks }) },
  });

  const result = await runTurn({
    model,
    ctx,
    history: [],
    userMessage: 'What does this role value most?',
    emit: (event) => events.push(event),
  });

  expect(result.stopReason).toBe('end_turn');
  expect(model.doGenerateCalls).toHaveLength(0);
});

test('malformed reviewer output preserves the edit and never guesses a score', async () => {
  const { ctx, events, resumeId } = await fixture(true, JOB);

  const result = await runTurn({
    model: malformedReviewModel(),
    ctx,
    history: [],
    userMessage: 'Tailor this resume for the selected backend role.',
    emit: (event) => events.push(event),
  });

  expect(result.stopReason).toBe('error');
  expect(JSON.stringify(result.messages)).toContain('Resume review unavailable');
  expect(JSON.stringify(result.messages)).not.toContain('/100');
  expect(events.filter((event) => event.type === 'turn_end')).toHaveLength(1);
  const tip = await getCurrentVersion(resumeId);
  expect(tip?.tree.files[0]?.content).toContain('Improved checkout reliability.');
}, 180_000);
