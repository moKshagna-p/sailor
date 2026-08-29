import { errorMessage, type ScoredResumeEvaluation } from '@sailor/core';
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

const REVIEW_UNAVAILABLE = `### Resume review unavailable

The resume edits made so far are saved, but the evaluator did not produce a valid score. No score was guessed. Retry the tailoring request to run the review again.`;

const assistantText = (text: string): ModelMessage => ({ role: 'assistant', content: text });

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
    // A tailoring turn legitimately takes many steps: fetch the JD, read the
    // resume, analyse, ask, then a dozen small edits. Stopping at 10 would cut
    // the agent off mid-job; unbounded would let a confused model spin forever.
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
          const failed =
            typeof part.output === 'object' &&
            part.output !== null &&
            'ok' in part.output &&
            part.output.ok === false;
          emit({
            type: 'tool_end',
            callId: part.toolCallId,
            name: part.toolName,
            ok: !failed,
            output: part.output,
          });
          break;
        }

        case 'tool-error':
          // A tool *threw*. That is our bug, not the model's — but the model can
          // still route around it, so surface it and keep the turn alive.
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
          // Every other part (text-start, step boundaries, raw chunks) carries no
          // information the client needs. Deliberately ignored.
          break;
      }
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
  } catch (cause) {
    if (signal?.aborted) return { messages: [], stopReason: 'cancelled' };
    emit({ type: 'error', message: errorMessage(cause) });
    return { messages: [], stopReason: 'error' };
  }
}

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
  const user: ModelMessage = { role: 'user', content: userMessage };
  const phaseInput = [...history, user];
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

  const initial = await runPhase({
    model,
    ctx: trackedCtx,
    messages: phaseInput,
    system: systemPrompt({ version, job }),
    emit,
    signal,
  });
  const turnMessages: ModelMessage[] = [user, ...initial.messages];

  if (initial.stopReason !== 'end_turn' || !job || !shouldReview) {
    emit({ type: 'turn_end', stopReason: initial.stopReason });
    return { messages: turnMessages, stopReason: initial.stopReason };
  }

  const failReview = (cause: unknown): TurnResult => {
    if (signal?.aborted) {
      emit({ type: 'turn_end', stopReason: 'cancelled' });
      return { messages: turnMessages, stopReason: 'cancelled' };
    }
    emit({ type: 'error', message: `Resume review failed: ${errorMessage(cause)}` });
    emit({ type: 'text_delta', text: `\n\n${REVIEW_UNAVAILABLE}` });
    turnMessages.push(assistantText(REVIEW_UNAVAILABLE));
    emit({ type: 'turn_end', stopReason: 'error' });
    return { messages: turnMessages, stopReason: 'error' };
  };

  let interim: ScoredResumeEvaluation;
  try {
    const interimVersion = await ctx.currentVersion();
    interim = await evaluateResume({ model, version: interimVersion, job, signal });
    const report = formatResumeEvaluation('interim', interimVersion.id, interim);
    emit({ type: 'text_delta', text: `\n\n${report}` });
    turnMessages.push(assistantText(report));
  } catch (cause) {
    return failReview(cause);
  }

  const correctionVersion = await ctx.currentVersion();
  const correction = await runPhase({
    model,
    ctx,
    messages: [
      ...history,
      ...turnMessages,
      {
        role: 'user',
        content:
          'Apply the independent review now. Make only evidence-backed improvements, then stop.',
      },
    ],
    system: `${systemPrompt({ version: correctionVersion, job })}\n\n${reviewCorrectionContext(interim)}`,
    emit,
    signal,
  });
  turnMessages.push(...correction.messages);

  if (correction.stopReason !== 'end_turn') {
    emit({ type: 'turn_end', stopReason: correction.stopReason });
    return { messages: turnMessages, stopReason: correction.stopReason };
  }

  try {
    const finalVersion = await ctx.currentVersion();
    const final = await evaluateResume({ model, version: finalVersion, job, signal });
    const report = formatResumeEvaluation('final', finalVersion.id, final);
    emit({ type: 'text_delta', text: `\n\n${report}` });
    turnMessages.push(assistantText(report));
  } catch (cause) {
    return failReview(cause);
  }

  emit({ type: 'turn_end', stopReason: 'end_turn' });
  return { messages: turnMessages, stopReason: 'end_turn' };
}
