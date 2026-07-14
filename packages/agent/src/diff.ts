/**
 * A minimal unified diff, used to show a human exactly what the agent wants to
 * change *before* they approve it. A permission prompt that says "the agent
 * wants to edit your resume" is worthless; one that shows the two bullets side
 * by side is the entire point of the gate.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before.split('\n');
  const b = after.split('\n');

  // Longest common subsequence over lines. Resumes are small (hundreds of lines),
  // so the O(n·m) table is fine and the simplicity is worth more than the speed.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i];
      const next = lcs[i + 1];
      if (!row || !next) continue;
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  type Line = { kind: ' ' | '-' | '+'; text: string };
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: ' ', text: a[i] ?? '' });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: '-', text: a[i] ?? '' });
      i++;
    } else {
      lines.push({ kind: '+', text: b[j] ?? '' });
      j++;
    }
  }
  while (i < a.length) lines.push({ kind: '-', text: a[i++] ?? '' });
  while (j < b.length) lines.push({ kind: '+', text: b[j++] ?? '' });

  // Collapse runs of unchanged lines that are far from any change.
  const keep = new Set<number>();
  lines.forEach((line, idx) => {
    if (line.kind === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep.add(k);
    }
  });

  if (keep.size === 0) return `--- ${path}\n+++ ${path}\n(no changes)`;

  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  let skipping = false;
  lines.forEach((line, idx) => {
    if (!keep.has(idx)) {
      if (!skipping) {
        out.push('@@ ... @@');
        skipping = true;
      }
      return;
    }
    skipping = false;
    out.push(`${line.kind}${line.text}`);
  });

  return out.join('\n');
}
