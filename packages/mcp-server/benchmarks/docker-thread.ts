/** Offline work benchmark, not a network latency prediction. Run: bun packages/mcp-server/benchmarks/docker-thread.ts */
import type { Sql } from "@armada/core";
import { encryptSecret } from "@armada/core/server";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";

const id = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const orgId = "00000000-0000-4000-8000-000000000003";
const key = Buffer.alloc(32, 7).toString("base64");
const event = await encryptSecret(
  JSON.stringify({ id: "output", at: 1, kind: "message", text: "x".repeat(1024), tools: [], partial: true }),
  key,
);
const manifest = await encryptSecret(JSON.stringify({ request: { repos: [{ dir: "/workspace" }] } }), key);
// 50,000 encrypted 1 KiB output events. Sequence/cursor belongs to the journal,
// independently of harness event identity. Reuse ciphertext to keep fixture setup cheap.
const journal = Array.from({ length: 50_000 }, (_, i) => ({ sequence: String(i + 1), event_enc: event }));
let queries = 0,
  ciphertextRows = 0,
  now = 0;
const sql = {
  async query(query: string, values: unknown[] = []) {
    queries++;
    now += 1; // Injected logical clock: one work unit per SQL call, no sleeps.
    let rows: unknown[];
    if (query.includes("select sequence::text,event_enc")) {
      const backward = query.includes("sequence <");
      const boundary = values[1] == null ? Infinity : Number(values[1]);
      const candidates = journal.filter((r) =>
        backward ? Number(r.sequence) < boundary : Number(r.sequence) > boundary,
      );
      if (backward) candidates.reverse();
      rows = candidates.slice(0, Number(values[2]));
      ciphertextRows += Math.min(rows.length, Number(values[2]) - 1);
    } else if (query.includes("from public.sandboxes s join")) {
      rows = [
        {
          id,
          org_id: orgId,
          owner_id: userId,
          provider: "docker",
          role: "member",
          status: "running",
          stopped_at: null,
          expires_at: null,
          usage_turns: null,
          harness: "codex",
          prompt_sequence: "0",
          journal_sequence: "50000",
          conversation_ids: [],
        },
      ];
    } else if (query.includes("select request_enc")) {
      rows = [{ request_enc: manifest }];
      ciphertextRows++;
    } else if (query.includes("public.docker_queued_prompts") || query.includes("from public.runtime_commands"))
      rows = [];
    else throw Error(`Unexpected benchmark query: ${query}`);
    return { rows };
  },
} as Sql;
const controls = createDockerSandboxControls(sql, key, {
  clock: {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  },
});
const caller = { userId, orgs: [{ orgId, role: "member" as const }], via: "supabase" as const };
for (const [name, operations] of Object.entries({
  threadOpen: [
    ["status", {}],
    ["logs", {}],
  ],
  status: [["status", {}]],
  logsPage: [["logs", { since_cursor: `ar1_${id}_10000` }]],
  liveTail: [
    ["status", {}],
    ["logs", { since_cursor: `ar1_${id}_50000` }],
  ],
} satisfies Record<string, [string, Record<string, unknown>][]>)) {
  queries = ciphertextRows = now = 0;
  for (const [operation, args] of operations) {
    const reply = await controls.invoke(caller, operation, { id, ...args });
    if (!reply.handled) throw Error("Benchmark did not reach Docker controls");
  }
  console.log(JSON.stringify({ name, queries, decryptions: ciphertextRows, logicalSqlWork: now }));
}
