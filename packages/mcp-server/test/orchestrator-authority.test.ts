import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Sql } from "@armada/core";
import { createSqlSandboxStore } from "@armada/core";
import { newOrchestratorEpochSecret, OrchestratorAuthority, reserveOrchestratorOperation } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { database } from "./support.ts";

test("managed parent is hidden from generic service/JWT reads and cleanup; identities cannot drift", async () => {
  const { db, people: p } = await database();
  const sql: Sql = { query: (q, v) => db.query(q, v) };
  try {
    const golden =
      (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]?.id ?? "missing-golden";
    const parent = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "parent",
      goldenId: golden,
      orgId: p.org,
      ownerId: p.owner,
      harness: "claude",
      status: "running",
      model: "m",
      reasoningEffort: "high",
      visibility: "private",
    });
    await db.query("insert into orchestrators(org_id,owner_id,sandbox_id) values($1,$2,$3)", [
      p.org,
      p.owner,
      parent.id,
    ]);
    for (const userId of [p.owner, p.admin, p.member]) {
      const scoped = createSqlData(sql)({
        userId,
        orgs: [{ orgId: p.org, role: userId === p.admin ? "admin" : "member" }],
        via: "supabase",
      });
      expect(await scoped.sandboxes.get(parent.id)).toBeNull();
      expect((await scoped.sandboxes.list({ limit: 20 })).rows).toHaveLength(0);
      await expect(scoped.sandboxes.update(parent.id, { status: "stopped" })).rejects.toThrow();
      await db.exec("set role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
      expect((await db.query("select id from sandboxes where id=$1", [parent.id])).rows).toHaveLength(0);
      await db.exec("reset role");
    }
    expect(await createSqlSandboxStore(sql).listBefore("2099-01-01")).toHaveLength(0);
    await expect(db.query("update sandboxes set visibility='org' where id=$1", [parent.id])).rejects.toThrow(
      "immutable managed parent",
    );
    await expect(db.query("update orchestrators set owner_id=$1", [p.admin])).rejects.toThrow("immutable orchestrator");
  } finally {
    await db.close();
  }
});

test("epoch admission rechecks scope, membership, generation, ACK, expiry and child ownership from a promptless-ready parent", async () => {
  const { db, people: p } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  try {
    const golden =
      (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]?.id ?? "missing-golden";
    const store = createSqlSandboxStore(sql);
    const sandbox = async (id: string, status: "ready" | "running" = "running") =>
      store.insert({
        id: crypto.randomUUID(),
        provider: "boat",
        providerSandboxId: id,
        goldenId: golden,
        orgId: p.org,
        ownerId: p.owner,
        harness: "codex",
        status,
        model: "m",
        reasoningEffort: "high",
        visibility: "private",
      });
    const parent = await sandbox("parent", "ready");
    const child = await sandbox("child");
    const unrelated = await sandbox("unrelated");
    const id = crypto.randomUUID();
    await db.query("insert into orchestrators(id,org_id,owner_id,sandbox_id,state) values($1,$2,$3,$4,'ready')", [
      id,
      p.org,
      p.owner,
      parent.id,
    ]);
    const operation = {
      orchestratorId: id,
      actorId: p.owner,
      action: "message" as const,
      key: "one",
      digest: "a".repeat(64),
      expectedRevision: 0,
    };
    const raced = await Promise.allSettled([
      reserveOrchestratorOperation(sql, operation),
      reserveOrchestratorOperation(sql, { ...operation, key: "two" }),
    ]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = raced[0]?.status === "fulfilled" ? operation : { ...operation, key: "two" };
    const receipt = await reserveOrchestratorOperation(sql, winner);
    expect(receipt.revision).toBe(1);
    await expect(reserveOrchestratorOperation(sql, { ...winner, digest: "b".repeat(64) })).rejects.toThrow(
      "Idempotency conflict",
    );
    await db.query("insert into orchestrator_children values($1,$2,$3,$4)", [child.id, id, p.org, p.owner]);
    await expect(
      db.query("insert into orchestrators(org_id,owner_id,sandbox_id) values($1,$2,$3)", [p.org, p.owner, child.id]),
    ).rejects.toThrow("not a child");
    const nativeGeneration = "0212ab63-8227-47fa-aa85-25b93c909200";
    await db.query("update sandboxes set orchestrator_native_generation=$2 where id=$1", [parent.id, nativeGeneration]);
    const { token, hash } = newOrchestratorEpochSecret();
    await db.query(
      `insert into orchestrator_delegations(orchestrator_id,hash,epoch,physical_generation,scopes,golden_ids,account_ids,expires_at,acknowledged_at,native_generation)
 select $1,$2,authority_epoch,1,array['worker:read'],array[]::uuid[],array[]::uuid[],now()+interval '24 hours',now(),$3 from orchestrators where id=$1`,
      [id, hash, nativeGeneration],
    );
    const authority = new OrchestratorAuthority(sql, async () => {
      throw new Error("no account adapter enabled");
    });
    const read = (method = "read", childId = child.id) =>
      authority.admit(token, { method, childId }, async (_tx, principal) => principal.ownerId);
    expect(await read()).toBe(p.owner);
    for (const method of ["exec", "token_create", "__proto__", "stop", "launch"])
      await expect(read(method)).rejects.toThrow("denied");
    await expect(read("read", unrelated.id)).rejects.toThrow("denied");
    for (const change of [
      "acknowledged_at=null",
      "created_at=now()-interval '2 hours',expires_at=now()-interval '1 second'",
      "native_generation='different-native-incarnation'",
      "revoked_at=now()",
    ]) {
      await db.exec(`update orchestrator_delegations set ${change}`);
      await expect(read()).rejects.toThrow("denied");
      await db.exec(
        "update orchestrator_delegations set created_at=now(),expires_at=now()+interval '24 hours',acknowledged_at=now(),native_generation='0212ab63-8227-47fa-aa85-25b93c909200',physical_generation=1,revoked_at=null",
      );
    }
    let delivered = "";
    let activeEpoch = 0n;
    let delayNext = false;
    let acknowledgeA: () => void = () => {};
    let enteredA: () => void = () => {};
    const entered = new Promise<void>((r) => {
      enteredA = r;
    });
    const delayed = new Promise<void>((r) => {
      acknowledgeA = r;
    });
    let scrubbedHash = "";
    const transport = {
      physicalGeneration: nativeGeneration,
      lifecycleGeneration: "1",
      deliver: async (value: string, binding: { epoch: string; physicalGeneration: string }) => {
        expect(binding.physicalGeneration).toBe(nativeGeneration);
        if (delayNext) {
          delayNext = false;
          enteredA();
          await delayed;
        }
        if (BigInt(binding.epoch) <= activeEpoch) return { acknowledged: false };
        activeEpoch = BigInt(binding.epoch);
        delivered = value;
        return { acknowledged: true };
      },
      scrub: async (hash?: string) => {
        scrubbedHash = hash ?? "";
        if (hash === undefined || hash === createHash("sha256").update(delivered).digest("hex")) delivered = "";
      },
    };
    const consent = { scopes: ["worker:read" as const], goldenIds: [golden], credentialIds: [] };
    await authority.installEpoch(id, transport, consent);
    await expect(read()).rejects.toThrow("denied");
    expect(await authority.admit(delivered, { method: "read", childId: child.id }, async () => true)).toBe(true);
    delayNext = true;
    const old = authority.installEpoch(id, transport, consent);
    const oldRejected = old.then(
      () => "unexpected success",
      (error) => error.message,
    );
    await entered;
    await authority.installEpoch(id, transport, consent);
    acknowledgeA();
    expect(await oldRejected).toContain("denied");
    expect(scrubbedHash).toMatch(/^[a-f0-9]{64}$/);
    // SQL activity advances do not replace the native process or expire its 24h epoch.
    await db.query("update sandboxes set lifecycle_generation=2 where id=$1", [parent.id]);
    expect(await authority.admit(delivered, { method: "read", childId: child.id }, async () => true)).toBe(true);
    // An old installation snapshot cannot rebind the new SQL incarnation.
    await expect(authority.installEpoch(id, transport, consent)).rejects.toThrow("denied");
    transport.lifecycleGeneration = "2";
    await authority.installEpoch(id, transport, consent);
    await db.query("update sandboxes set orchestrator_native_generation='replaced-native' where id=$1", [parent.id]);
    await expect(authority.admit(delivered, { method: "read", childId: child.id }, async () => true)).rejects.toThrow(
      "denied",
    );
    await db.query("update sandboxes set orchestrator_native_generation=$2 where id=$1", [parent.id, nativeGeneration]);
    // Rebinding an old native name cannot resurrect its retired token.
    await expect(authority.admit(delivered, { method: "read", childId: child.id }, async () => true)).rejects.toThrow(
      "denied",
    );
    await authority.installEpoch(id, transport, consent);
    expect(await authority.admit(delivered, { method: "read", childId: child.id }, async () => true)).toBe(true);
    await expect(
      authority.scrubBeforeCheckpoint(id, {
        physicalGeneration: nativeGeneration,
        lifecycleGeneration: "1",
        deliver: async () => ({ acknowledged: false }),
        scrub: async () => {
          throw new Error("synthetic-private-transport-error");
        },
      }),
    ).rejects.toThrow("authority is unavailable or denied");
    const accounts = { claude: crypto.randomUUID(), codex: crypto.randomUUID() };
    const forwarded: unknown[] = [];
    let accountDenied = false;
    const launchAuthority = new OrchestratorAuthority(sql, async (_tx, input) => {
      forwarded.push(input);
      if (accountDenied) throw new Error("account revoked");
    });
    await launchAuthority.installEpoch(id, transport, {
      scopes: ["worker:launch"],
      goldenIds: [golden],
      credentialIds: Object.values(accounts),
    });
    const launch = (harness: "claude" | "codex", overrides: Record<string, unknown> = {}) =>
      launchAuthority.admit(
        delivered,
        {
          method: "launch",
          goldenId: golden,
          harness,
          credentialId: accounts[harness],
          credentialVersion: 7,
          ...overrides,
        },
        async () => true,
      );
    for (const harness of ["claude", "codex"] as const) {
      expect(await launch(harness)).toBe(true);
      expect(forwarded.at(-1)).toEqual({
        userId: p.owner,
        orgId: p.org,
        harness,
        credentialId: accounts[harness],
        credentialVersion: 7,
      });
    }
    const before = forwarded.length;
    await expect(launch("claude", { credentialId: crypto.randomUUID() })).rejects.toThrow("denied");
    const alienGolden = crypto.randomUUID();
    await db.query(
      "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'alien','private','{}')",
      [alienGolden, p.org, p.admin],
    );
    const otherGolden = (await db.query<{ id: string }>("select id from goldens where name='elsewhere'")).rows[0]?.id;
    // Include forbidden IDs in consent to prove the current resource check, not just allowlist filtering.
    await launchAuthority.installEpoch(id, transport, {
      scopes: ["worker:launch"],
      goldenIds: [golden, alienGolden, otherGolden ?? ""],
      credentialIds: Object.values(accounts),
    });
    for (const goldenId of [alienGolden, otherGolden])
      await expect(launch("claude", { goldenId })).rejects.toThrow("denied");
    accountDenied = true;
    await expect(launch("codex")).rejects.toThrow("account revoked");
    await db.query("update goldens set removed_at=now() where id=$1", [golden]);
    await expect(launch("claude")).rejects.toThrow("denied");

    expect(forwarded.length).toBe(before + 1);
    await authority.installEpoch(id, transport, consent);
    const freshRead = () => authority.admit(delivered, { method: "read", childId: child.id }, async () => true);
    expect(await freshRead()).toBe(true);
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [p.admin]);
    await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    await db.exec("reset role");
    await expect(freshRead()).rejects.toThrow("denied");
    await expect(read()).rejects.toThrow("denied");
    await db.query("insert into members values($1,$2,'member')", [p.org, p.owner]);
    await expect(freshRead()).rejects.toThrow("denied");
    await expect(read()).rejects.toThrow("denied");
    await authority.revoke(id);
    await expect(read()).rejects.toThrow("denied");
  } finally {
    await db.close();
  }
});
