# Resume Document Import Design

## Goal

Let a user create an editable Sailor resume in one of three ways:

1. start from Sailor's built-in template;
2. paste or upload LaTeX source; or
3. upload a PDF or DOCX and convert it to compiling LaTeX while preserving its
   visible layout as closely as practical.

The import must never invent, rewrite, or omit resume text. A conversion that
cannot produce compiling LaTeX is rejected and creates no resume.

## Current behavior and root cause

The home page currently offers the starter template and a multi-file LaTeX
upload. It has no paste-LaTeX control, despite the intended product flow. The
authoritative Tectonic path and starter template compile successfully; the
missing and fragile behavior is at the home-page import boundary, not in the
compiler itself.

The existing LaTeX upload also reads every selected file as UTF-8 text. That is
correct for `.tex`, `.cls`, `.sty`, and `.bib`, but cannot carry PDF/DOCX input
or images used by an imported layout.

## Product behavior

The home page presents three equal creation choices:

- **Start from template** creates the existing starter resume.
- **Paste LaTeX** opens a compact dialog with a source textarea. Sailor requires
  a `\documentclass`, submits the source as `main.tex`, and displays the
  server's compile diagnostics without creating a broken resume.
- **Upload resume** accepts one `.pdf` or `.docx`, or a set of LaTeX source and
  asset files. The button reports extraction, conversion, and compile progress.

PDF and DOCX imports create editable, positioned LaTeX. The first rendered PDF
should look close to the original; subsequent edits remain normal immutable
Sailor versions. The UI labels the conversion as best-effort and tells the user
to review it before tailoring.

Image-only or password-protected PDFs are rejected with actionable errors.
Malformed, encrypted, or unsupported DOCX files are rejected. A failed import
resets the file input so the same file can be selected again.

## Conversion architecture

Conversion runs in the browser. This keeps untrusted office documents away from
the API process, reuses the installed PDF.js runtime, and avoids adding Pandoc or
LibreOffice as production server dependencies.

Both formats produce the same small intermediate layout model:

```ts
type PositionedRun = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: 'serif' | 'sans' | 'mono';
  bold: boolean;
  italic: boolean;
  color: string;
};

type PositionedPage = {
  width: number;
  height: number;
  backgroundPng: string;
  runs: PositionedRun[];
};
```

Coordinates and dimensions are PDF points. `backgroundPng` is base64 without a
data-URL prefix.

### PDF

PDF.js supplies page dimensions and text items with transforms, widths, heights,
and font identities. Sailor renders each page to a canvas, masks the text-run
rectangles using the sampled local background color, and retains the remaining
rules, icons, shading, and images as a PNG background. The extracted text runs
are then placed over that background by LaTeX.

This preserves source text verbatim and keeps it editable. Font substitution,
unusual text transforms, and text baked into an image are best-effort. If PDF.js
finds no selectable text, Sailor rejects the file rather than performing OCR or
guessing.

### DOCX

`docx-preview` renders the document into an off-screen, isolated container with
embedded HTML chunks and change markup disabled. Sailor reads page boxes, text
node rectangles, and computed font styles from that rendered result. Each page
is captured to canvas, its editable text rectangles are masked, and the same
positioned layout model is emitted.

DOCX conversion adds `docx-preview` and one DOM-to-canvas package to the web app.
No new server binary or conversion service is introduced.

### LaTeX generation

A pure `layoutToResumeTree()` function creates:

- `main.tex`, using `geometry`, `graphicx`, and `textpos` for fixed page geometry;
- one base64-encoded PNG background per page; and
- one clearly delimited source line per editable text run.

All LaTeX metacharacters are escaped by one shared function. The generator maps
fonts only to serif, sans, and mono families available to Tectonic. It never
generates or changes words.

## Binary resume assets

`ResumeFile` gains an optional `encoding: 'base64'`. Missing encoding continues
to mean UTF-8, so every existing resume and test fixture remains valid. The
compiler decodes base64 assets before writing them into its scratch directory.
Canonical hashing includes the encoding field, preserving content-addressed
version semantics.

The core schema rejects unsupported encodings and bounds individual and total
tree size. The editor only opens UTF-8 source files; binary backgrounds remain
part of the immutable tree and are preserved across edits.

## Data flow

```text
file/pasted source
  -> browser validation
  -> PDF.js or docx-preview extraction (document uploads only)
  -> positioned layout
  -> ResumeTree
  -> existing POST /api/resumes
  -> ResumeTree Zod parse
  -> authoritative Tectonic compile
  -> immutable initial version, only on success
```

No new database table, provider call, or model prompt is required.

## Errors and safety

- Accept only the advertised file extensions and MIME types.
- Limit PDF/DOCX source files to 10 MB and the generated tree to the core schema
  limit.
- Disable DOCX altChunk rendering so embedded HTML is never interpreted.
- Do not log document content or generated LaTeX.
- Preserve the existing traversal checks when writing binary assets.
- Return server compile diagnostics unchanged through the existing safe API
  error shape.
- Create no database row until conversion and compilation both succeed.

## Testing

Development follows red-green-refactor.

- Core tests prove base64 files parse, hash distinctly, and reject invalid or
  oversized content.
- Compiler tests prove a base64 PNG asset is decoded and included in a real PDF.
- Pure generator tests prove page geometry, run placement, font/style mapping,
  and complete LaTeX escaping using literal expected output.
- PDF adapter tests use a small real fixture or a complete PDF.js-shaped loader
  double and prove page positions and unchanged text.
- DOCX adapter tests cover validation and the DOM-to-layout boundary; the actual
  browser flow is exercised with a real DOCX.
- Homepage tests cover the three choices and error/progress state where the
  current test setup can exercise behavior without mocking framework internals.

Before completion, run `bun run check`, `bun run typecheck`, and `bun test`, then
drive all three creation paths in the browser with a real compiling LaTeX sample,
a text-based PDF, and a DOCX. Compare the first imported render with each source
and report any fidelity gap honestly.

## Deliberate limits

- No OCR in this version. Add it only when image-only resumes are a demonstrated
  need and can be implemented without inventing text.
- No AI reconstruction. It would improve some layouts but conflicts with the
  requirement that import never alter resume facts.
- Imported fixed-position layouts can overlap after large text edits. The user
  can ask the agent to reflow the document later; automatic semantic reflow is a
  separate feature.
- Word features outside the browser renderer's supported layout remain
  best-effort rather than triggering a second conversion stack.
