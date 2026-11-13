import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import type { Provider } from "@armada/core/server";
import { createSqlVaultStore } from "@armada/core/server";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createRuntimeCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeHistory } from "../src/runtime-history.ts";
import { createRuntimeProvider } from "../src/runtime-provider.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

function stopPort(f: Awaited<ReturnType<typeof runtimeFixture>>) {
  let stopped = false,
    calls = 0;
  const host = {
    id: "boat",
    async get() {
      return { id: "physical", state: stopped ? "stopped" : "running", stoppedAt: stopped ? new Date() : undefined };
    },
    async stop() {
      calls++;
      stopped = true;
    },
  } as unknown as Provider;
  return {
    context: {
      ...f.context,
      provider: async () =>
        createRuntimeProvider(host, "physical", {
          events: ({ sandboxId: _, ...page }) => createRuntimeHistory(f.sql, ENCRYPTION_KEY)(f.caller, f.row.id, page),
          async getPrompt() {
            throw Error("No native/live prompt reads during compute stop");
          },
        }),
    },
    calls: () => calls,
  };
}
const args = (id: string) => ({ id, request_id: crypto.randomUUID(), runtimeVersion: 1 as const });

test("checkpoint interrupts, flushes and seals a real Runner before stop; receipt and history survive stopped reads", async () => {
  const f = await runtimeFixture();
  try {
    const done = Promise.withResolvers<"interrupted">();
    f.hold(done.promise, () => done.resolve("interrupted"));
    const work = await f.send(f.caller, f.input("active turn"));
    const input = args(f.row.id),
      checkpoint = createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge);
    const receipt = (await callSharedTool(
      { ...f.context, runtimeCheckpoint: checkpoint },
      "runtime_checkpoint",
      input,
    )) as Awaited<ReturnType<typeof checkpoint>>;
    const high = (
      await f.db.query<{ n: string }>("select max(sequence)::text as n from runtime_events where sandbox_id=$1", [
        f.row.id,
      ])
    ).rows[0]!.n;
    expect(receipt).toMatchObject({
      runtime: { kind: "armada", epoch: f.active.epoch },
      checkpoint: { state: "complete", watermark: Number(high), acknowledgedSequence: Number(high) },
    });
    expect(f.journal.get(work.promptId)?.status).toBe("interrupted");
    await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "conflict" });
    const stop = stopPort(f);
    expect(await callSharedTool(stop.context, "stop", { id: f.row.id })).toMatchObject({ status: "stopped" });
    expect(stop.calls()).toBe(1);
    const authStore = createMemoryAuthStore();
    authStore.addMembership(f.people.owner, { orgId: f.people.org, name: "Fixture", role: "member" });
    const bearer = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: f.people.owner })).replace(/=+$/, "")}.sig`;
    const response = await handleControlRequest(
      new Request("https://armada.test/api/v1/sandbox/checkpoint-runtime-v1", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify(input),
      }),
      {
        authStore,
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        supabase: {
          supabaseUrl: "https://supabase.test",
          anonKey: "fixture",
          fetch: async () => Response.json({ id: f.people.owner }),
        },
        data: createSqlData(f.sql),
        runtimeCheckpoint: createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge),
        providers: {
          async resolve() {
            throw Error("No compute/provider resolution for cached checkpoint");
          },
        },
      },
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(receipt);
    const history = await createRuntimeHistory(f.sql, ENCRYPTION_KEY)(f.caller, f.row.id, {});
    expect(history.source).toBe("armada-runtime");
    expect(
      history.events
        .filter((v) => v.kind === "prompt" && ["finished", "interrupted"].includes(v.status))
        .map((v) => v.promptId),
    ).toEqual([f.first.promptId, work.promptId]);
    const stored = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(stored.preservationNote).toContain("checkpoint acknowledged");
    expect(stored.stoppedAt).not.toBeNull();
    expect(f.starts).toHaveLength(2);
    await expect(checkpoint({ ...f.caller, userId: f.people.admin }, input)).rejects.toMatchObject({
      code: "not_found",
    });
    for (const role of ["anon", "authenticated"])
      expect(
        (
          await f.db.query<{ ok: boolean }>(
            "select has_table_privilege($1,'runtime_checkpoints','select,insert,update,delete') as ok",
            [role],
          )
        ).rows[0]?.ok,
      ).toBe(false);
  } finally {
    await f.close();
  }
});

test("a lost checkpoint response reconciles from durable encrypted result after compute stops, never by waking the guest", async () => {
  const f = await runtimeFixture();
  try {
    const input = args(f.row.id);
    const lost = {
      ...f.bridge,
      async call(...params: Parameters<typeof f.bridge.call>) {
        await f.bridge.call(...params);
        throw Error("lost after durable result");
      },
    };
    await expect(createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, lost)(f.caller, input)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      (await f.db.query("select watermark from runtime_checkpoints where sandbox_id=$1", [f.row.id])).rows[0],
    ).toEqual({ watermark: null });
    await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "conflict" });
    const stop = stopPort(f);
    await callSharedTool(stop.context, "stop", { id: f.row.id });
    const recovered = await createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, input);
    expect(recovered.checkpoint.state).toBe("complete");
    expect((await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))?.preservationNote).toContain(
      "host stop is confirmed",
    );
    expect(stop.calls()).toBe(1);
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each(["generation", "prefix", "ack"] as const)(
  "authenticated but invalid durable checkpoint proof fails closed (%s)",
  async (mode) => {
    const f = await runtimeFixture();
    try {
      f.tamper(mode);
      await expect(
        createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, args(f.row.id)),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(
        (await f.db.query("select watermark from runtime_checkpoints where sandbox_id=$1", [f.row.id])).rows[0],
      ).toEqual({ watermark: null });
      await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await f.close();
    }
  },
);

test("a late journal tail or application-secret exposure invalidates checkpoint reuse", async () => {
  const f = await runtimeFixture();
  try {
    const input = args(f.row.id),
      checkpoint = createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge);
    const receipt = await checkpoint(f.caller, input);
    await createRuntimeEvents(f.authority, ENCRYPTION_KEY).append(f.active.runtimeToken, f.active.epoch, {
      sandboxId: f.row.id,
      generation: f.active.epoch,
      events: [
        {
          sequence: receipt.checkpoint.watermark + 1,
          event: { id: "late", at: 1, kind: "other", type: "late-notification", data: {} },
        },
      ],
    });
    await expect(checkpoint(f.caller, input)).rejects.toMatchObject({ code: "conflict" });
    const stop = stopPort(f);
    await callSharedTool(stop.context, "stop", { id: f.row.id });
    expect((await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))?.preservationNote).toContain(
      "no acknowledged runtime checkpoint",
    );
    await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.row.id]);
    await expect(checkpoint(f.caller, input)).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await f.close();
  }
});

test("an undelivered checkpoint intent fences new work across replicas until the same operation reconciles", async () => {
  const f = await runtimeFixture();
  try {
    const input = args(f.row.id);
    const unavailable = {
      ...f.bridge,
      async call() {
        throw Error("dropped before delivery");
      },
    };
    await expect(createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, unavailable)(f.caller, input)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.send(f.caller, f.input("must not run"))).rejects.toMatchObject({ code: "conflict" });
    expect(f.starts).toHaveLength(1);
    await expect(
      createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, args(f.row.id)),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, input)).checkpoint.state).toBe(
      "complete",
    );
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});
