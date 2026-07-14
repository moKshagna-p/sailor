import { expect, test } from 'bun:test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { GapAnalysis, ResumeTree, ResumeVersion } from '@sailor/core';
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

async function fixture(approve: boolean) {
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
      return null;
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
      return {
        versionId: outcome.version.id,
        unchanged: outcome.status === 'unchanged',
      };
    },
  };

  return { ctx, events, resumeId };
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
