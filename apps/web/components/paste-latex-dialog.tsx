'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';

export function PasteLatexDialog({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (source: string) => Promise<boolean>;
}) {
  const [source, setSource] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    textareaRef.current?.focus();
    return () => dialog?.close();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!source.includes('\\documentclass')) {
      setValidation('Paste a complete document containing \\documentclass.');
      return;
    }
    setValidation(null);
    if (await onSubmit(source)) onCancel();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="paste-latex-title"
      className="m-auto w-[calc(100%_-_2.5rem)] max-w-3xl border border-ink-600 bg-ink-900 p-0 text-chalk-200 shadow-2xl backdrop:bg-ink-950/80 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form onSubmit={submit}>
        <header className="rule-b flex items-start justify-between gap-6 px-6 py-5">
          <div>
            <p className="font-mono text-[10px] tracking-[0.22em] text-ochre uppercase">
              Source import
            </p>
            <h2
              id="paste-latex-title"
              className="mt-1 text-2xl text-chalk-100"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Paste complete LaTeX
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="font-mono text-xs text-ink-500 transition-colors hover:text-chalk-200 disabled:opacity-40"
          >
            esc
          </button>
        </header>

        <div className="px-6 py-5">
          <label htmlFor="latex-source" className="font-mono text-xs text-ink-400">
            Document source
          </label>
          <textarea
            ref={textareaRef}
            id="latex-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            spellCheck={false}
            disabled={busy}
            placeholder={'\\documentclass{article}\n\\begin{document}\n...\n\\end{document}'}
            className="mt-2 h-[48vh] w-full resize-y border border-ink-700 bg-ink-950 p-4 font-mono text-[13px] leading-relaxed text-chalk-200 outline-none transition-colors placeholder:text-ink-700 focus:border-ochre disabled:opacity-60"
          />
          {(validation ?? error) && (
            <p className="mt-3 border-l-2 border-strike py-1 pl-3 text-sm text-strike" role="alert">
              {validation ?? error}
            </p>
          )}
        </div>

        <footer className="rule-t flex items-center justify-end gap-3 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm text-ink-400 transition-colors hover:text-chalk-100 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || source.trim().length === 0}
            className="border border-ochre bg-ochre px-5 py-2 text-sm font-medium text-ink-950 transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Compiling…' : 'Compile & create'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
