import { expect, test } from "bun:test";
import { NPM_REGISTRY_URL } from "@armada/core";
import { DEMO_TOML } from "../../core/test/support.ts";
import { heard } from "../src/api.ts";
import { run } from "../src/cli.ts";
import type { Exec, Io } from "../src/io.ts";
import { upgrade } from "../src/upgrade.ts";

function terminal(o: { missing?: number; fail?: string; installed?: string; setup?: boolean; doctor?: string } = {}) {
  const calls: string[] = [];
  const waits: number[] = [];
  let checks = 0;
  const exec: Exec = async (command, args, options) => {
    expect(options.cwd).toBe("/work/widgets");
    calls.push([command, ...args].join(" "));
    if (command === "git") return { code: 0, stdout: "/work/widgets\n", stderr: "" };
    if (command === o.fail || args[0] === o.fail) return { code: 1, stdout: "", stderr: "synthetic failure" };
    return {
      code: args[0] === "doctor" && o.setup ? 1 : 0,
      stderr: "",
      stdout:
        args[0] === "--version"
          ? `${o.installed ?? "1.2.4"}\n`
          : args[0] === "doctor"
            ? (o.doctor ??
              JSON.stringify({
                schemaVersion: 1,
                root: "/work/widgets",
                armadaVersion: "1.2.4",
                checks: [
                  {
                    id: "skill:armada-worker",
                    level: o.setup ? "warning" : "ok",
                    fix: o.setup ? "run armada init" : null,
                  },
                  { id: "github-rules", level: "warning", fix: "change branch rules" },
                ],
              }))
            : "",
    };
  };
  const io: Io = {
    cwd: "/work/widgets",
    env: {},
    readFile: async () => null,
    stdout: () => {},
    stderr: () => {},
    ghToken: () => null,
    exec,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async (url) => {
      if (url === NPM_REGISTRY_URL)
        return Response.json({
          "dist-tags": { latest: "1.2.4" },
          versions: {
            "1.2.4": { dist: { tarball: "https://registry.npmjs.org/widgets.tgz" } },
          },
        });
      checks++;
      return new Response(null, { status: checks <= (o.missing ?? 0) ? 404 : 200 });
    },
  };
  return { io, calls, waits };
}

test("upgrade waits for the exact tarball, verifies the installed version and leaves current setup alone", async () => {
  const c = terminal({ missing: 2 });
  expect(await upgrade(c.io, "1.2.3", c.io.cwd)).toBe(0);
  expect(c.waits).toEqual([30_000, 30_000]);
  expect(c.calls).toEqual([
    "npm install -g @the-vibe-company/armada@1.2.4",
    "armada --version",
    "armada doctor --json",
  ]);
});

test("only setup checks from the newly installed doctor trigger init --merge", async () => {
  const c = terminal({ setup: true });
  expect(await upgrade(c.io, "1.2.3", c.io.cwd)).toBe(0);
  expect(c.calls.at(-1)).toBe("armada init --merge");
});

test("publication waits are bounded to five checks and four sleeps, with no install", async () => {
  const c = terminal({ missing: 5 });
  await expect(upgrade(c.io, "1.2.3", c.io.cwd)).rejects.toThrow("npm does not serve Armada 1.2.4");
  expect(c.waits).toEqual([30_000, 30_000, 30_000, 30_000]);
  expect(c.calls).toEqual([]);
});

test("upgrade dispatch uses the selected checkout; workers cannot upgrade", async () => {
  const c = terminal();
  c.io.cwd = "/tmp";
  c.io.readFile = async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null);
  expect(await run(["upgrade", "--config", "/work/widgets/armada.toml"], c.io)).toBe(0);
  const worker = terminal();
  worker.io.env.ARMADA_TICKET = "DEMO-2";
  worker.io.readFile = async () => DEMO_TOML;
  expect(await run(["upgrade"], worker.io)).toBe(2);
  expect(worker.calls).toEqual([]);
});

test("a server-required target wins over lagging npm metadata, and registry outages are bounded", async () => {
  const c = terminal();
  heard(c.io).server = { minimum: "1.2.5", latest: "1.2.6" };
  await expect(upgrade(c.io, "1.2.3", c.io.cwd)).rejects.toThrow("Armada 1.2.6 after 5 checks");
  expect(c.calls).toEqual([]);
  const offline = terminal();
  heard(offline.io).server = { minimum: "1.2.4", latest: "1.2.4" };
  offline.io.fetch = async () => {
    throw new Error("offline");
  };
  await expect(upgrade(offline.io, "1.2.3", offline.io.cwd)).rejects.toThrow("after 5 checks");
  expect(offline.waits).toHaveLength(4);
});

test("the upgraded doctor cannot downgrade skills installed by an even newer CLI", async () => {
  const c = terminal({
    doctor: JSON.stringify({
      schemaVersion: 1,
      root: "/work/widgets",
      armadaVersion: "1.2.4",
      checks: [{ id: "skills-version", level: "warning", fix: "update the CLI, not the skills" }],
    }),
  });
  await expect(upgrade(c.io, "1.2.3", c.io.cwd)).rejects.toThrow("skills require a CLI newer");
  expect(c.calls).not.toContain("armada init --merge");
});

test("selected nested/custom configs are refused before install, and a mismatched doctor cannot refresh setup", async () => {
  for (const path of ["/work/widgets/custom.toml", "/work/widgets/subdir/armada.toml"]) {
    const c = terminal();
    c.io.exec = async (command) => {
      c.calls.push(command);
      return { code: 0, stdout: "/work/widgets\n", stderr: "" };
    };
    c.io.readFile = async () => DEMO_TOML;
    expect(await run(["upgrade", "--config", path], c.io)).toBe(2);
    expect(c.calls).toEqual(["git"]);
  }
  const c = terminal({
    doctor: JSON.stringify({
      schemaVersion: 1,
      armadaVersion: "1.2.4",
      root: "/work/another",
      checks: [{ id: "skill:armada-worker", level: "warning" }],
    }),
  });
  await expect(upgrade(c.io, "1.2.3", c.io.cwd)).rejects.toThrow("doctor could not check setup");
  expect(c.calls).not.toContain("armada init --merge");
});

for (const [options, last] of [
  [{ fail: "npm" }, "npm install -g @the-vibe-company/armada@1.2.4"],
  [{ fail: "--version" }, "armada --version"],
  [{ installed: "1.2.3" }, "armada --version"],
  [{ doctor: "not JSON" }, "armada doctor --json"],
  [{ fail: "doctor" }, "armada doctor --json"],
] as const) {
  test(`upgrade stops safely at ${JSON.stringify(options)}`, async () => {
    const c = terminal(options);
    await expect(upgrade(c.io, "1.2.3", c.io.cwd)).rejects.toThrow();
    expect(c.calls.at(-1)).toBe(last);
    expect(c.calls).not.toContain("armada init --merge");
  });
}
