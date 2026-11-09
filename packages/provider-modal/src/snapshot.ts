import type { Sandbox } from "modal";
import { refusal } from "./errors.ts";
import type { Machine } from "./ports.ts";
import { scrubSsh } from "./ssh.ts";

/** Caller has already committed the checkpoint's exact durable event ACK. The runner and SSH/user
 * descendants must be dead before unlinking SQLite or native state. Recovery checkpoints keep it. */
export async function prepareFilesystemSnapshot(sandbox: Sandbox, machine: Machine): Promise<void> {
  await scrubSsh(sandbox, machine);
  if (!machine.golden) return;
  await removeManagedState(sandbox);
}

/** No runtime has been started in this incarnation: the registry marker is committed before boot.
 * New logical forks must not inherit a golden's native/journal history; working recovery keeps it. */
export async function prepareFreshFilesystem(sandbox: Sandbox, machine: Machine): Promise<void> {
  if (
    machine.phase !== "booting" ||
    machine.freshStatePreparedGeneration === machine.generation ||
    (!machine.golden && machine.generation !== 1)
  )
    throw refusal("conflict", "Fresh managed-state cleanup is forbidden for admitted or recovery incarnations.");
  await scrubSsh(sandbox, machine);
  await removeManagedState(sandbox);
}
async function removeManagedState(sandbox: Sandbox): Promise<void> {
  const process = await sandbox.exec(
    [
      "bash",
      "-c",
      `set -eu
# Also refuse an unexpected root/legacy writer (or an open directory/cwd) in managed state.
# The lifecycle lease, sealed runner admission and terminated SSH prevent new managed writers.
for entry in /proc/[0-9]*/fd/* /proc/[0-9]*/cwd; do
  target=$(readlink "$entry" 2>/dev/null) || continue
  case "$target" in
    /home/user/.armada-runtime|/home/user/.armada-runtime/*|/home/user/.claude|/home/user/.claude/*|/home/user/.claude.json*|/home/user/.codex|/home/user/.codex/*) exit 1;;
  esac
done
exec /bin/rm -rf -- /home/user/.armada-runtime /home/user/.claude /home/user/.claude.json /home/user/.claude.json.* /home/user/.codex
`,
    ],
    { timeoutMs: 30_000, workdir: "/home/user", env: {}, secrets: [], stdout: "ignore", stderr: "ignore" },
  );
  if ((await process.wait()) !== 0)
    throw refusal("conflict", "Golden runtime history cleanup could not verify quiescence; source retained.");
}
