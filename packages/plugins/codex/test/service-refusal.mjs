// Executed by the Bun owner test on Node: the daemon's real store uses node:sqlite.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fold } from "../../../daemon/src/fold.ts";
import { PluginRegistry } from "../../../daemon/src/plugins/registry.ts";
import { EventStore } from "../../../daemon/src/store.ts";
import { Workers } from "../../../daemon/src/workers/service.ts";
import { createLocalNode } from "../../node-local/src/index.ts";
import { opencodeRuntime } from "../../opencode/src/index.ts";
import { codexRuntime } from "../src/index.ts";

const [kind, root, mode] = process.argv.slice(2);
execFileSync("git", ["init", "--quiet", root]);
execFileSync("git", [
  "-C",
  root,
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.test",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "--allow-empty",
  "-qm",
  "Initial",
]);
const node = createLocalNode({ workspaceRoot: join(root, "worktrees"), transport: "pipe" });
let auth = "no";
let invalidated = false;
const registry = new PluginRegistry();
const registration = registry.activation({
  id: "fixture",
  version: "1.0.0",
  pluginApi: "^0.2.0",
  contributions: { runtime: { [kind]: { config: {}, secrets: [] } }, node: { local: { config: {}, secrets: [] } } },
});
registration.register.node("local", {
  ...node,
  async observe(ref) {
    const observation = await node.observe(ref);
    if (mode === "rules-change" && auth === "no" && !invalidated) {
      invalidated = true;
      const checkpoint = store.readSince(0, project).find((event) => event.kind === "coordinator.checkpoint")
        .payload.checkpoint;
      append("coordinator.checkpoint", { checkpoint: { ...checkpoint, rules: { ...checkpoint.rules, revision: 2 } } });
      throw new Error("Observation interrupted during authentication");
    }
    return observation;
  },
  launch(request) {
    return node.launch({
      ...request,
      env: {
        ...request.env,
        FAKE_AUTH: auth,
        XDG_CONFIG_HOME: join(root, "config"),
        FAKE_RUN_MARKER: join(root, "run"),
      },
    });
  },
});
registration.register.runtime(
  kind,
  (kind === "codex" ? codexRuntime : opencodeRuntime)({
    command: fileURLToPath(new URL(`../../${kind}/test/${kind}-worker.mjs`, import.meta.url)),
  }),
);
registration.commit();
const store = new EventStore(":memory:");
const at = "2030-01-01T00:00:00.000Z";
const project = "sample";
const append = (kind, payload) => store.append({ project, kind, payload, at, actor: "coordinator" });
append("ticket.seen", { id: "EX-1", title: "Example", labels: ["ready-for-agent"], blockers: [], status: "unstarted" });
append("coordinator.checkpoint", {
  checkpoint: {
    format: "armada.tools",
    version: 1,
    type: "rules",
    reason: "Fixture",
    rules: {
      revision: 1,
      value: {
        defaultRoute: { cli: kind, model: "fixture" },
        placement: { workers: "local", coordinator: "local" },
        policy: { maxWorkers: 1 },
      },
    },
  },
});
const workers = new Workers({
  store,
  registry,
  socketPath: join(root, "worker.sock"),
  projects: [{ id: project, repository: "example/sample", checkout: root }],
  now: () => at,
});
try {
  let refusal = "";
  try {
    await workers.tool(
      project,
      "worker.launch",
      { ticket: "EX-1", branch: "worker-test", brief: "brief" },
      "refused",
      () => {},
    );
  } catch (error) {
    refusal = error.message;
  }
  // Retry only the known refusal this fixture exercises. An unexpected failure before a
  // handle is returned intentionally leaves the daemon's launch intent unresolved.
  // Assert the original cause now so a retry cannot replace it with the safety refusal.
  assert.match(
    refusal,
    mode === "rules-change" ? /^Launch prerequisites changed$/ : new RegExp(`^${kind} credentials unavailable;`),
    `Expected a known startup refusal before retry; original launch error: ${refusal || "(none)"}`,
  );
  const sessions = fold(store.readSince(0, project)).projects[project].sessions;
  const remaining = await readdir(join(root, "worktrees"));
  const receipts = store
    .readSince(0, project)
    .filter((event) => event.kind === "coordinator.checkpoint")
    .map((event) => event.payload.checkpoint)
    .filter((checkpoint) => checkpoint.format === "armada.worker" && checkpoint.type === "receipt");
  auth = "yes";
  const retry = await workers.tool(
    project,
    "worker.launch",
    { ticket: "EX-1", branch: "worker-test", brief: "brief" },
    "retry",
    () => {},
  );
  await workers.tool(project, "worker.stop", { ticket: "EX-1", reason: "Fixture finished" }, "stop", () => {});
  console.log(
    JSON.stringify({
      refusal,
      remaining,
      receipts,
      released: sessions[0]?.phase === "released",
      active: sessions.filter((session) => session.phase !== "released" && session.phase !== "merged").length,
      retry: retry.ok,
    }),
  );
} finally {
  await workers.close();
  store.close();
}
