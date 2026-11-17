import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { encryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "../src/caller.ts";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";

for (const selection of ["implicit", "native", "historical"] as const) {
  test(`Docker status bounds latest reads and retains archive lookup: ${selection}`, async () => {
    const id = randomUUID();
    const publicId = randomUUID();
    const historicalId = randomUUID();
    const nativeId = randomUUID();
    const conversationId = randomUUID();
    const requestId = "docker_prompt_fixture";
    const result_enc = await encryptSecret(
      JSON.stringify({
        epoch: "1",
        requestId,
        status: 200,
        body: { version: 1, requestId, result: { promptId: nativeId, conversationId, status: "running" } },
      }),
      Buffer.alloc(32, 13).toString("base64"),
    );
    const userId = randomUUID();
    const orgId = randomUUID();
    const key = Buffer.alloc(32, 13).toString("base64");
    const event_enc = await encryptSecret(JSON.stringify({ id: "output", kind: "output", at: 1, text: "busy" }), key);
    const historicalEvent = await encryptSecret(
      JSON.stringify({
        id: "old_prompt",
        kind: "prompt",
        at: 1,
        promptId: historicalId,
        conversationId,
        status: "completed",
      }),
      key,
    );
    let pages = 0;
    let status = "running";
    const sql: Sql = {
      async query<T>(query: string) {
        let rows: unknown[] = [];
        if (query.includes("from public.sandboxes s join"))
          rows = [
            {
              id,
              org_id: orgId,
              owner_id: userId,
              role: "member",
              provider: "docker",
              docker_host_id: randomUUID(),
              docker_image: "fixture",
              harness: "codex",
              status,
              status_reason: null,
              stopped_at: null,
              model: null,
              reasoning_effort: null,
              conversation_ids: [],
              expires_at: null,
              usage_turns: null,
              prompt_sequence: "0",
              journal_sequence: "50000",
            },
          ];
        if (query.includes("from public.docker_queued_prompts"))
          rows = [{ prompt_id: publicId, native_prompt_id: nativeId, status: "admitted", command_pending: false }];
        if (query.includes("select sequence::text,request_id,epoch::text,result_enc"))
          rows = [{ sequence: "1", epoch: "1", request_id: requestId, result_enc }];
        if (query.includes("select sequence::text,event_enc")) {
          pages++;
          rows = Array.from({ length: 501 }, (_, i) => ({
            sequence: String(50000 - (pages - 1) * 500 - i),
            event_enc: selection === "historical" && pages === 2 ? historicalEvent : event_enc,
          }));
        }
        return { rows: rows as T[] };
      },
    };
    const caller: Caller = { userId, orgs: [{ orgId, role: "member" }], via: "service" };
    const controls = createDockerSandboxControls(sql, key);
    const args = {
      id,
      ...(selection === "native"
        ? { prompt_id: nativeId }
        : selection === "historical"
          ? { prompt_id: historicalId }
          : {}),
    };
    const result = await controls.invoke(caller, "status", args);
    expect(result).toMatchObject({ handled: true, result: { status: "running", settled: false } });
    if (selection !== "historical")
      expect(result).toMatchObject({
        result: { statusMessage: "Stored prompt state is incomplete; live data may be stale." },
      });
    expect(pages).toBe(selection === "historical" ? 2 : 0);
    if (selection === "native")
      expect(result).toMatchObject({ result: { prompt: { promptId: publicId, state: "running" } } });
    if (selection !== "implicit") return;
    status = "stopped";
    pages = 0;
    expect(await controls.invoke(caller, "status", { id })).toMatchObject({
      handled: true,
      result: { status: "stopped", settled: true },
    });
    expect(pages).toBe(0);
  });
}
