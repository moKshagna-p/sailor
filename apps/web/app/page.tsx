'use client';

import type { ResumeTree } from '@sailor/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AccountMenu } from '../components/account-menu.tsx';
import { PasteLatexDialog } from '../components/paste-latex-dialog.tsx';
import { api, type ResumeSummary } from '../lib/api.ts';
import { docxToPositionedPages } from '../lib/docx-resume.ts';
import { pdfToPositionedPages } from '../lib/pdf-resume.ts';
import {
  classifyResumeUpload,
  latexFilesToResumeTree,
  layoutToResumeTree,
} from '../lib/resume-import.ts';

export default function Library() {
  const router = useRouter();
  const [resumes, setResumes] = useState<ResumeSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pasteButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api
      .listResumes()
      .then((r) => setResumes(r.resumes))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function create(tree?: ResumeTree, title = 'Untitled resume'): Promise<boolean> {
    setBusy(true);
    setStatus('Compiling…');
    setError(null);
    try {
      const { resumeId } = await api.createResume(title, tree);
      router.push(`/r/${resumeId}`);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the resume');
      return false;
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const kind = classifyResumeUpload(files);
      const file = files[0];
      if (!file) return;
      setStatus(
        kind === 'pdf'
          ? 'Reading PDF…'
          : kind === 'docx'
            ? 'Reading Word document…'
            : 'Reading LaTeX…',
      );
      const tree =
        kind === 'pdf'
          ? layoutToResumeTree(await pdfToPositionedPages(file))
          : kind === 'docx'
            ? layoutToResumeTree(await docxToPositionedPages(file))
            : await latexFilesToResumeTree(files);
      const title = file.name.replace(/\.[^.]+$/, '') || 'Untitled resume';
      await create(tree, title);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not import the resume');
      setBusy(false);
      setStatus(null);
    } finally {
      event.target.value = '';
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col px-8 py-20">
      <header className="rise">
        <div className="flex items-baseline gap-3">
          <h1
            className="text-5xl text-chalk-100"
            style={{ fontFamily: 'var(--font-display)', fontWeight: 500 }}
          >
            Sailor
          </h1>
          <span className="font-mono text-[11px] tracking-widest text-ink-500 uppercase">v0.1</span>
          <AccountMenu />
        </div>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-chalk-400">
          Tailor your LaTeX résumé to a specific job. The agent reads the real posting, shows you
          exactly what it wants to change, and{' '}
          <span className="text-chalk-200">never invents a fact about you</span> — when a bullet
          needs a number it does not have, it asks.
        </p>
      </header>

      <section className="rise mt-14" style={{ animationDelay: '80ms' }}>
        <div className="grid gap-3 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => create()}
            disabled={busy}
            className="group min-h-32 border border-ochre bg-ochre p-5 text-left text-ink-950 transition-transform hover:-translate-y-0.5 disabled:opacity-40"
          >
            <span className="font-mono text-[10px] tracking-widest uppercase opacity-60">01</span>
            <span className="mt-7 block text-base font-medium">Start from template</span>
            <span className="mt-1 block text-xs opacity-70">A clean, editable foundation</span>
          </button>
          <button
            ref={pasteButtonRef}
            type="button"
            onClick={() => setPasteOpen(true)}
            disabled={busy}
            className="group min-h-32 border border-ink-600 p-5 text-left text-chalk-200 transition-all hover:-translate-y-0.5 hover:border-ochre disabled:opacity-40"
          >
            <span className="font-mono text-[10px] tracking-widest text-ink-500 uppercase">02</span>
            <span className="mt-7 block text-base font-medium group-hover:text-ochre">
              Paste LaTeX
            </span>
            <span className="mt-1 block text-xs text-ink-500">Compile source directly</span>
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="group min-h-32 border border-ink-600 p-5 text-left text-chalk-200 transition-all hover:-translate-y-0.5 hover:border-ochre disabled:opacity-40"
          >
            <span className="font-mono text-[10px] tracking-widest text-ink-500 uppercase">03</span>
            <span className="mt-7 block text-base font-medium group-hover:text-ochre">
              Upload resume
            </span>
            <span className="mt-1 block text-xs text-ink-500">PDF, DOCX, or LaTeX</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.tex,.cls,.sty,.bib,.png,.jpg,.jpeg"
            multiple
            hidden
            onChange={onUpload}
          />
        </div>
        <p className="mt-3 font-mono text-xs text-ink-500">
          PDF and Word imports preserve the original layout as editable, positioned LaTeX.
        </p>

        {status && (
          <p className="mt-4 font-mono text-xs text-ochre" aria-live="polite">
            {status}
          </p>
        )}

        {error && (
          <p className="mt-4 border-l-2 border-strike py-1 pl-3 text-sm text-strike" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="rise mt-16" style={{ animationDelay: '160ms' }}>
        <h2 className="font-mono text-[11px] tracking-widest text-ink-500 uppercase">
          Your résumés
        </h2>

        <div className="mt-5">
          {resumes === null && <p className="text-sm text-ink-500">Loading…</p>}

          {resumes?.length === 0 && (
            <p className="text-sm text-ink-500">Nothing yet. Start one above.</p>
          )}

          <ul>
            {resumes?.map((resume) => (
              <li key={resume.id}>
                <Link
                  href={`/r/${resume.id}`}
                  className="group flex items-baseline justify-between border-b border-ink-800 py-4 transition-colors hover:border-ink-600"
                >
                  <span className="text-[15px] text-chalk-200 transition-colors group-hover:text-ochre">
                    {resume.title}
                  </span>
                  <span className="font-mono text-xs text-ink-500">
                    {new Date(resume.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {pasteOpen && (
        <PasteLatexDialog
          busy={busy}
          error={error}
          onCancel={() => {
            setPasteOpen(false);
            requestAnimationFrame(() => pasteButtonRef.current?.focus());
          }}
          onSubmit={(source) =>
            create(
              { entry: 'main.tex', files: [{ path: 'main.tex', content: source }] },
              'Pasted resume',
            )
          }
        />
      )}
    </main>
  );
}
