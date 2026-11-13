import { expect, test } from "bun:test";
import { decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeModelAccess } from "../src/runtime-model-access.ts";
import { createRuntimeNativeAuth } from "../src/runtime-native-auth.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

async function fixture() {
  const { db, people } = await database();
  const host = crypto.randomUUID(),
    installation = crypto.randomUUID(),
    id = crypto.randomUUID(),
    generation = crypto.randomUUID();
  await db.query(
    `insert into docker_hosts(id,org_id,owner_id,registration_expires_at,installation_id,hash)
    values($1,$2,$3,now()-interval '1 day',$4,$5)`,
    [host, people.org, people.member, installation, "d".repeat(64)],
  );
  await db.query(
    `insert into sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
    docker_host_id,docker_installation_id,docker_generation,docker_image,expires_at)
    values($1,$2,$3,'docker',$4,'codex','ready',$5,$6,$7,$8,now()+interval '1 hour')`,
    [
      id,
      people.org,
      people.owner,
      `armada-${installation}-${host}-${id}-${generation}`,
      host,
      installation,
      generation,
      `ubuntu@sha256:${"a".repeat(64)}`,
    ],
  );
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const validator = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const issuer = createRuntimeEnrolments(sql, ENCRYPTION_KEY, { allowDockerIssue: true });
  const input = { sandboxId: id, ownerId: people.owner, configuration: { marker: "private-bootstrap" } };
  const issue = () => issuer.issue(input);
  const enrol = async () => validator.enrol((await issue()).enrolmentToken);
  const session = (active: Awaited<ReturnType<typeof enrol>>) =>
    validator.withSession(active.runtimeToken, active.epoch, async (_tx, scope) => scope);
  return { db, people, host, installation, id, sql, validator, issuer, input, issue, enrol, session };
}

// Docker has no public issuer. This boundary owns opt-in, retained validation and transport reuse.
test("Docker issuance is trusted opt-in; default validators exchange once, journal and fence replacement", async () => {
  const f = await fixture();
  try {
    await expect(f.validator.issue(f.input)).rejects.toThrow("runtime_enrolment_denied");
    const malformedOptIn = createRuntimeEnrolments(f.sql, ENCRYPTION_KEY, { allowDockerIssue: "false" } as never);
    const refused = await malformedOptIn.issue(f.input).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
    await expect(f.issuer.issue({ ...f.input, ownerId: f.people.member })).rejects.toThrow("runtime_enrolment_denied");
    const ticket = await f.issue();
    const active = await f.validator.enrol(ticket.enrolmentToken);
    expect(active.configuration).toEqual(f.input.configuration);
    await expect(f.validator.enrol(ticket.enrolmentToken)).rejects.toThrow("runtime_enrolment_denied");
    expect(await f.session(active)).toEqual({ sandboxId: f.id, epoch: active.epoch });
    expect(await f.validator.withOwner(f.id, f.people.owner, async (_tx, scope) => scope)).toEqual({
      sandboxId: f.id,
      epoch: active.epoch,
    });
    const event = { id: "docker-event", at: 1, kind: "other", type: "fixture", data: { marker: "private-journal" } };
    const response = await createRuntimeEvents(f.validator, ENCRYPTION_KEY).route(
      new Request("https://armada.example/api/runtime/events", {
        method: "POST",
        headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
        body: JSON.stringify({ sandboxId: f.id, generation: active.epoch, events: [{ sequence: 1, event }] }),
      }),
    );
    expect(await response?.json()).toEqual({ acknowledgedSequence: 1 });
    const stored = (
      await f.db.query<{ event_enc: Uint8Array<ArrayBuffer> }>(
        "select event_enc from runtime_events where sandbox_id=$1",
        [f.id],
      )
    ).rows[0];
    if (!stored) throw Error("missing encrypted journal");
    expect(Buffer.from(stored.event_enc).includes(Buffer.from("private-journal"))).toBe(false);
    expect(JSON.parse(await decryptSecret(stored.event_enc, ENCRYPTION_KEY))).toEqual(event);
    const replacement = await f.enrol();
    expect(BigInt(replacement.epoch)).toBe(BigInt(active.epoch) + 1n);
    await expect(f.session(active)).rejects.toThrow("runtime_enrolment_denied");
    expect((await f.session(replacement)).epoch).toBe(replacement.epoch);
  } finally {
    await f.db.close();
  }
});

// These revocations were invisible to the Boat-only runtime authority.
test("Docker current host and both source memberships gate sessions, owner commands and pending exchange", async () => {
  const f = await fixture();
  try {
    for (const change of ["revoked", "installation", "owner", "issuer"] as const) {
      const mutate = async (restore = false) => {
        if (change === "revoked")
          await f.db.query("update docker_hosts set revoked_at=case when $2 then null else now() end where id=$1", [
            f.host,
            restore,
          ]);
        else if (change === "installation")
          await f.db.query("update docker_hosts set installation_id=$2 where id=$1", [
            f.host,
            restore ? f.installation : crypto.randomUUID(),
          ]);
        else {
          const user = change === "owner" ? f.people.owner : f.people.member;
          if (restore)
            await f.db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [f.people.org, user]);
          else await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, user]);
        }
      };
      const active = await f.enrol();
      await mutate();
      await expect(f.session(active)).rejects.toThrow("runtime_enrolment_denied");
      await expect(f.validator.withOwner(f.id, f.people.owner, async () => true)).rejects.toThrow(
        "runtime_enrolment_denied",
      );
      await mutate(true);
      const pending = await f.issue();
      await mutate();
      await expect(f.validator.withBootstrap(pending.enrolmentToken, async () => true)).rejects.toThrow(
        "runtime_enrolment_denied",
      );
      await expect(f.validator.enrol(pending.enrolmentToken)).rejects.toThrow("runtime_enrolment_denied");
      await mutate(true);
    }
  } finally {
    await f.db.close();
  }
});

test("issuer role changes and departure/rejoin cannot resurrect Docker grants", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    await f.db.query("update members set role='admin' where org_id=$1 and user_id=$2", [f.people.org, f.people.member]);
    await f.db.query("update members set role='member' where org_id=$1 and user_id=$2", [
      f.people.org,
      f.people.member,
    ]);
    await expect(f.session(active)).rejects.toThrow("runtime_enrolment_denied");
    const pending = await f.issue();
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.member]);
    await f.db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [
      f.people.org,
      f.people.member,
    ]);
    await expect(f.validator.enrol(pending.enrolmentToken)).rejects.toThrow("runtime_enrolment_denied");
    expect((await f.session(await f.enrol())).sandboxId).toBe(f.id);
    const current = await f.enrol();
    await f.db.query("update docker_hosts set owner_id=$2 where id=$1", [f.host, f.people.admin]);
    await expect(f.session(current)).rejects.toThrow("runtime_enrolment_denied");
  } finally {
    await f.db.close();
  }
});

test("cross-owner Docker runtimes retain native publication and access-only model delivery", async () => {
  const f = await fixture();
  try {
    const native = (n: number) =>
      JSON.stringify({
        tokens: {
          account_id: "offline-account",
          access_token: `offline-access-${n}`,
          refresh_token: `offline-refresh-${n}`,
        },
      });
    const account = (
      await f.db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [f.people.owner, await encryptSecret(native(0), ENCRYPTION_KEY)],
      )
    ).rows[0];
    if (!account) throw Error("missing account");
    await f.db.query("update sandboxes set credential_id=$2,credential_version=1 where id=$1", [f.id, account.id]);
    const active = await f.enrol();
    const publish = createRuntimeNativeAuth(f.sql, ENCRYPTION_KEY);
    expect(
      await publish({
        token: active.runtimeToken,
        epoch: active.epoch,
        sandboxId: f.id,
        generation: active.epoch,
        authJson: native(1),
        expectedRevision: 0,
      }),
    ).toEqual({ authRevision: 1, committed: true });
    await f.db.query("update model_auth_state set source_generation='server:ready' where account_id=$1", [account.id]);
    const route = createRuntimeModelAccess(f.sql, ENCRYPTION_KEY, {
      async access() {
        return {
          accessToken: "offline-access",
          chatgptAccountId: "offline-account",
          chatgptPlanType: null,
          revision: 1,
        };
      },
    });
    const request = () =>
      route(
        new Request("https://armada.example/api/runtime/model-access", {
          method: "POST",
          headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
          body: "{}",
        }),
      );
    expect(await (await request())?.json()).toEqual({
      epoch: active.epoch,
      access: {
        accessToken: "offline-access",
        chatgptAccountId: "offline-account",
        chatgptPlanType: null,
        revision: 1,
      },
    });
    await f.db.query("update docker_hosts set revoked_at=now() where id=$1", [f.host]);
    expect((await request())?.status).toBe(401);
    await expect(
      publish({
        token: active.runtimeToken,
        epoch: active.epoch,
        sandboxId: f.id,
        generation: active.epoch,
        authJson: native(2),
        expectedRevision: 1,
      }),
    ).rejects.toThrow("runtime_enrolment_denied");
  } finally {
    await f.db.close();
  }
});

// The native credential paths carry prelocks only inside their original transaction.
// A stale receipt must not bypass a membership change after those locks are released.
test("source membership prelocks cannot authorize a later transaction after issuer departure", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    if (!f.sql.transaction) throw Error("missing transaction");
    const prelock = await f.sql.transaction((tx) => f.validator.lockSourceMembers(tx, f.id, f.people.owner));
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.member]);
    let committed = false;
    await expect(
      f.validator.withSession(
        active.runtimeToken,
        active.epoch,
        async () => {
          committed = true;
        },
        prelock,
      ),
    ).rejects.toThrow("runtime_enrolment_denied");
    expect(committed).toBe(false);
  } finally {
    await f.db.close();
  }
});
