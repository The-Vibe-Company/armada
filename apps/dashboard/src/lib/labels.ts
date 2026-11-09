import type { Harness } from "@armada/core";

/** The agent a harness runs, as people know it. */
export const HARNESS_LABELS: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };
