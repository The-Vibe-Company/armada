import { expect, spyOn, test } from "bun:test";
import type { AgentEvent, Sql } from "@armada/core";
import { createUsagePricingContext, decryptSecret } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture({
  isolated = false,
  provider = "boat",
}: {
  isolated?: boolean;
  provider?: "boat" | "modal";
} = {}) {
  const { db, people } = await (isolated ? database() : sharedDatabase());
  const id = crypto.randomUUID();
  if (provider === "modal") {
    const golden = (
      await db.query<{ id: string }>(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
       values($1,$2,'event-modal','private','modal','modal-master','modal-image','workspace','main','app',
       '{"repos":[{"url":"https://github.com/example/web.git","branch":"main","dir":"web"}],"init":[]}') returning id`,
        [people.org, people.owner],
      )
    ).rows[0]!;
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,runtime_transport)
       values($1,$2,$3,$4,'modal','event-modal','codex','ready','dialout')`,
      [id, golden.id, people.org, people.owner],
    );
  } else {
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime)
    select $1,id,org_id,owner_id,'event-native','codex','ready',true from goldens where owner_id=$2 and visibility='private' limit 1`,
      [id, people.owner],
    );
  }
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const enrol = async () =>
    authority.enrol(
      (await authority.issue({ ownerId: people.owner, sandboxId: id, configuration: {} })).enrolmentToken,
    );
  const route = () => createRuntimeEvents(authority, ENCRYPTION_KEY).route;
  const publish = async (
    active: Awaited<ReturnType<typeof enrol>>,
    events: { sequence: number; event: AgentEvent }[],
    extra = {},
  ) => {
    const response = await route()(
      new Request("https://armada.example/api/runtime/events", {
        method: "POST",
        headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
        body: JSON.stringify({ sandboxId: id, generation: active.epoch, events, ...extra }),
      }),
    );
    if (!response) throw Error("missing_event_route");
    return response;
  };
  const other = (id: string): Extract<AgentEvent, { kind: "other" }> => ({
    id,
    at: 1,
    kind: "other",
    type: "fixture",
    data: { marker: "private-archive-marker" },
  });
  const usage = (id: string): Extract<AgentEvent, { kind: "other" }> => ({
    id,
    at: 2,
    kind: "other",
    promptId: "prompt-a",
    type: "armada/turnUsage",
    data: {
      model: "gpt-6.1-sol",
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 10,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
  });
  const rows = async () =>
    (
      await db.query<{ sequence: string; epoch: string; event_enc: Uint8Array<ArrayBuffer> }>(
        "select sequence::text,epoch::text,event_enc from runtime_events order by sequence",
      )
    ).rows;
  const aggregate = async () =>
    (await db.query<{ usage_turns: unknown }>("select usage_turns from sandboxes where id=$1", [id])).rows[0]
      ?.usage_turns;
  return {
    db,
    sql,
    people,
    id,
    authority,
    enrol,
    route,
    publish,
    other,
    usage,
    rows,
    aggregate,
    close: async () => {
      if (isolated) await db.close();
    },
  };
}

test("ACK follows contiguous encrypted persistence and shared usage projection; replay is immutable and atomic", async () => {
  const f = await fixture({ isolated: true });
  try {
    const active = await f.enrol(),
      first = { sequence: 1, event: f.other("first") },
      third = { sequence: 3, event: f.other("third") };
    const response = await f.publish(active, [third, first]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ acknowledgedSequence: 1 });
    expect((await f.rows()).map((r) => r.sequence)).toEqual(["1"]);
    expect(await (await f.publish(active, [third])).json()).toEqual({ acknowledgedSequence: 1 });
    const second = { sequence: 2, event: f.usage("usage") };
    expect(await (await f.publish(active, [third, second, first])).json()).toEqual({ acknowledgedSequence: 3 });
    expect(await f.aggregate()).toMatchObject({
      turnCount: 1,
      turns: [{ promptId: "prompt-a", model: "gpt-6.1-sol", inputTokens: 100, outputTokens: 20, cachedTokens: 10 }],
    });
    const stored = await f.rows();
    expect(Buffer.from(stored[0]?.event_enc ?? []).includes(Buffer.from("private-archive-marker"))).toBe(false);
    const archived = stored[0];
    if (!archived) throw Error("missing encrypted event");
    expect(JSON.parse(await decryptSecret(archived.event_enc, ENCRYPTION_KEY))).toEqual(first.event);
    const reordered = {
      sequence: 1,
      event: {
        data: { marker: "private-archive-marker" },
        type: "fixture",
        kind: "other" as const,
        at: 1,
        id: "first",
      },
    };
    expect(await (await f.publish(active, [reordered])).json()).toEqual({ acknowledgedSequence: 3 });
    expect(
      (
        await f.publish(active, [
          { sequence: 4, event: f.other("fourth") },
          { sequence: 1, event: f.other("different") },
        ])
      ).status,
    ).toBe(409);
    expect(await f.rows()).toHaveLength(3);
    // Database failure after insert must roll the archive back too; never ACK lost projection work.
    await f.db.exec(`create function fail_runtime_usage() returns trigger language plpgsql as $$ begin raise exception 'synthetic storage failure'; end $$;
      create trigger fail_runtime_usage before update of usage_turns on sandboxes for each row execute function fail_runtime_usage();`);
    expect((await f.publish(active, [{ sequence: 4, event: f.usage("usage-after-fault") }])).status).toBe(503);
    expect(await f.rows()).toHaveLength(3);
    await f.db.exec("drop trigger fail_runtime_usage on sandboxes; drop function fail_runtime_usage()");
    expect(await (await f.publish(active, [{ sequence: 4, event: f.usage("usage-after-fault") }])).json()).toEqual({
      acknowledgedSequence: 4,
    });
    const unknown: AgentEvent = {
      id: "unknown-usage",
      at: 3,
      kind: "other",
      promptId: "prompt-unknown",
      type: "armada/turnUsage",
      data: {
        model: null,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    };
    expect(await (await f.publish(active, [{ sequence: 5, event: unknown }])).json()).toEqual({
      acknowledgedSequence: 5,
    });
    expect(await f.aggregate()).toMatchObject({
      turns: expect.arrayContaining([
        expect.objectContaining({ promptId: "prompt-unknown", model: null, inputTokens: null, outputTokens: null }),
      ]),
    });
  } finally {
    await f.close();
  }
});

test("a resumed epoch continues the persistent producer sequence and rejects the revoked runtime", async () => {
  const f = await fixture();
  try {
    const old = await f.enrol(),
      item = { sequence: 1, event: f.other("original") };
    expect(await (await f.publish(old, [item])).json()).toEqual({ acknowledgedSequence: 1 });
    const current = await f.enrol();
    expect((await f.publish(old, [{ sequence: 2, event: f.other("stale") }])).status).toBe(401);
    expect(await (await f.publish(current, [item, { sequence: 2, event: f.other("resumed") }])).json()).toEqual({
      acknowledgedSequence: 2,
    });
    expect((await f.rows()).map((r) => r.epoch)).toEqual([old.epoch, current.epoch]);
    expect((await f.publish(current, [item], { sandboxId: crypto.randomUUID() })).status).toBe(401);
    expect((await f.publish(current, [item], { generation: old.epoch })).status).toBe(401);
    await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.id]);
    expect((await f.publish(current, [{ sequence: 3, event: f.other("stopped") }])).status).toBe(401);
    expect(await f.rows()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("private archive grants and bounded event validation refuse malformed batches without publishing credentials", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    for (const role of ["anon", "authenticated"])
      expect(
        (
          await f.db.query<{ allowed: boolean }>(
            "select has_table_privilege($1,'runtime_events','select,insert,update,delete') as allowed",
            [role],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
    for (const sequence of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect((await f.publish(active, [{ sequence, event: f.other("bad") }])).status).toBe(400);
    expect(
      (await f.publish(active, [{ sequence: 1, event: { id: "invalid", at: 1, kind: "message" } as AgentEvent }]))
        .status,
    ).toBe(400);
    expect(
      (
        await f.publish(active, [
          { sequence: 1, event: { ...f.other("oversized"), data: { value: "x".repeat(262144) } } },
        ])
      ).status,
    ).toBe(413);
    expect((await f.publish(active, [], { padding: "x".repeat(1048576) })).status).toBe(413);
    const unsupported = await f.publish(active, [], {
      nativeAuth: { authJson: "not-auth-material", expectedRevision: 0 },
    });
    expect(unsupported.status).toBe(501);
    expect(await unsupported.json()).toEqual({ error: "runtime_native_auth_not_supported" });
    expect(await f.rows()).toHaveLength(0);
    expect(await f.route()(new Request("https://armada.example/healthz"))).toBeNull();
    expect((await f.route()(new Request("https://armada.example/api/runtime/events")))?.status).toBe(405);
  } finally {
    await f.close();
  }
});

test.each(["runtime", "server", "unicode-head"] as const)(
  "lost HTTP ACK leaves the journal pending; runtime/server restart retries without duplicate archive or usage (%s)",
  async (kind) => {
    const { RuntimeDialout } = await import("../../agent-runtime/src/dialout.ts");
    const { Journal, Runner } = await import("../../agent-runtime/src/index.ts");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const f = await fixture(),
      root = await mkdtemp(join(tmpdir(), "event-ack-"));
    let journal = new Journal(join(root, "journal"), (value) => value);
    try {
      const active = await f.enrol();
      let lost = true;
      let handler = f.route();
      const channel = new RuntimeDialout("https://armada.example", active, {
        socket() {
          throw Error("unused");
        },
        after() {
          throw Error("unused");
        },
        every() {
          throw Error("unused");
        },
        async fetch(url, options) {
          const response = await handler(new Request(url.href, options));
          if (!response) throw Error("event wire path mismatch");
          if (response.status === 200 && lost) {
            lost = false;
            // Lose the HTTP response after commit, then destroy ALL server-local
            // session/ingest state. The same runtime must replay on the new replica.
            handler = createRuntimeEvents(createRuntimeEnrolments(f.sql, ENCRYPTION_KEY), ENCRYPTION_KEY).route;
            throw Error("lost_ack_after_commit");
          }
          return response;
        },
      });
      const grant = {
        token: active.runtimeToken,
        sandboxId: f.id,
        generation: active.epoch,
        expiresAt: Date.now() + 60000,
      };
      const driver = {
        start() {
          throw Error("no harness expected");
        },
        async close() {},
      };
      let runner = new Runner(journal, grant, { codex: driver, claude: driver }, channel);
      if (kind === "unicode-head")
        journal.append({
          id: "unicode-head",
          at: 1,
          kind: "message",
          text: "😀".repeat(100000),
          partial: false,
          tools: [],
        });
      const count = kind === "unicode-head" ? 2 : 1;
      journal.append(f.usage("journal-native-usage"));
      await expect(runner.flushOutbox()).rejects.toThrow("lost_ack_after_commit");
      expect(journal.ack).toBe(0);
      expect(await f.rows()).toHaveLength(count);
      if (kind !== "server") {
        journal.close();
        journal = new Journal(join(root, "journal"), (value) => value);
        runner = new Runner(journal, grant, { codex: driver, claude: driver }, channel);
      }
      await runner.flushOutbox();
      expect(journal.ack).toBe(count);
      expect(await f.rows()).toHaveLength(count);
      expect(await f.aggregate()).toMatchObject({ turnCount: 1, turns: [{ inputTokens: 100, outputTokens: 20 }] });
      if (kind === "server") {
        journal.append({
          id: "after-restart",
          at: 4,
          kind: "prompt",
          promptId: "prompt-a",
          text: "fixture",
          status: "finished",
        });
        await runner.flushOutbox();
        expect(journal.ack).toBe(count + 1);
        expect(await f.rows()).toHaveLength(count + 1);
      }
    } finally {
      journal.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("unmeasured prompt-only turns accumulate across batches without claiming complete token coverage", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    for (const [index, promptId] of ["unmeasured-a", "unmeasured-a", "unmeasured-b"].entries()) {
      const event: AgentEvent = {
        id: `prompt-${index}`,
        at: index,
        kind: "prompt",
        promptId,
        text: "synthetic",
        status: "failed",
      };
      expect((await f.publish(active, [{ sequence: index + 1, event }])).status).toBe(200);
    }
    expect(await f.aggregate()).toMatchObject({ turnCount: 2, turns: [] });
    expect((await f.publish(active, [{ sequence: 4, event: f.usage("measured-only") }])).status).toBe(200);
    expect(await f.aggregate()).toMatchObject({
      turnCount: 3,
      turns: [{ promptId: "prompt-a", inputTokens: 100, outputTokens: 20 }],
    });
  } finally {
    await f.close();
  }
});

test("durable runtime history paginates the authenticated archive after stop without native or live runtime access", async () => {
  const { createRuntimeHistory } = await import("../src/runtime-history.ts");
  const f = await fixture();
  try {
    const active = await f.enrol();
    const message = (id: string, text: string, conversationId = "conversation"): AgentEvent => ({
      id,
      at: 3,
      kind: "message",
      text,
      partial: false,
      tools: [],
      conversationId,
      messageId: "answer",
      textMode: "snapshot",
    });
    expect(
      (
        await f.publish(active, [
          { sequence: 1, event: message("first", "Hello") },
          { sequence: 2, event: message("second", "Hello runtime") },
          { sequence: 3, event: message("other", "Unrelated", "another") },
          { sequence: 4, event: { ...f.other("end"), conversationId: "conversation" } },
        ])
      ).status,
    ).toBe(200);
    await f.db.query("update sandboxes set status='stopped',stopped_at=now(),stop_requested_at=now() where id=$1", [
      f.id,
    ]);
    const read = createRuntimeHistory(f.sql, ENCRYPTION_KEY);
    const caller = {
      userId: f.people.owner,
      orgs: [{ orgId: f.people.org, role: "member" as const }],
      via: "service" as const,
    };
    const first = await read(caller, f.id, { limit: 2, coalesce: true });
    expect(first).toMatchObject({
      source: "armada-runtime",
      events: [{ kind: "message", text: "Hello runtime" }],
      hasMore: true,
    });
    expect(first.events).toHaveLength(1);
    const next = await read(caller, f.id, { cursor: first.cursor ?? "", limit: 1, conversationId: "conversation" });
    expect(next.events).toEqual([]);
    expect(next.cursor).not.toBe(first.cursor);
    const end = await read(caller, f.id, { cursor: next.cursor ?? "" });
    expect(end.events.map((event) => event.id)).toEqual(["end"]);
    expect(end.hasMore).toBe(false);
    const tail = await read(caller, f.id, { direction: "backward", limit: 2 });
    expect(tail.events.map((event) => event.id)).toEqual(["other", "end"]);
    const older = await read(caller, f.id, { direction: "backward", cursor: tail.olderCursor ?? "", limit: 2 });
    expect(older.events.map((event) => event.id)).toEqual(["first", "second"]);
    await expect(read(caller, f.id, { cursor: `ar1_${crypto.randomUUID()}_1` })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(read(caller, f.id, { cursor: "native-boat-cursor" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(read({ ...caller, userId: f.people.member }, f.id, {})).rejects.toMatchObject({ code: "not_found" });
    const other = { ...caller, orgs: [{ orgId: f.people.otherOrg, role: "admin" as const }] };
    await expect(read(other, f.id, {})).rejects.toMatchObject({ code: "not_found" });
    const bounded = await read(caller, f.id, { maxBytes: 256 });
    expect(bounded.hasMore).toBe(true);
    expect(bounded.cursor).toBeDefined();
    const nativeId = crypto.randomUUID();
    await f.db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
       select $2,golden_id,org_id,owner_id,'history-native','codex','ready' from sandboxes where id=$1`,
      [f.id, nativeId],
    );
    await expect(read(caller, nativeId, {})).rejects.toMatchObject({ code: "not_found" });
    await f.db.query("update runtime_events set event_enc=$2 where sandbox_id=$1 and sequence=1", [
      f.id,
      new Uint8Array([1, 2, 3]),
    ]);
    await expect(read(caller, f.id, {})).rejects.toMatchObject({
      code: "unavailable",
      message: "Runtime history is unavailable.",
    });
  } finally {
    await f.close();
  }
});

test("runtime archive rechecks membership after decryption before returning history", async () => {
  const { createRuntimeHistory } = await import("../src/runtime-history.ts");
  const f = await fixture();
  try {
    const active = await f.enrol();
    await f.publish(active, [{ sequence: 1, event: f.other("private") }]);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const observed = spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
      const plaintext = await decrypt(...args);
      await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
      return plaintext;
    });
    try {
      await expect(
        createRuntimeHistory(f.sql, ENCRYPTION_KEY)(
          {
            userId: f.people.owner,
            orgs: [{ orgId: f.people.org, role: "member" }],
            via: "service",
          },
          f.id,
          {},
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      observed.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test.each(["boat", "modal"] as const)(
  "runtime archive projects coherent observed costs from the frozen admission across replay and resume, never guest money or missing tokens (%s)",
  async (provider) => {
    const f = await fixture({ provider });
    const caller = {
      userId: f.people.owner,
      via: "service" as const,
      orgs: [{ orgId: f.people.org, role: "member" as const }],
    };
    const store = createSqlData(f.sql)(caller).sandboxes;
    const read = async () => {
      const usage = (await store.get(f.id))?.usage;
      if (!usage) throw Error("Missing usage fixture");
      // The live compute clock is not part of the immutable token/cost snapshot.
      return { cost: usage.cost, turns: usage.turns, tokenTotals: usage.tokenTotals, turnCount: usage.turnCount };
    };
    const book = createUsagePricingContext({
      harness: "codex",
      credentialKind: "openai",
      customEndpoint: true,
      credentialId: crypto.randomUUID(),
      credentialVersion: 1,
      modelPrices: { "gpt-6.1-sol": { input: "2", output: "5", cacheRead: "1", cacheWrite: null, reasoning: null } },
    });
    await store.recordUsagePricingContext!(f.id, book);
    const first = {
      sequence: 1,
      event: {
        ...f.usage("priced-first"),
        data: { ...(f.usage("template").data as object), cacheWriteTokens: 0, usd: "999", pricing: { usd: "999" } },
      },
    };
    const active = await f.enrol();
    expect((await f.publish(active, [first])).status).toBe(200);
    const initial = await read();
    expect(initial?.cost).toMatchObject({ usd: "0.00029", basis: "estimated", unknown: null, unpricedTurns: 0 });
    expect(initial?.turns[0]?.pricing).toMatchObject({
      snapshot: book.prices["gpt-6.1-sol"],
      inputs: { inputTokens: 100, outputTokens: 20, cachedTokens: 10, cacheWriteTokens: 0 },
    });
    // A catalog/account edit does not rewrite the pre-work session admission.
    await store.recordUsagePricingContext!(f.id, {
      ...book,
      prices: {
        "gpt-6.1-sol": {
          ...book.prices["gpt-6.1-sol"]!,
          rates: { ...book.prices["gpt-6.1-sol"]!.rates, input: "200" },
        },
      },
    });
    expect((await f.publish(active, [first])).status).toBe(200);
    expect(await read()).toEqual(initial);
    const resumed = await f.enrol();
    const second = {
      sequence: 2,
      event: {
        ...f.usage("priced-resumed"),
        promptId: "prompt-b",
        data: {
          model: "gpt-6.1-sol",
          inputTokens: 50,
          outputTokens: 4,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: null,
        },
      },
    };
    expect((await f.publish(active, [second])).status).toBe(401);
    expect((await f.publish(resumed, [first, second])).status).toBe(200);
    const two = await read();
    expect(two?.turnCount).toBe(2);
    expect(two?.cost).toMatchObject({ usd: "0.00041", unknown: null, unpricedTurns: 0 });
    expect(two?.tokenTotals).toMatchObject({ inputTokens: 150, outputTokens: 24 });
    expect((await f.publish(resumed, [second])).status).toBe(200);
    expect(await read()).toEqual(two);
    const missing = { sequence: 3, event: { ...f.usage("missing-counter"), promptId: "prompt-c" } };
    expect((await f.publish(resumed, [missing])).status).toBe(200);
    const incomplete = await read();
    expect(incomplete?.turns.find((r) => r.promptId === "prompt-c")?.pricing).toMatchObject({
      unknown: "tokens",
      usd: null,
      snapshot: book.prices["gpt-6.1-sol"],
    });
    expect(incomplete?.turns.find((r) => r.promptId === "prompt-c")?.cacheWriteTokens).toBeNull();
    expect(incomplete?.tokenTotals).toMatchObject({
      inputTokens: 250,
      outputTokens: 44,
      cacheWriteTokens: 0,
      incomplete: true,
    });
    expect(incomplete?.cost).toMatchObject({ usd: null, unknown: "tokens", unpricedTurns: 1 });
  },
);
