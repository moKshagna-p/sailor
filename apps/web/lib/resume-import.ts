import { ResumeTree, type ResumeTree as ResumeTreeType } from '@sailor/core';

const TEXT_EXTENSIONS = new Set(['tex', 'cls', 'sty', 'bib', 'bst']);

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function projectPath(file: File, root: string): string {
  const prefix = `${root}/`;
  if (!file.webkitRelativePath.startsWith(prefix)) {
    throw new Error('All files must come from one folder.');
  }

  const relative = file.webkitRelativePath.slice(prefix.length);
  const segments = relative.split('/');
  if (
    relative.startsWith('/') ||
    relative.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe project path: ${file.webkitRelativePath || file.name}`);
  }
  return segments.join('/');
}

export async function latexFolderToResumeTree(files: File[]): Promise<ResumeTreeType> {
  const firstPath = files[0]?.webkitRelativePath ?? '';
  const root = firstPath.split('/')[0];
  if (!root || !firstPath.includes('/')) {
    throw new Error('Choose a folder, not individual files.');
  }

  const parts = await Promise.all(
    files.map(async (file) => {
      const path = projectPath(file, root);
      const extension = path.split('.').pop()?.toLowerCase() ?? '';
      return TEXT_EXTENSIONS.has(extension)
        ? { path, content: await file.text() }
        : { path, content: await fileToBase64(file), encoding: 'base64' as const };
    }),
  );

  if (new Set(parts.map((file) => file.path)).size !== parts.length) {
    throw new Error('The selected folder contains duplicate project paths.');
  }

  const roots = parts
    .filter(
      (file) =>
        file.path.toLowerCase().endsWith('.tex') && file.content.includes('\\documentclass'),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const main = roots.find((file) => file.path.toLowerCase() === 'main.tex');
  const entry = main?.path ?? (roots.length === 1 ? roots[0]?.path : undefined);

  if (!entry) {
    throw new Error(
      roots.length === 0
        ? 'No .tex file in that folder contains a \\documentclass.'
        : `Several .tex files contain a \\documentclass: ${roots.map((file) => file.path).join(', ')}`,
    );
  }

  return ResumeTree.parse({ entry, files: parts });
}
