import { beforeAll, expect, test } from 'bun:test';
import { type ResumeTree, SyncTexMap } from '@sailor/core';
import { locateSource, parseSyncTex } from './synctex.ts';
import { compileWithTectonic, prewarm } from './tectonic.ts';

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

// One box on one page, written by hand: enough to exercise the wire format
// without paying for a compile.
const SYNTHETIC = `SyncTeX Version:1
Input:1:/tmp/scratch/resume.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,3:8799519,8865055:22609920,642672,183080
]
}1
`;

// Pay the CTAN download once, not inside a test that is timing a compile. Bun
// may run this file before latex.test.ts, so it cannot rely on that one's warm-up.
beforeAll(async () => {
  await prewarm();
}, 600_000);

/**
 * These tests shell out to the real Tectonic binary. Warm, each compile is ~2s;
 * the budget is deliberately far larger because the failure worth preventing is
 * a false red on a slow machine, not a slow compile worth catching.
 */
const COMPILE_TIMEOUT_MS = 120_000;

test(
  'a synctex compile carries the map; a plain one does not',
  async () => {
    const withMap = await compileWithTectonic(TREE, { synctex: true });
    const withoutMap = await compileWithTectonic(TREE);

    expect(withMap.ok).toBe(true);
    expect(withoutMap.ok).toBe(true);
    if (!withMap.ok || !withoutMap.ok) return;

    expect(typeof withMap.synctex).toBe('string');
    expect(withMap.synctex).toContain('SyncTeX Version:1');
    expect(withoutMap.synctex).toBeUndefined();
  },
  COMPILE_TIMEOUT_MS,
);

test(
  'the map names the source file and records the section lines',
  async () => {
    const result = await compileWithTectonic(TREE, { synctex: true });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.synctex) return;

    const map = parseSyncTex(result.synctex);

    // Exactly one input file, and it is ours.
    expect(map.files.some((f) => f.path.endsWith('resume.tex'))).toBe(true);
    expect(map.boxes.length).toBeGreaterThan(0);

    // Both section headings produced visible material and must appear as boxes.
    // (TeX folds a paragraph's body into the box for the line the paragraph
    // *starts* on, so the line-4 body text is attributed to line 3, not line 4 —
    // that is expected, and still lands a click in the right section.)
    const lines = new Set(map.boxes.map((b) => b.line));
    expect(lines.has(3)).toBe(true); // \section{Experience} + its body
    expect(lines.has(5)).toBe(true); // \section{Education} + its body
  },
  COMPILE_TIMEOUT_MS,
);

test(
  'a point inside the first section box resolves to its source line',
  async () => {
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
  },
  COMPILE_TIMEOUT_MS,
);

/**
 * The map is made on the server and hit-tested in the browser, so it has to
 * survive JSON and the schema at the far end. This is the test that fails if
 * someone puts a `Map` or a `Set` back into it — the shape would still typecheck
 * everywhere except the one place it matters.
 */
test('a parsed map survives the trip to a browser', () => {
  const map = parseSyncTex(SYNTHETIC);
  expect(map.boxes).toHaveLength(1);

  const arrived = SyncTexMap.parse(JSON.parse(JSON.stringify(map)));
  expect(arrived).toEqual(map);

  // And it is still answerable on the other side.
  const box = arrived.boxes[0];
  expect(box).toBeDefined();
  if (!box) return;
  const centre = (low: number, size: number) => ((low + size / 2) / 65536) * (72 / 72.27);
  expect(
    locateSource(arrived, {
      page: 1,
      x: centre(box.left, box.width),
      y: centre(box.top, box.height),
    }),
  ).toEqual({ file: '/tmp/scratch/resume.tex', line: 3 });
});

test('parseSyncTex tolerates junk without throwing', () => {
  const map = parseSyncTex('not\na\nreal\nsynctex\nfile');
  expect(map.boxes).toHaveLength(0);
  expect(map.files).toHaveLength(0);
});
