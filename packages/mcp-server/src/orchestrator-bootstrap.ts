import { ORCHESTRATOR_SKILL_PATTERN, type OrchestratorSkillReceipt, type Provider } from "@armada/core";
import { parseSkillReceipt, skillInstallCommand } from "@armada/core/server";
import type { OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";

const toolReference = `---
name: armada-tools
description: Armada launcher tool reference, not an orchestration method.
---
The delegated MCP connection exposes launch, read, message and stop (not the
owner API). Use the tool schemas exposed by that connection:
- launch: {idempotencyKey, selection:{goldenId,harness,credentialId,
  credentialVersion,model,prompt?,repo?,size?,reasoningEffort?,skills?}}.
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
        skill.split("/")[1]?.startsWith("armada-tools@")))
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
    const result = await provider.exec({
      sandboxId,
      cwd: projectDir,
      timeoutSeconds: 300,
      command: skill
        ? `${skillInstallCommand(skill, projectDir, request.harness ?? "codex")} >/dev/null && ${referenceCommand} && cat ${quote(`${projectDir}/.companion/skills.lock.json`)}`
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
    if (skill) {
      validatingReceipt = true;
      receipt = parseSkillReceipt(result.stdout, skill, request.harness ?? "codex");
    }
  } catch (error) {
    if (validatingReceipt) request.diagnostics?.captureReason("skill_provenance_missing");
    else request.diagnostics?.capture(error);
    throw new Error("orchestrator_skill_bootstrap_failed");
  }
  await request.recordReceipt?.(receipt);
  await request.configureAuthority();
  return receipt;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
