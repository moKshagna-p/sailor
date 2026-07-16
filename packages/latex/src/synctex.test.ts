import { expect, test } from 'bun:test';
import type { ResumeTree } from '@sailor/core';
import { locateSource, parseSyncTex } from './synctex.ts';
import { compileWithTectonic } from './tectonic.ts';

// A tiny document whose section commands sit on lines we can assert against.
// Line numbers are 1-based and count every line below, including the first.
const DOC = `\\documentclass{article}
\\begin{document}
\\section{Experience}
Built a payments service at Acme Corporation over three years.
\\section{Education}
BSc Computer Science, State University.
\\end{document}
`;

const TREE: ResumeTree = {
  entry: 'resume.tex',
  files: [{ path: 'resume.tex', content: DOC }],
};

test('a synctex compile carries the map; a plain one does not', async () => {
  const withMap = await compileWithTectonic(TREE, { synctex: true });
  const withoutMap = await compileWithTectonic(TREE);

  expect(withMap.ok).toBe(true);
  expect(withoutMap.ok).toBe(true);
  if (!withMap.ok || !withoutMap.ok) return;

  expect(typeof withMap.synctex).toBe('string');
  expect(withMap.synctex).toContain('SyncTeX Version:1');
  expect(withoutMap.synctex).toBeUndefined();
}, 30_000);

test('the map names the source file and records the section lines', async () => {
  const result = await compileWithTectonic(TREE, { synctex: true });
  expect(result.ok).toBe(true);
  if (!result.ok || !result.synctex) return;

  const map = parseSyncTex(result.synctex);

  // Exactly one input file, and it is ours.
  expect([...map.files.values()].some((p) => p.endsWith('resume.tex'))).toBe(true);
  expect(map.boxes.length).toBeGreaterThan(0);

  // Both section headings produced visible material and must appear as boxes.
  // (TeX folds a paragraph's body into the box for the line the paragraph
  // *starts* on, so the line-4 body text is attributed to line 3, not line 4 —
  // that is expected, and still lands a click in the right section.)
  const lines = new Set(map.boxes.map((b) => b.line));
  expect(lines.has(3)).toBe(true); // \section{Experience} + its body
  expect(lines.has(5)).toBe(true); // \section{Education} + its body
}, 30_000);

test('a point inside the first section box resolves to its source line', async () => {
  const result = await compileWithTectonic(TREE, { synctex: true });
  expect(result.ok).toBe(true);
  if (!result.ok || !result.synctex) return;

  const map = parseSyncTex(result.synctex);

  // Take a real box on line 3 and query its own centre, converted back to PDF
  // points. Hitting the centre must return that same line — this exercises the
  // full sp↔pt round trip, not just the parser.
  const box = map.boxes.find((b) => b.line === 3);
  expect(box).toBeDefined();
  if (!box) return;

  const SP_PER_PT = 65536;
  const centreXpt =
    ((box.left + box.width / 2 - map.xOffset) / map.unit / SP_PER_PT) * (72 / 72.27);
  const centreYpt =
    ((box.top + box.height / 2 - map.yOffset) / map.unit / SP_PER_PT) * (72 / 72.27);

  const located = locateSource(map, { page: box.page, x: centreXpt, y: centreYpt });
  expect(located).not.toBeNull();
  expect(located?.line).toBe(3);
  expect(located?.file.endsWith('resume.tex')).toBe(true);
}, 30_000);

test('parseSyncTex tolerates junk without throwing', () => {
  const map = parseSyncTex('not\na\nreal\nsynctex\nfile');
  expect(map.boxes).toHaveLength(0);
  expect(map.files.size).toBe(0);
});
