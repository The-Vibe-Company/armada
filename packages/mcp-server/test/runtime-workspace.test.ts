import { expect, test } from "bun:test";
import { type GoldenRecord, parseGoldenConfig } from "@armada/core/server";
import { runtimeWorkspace } from "../src/runtime-workspace.ts";

// Real workspace policy, fake private command transport: no process/provider I/O.
// Protects health -> GitHub -> pull -> init ordering and failure short-circuiting.
test.each(["success", "health", "github", "repository", "init"] as const)(
  "enrolled Modal workspace setup preserves epoch-bound ordering (%s)",
  async (failure) => {
    const order: string[] = [];
    const golden: GoldenRecord = {
      id: "golden",
      orgId: "org",
      ownerId: "owner",
      name: "workspace",
      visibility: "private",
      provider: "modal",
      providerSandboxId: "master",
      providerSnapshotId: "image",
      modal: { workspace: "ws", environment: "main", appId: "app" },
      createdAt: "2026-11-14T00:00:00Z",
      config: parseGoldenConfig({
        repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
        init: ["bun install"],
      }),
    };
    const signal = new AbortController().signal;
    const prepared = runtimeWorkspace(
      {
        host: {
          id: "modal",
          async exec() {
            throw Error("Native exec must never run");
          },
        },
        actor: { userId: "owner", orgId: "org", role: "member" },
        sandbox: { id: "logical", providerSandboxId: "physical" },
        credentials: { secrets: [] },
        signal,
      },
      {
        async workspaceHealth(epoch, admission) {
          expect([epoch, admission]).toEqual(["7", signal]);
          order.push("health");
          if (failure === "health") throw Error("old_runtime");
        },
        async workspaceExec(request, step, epoch, admission) {
          expect([epoch, admission, request.sandboxId, step.index, step.attempt]).toEqual([
            "7",
            signal,
            "physical",
            0,
            0,
          ]);
          expect(request.timeoutSeconds).toBe(600);
          order.push(step.phase);
          return {
            detached: false,
            stdout: "",
            stderr: "",
            exitCode: failure === step.phase ? 1 : 0,
            timedOut: false,
            truncated: false,
          };
        },
      },
      "7",
      {
        async prepareLaunch(caller, id) {
          expect([caller.userId, caller.orgs, id]).toEqual(["owner", [{ orgId: "org", role: "member" }], "logical"]);
          order.push("github");
          if (failure === "github") throw Error("github_denied");
          return { status: "connected", login: "owner" };
        },
      },
    );
    const work = prepared.prepareWorkspace!(
      golden,
      () => {},
      async () => {
        throw Error("No wall-clock retries");
      },
    );
    if (failure === "success") expect(await work).toMatchObject({ status: "connected", login: "owner" });
    else await expect(work).rejects.toThrow();
    const phases = ["health", "github", "repository", "init"];
    expect(order).toEqual(failure === "success" ? phases : phases.slice(0, phases.indexOf(failure) + 1));
  },
);
