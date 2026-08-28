import { errorMessage } from '@sailor/core';
import type { LanguageModel, ModelMessage } from 'ai';
import { stepCountIs, streamText } from 'ai';
import { evaluateResume, formatResumeEvaluation, reviewCorrectionContext } from './evaluation.ts';
import type { AgentEventSink } from './events.ts';
import { systemPrompt } from './prompt.ts';
import type { ToolContext } from './tools/context.ts';
import { buildTools } from './tools/index.ts';

/**
 * A single agent turn. Blocks until the model stops, streaming events as it goes.
 *
 * Permission gating happens *inside* the tools (see resume.ts), not here. The AI
 * SDK's native `toolApproval` would work, but it requires ending the stream and
 * resuming it with an approval response — which means the turn's state has to
 * survive a round-trip to the browser. Gating inside `execute` keeps one
 * continuous stream and one place where "is this allowed" is answered.
 */
const MAX_STEPS = 40;

export type TurnResult = {
  /** New messages produced this turn, ready to persist for the next one. */
  messages: ModelMessage[];
  stopReason: 'end_turn' | 'max_steps' | 'error' | 'cancelled';
};

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
  const { model, ctx, messages, system, emit, signal } = args;

  const result = streamText({
    model,
    system,
    messages,
    tools: buildTools(ctx),
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: signal,
  });

  let stopReason: TurnResult['stopReason'] = 'end_turn';

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'reasoning-delta':
          emit({ type: 'thinking_delta', text: part.text });
          break;

        case 'text-delta':
          emit({ type: 'text_delta', text: part.text });
          break;

        case 'tool-call':
          emit({
            type: 'tool_start',
            callId: part.toolCallId,
            name: part.toolName,
            input: part.input,
          });
          break;

        case 'tool-result': {
          // Our tools return Result<T>; a false `ok` is a handled failure the
          // model is expected to recover from, not a crash.
          const output = part.output as { ok?: boolean } | undefined;
          emit({
            type: 'tool_end',
            callId: part.toolCallId,
            name: part.toolName,
            ok: output?.ok !== false,
            output: part.output,
          });
          break;
        }

        case 'tool-error':
          emit({
            type: 'tool_end',
            callId: part.toolCallId,
            name: part.toolName,
            ok: false,
            output: { ok: false, error: errorMessage(part.error) },
          });
          break;

        case 'error':
          stopReason = 'error';
          emit({ type: 'error', message: errorMessage(part.error) });
          break;

        case 'abort':
          stopReason = 'cancelled';
          break;

        default:
          break;
      }
    }
  } catch (cause) {
    if (signal?.aborted) return { messages: [], stopReason: 'cancelled' };
    emit({ type: 'error', message: errorMessage(cause) });
    return { messages: [], stopReason: 'error' };
  }

  const steps = await result.steps;
  if (steps.length >= MAX_STEPS && stopReason === 'end_turn') {
    stopReason = 'max_steps';
    emit({
      type: 'error',
      message:
        `The agent hit its ${MAX_STEPS}-step limit and stopped. Its work so far is saved — ` +
        `send another message to have it continue.`,
    });
  }

  const response = await result.response;
  return { messages: response.messages, stopReason };
}

const assistantText = (text: string): ModelMessage => ({ role: 'assistant', content: text });

const REVIEW_UNAVAILABLE = `### Resume review unavailable

The resume edits made so far are saved, but the evaluator did not produce a valid score. No
score was guessed. Retry the tailoring request to run the review again.`;

export async function runTurn(args: {
  model: LanguageModel;
  ctx: ToolContext;
  /** Prior turns, replayed from the DB. */
  history: ModelMessage[];
  userMessage: string;
  emit: AgentEventSink;
  signal?: AbortSignal;
}): Promise<TurnResult> {
  const { model, ctx, history, userMessage, emit, signal } = args;

  const version = await ctx.currentVersion();
  const job = await ctx.jobTarget();
  const messages: ModelMessage[] = [...history, { role: 'user', content: userMessage }];
  const turnMessages: ModelMessage[] = [{ role: 'user', content: userMessage }];
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

  const finish = (stopReason: TurnResult['stopReason']): TurnResult => {
    emit({ type: 'turn_end', stopReason });
    return { messages: turnMessages, stopReason };
  };

  const reviewFailed = (cause: unknown): TurnResult => {
    if (signal?.aborted) return finish('cancelled');
    emit({ type: 'error', message: `Resume review failed: ${errorMessage(cause)}` });
    emit({ type: 'text_delta', text: `\n\n${REVIEW_UNAVAILABLE}` });
    turnMessages.push(assistantText(REVIEW_UNAVAILABLE));
    return finish('error');
  };

  const initial = await runPhase({
    model,
    ctx: trackedCtx,
    messages,
    system: systemPrompt({ version, job }),
    emit,
    signal,
  });
  turnMessages.push(...initial.messages);

  if (initial.stopReason !== 'end_turn') {
    if (
      initial.messages.length === 0 &&
      (initial.stopReason === 'error' || initial.stopReason === 'cancelled')
    ) {
      turnMessages.length = 0;
    }
    return finish(initial.stopReason);
  }
  if (!job || !shouldReview) return finish('end_turn');

  const interimVersion = await ctx.currentVersion();
  let interimReview: Awaited<ReturnType<typeof evaluateResume>>;
  try {
    interimReview = await evaluateResume({ model, version: interimVersion, job, signal });
  } catch (cause) {
    return reviewFailed(cause);
  }

  const interimReport = formatResumeEvaluation('interim', interimVersion.id, interimReview);
  const interimMessage = assistantText(interimReport);
  emit({ type: 'text_delta', text: `\n\n${interimReport}` });
  turnMessages.push(interimMessage);

  const correction = await runPhase({
    model,
    ctx,
    messages: [
      ...messages,
      ...initial.messages,
      interimMessage,
      {
        role: 'user',
        content:
          'Apply the independent review now. Make only evidence-backed improvements, then stop.',
      },
    ],
    system: `${systemPrompt({ version: interimVersion, job })}\n\n${reviewCorrectionContext(interimReview)}`,
    emit,
    signal,
  });
  turnMessages.push(...correction.messages);
  if (correction.stopReason !== 'end_turn') return finish(correction.stopReason);

  const finalVersion = await ctx.currentVersion();
  let finalReview: Awaited<ReturnType<typeof evaluateResume>>;
  try {
    finalReview = await evaluateResume({ model, version: finalVersion, job, signal });
  } catch (cause) {
    return reviewFailed(cause);
  }

  const finalReport = formatResumeEvaluation('final', finalVersion.id, finalReview);
  emit({ type: 'text_delta', text: `\n\n${finalReport}` });
  turnMessages.push(assistantText(finalReport));
  return finish('end_turn');
}
