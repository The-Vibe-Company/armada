import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgeProvider, PluginContext } from "@armada/plugin-api";
import { activate } from "../src/index.ts";
import { githubToken } from "../src/keychain.ts";

test("merge pins the requested head and reports only confirmed GitHub merges", async (t) => {
  let provider: ForgeProvider | undefined;
  activate({
    config: { forge: { github: { projects: { orchard: { repository: "example/orchard" } } } } },
    secrets: {
      get: async (name: string) => {
        assert.equal(name, "GITHUB_TOKEN");
        return "synthetic-key";
      },
    },
    register: {
      forge: (_kind: string, value: ForgeProvider) => {
        provider = value;
      },
    },
  } as unknown as PluginContext);
  assert.ok(provider);
  const head = "0123456789abcdef0123456789abcdef01234567";
  let calls = 0;
  let merged = true;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/example/orchard/pulls/17/merge");
    assert.equal(init.method, "PUT");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-key");
    assert.deepEqual(JSON.parse(String(init.body)), { sha: head, merge_method: "squash" });
    return Response.json({ merged }, { status: merged ? 200 : 409 });
  });
  assert.deepEqual(await provider.merge({ project: "orchard", number: 17, head }), { merged: true });
  merged = false;
  assert.deepEqual(await provider.merge({ project: "orchard", number: 17, head }), { merged: false });
  assert.equal(calls, 2);
  await assert.rejects(provider.merge({ project: "orchard", number: 17, head: "" }), /GitHub merge failed/);
  assert.equal(calls, 2);
});

test("the declared token wins and gh auth token is the bounded fallback", async () => {
  const calls: string[] = [];
  const command = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args].join(" "));
    return "synthetic-gh-token\n";
  };
  assert.equal(
    await githubToken({ keychain: { read: async () => "synthetic-declared-token" }, command }),
    "synthetic-declared-token",
  );
  assert.deepEqual(calls, []);
  assert.equal(await githubToken({ keychain: { read: async () => null }, command }), "synthetic-gh-token");
  assert.deepEqual(calls, ["gh auth token"]);
});
