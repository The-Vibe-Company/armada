// A local skill update on the current branch, sharing init's vendoring rules.
import { BUNDLED_SKILLS, planIsEmpty, planSkills } from "@armada/core";
import type { Io } from "./io.ts";
import { UsageError } from "./io.ts";
import { applyPlan, fsRepoView, gitRoot, requireExec } from "./repo.ts";

export async function updateSkills(io: Io, armadaVersion: string, json: boolean): Promise<number> {
  const root = await gitRoot(requireExec(io), io.cwd);
  if (!root) throw new UsageError("skills update needs a Git checkout");
  const plan = await planSkills(fsRepoView(root), armadaVersion);
  await applyPlan(root, plan);
  io.stdout(
    json
      ? `${JSON.stringify({ root, armadaVersion, installed: plan.installed, updated: plan.updated, writes: plan.writes.map((w) => w.path), removes: plan.removes, links: plan.links }, null, 2)}\n`
      : planIsEmpty(plan)
        ? `Bundled skills already match Armada ${armadaVersion}.\n`
        : `Updated bundled skills to Armada ${armadaVersion} in ${root}.\nReview and commit the changes on your branch.\n`,
  );
  return 0;
}

/** Print an exact bundled file without resolving project settings or credentials. */
export function printSkill(io: Io, args: string[]): number {
  if (args.length < 1 || args.length > 2) throw new UsageError("skill needs <name> [<file>]");
  const name = args[0];
  const skill = BUNDLED_SKILLS.find((s) => s.name === name);
  if (!skill)
    throw new UsageError(`unknown skill: ${name}; available: ${BUNDLED_SKILLS.map((s) => s.name).join(", ")}`);
  const path = args[1] ?? "SKILL.md";
  const file = skill.files.find((f) => f.path === path);
  if (!file) throw new UsageError(`skill ${name} has no bundled file ${path}`);
  io.stdout(file.content);
  return 0;
}
