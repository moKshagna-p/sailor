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
  /**
   * Raw SyncTeX map (decompressed text), present only when a compile was asked
   * for it. It ties PDF coordinates back to source line numbers — the basis for
   * "click a spot in the preview, land on the LaTeX that produced it". Absent on
   * the WASM engine, which cannot emit it.
   */
  synctex?: string;
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

/** One box of typeset material, and the source line that produced it. */
export const SyncTexBox = z.object({
  page: z.number().int().positive(),
  tag: z.number().int(),
  line: z.number().int().positive(),
  /** All in scaled points, PDF-style: origin top-left, y grows downward. */
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
});
export type SyncTexBox = z.infer<typeof SyncTexBox>;

/**
 * A single typeset glyph or kern, and the line it came from. These are what make
 * a click land on the right line: TeX tags a paragraph's box with the line it was
 * *broken* on, which for a bullet is the line after the `\item`, while the glyphs
 * inside that box still carry the line that actually typeset them.
 */
export const SyncTexPoint = z.object({
  page: z.number().int().positive(),
  tag: z.number().int(),
  line: z.number().int().positive(),
  /** Scaled points, PDF-style: origin top-left. */
  x: z.number(),
  y: z.number(),
});
export type SyncTexPoint = z.infer<typeof SyncTexPoint>;

/**
 * A parsed SyncTeX map. The server produces it; the browser hit-tests clicks
 * against it, so it lives here — it crosses a process boundary.
 *
 * `files` is an array of tag/path pairs rather than a map keyed by tag because
 * this travels as JSON. A document has one or two input files, so looking a tag
 * up linearly costs nothing, and the alternative — a serialise/deserialise pair
 * around a `Map<number, string>` — is two more places to drift.
 */
export const SyncTexMap = z.object({
  files: z.array(z.object({ tag: z.number().int(), path: z.string() })),
  boxes: z.array(SyncTexBox),
  points: z.array(SyncTexPoint),
  /** Scaled-points-per-unit multiplier, and the offsets added to every coordinate. */
  unit: z.number(),
  xOffset: z.number(),
  yOffset: z.number(),
});
export type SyncTexMap = z.infer<typeof SyncTexMap>;

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
