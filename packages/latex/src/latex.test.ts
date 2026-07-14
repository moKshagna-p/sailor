import { beforeAll, expect, test } from 'bun:test';
import { compileWithTectonic, prewarm } from './tectonic.ts';
import { STARTER_RESUME } from './template.ts';

// Pay the CTAN download once, not inside a test that is timing a compile.
beforeAll(async () => {
  await prewarm();
}, 300_000);

test('the starter resume compiles to a real PDF', async () => {
  const result = await compileWithTectonic(STARTER_RESUME);
  if (!result.ok) throw new Error(`Expected success, got:\n${result.log}`);

  // A PDF, not just non-empty bytes.
  expect(new TextDecoder().decode(result.pdf.slice(0, 5))).toBe('%PDF-');
  expect(result.pdf.byteLength).toBeGreaterThan(1000);
}, 60_000);

test('a broken document fails with a diagnostic the agent can act on', async () => {
  const result = await compileWithTectonic({
    entry: 'main.tex',
    files: [
      {
        path: 'main.tex',
        content: '\\documentclass{article}\\begin{document}\\thisIsNotACommand\\end{document}',
      },
    ],
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;

  // The whole point of the diagnostics parser: the model must be able to read
  // this and fix its own edit. A bare "compile failed" is useless to it.
  const messages = result.diagnostics.map((d) => d.message).join(' ');
  expect(messages).toContain('Undefined control sequence');
  expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
}, 60_000);

test('path traversal in a resume file is refused', async () => {
  // The Zod schema blocks this at the boundary, but the compiler must not rely
  // on that — it is the thing actually writing bytes to disk.
  const attempt = compileWithTectonic({
    entry: 'main.tex',
    files: [
      {
        path: 'main.tex',
        content: '\\documentclass{article}\\begin{document}x\\end{document}',
      },
      { path: '../../../../tmp/sailor-pwned.tex', content: 'pwned' },
    ],
  });
  await expect(attempt).rejects.toThrow(/outside the scratch dir/);
}, 30_000);
