import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { createSqlVaultStore, decryptSecret, encryptSecret } from "@armada/core/server";
import { createDockerBootstrapService, DockerBootstrapDenied } from "../src/docker-bootstrap-service.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { migratedDatabase } from "./migrated-database.ts";

let db: Awaited<ReturnType<typeof migratedDatabase>>;
const sql: Sql = {
  query: (q, v) => db.query(q, v),
  transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const key = Buffer.alloc(32, 9).toString("base64");
const manifest = {
  protocol: 1,
  platform: "linux",
  architecture: "x64",
  libc: "glibc",
  runtime: { sha256: "b".repeat(64), bytes: 42 },
  harnesses: { codex: { files: [{ path: "bin/codex" }] } },
};
const credentials = launchCredentials(createSqlVaultStore(sql), key);
const options = {
  enabled: true,
  serverUrl: "https://armada.example",
  manifest,
  architecture: "x64" as const,
  credentials,
};
const service = createDockerBootstrapService(sql, key, options);
const hosts = createDockerHostStore(sql, key);
const reservations = createDockerSandboxService(sql, key, { enabled: true });
beforeAll(async () => {
  db = await migratedDatabase();
});
afterAll(async () => {
  await db.close();
});
async function fixture(ack = true) {
  const orgId = randomUUID(),
    userId = randomUUID(),
    adminId = randomUUID();
  await db.query(`insert into auth.users(id) values($1),($2)`, [userId, adminId]);
  await db.query(`insert into public.orgs(id,name) values($1,$2)`, [orgId, `bootstrap-${orgId}`]);
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'admin')`, [
    orgId,
    userId,
    adminId,
  ]);
  const actor = { userId, orgId },
    admin = { userId: adminId, orgId };
  const registration = await hosts.issueRegistration(admin),
    installationId = randomUUID();
  const host = await hosts.exchangeRegistration(registration.registrationToken, installationId);
  // Generated offline value, not an actual credential or an externally usable fixture secret.
  const secret = `offline-bootstrap-${randomUUID()}`,
    credentialId = randomUUID();
  await db.query(`insert into public.credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)`, [
    credentialId,
    userId,
    await encryptSecret(secret, key),
  ]);
  const sandbox = await reservations.reserve(actor, {
    requestId: randomUUID(),
    hostId: host.hostId,
    image: `worker@sha256:${"a".repeat(64)}`,
    credentialId,
    credentialVersion: 1,
  });
  if (ack) await hosts.complete(host.hostToken, installationId, { requestId: sandbox.id, outcome: "completed" });
  return { actor, admin, secret, credentialId, sandbox, installationId, ...host, requestId: randomUUID() };
}
async function denied(work: Promise<unknown>) {
  await expect(work).rejects.toBeInstanceOf(DockerBootstrapDenied);
  await expect(work).rejects.toThrow("Docker bootstrap denied");
}
async function pending(sandboxId: string) {
  return (
    await db.query<{
      enrolment_hash: string | null;
      runtime_hash: string | null;
      epoch: string;
      configuration_enc: Uint8Array<ArrayBuffer> | null;
    }>(
      `select enrolment_hash,runtime_hash,epoch::text,configuration_enc from public.runtime_enrolments where sandbox_id=$1`,
      [sandboxId],
    )
  ).rows[0];
}

// Service composition owns admission ordering and atomic delivery. Auth selection itself is tested elsewhere.
test("bootstrap is literal opt-in, owner-only and waits for create ACK before resolving credentials", async () => {
  const acknowledged = await fixture();
  let disabledResolutions = 0;
  const disabledTracked = {
    ...credentials,
    resolve: async (...args: Parameters<typeof credentials.resolve>) => {
      disabledResolutions++;
      return credentials.resolve(...args);
    },
  };
  for (const enabled of [undefined, false, "true", 1]) {
    await denied(
      createDockerBootstrapService(sql, key, { ...options, enabled, credentials: disabledTracked } as never).bootstrap(
        acknowledged.actor,
        acknowledged.sandbox.id,
        acknowledged.requestId,
      ),
    );
  }
  expect(disabledResolutions).toBe(0);
  expect(await pending(acknowledged.sandbox.id)).toBeUndefined();
  expect(
    (
      await db.query(
        `select 1 from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation='bootstrap'`,
        [acknowledged.sandbox.id],
      )
    ).rows,
  ).toHaveLength(0);
  const f = await fixture(false);
  let resolutions = 0;
  const tracked = {
    ...credentials,
    resolve: async (...args: Parameters<typeof credentials.resolve>) => {
      resolutions++;
      return credentials.resolve(...args);
    },
  };
  const guarded = createDockerBootstrapService(sql, key, { ...options, credentials: tracked });
  await denied(guarded.bootstrap(f.admin, f.sandbox.id, f.requestId));
  await denied(guarded.bootstrap(f.actor, f.sandbox.id, f.requestId));
  expect(resolutions).toBe(0);
  expect(await pending(f.sandbox.id)).toBeUndefined();
  await hosts.complete(f.hostToken, f.installationId, { requestId: f.sandbox.id, outcome: "completed" });
  expect(await guarded.bootstrap(f.actor, f.sandbox.id, f.requestId)).toEqual({
    requestId: f.requestId,
    operation: "bootstrap",
    state: "pending",
  });
  expect(resolutions).toBe(1);
});

test("sealed account configuration is delivered only by enrolment, host gets ticket and artifact, neither ACK means readiness", async () => {
  const f = await fixture();
  const result = await service.bootstrap(f.actor, f.sandbox.id, f.requestId);
  expect(Object.keys(result).sort()).toEqual(["operation", "requestId", "state"]);
  const stored = await pending(f.sandbox.id);
  if (!stored?.configuration_enc) throw Error("missing sealed configuration");
  expect(Buffer.from(stored.configuration_enc).includes(Buffer.from(f.secret))).toBe(false);
  const configuration = JSON.parse(await decryptSecret(stored.configuration_enc, key));
  expect(configuration.codexEnv.OPENAI_API_KEY).toBe(f.secret);
  const delivery = await hosts.poll(f.hostToken, f.installationId);
  if (delivery?.operation !== "bootstrap") throw Error("missing bootstrap delivery");
  expect(delivery.bootstrap).toEqual({
    serverUrl: options.serverUrl,
    artifact: manifest.runtime,
    enrolmentToken: expect.stringMatching(/^armada_enrol_[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(delivery)).not.toContain(f.secret);
  const enrolled = await createRuntimeEnrolments(sql, key).enrol(delivery.bootstrap.enrolmentToken);
  expect(enrolled.configuration).toEqual(configuration);
  await hosts.complete(f.hostToken, f.installationId, { requestId: f.requestId, outcome: "completed" });
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("starting");
});

test("lost commit response retries retain original encrypted job and do not rotate an enrolled runtime", async () => {
  const f = await fixture();
  let lose = true;
  const lostResponse: Sql = {
    ...sql,
    transaction: async (work) => {
      if (!sql.transaction) throw Error("transactions required");
      const result = await sql.transaction(work);
      if (lose && (await pending(f.sandbox.id))) {
        lose = false;
        throw Error("lost commit response");
      }
      return result;
    },
  };
  await denied(
    createDockerBootstrapService(lostResponse, key, {
      ...options,
      serverUrl: "https://ARMADA.example:443/",
    }).bootstrap(f.actor, f.sandbox.id, f.requestId),
  );
  const ciphertext = (
    await db.query<{ input_enc: Uint8Array<ArrayBuffer> }>(
      `select input_enc from public.docker_host_jobs where request_id=$1`,
      [f.requestId],
    )
  ).rows[0]?.input_enc;
  const delivery = await hosts.poll(f.hostToken, f.installationId);
  if (delivery?.operation !== "bootstrap") throw Error("missing delivery");
  const enrolled = await createRuntimeEnrolments(sql, key).enrol(delivery.bootstrap.enrolmentToken);
  await db.query(`update public.credentials set status='revoked' where id=$1`, [f.credentialId]);
  let historicalResolutions = 0;
  const historical = createDockerBootstrapService(sql, key, {
    ...options,
    credentials: {
      resolve: async () => {
        historicalResolutions++;
        throw Error("must not re-resolve historical account");
      },
    },
  });
  expect(await historical.bootstrap(f.actor, f.sandbox.id, f.requestId)).toMatchObject({ state: "pending" });
  expect(await pending(f.sandbox.id)).toMatchObject({
    enrolment_hash: null,
    runtime_hash: expect.any(String),
    epoch: enrolled.epoch,
    configuration_enc: null,
  });
  expect(
    (
      await db.query<{ input_enc: Uint8Array<ArrayBuffer> }>(
        `select input_enc from public.docker_host_jobs where request_id=$1`,
        [f.requestId],
      )
    ).rows[0]?.input_enc,
  ).toEqual(ciphertext);
  await denied(historical.bootstrap(f.actor, f.sandbox.id, randomUUID()));
  await denied(
    createDockerBootstrapService(sql, key, { ...options, serverUrl: "https://changed.example" }).bootstrap(
      f.actor,
      f.sandbox.id,
      f.requestId,
    ),
  );
  await denied(
    createDockerBootstrapService(sql, key, {
      ...options,
      manifest: { ...manifest, runtime: { ...manifest.runtime, sha256: "c".repeat(64) } },
    }).bootstrap(f.actor, f.sandbox.id, f.requestId),
  );
  expect((await pending(f.sandbox.id))?.epoch).toBe(enrolled.epoch);
  expect(historicalResolutions).toBe(0);
});

test("queue failure rolls back runtime ticket issuance and redacts private dependency errors", async () => {
  const f = await fixture();
  await db.exec(`create function public.reject_bootstrap_job() returns trigger language plpgsql as $$
    begin if new.bound_operation='bootstrap' then raise exception 'private queue detail'; end if; return new; end $$;
    create trigger reject_bootstrap_job before insert on public.docker_host_jobs for each row execute function public.reject_bootstrap_job();`);
  try {
    await denied(service.bootstrap(f.actor, f.sandbox.id, f.requestId));
  } finally {
    await db.exec(
      `drop trigger reject_bootstrap_job on public.docker_host_jobs; drop function public.reject_bootstrap_job();`,
    );
  }
  expect(await pending(f.sandbox.id)).toBeUndefined();
  expect(
    (await db.query(`select 1 from public.docker_host_jobs where request_id=$1`, [f.requestId])).rows,
  ).toHaveLength(0);
  const broken = createDockerBootstrapService(sql, key, {
    ...options,
    credentials: {
      resolve: async () => {
        throw Error(f.secret);
      },
    },
  });
  await denied(broken.bootstrap(f.actor, f.sandbox.id, f.requestId));
  expect(await pending(f.sandbox.id)).toBeUndefined();
  expect(await service.bootstrap(f.actor, f.sandbox.id, f.requestId)).toMatchObject({ state: "pending" });
});

test("new issuance rechecks current pin, lifecycle, host authority and original reservation actor epoch without replacing unknown grants", async () => {
  for (const change of ["pin", "stop", "host", "rejoin", "race"] as const) {
    const f = await fixture();
    let resolver = credentials;
    if (change === "pin")
      await db.query(`update public.credentials set status='revoked' where id=$1`, [f.credentialId]);
    if (change === "stop") await reservations.stop(f.actor, f.sandbox.id, randomUUID());
    if (change === "host") await hosts.revoke(f.admin, f.hostId);
    if (change === "rejoin") {
      await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [f.actor.orgId, f.actor.userId]);
      await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member')`, [
        f.actor.orgId,
        f.actor.userId,
      ]);
    }
    if (change === "race")
      resolver = {
        ...credentials,
        resolve: async (...args) => {
          const value = await credentials.resolve(...args);
          await db.query(`update public.credentials set status='revoked' where id=$1`, [f.credentialId]);
          return value;
        },
      };
    await denied(
      createDockerBootstrapService(sql, key, { ...options, credentials: resolver }).bootstrap(
        f.actor,
        f.sandbox.id,
        f.requestId,
      ),
    );
    expect(await pending(f.sandbox.id)).toBeUndefined();
  }
  const occupied = await fixture();
  await createRuntimeEnrolments(sql, key, { allowDockerIssue: true }).issue({
    sandboxId: occupied.sandbox.id,
    ownerId: occupied.actor.userId,
    configuration: { existing: "grant" },
  });
  const original = await pending(occupied.sandbox.id);
  await denied(service.bootstrap(occupied.actor, occupied.sandbox.id, occupied.requestId));
  expect(await pending(occupied.sandbox.id)).toEqual(original);
});

test("resume retains allocation and conversation, fences the old epoch and issues a fresh single-use enrolment", async () => {
  const f = await fixture();
  await service.bootstrap(f.actor, f.sandbox.id, f.requestId);
  const first = await hosts.poll(f.hostToken, f.installationId);
  if (first?.operation !== "bootstrap") throw Error("missing initial bootstrap");
  const authority = createRuntimeEnrolments(sql, key);
  const initial = await authority.enrol(first.bootstrap.enrolmentToken);
  await hosts.complete(f.hostToken, f.installationId, { requestId: f.requestId, outcome: "completed" });
  const conversationId = randomUUID();
  await db.query(`update public.sandboxes set status='ready',conversation_ids=array[$2]::text[] where id=$1`, [
    f.sandbox.id,
    conversationId,
  ]);
  const stopId = randomUUID();
  await reservations.stop(f.actor, f.sandbox.id, stopId);
  await hosts.complete(f.hostToken, f.installationId, { requestId: stopId, outcome: "completed" });
  const resumeId = randomUUID();
  await denied(service.resume(f.admin, f.sandbox.id, resumeId));
  expect(await service.resume(f.actor, f.sandbox.id, resumeId)).toEqual({
    requestId: resumeId,
    operation: "resume",
    state: "pending",
  });
  const resumed = await hosts.poll(f.hostToken, f.installationId);
  if (resumed?.operation !== "resume") throw Error("missing resumed bootstrap");
  expect(resumed.request).toEqual(first.request);
  expect(resumed.bootstrap.enrolmentToken).not.toBe(first.bootstrap.enrolmentToken);
  await expect(authority.withSession(initial.runtimeToken, initial.epoch, async () => true)).rejects.toThrow();
  const enrolled = await authority.enrol(resumed.bootstrap.enrolmentToken);
  expect(BigInt(enrolled.epoch)).toBeGreaterThan(BigInt(initial.epoch));
  expect(
    (
      await db.query<{ conversation_ids: string[] }>(`select conversation_ids from public.sandboxes where id=$1`, [
        f.sandbox.id,
      ])
    ).rows[0]?.conversation_ids,
  ).toEqual([conversationId]);
  await hosts.complete(f.hostToken, f.installationId, { requestId: resumeId, outcome: "completed" });
  expect(await service.resume(f.actor, f.sandbox.id, resumeId)).toEqual({
    requestId: resumeId,
    operation: "resume",
    state: "completed",
  });
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("starting");
});
