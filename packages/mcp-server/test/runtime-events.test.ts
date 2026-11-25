import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import type { AgentEvent } from "@armada/core";
import { streamSandboxEvents } from "@armada/core/contract";
import * as coreServer from "@armada/core/server";
import { createUsagePricingContext, decryptSecret, encryptSecret } from "@armada/core/server";
import { type IngestClient, Journal, Runner } from "../../agent-runtime/src/index.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createEventFeed } from "../src/event-feed.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createOutboundWebhooks } from "../src/outbound-webhooks.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeIdle } from "../src/runtime-idle.ts";
import { createServerRequestDrain } from "../src/server-request-drain.ts";
import { sqlOver } from "../src/sql.ts";
import { eventFeedWakeKey, runtimeWakes } from "../src/wake-bus.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture({ provider = "boat" }: { provider?: "boat" | "modal" } = {}) {
  const { db, people, openaiCredentialId } = await sharedDatabase();
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
  const queries: string[] = [];
  const sql = sqlOver({
    unsafe: async (q, v) => (await db.query(q, v)).rows,
    begin: (work) =>
      db.transaction((tx) =>
        work({
          unsafe: async (q, v) => {
            queries.push(q);
            return (await tx.query(q, v)).rows;
          },
        }),
      ),
  });
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
    queries,
    sql,
    people,
    id,
    openaiCredentialId,
    authority,
    enrol,
    route,
    publish,
    other,
    usage,
    rows,
    aggregate,
    close: async () => {
      await db.exec(
        "reset role; reset all; set search_path=public; drop trigger if exists fail_runtime_usage on sandboxes; drop function if exists fail_runtime_usage()",
      );
    },
  };
}

test("ACK follows contiguous encrypted persistence and shared usage projection; replay is immutable and atomic", async () => {
  const f = await fixture();
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
    await f.db.query("update sandboxes set status='running',task_prompt_id='prompt-a' where id=$1", [f.id]);
    const completion = [
      { sequence: 4, event: f.usage("usage-after-fault") },
      {
        sequence: 5,
        event: { id: "terminal", kind: "prompt", status: "finished", promptId: "prompt-a", text: "", at: 3 },
      },
    ] satisfies { sequence: number; event: AgentEvent }[];
    const status = async () => (await f.db.query("select status from sandboxes where id=$1", [f.id])).rows;
    // Database failure after insert must roll back the archive and lifecycle journal before ACK.
    await f.db.exec(`create function fail_runtime_usage() returns trigger language plpgsql as $$ begin raise exception 'synthetic storage failure'; end $$;
      create trigger fail_runtime_usage before update of usage_turns on sandboxes for each row execute function fail_runtime_usage();`);
    expect((await f.publish(active, completion)).status).toBe(503);
    expect(await f.rows()).toHaveLength(3);
    expect(await status()).toEqual([{ status: "running" }]);
    await f.db.exec("drop trigger fail_runtime_usage on sandboxes; drop function fail_runtime_usage()");
    expect(await (await f.publish(active, completion)).json()).toEqual({ acknowledgedSequence: 5 });
    expect(await status()).toEqual([{ status: "ready" }]);
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
    expect(await (await f.publish(active, [{ sequence: 6, event: unknown }])).json()).toEqual({
      acknowledgedSequence: 6,
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

test("the runtime archive links only visible model text to its prompt UUID", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    const promptId = crypto.randomUUID();
    const message = (sequence: number, extra: Partial<Extract<AgentEvent, { kind: "message" }>> = {}) => ({
      sequence,
      event: {
        id: `message-${sequence}`,
        at: 1,
        kind: "message" as const,
        promptId,
        text: "hello",
        partial: true,
        tools: [],
        ...extra,
      },
    });
    const response = await f.publish(active, [
      { sequence: 1, event: { ...f.other("status"), promptId } },
      message(2, { text: "  " }),
      message(3, { responseKind: "tool_result" }),
      message(4, { retracted: true }),
      message(5, { promptId: "non-uuid" }),
      message(6),
    ]);
    expect(await response.json()).toEqual({ acknowledgedSequence: 6 });
    const { rows } = await f.db.query<{ visible_text_prompt_id: string | null }>(
      "select visible_text_prompt_id from runtime_events where sandbox_id=$1 order by sequence",
      [f.id],
    );
    expect(rows.map((row) => row.visible_text_prompt_id)).toEqual([null, null, null, null, null, promptId]);
  } finally {
    await f.close();
  }
});

// #2560: the first model output dates the activation's first token by the model event's own time, not the upload
// time (a journal buffered while disconnected keeps its timestamps). Other events, tool results and output from
// before the activation was accepted do not count; the earliest output wins.
test("first model output of an activation is recorded once as its first token, dated by the event", async () => {
  const f = await fixture();
  try {
    await f.db.query("update sandboxes set status='starting' where id=$1", [f.id]);
    const accepted = Date.parse("2020-01-01T17:00:00.000Z");
    await f.db.query("update sandbox_launch_stages set at=$2 where sandbox_id=$1 and stage='accepted'", [
      f.id,
      new Date(accepted).toISOString(),
    ]);
    const active = await f.enrol();
    const message = (id: string, at: number, extra = {}): AgentEvent => ({
      id,
      at,
      kind: "message",
      text: "ok",
      partial: true,
      tools: [],
      ...extra,
    });
    const firstToken = async () =>
      (
        await f.db.query<{ ms: number }>(
          "select (extract(epoch from at)*1000)::float8 as ms from sandbox_launch_stages where sandbox_id=$1 and stage='first_token'",
          [f.id],
        )
      ).rows.map((row) => Number(row.ms));
    const buffered = Date.parse("2020-01-01T17:50:24.928Z");
    await f.publish(active, [
      { sequence: 1, event: f.other("other") },
      { sequence: 2, event: message("tool-result", buffered - 1000, { responseKind: "tool_result" }) },
      { sequence: 3, event: message("before-activation", accepted - 1000) },
    ]);
    expect(await firstToken()).toEqual([]);
    // Uploaded now (years later), persisted at the model output's time.
    await f.publish(active, [
      { sequence: 4, event: message("first", buffered) },
      { sequence: 5, event: message("second", buffered + 5000) },
    ]);
    expect(await firstToken()).toEqual([buffered]);
    await f.publish(active, [{ sequence: 6, event: message("later", buffered + 60_000) }]);
    expect(await firstToken()).toEqual([buffered]);
    // A runtime clock ahead of the server never dates output in the future.
    await f.db.query("delete from sandbox_launch_stages where sandbox_id=$1 and stage='first_token'", [f.id]);
    // The server clamps to its database clock, so bound it with samples of that
    // clock taken around the publish rather than the runner's wall clock.
    const dbNow = async () =>
      (await f.db.query<{ ms: number }>("select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms")).rows[0]!
        .ms;
    const before = await dbNow();
    await f.publish(active, [{ sequence: 7, event: message("skewed", before + 3_600_000) }]);
    const after = await dbNow();
    const [skewed] = await firstToken();
    expect(skewed).toBeGreaterThanOrEqual(Math.floor(before));
    expect(skewed).toBeLessThanOrEqual(Math.ceil(after));
  } finally {
    await f.close();
  }
});

test("a maximum event batch uses bounded SQL and detects duplicate conflicts before committing", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const batch = Array.from({ length: 1000 }, (_, i) => ({
    sequence: i + 1,
    event: f.other(`event-${i}`),
  }));
  f.queries.length = 0;
  expect(await (await f.publish(active, batch)).json()).toEqual({ acknowledgedSequence: 1000 });
  // Includes session authorization/locks, archive high-water/read and one bulk insert.
  expect(f.queries.length).toBeLessThanOrEqual(11);
  expect(await f.rows()).toHaveLength(1000);
  f.queries.length = 0;
  expect(await (await f.publish(active, batch)).json()).toEqual({ acknowledgedSequence: 1000 });
  expect(f.queries.length).toBeLessThanOrEqual(11);
  const next = { sequence: 1001, event: f.other("next") };
  expect(await (await f.publish(active, [next, next])).json()).toEqual({ acknowledgedSequence: 1001 });
  const conflict = { sequence: 1002, event: f.other("new") };
  expect((await f.publish(active, [conflict, { ...conflict, event: f.other("conflict") }])).status).toBe(409);
  expect(await f.rows()).toHaveLength(1001);
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
    f.queries.length = 0;
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
    expect(f.queries).toHaveLength(0);
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

test("a lost HTTP ACK survives journal reopen and server replacement without duplicate archive or usage", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const grant = {
    token: active.runtimeToken,
    sandboxId: f.id,
    generation: active.epoch,
    expiresAt: Date.UTC(2100, 0, 1),
  };
  const text = "😀".repeat(60000);
  const root = await mkdtemp(join(tmpdir(), "event-ack-"));
  const path = join(root, "journal");
  const openJournal = () => new Journal(path, (value) => value);
  const publish = async (route: ReturnType<typeof f.route>, batch: Parameters<IngestClient["append"]>[0]) => {
    const response = await route(
      new Request("https://armada.example/api/runtime/events", {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}`, "x-armada-runtime-epoch": grant.generation },
        body: JSON.stringify(batch),
      }),
    );
    expect(response?.status).toBe(200);
    return response!;
  };

  try {
    const journal = openJournal();
    try {
      const original = f.route();
      const runner = new Runner(
        journal,
        grant,
        {},
        {
          async append(batch) {
            await publish(original, batch);
            throw Error("lost_ack_after_commit");
          },
        },
      );
      journal.append({
        id: "unicode-head",
        at: 1,
        kind: "message",
        text,
        partial: false,
        tools: [],
      });
      journal.append(f.usage("journal-usage"));
      await expect(runner.flushOutbox()).rejects.toThrow("lost_ack_after_commit");
      expect(journal.ack).toBe(0);
    } finally {
      journal.close();
    }
    const archive = await f.rows();
    expect(archive).toHaveLength(2);
    expect(JSON.parse(await decryptSecret(archive[0]!.event_enc, ENCRYPTION_KEY))).toMatchObject({
      id: "unicode-head",
      text,
    });
    expect(await f.aggregate()).toMatchObject({ turnCount: 1, turns: [{ inputTokens: 100, outputTokens: 20 }] });

    const reopened = openJournal();
    try {
      const replacement = createRuntimeEvents(createRuntimeEnrolments(f.sql, ENCRYPTION_KEY), ENCRYPTION_KEY).route;
      const runner = new Runner(
        reopened,
        grant,
        {},
        {
          async append(batch) {
            return (await publish(replacement, batch)).json() as ReturnType<IngestClient["append"]>;
          },
        },
      );
      expect(reopened.ack).toBe(0);
      await runner.flushOutbox();
      expect(reopened.ack).toBe(2);
      expect(await f.rows()).toEqual(archive);
      expect(await f.aggregate()).toMatchObject({ turnCount: 1, turns: [{ inputTokens: 100, outputTokens: 20 }] });

      reopened.append({
        id: "after-restart",
        at: 4,
        kind: "prompt",
        promptId: "prompt-a",
        text: "fixture",
        status: "finished",
      });
      await runner.flushOutbox();
      expect(reopened.ack).toBe(3);
      expect(await f.rows()).toHaveLength(3);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

test("the runtime sweep settles a completed turn published by an overlapping server", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const promptId = crypto.randomUUID();
  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind: "prompt",
    promptId,
    status: "failed",
    at: 1,
    text: "",
  };
  expect((await f.publish(active, [{ sequence: 1, event }])).status).toBe(200);
  await f.db.query(
    "update sandboxes set status='running',task_prompt_id=$2,expires_at=now()+interval '1 hour' where id=$1",
    [f.id, promptId],
  );
  const checkpoint = mock(async () => {
    throw Error("A recently settled turn is not ready for idle checkpointing.");
  });
  const idle = createRuntimeIdle(f.sql, ENCRYPTION_KEY, checkpoint, { now: () => 2 });
  await idle.reconcileOne(new AbortController().signal);
  expect((await f.db.query("select status from sandboxes where id=$1", [f.id])).rows).toEqual([{ status: "ready" }]);
  expect(checkpoint).not.toHaveBeenCalled();
});

test.each(["current", "superseded", "revoked", "rolled back"] as const)(
  "idle stop handoff with a %s checkpoint publication",
  async (scenario) => {
    const f = await fixture({ provider: scenario === "current" ? "modal" : "boat" });
    const active = await f.enrol();
    const promptId = crypto.randomUUID();
    await f.db.query(
      `update sandboxes set task_prompt_id=$2,expires_at=now()+interval '1 hour',
       reconcile_after=now()+interval '1 hour' where id=$1`,
      [f.id, promptId],
    );
    const event: AgentEvent = { id: promptId, kind: "prompt", promptId, status: "finished", at: 1, text: "" };
    expect((await f.publish(active, [{ sequence: 1, event }])).status).toBe(200);
    const read = async () =>
      (
        await f.db.query<{
          status: string;
          status_reason: string | null;
          lifecycle_generation: string;
          stop_generation: string;
          expires_at: string;
          stop_requested: boolean;
          due: boolean;
        }>(
          `select status,status_reason,lifecycle_generation::text,stop_generation::text,expires_at::text,
                stop_requested_at is not null as stop_requested,reconcile_after<=now() as due
         from sandboxes where id=$1`,
          [f.id],
        )
      ).rows[0]!;
    const before = await read();
    const checkpointRequests: string[] = [];
    let now = 100;
    const idle = createRuntimeIdle(
      f.sql,
      ENCRYPTION_KEY,
      async (_actor, input, guard) => {
        await guard!(f.sql);
        await f.db.query(
          `insert into runtime_checkpoints(sandbox_id,epoch,request_id,watermark,completed_at)
         values($1,$2,$3,1,now()) on conflict (sandbox_id,epoch) do nothing`,
          [f.id, active.epoch, input.request_id],
        );
        if (scenario === "superseded")
          await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [f.id]);
        if (scenario === "revoked")
          await f.authority.issue({ ownerId: f.people.owner, sandboxId: f.id, configuration: {} });
        checkpointRequests.push(input.request_id);
        return {
          id: input.id,
          requestId: input.request_id,
          runtime: { kind: "armada", epoch: active.epoch },
          checkpoint: { state: "complete", watermark: 1, acknowledgedSequence: 1 },
        };
      },
      { delayMs: 10, now: () => now },
    );
    const sweep = () => idle.reconcileOne(new AbortController().signal);
    const readJournal = async () =>
      (
        await f.db.query(
          `select from_status,to_status,actor,code,generation::text
         from sandbox_transitions where sandbox_id=$1 and to_status='stopping'`,
          [f.id],
        )
      ).rows;
    if (scenario === "rolled back") {
      await f.db.exec(`
        create function fail_idle_stop_publication() returns trigger language plpgsql as $$
        begin
          raise exception 'idle stop publication failed';
        end $$;
        create trigger fail_idle_stop_publication after update of status on sandboxes
        for each row when (new.status = 'stopping') execute function fail_idle_stop_publication();
      `);
      try {
        await sweep();
        expect(await read()).toEqual(before);
        expect(await readJournal()).toEqual([]);
        expect(checkpointRequests).toHaveLength(1);
      } finally {
        await f.db.exec(
          "drop trigger fail_idle_stop_publication on sandboxes; drop function fail_idle_stop_publication()",
        );
      }
      now += 60_000;
    }
    await sweep();
    expect(checkpointRequests).toHaveLength(scenario === "rolled back" ? 2 : 1);
    if (scenario === "rolled back") expect(checkpointRequests[1]).toBe(checkpointRequests[0]);
    const journal = await readJournal();
    if (scenario === "superseded") {
      expect(journal).toEqual([]);
      expect(await read()).toEqual({
        ...before,
        lifecycle_generation: String(Number(before.lifecycle_generation) + 1),
      });
    } else if (scenario === "revoked") {
      expect(journal).toEqual([]);
      expect(await read()).toEqual(before);
    } else {
      expect(journal).toEqual([
        {
          from_status: "ready",
          to_status: "stopping",
          actor: "idle",
          code: "runtime_checkpoint_idle_paused",
          generation: before.lifecycle_generation,
        },
      ]);
      expect(await read()).toEqual({
        ...before,
        status: "stopping",
        status_reason: "idle_paused",
        stop_requested: true,
        stop_generation: String(Number(before.stop_generation) + 1),
        due: scenario === "current",
      });
      expect((await f.db.query("select state from jobs where sandbox_id=$1 and kind='stop'", [f.id])).rows).toEqual([
        { state: "queued" },
      ]);
    }
  },
);

test("idle evidence upgrades long archives, survives enrolment renewal, and blocks unresolved turns and commands", async () => {
  const f = await fixture();
  let active = await f.enrol();
  const ciphertext = await encryptSecret(JSON.stringify(f.other("archived")), ENCRYPTION_KEY);
  await f.db.query(
    `insert into runtime_events(sandbox_id,sequence,epoch,event_enc)
     select $1,n,$2,$3 from generate_series(1,10001) n`,
    [f.id, active.epoch, ciphertext],
  );
  const prompt = (promptId: string, status: "running" | "finished", at: number): AgentEvent => ({
    id: promptId + status,
    promptId,
    status,
    at,
    kind: "prompt",
    text: "",
  });
  await f.db.query("update sandboxes set task_prompt_id='current',expires_at=now()+interval '1 hour' where id=$1", [
    f.id,
  ]);
  let admitted = 0;
  let now = 1000;
  const idle = createRuntimeIdle(
    f.sql,
    ENCRYPTION_KEY,
    async (_actor, _input, guard) => {
      await guard!(f.sql);
      admitted++;
      throw Error("test stops before provider dispatch");
    },
    { delayMs: 10, now: () => now },
  );
  const sweep = async () => {
    now += 60000;
    await idle.reconcileOne(new AbortController().signal);
  };
  // Crypto has its own boundary tests; avoid 10,001 identical decryptions here.
  const decrypt = coreServer.decryptSecret;
  const archiveJson = JSON.stringify(f.other("archived"));
  const cryptoSpy = spyOn(coreServer, "decryptSecret").mockImplementation(async (bytes, key) =>
    Buffer.from(bytes).equals(Buffer.from(ciphertext)) ? archiveJson : decrypt(bytes, key),
  );
  expect(
    (
      await f.publish(active, [
        { sequence: 10002, event: { ...f.other("earlier"), promptId: "earlier" } },
        { sequence: 10003, event: prompt("current", "finished", 3) },
      ])
    ).status,
  ).toBe(200);
  cryptoSpy.mockRestore();

  await sweep();
  expect(admitted).toBe(0);
  expect((await f.publish(active, [{ sequence: 10004, event: prompt("earlier", "finished", 4) }])).status).toBe(200);
  active = await f.enrol();
  await sweep();
  expect(admitted).toBe(1);
  await f.db.query(
    `insert into runtime_commands(sandbox_id,epoch,request_id,request_enc)
     values($1,$2,$3,$4)`,
    [f.id, active.epoch, crypto.randomUUID(), ciphertext],
  );
  await sweep();
  expect(admitted).toBe(1);
  await f.db.query("delete from runtime_commands where sandbox_id=$1", [f.id]);
  // An output read past its deadline is abandoned: nobody awaits it, so it never blocks idle.
  await f.db.query(
    `insert into runtime_commands(sandbox_id,epoch,request_id,request_enc)
     values($1,$2,$3,$4)`,
    [f.id, active.epoch, `outputs_${now + 60000}_expired`, ciphertext],
  );
  await sweep();
  expect(admitted).toBe(2);
  await f.db.query("delete from runtime_commands where sandbox_id=$1", [f.id]);
  expect(
    (
      await f.publish(active, [
        { sequence: 10005, event: { id: "unknown", kind: "prompt", text: "", status: "finished", at: 5 } },
      ])
    ).status,
  ).toBe(200);
  await sweep();
  expect(admitted).toBe(2);
});

test("runtime retry metadata is published without a status read and clears on progress", async () => {
  const f = await fixture();
  const active = await f.enrol();
  await f.db.query("insert into sandbox_turn_models(sandbox_id,prompt_id) values($1,'retry_prompt')", [f.id]);
  const retry: AgentEvent = {
    id: "retry_metadata",
    at: Date.now(),
    kind: "other",
    promptId: "retry_prompt",
    type: "armada/modelRateLimit",
    data: { retryCount: 1, delayMs: 60000, totalWaitMs: 60000 },
  };
  const retryAt = async () =>
    (
      await f.db.query<{ pending: boolean }>(
        "select rate_limit_retry_at > now() as pending from sandbox_turn_models where sandbox_id=$1 and prompt_id='retry_prompt'",
        [f.id],
      )
    ).rows[0]?.pending;
  expect((await f.publish(active, [{ sequence: 1, event: retry }])).status).toBe(200);
  expect(await retryAt()).toBe(true);
  const progress: AgentEvent = {
    id: "retry_progress",
    text: "work",
    at: retry.at + 1,
    kind: "prompt",
    promptId: "retry_prompt",
    status: "finished",
  };
  expect((await f.publish(active, [{ sequence: 2, event: progress }])).status).toBe(200);
  expect(await retryAt()).toBeNull();
  await f.publish(active, [{ sequence: 1, event: retry }]);
  expect(await retryAt()).toBeNull();
});

test("terminal runtime prompts admit one webhook and one Langfuse export across replay", async () => {
  const f = await fixture({ provider: "modal" });
  try {
    await f.db.query(
      "insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2)",
      [f.people.org, await encryptSecret("webhook_secret", ENCRYPTION_KEY)],
    );
    await f.db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'metadata',$2)", [
      f.people.org,
      await encryptSecret("langfuse_config", ENCRYPTION_KEY),
    ]);
    const active = await f.enrol();
    const event: AgentEvent = {
      id: "terminal_event",
      at: 10,
      kind: "prompt",
      promptId: "completed_prompt",
      status: "failed",
      text: "private_prompt_content",
    };
    const batch = [{ sequence: 1, event }];
    expect((await f.publish(active, batch)).status).toBe(200);
    expect((await f.publish(active, batch)).status).toBe(200);
    const deliveries = (
      await f.db.query<{ payload: Record<string, unknown> }>("select payload from outbound_webhook_deliveries")
    ).rows;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload).toMatchObject({
      type: "turn.failed",
      sandboxId: f.id,
      promptId: "completed_prompt",
      externalRef: null,
      reason: "turn_failed",
    });
    expect(JSON.stringify(deliveries)).not.toContain("private_prompt_content");
    expect(
      (await f.db.query("select sandbox_id,prompt_id,runtime_ack,terminal_status from langfuse_turn_exports")).rows,
    ).toEqual([{ sandbox_id: f.id, prompt_id: "completed_prompt", runtime_ack: 1, terminal_status: "failed" }]);
  } finally {
    await f.close();
  }
});

test("failed webhook jobs persist the original backoff and stop after five sends", async () => {
  const f = await fixture();
  try {
    const endpoint = (
      await f.db.query<{ id: string }>(
        "insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2) returning id",
        [f.people.org, await encryptSecret("webhook_secret", ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    await f.db.query("insert into outbound_webhook_deliveries(endpoint_id,payload) values($1,'{}')", [endpoint.id]);
    const store = createJobsStore(f.sql);
    const owner = crypto.randomUUID();
    const now = Date.UTC(2030, 0, 1);
    const worker = createOutboundWebhooks(f.sql, ENCRYPTION_KEY, "https://armada.example", {
      now: () => now,
      send: async () => 503,
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const job = (await store.claim("webhook", owner, 30, 1))!;
      const result = await worker.run(job, {
        signal: new AbortController().signal,
        canDispatch: async () => (await store.inspect(job, owner)) === "dispatch",
      });
      expect(await store.complete(job, owner, result)).toBe(true);
      const row = (
        await f.db.query<{ attempts: number; last_status: number; next_attempt_at: Date }>(
          "select attempts,last_status,next_attempt_at from outbound_webhook_deliveries where id=$1",
          [job.id],
        )
      ).rows[0]!;
      expect(row.attempts).toBe(attempt);
      expect(row.last_status).toBe(503);
      expect(new Date(row.next_attempt_at).getTime()).toBe(now + 30_000 * 2 ** (attempt - 1));
      expect(await store.claim("webhook", owner, 30, 1)).toBeUndefined();
      await f.db.query("update jobs set run_after=now()-interval '1 second' where id=$1", [job.id]);
      await f.db.query("update outbound_webhook_deliveries set next_attempt_at=now()-interval '1 second' where id=$1", [
        job.id,
      ]);
    }
    expect(await store.claim("webhook", owner, 30, 1)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a lost webhook settlement replays the same signed delivery ID under a new epoch", async () => {
  const f = await fixture();
  try {
    const endpoint = (
      await f.db.query<{ id: string }>(
        "insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2) returning id",
        [f.people.org, await encryptSecret("webhook_secret", ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    const { rows: deliveries } = await f.db.query<{ id: string }>(
      "insert into outbound_webhook_deliveries(endpoint_id,payload) values($1,'{}') returning id",
      [endpoint.id],
    );
    const id = deliveries[0]!.id;
    const oldClaim = await f.db.query(
      "update outbound_webhook_deliveries set attempts=attempts+1,lease_until=now()+interval '60 seconds' where id=$1 returning id",
      [id],
    );
    expect(oldClaim.rows).toEqual([]);
    const store = createJobsStore(f.sql);
    const owner = crypto.randomUUID();
    const sent: (string | undefined)[] = [];
    const worker = createOutboundWebhooks(f.sql, ENCRYPTION_KEY, "https://armada.example", {
      now: () => Date.UTC(2030, 0, 1),
      send: async (_url, _body, headers) => {
        sent.push(headers["Armada-Webhook-Id"]);
        return 204;
      },
    });
    const run = async () => {
      const job = (await store.claim("webhook", owner, 30, 1))!;
      const result = await worker.run(job, {
        signal: new AbortController().signal,
        canDispatch: async () => (await store.inspect(job, owner)) === "dispatch",
      });
      return { job, result };
    };
    const first = await run();
    await f.db.query("update jobs set lease_until=now()-interval '1 second' where id=$1", [id]);
    const replacement = await run();
    expect(await store.complete(first.job, owner, first.result)).toBe(false);
    expect(await store.complete(replacement.job, owner, replacement.result)).toBe(true);
    expect(sent).toEqual([id, id]);
    expect(
      (
        await f.db.query(
          "select attempts,delivered_at is not null as delivered from outbound_webhook_deliveries where id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ attempts: 2, delivered: true }]);
  } finally {
    await f.close();
  }
});

test("journaled lifecycle webhooks enqueue once per endpoint and transition during overlap", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      `insert into outbound_webhook_endpoints(org_id,url,secret_enc)
       values ($1,'https://first.example/events',$2), ($1,'https://second.example/events',$2)`,
      [f.people.org, new Uint8Array([1])],
    );
    await f.db.transaction(async (tx) => {
      for (const legacyPublisherEnabled of [true, false]) {
        if (!legacyPublisherEnabled) {
          await tx.exec("alter table sandboxes disable trigger sandbox_outbound_webhooks");
        }
        await tx.query("update sandboxes set status='stopping' where id=$1", [f.id]);
        const transition = await tx.query(
          `select result.applied from sandboxes s
           cross join lateral sandbox_transition(
             s.id,s.lifecycle_generation,array['stopping']::sandbox_status[],'stopped','lifecycle_runner','stopped','[]'
           ) result where s.id=$1`,
          [f.id],
        );
        expect(transition.rows).toEqual([{ applied: true }]);
      }
      const { rows } = await tx.query(
        `select count(distinct d.endpoint_id)::int as endpoints, count(*)::int as deliveries,
                count(j.id)::int as jobs, bool_and(d.payload->>'id' = d.id::text) as signed_identity
         from sandbox_transitions t
         left join outbound_webhook_deliveries d on d.sandbox_transition_id=t.id
         left join jobs j on j.id=d.id and j.kind='webhook'
         where t.sandbox_id=$1 and t.to_status='stopped'
         group by t.id order by t.id`,
        [f.id],
      );
      expect(rows).toEqual([
        { endpoints: 2, deliveries: 2, jobs: 2, signed_identity: true },
        { endpoints: 2, deliveries: 2, jobs: 2, signed_identity: true },
      ]);
      const allJobs = await tx.query("select count(*)::int as count from jobs where kind='webhook'");
      expect(allJobs.rows).toEqual([{ count: 4 }]);
      await tx.exec("alter table sandboxes enable trigger sandbox_outbound_webhooks");
    });
  } finally {
    await f.close();
  }
});

test("webhook cutover backfills pending deliveries and honors a live legacy receipt", async () => {
  const f = await fixture();
  try {
    const migration = await Bun.file(
      new URL("../../../supabase/migrations/20261119170137_outbound_webhook_jobs.sql", import.meta.url),
    ).text();
    const { rows } = await f.db.transaction(async (tx) => {
      await tx.exec(`
        drop trigger outbound_webhook_job_on_delivery on outbound_webhook_deliveries;
        drop trigger outbound_webhook_legacy_claim_fence on outbound_webhook_deliveries;
        drop function enqueue_outbound_webhook_job();
        drop function fence_outbound_webhook_legacy_claim();
      `);
      const { rows: endpoints } = await tx.query<{ id: string }>(
        "insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2) returning id",
        [f.people.org, new Uint8Array([1])],
      );
      const deliveries = await tx.query<{ id: string; lease_until: Date | null; next_attempt_at: Date }>(
        `insert into outbound_webhook_deliveries(endpoint_id,payload,attempts,lease_until,next_attempt_at)
         values ($1,'{}',0,null,now()+interval '30 seconds'), ($1,'{}',1,now()+interval '60 seconds',now())
         returning id,lease_until,next_attempt_at`,
        [endpoints[0]!.id],
      );
      await tx.exec(migration);
      return deliveries;
    });
    const [pending, inFlight] = rows;
    const jobs = await f.db.query<{ id: string; run_after: Date }>(
      "select id,run_after from jobs where kind='webhook' order by run_after",
    );
    expect(jobs.rows).toEqual([
      { id: pending!.id, run_after: pending!.next_attempt_at },
      { id: inFlight!.id, run_after: inFlight!.lease_until! },
    ]);
    const receipt = await f.db.query(
      `update outbound_webhook_deliveries set last_status=204,delivered_at=now(),lease_until=null
       where id=$1 and attempts=1 returning id`,
      [inFlight!.id],
    );
    expect(receipt.rows).toEqual([{ id: inFlight!.id }]);
    await f.db.query("update jobs set run_after=now() where id=$1", [inFlight!.id]);
    const owner = crypto.randomUUID();
    const store = createJobsStore(f.sql);
    const job = (await store.claim("webhook", owner, 30, 1))!;
    expect(job.id).toBe(inFlight!.id);
    const worker = createOutboundWebhooks(f.sql, ENCRYPTION_KEY, "https://armada.example");
    expect(
      await worker.run(job, {
        signal: new AbortController().signal,
        canDispatch: async () => {
          throw new Error("Already delivered");
        },
      }),
    ).toEqual({ status: "done" });
  } finally {
    await f.close();
  }
});

test("completed API turns publish exact monthly spend once and count unknown turns in UTC", async () => {
  const f = await fixture();
  const account = crypto.randomUUID();
  const store = createSqlData(f.sql)({
    userId: f.people.owner,
    via: "service",
    orgs: [{ orgId: f.people.org, role: "member" }],
  }).sandboxes;
  await store.recordUsagePricingContext!(
    f.id,
    createUsagePricingContext({
      harness: "codex",
      credentialKind: "openai",
      credentialId: account,
      credentialVersion: 1,
      customEndpoint: true,
      modelPrices: { "gpt-6.1-sol": { input: "2", output: "5", cacheRead: "1", cacheWrite: null, reasoning: null } },
    }),
  );
  await f.db.exec("set time zone 'America/Los_Angeles'");
  const active = await f.enrol();
  const measured = (promptId: string, inputTokens: number) => ({
    ...f.usage(`usage-${promptId}`),
    promptId,
    data: { ...(f.usage("shape").data as object), inputTokens, cacheWriteTokens: 0 },
  });
  const complete = (promptId: string, at: string) =>
    ({
      kind: "prompt",
      id: `complete-${promptId}`,
      promptId,
      at: Date.parse(at),
      status: "finished",
      text: "",
    }) satisfies AgentEvent;
  const spend = async () =>
    (
      await f.db.query(
        `select period_start::text, trim_scale(usd)::text as usd, unpriced_turns
         from account_spend where account_id=$1 order by period_start`,
        [account],
      )
    ).rows;
  const events = [
    measured("first", 100),
    complete("first", "2026-10-31T23:59:58Z"),
    complete("second", "2026-10-31T23:59:59Z"),
    measured("second", 200),
    complete("unknown", "2026-11-01T00:00:00Z"),
  ].map((event, index) => ({ event, sequence: index + 1 }));

  expect((await f.publish(active, events.slice(0, 1))).status).toBe(200);
  expect(await spend()).toEqual([]);
  expect((await f.publish(active, events.slice(1, 3))).status).toBe(200);
  expect(await spend()).toEqual([{ period_start: "2026-10-01", usd: "0.00029", unpriced_turns: 1 }]);
  expect((await f.publish(active, events.slice(3))).status).toBe(200);
  expect((await f.publish(active, events)).status).toBe(200);
  expect(await spend()).toEqual([
    { period_start: "2026-10-01", usd: "0.00078", unpriced_turns: 0 },
    { period_start: "2026-11-01", usd: "0", unpriced_turns: 1 },
  ]);
});

test("runtime ingest wakes the authorized event feed after commit and suppresses replay wakes", async () => {
  const f = await fixture();
  const feed = createEventFeed(f.sql, new coreServer.DelegatedAuthority(f.sql, async () => {}), ENCRYPTION_KEY);
  const actor = {
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" as const }],
    via: "service" as const,
  };
  const { promise, resolve, reject } = Promise.withResolvers<Awaited<ReturnType<ReturnType<typeof feed.owner>>>>();
  let notifications = 0;
  const close = runtimeWakes.subscribe(eventFeedWakeKey(f.id), () => {
    notifications++;
    void feed.owner(actor, f.id)("0").then(resolve, reject);
  });
  try {
    const active = await f.enrol();
    const item = { sequence: 1, event: f.other("live") };
    const privateItem = {
      sequence: 2,
      event: { id: "u1", at: 2, kind: "other" as const, type: "usage_report", data: {} },
    };
    expect((await f.publish(active, [item, privateItem])).ok).toBe(true);
    expect(notifications).toBe(1);
    const page = (await promise)!;
    expect(page).toEqual([
      expect.objectContaining({ kind: "runtime_event", sequence: "1", ref: "1", event: item.event }),
      expect.objectContaining({ kind: "runtime_event", sequence: "2", ref: "2" }),
    ]);
    expect(page[1]?.event).toBeUndefined();
    expect(await feed.ownerTail?.(actor, f.id)).toBe(page[1]!.id);
    expect(await feed.ownerTail?.({ ...actor, userId: f.people.member }, f.id)).toBeNull();
    expect(await feed.owner({ ...actor, userId: f.people.member }, f.id)("0")).toBeNull();
    expect((await f.publish(active, [item])).ok).toBe(true);
    expect(notifications).toBe(1);
    await f.db.query(
      'update sandboxes set status=\'stopped\',status_reason=\'idle_paused\',stopped_at=now(),transition_context=\'{"actor":"idle","code":"idle_paused"}\'::jsonb where id=$1',
      [f.id],
    );
    const transitions = await feed.owner(actor, f.id)(page[1]!.id);
    expect(transitions).toEqual([
      expect.objectContaining({ kind: "transition", sequence: null, status: "stopped", statusReason: "idle_paused" }),
    ]);
    expect(await feed.ownerTail?.(actor, f.id)).toBe(transitions![0]!.id);
  } finally {
    close();
    await f.close();
  }
});

test("runtime batches survive a deploy handover exactly once in event_log and the resumed SSE stream", async () => {
  const f = await fixture();
  const authStore = createMemoryAuthStore();
  const owner = generateToken("service");
  authStore.addMembership(f.people.owner, { orgId: f.people.org, name: "Example", role: "member" });
  await authStore.insertToken("service", {
    userId: f.people.owner,
    orgId: f.people.org,
    hash: await sha256Hex(owner),
    label: "test",
    createdAt: new Date().toISOString(),
  });
  const active = await f.enrol();
  const promptId = crypto.randomUUID();
  await f.db.query("update sandboxes set status='running',task_prompt_id=$2 where id=$1", [f.id, promptId]);

  const admitted = Promise.withResolvers<void>();
  const releaseBatch = Promise.withResolvers<void>();
  function replica() {
    let holdBatch = false;
    const shutdown = new AbortController();
    const ingest = createRuntimeEvents(createRuntimeEnrolments(f.sql, ENCRYPTION_KEY), ENCRYPTION_KEY).route;
    const control: ControlOptions = {
      authStore,
      supabase: { supabaseUrl: "https://example.test", anonKey: "placeholder" },
      encryptionKey: undefined,
      store: {} as ControlOptions["store"],
      eventFeed: createEventFeed(f.sql, new coreServer.DelegatedAuthority(f.sql, async () => {})),
      eventStreamShutdown: shutdown.signal,
    };
    const requests = createServerRequestDrain(async (request) => {
      if (holdBatch && request.method === "POST") {
        admitted.resolve();
        await releaseBatch.promise;
      }
      const response = (await ingest(request)) ?? (await handleControlRequest(request, control));
      if (!response) throw new Error("Unexpected handover request");
      return response;
    });
    return {
      fetch: requests.fetch,
      activeRequests: requests.requests,
      holdNextBatch() {
        holdBatch = true;
      },
      drain() {
        requests.beginDrain();
        shutdown.abort();
      },
    };
  }

  const post = (...sequences: number[]) =>
    new Request("https://example.test/api/runtime/events", {
      method: "POST",
      headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
      body: JSON.stringify({
        sandboxId: f.id,
        generation: active.epoch,
        events: sequences.map((sequence) => ({
          sequence,
          event: { ...f.other(`event-${sequence}`), promptId },
        })),
      }),
    });
  const subscribe = (cursor?: string) =>
    new Request(`https://example.test/api/v1/events?sandbox=${f.id}`, {
      headers: { authorization: `Bearer ${owner}`, ...(cursor ? { "Last-Event-ID": cursor } : {}) },
    });
  function readFrames(chunk: Uint8Array | undefined) {
    return new TextDecoder()
      .decode(chunk)
      .trimEnd()
      .split("\n\n")
      .map((frame) => {
        const [id, data] = frame.split("\n");
        const event = streamSandboxEvents.output.parse(JSON.parse(data!.slice(6)));
        expect(id).toBe(`id: ${event.id}`);
        return event;
      });
  }

  const eventLog = async () =>
    (
      await f.db.query<{ id: string; sequence: string }>(
        "select id::text,sequence::text from event_log where sandbox_id=$1 and kind='runtime_event' order by id::bigint",
        [f.id],
      )
    ).rows;

  const original = replica();
  const replacement = replica();
  try {
    expect(await (await original.fetch(post(1, 2))).json()).toEqual({ acknowledgedSequence: 2 });
    const before = (await original.fetch(subscribe())).body!.getReader();
    const firstPage = readFrames((await before.read()).value);

    original.holdNextBatch();
    const inFlight = Promise.resolve(original.fetch(post(3, 4)));
    try {
      await Promise.race([
        admitted.promise,
        inFlight.then((response) => {
          throw new Error(`Batch did not reach the admission barrier (HTTP ${response.status})`);
        }),
      ]);
      original.drain();
      expect((await before.read()).done).toBe(true);
      const refused = await original.fetch(post(3, 4, 5, 6));
      expect(refused.status).toBe(503);
      await refused.body?.cancel();
      expect(original.activeRequests.size).toBe(1);
      releaseBatch.resolve();
      await (await inFlight).body?.cancel();
      expect((await eventLog()).map(({ sequence }) => sequence)).toEqual(["1", "2", "3", "4"]);
      expect(await (await replacement.fetch(post(3, 4, 5, 6))).json()).toEqual({ acknowledgedSequence: 6 });

      const resumed = (await replacement.fetch(subscribe(firstPage.at(-1)!.id))).body!.getReader();
      try {
        const received = [...firstPage, ...readFrames((await resumed.read()).value)];
        const rows = await eventLog();
        expect(rows.map(({ sequence }) => sequence)).toEqual(["1", "2", "3", "4", "5", "6"]);
        expect(received.map(({ id, sequence }) => ({ id, sequence }))).toEqual(rows);
      } finally {
        await resumed.cancel();
      }
    } finally {
      releaseBatch.resolve();
      const response = await inFlight;
      if (!response.bodyUsed) await response.body?.cancel();
    }
  } finally {
    original.drain();
    replacement.drain();
    await f.close();
  }
});

async function accountEventFixture() {
  const f = await fixture();
  const account = { id: f.openaiCredentialId, version: 1 };
  await f.db.query("update sandboxes set credential_id=$2, credential_version=$3 where id=$1", [
    f.id,
    account.id,
    account.version,
  ]);
  const active = await f.enrol();
  const { append } = createRuntimeEvents(f.authority, ENCRYPTION_KEY);
  const send = (events: { sequence: number; event: AgentEvent }[]) =>
    append(active.runtimeToken, active.epoch, { sandboxId: f.id, generation: active.epoch, events });
  return { ...f, account, send };
}

function exhaustion(sequence: number, at: number, data: Record<string, unknown>) {
  return {
    sequence,
    event: { id: String(sequence), at, kind: "other" as const, type: "usage_limit", promptId: "p", data },
  };
}

test("runtime ACK persists provider exhaustion for the pinned revision and ignores a late older fact", async () => {
  const f = await accountEventFixture();
  const resetsAt = "2027-01-01T14:00:00.000Z";
  const code = "usage_limit_exceeded";
  await expect(f.send([exhaustion(1, 200, { code, resetsAt })])).resolves.toEqual({ acknowledgedSequence: 1 });
  await expect(f.send([exhaustion(2, 100, { code })])).resolves.toEqual({ acknowledgedSequence: 2 });
  expect((await f.db.query("select account_id,account_version,code,resets_at from account_exhaustion")).rows).toEqual([
    { account_id: f.account.id, account_version: f.account.version, code, resets_at: new Date(resetsAt) },
  ]);
});

test("a mid-turn provider retry leaves the account binding and health intact", async () => {
  const f = await accountEventFixture();
  const code = "usage_limit_exceeded";
  await expect(f.send([exhaustion(1, 200, { code, resetsAt: "2027-01-01T14:00:00.000Z" })])).resolves.toEqual({
    acknowledgedSequence: 1,
  });
  const readHealth = async () => (await f.db.query("select * from account_exhaustion")).rows;
  const before = await readHealth();
  expect(before).toHaveLength(1);
  const at = Date.now();
  await expect(
    f.send([
      {
        sequence: 2,
        event: {
          id: "retry",
          at,
          kind: "other",
          type: "armada/modelRateLimit",
          promptId: "p",
          data: {
            retryCount: 1,
            delayMs: 60000,
            totalWaitMs: 60000,
            message: "Rate limited by the model provider, retrying in 60 s",
          },
        },
      },
      exhaustion(3, at + 1, { code: "rate_limited" }),
    ]),
  ).resolves.toEqual({ acknowledgedSequence: 3 });
  expect(await readHealth()).toEqual(before);
  expect((await f.db.query("select credential_id,credential_version from sandboxes where id=$1", [f.id])).rows).toEqual(
    [{ credential_id: f.account.id, credential_version: f.account.version }],
  );
});

test("a provider reset outside PostgreSQL's ISO calendar still acknowledges the journal", async () => {
  const f = await accountEventFixture();
  await expect(
    f.send([exhaustion(1, 300, { code: "usage_limit_exceeded", resetsAt: "0000-01-01T00:00:00.000Z" })]),
  ).resolves.toEqual({ acknowledgedSequence: 1 });
  expect(
    (await f.db.query("select resets_at from account_exhaustion where account_id=$1", [f.account.id])).rows,
  ).toEqual([{ resets_at: null }]);
});

test("workspace execution timestamps are logged only for freshly committed events", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const info = spyOn(console, "info");
  try {
    const events = (["running", "finished"] as const).map((status, index) => ({
      sequence: index + 1,
      event: {
        ...f.other(`workspace_workspace_${active.epoch}_repository_0_0_${status}`),
        at: 1000 + index * 29_000,
        type: "armada/workspaceStep",
        data: { phase: "repository", index: 0, attempt: 0, status, extra: "not-for-logs" },
      },
    }));
    expect((await f.publish(active, events)).status).toBe(200);
    expect((await f.publish(active, events)).status).toBe(200);
    const lines = info.mock.calls
      .map(([line]) => JSON.parse(line))
      .filter((entry) => entry.event === "runtime_workspace_execution");
    expect(lines).toMatchObject([
      {
        sandboxId: f.id,
        epoch: active.epoch,
        commandId: `workspace_${active.epoch}_repository_0_0`,
        stage: "running",
        runtimeAtMs: 1000,
      },
      { stage: "finished", runtimeAtMs: 30_000 },
    ]);
    expect(JSON.stringify(lines)).not.toContain("not-for-logs");
  } finally {
    info.mockRestore();
    await f.close();
  }
});
