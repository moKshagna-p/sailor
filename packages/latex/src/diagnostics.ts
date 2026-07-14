import type { LatexDiagnostic } from '@sailor/core';

/**
 * TeX error output is a 1978 format and it shows. The two shapes that matter:
 *
 *   ! Undefined control sequence.
 *   l.42 \foobar
 *
 *   ./main.tex:42: LaTeX Error: File `nonexistent.sty' not found.
 *
 * We parse both. Anything we cannot parse is still surfaced via the raw log —
 * a diagnostic we drop is a diagnostic the agent cannot fix.
 */
/**
 * The file group is deliberately narrow — it must look like a TeX source path.
 * A looser `[^:]+:(\d+):` also matches Tectonic's own download chatter
 * ("...01 Jan 2027 00:00:00 GMT [JAW]"), which produced confident nonsense
 * diagnostics pointing at an HTTP timestamp. Ask for a real path or nothing.
 */
const GNU_STYLE = /^(?<file>[^\s:]+\.(?:tex|sty|cls|ltx|bib|def)):(?<line>\d+):\s*(?<message>.+)$/;
const TEX_ERROR = /^!\s*(?<message>.+)$/;
const LINE_HINT = /^l\.(?<line>\d+)/;
const WARNING = /^(?:LaTeX|Package|Class)\s+(?:\w+\s+)?Warning:\s*(?<message>.+)$/;

export function parseLatexLog(log: string): LatexDiagnostic[] {
  const diagnostics: LatexDiagnostic[] = [];
  const lines = log.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const gnu = GNU_STYLE.exec(line);
    if (gnu?.groups) {
      const { file, line: lineNo, message } = gnu.groups;
      // Filter the noise: a bare "12: " with no real message is a page number.
      if (message && message.length > 3) {
        diagnostics.push({
          severity: /error/i.test(message) ? 'error' : 'warning',
          file: file ?? null,
          line: lineNo ? Number(lineNo) : null,
          message: message.trim(),
        });
      }
      continue;
    }

    const texError = TEX_ERROR.exec(line);
    if (texError?.groups?.message) {
      // TeX prints the offending line a few lines below the `!`, as `l.<n>`.
      let lineNo: number | null = null;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const hint = LINE_HINT.exec(lines[j] ?? '');
        if (hint?.groups?.line) {
          lineNo = Number(hint.groups.line);
          break;
        }
      }
      diagnostics.push({
        severity: 'error',
        file: null,
        line: lineNo,
        message: texError.groups.message.trim(),
      });
      continue;
    }

    const warning = WARNING.exec(line);
    if (warning?.groups?.message) {
      diagnostics.push({
        severity: 'warning',
        file: null,
        line: null,
        message: warning.groups.message.trim(),
      });
    }
  }

  return dedupe(diagnostics);
}

/** TeX repeats itself across passes; the same error 3x helps nobody. */
function dedupe(diagnostics: LatexDiagnostic[]): LatexDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
