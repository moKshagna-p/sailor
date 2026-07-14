import { z } from 'zod';

export const LatexDiagnostic = z.object({
  severity: z.enum(['error', 'warning']),
  file: z.string().nullable(),
  line: z.number().nullable(),
  message: z.string(),
});
export type LatexDiagnostic = z.infer<typeof LatexDiagnostic>;

export type CompileOk = {
  ok: true;
  /** Raw PDF bytes. Not serialised to JSON — routes stream it or base64 it explicitly. */
  pdf: Uint8Array;
  diagnostics: LatexDiagnostic[];
  durationMs: number;
  engine: 'tectonic' | 'wasm';
};

export type CompileErr = {
  ok: false;
  /** Diagnostics are the useful part — the agent reads these to fix its own edit. */
  diagnostics: LatexDiagnostic[];
  /** Tail of the raw engine log, for when the parser misses something. */
  log: string;
  durationMs: number;
  engine: 'tectonic' | 'wasm';
};

export type CompileResult = CompileOk | CompileErr;

/** Collapse diagnostics into something short enough to hand back to a model. */
export function summariseDiagnostics(diagnostics: LatexDiagnostic[], limit = 5): string {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const shown = (errors.length > 0 ? errors : diagnostics).slice(0, limit);
  if (shown.length === 0) return 'No diagnostics were emitted.';
  return shown
    .map((d) => {
      const where = d.file ? `${d.file}${d.line === null ? '' : `:${d.line}`}` : '<unknown>';
      return `${d.severity} at ${where}: ${d.message}`;
    })
    .join('\n');
}
