import { expect, test } from 'bun:test';
import {
  classifyResumeUpload,
  escapeLatex,
  latexFilesToResumeTree,
  layoutToResumeTree,
} from '../apps/web/lib/resume-import.ts';

test('resume uploads distinguish documents from multi-file LaTeX projects', () => {
  expect(classifyResumeUpload([new File(['x'], 'resume.pdf')])).toBe('pdf');
  expect(classifyResumeUpload([new File(['x'], 'resume.docx')])).toBe('docx');
  expect(classifyResumeUpload([new File(['x'], 'main.tex')])).toBe('latex');
  expect(classifyResumeUpload([new File(['x'], 'main.tex'), new File(['x'], 'resume.cls')])).toBe(
    'latex',
  );
  expect(() =>
    classifyResumeUpload([new File(['x'], 'resume.pdf'), new File(['x'], 'extra.tex')]),
  ).toThrow('one PDF or DOCX');
});

test('positioned LaTeX preserves and escapes source text while carrying page art', () => {
  const tree = layoutToResumeTree([
    {
      width: 612,
      height: 792,
      backgroundPng: 'iVBORw0KGgo=',
      runs: [
        {
          text: String.raw`R&D_50% #1 {Go} \ $5 ~ ^`,
          x: 36,
          y: 42,
          width: 220,
          height: 14,
          fontSize: 11,
          fontFamily: 'sans',
          bold: true,
          italic: false,
          color: '112233',
        },
      ],
    },
  ]);

  expect(tree.entry).toBe('main.tex');
  expect(tree.files[1]).toEqual({
    path: 'page-1.png',
    content: 'iVBORw0KGgo=',
    encoding: 'base64',
  });
  expect(tree.files[0]?.content).toContain(
    String.raw`R\&D\_50\% \#1 \{Go\} \textbackslash{} \$5 \textasciitilde{} \textasciicircum{}`,
  );
  expect(tree.files[0]?.content).toContain(String.raw`\begin{textblock*}{220pt}(36pt,42pt)`);
  expect(tree.files[0]?.content).toContain(
    String.raw`\fontsize{11pt}{14pt}\selectfont\sffamily\bfseries\color[HTML]{112233}`,
  );
});

test('LaTeX escaping covers every syntax character without changing words', () => {
  expect(escapeLatex(String.raw`a&b_c%d#e$f{g}h\i~j^k`)).toBe(
    String.raw`a\&b\_c\%d\#e\$f\{g\}h\textbackslash{}i\textasciitilde{}j\textasciicircum{}k`,
  );
});

test('positioned imports require a page and selectable text', () => {
  expect(() => layoutToResumeTree([])).toThrow('no pages');
  expect(() =>
    layoutToResumeTree([{ width: 612, height: 792, backgroundPng: 'png', runs: [] }]),
  ).toThrow('no selectable text');
});

test('LaTeX uploads choose the document root and preserve binary assets', async () => {
  const tree = await latexFilesToResumeTree([
    new File(['helper'], 'preamble.tex', { type: 'text/plain' }),
    new File([String.raw`\documentclass{article}\begin{document}Hi\end{document}`], 'cv.tex'),
    new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
  ]);

  expect(tree.entry).toBe('cv.tex');
  expect(tree.files).toContainEqual({ path: 'photo.png', content: 'AQID', encoding: 'base64' });
  expect(tree.files.find((file) => file.path === 'cv.tex')?.encoding).toBeUndefined();
});

test('LaTeX uploads reject source without a document class', async () => {
  await expect(
    latexFilesToResumeTree([new File(['just a fragment'], 'fragment.tex')]),
  ).rejects.toThrow('contain a \\documentclass');
});
