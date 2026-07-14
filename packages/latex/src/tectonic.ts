import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompileResult, ResumeTree } from '@sailor/core';
import { getEntryFile } from '@sailor/core';
import { parseLatexLog } from './diagnostics.ts';
import { Semaphore } from './semaphore.ts';

/**
 * The authoritative compile path. Every PDF a user downloads comes from here.
 *
 * A note on "warm pool": Tectonic is a one-shot CLI, not a server, so there is
 * no process to keep warm — pretending otherwise would be theatre. The costs
 * that actually matter are (1) fetching TeX packages from CTAN, which we kill
 * with a persistent shared cache, and (2) fork storms under load, which we kill
 * with a semaphore. `prewarm()` populates the cache at boot so the first real
 * user compile is not the one that pays for it.
 */
const CACHE_DIR = resolve(process.env.TECTONIC_CACHE_DIR ?? '.tectonic-cache');
const BIN = resolve(process.env.TECTONIC_BIN ?? './bin/tectonic');
const TIMEOUT_MS = Number(process.env.LATEX_TIMEOUT_MS ?? 20_000);

/**
 * The first compile on a cold machine downloads the CTAN bundle, which takes far
 * longer than any steady-state compile ever will. Holding both to one budget
 * means either the timeout is uselessly long or cold start spuriously fails —
 * so prewarm gets its own, generous budget and normal compiles stay strict.
 */
const PREWARM_TIMEOUT_MS = Number(process.env.LATEX_PREWARM_TIMEOUT_MS ?? 300_000);

const gate = new Semaphore(Number(process.env.LATEX_POOL_SIZE ?? 4));

export async function compileWithTectonic(
  tree: ResumeTree,
  options: { timeoutMs?: number } = {},
): Promise<CompileResult> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const release = await gate.acquire();
  const started = performance.now();
  let dir: string | undefined;

  try {
    dir = await mkdtemp(join(tmpdir(), 'sailor-tex-'));

    // ResumeFile.path already rejects `..` and absolute paths at the schema
    // boundary; this is the second line of defence, because a traversal here
    // writes attacker-chosen bytes to an attacker-chosen path.
    for (const file of tree.files) {
      const target = resolve(dir, file.path);
      if (!target.startsWith(`${dir}/`)) {
        throw new Error(`Refusing to write outside the scratch dir: ${file.path}`);
      }
      await Bun.write(Bun.file(target), file.content);
    }

    const entry = getEntryFile(tree);

    const proc = Bun.spawn(
      [
        BIN,
        '-X',
        'compile',
        entry.path,
        // Disables shell-escape and every other known-insecure TeX feature. The
        // input is a file a stranger uploaded; without this, \write18 is RCE.
        '--untrusted',
        '--outdir',
        dir,
        '--keep-logs',
        '--print',
      ],
      {
        cwd: dir,
        env: { ...process.env, TECTONIC_CACHE_DIR: CACHE_DIR },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);

    // Tectonic writes its chatter to stderr, but a malformed doc can put the
    // useful part on stdout. Parse both — dropping a diagnostic means the agent
    // cannot self-correct.
    const log = `${stderr}\n${stdout}`;
    const durationMs = Math.round(performance.now() - started);
    const diagnostics = parseLatexLog(log);

    if (exitCode !== 0) {
      return {
        ok: false,
        diagnostics,
        log: log.slice(-4000),
        durationMs,
        engine: 'tectonic',
      };
    }

    const pdfPath = join(dir, entry.path.replace(/\.tex$/, '.pdf'));
    const pdfFile = Bun.file(pdfPath);
    if (!(await pdfFile.exists())) {
      return {
        ok: false,
        diagnostics: [
          ...diagnostics,
          {
            severity: 'error',
            file: entry.path,
            line: null,
            message: 'Tectonic exited cleanly but produced no PDF.',
          },
        ],
        log: log.slice(-4000),
        durationMs,
        engine: 'tectonic',
      };
    }

    return {
      ok: true,
      pdf: new Uint8Array(await pdfFile.arrayBuffer()),
      diagnostics,
      durationMs,
      engine: 'tectonic',
    };
  } finally {
    release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

let prewarmed: Promise<void> | null = null;

/**
 * Compiles a trivial document once, which forces Tectonic to fetch and cache the
 * CTAN bundle. Without this the first user-facing compile eats a multi-second
 * download. Idempotent and safe to call on every boot.
 */
export function prewarm(): Promise<void> {
  prewarmed ??= (async () => {
    const started = performance.now();
    const result = await compileWithTectonic(
      {
        entry: 'warm.tex',
        files: [
          {
            path: 'warm.tex',
            content: '\\documentclass{article}\\begin{document}warm\\end{document}',
          },
        ],
      },
      { timeoutMs: PREWARM_TIMEOUT_MS },
    );
    const ms = Math.round(performance.now() - started);
    if (result.ok) {
      console.warn(`[latex] tectonic cache warm (${ms}ms)`);
    } else {
      // Not fatal — the first real compile will retry the fetch. But it almost
      // always means the binary is missing, so say so loudly.
      console.error(
        `[latex] prewarm failed after ${ms}ms. Is ${BIN} present? ` +
          `Run: bun run scripts/install-tectonic.ts`,
      );
    }
  })();
  return prewarmed;
}

export const tectonicStatus = () => ({
  bin: BIN,
  cacheDir: CACHE_DIR,
  queueDepth: gate.queueDepth,
});
