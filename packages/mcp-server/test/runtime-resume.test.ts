import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core/server";
import { sandbox as sdkSandbox } from "../../provider-boat/test/support.ts";
import { boatRuntimeResume } from "../src/boat-runtime-resume.ts";
import { createSqlData } from "../src/data.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createRuntimeCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeHistory } from "../src/runtime-history.ts";
import { createRuntimeResume } from "../src/runtime-resume.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function stopped(harness: "codex" | "claude" = "codex", provider: "boat" | "modal" = "boat") {
  const f = await runtimeFixture(await sharedDatabase(), provider, harness);
  const cp = await createRuntimeCheckpoint(
    f.sql,
    ENCRYPTION_KEY,
    f.bridge,
  )(f.caller, { id: f.row.id, request_id: crypto.randomUUID(), runtimeVersion: 1 });
  await f.db.query("update sandboxes set stop_requested_at=now(),status='stopping' where id=$1", [f.row.id]);
  await f.db.query("update sandboxes set stop_requested_at=null,status='stopped',stopped_at=now() where id=$1", [
    f.row.id,
  ]);
  return { ...f, cp };
}
const input = (id: string) => ({
  id,
  request_id: crypto.randomUUID(),
  runtimeVersion: 1 as const,
  prompt: "continue the previous conversation",
});

describe.each([
  ["boat", "codex"],
  ["boat", "claude"],
  ["modal", "codex"],
] as const)("retained runtime resume (%s/%s)", (provider, harness) => {
  let f: Awaited<ReturnType<typeof stopped>>;
  // Cold WASM/migrations and building the stopped checkpoint are prerequisites,
  // not resume/replay work. Keep the behavior timeout and real assertions intact.
  beforeAll(async () => {
    f = await stopped(harness, provider);
  }, 20_000);
  afterAll(async () => {
    await f?.close();
  });

  test("resume reopens the same journal into a new attested epoch; stable replay never activates or starts a turn twice", async () => {
    const old = f.active;
    let activations = 0;
    const resume = createRuntimeResume(
      f.sql,
      ENCRYPTION_KEY,
      f.bridge,
      async () => ({
        async start(_signal, restore) {
          activations++;
          return f.reboot(restore);
        },
        async stop() {
          throw Error("Healthy resume must not stop compute");
        },
      }),
      provider === "modal"
        ? async () => {
            throw Error("No Boat MCP preparation on model-only Modal resume");
          }
        : undefined,
    );
    const request = input(f.row.id);
    const result = (await callSharedTool(
      { ...f.context, runtimeResume: resume },
      "runtime_resume",
      request,
    )) as Awaited<ReturnType<typeof resume>>;
    expect(result).toMatchObject({
      resumed: true,
      conversationId: f.first.conversationId,
      runtime: { kind: "armada", epoch: "2" },
      sourceCheckpoint: { epoch: "1", watermark: f.cp.checkpoint.watermark },
    });
    expect(result.promptId).not.toBe(f.first.promptId);
    await expect(f.authority.withSession(old.runtimeToken, old.epoch, async () => true)).rejects.toThrow();
    expect(await resume(f.caller, request)).toEqual(result);
    expect(activations).toBe(1);
    expect(f.starts).toEqual([undefined, "native-thread"]);
    const row = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(row.status).toBe("running");
    expect(row.stoppedAt).toBeNull();
    expect(row.taskPromptId).toBe(result.promptId);
    expect(
      (await createRuntimeHistory(f.sql, ENCRYPTION_KEY)(f.caller, f.row.id, {})).events.some(
        (e) => e.promptId === f.first.promptId,
      ),
    ).toBe(true);
    await expect(resume(f.caller, { ...request, prompt: "different" })).rejects.toMatchObject({ code: "conflict" });
    expect(activations).toBe(1);
  });
});

test("an already enrolled uncertain resume reconciles on a fresh server without another activation or ticket", async () => {
  const f = await stopped();
  try {
    let activations = 0;
    const request = input(f.row.id);
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start(_signal, restore) {
        activations++;
        const ready = await f.reboot(restore);
        f.lose();
        return ready;
      },
      async stop() {
        throw Error("Live enrolled uncertainty must remain reconcilable");
      },
    }));
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    const recovered = await createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, request);
    expect(recovered.runtime.epoch).toBe("2");
    expect(activations).toBe(1);
    expect(f.starts).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test.each(["missing-proof", "prefix", "taint", "account", "owner"] as const)(
  "resume refuses unsafe state before preparing or activating compute (%s)",
  async (mode) => {
    const f = await stopped();
    try {
      let calls = 0;
      if (mode === "missing-proof") await f.db.query("delete from runtime_checkpoints where sandbox_id=$1", [f.row.id]);
      if (mode === "prefix")
        await f.db.query("update runtime_checkpoints set watermark=watermark+1 where sandbox_id=$1", [f.row.id]);
      if (mode === "taint")
        await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.row.id]);
      if (mode === "account") await f.db.query("update credentials set status='revoked' where id=$1", [f.account.id]);
      const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => {
        calls++;
        throw Error("Must not resolve management/model credentials");
      });
      await expect(
        resume(mode === "owner" ? { ...f.caller, userId: f.people.admin } : f.caller, input(f.row.id)),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(f.starts).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test("activation uncertainty never dispatches again under another key or on retry", async () => {
  const f = await stopped();
  try {
    let starts = 0,
      stops = 0;
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start() {
        starts++;
        throw Error("unknown provider outcome");
      },
      async stop() {
        stops++;
      },
    }));
    const request = input(f.row.id);
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    await expect(resume(f.caller, input(f.row.id))).rejects.toThrow();
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("an old runtime without verified restore health cannot receive a resumed prompt", async () => {
  const f = await stopped();
  try {
    let activations = 0;
    const request = input(f.row.id);
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start(_signal, restore) {
        activations++;
        return f.reboot(restore, false);
      },
      async stop() {},
    }));
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    expect(activations).toBe(1);
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  "actual activation boundary dispatches only while retained disk remains untainted (%s)",
  async (taint) => {
    const f = await stopped();
    const requests: string[] = [];
    let activated = false;
    const network = spyOn(globalThis, "fetch").mockImplementation((async (value: Parameters<typeof fetch>[0]) => {
      const url = String(value instanceof Request ? value.url : value);
      requests.push(url);
      if (url.endsWith("/resume")) activated = true;
      if (url.endsWith("/stop")) activated = false;
      return Response.json({
        ok: true,
        sandbox: sdkSandbox({ id: "physical", state: activated ? "running" : "archived" }),
      });
    }) as typeof fetch);
    try {
      const prepare = boatRuntimeResume({
        sql: f.sql,
        vault: createSqlVaultStore(f.sql),
        key: ENCRYPTION_KEY,
        modelAuth: createModelAuthOwnership(f.sql, ENCRYPTION_KEY),
        policy: {
          async start(value) {
            if (taint) await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.row.id]);
            await value.activate?.(value.signal);
            throw Error("Fixture ends after activation boundary");
          },
        },
      });
      await expect(
        createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, prepare)(f.caller, input(f.row.id)),
      ).rejects.toThrow();
      expect(requests.some((path) => path.endsWith("/resume"))).toBe(!taint);
      expect(f.starts).toHaveLength(1);
    } finally {
      network.mockRestore();
      await f.close();
    }
  },
);
