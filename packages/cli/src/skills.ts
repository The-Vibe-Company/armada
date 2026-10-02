// A local skill update on the current branch, sharing init's vendoring rules.
import { planIsEmpty, planSkills } from "@armada/core";
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
