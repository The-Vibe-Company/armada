import { ORCHESTRATOR_SKILL_PATTERN, type OrchestratorSkillReceipt, type Provider } from "@armada/core";
import type { OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";

const toolReference = `---
name: armada-tools
description: Armada launcher tool reference, not an orchestration method.
---
Use armada --help and armada <command> --help to discover launch, status, logs,
send, wait and stop. The delegated MCP tools expose the same child operations.
Launch only through the delegated Armada connection; keep returned child IDs.
Wait/read child results and stop children when needed. Authority is scoped to
this parent's owner, organization and owned children, with expiry and child limits.
No ticket routing, review, merge or scheduling policy is supplied by Armada.
`;

/** Preparation precedes delegated authority and the first turn. Never return guest diagnostics. */
export async function bootstrapOrchestrator(
  provider: Provider,
  request: {
    sandboxId: string;
    projectDir: string;
    /** Legacy metadata; no longer selects an installer or method. */
    skillRevision: string;
    skill?: string | undefined;
    expectedReceipt?: OrchestratorSkillReceipt | null | undefined;
    harness?: "claude" | "codex";
    recordReceipt?: (receipt: OrchestratorSkillReceipt | null) => Promise<void>;
    configureAuthority: () => Promise<void>;
    diagnostics?: OrchestratorDiagnostics;
  },
): Promise<OrchestratorSkillReceipt | null> {
  const { sandboxId, projectDir, skill } = request;
  if (
    !projectDir.startsWith("/") ||
    [...projectDir].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    (skill !== undefined && (skill.length > 256 || !ORCHESTRATOR_SKILL_PATTERN.test(skill)))
  ) {
    request.diagnostics?.captureReason("skill_configuration_invalid");
    throw new Error("orchestrator_invalid_bootstrap");
  }
  const referenceDir = `${projectDir}/${request.harness === "claude" ? ".claude" : ".agents"}/skills/armada-tools`;
  const referenceCommand = `mkdir -p ${quote(referenceDir)} && printf '%s' ${quote(toolReference)} > ${quote(`${referenceDir}/SKILL.md`)}`;
  let receipt: OrchestratorSkillReceipt | null = null;
  try {
    const [reference, version] = skill?.split("@") ?? [];
    const result = await provider.exec({
      sandboxId,
      cwd: projectDir,
      timeoutSeconds: 300,
      command: skill
        ? `skillpack install ${quote(reference!)} --version ${quote(version!)} --api-url https://skillpack.app/v1 --scope project --project ${quote(projectDir)} --tools ${request.harness === "claude" ? "claude-code" : "codex"} --pin --yes --json >/dev/null && ${referenceCommand} && cat ${quote(`${projectDir}/.companion/skills.lock.json`)}`
        : referenceCommand,
    });
    if (result.detached || result.timedOut || result.truncated || result.exitCode !== 0)
      throw new Error("install_failed");
    if (skill) {
      const lock = JSON.parse(result.stdout);
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
            target.tool === (request.harness === "claude" ? "claude-code" : "codex") &&
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
      if (request.expectedReceipt && JSON.stringify(request.expectedReceipt) !== JSON.stringify(receipt))
        throw new Error("receipt_changed");
    }
  } catch {
    request.diagnostics?.captureReason("skill_install_nonzero");
    throw new Error("orchestrator_skill_bootstrap_failed");
  }
  await request.recordReceipt?.(receipt);
  await request.configureAuthority();
  return receipt;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
