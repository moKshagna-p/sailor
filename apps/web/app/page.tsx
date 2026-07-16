'use client';

import type { ResumeTree } from '@sailor/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, type ResumeSummary } from '../lib/api.ts';

export default function Library() {
  const router = useRouter();
  const [resumes, setResumes] = useState<ResumeSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .listResumes()
      .then((r) => setResumes(r.resumes))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function create(tree?: ResumeTree, title = 'Untitled resume') {
    setBusy(true);
    setError(null);
    try {
      const { resumeId } = await api.createResume(title, tree);
      router.push(`/r/${resumeId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the resume');
      setBusy(false);
    }
  }

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    const parts = await Promise.all(
      files.map(async (f) => ({ path: f.name, content: await f.text() })),
    );

    // The entry is the .tex that actually has a \documentclass. Picking the first
    // .tex would break every template that ships a preamble in a separate file.
    const entry =
      parts.find((f) => f.path.endsWith('.tex') && f.content.includes('\\documentclass'))?.path ??
      parts.find((f) => f.path.endsWith('.tex'))?.path;

    if (!entry) {
      setError(
        'None of those files contain a \\documentclass — I cannot tell which one to compile.',
      );
      return;
    }

    const title = entry.replace(/\.tex$/, '');
    await create({ entry, files: parts }, title);
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
          <Link href="/settings" className="font-mono text-[11px] text-ink-500 hover:text-ochre">
            Settings
          </Link>
        </div>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-chalk-400">
          Tailor your LaTeX résumé to a specific job. The agent reads the real posting, shows you
          exactly what it wants to change, and{' '}
          <span className="text-chalk-200">never invents a fact about you</span> — when a bullet
          needs a number it does not have, it asks.
        </p>
      </header>

      <section className="rise mt-14" style={{ animationDelay: '80ms' }}>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => create()}
            disabled={busy}
            className="border border-ochre bg-ochre px-5 py-2.5 text-sm font-medium text-ink-900 transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Start from template
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="border border-ink-600 px-5 py-2.5 text-sm text-chalk-200 transition-colors hover:border-ink-500 hover:text-chalk-100 disabled:opacity-40"
          >
            Upload .tex
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".tex,.cls,.sty,.bib"
            multiple
            hidden
            onChange={onUpload}
          />
        </div>
        <p className="mt-3 font-mono text-xs text-ink-500">
          Upload every file your résumé needs — the .tex, plus any .cls or .sty it depends on.
        </p>

        {error && (
          <p className="mt-4 border-l-2 border-strike py-1 pl-3 text-sm text-strike">{error}</p>
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
    </main>
  );
}
