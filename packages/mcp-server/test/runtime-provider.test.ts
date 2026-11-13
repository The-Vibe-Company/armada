import { expect, test } from "bun:test";
import {
  createSqlSandboxStore,
  createSqlVaultStore,
  type Provider,
  type ProviderTarget,
  type Sql,
} from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import {
  createHistoricalSandboxProviderResolver,
  createMcpSandboxProviderResolver,
} from "../src/mcp-sandbox-provider.ts";
import { createRuntimeProvider } from "../src/runtime-provider.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

test("runtime sandbox adapter exposes bound reads/compute cleanup, never host agent or optional fallback", async () => {
  const calls: string[] = [];
  const host = new Proxy(
    { id: "boat" },
    {
      get(object, key) {
        if (key === "id") return object.id;
        if (["backendIdentity", "managementIdentity"].includes(String(key))) return undefined;
        return async () => {
          calls.push(String(key));
          if (key === "get") return { id: "physical", state: "ready" };
          return { status: "deleted" };
        };
      },
    },
  ) as unknown as Provider;
  const runtime = createRuntimeProvider(host, "physical", {
    async getPrompt() {
      calls.push("runtime-prompt-read");
      return { promptId: "p", status: "finished", done: true };
    },
    async events() {
      calls.push("runtime-events");
      return { events: [], source: "armada-runtime", hasMore: false };
    },
  });
  await runtime.get("physical");
  expect(await runtime.getPrompt({ sandboxId: "physical", promptId: "p" })).toMatchObject({ done: true });
  expect(await runtime.events({ sandboxId: "physical" })).toMatchObject({ source: "armada-runtime" });
  await runtime.stop({ sandboxId: "physical" });
  await runtime.delete({ sandboxId: "physical" });
  expect(calls).toEqual(["get", "runtime-prompt-read", "runtime-events", "stop", "delete"]);
  await expect(runtime.get("other")).rejects.toMatchObject({ code: "not_found" });
  await expect(runtime.events({ sandboxId: "other" })).rejects.toMatchObject({ code: "not_found" });
  for (const attempt of [
    () => runtime.prompt({ sandboxId: "physical", harness: "codex", text: "must not send" }),
    () => runtime.exec({ sandboxId: "physical", command: "must not exec" }),
    () => runtime.interrupt({ sandboxId: "physical" }),
    () => runtime.quiesce?.({ sandboxId: "physical" }),
    () => runtime.sshKey({ sandboxId: "physical", key: "must not register" }),
  ])
    await expect(attempt()).rejects.toMatchObject({ code: "invalid_request", retryable: false });
  expect(runtime.configureMcp).toBeUndefined();
  expect(runtime.collectTurnUsage).toBeUndefined();
  expect(calls).toHaveLength(5);
});

test("registry and active/historical SQL resolvers preserve immutable runtime choice or refuse, never native fallback", async () => {
  const { db, people } = await database();
  try {
    const sql: Sql = { query: (q, v) => db.query(q, v) };
    const golden = (
      await db.query<{ id: string }>("select id from goldens where owner_id=$1 and visibility='private' limit 1", [
        people.owner,
      ])
    ).rows[0];
    if (!golden) throw Error("missing owned golden");
    const record = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "physical",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "codex",
      status: "ready",
      model: "gpt-5.4",
      reasoningEffort: "high",
      boatRuntime: true,
    });
    const calls: string[] = [];
    const host = { id: "boat" } as Provider;
    const base = {
      vault: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      providerFor() {
        calls.push("native");
        return host;
      },
    };
    const factory = providerRegistry({
      ...base,
      async runtimeProviderFor(_key, target, actor) {
        expect([target.id, target.boatRuntime, actor.userId]).toEqual([record.id, true, people.owner]);
        calls.push("runtime");
        return host;
      },
    });
    const target: ProviderTarget = {
      id: record.id,
      boatRuntime: true,
      provider: "boat",
      orgId: people.org,
      visibility: "private",
      modal: null,
    };
    await factory.resolve(target, { userId: people.owner });
    await createMcpSandboxProviderResolver(sql, factory)(record.id);
    await createHistoricalSandboxProviderResolver(factory)(sql, record.id);
    expect(calls).toEqual(["runtime", "runtime", "runtime"]);
    const { boatRuntime: choice, ...nativeTarget } = target;
    void choice;
    await factory.resolve(nativeTarget, { userId: people.owner });
    expect(calls.at(-1)).toBe("native");
    await expect(providerRegistry(base).resolve(target, { userId: people.owner })).rejects.toMatchObject({
      code: "provider_not_configured",
    });
    const { id: hint, ...noIdentity } = target;
    void hint;
    await expect(factory.resolve(noIdentity, { userId: people.owner })).rejects.toMatchObject({
      code: "provider_not_configured",
    });
    expect(calls.filter((value) => value === "native")).toHaveLength(1);
    const caller = {
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" as const }],
      via: "service" as const,
    };
    const context: ToolContext = {
      caller,
      data: createSqlData(sql)(caller),
      async provider() {
        throw Error("must reject before resolving native credentials/provider");
      },
      launchCredentials: {
        async resolve() {
          throw Error("must not resolve native model credentials");
        },
      },
      async exposedSecrets() {
        throw Error("must not inspect native credentials");
      },
      now: () => new Date(),
      async sleep() {
        throw Error("must not wait");
      },
    };
    for (const [name, extra] of [
      ["send", { prompt: "no" }],
      ["exec", { command: "no" }],
      ["steer", { text: "no" }],
      ["interrupt", {}],
      ["github_refresh", {}],
    ] as const)
      await expect(callSharedTool(context, name, { id: record.id, ...extra })).rejects.toMatchObject({
        code: "unsupported",
      });
  } finally {
    await db.close();
  }
});
