import type { SkillReceipt } from "./delegated-access.ts";
import { HARNESS_CATALOG, isHarness } from "./harnesses.ts";
import { shellQuote as quote } from "./shell-quote.ts";
import { skillRefusalMessage } from "./skill-diagnostics.ts";
import { validateSkillPins } from "./skill-pins.ts";

export { validateSkillPins } from "./skill-pins.ts";

import type { Provider } from "./provider.ts";

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

/** Anonymous catalog installation only. Private callers reuse installPrivateSkill from #872. */
export async function installSkill(
  provider: Provider,
  sandboxId: string,
  projectDir: string,
  harness: string,
  skill: string,
  buildWarnings: readonly string[] = [],
): Promise<SkillReceipt> {
  validateSkillPins([skill], true);
  let reason = "skillpack_transport_failed";
  try {
    const commands = {
      installCommand: skillInstallCommand(skill, projectDir, harness),
      receiptCommand: `cat ${quote(projectDir + "/.companion/skills.lock.json")}`,
    };
    const result = await provider.exec({
      sandboxId,
      cwd: projectDir,
      timeoutSeconds: 300,
      command: `${commands.installCommand} >/dev/null && ${commands.receiptCommand}`,
    });
    if (result.detached) reason = "skillpack_process_failed";
    else if (result.timedOut) reason = "skillpack_timeout";
    else if (result.truncated) reason = "skillpack_protocol_invalid";
    else if ([126, 127].includes(result.exitCode ?? 0)) reason = "skillpack_cli_unavailable";
    else if ([2, 5].includes(result.exitCode ?? 0)) reason = "skillpack_request_rejected";
    else if ([3, 4, 7].includes(result.exitCode ?? 0)) reason = "skillpack_skill_unavailable";
    else if (result.exitCode === 6) reason = "skillpack_install_conflict";
    else if (result.exitCode === 8) reason = "skillpack_registry_unavailable";
    else if (result.exitCode !== 0) reason = "skillpack_install_nonzero";
    else {
      reason = "skillpack_receipt_invalid";
      return parseSkillReceipt(result.stdout, skill, harness);
    }
  } catch {
    // Only the closed classification survives; guest output and provider errors do not.
  }
  if (reason === "skillpack_cli_unavailable" && buildWarnings.includes("skillpack_download_unavailable"))
    reason = "skillpack_download_unavailable";
  throw new Error(skillRefusalMessage(reason));
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
