import { ORCHESTRATOR_SKILL_PATTERN, type OrchestratorSkillReceipt } from "./orchestrator.ts";
import type { ExecResult, Provider } from "./provider.ts";

export function validateSkillPins(skills: unknown): asserts skills is string[] {
  if (
    !Array.isArray(skills) ||
    skills.length > 20 ||
    skills.some(
      (skill) =>
        typeof skill !== "string" ||
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

/** Trusted server transport seam for #841, never a public launch/config field.
 * A private transport may close over a resolved credential, applying it only to
 * installCommand via ephemeral process environment. Never persist credentials,
 * attach them to the sandbox environment, or use private transport in goldens.
 * Return receiptCommand output only after a successful synchronous installation.
 */
export type SkillInstallTransport = (commands: {
  installCommand: string;
  receiptCommand: string;
}) => Promise<ExecResult>;

export async function installSkill(
  provider: Provider,
  sandboxId: string,
  projectDir: string,
  harness: string,
  skill: string,
  transport?: SkillInstallTransport,
): Promise<OrchestratorSkillReceipt> {
  validateSkillPins([skill]);
  try {
    const commands = {
      installCommand: skillInstallCommand(skill, projectDir, harness),
      receiptCommand: `cat ${quote(projectDir + "/.companion/skills.lock.json")}`,
    };
    const result = await (transport
      ? transport(commands)
      : provider.exec({
          sandboxId,
          cwd: projectDir,
          timeoutSeconds: 300,
          command: `${commands.installCommand} >/dev/null && ${commands.receiptCommand}`,
        }));
    if (result.detached || result.timedOut || result.truncated || result.exitCode !== 0)
      throw new Error("install_failed");
    return parseSkillReceipt(result.stdout, skill, harness);
  } catch {
    throw new Error("Skillpack installation failed: native CLI, public pin or verified receipt unavailable.");
  }
}
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function skillInstallCommand(skill: string, projectDir: string, harness: string): string {
  validateSkillPins([skill]);
  const [reference, version] = skill.split("@");
  return `skillpack install ${quote(reference!)} --version ${quote(version!)} --api-url https://skillpack.app/v1 --scope project --project ${quote(projectDir)} --tools ${harness === "claude" ? "claude-code" : "codex"} --pin --yes --json`;
}
