import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinePaths, readCoordinatorName } from "@armada/core";
import { ARMADA_URL, DEMO_TOML, fakeArmada, NOW } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";
import { coordinatorName } from "../src/coordinator.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("use persists the project checkout role without sign-in; environment takes precedence and invalid names refuse", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-coordinators-"));
  dirs.push(home);
  const output: string[] = [];
  const io: Io = {
    cwd: "/work/widgets/subfolder",
    env: { XDG_CONFIG_HOME: home },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    fetch: async () => {
      throw new Error("use must not use the network");
    },
    stdout: (text) => output.push(text),
    stderr: () => {},
    ghToken: () => null,
  };
  expect(await coordinatorName(io, "widgets")).toBe("default");
  expect(await run(["coordinator", "use", "front"], io)).toBe(0);
  const paths = machinePaths(io.env);
  if (!paths) throw new Error("no paths");
  expect(await readCoordinatorName(paths, "widgets", "/work/widgets")).toBe("front");
  expect(await coordinatorName(io, "widgets")).toBe("front");
  expect(await coordinatorName(io, "widgets", "/work/other")).toBe("default");
  io.env.ARMADA_COORDINATOR = "back";
  expect(await coordinatorName(io, "widgets")).toBe("back");
  expect(await run(["coordinator", "use", "new"], io)).toBe(0);
  expect(output.join("")).toContain("ARMADA_COORDINATOR selects back");
  expect(await run(["coordinator", "use", "Bad_Name"], io)).toBe(2);
  expect(await readCoordinatorName(paths, "widgets", "/work/widgets")).toBe("new");
});

test("list shows sessions and tickets; take refuses another owner without matching from", async () => {
  const armada = fakeArmada({ keys: { "synthetic-coordinator-key": "coordinator" } });
  const output: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: {
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: "synthetic-coordinator-key",
      ARMADA_COORDINATOR: "back",
      LINEAR_API_KEY: "synthetic",
    },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    fetch: armada.fetch,
    stdout: (text) => output.push(text),
    stderr: () => {},
    ghToken: () => null,
    now: () => NOW,
    machineName: "machine",
    ttyName: "tty",
  };
  await armada.store.recordCoordinatorSeen({ project: "widgets", name: "front", handle: "workspace/session", at: NOW });
  await armada.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-7",
    coordinator: "front",
    runtime: "conductor",
    handle: "workspace/worker",
    branch: null,
    at: NOW,
  });
  expect(await run(["coordinator", "list", "--json"], io)).toBe(0);
  expect(JSON.parse(output.join("")).coordinators).toMatchObject([
    { name: "back", sessions: [{ handle: "machine/tty" }] },
    { name: "front", tickets: ["DEMO-7"] },
  ]);
  expect(await run(["coordinator", "take", "DEMO-7"], io)).toBe(1);
  expect(await run(["coordinator", "take", "DEMO-7", "--from", "front"], io)).toBe(0);
  expect((await armada.store.getRuntimeHandle("widgets", "DEMO-7"))?.coordinator).toBe("back");
  expect(armada.calls.some((call) => call.path === "fleet/coordinators/take")).toBe(true);
});
