import { ORCHESTRATOR_SKILL_PATTERN, type OrchestratorSkillReceipt } from "./orchestrator.ts";
import type { Provider } from "./provider.ts";

export function validateSkillPins(skills: unknown): asserts skills is string[] {
  if (
    !Array.isArray(skills) ||
    skills.length > 20 ||
    skills.some(
      (skill) =>
        typeof skill !== "string" ||
        !skill.includes("/") ||
        skill.length > 256 ||
        !ORCHESTRATOR_SKILL_PATTERN.test(skill) ||
        skill.split("/")[1]?.startsWith("armada-tools@"),
    ) ||
    new Set(skills.map((skill) => skill.split("@")[0].split("/")[1])).size !== skills.length
  )
    throw new Error("Skills require distinct public org/slug@exact-version pins (maximum 20).");
}

export function parseSkillReceipt(output: string, skill: string, harness: string): OrchestratorSkillReceipt {
  const [reference, version] = skill.split("@");
  let receipt: OrchestratorSkillReceipt;
  const lock = JSON.parse(output);
  const [org, slug] = reference!.split("/");
  const workspace = lock.workspaces?.[`catalog:${org}`];
  const entry = workspace?.skills?.[slug!];
  if (
    ![2, 3].includes(lock.lockfileVersion) ||
    entry?.version !== version ||
    entry?.catalogReference !== reference ||
    entry?.pinned !== version ||
    typeof entry?.skillId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(entry.skillId) ||
    !/^sha256:[a-f0-9]{64}$/.test(entry?.checksum) ||
    workspace?.apiUrl !== "https://skillpack.app/v1" ||
    !entry.targets?.some(
      (target: { tool: string; version: string; packageChecksum: string }) =>
        target.tool === (harness === "claude" ? "claude-code" : "codex") &&
        target.version === version &&
        target.packageChecksum === entry.checksum,
    )
  )
    throw new Error("invalid_receipt");
  receipt = {
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
): Promise<OrchestratorSkillReceipt> {
  validateSkillPins([skill]);
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
  const action =
    reason === "skillpack_download_unavailable"
      ? "The last golden build reported skillpack_download_unavailable: allow GitHub release egress, then rebuild; repeating an offline build will not help."
      : reason === "skillpack_cli_unavailable"
        ? "Rebuild the golden with armada golden update to provision the native CLI."
        : "Check the requested public pin, registry access and compatible CLI; see docs/private-skillpack.md.";
  throw new Error(`Skillpack installation failed: ${reason}. ${action}`);
}
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function skillInstallCommand(skill: string, projectDir: string, harness: string): string {
  validateSkillPins([skill]);
  const [reference, version] = skill.split("@");
  return `export PATH="$PATH:/home/user/.local/bin"; skillpack install ${quote(reference!)} --version ${quote(version!)} --api-url https://skillpack.app/v1 --scope project --project ${quote(projectDir)} --tools ${harness === "claude" ? "claude-code" : "codex"} --pin --yes --json`;
}
