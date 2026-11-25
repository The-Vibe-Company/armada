import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { countArchitecture } from "../metrics/architecture-counters";
import { machineAdapterPaths } from "../metrics/architecture-rules";
import { compare } from "./ratchets";

const server = "packages/mcp-server/src/";
const finish = server + "sandbox-finish.ts";
const branch = 'if (provider === "modal") finish();';

test("reports the new provider branch with repository totals and its source location", () => {
  const original = [server + "sandbox-stop.ts", branch] as const;
  const base = new Map([original]);
  const head = new Map([[finish, "// original\n" + branch], original]);
  expect(compare(base, head)[0]).toEqual({
    name: "provider-branch",
    before: 1,
    after: 2,
    added: [{ path: finish, line: 2, text: '=== "modal"' }],
  });
});

const stop = server + "sandbox-stop.ts";

test.each([
  [
    "move a branch",
    new Map([
      [finish, branch],
      [stop, "// original"],
    ]),
    new Map([
      [finish, "// original"],
      [stop, branch],
    ]),
  ],
  ["rename a file", new Map([[finish, branch]]), new Map([[stop, branch]])],
])("allows an equal total after a %s", (_, base, head) => {
  expect(compare(base, head)[0]).toMatchObject({ before: 1, after: 1, added: [] });
});

test("counts provider comparisons and switch forms across ts and tsx while excluding machine adapters, tests and generated files", () => {
  const source = "switch (provider.id) { case 'boat': break; }\nif (choice !==\n  'docker') skip();";
  const head = new Map([
    [finish, source],
    ["apps/dashboard/src/page.tsx", 'if (provider === "modal") render();'],
    [server + "modal-integration.ts", 'if (target.provider !== "modal") fail();'],
    [server + "docker-machine-adapter.ts", source],
    [server + "docker-machine-bindings.ts", source],
    [server + "docker-machine-inventory.ts", source],
    ["packages/core/src/docker-machine.ts", source],
    ["packages/provider-boat/src/machine.ts", source],
    ["packages/provider-modal/src/machine.ts", source],
    ["packages/docker-host/src/host.ts", source],
    ["scripts/metrics/example.ts", source],
    [server + "sandbox-finish.test.ts", source],
    ["packages/core/src/database.types.ts", source],
  ]);
  expect(compare(undefined, head)[0]).toMatchObject({ before: undefined, after: 5 });
  expect(countArchitecture(head).providerIdBranchesOutsideAdapters).toBe(5);
});

test("keeps only existing machine adapter files in the provider-branch allowlist", () => {
  const root = resolve(import.meta.dir, "../..");
  expect(machineAdapterPaths.size).toBeGreaterThan(0);
  for (const path of machineAdapterPaths) {
    expect(existsSync(resolve(root, path))).toBe(true);
  }
});

test("counts versioned route names only in the route tables", () => {
  const head = new Map([
    [server + "control-tool-routes.ts", 'const routes = ["sandbox/launch-v2"];'],
    [server + "control.ts", 'case "sandbox/resume-v3":'],
    [server + "models.ts", 'const model = "gpt-5-v2";'],
  ]);
  expect(compare(new Map(), head)[1]).toMatchObject({ before: 0, after: 2 });
});

test("counts case-insensitive deprecation headers only in server source", () => {
  const headers = 'headers.set("deprecation", date);\nconst response = { Sunset: date };';
  const head = new Map([
    [server + "control.ts", headers],
    [server + "control.test.ts", headers],
    ["packages/core/src/client.ts", headers],
  ]);
  expect(compare(new Map(), head)[2]).toMatchObject({ before: 0, after: 2 });
});

test("reports the added occurrence when the same branch token also moves", () => {
  const base = new Map([[stop, branch]]);
  const head = new Map([
    [finish, 'if (provider === "modal") audit();'],
    [server + "turns.ts", branch],
  ]);
  expect(compare(base, head)[0]?.added).toEqual([{ path: finish, line: 1, text: '=== "modal"' }]);
});

const control = server + "control.ts";
const route = '"sandbox/info"';
const registration = 'defineRoutes("sandbox", { "sandbox/info": handler });';

test.each([
  ["a control case", control, "", `switch (route) { case ${route}: break; }`, route],
  ["a control route key", control, "", registration, route],
  [
    "a server mount",
    server + "serve.ts",
    "createHandler({ routes: assembly.mounts(configureTimeout) });",
    "createHandler({ routes: assembly.mounts(configureTimeout).concat(mount) });",
    "mount",
  ],
  ["a server worker", server + "serve.ts", "", 'workers.managed.set("idle", factory);', '"idle"'],
  [
    "a core barrel export",
    "packages/core/src/index.ts",
    'export { first } from "./core";',
    'export { first, second } from "./core";',
    "second",
  ],
  [
    "a CLI command",
    "packages/cli/src/commands/index.ts",
    "export const commands = [launch];",
    "export const commands = [launch, stop];",
    "stop",
  ],
])("reports %s added at a central append point", (_, path, before, after, text) => {
  const result = compare(new Map([[path, before]]), new Map([[path, after]])).find(
    ({ name }) => name === "append-point",
  );
  expect(result).toMatchObject({ added: [{ path, line: 1, text }] });
  expect(result!.after).toBe(result!.before! + 1);
});

test("allows a route defined in its owning module", () => {
  const result = compare(new Map(), new Map([[server + "sandbox-control.ts", registration]])).find(
    ({ name }) => name === "append-point",
  );
  expect(result).toMatchObject({ before: 0, after: 0, added: [] });
});

test("allows spreading assembled mounts without adding a central registration", () => {
  const path = server + "serve.ts";
  const base = new Map([[path, "createHandler({ routes: assembly.mounts(configureTimeout) });"]]);
  const head = new Map([[path, "createHandler({ routes: [...assembly.mounts(configureTimeout)] });"]]);
  expect(compare(base, head).find(({ name }) => name === "append-point")).toMatchObject({
    before: 0,
    after: 0,
    added: [],
  });
});

test("reports native-path growth in a new server file", () => {
  const path = server + "launch-provider.ts";
  const head = new Map([[path, 'const agentPath = "runtime";']]);
  expect(compare(new Map(), head).find(({ name }) => name === "native-path")).toEqual({
    name: "native-path",
    before: 0,
    after: 1,
    added: [{ path, line: 1, text: "agentPath" }],
  });
});

test("allows native-path deletions and uses the architecture metric's scope", () => {
  const source = 'const options = { agentPath: "native", nativeRuntime, nativeCli, runtimeTransport };';
  const retained = new Map([
    ["apps/dashboard/src/launch.tsx", source],
    ["packages/agent-runtime/src/harness.ts", source],
    ["scripts/metrics/example.ts", source],
    [
      server + "ordinary-launch-receipts.ts",
      'const fields = {\n  ordinaryRoute: "native",\n  modalTransportField: "runtimeTransport",\n};',
    ],
    [server + "launch.test.ts", source],
    [server + "launch.generated.ts", source],
  ]);
  const base = new Map([...retained, [server + "launch-provider.ts", source]]);
  expect(compare(base, retained).find(({ name }) => name === "native-path")).toEqual({
    name: "native-path",
    before: 10,
    after: 5,
    added: [],
  });
});
