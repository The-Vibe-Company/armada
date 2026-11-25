import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { insertSandboxFixture } from "../../core/test/sandbox.fixture.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { archivedBoat, runBoatStop } from "./boat-stop.fixture.ts";
import { bunLikeSql, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

async function fixture() {
  const server = await harness();
  const sql = bunLikeSql(server.db);
  const data = createSqlData(sql);
  const actor = { userId: server.people.owner, orgId: server.people.org, role: "member" as const };
  const scoped = data({ via: "service", userId: actor.userId, orgs: [{ orgId: actor.orgId, role: actor.role }] });
  const golden = (await server.db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const id = crypto.randomUUID();
  const insert = () =>
    insertSandboxFixture(sql, {
      id,
      provider: "boat",
      providerSandboxId: "bx_23456789",
      goldenId: golden.id,
      orgId: actor.orgId,
      ownerId: actor.userId,
      harness: "claude",
      status: "ready",
      model: "claude-sonnet-5",
      reasoningEffort: "high",
      requestedTtlSeconds: 90,
      effectiveTtlSeconds: 90,
    });
  const token = await server.token(actor.userId);
  const control = (action: string, provider: ReturnType<typeof createBoatProvider>) =>
    handleControlRequest(
      new Request(PUBLIC_URL + `/api/v1/sandbox/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, ...(action === "send" ? { prompt: "continue" } : {}) }),
      }),
      {
        authStore: server.auth,
        supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
        store: createSqlVaultStore(sql),
        encryptionKey: ENCRYPTION_KEY,
        data,
        providers: { resolve: async () => provider },
      },
    );
  return { server, sql, scoped, actor, id, insert, control };
}

test("a failed sandbox keeps its diagnostic during stop retry and settlement", async () => {
  const f = await fixture();
  const provider = createBoatProvider({
    apiKey: "test-key",
    fetch: (async () => {
      throw Error("Stop admission must not call Boat.");
    }) as unknown as typeof fetch,
  });
  try {
    await f.insert();
    await f.server.db.query("update sandboxes set status='failed',status_reason=$2 where id=$1", [
      f.id,
      "Original initialization failure",
    ]);
    expect((await f.control("stop", provider))?.status).toBe(200);
    expect(
      await runBoatStop(f.sql, {
        ...archivedBoat(false),
        observe: async () => ({ kind: "absent", receipt: { operation: "delete" } }),
      }),
    ).toBe("retry");
    expect(await f.scoped.sandboxes.get(f.id)).toMatchObject({
      status: "failed",
      statusReason: "Original initialization failure",
      stoppedAt: null,
    });
    await f.server.db.query("update jobs set run_after=now() where sandbox_id=$1 and kind='stop'", [f.id]);
    expect(await runBoatStop(f.sql, archivedBoat())).toBe("done");
    expect(await f.scoped.sandboxes.get(f.id)).toMatchObject({
      status: "failed",
      statusReason: "Original initialization failure",
      stoppedAt: expect.any(String),
    });
  } finally {
    await f.server.close();
  }
});
