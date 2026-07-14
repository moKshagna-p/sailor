import { err, errorMessage, GapAnalysis, ok } from '@sailor/core';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './context.ts';

export function interactTools(ctx: ToolContext) {
  return {
    /**
     * The load-bearing tool for invariant 1. The model's strongest instinct when
     * a bullet lacks a number is to supply a plausible one. This gives that
     * instinct somewhere legitimate to go.
     */
    ask_user: tool({
      description:
        'Ask the user a question and wait for their answer. USE THIS whenever a bullet would ' +
        'be stronger with a fact you do not have — a metric, a scale, a team size, a ' +
        'technology. NEVER guess such a fact. Ask one specific question at a time; ' +
        '"How many users did that serve?" is useful, "Tell me more about your experience" ' +
        'is not.',
      inputSchema: z.object({
        question: z.string().min(3).describe('One specific question, in plain language.'),
        why: z
          .string()
          .describe(
            'One line on what you will do with the answer, so the user knows why it matters.',
          ),
      }),
      async execute({ question, why }) {
        try {
          const answer = await ctx.askUser(`${question}\n\n_${why}_`);
          if (!answer.trim()) {
            return ok({
              answer: '',
              note:
                'The user did not answer. Do NOT invent a value. Leave the bullet without the ' +
                'number, or rewrite it to be strong without one.',
            });
          }
          return ok({ answer });
        } catch (cause) {
          return err(errorMessage(cause), 'Continue without the fact. Do not fabricate it.');
        }
      },
    }),

    record_gap_analysis: tool({
      description:
        'Record how the resume currently measures up against the job description. Call this ' +
        'BEFORE making edits — it is the plan you and the user agree on, and it is shown to ' +
        'them in the UI. Cite verbatim resume text as evidence; if the resume does not ' +
        'support a requirement, mark it missing and say so.',
      inputSchema: z.object({
        matches: z
          .array(
            z.object({
              requirement: z
                .string()
                .describe('A single requirement, quoted or closely paraphrased from the JD.'),
              evidence: z
                .array(z.string())
                .describe('Verbatim snippets from the resume that support it. Empty if none.'),
              status: z.enum(['strong', 'weak', 'missing']),
              askUser: z
                .string()
                .nullable()
                .describe(
                  'If the user might have this but has not written it down, the question to ask them. ' +
                    'Otherwise null. This never becomes an invented bullet.',
                ),
            }),
          )
          .min(1),
        coverage: z
          .number()
          .min(0)
          .max(100)
          .describe('Rough share of requirements the resume already supports.'),
        notes: z
          .string()
          .describe('The one thing that would most improve this resume for this role.'),
      }),
      async execute(input) {
        const parsed = GapAnalysis.safeParse(input);
        if (!parsed.success) {
          return err(
            `Gap analysis was malformed: ${parsed.error.message}`,
            'Check the shape and call again.',
          );
        }

        ctx.emitGapAnalysis(parsed.data);

        const missing = parsed.data.matches.filter((m) => m.status === 'missing').length;
        return ok({
          recorded: parsed.data.matches.length,
          coverage: parsed.data.coverage,
          note:
            missing > 0
              ? `${missing} requirement(s) have no support in the resume. For each, either ask_user ` +
                `for a real fact, or leave it alone. Do not write a bullet you cannot source.`
              : 'The resume supports every requirement. Focus on sharpening wording and ordering.',
        });
      },
    }),
  };
}
