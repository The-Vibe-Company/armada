// The skills Armada vendors into every managed repository. Their files live in
// `skills/` at the root of the Armada repository and are imported as text, so
// the single published bundle carries them. Folder hashes use the `npx skills`
// algorithm, so skills-lock.json stays readable by that tool.
import { createHash } from "node:crypto";
import coordinatorMerge from "../../../skills/armada-coordinator/MERGE.md" with { type: "text" };
import coordinator from "../../../skills/armada-coordinator/SKILL.md" with { type: "text" };
import claudeCode from "../../../skills/armada-runtime-claude-code/SKILL.md" with { type: "text" };
import conductor from "../../../skills/armada-runtime-conductor/SKILL.md" with { type: "text" };
import worker from "../../../skills/armada-worker/SKILL.md" with { type: "text" };

/** Where Armada's skills come from, in skills-lock.json terms. */
export const SKILLS_SOURCE = "The-Vibe-Company/armada";

export interface SkillFile {
  /** Path inside the skill folder, `/`-separated. */
  path: string;
  content: string;
}

export interface BundledSkill {
  name: string;
  files: SkillFile[];
}

/** Every skill a repository needs to be run by Armada. A missing one is an error. */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  {
    name: "armada-coordinator",
    files: [
      { path: "MERGE.md", content: coordinatorMerge },
      { path: "SKILL.md", content: coordinator },
    ],
  },
  { name: "armada-runtime-claude-code", files: [{ path: "SKILL.md", content: claudeCode }] },
  { name: "armada-runtime-conductor", files: [{ path: "SKILL.md", content: conductor }] },
  { name: "armada-worker", files: [{ path: "SKILL.md", content: worker }] },
];

/**
 * Hash of a skill folder as `npx skills` computes it: sha256 over every file,
 * sorted by relative path, feeding the path then the content.
 */
export function skillFolderHash(files: readonly { path: string; content: string | Uint8Array }[]): string {
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(f.path);
    hash.update(f.content);
  }
  return hash.digest("hex");
}
