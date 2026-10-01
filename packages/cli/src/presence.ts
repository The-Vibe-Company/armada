import type { ArmadaConfig, CoordinatorFacts, Credentials } from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import type { Io } from "./io.ts";
import { liveFleet } from "./worker.ts";

export function detectCoordinator(io: Io): CoordinatorFacts {
  const read = (name: string) => io.env[name]?.trim() || null;
  const workspace = read("CONDUCTOR_WORKSPACE_ID");
  const harness = workspace
    ? "conductor-cloud"
    : read("CLAUDECODE")
      ? "claude-code"
      : ["CODEX_THREAD_ID", "CODEX_CI", "CODEX_SANDBOX_ENV", "CODEX_SESSION_ID"].some(read)
        ? "codex"
        : "terminal";
  const handle =
    read("ARMADA_COORDINATOR_HANDLE") ??
    (workspace
      ? [workspace, read("CONDUCTOR_SESSION_ID")].filter(Boolean).join("/")
      : [io.machineName, io.ttyName].filter(Boolean).join("/") || null);
  const model =
    harness === "conductor-cloud"
      ? (read("CONDUCTOR_MODEL") ?? read("CODEX_MODEL") ?? read("CLAUDE_MODEL"))
      : harness === "claude-code"
        ? (read("CLAUDE_MODEL") ?? read("ANTHROPIC_MODEL"))
        : harness === "codex"
          ? (read("CODEX_MODEL") ?? read("OPENAI_MODEL"))
          : null;
  return { harness, handle, model, cliVersion: version };
}

export async function recordPresence(io: Io, config: ArmadaConfig, credentials: Credentials): Promise<void> {
  if (!credentials.armadaSignIn || credentials.armadaSignIn.kind === "worker") return;
  const { fleet, warning } = liveFleet(io, config, credentials);
  try {
    if (!fleet) throw new Error(warning ?? "Armada is unreachable");
    await fleet.coordinator(detectCoordinator(io));
  } catch (error) {
    io.stderr(
      `armada: warning: could not record coordinator activity (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }
}
