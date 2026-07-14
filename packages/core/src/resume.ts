import { z } from 'zod';

/**
 * A resume is a set of LaTeX files (main.tex plus any .cls/.sty/assets the user
 * uploaded). We keep the whole tree because real templates — Awesome-CV,
 * moderncv, RenderCV — are never a single file.
 */
export const ResumeFile = z.object({
  path: z
    .string()
    .min(1)
    .max(200)
    // Traversal guard: these paths are written to a scratch dir before compiling.
    .refine((p) => !p.includes('..') && !p.startsWith('/'), 'path must be relative and not escape'),
  content: z.string(),
});
export type ResumeFile = z.infer<typeof ResumeFile>;

export const ResumeTree = z.object({
  /** Which file is the compile root. Must exist in `files`. */
  entry: z.string().min(1),
  files: z.array(ResumeFile).min(1).max(50),
});
export type ResumeTree = z.infer<typeof ResumeTree>;

export function getFile(tree: ResumeTree, path: string): ResumeFile | undefined {
  return tree.files.find((f) => f.path === path);
}

export function getEntryFile(tree: ResumeTree): ResumeFile {
  const entry = getFile(tree, tree.entry);
  if (!entry) throw new Error(`Resume entry "${tree.entry}" is not present in the file tree`);
  return entry;
}

/** Immutable snapshot. Every agent edit creates one of these; nothing mutates. */
export const ResumeVersion = z.object({
  id: z.string(),
  resumeId: z.string(),
  /** sha256 of the canonicalised tree. Identical content ⇒ identical hash. */
  contentHash: z.string(),
  tree: ResumeTree,
  /** Human-readable reason this version exists, written by whoever created it. */
  summary: z.string(),
  createdBy: z.enum(['user', 'agent']),
  parentId: z.string().nullable(),
  createdAt: z.date(),
});
export type ResumeVersion = z.infer<typeof ResumeVersion>;

/** Canonical serialisation — sorted paths, so hashing is order-independent. */
export function canonicalise(tree: ResumeTree): string {
  const files = [...tree.files].sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify({ entry: tree.entry, files });
}

export async function hashTree(tree: ResumeTree): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalise(tree));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
