import { ORCHESTRATOR_SKILL_PATTERN, type OrchestratorSkillReceipt, type Provider } from "@armada/core";
import { installPrivateSkill, PrivateSkillError } from "@armada/core/server";
import type { OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";

const toolReference = `---
name: armada-tools
description: Armada launcher tool reference, not an orchestration method.
---
The delegated MCP connection exposes launch, read, message and stop (not the
owner API). Use the tool schemas exposed by that connection:
- launch: {idempotencyKey, selection:{goldenId,harness,credentialId,
  credentialVersion,model,prompt?,repo?,size?,reasoningEffort?}}.
  Select only authorized golden/account references; retain the returned child ID.
- read: {sandboxId}. Poll this to observe child status/results; no wait tool exists.
- message: {idempotencyKey,sandboxId,text}. Send another turn to an owned child.
- stop: {idempotencyKey,sandboxId}. Stop an owned child when needed.
Reuse each mutation's key and identical arguments after an uncertain response.
Authority is limited to this parent's owner/org, allowed accounts/goldens,
owned children, expiry and active-child limits. Never use the owner's API token.
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
    harness?: "claude" | "codex";
    skillpackKey?: () => Promise<string | null>;
    recordReceipt?: (receipt: OrchestratorSkillReceipt | null) => Promise<void>;
    configureAuthority: () => Promise<void>;
    diagnostics?: OrchestratorDiagnostics;
  },
): Promise<OrchestratorSkillReceipt | null> {
  const { sandboxId, projectDir, skill } = request;
  if (
    !projectDir.startsWith("/") ||
    [...projectDir].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    (skill !== undefined &&
      (skill.length > 256 ||
        !ORCHESTRATOR_SKILL_PATTERN.test(skill) ||
        skill.split("/").at(-1)?.startsWith("armada-tools@")))
  ) {
    request.diagnostics?.captureReason("skill_configuration_invalid");
    throw new Error("orchestrator_invalid_bootstrap");
  }
  const referenceDir = `${projectDir}/${request.harness === "claude" ? ".claude" : ".agents"}/skills/armada-tools`;
  const referenceFile = quote(`${referenceDir}/SKILL.md`);
  // Never follow a redirected destination or overwrite an unrelated package.
  const referenceCommand = `test ! -L ${quote(referenceDir)} && mkdir -p ${quote(referenceDir)} && if test -e ${referenceFile}; then test ! -L ${referenceFile} && test "$(cat ${referenceFile})" = "$(printf '%s' ${quote(toolReference)})"; else (set -C; printf '%s' ${quote(toolReference)} > ${referenceFile}); fi`;
  let receipt: OrchestratorSkillReceipt | null = null;
  let validatingReceipt = false;
  try {
    const [reference, version] = skill?.split("@") ?? [];
    const privateSkill = skill !== undefined && !skill.includes("/");
    if (privateSkill)
      receipt = await installPrivateSkill(provider, {
        sandboxId,
        projectDir,
        reference: skill,
        harness: request.harness ?? "codex",
        key: (await request.skillpackKey?.()) ?? null,
      });
    const publicSkill = skill && !privateSkill;
    const result = await provider.exec({
      sandboxId,
      cwd: projectDir,
      timeoutSeconds: 300,
      command: publicSkill
        ? `skillpack install ${quote(reference!)} --version ${quote(version!)} --api-url https://skillpack.app/v1 --scope project --project ${quote(projectDir)} --tools ${request.harness === "claude" ? "claude-code" : "codex"} --pin --yes --json >/dev/null && ${referenceCommand} && cat ${quote(`${projectDir}/.companion/skills.lock.json`)}`
        : referenceCommand,
    });
    if (result.detached || result.timedOut || result.truncated || result.exitCode !== 0) {
      request.diagnostics?.captureReason(
        result.detached
          ? "skill_execution_detached"
          : result.timedOut
            ? "skill_install_timeout"
            : result.truncated
              ? "skill_output_truncated"
              : result.exitCode === 127
                ? "skill_command_missing"
                : "skill_install_nonzero",
      );
      throw new Error("install_failed");
    }
    if (publicSkill) {
      validatingReceipt = true;
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
    }
  } catch (error) {
    if (error instanceof PrivateSkillError) request.diagnostics?.captureReason(error.reason);
    else if (validatingReceipt) request.diagnostics?.captureReason("skill_provenance_missing");
    else request.diagnostics?.capture(error);
    if (error instanceof PrivateSkillError) throw error;
    throw new Error("orchestrator_skill_bootstrap_failed");
  }
  await request.recordReceipt?.(receipt);
  await request.configureAuthority();
  return receipt;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
