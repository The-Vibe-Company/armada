/** Public package selection shared by installation and local discovery.
 * Replace this legacy bundle with the authored tool skill once its pinned package is available.
 */
export const SKILL_PACKAGE = {
  names: ["armada-manager", "ship-pr-dev", "review-code-dev", "capture-learning-tools"],
  sourceDirectory: ".agents/skills",
  discoveryRoots: [".agents/skills", ".claude/skills", ".codex/skills"],
} as const;
