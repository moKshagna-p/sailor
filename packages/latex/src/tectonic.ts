import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompileResult, ResumeTree } from '@sailor/core';
import { getEntryFile } from '@sailor/core';
import { parseLatexLog } from './diagnostics.ts';
import { Semaphore } from './semaphore.ts';
import { STARTER_RESUME } from './template.ts';

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
// This package is executed from the API workspace in development, from the repo
// root in tests, and from an arbitrary working directory in production. Resolve
// relative TeX paths against the repository/project root, never `process.cwd()`.
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CACHE_DIR = resolve(PROJECT_ROOT, process.env.TECTONIC_CACHE_DIR ?? '.tectonic-cache');
const BIN = resolve(PROJECT_ROOT, process.env.TECTONIC_BIN ?? './bin/tectonic');
const TIMEOUT_MS = Number(process.env.LATEX_TIMEOUT_MS ?? 20_000);

/**
 * The first compile on a cold machine downloads the CTAN bundle, which takes far
 * longer than any steady-state compile ever will. Holding both to one budget
 * means either the timeout is uselessly long or cold start spuriously fails —
 * so prewarm gets its own, generous budget and normal compiles stay strict.
 *
 * Ten minutes because a fully cold fetch of everything the starter resume needs
 * was measured at 226s here, on a fast connection. A CI runner is slower, and
 * the cost of this being too small is a red build on a green tree.
 */
const PREWARM_TIMEOUT_MS = Number(process.env.LATEX_PREWARM_TIMEOUT_MS ?? 600_000);

const gate = new Semaphore(Number(process.env.LATEX_POOL_SIZE ?? 4));

export async function compileWithTectonic(
  tree: ResumeTree,
  options: { timeoutMs?: number; synctex?: boolean } = {},
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
        // Only when asked: the map is dead weight on the compile-before-commit
        // path (the agent never clicks), and only the live preview needs it.
        ...(options.synctex ? ['--synctex'] : []),
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
      ...(options.synctex ? { synctex: await readSyncTex(dir, entry.path) } : {}),
    };
  } finally {
    release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Read and decompress the SyncTeX map Tectonic wrote next to the PDF. A missing
 * or unreadable file is not fatal — it just means no click-to-source for this
 * build — so this returns undefined rather than throwing into the compile.
 */
async function readSyncTex(dir: string, entryPath: string): Promise<string | undefined> {
  const gzPath = join(dir, entryPath.replace(/\.tex$/, '.synctex.gz'));
  const gz = Bun.file(gzPath);
  if (!(await gz.exists())) return undefined;
  try {
    return new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())));
  } catch {
    return undefined;
  }
}

let prewarmed: Promise<void> | null = null;

/**
 * Compiles the starter resume once, which forces Tectonic to fetch and cache the
 * CTAN packages a real document needs. Without this the first user-facing
 * compile eats a multi-second download. Idempotent and safe to call on boot.
 *
 * It warms with the actual template rather than a bare `\documentclass{article}`
 * on purpose. The trivial document only pulls the base bundle, leaving geometry,
 * titlesec, enumitem and hyperref to be downloaded by the first real compile —
 * which is the one this exists to make fast, and which then blows the normal
 * compile budget on a cold machine.
 */
export function prewarm(): Promise<void> {
  prewarmed ??= (async () => {
    const started = performance.now();
    const result = await compileWithTectonic(STARTER_RESUME, { timeoutMs: PREWARM_TIMEOUT_MS });
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
