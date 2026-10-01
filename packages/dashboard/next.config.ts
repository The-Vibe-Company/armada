import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The monorepo root: Bun installs every workspace there, and the server bundle
// traces its files from there.
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
  // core ships TypeScript sources.
  transpilePackages: ["@armada/core"],
  // Loaded at run time, not bundled: core's Turso adapter (a native module, for
  // the CLI only), node-postgres, and PGlite (WebAssembly and its data files).
  serverExternalPackages: ["@libsql/client", "libsql", "pg", "@electric-sql/pglite"],
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // The repository's own AGENTS.md is the agents' guide; do not generate one here.
  agentRules: false,
  devIndicators: false,
};

export default config;
