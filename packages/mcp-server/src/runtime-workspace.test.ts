import { expect, test } from "bun:test";
import { modalLaunchSetupTimer } from "./jobs/modal-launch-setup.ts";
import { runtimeWorkspace } from "./runtime-workspace.ts";

test("Modal workspace timing attributes a failed init wait to its command", async () => {
  let now = 0;
  const events: unknown[] = [];
  const identity = { sandboxId: "sandbox", jobId: "setup", generation: "1", attempt: 2 };
  const timePhase = modalLaunchSetupTimer(
    identity,
    () => now,
    (line) => events.push(JSON.parse(line)),
  );
  const failure = new Error("Runtime command unavailable");
  const workspace = runtimeWorkspace(
    {
      actor: { userId: "owner", orgId: "org", role: "member" },
      host: { id: "modal" },
      sandbox: { id: "sandbox", providerSandboxId: "machine" },
      credentials: { secrets: [] },
    },
    {
      async workspaceHealth() {
        now += 2;
      },
      async workspaceExec(_request, { phase }) {
        if (phase === "init") {
          now += 85_000;
          throw failure;
        }
        now += 14;
        return { detached: false, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
      },
    },
    "epoch",
    {
      async prepareLaunch() {
        now += 5;
        return { status: "not_connected", message: "GitHub is unavailable." };
      },
    },
    {
      assertClaim: async () => {},
      trackPushes: true,
      healthRequestId: "health",
      timeStep: (step) => timePhase("workspace", step),
    },
  );

  await expect(
    workspace.prepareWorkspace(
      {
        config: {
          repos: [{ url: "https://github.com/example/repo", branch: "main", dir: "repo" }],
          init: ["echo ready"],
        },
      },
      () => {},
    ),
  ).rejects.toBe(failure);

  const base = { ...identity, event: "modal_launch_setup_phase", phase: "workspace" };
  expect(events).toEqual([
    { ...base, step: "runtime_health", state: "started" },
    { ...base, step: "runtime_health", state: "finished", durationMs: 2 },
    { ...base, step: "github_prepare", state: "started" },
    { ...base, step: "github_prepare", state: "finished", durationMs: 5 },
    { ...base, step: "repository", index: 0, commandAttempt: 0, state: "started" },
    { ...base, step: "repository", index: 0, commandAttempt: 0, state: "finished", durationMs: 14 },
    { ...base, step: "init", index: 0, commandAttempt: 0, state: "started" },
    { ...base, step: "init", index: 0, commandAttempt: 0, state: "finished", durationMs: 85_000 },
  ]);
});
