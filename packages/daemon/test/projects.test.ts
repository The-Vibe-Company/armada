import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import type { ArmadaPlugin, PluginContext } from "@armada/plugin-api";
import { type ServerMessage, serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { bootDaemon } from "../src/boot.ts";
import { type DaemonProject, inspectProject, Projects } from "../src/projects.ts";
import { startServer } from "../src/server/index.ts";
import { dispatchProjects } from "../src/server/projects.ts";
import { startReaders } from "../src/server/readers.ts";
import { Workers } from "../src/workers/service.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "armada-projects-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}
async function repo(dir: string, name: string, remote: string) {
  const path = join(dir, name);
  await fs.mkdir(path);
  git(path, "init", "-q", "-b", "main");
  git(path, "remote", "add", "origin", remote);
  await fs.writeFile(join(path, "README.md"), "example\n");
  git(path, "add", ".");
  git(
    path,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Initial",
  );
  return path;
}
const toml = `[project]\nname="Example"\nslug="example"\n[tracker]\nprogram_root="EX-1"\nready_label="launchable"\n[tracker.labels]\nphase_group="Work phase"\nruntime_group="Worker runtime"\n[github]\nrepository="example/configured"\n`;

test("inspection reads Git SSH/HTTPS and TOML without changing the folder", async (t) => {
  const dir = await fixture(t);
  for (const remote of ["git@github.com:example/project.git", "https://github.com/example/project.git"]) {
    const path = await repo(dir, remote.startsWith("git@") ? "Project SSH" : "Project HTTPS", remote);
    const inspected = await inspectProject(path);
    assert.deepEqual(inspected.git, { remote: "example/project", branch: "main", clean: true });
    assert.equal(inspected.toml, null);
    assert.deepEqual(inspected.suggested, {
      id: basename(path).toLowerCase().replace(/ /g, "-"),
      name: basename(path),
      repository: "example/project",
    });
    assert.deepEqual(inspected.problems, []);
    await fs.writeFile(join(path, "armada.toml"), toml);
    const before = git(path, "status", "--porcelain");
    const configured = await inspectProject(path);
    assert.deepEqual(configured.toml, {
      programRoot: "EX-1",
      phaseGroup: "Work phase",
      runtimeGroup: "Worker runtime",
      readyLabel: "launchable",
      repository: "example/configured",
    });
    assert.equal(configured.suggested.programRoot, "EX-1");
    assert.equal(configured.git?.clean, false);
    assert.equal(git(path, "status", "--porcelain"), before);
    assert.equal(await fs.readFile(join(path, "armada.toml"), "utf8"), toml);
  }
});

test("inspection names non-Git, invalid TOML and missing-folder problems", async (t) => {
  const dir = await fixture(t);
  const folder = await inspectProject(dir);
  assert.equal(folder.git, null);
  assert.ok(folder.problems.some((p) => /git/i.test(p)));
  await fs.writeFile(join(dir, "armada.toml"), "[broken");
  const invalid = await inspectProject(dir);
  assert.equal(invalid.toml, null);
  assert.ok(invalid.problems.some((p) => /toml/i.test(p)));
  const missing = await inspectProject(join(dir, "missing"));
  assert.equal(missing.git, null);
  assert.ok(missing.problems.some((p) => /folder/i.test(p)));
});

test("registry serializes additions, rejects duplicate identities and roots, and persists confirmed metadata", async (t) => {
  const dir = await fixture(t);
  const path = await repo(dir, "source", "git@github.com:example/source.git");
  await fs.writeFile(join(path, "armada.toml"), toml);
  const file = join(dir, "projects.json");
  const started: unknown[] = [];
  const registry = await Projects.open(file, {
    start: async (p) => {
      started.push(p);
    },
    stop: async () => {},
  });
  const input = { path, id: "source", name: "Source", repository: "example/source", programRoot: "EX-1" };
  await registry.add(input);
  assert.equal(started.length, 1);
  assert.equal(registry.list[0]?.root, path);
  assert.equal(registry.list[0]?.readyLabel, "launchable");
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), registry.list);
  await assert.rejects(registry.add(input), /id.*exists/i);
  await assert.rejects(registry.add({ ...input, id: "other" }), /root|folder.*registered/i);
  const alias = join(dir, "alias");
  await fs.symlink(path, alias);
  await assert.rejects(registry.add({ ...input, id: "alias", path: alias }), /root|folder.*registered/i);
  await assert.rejects(registry.add({ ...input, id: "bad", repository: "malformed" }), /repository/i);
  await assert.rejects(registry.add({ ...input, id: "missing", path: join(dir, "missing") }), /folder/i);
  const reopened = await Projects.open(file, { start: async () => {}, stop: async () => {} });
  assert.deepEqual(reopened.list, registry.list);
  const other = await repo(dir, "other", "https://github.com/example/other");
  const attempts = await Promise.allSettled([
    registry.add({ ...input, id: "concurrent", path: other }),
    registry.add({ ...input, id: "concurrent", path: other }),
  ]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(registry.list.length, 2);
});

test("a failure before atomic rename keeps the old file and rolls back started services", async (t) => {
  const dir = await fixture(t);
  const path = await repo(dir, "source", "git@github.com:example/source.git");
  const file = join(dir, "projects.json");
  await fs.writeFile(file, "[]\n");
  const calls: string[] = [];
  const registry = await Projects.open(file, {
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
  });
  const rename = t.mock.method(fs, "rename", async () => {
    throw new Error("simulated interruption before rename");
  });
  await assert.rejects(
    registry.add({ path, id: "source", name: "Source", repository: "example/source" }),
    /interruption/,
  );
  rename.mock.restore();
  assert.equal(await fs.readFile(file, "utf8"), "[]\n");
  assert.deepEqual(calls, ["start", "stop"]);
  assert.deepEqual(registry.list, []);
  const reopened = await Projects.open(file, { start: async () => {}, stop: async () => {} });
  assert.deepEqual(reopened.list, []);
  await registry.add({ path, id: "source", name: "Source", repository: "example/source" });
  const committed = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(committed, registry.list, "minimal projects survive JSON persistence without undefined fields");
  const restored = await Projects.open(file, { start: async () => {}, stop: async () => {} });
  assert.deepEqual(restored.list, registry.list);
});

// Exercise project mutations over the transport and the real plugin/reader/coordinator services.
// External provider reads and the model are fake; admission, persistence and lifetimes are real.
test("live add opens configured readers and coordinator; removal refuses active workers and keeps history", {
  timeout: 15_000,
}, async (t) => {
  const dir = await fixture(t);
  const path = await repo(dir, "source", "git@github.com:example/source.git");
  await fs.writeFile(join(path, "armada.toml"), toml);
  const configurations: PluginContext["config"][] = [];
  const reads: string[] = [];
  const timers = new Set<() => void>();
  const contributions = Object.fromEntries(
    ["tracker", "forge", "node"].map((seam) => [
      seam,
      {
        [seam === "tracker" ? "linear" : seam === "forge" ? "github" : "local"]: {
          config: { type: "object" },
          secrets: [],
        },
      },
    ]),
  );
  const daemon = await bootDaemon({
    databasePath: join(dir, "events.sqlite"),
    configPath: join(dir, "config.json"),
    secrets: { get: async () => null },
    log: {
      info() {},
      error(line) {
        throw new Error(line);
      },
    },
    catalog: [
      {
        id: "project-providers",
        manifest: {
          id: "project-providers",
          version: "1.0.0",
          pluginApi: "^0.2.0",
          enabledByDefault: true,
          description: "Synthetic project readers",
          contributions,
        },
        load: async (): Promise<ArmadaPlugin> => ({
          activate(ctx) {
            configurations.push(ctx.config);
            ctx.register.tracker("linear", {
              read: async ({ project }) => {
                reads.push(`tracker:${project}`);
              },
              write: async () => {},
            });
            ctx.register.forge("github", {
              read: async ({ project }: { project: string }) => {
                reads.push(`forge:${project}`);
              },
            } as never);
            ctx.register.node("local", {} as never);
          },
        }),
      },
    ],
  });
  const faux = fauxProvider({ models: [{ id: "project-model" }] });
  faux.setResponses([fauxAssistantMessage("Project coordinator is ready")]);
  const models = createModels();
  models.setProvider(faux.provider);
  let server: Awaited<ReturnType<typeof startServer>>;
  const groups = new Map<string, Awaited<ReturnType<typeof startReaders>>>();
  let workers: Workers;
  const file = join(dir, "projects.json");
  const registry = await Projects.open(file, {
    async start(p) {
      await daemon.addProject(p);
      const readers = await startReaders({
        registry: daemon.registry,
        store: daemon.store,
        projects: [p],
        schedule(callback) {
          timers.add(callback);
          return () => {
            timers.delete(callback);
          };
        },
      });
      groups.set(p.id, readers);
      await readers.ready;
      await server.openProject({
        project: p.id,
        models,
        model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
        setTimer: () => () => {},
      });
    },
    async stop(p) {
      groups.get(p.id)?.stop();
      groups.delete(p.id);
      await server.closeProject(p.id);
      daemon.removeProject(p.id);
    },
    removing: (project, action) => workers.removingProject(project, action),
  });
  workers = new Workers({
    store: daemon.store,
    registry: daemon.registry,
    get projects() {
      return registry.list as (DaemonProject & { checkout: string })[];
    },
    socketPath: join(dir, "socket"),
  });
  server = await startServer({ store: daemon.store, projects: [], projectRegistry: registry, workers });
  const ws = new WebSocket(server.wsUrl);
  const messages: ServerMessage[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (data) => {
    const message: ServerMessage = JSON.parse(String(data));
    serverMessageSchema.parse(message);
    messages.push(message);
    wake?.();
  });
  t.after(async () => {
    ws.close();
    for (const r of groups.values()) r.stop();
    await server.close();
    await workers.close();
    daemon.close();
  });
  await once(ws, "open");
  let counter = 0;
  async function ask(body: Record<string, unknown>): Promise<ServerMessage> {
    const id = `request-${++counter}`;
    ws.send(JSON.stringify({ ...body, version, id }));
    for (;;) {
      const index = messages.findIndex((m) => "id" in m && m.id === id);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const added = await ask({
    type: "projects.add",
    projectId: "source",
    path,
    name: "Source",
    repository: "example/source",
    programRoot: "EX-1",
  });
  assert.equal(added.type, "projects.result");
  if (added.type === "projects.result")
    assert.deepEqual(
      Object.keys(added.projects[0] ?? {}).sort(),
      ["id", "name", "repository", "root"],
      "mutation replies expose the same public fields as projects.list",
    );
  assert.ok(messages.some((m) => m.type === "projects.result" && m.id === "projects-changed"));
  assert.deepEqual(reads.sort(), ["forge:source", "tracker:source"]);
  assert.equal(timers.size, 2);
  assert.deepEqual(configurations.at(-1)?.tracker?.linear, {
    projects: {
      source: {
        programRoot: "EX-1",
        phaseGroup: "Work phase",
        runtimeGroup: "Worker runtime",
        readyLabel: "launchable",
      },
    },
  });
  assert.deepEqual(configurations.at(-1)?.forge?.github, { projects: { source: { repository: "example/source" } } });
  assert.deepEqual(configurations.at(-1)?.node?.local, { projects: { source: { root: path } } });
  const coordinator = server.coordinators.get("source");
  assert.ok(coordinator);
  const submission = await coordinator.conversation.submit({ type: "input", content: "Are you ready?" }, context);
  assert.equal((await submission.wait(context)).status, "done");
  const at = "2030-01-01T00:00:00.000Z";
  daemon.store.append({
    project: "source",
    at,
    actor: "worker",
    kind: "session.claimed",
    payload: {
      ticket: "EX-2",
      session: "worker-1",
      generation: 1,
      owner: "default",
      runtime: "codex",
      handle: "local-1",
    },
  });
  const refused = await ask({ type: "projects.remove", project: "source" });
  assert.equal(refused.type, "error");
  if (refused.type === "error") assert.match(refused.message, /worker in flight/);
  assert.ok(server.coordinators.has("source"));
  assert.equal(registry.list.length, 1);
  daemon.store.append({
    project: "source",
    at,
    actor: "worker",
    kind: "session.released",
    payload: { ticket: "EX-2", session: "worker-1", reason: "Complete" },
  });
  const history = daemon.store.readSince(0, "source");
  const removed = await ask({ type: "projects.remove", project: "source" });
  assert.equal(removed.type, "projects.result");
  assert.deepEqual(registry.list, []);
  assert.equal(server.coordinators.size, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(daemon.store.readSince(0, "source").slice(0, history.length), history);
  const historical = await ask({ type: "session.read", project: "source", sessionId: "worker-1" });
  assert.equal(historical.type, "session.result");
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), []);
});

test("host project scope clears stale saved roots while keeping provider options", async (t) => {
  const dir = await fixture(t);
  const configPath = join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      plugins: [
        {
          id: "scoped-tracker",
          config: {
            tracker: {
              linear: {
                endpoint: "https://linear.example.invalid",
                projects: { source: { programRoot: "OLD-1", runtimeGroup: "Old runtime" } },
              },
            },
          },
        },
      ],
    }),
  );
  const configs: unknown[] = [];
  const daemon = await bootDaemon({
    databasePath: join(dir, "store.sqlite"),
    configPath,
    projects: [],
    secrets: { get: async () => null },
    log: {
      info() {},
      error(line) {
        throw new Error(line);
      },
    },
    catalog: [
      {
        id: "scoped-tracker",
        manifest: {
          id: "scoped-tracker",
          version: "1.0.0",
          pluginApi: "^0.2.0",
          description: "Synthetic scoped tracker",
          enabledByDefault: true,
          contributions: { tracker: { linear: { config: { type: "object" }, secrets: [] } } },
        },
        load: async () => ({
          activate(ctx) {
            configs.push(ctx.config.tracker?.linear);
            ctx.register.tracker("linear", { read: async () => {}, write: async () => {} });
          },
        }),
      },
    ],
  });
  t.after(() => daemon.close());
  await daemon.addProject({
    id: "source",
    name: "Source",
    repository: "example/source",
    root: dir,
    phaseGroup: "Agent phase",
    tracker: "linear",
    forge: "github",
  });
  assert.deepEqual(configs.at(-1), { endpoint: "https://linear.example.invalid", projects: {} });
  assert.deepEqual(configs[0], configs.at(-1));
});

test("failed removal recovery preserves the committed registry and blocks queued mutations with an actionable error", async (t) => {
  const dir = await fixture(t);
  const first = join(dir, "first");
  const second = join(dir, "second");
  await fs.mkdir(first);
  await fs.mkdir(second);
  const file = join(dir, "projects.json");
  const live = new Set<string>();
  let failRecovery = false;
  const registry = await Projects.open(file, {
    async start(p) {
      live.add(p.id);
      if (failRecovery) throw new Error("synthetic private provider failure");
    },
    async stop(p) {
      live.delete(p.id);
    },
  });
  const input = { id: "first", name: "First", path: first, repository: "example/first" };
  await registry.add(input);
  assert.equal(live.size, 1);
  const before = await fs.readFile(file, "utf8");
  let notifications = 0;
  registry.subscribe(() => {
    notifications++;
  });
  failRecovery = true;
  const rename = t.mock.method(fs, "rename", async () => {
    throw new Error("simulated rename refusal");
  });
  const removal = registry.remove("first");
  const queued = registry.add({ id: "second", name: "Second", path: second, repository: "example/second" });
  await assert.rejects(removal, /restart the daemon/i);
  await assert.rejects(queued, /restart the daemon/i);
  rename.mock.restore();
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal(registry.list[0]?.id, "first");
  assert.equal(notifications, 0);
  assert.equal(live.size, 0);
  const reply = await dispatchProjects({ type: "projects.remove", version, id: "retry", project: "first" }, registry);
  assert.equal(reply.type, "error");
  if (reply.type === "error") {
    assert.match(reply.message, /restart the daemon/i);
    assert.doesNotMatch(reply.message, /private provider/);
  }
});

test("failed add compensation leaves the file unchanged and latches recovery instead of admitting another mutation", async (t) => {
  const dir = await fixture(t);
  const file = join(dir, "projects.json");
  await fs.writeFile(file, "[]\n");
  const registry = await Projects.open(file, {
    async start() {
      throw new Error("partial provider startup");
    },
    async stop() {
      throw new Error("cleanup refused");
    },
  });
  const input = { id: "new", name: "New", path: dir, repository: "example/new" };
  await assert.rejects(registry.add(input), /restart the daemon/i);
  await assert.rejects(registry.add(input), /restart the daemon/i);
  assert.equal(await fs.readFile(file, "utf8"), "[]\n");
  assert.deepEqual(registry.list, []);
});
