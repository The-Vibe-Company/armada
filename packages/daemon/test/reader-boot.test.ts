import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { EventStore } from "../src/store.ts";
import { nodeExecutable } from "./support/node.ts";
import { project } from "./support/reader-recordings.ts";

// Exercise the actual source entry point, loader, bundled plugins and SQLite store.
// Only the remote services are replaced; no token or plugin config is saved.
for (const mode of ["environment", "gh", "missing", "unauthorized", "network"] as const) {
  test(`daemon reader boot: ${mode}`, { timeout: 10_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "armada-reader-boot-"));
    const database = join(dir, "fleet.sqlite");
    const projects = join(dir, "projects.json");
    writeFileSync(projects, JSON.stringify([project]));
    if (mode === "gh")
      writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf synthetic-github-environment-secret", { mode: 0o700 });
    const preload = `
      import { github, issue, page } from ${JSON.stringify(new URL("./support/reader-recordings.ts", import.meta.url).href)};
      globalThis.fetch = async (url, init) => {
        const linear = String(url).includes('linear');
        const secret = linear ? process.env.LINEAR_API_KEY : "synthetic-github-environment-secret";
        const expected = linear ? secret : 'Bearer ' + secret;
        if (init.headers.Authorization !== expected) throw new Error('wrong environment credential');
        if (${JSON.stringify(mode)} === 'unauthorized') return Response.json({ errors: [{ message: secret }] }, {status: 401});
        if (${JSON.stringify(mode)} === 'network') throw new TypeError('private transport detail ' + secret + '\\nforged log line');
        const {query} = JSON.parse(init.body);
        const operation = /query\\s+(\\w+)/.exec(query)?.[1];
        const data = operation === 'Root' ? {issue: issue('SEED-1')} :
          operation === 'Children' ? {issues: page([])} :
          operation === 'Comments' ? {issues: {nodes: [{identifier: 'SEED-1', comments: page([])}]}} : github;
        return Response.json({data});
      };
    `;
    const child = spawn(
      nodeExecutable,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        new URL("../src/server/main.ts", import.meta.url).pathname,
        "--database",
        database,
        "--projects",
        projects,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ARMADA_APP_CONFIG: join(dir, "config.json"),
          XDG_CONFIG_HOME: dir,
          PATH: dir, // No owner gh session in missing-credential coverage.
          LINEAR_API_KEY: mode === "missing" ? "" : "synthetic-linear-environment-secret",
          GITHUB_TOKEN: mode === "missing" || mode === "gh" ? "" : "synthetic-github-environment-secret",
        },
      },
    );
    const exited = once(child, "exit");
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    const lines = createInterface({ input: child.stdout });
    t.after(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
      lines.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const [line] = await Promise.race([
      once(lines, "line"),
      exited.then(() => {
        throw new Error(`daemon exited before readiness: ${errors}`);
      }),
    ]);
    const ready = JSON.parse(line);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    const store = new EventStore(database);
    try {
      const kinds = store.readSince(0).map((event) => event.kind);
      if (mode === "environment" || mode === "gh") {
        assert.deepEqual(ready.readers, [{ project: project.id, tracker: true, forge: true }]);
        assert.ok(kinds.includes("ticket.seen"), "environment token ingests Linear facts");
        assert.ok(kinds.includes("pull-request.opened"), "environment token ingests GitHub facts");
      } else {
        const reason =
          mode === "missing"
            ? ["Linear key missing", "GitHub credentials unavailable"]
            : mode === "unauthorized"
              ? ["Linear answered 401", "GitHub answered 401"]
              : ["Linear network request failed", "GitHub network request failed"];
        assert.deepEqual(ready.readers, [
          { project: project.id, tracker: false, forge: false, trackerError: reason[0], forgeError: reason[1] },
        ]);
        for (const message of reason) assert.ok(errors.includes(message), `log explains ${message}`);
        assert.deepEqual(
          kinds.filter((kind) => kind !== "coordinator.checkpoint"),
          [],
        );
        const checkpoints = store.readSince(0).filter((event) => event.kind === "coordinator.checkpoint");
        if (mode === "missing") assert.equal(checkpoints.length, 0);
        else assert.equal(checkpoints.length, 1, "failed requests retain usage without declaring a successful read");
        assert.equal((await import("../src/fold.ts")).fold(store.readSince(0)).projects[project.id]?.readAt, undefined);
      }
      assert.doesNotMatch(
        errors + line + JSON.stringify(store.readSince(0)),
        /synthetic-(?:linear|github)-environment-secret|private transport detail|forged log line/,
      );
    } finally {
      store.close();
    }
  });
}

test("runtime-added projects share the host's Linear cooldown while another daemon stays isolated", async (t) => {
  const { bootDaemon } = await import("../src/boot.ts");
  const { BUNDLED_PLUGINS } = await import("../src/plugins/catalog.ts");
  const { issue, page } = await import("./support/reader-recordings.ts");
  const dir = mkdtempSync(join(tmpdir(), "armada-reader-quota-"));
  let daemon: Awaited<ReturnType<typeof bootDaemon>> | undefined;
  let other: Awaited<ReturnType<typeof bootDaemon>> | undefined;
  t.after(() => {
    daemon?.close();
    other?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests++;
    if (requests === 1) return new Response("withheld", { status: 429, headers: { "Retry-After": "120" } });
    const operation = /query\s+(\w+)/.exec(JSON.parse(String(init?.body)).query)?.[1];
    return Response.json({
      data:
        operation === "Root"
          ? { issue: issue("SEED-1") }
          : operation === "Comments"
            ? { issues: { nodes: [{ identifier: "SEED-1", comments: page([]) }] } }
            : { issues: page([]), comments: page([]) },
    });
  });
  const options = {
    databasePath: ":memory:",
    catalog: BUNDLED_PLUGINS.filter((p) => p.id === "linear"),
    secrets: { get: async () => "synthetic-key" },
    log: { info() {}, error() {} },
  };
  daemon = await bootDaemon({ ...options, configPath: join(dir, "first.json"), projects: [project] });
  const first = daemon.registry.get("tracker", "linear", project.id);
  assert.ok(first);
  const pause = await first.read({ project: project.id });
  assert.ok(pause?.pausedUntil);
  await daemon.addProject({
    ...project,
    id: "garden",
    root: dir,
    phaseGroup: "Agent phase",
    tracker: "linear",
    forge: "github",
  });
  const added = daemon.registry.get("tracker", "linear", "garden");
  assert.ok(added);
  assert.equal((await added.read({ project: "garden" }))?.pausedUntil, pause.pausedUntil);
  assert.equal(requests, 1, "adding a scoped provider does not bypass the same credential's pause");
  other = await bootDaemon({
    ...options,
    configPath: join(dir, "other.json"),
    projects: [{ ...project, id: "other" }],
  });
  const isolated = other.registry.get("tracker", "linear", "other");
  assert.ok(isolated);
  await isolated.read({ project: "other" });
  assert.equal(requests, 4, "another daemon reads its independent store instead of inheriting process-global state");
});
