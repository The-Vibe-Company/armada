import { expect, test } from "bun:test";
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

test("counts provider comparisons and switch forms while excluding adapters and tests", () => {
  const source = "switch (provider.id) { case 'boat': break; }\nif (choice !==\n  'docker') skip();";
  const head = new Map([
    [finish, source],
    [server + "modal-integration.ts", source],
    [server + "sandbox-finish.test.ts", source],
    ["packages/provider-modal/src/provider.ts", source],
    ["packages/docker-host/src/host.ts", source],
  ]);
  expect(compare(undefined, head)[0]).toMatchObject({ before: undefined, after: 3 });
});

test("counts versioned route names only in the route tables", () => {
  const head = new Map([
    [server + "public-rest-routes.ts", 'const routes = ["sandbox/launch-v2"];'],
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
