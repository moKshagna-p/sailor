import { expect, test } from 'bun:test';
import type { GapAnalysis, ResumeTree, ResumeVersion } from '@sailor/core';
import type { ToolContext } from './context.ts';
import { buildTools, isGated } from './index.ts';
import { assertPublicUrl } from './research.ts';

const BODY = String.raw`\documentclass{article}
\begin{document}
\section{Experience}
\begin{itemize}
  \item Improved checkout performance.
  \item Wrote tests.
\end{itemize}
\end{document}`;

type Harness = {
  ctx: ToolContext;
  commits: Array<{ tree: ResumeTree; summary: string }>;
  permissionPrompts: Array<{ title: string; diff?: string }>;
  setApproval(value: boolean): void;
  currentContent(): string;
};

function harness(): Harness {
  let content = BODY;
  let approve = true;
  const commits: Harness['commits'] = [];
  const permissionPrompts: Harness['permissionPrompts'] = [];

  const ctx: ToolContext = {
    userId: 'u1',
    sessionId: 's1',
    resumeId: 'r1',
    async currentVersion(): Promise<ResumeVersion> {
      return {
        id: 'v1',
        resumeId: 'r1',
        contentHash: 'hash',
        tree: { entry: 'main.tex', files: [{ path: 'main.tex', content }] },
        summary: 'test',
        createdBy: 'user',
        parentId: null,
        createdAt: new Date(),
      };
    },
    async jobTarget() {
      return null;
    },
    async requestPermission(request) {
      permissionPrompts.push({ title: request.title, diff: request.diff });
      return approve;
    },
    async askUser() {
      return '';
    },
    emitGapAnalysis(_: GapAnalysis) {},
    async commit({ tree, summary }) {
      commits.push({ tree, summary });
      const file = tree.files.find((f) => f.path === 'main.tex');
      if (file) content = file.content;
      return { versionId: 'v2', unchanged: false };
    },
  };

  return {
    ctx,
    commits,
    permissionPrompts,
    setApproval: (v) => {
      approve = v;
    },
    currentContent: () => content,
  };
}

// The AI SDK hands execute() a second options arg we never read.
const OPTS = { toolCallId: 'call_1', messages: [] } as never;

test('edit_resume asks permission, shows a diff, and commits on approval', async () => {
  const h = harness();
  const tools = buildTools(h.ctx);

  const result = await tools.edit_resume.execute?.(
    {
      oldText: '\\item Improved checkout performance.',
      newText: '\\item Cut checkout latency by moving session state to Redis.',
      summary: 'Sharpen checkout bullet',
    },
    OPTS,
  );

  expect(result).toMatchObject({ ok: true });
  expect(h.permissionPrompts).toHaveLength(1);
  // The human must see WHAT changed, not just that something did.
  expect(h.permissionPrompts[0]?.diff).toContain('-  \\item Improved checkout performance.');
  expect(h.permissionPrompts[0]?.diff).toContain('+  \\item Cut checkout latency');
  expect(h.commits).toHaveLength(1);
  expect(h.currentContent()).toContain('Redis');
}, 60_000);

test('a rejected edit changes nothing', async () => {
  const h = harness();
  h.setApproval(false);
  const tools = buildTools(h.ctx);

  const result = await tools.edit_resume.execute?.(
    {
      oldText: '\\item Wrote tests.',
      newText: '\\item Wrote 500 tests.',
      summary: 'Add number',
    },
    OPTS,
  );

  expect(result).toMatchObject({ ok: false });
  expect(h.commits).toHaveLength(0);
  expect(h.currentContent()).not.toContain('500');
}, 30_000);

test('an ambiguous oldText is refused rather than replacing the wrong bullet', async () => {
  const h = harness();
  const tools = buildTools(h.ctx);

  const result = await tools.edit_resume.execute?.(
    { oldText: '\\item', newText: '\\item Changed', summary: 'Ambiguous' },
    OPTS,
  );

  expect(result).toMatchObject({ ok: false });
  expect((result as { error: string }).error).toMatch(/appears 2 times/);
  expect(h.commits).toHaveLength(0);
});

test('an edit that breaks LaTeX is rolled back, and the model is told why', async () => {
  const h = harness();
  const tools = buildTools(h.ctx);

  const result = await tools.edit_resume.execute?.(
    {
      // \end{document} removed → the document cannot compile.
      oldText: '\\end{document}',
      newText: '\\thisIsNotARealCommand',
      summary: 'Break it',
    },
    OPTS,
  );

  expect(result).toMatchObject({ ok: false });
  const e = result as { error: string; hint?: string };
  expect(e.error).toMatch(/broke the LaTeX build/);
  expect(e.error).toMatch(/Undefined control sequence|Emergency stop|\\end/i);
  // Invariant 3: nothing was saved.
  expect(h.commits).toHaveLength(0);
  expect(h.currentContent()).toBe(BODY);
}, 60_000);

test('only edit_resume is gated', () => {
  expect(isGated('edit_resume')).toBe(true);
  expect(isGated('read_resume')).toBe(false);
  expect(isGated('web_search')).toBe(false);
  expect(isGated('compile_resume')).toBe(false);
});

test('fetch_url refuses private addresses (SSRF)', () => {
  expect(() => assertPublicUrl('http://localhost:5432')).toThrow(/private address/);
  expect(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/private/);
  expect(() => assertPublicUrl('http://10.0.0.5/admin')).toThrow(/private/);
  expect(() => assertPublicUrl('http://192.168.1.1')).toThrow(/private/);
  expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(/only http and https/);
  expect(assertPublicUrl('https://jobs.example.com/swe').hostname).toBe('jobs.example.com');
});
