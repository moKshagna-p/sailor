import type { ResumeTree } from '@sailor/core';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type PositionedRun = {
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

export type PositionedPage = {
  width: number;
  height: number;
  backgroundPng: string;
  runs: PositionedRun[];
};

const LATEX_ESCAPES: Readonly<Record<string, string>> = {
  '\\': String.raw`\textbackslash{}`,
  '&': String.raw`\&`,
  '%': String.raw`\%`,
  $: String.raw`\$`,
  '#': String.raw`\#`,
  _: String.raw`\_`,
  '{': String.raw`\{`,
  '}': String.raw`\}`,
  '~': String.raw`\textasciitilde{}`,
  '^': String.raw`\textasciicircum{}`,
  '\n': String.raw`\\`,
};

export function escapeLatex(text: string): string {
  return Array.from(text, (character) => LATEX_ESCAPES[character] ?? character).join('');
}

function points(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Imported layout contains an invalid coordinate.');
  return `${Number(value.toFixed(2))}pt`;
}

function color(value: string): string {
  const hex = value.replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : '000000';
}

function runSource(run: PositionedRun): string {
  if (run.width <= 0 || run.height <= 0 || run.fontSize <= 0) {
    throw new Error('Imported layout contains an invalid text box.');
  }

  const family =
    run.fontFamily === 'sans'
      ? String.raw`\sffamily`
      : run.fontFamily === 'mono'
        ? String.raw`\ttfamily`
        : String.raw`\rmfamily`;
  const weight = run.bold ? String.raw`\bfseries` : '';
  const shape = run.italic ? String.raw`\itshape` : '';

  return String.raw`\begin{textblock*}{${points(run.width)}}(${points(run.x)},${points(run.y)})
{\fontsize{${points(run.fontSize)}}{${points(run.height)}}\selectfont${family}${weight}${shape}\color[HTML]{${color(run.color)}} ${escapeLatex(run.text)}}
\end{textblock*}`;
}

export function layoutToResumeTree(pages: PositionedPage[]): ResumeTree {
  const first = pages[0];
  if (!first) throw new Error('The imported document has no pages.');
  if (!pages.some((page) => page.runs.some((run) => run.text.trim().length > 0))) {
    throw new Error('The imported document has no selectable text.');
  }
  if (first.width <= 0 || first.height <= 0) {
    throw new Error('The imported document has invalid page dimensions.');
  }

  const pageSource = pages
    .map((page, index) => {
      const pageNumber = index + 1;
      return String.raw`% --- imported page ${pageNumber} ---
\thispagestyle{empty}
\begin{textblock*}{${points(first.width)}}(0pt,0pt)
\includegraphics[width=${points(first.width)},height=${points(first.height)}]{page-${pageNumber}.png}
\end{textblock*}
${page.runs
  .filter((run) => run.text.length > 0)
  .map(runSource)
  .join('\n')}
\mbox{}
${pageNumber < pages.length ? String.raw`\newpage` : ''}`;
    })
    .join('\n');

  const content = String.raw`\documentclass{article}
\usepackage[paperwidth=${points(first.width)},paperheight=${points(first.height)},margin=0pt]{geometry}
\usepackage{graphicx}
\usepackage[absolute,overlay]{textpos}
\usepackage{xcolor}
\setlength{\TPHorizModule}{1pt}
\setlength{\TPVertModule}{1pt}
\setlength{\parindent}{0pt}
\pagestyle{empty}
\begin{document}
${pageSource}
\end{document}
`;

  return {
    entry: 'main.tex',
    files: [
      { path: 'main.tex', content },
      ...pages.map((page, index) => ({
        path: `page-${index + 1}.png`,
        content: page.backgroundPng,
        encoding: 'base64' as const,
      })),
    ],
  };
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

const TEXT_EXTENSIONS = new Set(['tex', 'cls', 'sty', 'bib']);

export async function latexFilesToResumeTree(files: File[]): Promise<ResumeTree> {
  const parts = await Promise.all(
    files.map(async (file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      return TEXT_EXTENSIONS.has(extension)
        ? { path: file.name, content: await file.text() }
        : { path: file.name, content: await fileToBase64(file), encoding: 'base64' as const };
    }),
  );
  const entry = parts.find(
    (file) => file.path.toLowerCase().endsWith('.tex') && file.content.includes('\\documentclass'),
  )?.path;

  if (!entry) {
    throw new Error(
      'None of those files contain a \\documentclass — I cannot tell which one to compile.',
    );
  }

  return { entry, files: parts };
}
