import { expect, test } from "bun:test";
import { CODEX_AUTH_ENV } from "@armada/core";
import {
  createSqlVaultStore,
  decryptSecret,
  encryptSecret,
  resolveCredentials,
  type Sql,
  toHarnessCredentials,
} from "@armada/core/server";
import { dockerRuntimeConfiguration } from "../src/docker-runtime-configuration.ts";
import { runtimeConfiguration } from "../src/runtime-configuration.ts";
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

async function configurationFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const key = `offline-docker-${crypto.randomUUID()}`;
  const account = (
    await f.db.query<{ id: string; version: number }>(
      "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'openai',$2) returning id,version",
      [f.people.owner, await encryptSecret(key, ENCRYPTION_KEY)],
    )
  ).rows[0];
  if (!account) throw Error("missing account");
  await f.db.query("update sandboxes set credential_id=$2,credential_version=$3 where id=$1", [
    f.id,
    account.id,
    account.version,
  ]);
  const sandbox = (
    await f.db.query<Parameters<typeof dockerRuntimeConfiguration>[0]["sandbox"]>(
      `select id,owner_id as "ownerId",org_id as "orgId",provider,harness,visibility,status,
       deleted_at::text as "deletedAt",stop_requested_at::text as "stopRequestedAt",
       expires_at::text as "expiresAt",repository_dir as "repositoryDir",
       credential_id as "credentialId",credential_version as "credentialVersion" from sandboxes where id=$1`,
      [f.id],
    )
  ).rows[0];
  if (!sandbox) throw Error("missing Docker target");
  const actor = { userId: f.people.owner, orgId: f.people.org, role: "member" as const };
  const credentials = toHarnessCredentials(
    await resolveCredentials(createSqlVaultStore(f.sql), ENCRYPTION_KEY, {
      ...actor,
      harness: "codex",
      credentialId: sandbox.credentialId,
      credentialVersion: sandbox.credentialVersion,
    }),
  );
  // Trusted descriptor: archive inventory validation belongs to the runtime artifact boundary.
  const manifest = {
    protocol: 1,
    platform: "linux",
    architecture: "x64",
    libc: "glibc",
    runtime: { sha256: "a".repeat(64), bytes: 10 },
    harnesses: { codex: { files: [{ path: "bin/codex" }] } },
  };
  return { key, actor, sandbox, credentials, manifest, architecture: "x64" as const };
}

// The shared Boat matrix owns auth selection; Docker owns its no-golden target and sealed delivery.
test("Docker current account projection reaches only encrypted enrolment under owner and host scope", async () => {
  const f = await fixture();
  try {
    const input = await configurationFixture(f);
    const plan = await dockerRuntimeConfiguration(input);
    expect(plan.configuration.cwd).toBe("/home/user");
    expect(plan.configuration.grant.expiresAt).toBe(Date.parse(input.sandbox.expiresAt));
    expect(JSON.stringify({ artifact: plan.artifact, cacheDir: plan.cacheDir })).not.toContain(input.key);
    await expect(
      f.issuer.issue({ sandboxId: f.id, ownerId: f.people.member, configuration: plan.configuration }),
    ).rejects.toThrow("runtime_enrolment_denied");
    const ticket = await f.issuer.issue({
      sandboxId: f.id,
      ownerId: f.people.owner,
      configuration: plan.configuration,
    });
    expect(JSON.stringify(ticket)).not.toContain(input.key);
    const pending = (
      await f.db.query<{ configuration_enc: Uint8Array<ArrayBuffer> }>(
        "select configuration_enc from runtime_enrolments where sandbox_id=$1",
        [f.id],
      )
    ).rows[0];
    if (!pending) throw Error("missing sealed configuration");
    expect(Buffer.from(pending.configuration_enc).includes(Buffer.from(input.key))).toBe(false);
    const active = await f.validator.enrol(ticket.enrolmentToken);
    expect(active.configuration).toEqual(plan.configuration);
    expect(active.configuration).toMatchObject({ codexEnv: { OPENAI_API_KEY: input.key } });
    const next = await f.issuer.issue({ sandboxId: f.id, ownerId: f.people.owner, configuration: plan.configuration });
    await f.db.query("update docker_hosts set revoked_at=now() where id=$1", [f.host]);
    await expect(f.validator.enrol(next.enrolmentToken)).rejects.toThrow("runtime_enrolment_denied");
  } finally {
    await f.db.close();
  }
});

test("Docker projection rejects repository, provider, visibility, pin and environment escalation without effects", async () => {
  const f = await fixture();
  try {
    const original = await configurationFixture(f);
    let reads = 0;
    for (const reason of ["repository", "provider", "visibility", "binding", "environment", "selector"]) {
      const input = structuredClone(original);
      // A missed admission guard would reach native state; denied inputs must not do so.
      input.credentials.codexAuthJson = true;
      input.credentials.env = { [CODEX_AUTH_ENV]: original.key };
      if (reason === "repository") Object.assign(input.sandbox, { repositoryDir: "project" });
      if (reason === "provider") Object.assign(input.sandbox, { provider: "boat" });
      if (reason === "selector") Object.assign(input.sandbox, { provider: original.key });
      if (reason === "visibility") Object.assign(input.sandbox, { visibility: "org" });
      if (reason === "binding") input.credentials.binding = { credentialId: crypto.randomUUID(), credentialVersion: 1 };
      if (reason === "environment") input.credentials.env.ANTHROPIC_API_KEY = original.key;
      const configured = {
        ...input,
        modelAuth: {
          state: {
            async read() {
              reads++;
              throw Error(original.key);
            },
          },
        },
      };
      const projection =
        reason === "selector"
          ? runtimeConfiguration(configured, original.key as "docker")
          : dockerRuntimeConfiguration(configured);
      await expect(projection).rejects.toMatchObject({
        code: "unavailable",
        message:
          reason === "selector"
            ? "Runtime configuration is unavailable."
            : "Docker runtime configuration is unavailable.",
      });
    }
    expect(reads).toBe(0);
    expect((await f.db.query("select 1 from runtime_enrolments where sandbox_id=$1", [f.id])).rows).toEqual([]);
  } finally {
    await f.db.close();
  }
});
