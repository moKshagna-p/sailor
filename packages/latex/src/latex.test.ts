import { beforeAll, expect, test } from 'bun:test';
import { compileWithTectonic, prewarm, tectonicStatus } from './tectonic.ts';
import { STARTER_RESUME } from './template.ts';

// Pay the CTAN download once, not inside a test that is timing a compile.
beforeAll(async () => {
  await prewarm();
}, 600_000);

test('the starter resume compiles to a real PDF', async () => {
  const result = await compileWithTectonic(STARTER_RESUME);
  if (!result.ok) throw new Error(`Expected success, got:\n${result.log}`);

  // A PDF, not just non-empty bytes.
  expect(new TextDecoder().decode(result.pdf.slice(0, 5))).toBe('%PDF-');
  expect(result.pdf.byteLength).toBeGreaterThan(1000);
}, 60_000);

test('a resume using a standard LaTeX package compiles', async () => {
  const result = await compileWithTectonic({
    entry: 'main.tex',
    files: [
      {
        path: 'main.tex',
        content: '\\documentclass{article}\\usepackage{latexsym}\\begin{document}ok\\end{document}',
      },
    ],
  });

  if (!result.ok) throw new Error(`Expected success, got:\n${result.log}`);
  expect(new TextDecoder().decode(result.pdf.slice(0, 5))).toBe('%PDF-');
}, 60_000);

test('a base64 layout asset is decoded before Tectonic reads it', async () => {
  const result = await compileWithTectonic({
    entry: 'main.tex',
    files: [
      {
        path: 'main.tex',
        content:
          '\\documentclass{article}\\usepackage{graphicx}\\begin{document}\\includegraphics{dot.png}\\end{document}',
      },
      {
        path: 'dot.png',
        content:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        encoding: 'base64',
      },
    ],
  });

  if (!result.ok) throw new Error(`Expected success, got:\n${result.log}`);
  expect(new TextDecoder().decode(result.pdf.slice(0, 5))).toBe('%PDF-');
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

test('abort cancels queued and running compiles and releases every permit', async () => {
  const uniqueTree = (label: string) => ({
    entry: 'main.tex',
    files: [
      {
        path: 'main.tex',
        content: `${STARTER_RESUME.files[0]?.content ?? ''}\n% cancellation-${label}-${crypto.randomUUID()}`,
      },
    ],
  });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 2_000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error('Timed out waiting for compiler state');
      await Bun.sleep(10);
    }
  };

  const firstController = new AbortController();
  const secondController = new AbortController();
  const queuedController = new AbortController();
  const first = compileWithTectonic(uniqueTree('first'), { signal: firstController.signal });
  const second = compileWithTectonic(uniqueTree('second'), { signal: secondController.signal });

  await waitFor(() => tectonicStatus().activeCompiles === 2);
  const queued = compileWithTectonic(uniqueTree('queued'), { signal: queuedController.signal });
  await waitFor(() => tectonicStatus().queueDepth === 1);

  queuedController.abort();
  await expect(queued).rejects.toHaveProperty('name', 'AbortError');
  expect(tectonicStatus().queueDepth).toBe(0);

  const abortedAt = performance.now();
  firstController.abort();
  secondController.abort();
  await expect(Promise.all([first, second])).rejects.toHaveProperty('name', 'AbortError');
  expect(performance.now() - abortedAt).toBeLessThan(2_000);
  expect(tectonicStatus().activeCompiles).toBe(0);

  const followUp = await compileWithTectonic(uniqueTree('follow-up'));
  expect(followUp.ok).toBe(true);
}, 30_000);

test('canonical-equivalent requests reuse matching cached artifacts', async () => {
  const marker = crypto.randomUUID();
  const main = {
    path: 'main.tex',
    content: `\\documentclass{article}\\begin{document}${marker}\\end{document}`,
  };
  const note = { path: 'note.txt', content: marker };
  const tree = { entry: 'main.tex', files: [main, note] };
  const runsBefore = tectonicStatus().compilerRuns;

  const first = await compileWithTectonic(tree);
  const runsAfterFirst = tectonicStatus().compilerRuns;
  const reordered = await compileWithTectonic({ ...tree, files: [note, main] });

  expect(first.ok).toBe(true);
  expect(reordered.ok).toBe(true);
  expect(runsAfterFirst).toBe(runsBefore + 1);
  expect(tectonicStatus().compilerRuns).toBe(runsAfterFirst);
  if (!first.ok || !reordered.ok) return;
  expect(reordered.pdf).toEqual(first.pdf);
  expect(first.synctex).toBeUndefined();

  const withSyncTex = await compileWithTectonic(tree, { synctex: true });
  const runsAfterSyncTex = tectonicStatus().compilerRuns;
  const cachedWithSyncTex = await compileWithTectonic(tree, { synctex: true });
  expect(runsAfterSyncTex).toBe(runsAfterFirst + 1);
  expect(tectonicStatus().compilerRuns).toBe(runsAfterSyncTex);
  expect(withSyncTex.ok).toBe(true);
  expect(cachedWithSyncTex.ok).toBe(true);
  if (!withSyncTex.ok || !cachedWithSyncTex.ok) return;
  expect(withSyncTex.synctex).toBeDefined();
  expect(cachedWithSyncTex.synctex).toBe(withSyncTex.synctex);
  expect(cachedWithSyncTex.pdf).toEqual(withSyncTex.pdf);
}, 30_000);

test('single-flight keeps compiling for a live subscriber when its peer aborts', async () => {
  const marker = crypto.randomUUID();
  const tree = {
    entry: 'main.tex',
    files: [
      {
        path: 'main.tex',
        content: `\\documentclass{article}\\begin{document}${marker}\\end{document}`,
      },
    ],
  };
  const controller = new AbortController();
  const runsBefore = tectonicStatus().compilerRuns;
  const aborted = compileWithTectonic(tree, { signal: controller.signal });
  const survivor = compileWithTectonic(tree);

  await Bun.sleep(100);
  controller.abort();

  await expect(aborted).rejects.toHaveProperty('name', 'AbortError');
  expect((await survivor).ok).toBe(true);
  expect(tectonicStatus().compilerRuns).toBe(runsBefore + 1);
}, 30_000);
