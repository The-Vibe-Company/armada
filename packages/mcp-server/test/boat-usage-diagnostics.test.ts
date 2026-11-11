import { expect, test } from "bun:test";
import { type SandboxUsage, type TurnTokenUsage, usageUnavailableReason } from "@armada/core";
import { call, harness } from "./support.ts";

test("shared status API retains a readable missing-usage stage across stop, then clears it when counters arrive", async () => {
  const server = await harness();
  try {
    const { people: p, boat, db } = server;
    const golden = (await db.query<{ id: string }>("select id from goldens where name='mine'")).rows[0];
    if (!golden) throw new Error("Missing golden fixture");
    const native = await boat.provider.fork({ from: "snapshot" });
    const receipt = await boat.provider.prompt({ sandboxId: native.id, harness: "codex", text: "fixture turn" });
    boat.finish(native.id, receipt.promptId, "finished");
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat',$5,'codex','ready')`,
      [id, golden.id, p.org, p.owner, native.id],
    );
    let observation: TurnTokenUsage = {
      promptId: receipt.promptId,
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      unavailableReason: usageUnavailableReason("native_start_unobserved"),
    };
    boat.provider.collectTurnUsage = async () => [observation];
    const client = await server.client(await server.token(p.owner));
    const detail = async () => {
      const result = await call(client, "status", { id });
      expect(result.isError).toBe(false);
      return result.data as unknown as { usage: SandboxUsage; status: string };
    };
    const first = await detail();
    expect(first.status).toBe("ready");
    expect(first.usage.turns[0]?.unavailableReason).toEqual(usageUnavailableReason("native_start_unobserved"));
    expect(first.usage.tokenTotals?.inputTokens).toBeNull();
    await boat.provider.stop({ sandboxId: native.id });
    observation = { ...observation, unavailableReason: usageUnavailableReason("compute_inactive") };
    expect((await detail()).usage.turns[0]?.unavailableReason?.code).toBe("native_start_unobserved");
    boat.sandbox(native.id).info.state = "ready";
    observation = {
      promptId: receipt.promptId,
      model: "gpt-6.1-sol",
      inputTokens: 42,
      outputTokens: 7,
      cachedTokens: 0,
    };
    const measured = await detail();
    expect(measured.usage.tokenTotals?.inputTokens).toBe(42);
    expect(measured.usage.turns).toHaveLength(1);
    expect(measured.usage.turns[0]?.unavailableReason).toBeUndefined();
  } finally {
    await server.close();
  }
});
