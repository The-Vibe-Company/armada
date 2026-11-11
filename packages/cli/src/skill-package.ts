/** Reviewed public tool-knowledge package shared by installation and local discovery. */
export const SKILL_PACKAGE = {
  names: ["armada"],
  revision: "edae17036da335f41e91af7e6ade7a42473d6a45",
  sourceDirectory: ".agents/skills",
  discoveryRoots: [".agents/skills", ".claude/skills", ".codex/skills"],
} as const;
