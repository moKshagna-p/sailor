import type { ResumeTree } from '@sailor/core';
import { err, errorMessage, ok, summariseDiagnostics } from '@sailor/core';
import { compileWithTectonic } from '@sailor/latex';
import { tool } from 'ai';
import { z } from 'zod';
import { unifiedDiff } from '../diff.ts';
import type { ToolContext } from './context.ts';

export function resumeTools(ctx: ToolContext) {
  return {
    read_resume: tool({
      description:
        'Read the current LaTeX source of the resume. Always read before editing — ' +
        'the user may have changed the file since your last look.',
      inputSchema: z.object({
        path: z.string().optional().describe('Which file to read. Omit for the main entry file.'),
      }),
      async execute({ path }) {
        const version = await ctx.currentVersion();
        const target = path ?? version.tree.entry;
        const file = version.tree.files.find((f) => f.path === target);

        if (!file) {
          return err(
            `No file at "${target}"`,
            `Files in this resume: ${version.tree.files.map((f) => f.path).join(', ')}`,
          );
        }

        return ok({
          path: file.path,
          content: file.content,
          allFiles: version.tree.files.map((f) => f.path),
        });
      },
    }),

    edit_resume: tool({
      description:
        'Replace an exact snippet of LaTeX with new text. This is the ONLY way to change ' +
        'the resume. `oldText` must appear EXACTLY ONCE in the file — include surrounding ' +
        'lines to disambiguate if needed. The edit is compiled before it is saved: if it ' +
        'breaks the build, it is rolled back and you get the LaTeX errors to fix.',
      inputSchema: z.object({
        path: z.string().optional().describe('File to edit. Omit for the main entry file.'),
        oldText: z.string().min(1).describe('Exact text to replace. Must be unique in the file.'),
        newText: z.string().describe('Replacement text. Empty string deletes the snippet.'),
        summary: z
          .string()
          .min(1)
          .describe('One line, for the version history. e.g. "Reframed API bullet for Stripe JD"'),
      }),
      async execute({ path, oldText, newText, summary }) {
        const version = await ctx.currentVersion();
        const target = path ?? version.tree.entry;
        const file = version.tree.files.find((f) => f.path === target);

        if (!file) {
          return err(
            `No file at "${target}"`,
            `Files in this resume: ${version.tree.files.map((f) => f.path).join(', ')}`,
          );
        }

        // Exactly-once matching. A replace-all here would silently rewrite every
        // similar bullet in the resume, which is exactly the kind of quiet damage
        // the user would not notice until an interview.
        const occurrences = file.content.split(oldText).length - 1;
        if (occurrences === 0) {
          return err(
            `\`oldText\` does not appear in ${target}.`,
            'It must match the file byte-for-byte, including whitespace and backslashes. ' +
              'Re-read the file and copy the snippet exactly.',
          );
        }
        if (occurrences > 1) {
          return err(
            `\`oldText\` appears ${occurrences} times in ${target}; it must be unique.`,
            'Include more surrounding context (the line above and below) to pin down which ' +
              'occurrence you mean.',
          );
        }

        const updated = file.content.replace(oldText, newText);
        const diff = unifiedDiff(target, file.content, updated);

        const approved = await ctx.requestPermission({
          toolName: 'edit_resume',
          title: summary,
          diff,
        });
        if (!approved) {
          return err(
            'The user rejected this edit.',
            'Do not retry the same edit. Ask what they would prefer instead.',
          );
        }

        const nextTree: ResumeTree = {
          entry: version.tree.entry,
          files: version.tree.files.map((f) =>
            f.path === target ? { ...f, content: updated } : f,
          ),
        };

        // Invariant 3: never commit a resume that does not build.
        const compiled = await compileWithTectonic(nextTree);
        if (!compiled.ok) {
          return err(
            `That edit broke the LaTeX build, so it was NOT saved.\n\n${summariseDiagnostics(
              compiled.diagnostics,
            )}`,
            'Fix the LaTeX and call edit_resume again. Common causes: an unescaped %, &, _, ' +
              '# or $; a \\begin without a matching \\end; a command the document class does ' +
              'not define.',
          );
        }

        try {
          const { versionId, unchanged } = await ctx.commit({
            tree: nextTree,
            summary,
            parentId: version.id,
          });

          if (unchanged) {
            return ok({
              versionId,
              note: 'That edit produced no change — the new text was identical to the old.',
            });
          }

          return ok({
            versionId,
            diff,
            compiledIn: `${compiled.durationMs}ms`,
            note: 'Saved and compiled cleanly.',
          });
        } catch (cause) {
          return err(`Failed to save the edit: ${errorMessage(cause)}`);
        }
      },
    }),

    compile_resume: tool({
      description:
        'Compile the resume as it currently stands and report any LaTeX errors or warnings. ' +
        'Use this to check your work — it changes nothing.',
      inputSchema: z.object({}),
      async execute() {
        const version = await ctx.currentVersion();
        const result = await compileWithTectonic(version.tree);

        if (!result.ok) {
          return err(
            `The resume does not currently compile.\n\n${summariseDiagnostics(result.diagnostics)}`,
            'Read the file and fix the reported line.',
          );
        }

        return ok({
          compiledIn: `${result.durationMs}ms`,
          sizeBytes: result.pdf.byteLength,
          warnings: result.diagnostics.filter((d) => d.severity === 'warning').length,
        });
      },
    }),
  };
}
