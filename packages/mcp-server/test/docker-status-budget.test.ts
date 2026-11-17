import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { encryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "../src/caller.ts";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";

test("Docker status bounds retained journal work even when the latest prompt is buried", async () => {
  const id = randomUUID();
  const userId = randomUUID();
  const orgId = randomUUID();
  const key = Buffer.alloc(32, 13).toString("base64");
  const event_enc = await encryptSecret(JSON.stringify({ id: "output", kind: "output", at: 1, text: "busy" }), key);
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
      if (query.includes("select sequence::text,event_enc")) {
        pages++;
        rows = Array.from({ length: 501 }, (_, i) => ({ sequence: String(50000 - (pages - 1) * 500 - i), event_enc }));
      }
      return { rows: rows as T[] };
    },
  };
  const caller: Caller = { userId, orgs: [{ orgId, role: "member" }], via: "service" };
  const controls = createDockerSandboxControls(sql, key);
  const result = await controls.invoke(caller, "status", { id });
  expect(result).toMatchObject({ handled: true, result: { status: "running", settled: false } });
  expect(result).toMatchObject({
    result: { statusMessage: "Stored prompt state is incomplete; live data may be stale." },
  });
  expect(pages).toBe(1);
  status = "stopped";
  pages = 0;
  expect(await controls.invoke(caller, "status", { id })).toMatchObject({
    handled: true,
    result: { status: "stopped", settled: true },
  });
  expect(pages).toBe(1);
});
