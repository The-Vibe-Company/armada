import { expect, test } from "bun:test";
import { checkImportBoundaries } from "./import-boundaries.ts";

test.each([
  ["packages/cli/src/main.ts", 'import { createClient } from "@supabase/supabase-js";', "@supabase/supabase-js"],
  ["packages/sdk/src/client.ts", 'export type { Sql } from "@armada/core/server";', "@armada/core/server"],
  ["packages/sdk/src/client.ts", 'import "../../mcp-server/src/serve";', "../../mcp-server/src/serve"],
  ["packages/cli/src/main.ts", 'import "@armada/docker-host";', "@armada/docker-host"],
  ["packages/cli/src/main.ts", 'import "@armada/provider-boat";', "@armada/provider-boat"],
])("%s rejects %s at the client boundary", (file, source, target) => {
  expect(checkImportBoundaries(new Map([[file, source]]))).toEqual([`${file}: client-server-import: ${target}`]);
});

test("checks a transitive browser core dependency while leaving unreachable server code alone", () => {
  expect(
    checkImportBoundaries(
      new Map([
        ["packages/core/src/index.ts", 'export * from "./nested";'],
        ["packages/core/src/nested/index.ts", 'export * from "../leaf.js";'],
        ["packages/core/src/leaf.ts", 'import "node:fs"; export * from "./index.ts";'],
        ["packages/core/src/server.ts", 'import "node:os";'],
      ]),
    ),
  ).toEqual(["packages/core/src/leaf.ts: browser-core-import: node:fs"]);
});

test("checks browser-safe core subpath entries and rejects the server barrel", () => {
  expect(
    checkImportBoundaries(
      new Map([
        ["packages/core/src/contract/index.ts", 'export * from "@armada/core/server";'],
        ["packages/core/src/server.ts", ""],
      ]),
    ),
  ).toEqual(["packages/core/src/contract/index.ts: browser-core-import: @armada/core/server"]);
});

test("enforces provider exports across packages, including relative paths and dynamic imports", () => {
  expect(
    checkImportBoundaries(
      new Map([
        [
          "packages/mcp-server/src/provider.ts",
          `import "@armada/provider-modal";
         import "@armada/provider-modal/embedded";
         import("@armada/provider-modal/src/store");
         export * from "../../provider-boat/src/native-cwd.ts";
         import "../../provider-boat/test/support";
         import "../../provider-boat/package.json";`,
        ],
        ["packages/provider-boat/test/probe.ts", 'import "../src/native-cwd.ts";'],
      ]),
      new Map([["@armada/provider-modal/embedded", "packages/provider-modal/src/embedded.ts"]]),
    ),
  ).toEqual([
    "packages/mcp-server/src/provider.ts: provider-private-import: ../../provider-boat/package.json",
    "packages/mcp-server/src/provider.ts: provider-private-import: ../../provider-boat/src/native-cwd.ts",
    "packages/mcp-server/src/provider.ts: provider-private-import: ../../provider-boat/test/support",
    "packages/mcp-server/src/provider.ts: provider-private-import: @armada/provider-modal/src/store",
  ]);
});

test("allows only the existing provider edge at an excepted file", () => {
  expect(
    checkImportBoundaries(
      new Map([
        [
          "packages/core/test/golden-os.probe.ts",
          `import "../../provider-modal/src/ssh.ts"; import "../../provider-modal/src/store.ts";`,
        ],
      ]),
    ),
  ).toEqual(["packages/core/test/golden-os.probe.ts: provider-private-import: ../../provider-modal/src/store.ts"]);
});

test("keeps the dashboard on public Supabase credentials and rejects service-role modules", () => {
  const file = "apps/dashboard/src/lib/data.ts";
  expect(
    checkImportBoundaries(
      new Map([
        [
          file,
          `import "@supabase/supabase-js";
            import "@armada/core/server";
            import "@armada/auth";
            import "../../../../packages/core/src/golden-create.ts";
            import "../../../../packages/core/src/vault-store.ts";`,
        ],
      ]),
    ),
  ).toEqual([
    `${file}: dashboard-service-import: ../../../../packages/core/src/golden-create.ts`,
    `${file}: dashboard-service-import: ../../../../packages/core/src/vault-store.ts`,
    `${file}: dashboard-service-import: @armada/auth`,
    `${file}: dashboard-service-import: @armada/core/server`,
  ]);
});

test("follows browser imports across workspace package boundaries", () => {
  const file = "packages/agent-runtime/src/cwd.ts";
  expect(
    checkImportBoundaries(
      new Map([
        ["packages/core/src/index.ts", 'export * from "@armada/agent-runtime";'],
        ["packages/agent-runtime/src/index.ts", 'export * from "./cwd";'],
        [file, 'import "node:fs";'],
      ]),
      new Map([["@armada/agent-runtime", "packages/agent-runtime/src/index.ts"]]),
    ),
  ).toEqual([`${file}: browser-core-import: node:fs`]);
});

test("ignores import-like text in a regex literal", () => {
  const source = String.raw`const example = /import "@armada\/core\/server"/;`;
  expect(checkImportBoundaries(new Map([["packages/cli/src/example.ts", source]]))).toEqual([]);
});
