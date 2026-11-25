import type { SkillReceipt } from "./delegated-access.ts";
import { HARNESS_CATALOG, isHarness } from "./harnesses.ts";
import { shellQuote as quote } from "./shell-quote.ts";
import { validateSkillPins } from "./skill-pins.ts";

export { validateSkillPins } from "./skill-pins.ts";

function skillpackTool(harness: string): string {
  if (!isHarness(harness)) throw Error("unsupported_harness");
  return HARNESS_CATALOG[harness].skillpackTool;
}

export function parseSkillReceipt(output: string, skill: string, harness: string): SkillReceipt {
  return parseReceipt(output, skill, harness);
}
export function parsePrivateSkillReceipt(
  output: string,
  skill: string,
  harness: string,
  workspaceId: string,
): SkillReceipt & { workspaceId: string } {
  validateSkillPins([skill]);
  if (skill.includes("/") || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(workspaceId))
    throw Error("invalid_receipt");
  return { ...parseReceipt(output, skill, harness, workspaceId), workspaceId };
}
function parseReceipt(output: string, skill: string, harness: string, workspaceId?: string): SkillReceipt {
  const [reference, version] = skill.split("@");
  const lock = JSON.parse(output);
  const [org, slug] = reference!.split("/");
  const workspace = lock.workspaces?.[workspaceId ?? `catalog:${org}`];
  const entry = workspace?.skills?.[workspaceId ? reference! : slug!];
  if (
    ![2, 3].includes(lock.lockfileVersion) ||
    entry?.version !== version ||
    (!workspaceId && entry?.catalogReference !== reference) ||
    entry?.pinned !== version ||
    typeof entry?.skillId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(entry.skillId) ||
    !/^sha256:[a-f0-9]{64}$/.test(entry?.checksum) ||
    workspace?.apiUrl !== "https://skillpack.app/v1" ||
    !entry.targets?.some(
      (target: { tool: string; version: string; packageChecksum: string }) =>
        target.tool === skillpackTool(harness) &&
        target.version === version &&
        target.packageChecksum === entry.checksum,
    )
  )
    throw new Error("invalid_receipt");
  const receipt: SkillReceipt = {
    reference: skill,
    version: version!,
    skillId: entry.skillId,
    checksum: entry.checksum,
    origin: workspace.apiUrl,
  };
  return receipt;
}

export function skillInstallCommand(skill: string, projectDir: string, harness: string): string {
  validateSkillPins([skill], true);
  const [reference, version] = skill.split("@");
  return `export PATH="$PATH:/home/user/.local/bin"; skillpack install ${quote(reference!)} --version ${quote(version!)} --api-url https://skillpack.app/v1 --scope project --project ${quote(projectDir)} --tools ${skillpackTool(harness)} --pin --yes --json`;
}

export function skillExclusionCommand(skills: readonly string[], harness: string): string {
  const paths = [
    "/.companion/skills.lock.json",
    "/.companion/skills.lock.json.lock",
    ...skills.flatMap((skill) => {
      const slug = skill.split("@")[0]!.split("/").at(-1);
      return [`/.agents/skills/${slug}/`, ...(harness === "claude" ? [`/.claude/skills/${slug}/`] : [])];
    }),
  ];
  return `exclude=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$exclude")" && printf '\\n%s\\n' ${paths.map(quote).join(" ")} >> "$exclude"`;
}
