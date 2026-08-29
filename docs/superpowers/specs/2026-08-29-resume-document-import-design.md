# LaTeX Resume Folder Import Design

## Goal

Let a user create a Sailor resume from either pasted LaTeX or a complete LaTeX
project folder. A folder import preserves the source tree and its local assets so
the authoritative server compiler sees the same relative paths that the project
expects.

PDF and DOCX resume reconstruction is removed. Those formats are rendered
outputs, not reliable editable sources, and converting them back to positioned
LaTeX produces fragile resumes.

## Product behavior

The home page offers three creation paths:

1. **Start from template** creates the existing starter resume.
2. **Paste LaTeX** submits one `main.tex` file through the existing compile-first
   creation flow.
3. **Upload LaTeX folder** opens the browser's native directory picker and
   imports the selected project with its relative directory structure intact.

The folder picker replaces the PDF/DOCX/loose-file upload. Its copy explains
that the folder must contain the resume's `.tex`, `.cls`, `.sty`, bibliography,
images, fonts, and other local compile inputs.

## Entry-file selection

Sailor selects the compile entry without guessing:

1. use `main.tex` when it contains `\documentclass`;
2. otherwise use the sole `.tex` file containing `\documentclass`;
3. if none exists, reject the import with an actionable error; and
4. if several candidates exist, reject the import and list their relative paths.

An entry-file chooser is deliberately omitted. Real resume projects normally
have one root document, and an explicit error is smaller and safer than adding
picker state for an ambiguous project.

## Project-tree conversion

The browser receives `File` objects from `<input type="file" webkitdirectory>`.
For every file, it removes the picker-only top-level folder prefix from
`webkitRelativePath` while preserving everything beneath it. For example:

```text
my-resume/main.tex             -> main.tex
my-resume/images/leetcode.png  -> images/leetcode.png
my-resume/styles/resume.cls    -> styles/resume.cls
```

Known LaTeX source files are stored as UTF-8. Other files are stored as base64
assets using the existing optional `ResumeFile.encoding` field. The existing
core schema remains the trust boundary for path, file-count, per-file, and total
tree-size limits.

Picker metadata must not be trusted. Import rejects empty paths, absolute paths,
path traversal, duplicate normalized paths, and folders whose files do not share
one top-level picker directory. No file is silently renamed or flattened.

## Compile and persistence flow

```text
folder picker
  -> preserve and validate relative paths
  -> choose the root .tex file
  -> ResumeTree
  -> existing POST /api/resumes
  -> ResumeTree Zod parse
  -> authoritative Tectonic compile of the full scratch-directory tree
  -> immutable initial version only on success
```

This is Overleaf-like only in the relevant sense: Sailor compiles a root TeX
file with all uploaded project files available at their original relative paths.
It does not add collaboration, cloud package management, shell escape, or an
Overleaf-compatible project API. Tectonic remains sandboxed with `--untrusted`.

The existing compiler already writes every `ResumeTree` file into one temporary
directory before invoking Tectonic. Binary decoding remains necessary for local
images and other assets. No database schema change or new service is needed.

## Errors

Conversion errors are shown before upload and create nothing. Compile errors
continue through the existing server response, including the compile-before-save
guarantee:

```text
That LaTeX does not compile, so it was not saved:
error at <unknown>: Unable to load picture or PDF file 'leetcode.png'.
```

Because the whole tree is uploaded, a correctly referenced local asset compiles.
If the TeX refers to a file that is not in the chosen folder, the diagnostic is
still the correct result and tells the user what must be added or fixed.

Errors must remain actionable for an empty folder, missing root document,
ambiguous root documents, unsafe or duplicate paths, unsupported tree size, and
server compilation failure. Resume contents and compiler input are not logged.

## Removal

Delete the PDF and DOCX resume adapters, positioned-layout generator, their
tests, and the `docx-preview` and `html-to-image` dependencies. Keep PDF.js and
the existing PDF text extractor because they are still used for job-description
PDF import and resume preview.

Keep the binary `ResumeFile` support and compiler decoding already added on this
branch; folder projects need them for images and other non-text inputs.

## Testing and verification

Development follows red-green-refactor.

- Pure importer tests cover prefix removal, nested paths, UTF-8 source, base64
  assets, deterministic entry selection, duplicate paths, traversal, and entry
  ambiguity.
- Existing core and compiler tests continue proving binary assets are validated,
  hashed, decoded, and compiled.
- The home-page flow is exercised with a real folder containing `main.tex`, a
  nested include, and `images/leetcode.png`.
- Removing `leetcode.png` must reproduce the actionable compile failure and must
  not create a resume.
- Before completion, run `bun run check`, `bun run typecheck`, and `bun test`,
  then drive template, pasted-source, and folder creation in the browser.

## Deliberate limits

- No PDF, DOCX, OCR, or AI reconstruction.
- No ZIP upload until browser folder selection proves insufficient in real use.
- No entry-file chooser until ambiguous multi-document folders are common.
- No full project file browser in the editor; the existing source editor and
  agent tools continue to operate on the imported immutable tree.
