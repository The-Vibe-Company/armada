import { expect, test } from "bun:test";
import type { RunnerRequest } from "@armada/agent-runtime";
import type { Sql } from "@armada/core/server";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

async function fixture() {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
    select $1,id,org_id,owner_id,'command-native','codex','ready' from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  let now = 0;
  let waiting: (() => Promise<void>) | undefined;
  const clock = {
    now: () => now,
    async wait() {
      const callback = waiting;
      waiting = undefined;
      await callback?.();
      now += 20000;
    },
  };
  const bridge = () => createRuntimeCommands(authority, ENCRYPTION_KEY, clock);
  const enrol = async () =>
    authority.enrol(
      (await authority.issue({ ownerId: people.owner, sandboxId: id, configuration: {} })).enrolmentToken,
    );
  const command = (requestId: string): RunnerRequest => ({ version: 1, sandboxId: id, requestId, op: "health" });
  const request = async (path: string, token: string, epoch: string, body: unknown) => {
    const response = await bridge().route(
      new Request(`https://armada.example/api/runtime/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-armada-runtime-epoch": epoch },
        body: JSON.stringify(body),
      }),
    );
    if (!response) throw Error("missing_command_route");
    return response;
  };
  return {
    db,
    people,
    id,
    authority,
    bridge,
    enrol,
    command,
    request,
    onWait(callback: () => Promise<void>) {
      waiting = callback;
    },
  };
}

test("encrypted command mailbox survives replica restart, redelivers one stable ID and pins the first durable result", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    const first = {
      ...f.command("z-first"),
      op: "prompt",
      input: { sandboxId: f.id, harness: "codex", text: "private-command-marker" },
    } as const;
    const last = f.command("a-second");
    await f.bridge().enqueue(f.people.owner, first);
    await f.bridge().enqueue(f.people.owner, last);
    await f.bridge().enqueue(f.people.owner, first);
    expect((await f.db.query("select request_id from runtime_commands")).rows).toHaveLength(2);
    const stored = (
      await f.db.query<{ request_enc: Uint8Array }>(
        "select request_enc from runtime_commands where request_id='z-first'",
      )
    ).rows[0];
    expect(Buffer.from(stored?.request_enc ?? []).includes(Buffer.from("private-command-marker"))).toBe(false);
    const poll = async () => f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch });
    const response = await poll();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ epoch: active.epoch, command: first });
    expect(await (await poll()).json()).toEqual({ epoch: active.epoch, command: first });
    const reply = {
      epoch: active.epoch,
      requestId: first.requestId,
      status: 200,
      body: { requestId: first.requestId, result: { marker: "private-result-marker" } },
    };
    expect(await (await f.request("results", active.runtimeToken, active.epoch, reply)).json()).toEqual({
      epoch: active.epoch,
      requestId: first.requestId,
    });
    expect(
      (
        await f.request("results", active.runtimeToken, active.epoch, {
          ...reply,
          body: { error: "late replay must not overwrite" },
        })
      ).status,
    ).toBe(200);
    expect(await f.bridge().result(f.people.owner, f.id, first.requestId)).toEqual({ state: "finished", reply });
    const sealed = (
      await f.db.query<{ result_enc: Uint8Array }>("select result_enc from runtime_commands where request_id='z-first'")
    ).rows[0];
    expect(Buffer.from(sealed?.result_enc ?? []).includes(Buffer.from("private-result-marker"))).toBe(false);
    expect(await (await poll()).json()).toEqual({ epoch: active.epoch, command: last });
    await expect(
      f.bridge().enqueue(f.people.owner, { ...first, input: { ...first.input, text: "changed" } }),
    ).rejects.toThrow("runtime_command_conflict");
    await expect(f.bridge().enqueue(f.people.member, f.command("foreign-owner"))).rejects.toThrow(
      "runtime_enrolment_denied",
    );
    expect(
      (await f.request("results", active.runtimeToken, active.epoch, { ...reply, requestId: "not-enqueued", body: {} }))
        .status,
    ).toBe(409);
  } finally {
    await f.db.close();
  }
});

test("replacement epoch refuses old replies and never silently adopts unfinished commands", async () => {
  const f = await fixture();
  try {
    const old = await f.enrol();
    const request = f.command("before-resume");
    await f.bridge().enqueue(f.people.owner, request);
    const current = await f.enrol();
    const reply = { epoch: old.epoch, requestId: request.requestId, status: 200, body: {} };
    expect((await f.request("results", old.runtimeToken, old.epoch, reply)).status).toBe(401);
    expect(await f.bridge().result(f.people.owner, f.id, request.requestId)).toEqual({ state: "superseded" });
    expect((await f.bridge().next(current.runtimeToken, current.epoch)).command).toBeNull();
    await expect(f.bridge().enqueue(f.people.owner, request)).rejects.toThrow("runtime_command_conflict");
    expect(
      (await f.request("results", current.runtimeToken, current.epoch, { ...reply, epoch: current.epoch })).status,
    ).toBe(409);
    const fresh = f.command("after-resume");
    await f.bridge().enqueue(f.people.owner, fresh);
    expect(await f.bridge().next(current.runtimeToken, current.epoch)).toEqual({
      epoch: current.epoch,
      command: fresh,
    });
    await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.id]);
    expect((await f.request("poll", current.runtimeToken, current.epoch, { epoch: current.epoch })).status).toBe(401);
  } finally {
    await f.db.close();
  }
});

test("empty polls release the transaction while waiting and private routes/grants reject malformed authority", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    const response = await f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch });
    expect(await response.json()).toEqual({ epoch: active.epoch, command: null });
    f.onWait(async () => {
      await f.bridge().enqueue(f.people.owner, f.command("arrived-during-idle"));
    });
    const awakened = await f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch });
    expect(await awakened.json()).toEqual({ epoch: active.epoch, command: f.command("arrived-during-idle") });
    expect((await f.request("poll", "invalid", active.epoch, { epoch: active.epoch })).status).toBe(401);
    expect((await f.request("poll", active.runtimeToken, active.epoch, { epoch: "wrong" })).status).toBe(409);
    for (const role of ["anon", "authenticated"]) {
      expect(
        (
          await f.db.query<{ allowed: boolean }>(
            "select has_table_privilege($1,'runtime_commands','select,insert,update,delete') as allowed",
            [role],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      expect(
        (
          await f.db.query<{ allowed: boolean }>(
            "select has_sequence_privilege($1,'runtime_commands_sequence_seq','usage,select,update') as allowed",
            [role],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
    }
    expect(await f.bridge().route(new Request("https://armada.example/healthz"))).toBeNull();
    expect((await f.bridge().route(new Request("https://armada.example/api/runtime/poll")))?.status).toBe(405);
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (
        await f.bridge().route(
          new Request("https://armada.example/api/runtime/poll", {
            method: "POST",
            signal: aborted.signal,
            headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
            body: JSON.stringify({ epoch: active.epoch }),
          }),
        )
      )?.status,
    ).toBe(499);
  } finally {
    await f.db.close();
  }
});

test.each(["health", "maximum-frame"] as const)(
  "dialout client wire contract round-trips a real Runner response (%s)",
  async (kind) => {
    const { RuntimeDialout } = await import("../../agent-runtime/src/dialout.ts");
    const { Journal, Runner } = await import("../../agent-runtime/src/index.ts");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "command-wire-"));
    const journal = new Journal(join(root, "journal"), (value) => value);
    const stop = new AbortController();
    try {
      if (kind === "maximum-frame") {
        await f.authority.issue({ ownerId: f.people.owner, sandboxId: f.id, configuration: {} });
        await f.db.query("update runtime_enrolments set epoch=9223372036854775805");
      }
      const active = await f.enrol();
      let command = f.command("client-wire");
      if (kind === "maximum-frame") {
        const empty = { ...command, op: "prompt", input: { sandboxId: f.id, harness: "codex", text: "" } } as const;
        const rawBudget = 1048576 - Buffer.byteLength(JSON.stringify(empty));
        await expect(
          f.bridge().enqueue(f.people.owner, { ...empty, input: { ...empty.input, text: "x".repeat(rawBudget) } }),
        ).rejects.toThrow("runtime_command_conflict");
        const budget =
          1048576 - Buffer.byteLength(JSON.stringify({ type: "command", epoch: active.epoch, request: empty }));
        command = { ...empty, input: { ...empty.input, text: "x".repeat(budget) } };
      }
      await f.bridge().enqueue(f.people.owner, command);
      const driver = {
        start() {
          if (kind === "health") throw Error("health must not start a harness");
          return { done: Promise.resolve("finished" as const), async interrupt() {}, async steer() {} };
        },
        async close() {},
      };
      const runner = new Runner(
        journal,
        { token: active.runtimeToken, sandboxId: f.id, generation: active.epoch, expiresAt: Date.now() + 60000 },
        { codex: driver, claude: driver },
      );
      const channel = new RuntimeDialout("https://armada.example", active, {
        socket() {
          throw Error("upgrade rejected");
        },
        after() {
          throw Error("unexpected retry/idle wait");
        },
        every() {
          return () => {};
        },
        async fetch(url, options) {
          const response = await f.bridge().route(new Request(url.href, options));
          if (!response) throw Error("wire path mismatch");
          if (url.pathname.endsWith("/results")) stop.abort();
          return response;
        },
      });
      await channel.run(
        (request) =>
          runner.handle(
            new Request("http://runtime/v1", {
              method: "POST",
              headers: { "x-armada-runner-grant": active.runtimeToken },
              body: JSON.stringify(request),
            }),
          ),
        stop.signal,
      );
      const result = await f.bridge().result(f.people.owner, f.id, command.requestId);
      expect(result.state).toBe("finished");
      if (result.state !== "finished") throw Error("missing real runner result");
      if (kind === "maximum-frame") {
        expect(result.reply).toMatchObject({
          epoch: active.epoch,
          requestId: command.requestId,
          status: 200,
          body: { result: { promptId: expect.any(String) } },
        });
        return;
      }
      expect(result.reply).toMatchObject({
        epoch: active.epoch,
        requestId: command.requestId,
        status: 200,
        body: { result: { generation: active.epoch, ready: true } },
      });
    } finally {
      stop.abort();
      journal.close();
      await f.db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
