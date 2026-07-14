import { errorMessage } from '@sailor/core';
import type { LanguageModel, ModelMessage } from 'ai';
import { stepCountIs, streamText } from 'ai';
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

  const result = streamText({
    model,
    system: systemPrompt({ version, job }),
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
  } catch (cause) {
    if (signal?.aborted) {
      emit({ type: 'turn_end', stopReason: 'cancelled' });
      return { messages: [], stopReason: 'cancelled' };
    }
    const message = errorMessage(cause);
    emit({ type: 'error', message });
    emit({ type: 'turn_end', stopReason: 'error' });
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

  emit({ type: 'turn_end', stopReason });

  const response = await result.response;
  return {
    // The user message plus everything the model produced, so the next turn
    // replays exactly what happened.
    messages: [{ role: 'user', content: userMessage }, ...response.messages],
    stopReason,
  };
}
