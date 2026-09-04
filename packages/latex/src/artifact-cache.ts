import type { LatexDiagnostic } from '@sailor/core';

export type CompileArtifact = {
  pdf: Uint8Array;
  diagnostics: LatexDiagnostic[];
  synctex?: string;
};

type CacheEntry = {
  artifact: CompileArtifact;
  bytes: number;
};

/** A byte- and entry-bounded LRU for successful, immutable compiler artifacts. */
export class CompileArtifactCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 0) {
      throw new Error(`Cache maxEntries must be a non-negative integer, got ${maxEntries}`);
    }
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new Error(`Cache maxBytes must be a non-negative number, got ${maxBytes}`);
    }
  }

  get(key: string): CompileArtifact | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return cloneArtifact(entry.artifact);
  }

  set(key: string, artifact: CompileArtifact): void {
    const stored = cloneArtifact(artifact);
    const bytes = stored.pdf.byteLength + (stored.synctex ? new Blob([stored.synctex]).size : 0);
    if (this.maxEntries === 0 || bytes > this.maxBytes) return;

    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }

    this.entries.set(key, { artifact: stored, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.bytes -= oldest.bytes;
    }
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.bytes;
  }
}

function cloneArtifact(artifact: CompileArtifact): CompileArtifact {
  return {
    pdf: artifact.pdf.slice(),
    diagnostics: artifact.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    ...(artifact.synctex === undefined ? {} : { synctex: artifact.synctex }),
  };
}
