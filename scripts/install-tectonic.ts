/**
 * Fetches the Tectonic binary into ./bin. Tectonic is a single static Rust
 * binary that pulls TeX packages on demand and caches them, which is why we use
 * it instead of a 4GB TeX Live install.
 *
 *   bun run scripts/install-tectonic.ts
 */
import { chmod, mkdir } from 'node:fs/promises';
import { $ } from 'bun';

const VERSION = '0.16.9';

const TARGETS: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) {
  console.error(`No Tectonic build for ${key}. Install it yourself and set TECTONIC_BIN.`);
  process.exit(1);
}

const url =
  `https://github.com/tectonic-typesetting/tectonic/releases/download/` +
  `tectonic%40${VERSION}/tectonic-${VERSION}-${target}.tar.gz`;

console.log(`Downloading tectonic ${VERSION} for ${key}...`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}\n  ${url}`);
  process.exit(1);
}

await mkdir('bin', { recursive: true });
const tarball = 'bin/tectonic.tar.gz';
await Bun.write(tarball, await res.arrayBuffer());
await $`tar -xzf ${tarball} -C bin`.quiet();
await $`rm ${tarball}`.quiet();
await chmod('bin/tectonic', 0o755);

const { stdout } = await $`./bin/tectonic --version`.quiet();
console.log(`✓ ${stdout.toString().trim()} → ./bin/tectonic`);
