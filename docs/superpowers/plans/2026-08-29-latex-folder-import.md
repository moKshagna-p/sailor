# LaTeX Folder Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PDF/DOCX resume reconstruction with a native folder picker that preserves a complete LaTeX project's paths and assets.

**Architecture:** The browser converts directory-picker `File` values directly into the existing immutable `ResumeTree`. The existing API validates and compiles that tree with Tectonic before persistence; no route, table, service, or dependency is added.

**Tech Stack:** Bun, TypeScript, Next.js 16, React 19, Zod, Tectonic, Bun test, Biome.

**Spec:** `docs/superpowers/specs/2026-08-29-resume-document-import-design.md`

## Global Constraints

- Use Bun only and preserve every path beneath the selected folder.
- Keep compile-before-save, immutable versions, and Tectonic `--untrusted`.
- Keep `ResumeFile.encoding: 'base64'` for binary project assets.
- Reject unsafe, duplicate, missing, and ambiguous roots instead of guessing.
- Do not add `any`, non-null assertions, `@ts-expect-error`, or silent catches.

---

### Task 1: Convert a picked folder into a safe `ResumeTree`

**Files:**
- Modify: `tests/resume-import.test.ts`
- Modify: `apps/web/lib/resume-import.ts`

**Interfaces:**
- Consumes: `File[]` with `webkitRelativePath` values shaped as `<folder>/<project path>`.
- Produces: `latexFolderToResumeTree(files: File[]): Promise<ResumeTree>`.

- [ ] **Step 1: Replace positioned-document tests with failing folder tests**

Use real `File` instances with picker paths attached via `Object.defineProperty`:

```ts
function pickedFile(content: BlobPart[], name: string, relativePath: string): File {
  const file = new File(content, name);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

test('folder import preserves nested paths and binary assets', async () => {
  const tree = await latexFolderToResumeTree([
    pickedFile([String.raw`\documentclass{article}`], 'main.tex', 'resume/main.tex'),
    pickedFile([new Uint8Array([1, 2, 3])], 'leetcode.png', 'resume/images/leetcode.png'),
  ]);
  expect(tree.entry).toBe('main.tex');
  expect(tree.files).toContainEqual({
    path: 'images/leetcode.png', content: 'AQID', encoding: 'base64',
  });
});
```

Add literal cases proving `main.tex` wins over another root, a sole non-main root is selected, and imports reject missing `\documentclass`, several non-main roots, duplicate paths, traversal, and inconsistent top-level directories.

- [ ] **Step 2: Run `bun test tests/resume-import.test.ts` and verify RED**

Expected: FAIL because `latexFolderToResumeTree` is not exported.

- [ ] **Step 3: Implement the minimum folder converter**

Keep the existing chunked base64 helper. Replace PDF/DOCX classification and positioned-layout generation with path-prefix removal, known text extensions (`tex`, `cls`, `sty`, `bib`, `bst`), binary base64 encoding, duplicate detection, and deterministic root selection. Parse the result through `ResumeTree.parse()` before returning.

The root-selection branch is exactly:

```ts
const roots = parts.filter((file) =>
  file.path.toLowerCase().endsWith('.tex') && file.content.includes('\\documentclass'),
);
const main = roots.find((file) => file.path.toLowerCase() === 'main.tex');
const entry = main?.path ?? (roots.length === 1 ? roots[0]?.path : undefined);
```

Reject no entry and ambiguous entries with messages that list candidate paths.

- [ ] **Step 4: Run focused verification**

```bash
bun test tests/resume-import.test.ts packages/db/src/db.test.ts packages/latex/src/latex.test.ts
bun run --filter @sailor/web typecheck
```

Expected: all selected tests and web typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/resume-import.ts tests/resume-import.test.ts
git commit -m "feat(web): preserve latex folder projects"
```

### Task 2: Replace document upload UI and delete reconstruction code

**Files:**
- Modify: `apps/web/app/page.tsx`
- Delete: `apps/web/lib/pdf-resume.ts`
- Delete: `apps/web/lib/docx-resume.ts`
- Delete: `tests/pdf-resume.test.ts`
- Delete: `tests/docx-resume.test.ts`
- Modify: `apps/web/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `latexFolderToResumeTree(files: File[]): Promise<ResumeTree>`.
- Produces: **Upload LaTeX folder** through existing `api.createResume(title, tree)`.

- [ ] **Step 1: Make the home page consume only folder projects**

Remove PDF/DOCX imports and classification. In `onUpload`, report `Reading LaTeX folder…`, call `latexFolderToResumeTree(files)`, and derive the title from the first `webkitRelativePath` segment.

Change the card copy to `Upload LaTeX folder` and `Source, styles, and assets`. Change the hidden input to a multiple file input with the `webkitdirectory` attribute. If React's types omit that attribute, use a narrow local input-props intersection; do not use `any` or a global declaration.

Replace the best-effort conversion note with: `Choose the complete project folder so image, style, and bibliography paths still resolve.` Preserve busy, error, and `aria-live` behavior.

- [ ] **Step 2: Delete PDF/DOCX code and dependencies**

Delete both adapters and their tests, then run:

```bash
bun remove --cwd apps/web docx-preview html-to-image
```

Keep `pdfjs-dist`, `apps/web/lib/pdf-text.ts`, and PDF preview code because job-description import and preview still use them.

- [ ] **Step 3: Run focused verification**

```bash
bun test tests/resume-import.test.ts
bun run --filter @sailor/web typecheck
bun run check
```

Expected: all commands exit 0 without warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/page.tsx apps/web/lib/pdf-resume.ts apps/web/lib/docx-resume.ts tests/pdf-resume.test.ts tests/docx-resume.test.ts apps/web/package.json bun.lock
git commit -m "feat(web): import complete latex folders"
```

### Task 3: Verify compile-before-save with a real folder

**Files:**
- Modify only files required by failures caused by Tasks 1-2.

**Interfaces:**
- Consumes: the folder picker and existing API/compiler flow.
- Produces: verified template, paste, and folder creation behavior.

- [ ] **Step 1: Run the repository definition of done in order**

```bash
bun run check:fix
bun run check
bun run typecheck
bun test
```

Expected: zero warnings, type errors, and test failures.

- [ ] **Step 2: Drive the real browser flow**

Run the API and web app. Upload a folder with `main.tex`, `sections/body.tex`, and `images/leetcode.png`; the root must input the nested source and include the image. Confirm creation, server PDF display, and all paths after reload.

Upload a copy without the image. Confirm the UI shows the server diagnostic and no resume row is created. Also create one resume from the template and one from pasted LaTeX.

- [ ] **Step 3: Inspect final state**

```bash
git diff --check
git status --short
git diff main...HEAD --stat
```

Do not commit runtime data, generated PDFs, environment files, or caches.
