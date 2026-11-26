import { expect, test } from "bun:test";
import { affectedWorkspaces, verificationCommands } from "./verify-changed.ts";

test("changed verification includes transitive consumers, isolates leaves and broadens unknown inputs", () => {
  const workspaces = [
    { path: "packages/core", name: "core", dependencies: [] },
    { path: "packages/server", name: "server", dependencies: ["core"] },
    { path: "apps/dashboard", name: "dashboard", dependencies: ["server"] },
    { path: "packages/independent", name: "independent", dependencies: [] },
  ];
  expect(affectedWorkspaces(["packages/core/src/a.ts"], workspaces)).toEqual([
    "apps/dashboard",
    "packages/core",
    "packages/server",
  ]);
  expect(affectedWorkspaces(["packages/independent/test/a.test.ts"], workspaces)).toEqual(["packages/independent"]);
  expect(affectedWorkspaces(["bun.lock"], workspaces)).toEqual(workspaces.map((w) => w.path).sort());
  expect(affectedWorkspaces(["docs/contributing.md", "AGENTS.md"], workspaces)).toEqual(
    workspaces.map((w) => w.path).sort(),
  );
  expect(affectedWorkspaces([], workspaces)).toEqual([]);
});

test("verificationCommands prepares runtime only when tests run and manifest is missing", () => {
  expect(verificationCommands(["./packages/mcp-server/test/a.test.ts"], false)).toEqual([
    ["bun", "run", "lint"],
    ["bun", "run", "typecheck"],
    ["bun", "run", "prepare-runtime"],
    ["bun", "test", "./packages/mcp-server/test/a.test.ts"],
  ]);
  expect(verificationCommands(["./packages/mcp-server/test/a.test.ts"], true)).toEqual([
    ["bun", "run", "lint"],
    ["bun", "run", "typecheck"],
    ["bun", "test", "./packages/mcp-server/test/a.test.ts"],
  ]);
  expect(verificationCommands([], false)).toEqual([
    ["bun", "run", "lint"],
    ["bun", "run", "typecheck"],
  ]);
});
