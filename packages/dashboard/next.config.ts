import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The monorepo root: Bun installs every workspace there, and the server bundle
// traces its files from there.
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
  // core ships TypeScript sources.
  transpilePackages: ["@armada/core"],
  // A native module, loaded at run time by core's Turso adapter.
  serverExternalPackages: ["@libsql/client", "libsql"],
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // The repository's own AGENTS.md is the agents' guide; do not generate one here.
  agentRules: false,
  devIndicators: false,
};

export default config;
