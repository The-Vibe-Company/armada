import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The monorepo root: Bun installs every workspace there, and the server bundle
// traces its files from there.
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
  // core ships TypeScript sources.
  transpilePackages: ["@armada/core"],
  // Loaded at run time, not bundled: node-postgres, and PGlite (WebAssembly and its data files).
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  outputFileTracingRoot: root,
  // PGlite (21 MB of WebAssembly and data) only opens `pglite:` URLs, which a
  // production server refuses (`databaseUrlOf`): kept out of the functions'
  // bundle. `next dev`, local `next start` and the tests load it from
  // node_modules as before.
  // Globs are relative to this package; Bun installs every workspace at the monorepo root.
  outputFileTracingExcludes: { "*": ["../../node_modules/**/@electric-sql/pglite/**"] },
  turbopack: { root },
  poweredByHeader: false,
  // The repository's own AGENTS.md is the agents' guide; do not generate one here.
  agentRules: false,
  devIndicators: false,
};

export default config;
