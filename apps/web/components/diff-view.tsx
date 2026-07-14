'use client';

/** Proofing marks: struck lines in red, added lines in green, context in chalk. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));

  return (
    <pre className="overflow-x-auto border border-ink-700 bg-ink-900 p-3 font-mono text-[11.5px] leading-relaxed">
      {lines.map((line, i) => {
        const kind = line.startsWith('+')
          ? 'added'
          : line.startsWith('-')
            ? 'removed'
            : line.startsWith('@@')
              ? 'skip'
              : 'context';

        return (
          <div
            // A diff is a static, immutable list; line N is always line N.
            // biome-ignore lint/suspicious/noArrayIndexKey: static rendered diff
            key={`${i}-${line.slice(0, 12)}`}
            className={
              kind === 'added'
                ? 'bg-added/10 text-added'
                : kind === 'removed'
                  ? 'bg-strike/10 text-strike'
                  : kind === 'skip'
                    ? 'py-1 text-center text-ink-600'
                    : 'text-chalk-400'
            }
          >
            {kind === 'skip' ? '⋯' : line}
          </div>
        );
      })}
    </pre>
  );
}
