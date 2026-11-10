import type { Provider } from "@armada/core";
import type { OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";

/** Public provenance only; guest output and private authority are never returned or logged. */
export interface OrchestratorSkillReceipt {
  revision: string;
  source: string;
}

/**
 * Runs the existing CLI installer, not a second skill copier. Conflicts fail closed;
 * the installer preserves unrelated files and refuses existing package directories.
 * The caller owns the admission/generation fence and must revalidate it inside
 * configureAuthority. Installation is preparation, never evidence of native continuity.
 */
export async function bootstrapOrchestrator(
  provider: Provider,
  request: {
    sandboxId: string;
    projectDir: string;
    skillRevision: string;
    configureAuthority: () => Promise<void>;
    diagnostics?: OrchestratorDiagnostics;
  },
): Promise<OrchestratorSkillReceipt> {
  const { sandboxId, projectDir, skillRevision: revision } = request;
  if (
    !/^[a-f0-9]{40}$/.test(revision) ||
    !projectDir.startsWith("/") ||
    [...projectDir].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    request.diagnostics?.captureReason("skill_configuration_invalid");
    throw new Error("orchestrator_invalid_bootstrap");
  }
  const source = `https://github.com/The-Vibe-Company/armada/tree/${revision}/.agents/skills`;
  // Public installer-only pin, independent of server rollout/npm release races.
  // Existing goldens need not already contain the Armada CLI; use the same
  // reviewed installer rather than a second copier or unpinned remote script.
  const installer = `install_armada_skills() {
    if command -v armada >/dev/null 2>&1; then armada "$@";
    else npx --yes --ignore-scripts --package @the-vibe-company/armada@2.14.0 armada "$@"; fi
  }`;
  let installed = false;
  try {
    const result = await provider.exec({
      sandboxId,
      command: `${installer}
install_armada_skills skill install --project ${quote(projectDir)} --yes --revision ${quote(revision)}`,
      cwd: projectDir,
      timeoutSeconds: 300,
    });
    if (result.detached) request.diagnostics?.captureReason("skill_execution_detached");
    else if (result.timedOut) request.diagnostics?.captureReason("skill_install_timeout");
    else if (result.truncated) request.diagnostics?.captureReason("skill_output_truncated");
    else if (result.exitCode !== 0)
      request.diagnostics?.captureReason(result.exitCode === 127 ? "skill_command_missing" : "skill_install_nonzero");
    else if (!result.stdout.split(/\r?\n/).includes(`Source: ${source}`))
      request.diagnostics?.captureReason("skill_provenance_missing");
    installed =
      !result.detached &&
      result.exitCode === 0 &&
      !result.timedOut &&
      !result.truncated &&
      result.stdout.split(/\r?\n/).includes(`Source: ${source}`);
  } catch (error) {
    request.diagnostics?.capture(error);
    // Provider/guest diagnostics can include private environment or command output.
    throw new Error("orchestrator_skill_bootstrap_failed");
  }
  if (!installed) throw new Error("orchestrator_skill_bootstrap_failed");
  await request.configureAuthority();
  return { revision, source };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
