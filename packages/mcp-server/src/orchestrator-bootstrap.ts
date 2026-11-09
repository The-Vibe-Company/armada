import type { Provider } from "@armada/core";

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
  },
): Promise<OrchestratorSkillReceipt> {
  const { sandboxId, projectDir, skillRevision: revision } = request;
  if (
    !/^[a-f0-9]{40}$/.test(revision) ||
    !projectDir.startsWith("/") ||
    [...projectDir].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error("orchestrator_invalid_bootstrap");
  }
  const source = `https://github.com/The-Vibe-Company/armada/tree/${revision}/.agents/skills`;
  let installed = false;
  try {
    const result = await provider.exec({
      sandboxId,
      command: `armada skill install --project ${quote(projectDir)} --yes --revision ${quote(revision)}`,
      cwd: projectDir,
      timeoutSeconds: 300,
    });
    installed =
      !result.detached &&
      result.exitCode === 0 &&
      !result.timedOut &&
      !result.truncated &&
      result.stdout.split(/\r?\n/).includes(`Source: ${source}`);
  } catch {
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
