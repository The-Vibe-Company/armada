/** Reviewed public tool-knowledge package shared by installation and local discovery. */
export const SKILL_PACKAGE = {
  names: ["armada"],
  revision: "e188088162039ebf48588f36b2e23d854d8b174b",
  sourceDirectory: ".agents/skills",
  discoveryRoots: [".agents/skills", ".claude/skills", ".codex/skills"],
} as const;
