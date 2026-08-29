import { expect, test } from 'bun:test';
import { latexFolderToResumeTree } from '../apps/web/lib/resume-import.ts';

function pickedFile(content: BlobPart[], name: string, relativePath: string, type?: string): File {
  const file = new File(content, name, type ? { type } : undefined);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

test('folder import preserves nested source paths and binary assets', async () => {
  const tree = await latexFolderToResumeTree([
    pickedFile(
      [
        String.raw`\documentclass{article}\input{sections/body}\includegraphics{images/leetcode.png}`,
      ],
      'main.tex',
      'resume/main.tex',
    ),
    pickedFile(['body'], 'body.tex', 'resume/sections/body.tex'),
    pickedFile([new Uint8Array([1, 2, 3])], 'leetcode.png', 'resume/images/leetcode.png'),
  ]);

  expect(tree.entry).toBe('main.tex');
  expect(tree.files).toContainEqual({ path: 'sections/body.tex', content: 'body' });
  expect(tree.files).toContainEqual({
    path: 'images/leetcode.png',
    content: 'AQID',
    encoding: 'base64',
  });
});

test('folder import prefers root main.tex over another document', async () => {
  const tree = await latexFolderToResumeTree([
    pickedFile([String.raw`\documentclass{article}`], 'letter.tex', 'resume/letter.tex'),
    pickedFile([String.raw`\documentclass{article}`], 'main.tex', 'resume/main.tex'),
  ]);

  expect(tree.entry).toBe('main.tex');
});

test('folder import uses the sole document root when it is not main.tex', async () => {
  const tree = await latexFolderToResumeTree([
    pickedFile([String.raw`\documentclass{article}`], 'cv.tex', 'resume/cv.tex'),
    pickedFile(['fragment'], 'body.tex', 'resume/body.tex'),
  ]);

  expect(tree.entry).toBe('cv.tex');
});

test('folder import rejects a project without a document root', async () => {
  await expect(
    latexFolderToResumeTree([
      pickedFile(['just a fragment'], 'fragment.tex', 'resume/fragment.tex'),
    ]),
  ).rejects.toThrow('No .tex file');
});

test('folder import lists ambiguous document roots', async () => {
  await expect(
    latexFolderToResumeTree([
      pickedFile([String.raw`\documentclass{article}`], 'cv.tex', 'resume/cv.tex'),
      pickedFile([String.raw`\documentclass{article}`], 'letter.tex', 'resume/letter.tex'),
    ]),
  ).rejects.toThrow('cv.tex, letter.tex');
});

test('folder import rejects duplicate and unsafe project paths', async () => {
  await expect(
    latexFolderToResumeTree([
      pickedFile([String.raw`\documentclass{article}`], 'main.tex', 'resume/main.tex'),
      pickedFile(['duplicate'], 'main.tex', 'resume/main.tex'),
    ]),
  ).rejects.toThrow('duplicate project paths');

  await expect(
    latexFolderToResumeTree([
      pickedFile([String.raw`\documentclass{article}`], 'main.tex', 'resume/../main.tex'),
    ]),
  ).rejects.toThrow('Unsafe project path: resume/../main.tex');
});

test('folder import requires one selected directory', async () => {
  await expect(
    latexFolderToResumeTree([
      pickedFile([String.raw`\documentclass{article}`], 'main.tex', 'one/main.tex'),
      pickedFile(['body'], 'body.tex', 'two/body.tex'),
    ]),
  ).rejects.toThrow('one folder');

  await expect(latexFolderToResumeTree([new File(['x'], 'main.tex')])).rejects.toThrow(
    'folder, not individual files',
  );
});
