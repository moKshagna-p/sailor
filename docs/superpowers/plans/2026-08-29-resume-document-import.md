# Resume Document Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable pasted-LaTeX, PDF, and DOCX resume creation while preserving imported text exactly and reproducing the original page layout as editable LaTeX.

**Architecture:** Browser adapters turn PDF.js pages or a `docx-preview` DOM into one positioned-page model. A pure generator converts that model into a `ResumeTree`; the existing API parses it and Tectonic compiles it before the database creates the immutable root version. Base64 PNG backgrounds preserve non-text visual details without adding a server conversion binary.

**Tech Stack:** Bun, TypeScript, Next.js 16/React 19, Zod, PDF.js, `docx-preview`, `html-to-image`, Tectonic, Bun test, Biome.

**Spec:** `docs/superpowers/specs/2026-08-29-resume-document-import-design.md`

## Global Constraints

- Use Bun only; never add npm/yarn/pnpm lockfiles.
- Never invent, rewrite, or omit resume text.
- Every import creates one immutable initial version only after authoritative compilation succeeds.
- Keep provider SDKs, Drizzle, and raw SQL out of the web app.
- Parse every API payload with the existing `@sailor/core` Zod schemas.
- Do not add `any`, non-null assertions, `@ts-expect-error`, or silent catches.
- Keep PDF/DOCX source uploads at or below 10 MB.
- No OCR, AI reconstruction, Pandoc, LibreOffice, or server-side office parser.

---

### Task 1: Carry binary layout assets through immutable resume trees

**Files:**
- Modify: `packages/core/src/resume.ts:8-24`
- Modify: `packages/latex/src/tectonic.ts:57-66`
- Modify: `packages/agent/src/tools/resume.ts:20-52`
- Test: `packages/db/src/db.test.ts`
- Test: `packages/latex/src/latex.test.ts`
- Test: `packages/agent/src/tools/tools.test.ts`

**Interfaces:**
- Produces: `ResumeFile.encoding?: 'base64'`; missing means UTF-8.
- Produces: compiler decoding for base64 files.
- Produces: model-legible refusal when `read_resume` or `edit_resume` targets a binary asset.

- [ ] **Step 1: Write failing core/hash and agent tests**

Add a DB/core-facing assertion that these trees hash differently and invalid encodings fail parsing:

```ts
const plain = { entry: 'main.tex', files: [{ path: 'main.tex', content: 'x' }] };
const binary = {
  entry: 'main.tex',
  files: [
    { path: 'main.tex', content: 'x' },
    { path: 'page.png', content: 'aGVsbG8=', encoding: 'base64' as const },
  ],
};
expect(await hashTree(plain)).not.toBe(await hashTree(binary));
expect(() => ResumeTree.parse({
  entry: 'main.tex',
  files: [{ path: 'main.tex', content: 'x', encoding: 'hex' }],
})).toThrow();
```

Add a tool test that calls `read_resume` for `page.png` and expects `{ ok: false }` with a binary-asset hint. This catches accidental base64 disclosure to the model.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun test packages/db/src/db.test.ts packages/agent/src/tools/tools.test.ts
```

Expected: FAIL because `encoding` is not accepted and binary files are returned as text.

- [ ] **Step 3: Add the schema and tool guards**

In `packages/core/src/resume.ts`, keep old rows valid and bound stored content:

```ts
export const MAX_RESUME_TREE_CHARS = 25 * 1024 * 1024;

export const ResumeFile = z.object({
  path: /* existing guarded path */,
  content: z.string().max(15 * 1024 * 1024),
  encoding: z.literal('base64').optional(),
});

export const ResumeTree = z
  .object({ entry: z.string().min(1), files: z.array(ResumeFile).min(1).max(50) })
  .refine(
    (tree) => tree.files.reduce((size, file) => size + file.content.length, 0) <= MAX_RESUME_TREE_CHARS,
    'resume file tree is too large',
  );
```

In both `read_resume` and `edit_resume`, return `err('... is a binary asset', 'Edit main.tex instead.')` when `file.encoding === 'base64'`.

- [ ] **Step 4: Write the failing real-compiler binary test**

Add a 1×1 literal PNG fixture as base64 to `packages/latex/src/latex.test.ts`; compile a document containing `\includegraphics{dot.png}` and assert the result starts with `%PDF-`.

- [ ] **Step 5: Run the compiler test and verify RED**

Run:

```bash
bun test packages/latex/src/latex.test.ts
```

Expected: FAIL because Tectonic receives base64 text instead of PNG bytes.

- [ ] **Step 6: Decode assets in the compiler**

Change the scratch write to:

```ts
const bytes = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content;
await Bun.write(Bun.file(target), bytes);
```

Do not change path traversal checks or compilation flags.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
bun test packages/db/src/db.test.ts packages/agent/src/tools/tools.test.ts packages/latex/src/latex.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/core/src/resume.ts packages/latex/src/tectonic.ts packages/latex/src/latex.test.ts packages/agent/src/tools/resume.ts packages/agent/src/tools/tools.test.ts packages/db/src/db.test.ts
git commit -m "feat(resume): support binary layout assets"
```

### Task 2: Generate compiling positioned LaTeX without changing text

**Files:**
- Create: `apps/web/lib/resume-import.ts`
- Create: `tests/resume-import.test.ts`

**Interfaces:**
- Produces: `PositionedRun`, `PositionedPage`.
- Produces: `escapeLatex(text: string): string`.
- Produces: `layoutToResumeTree(pages: PositionedPage[]): ResumeTree`.
- Produces: `latexFilesToResumeTree(files: File[]): Promise<ResumeTree>`.

- [ ] **Step 1: Write failing pure generator tests**

Use literal expected fragments, not generator-built expectations:

```ts
test('layoutToResumeTree preserves text while escaping LaTeX and carrying page art', () => {
  const tree = layoutToResumeTree([{
    width: 612,
    height: 792,
    backgroundPng: 'iVBORw0KGgo=',
    runs: [{
      text: 'R&D_50% #1 {Go} \\ $5 ~ ^', x: 36, y: 42, width: 220, height: 14,
      fontSize: 11, fontFamily: 'sans', bold: true, italic: false, color: '112233',
    }],
  }]);

  expect(tree.entry).toBe('main.tex');
  expect(tree.files[1]).toEqual({
    path: 'page-1.png', content: 'iVBORw0KGgo=', encoding: 'base64',
  });
  expect(tree.files[0]?.content).toContain('R\&D\_50\% \#1 \{Go\} \\textbackslash{} \$5 \\textasciitilde{} \\textasciicircum{}');
  expect(tree.files[0]?.content).toContain('\\begin{textblock*}{220pt}(36pt,42pt)');
});
```

Add tests that reject zero pages, empty extracted text, mixed PDF/DOCX selections, and LaTeX uploads without a `.tex` entry containing `\documentclass`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test tests/resume-import.test.ts
```

Expected: FAIL because `apps/web/lib/resume-import.ts` does not exist.

- [ ] **Step 3: Implement the smallest pure model and generator**

Implement only the approved fields. `layoutToResumeTree` must:

1. reject no pages or no non-whitespace run text;
2. use page 1 dimensions for `geometry`;
3. include `graphicx`, `textpos`, and `xcolor`;
4. put each page PNG at `(0pt,0pt)`;
5. put one escaped text run per source line with serif/sans/mono, bold, italic, font size, and six-digit color;
6. insert `\newpage` between pages; and
7. return the main source plus base64 PNG files.

Implement `latexFilesToResumeTree` with `File.text()` for `.tex/.cls/.sty/.bib` and base64 for image/PDF assets. Select the `.tex` containing `\documentclass`; throw the existing actionable message when absent.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
bun test tests/resume-import.test.ts
bun run --filter @sailor/web typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web/lib/resume-import.ts tests/resume-import.test.ts
git commit -m "feat(web): generate positioned resume latex"
```

### Task 3: Convert selectable PDFs into positioned pages

**Files:**
- Create: `apps/web/lib/pdf-resume.ts`
- Create: `tests/pdf-resume.test.ts`

**Interfaces:**
- Consumes: `PositionedPage` and `PositionedRun` from `resume-import.ts`.
- Produces: `pdfToPositionedPages(file: File, loader?: PdfLoader): Promise<PositionedPage[]>`.

- [ ] **Step 1: Write a failing PDF adapter test**

Use a complete loader double with a 612×792 viewport, one real-shaped text item, a font style, and a render task. Assert literal layout values and unchanged text:

```ts
expect(pages[0]?.runs[0]).toMatchObject({
  text: 'Senior R&D Engineer',
  x: 36,
  y: 730,
  width: 120,
  height: 12,
  fontSize: 12,
  fontFamily: 'sans',
});
```

Also assert non-PDF, >10 MB, password-protected, and no-selectable-text errors.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test tests/pdf-resume.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement PDF.js extraction and page masking**

Load `pdfjs-dist/legacy/build/pdf.mjs` lazily with the existing worker URL pattern. For every page:

- get a scale-1 viewport and text content;
- narrow unknown items by checking `str`, `transform`, `width`, `height`, and `fontName`;
- derive top-left coordinates from the PDF bottom-left transform;
- infer serif/sans/mono and bold/italic from PDF.js style/font names;
- render at 2× into a canvas;
- cover each editable text rectangle with its nearby sampled background color; and
- export the masked canvas as base64 PNG.

Set `isEvalSupported: false` when loading the PDF. Keep the injected loader narrow enough for the Bun test; do not mock PDF.js globally.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
bun test tests/pdf-resume.test.ts tests/pdf-text.test.ts
bun run --filter @sailor/web typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web/lib/pdf-resume.ts tests/pdf-resume.test.ts
git commit -m "feat(web): convert pdf resumes to positioned pages"
```

### Task 4: Convert DOCX layout into the shared positioned model

**Files:**
- Modify: `apps/web/package.json`
- Modify: `bun.lock`
- Create: `apps/web/lib/docx-resume.ts`
- Create: `tests/docx-resume.test.ts`

**Interfaces:**
- Consumes: `PositionedPage` and `PositionedRun` from `resume-import.ts`.
- Produces: `docxToPositionedPages(file: File, dependencies?: DocxDependencies): Promise<PositionedPage[]>`.

- [ ] **Step 1: Add only the two approved browser dependencies**

Run:

```bash
bun add --cwd apps/web docx-preview html-to-image
```

Expected: only `apps/web/package.json` and `bun.lock` change.

- [ ] **Step 2: Write the failing DOM-boundary tests**

Keep the extraction logic callable with plain structural objects so Bun does not need jsdom. Test `styleToRun()` and `rectToPoints()` with literal rectangles/styles, plus file validation through injected `render` and `capture` functions. Assert exact text, 96px→72pt conversion, font family/style/color, and these errors: wrong type, >10 MB, malformed renderer result, and no text.

- [ ] **Step 3: Run the test and verify RED**

Run:

```bash
bun test tests/docx-resume.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement the browser adapter**

Use dynamic imports for `docx-preview` and `html-to-image`. Append one off-screen container, call `renderAsync` with:

```ts
{
  breakPages: true,
  ignoreLastRenderedPageBreak: false,
  useBase64URL: true,
  renderAltChunks: false,
  renderChanges: false,
  experimental: true,
}
```

For each `section.docx`, collect leaf text-bearing spans, their rectangles, and computed styles. Capture the page with `toCanvas(..., { pixelRatio: 2, backgroundColor: '#fff' })`, mask the run rectangles, and emit the shared model. Remove the container in `finally`; a cleanup failure must not hide an import error.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
bun test tests/docx-resume.test.ts
bun run --filter @sailor/web typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web/package.json bun.lock apps/web/lib/docx-resume.ts tests/docx-resume.test.ts
git commit -m "feat(web): convert docx resumes to positioned pages"
```

### Task 5: Replace the fragile home import controls with three working paths

**Files:**
- Modify: `apps/web/app/page.tsx:10-116`
- Create: `apps/web/components/paste-latex-dialog.tsx`
- Test: `tests/resume-import.test.ts`

**Interfaces:**
- Consumes: `layoutToResumeTree`, `latexFilesToResumeTree`, `pdfToPositionedPages`, and `docxToPositionedPages`.
- Produces: template, paste, and file-upload creation paths through existing `api.createResume()`.

- [ ] **Step 1: Add failing classification tests**

Add a pure exported `classifyResumeUpload(files: File[]): 'pdf' | 'docx' | 'latex'` test table:

```ts
[
  [[new File(['x'], 'resume.pdf')], 'pdf'],
  [[new File(['x'], 'resume.docx')], 'docx'],
  [[new File(['x'], 'main.tex')], 'latex'],
]
```

Assert that PDF/DOCX mixed with any second file throws, while multi-file LaTeX remains allowed.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test tests/resume-import.test.ts
```

Expected: FAIL because classification is not implemented.

- [ ] **Step 3: Implement classification and the paste dialog**

The dialog is a native `<dialog>`-style fixed overlay with an associated `textarea`, Cancel, and Compile & create buttons. It validates `\documentclass` before calling `onSubmit(source)`, closes only on success, returns focus to the trigger, and closes on Escape.

- [ ] **Step 4: Wire the home page**

Replace the two-button row with three responsive cards/buttons:

- Start from template → existing `create()`;
- Paste LaTeX → dialog → `{ entry: 'main.tex', files: [{ path: 'main.tex', content: source }] }`;
- Upload resume → classify → PDF/DOCX adapter + generator, or LaTeX tree reader.

Use one `status: string | null` for `Reading PDF…`, `Reading Word document…`, and `Compiling…`. Clear the file input in `finally`. Derive titles from the uploaded filename without its extension. Keep server diagnostics in the existing error region and add `aria-live="polite"` to status/error output.

- [ ] **Step 5: Verify the web path and commit**

Run:

```bash
bun test tests/resume-import.test.ts tests/pdf-resume.test.ts tests/docx-resume.test.ts
bun run --filter @sailor/web typecheck
bun run check
```

Expected: PASS with zero warnings.

Commit:

```bash
git add apps/web/app/page.tsx apps/web/components/paste-latex-dialog.tsx apps/web/lib/resume-import.ts tests/resume-import.test.ts
git commit -m "feat(web): add resume creation choices"
```

### Task 6: Full verification and real-flow fidelity check

**Files:**
- Modify only files required by failures directly caused by Tasks 1-5.

**Interfaces:**
- Verifies the complete user-visible feature; produces no new API.

- [ ] **Step 1: Run required automated verification in order**

Run:

```bash
bun run check
bun run typecheck
bun test
```

Expected: all pass with zero warnings/errors/failures. If Biome changes files, inspect the diff and rerun all three commands.

- [ ] **Step 2: Drive the actual application**

Start Postgres, API, and web with the repository's Bun scripts. In the browser:

1. Start from template and confirm the workbench shows a PDF.
2. Paste a minimal compiling article and confirm its exact text appears.
3. Paste broken LaTeX and confirm no resume is created and diagnostics are visible.
4. Upload a real text-based resume PDF and compare text and page layout.
5. Upload a real DOCX and compare text and page layout.
6. Edit one imported run, save it, reload, and confirm the background assets survive.

Record any source file used for manual verification outside git unless it is an intentionally small, non-PII test fixture.

- [ ] **Step 3: Inspect branch state and commit only necessary fixes**

Run:

```bash
git status --short
git diff --check
git log --oneline main..HEAD
```

If verification required a focused fix, commit it with a lowercase conventional subject under 70 characters. Do not create an empty cleanup commit.
