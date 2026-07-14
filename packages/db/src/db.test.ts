import { expect, test } from 'bun:test';
import type { ResumeTree } from '@sailor/core';
import { hashTree } from '@sailor/core';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { commitVersion, createResume, ensureUser, listVersions, rollbackTo } from './queries.ts';

const tree = (bullet: string): ResumeTree => ({
  entry: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}\\begin{document}${bullet}\\end{document}`,
    },
  ],
});

test('secrets round-trip and never store plaintext', async () => {
  const sealed = await encryptSecret('sk-ant-super-secret');
  expect(sealed).not.toContain('sk-ant');
  expect(await decryptSecret(sealed)).toBe('sk-ant-super-secret');

  // A fresh IV each time ⇒ the same plaintext must not produce the same ciphertext.
  expect(await encryptSecret('same')).not.toBe(await encryptSecret('same'));
});

test('hashing is order-independent', async () => {
  const a: ResumeTree = {
    entry: 'main.tex',
    files: [
      { path: 'main.tex', content: 'x' },
      { path: 'cv.cls', content: 'y' },
    ],
  };
  const b: ResumeTree = {
    entry: 'main.tex',
    files: [
      { path: 'cv.cls', content: 'y' },
      { path: 'main.tex', content: 'x' },
    ],
  };
  expect(await hashTree(a)).toBe(await hashTree(b));
});

test('versions are append-only, deduped, and rollback is non-destructive', async () => {
  const userId = await ensureUser(`test-${crypto.randomUUID()}@sailor.local`);
  const { resumeId, versionId } = await createResume({
    userId,
    title: 'Test',
    tree: tree('Built a thing'),
  });

  const edited = await commitVersion({
    resumeId,
    tree: tree('Built a thing that scaled to 10M users'),
    summary: 'Tailor for Acme',
    createdBy: 'agent',
    parentId: versionId,
  });
  expect(edited.status).toBe('committed');

  // Committing identical content must NOT create a second row.
  const noop = await commitVersion({
    resumeId,
    tree: tree('Built a thing that scaled to 10M users'),
    summary: 'Same content again',
    createdBy: 'agent',
    parentId: edited.version.id,
  });
  expect(noop.status).toBe('unchanged');
  expect(noop.version.id).toBe(edited.version.id);

  // Rollback moves forward: the rolled-back-from version still exists.
  const rolled = await rollbackTo(versionId);
  expect(rolled.status).toBe('committed');
  expect(rolled.version.tree.files[0]?.content).toContain('Built a thing');
  expect(rolled.version.tree.files[0]?.content).not.toContain('10M users');

  const history = await listVersions(resumeId);
  expect(history).toHaveLength(3); // initial, edit, rollback — nothing destroyed
  expect(history.map((v) => v.summary)).toContain('Tailor for Acme');
});
