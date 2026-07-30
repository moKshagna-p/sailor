import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source. `@sailor/latex` is here only for
  // its `/synctex` subpath, which is pure geometry — the Tectonic half of that
  // package imports `node:` modules and must never reach the browser bundle.
  transpilePackages: ['@sailor/core', '@sailor/latex'],
};

export default config;
