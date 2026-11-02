import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Ticket } from "@armada/protocol";
import { EventStore } from "../src/store.ts";
import { startWorkerSocket } from "../src/workers/socket.ts";
import { fakeWorkers } from "./support/fake-worker.ts";

const at = "2030-01-01T00:00:00.000Z";
const project = "orchard";
const cli = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
async function fixture(t: TestContext, internal = true) {
  const directory = await mkdtemp(join(tmpdir(), "armada-ticket-"));
  const store = new EventStore(":memory:");
  const { workers, launch } = fakeWorkers(store, [{ id: project, repository: "example/orchard" }]);
  const socketPath = join(directory, "worker.sock");
  const socket = await startWorkerSocket(workers, socketPath);
  t.after(async () => {
    await workers.shutdown(project, "Fixture cleanup", () => {});
    await workers.close();
    await socket.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fields = {
    id: "SEED-1",
    title: "Plant the orchard",
    description: "Keep the saplings watered.",
    labels: ["ready-for-agent", "api"],
    parent: "SEED-2",
    blockers: ["SEED-3"],
  };
  for (const id of ["SEED-2", "SEED-3"])
    store.append({
      project,
      at,
      actor: "Mira",
      kind: "ticket.created",
      payload: {
        id,
        title: id === "SEED-2" ? "Orchard specification" : "Prepare the soil",
        description: "Private related-ticket description",
        labels: [],
        state: "completed",
        parent: null,
        blockers: [],
      },
    });
  if (internal)
    store.append({ project, at, actor: "Mira", kind: "ticket.created", payload: { ...fields, state: "unstarted" } });
  else
    store.append({
      project,
      at,
      actor: "Linear",
      kind: "ticket.seen",
      payload: {
        ...fields,
        status: "unstarted",
        blockers: [{ id: "SEED-3", status: "completed" }],
        url: "https://linear.app/example/issue/SEED-1",
        comments: [
          { body: "Later folded comment", author: "Nora", at: "2030-01-01T00:02:00Z" },
          { body: "Middle tied folded comment", author: "Nora", at },
          { body: "Earlier folded comment", author: "Mira", at },
        ],
      },
    });
  const worker = await launch(project, "SEED-1", "worker/seed-1");
  const env = {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: directory,
    ARMADA_WORKER_SOCKET: socketPath,
    ARMADA_WORKER_TOKEN: worker.token,
    ARMADA_TICKET: "SEED-1",
  };
  const run = async (args: string[], token = worker.token) => {
    try {
      const output = await promisify(execFile)("bun", [cli, ...args], {
        cwd: directory,
        env: { ...env, ARMADA_WORKER_TOKEN: token },
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { code: 0, ...output };
    } catch (error) {
      const failed = error as Error & { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  return { store, workers, worker, run };
}

test("an internal worker reads its full ticket and comments through the CLI and socket without tracker keys", async (t) => {
  const f = await fixture(t);
  // Add after launch to prove this reads current state, not the launch brief's excerpts.
  for (let n = 14; n >= 0; n--)
    f.store.append({
      project,
      at: new Date(Date.parse(at) + n * 60000).toISOString(),
      actor: "Mira",
      kind: "ticket.commented",
      payload: {
        ticket: "SEED-1",
        id: `comment-${n}`,
        body: `Comment ${n}: ${n === 0 ? "🌱".repeat(17000) : "Water daily"}`,
        author: "Mira",
      },
    });
  f.store.append({
    project,
    at,
    actor: "Other",
    kind: "ticket.commented",
    payload: {
      ticket: "SEED-1",
      id: "comment-0",
      body: "Duplicate must not replace the original",
      author: "Other",
    },
  });
  f.store.append({
    project,
    at,
    actor: "Elsewhere",
    kind: "ticket.commented",
    payload: {
      ticket: "SEED-2",
      id: "secret",
      body: "Private related-ticket comment",
      author: "Elsewhere",
    },
  });
  const sequence = f.store.sequence;
  const result = await f.run(["ticket"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /# SEED-1 — Plant the orchard/);
  assert.match(result.stdout, /State: unstarted/);
  assert.match(result.stdout, /Labels: ready-for-agent, api/);
  assert.match(result.stdout, /Parent: SEED-2.*completed/);
  assert.match(result.stdout, /SEED-3.*completed/);
  assert.match(result.stdout, /Keep the saplings watered\./);
  assert.match(result.stdout, /Mira.*2030-01-01T00:00:00.000Z/);
  assert.ok(result.stdout.indexOf("Comment 0:") < result.stdout.indexOf("Comment 14:"));
  assert.equal((result.stdout.match(/Comment \d+:/g) ?? []).length, 15);
  assert.ok(result.stdout.includes("🌱".repeat(17000)));
  assert.doesNotMatch(result.stdout, /Private related-ticket|Duplicate must|older comments are in Linear/);
  const json = await f.run(["ticket", "SEED-1", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const ticket = JSON.parse(json.stdout) as Ticket;
  assert.equal(ticket.id, "SEED-1");
  assert.equal(ticket.description, "Keep the saplings watered.");
  assert.equal(ticket.comments?.length, 15);
  assert.equal(ticket.comments?.[0]?.body.startsWith("Comment 0:"), true);
  assert.equal(f.store.sequence, sequence, "ticket reads do not append events");
  assert.equal(
    f.store.fold(project).projects[project]?.tickets.find((ticket) => ticket.id === "SEED-1")?.comments?.length,
    12,
  );
});

test("the socket refuses another ticket only after authenticating the current worker capability", async (t) => {
  const f = await fixture(t);
  const own = await f.run(["ticket"]);
  assert.equal(own.code, 0, own.stderr);
  const refused = await f.run(["ticket", "SEED-2"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /your capability is for SEED-1/);
  assert.equal(refused.stdout, "");
  assert.doesNotMatch(refused.stderr, /Orchard specification|Private related-ticket/);
  const invalid = await f.run(["ticket", "SEED-2"], "invalid-capability");
  assert.equal(invalid.code, 1);
  assert.doesNotMatch(invalid.stderr, /your capability|SEED-1/);
  await f.workers.request(f.worker.token, { command: "release", ticket: "SEED-1", reason: "Finished" });
  const retired = await f.run(["ticket"]);
  assert.equal(retired.code, 1);
  assert.doesNotMatch(retired.stderr, /your capability/);
});

test("a Linear worker prints folded comments oldest first and points to Linear for older comments", async (t) => {
  const f = await fixture(t, false);
  const result = await f.run(["ticket"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.indexOf("Earlier folded comment") < result.stdout.indexOf("Later folded comment"));
  assert.ok(result.stdout.indexOf("Earlier folded comment") < result.stdout.indexOf("Middle tied folded comment"));
  assert.match(result.stdout, /older comments are in Linear/);
  assert.match(result.stdout, /https:\/\/linear.app\/example\/issue\/SEED-1/);
  const json = await f.run(["ticket", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).comments.length, 3);
});
