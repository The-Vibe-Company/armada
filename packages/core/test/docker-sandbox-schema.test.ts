import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";

// The migrated database owns these storage/security contracts; no provider or API is enabled.
describe("Docker plain-image sandbox schema", () => {
  let db: PGlite;
  const org = crypto.randomUUID();
  const otherOrg = crypto.randomUUID();
  const issuer = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const other = crypto.randomUUID();
  const host = crypto.randomUUID();
  const installation = crypto.randomUUID();
  const image = `ubuntu@sha256:${"a".repeat(64)}`;

  beforeAll(async () => {
    db = await openMigratedDatabase();
    for (const id of [issuer, owner, other]) await db.query("insert into auth.users(id) values ($1)", [id]);
    for (const id of [org, otherOrg]) await db.query("insert into orgs(id,name) values ($1,$2)", [id, `Docker ${id}`]);
    for (const id of [issuer, owner, other]) {
      await db.query("insert into members(org_id,user_id,role) values ($1,$2,'member')", [org, id]);
    }
    await db.query(
      `insert into docker_hosts(id,org_id,owner_id,installation_id,hash,registration_expires_at)
       values ($1,$2,$3,$4,$5,now()-interval '1 day')`,
      [host, org, issuer, installation, "a".repeat(64)],
    );
  });
  afterAll(async () => {
    await db?.close();
  });

  function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const id = crypto.randomUUID();
    const generation = crypto.randomUUID();
    const row: Record<string, unknown> = {
      id,
      org_id: org,
      owner_id: owner,
      provider: "docker",
      harness: "codex",
      status: "ready",
      docker_host_id: host,
      docker_installation_id: installation,
      docker_generation: generation,
      docker_image: image,
      provider_sandbox_id: `armada-${installation}-${host}-${id}-${generation}`,
      ...overrides,
    };
    if (!Object.hasOwn(overrides, "provider_sandbox_id")) {
      row.provider_sandbox_id = `armada-${row.docker_installation_id}-${row.docker_host_id}-${row.id}-${row.docker_generation}`;
    }
    return row;
  }

  async function insert(row = record()) {
    const columns = Object.keys(row);
    await db.query(
      `insert into sandboxes (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
      Object.values(row),
    );
    return row.id;
  }

  async function asRole<T>(role: "authenticated" | "anon", user: string, run: () => Promise<T>) {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
      await db.exec(`set local role ${role}`);
      const result = await run();
      await db.exec("commit");
      return result;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  }

  test("registered hosts admit private Codex records without a golden or Boat alias", async () => {
    const id = await insert();
    expect(
      (
        await db.query(
          `select golden_id,source_golden_visibility,boat_id,visibility,access_owner_id,boat_runtime,repository_dir from sandboxes where id=$1`,
          [id],
        )
      ).rows,
    ).toEqual([
      {
        golden_id: null,
        source_golden_visibility: null,
        boat_id: null,
        visibility: "private",
        access_owner_id: owner,
        boat_runtime: false,
        repository_dir: null,
      },
    ]);
    expect(
      (await asRole("authenticated", owner, () => db.query("select id from sandboxes where id=$1", [id]))).rows,
    ).toEqual([{ id }]);
    expect(
      (await asRole("authenticated", other, () => db.query("select id from sandboxes where id=$1", [id]))).rows,
    ).toEqual([]);
  });

  test("admission rejects unavailable hosts, absent members and malformed Docker bindings", async () => {
    for (const [override, error] of [
      [{ org_id: otherOrg }, /Docker host unavailable/],
      [{ docker_host_id: crypto.randomUUID() }, /Docker host unavailable/],
      [{ docker_installation_id: crypto.randomUUID() }, /Docker host unavailable/],
      [{ provider_sandbox_id: "wrong-name" }, /name must match/],
      [{ docker_generation: null }, /name must match/],
      [{ docker_image: "ubuntu:latest" }, /sandboxes_docker_binding_chk/],
      [{ docker_image: `${"a".repeat(450)}@sha256:${"a".repeat(64)}` }, /sandboxes_docker_binding_chk/],
      [{ docker_image: null }, /sandboxes_docker_binding_chk/],
      [{ visibility: "org" }, /sandboxes_docker_binding_chk/],
      [{ access_owner_id: other }, /sandboxes_docker_binding_chk/],
      [{ boat_runtime: true }, /sandboxes_(docker_binding_chk|boat_runtime_target)/],
      [{ boat_id: "bx_alias" }, /sandboxes_provider_compat_chk/],
      [{ repository_dir: "repo" }, /configured golden repository/],
      [{ expires_at: "2000-01-01T00:00:00Z" }, /expiry must be in the future/],
      [{ expires_at: null }, /expiry must be in the future/],
      [{ source_golden_visibility: "private" }, /sandboxes_golden_source_chk/],
    ] as const) {
      await expect(insert(record(override))).rejects.toThrow(error);
    }
    await db.query("update docker_hosts set revoked_at=now() where id=$1", [host]);
    await expect(insert()).rejects.toThrow(/Docker host unavailable/);
    await db.query("update docker_hosts set revoked_at=null where id=$1", [host]);
    await db.query("delete from members where org_id=$1 and user_id=$2", [org, issuer]);
    await expect(insert()).rejects.toThrow(/issuer is not a member/);
    await db.query("insert into members(org_id,user_id,role) values ($1,$2,'member')", [org, issuer]);
    await db.query("delete from members where org_id=$1 and user_id=$2", [org, owner]);
    await expect(insert()).rejects.toThrow(/owner is not a member/);
    await db.query("insert into members(org_id,user_id,role) values ($1,$2,'member')", [org, owner]);
    const unregistered = crypto.randomUUID();
    await db.query(
      `insert into docker_hosts(id,org_id,owner_id,registration_hash,registration_expires_at) values ($1,$2,$3,$4,now()-interval '1 day')`,
      [unregistered, org, issuer, "b".repeat(64)],
    );
    await expect(insert(record({ docker_host_id: unregistered }))).rejects.toThrow(/Docker host unavailable/);
  });

  test("binding and lifecycle guards survive host revocation while trusted cleanup remains possible", async () => {
    const id = await insert();
    for (const [column, value] of [
      ["docker_host_id", crypto.randomUUID()],
      ["docker_installation_id", crypto.randomUUID()],
      ["docker_generation", crypto.randomUUID()],
      ["docker_image", `ubuntu@sha256:${"b".repeat(64)}`],
      ["provider_sandbox_id", "changed"],
      ["owner_id", other],
      ["harness", "claude"],
    ]) {
      await expect(db.query(`update sandboxes set ${column}=$1 where id=$2`, [value, id])).rejects.toThrow(/immutable/);
    }
    await expect(db.query("update sandboxes set provider='boat' where id=$1", [id])).rejects.toThrow(
      /sandbox golden does not exist/,
    );
    for (const [status, stopped, deleted, message] of [
      ["ready", "2000-01-01", null, /active sandbox/],
      ["stopping", null, "2000-01-01", /stopping sandbox/],
      ["stopped", null, null, /stopped sandbox records/],
      ["deleted", null, null, /deleted sandbox records/],
    ] as const) {
      await expect(
        db.query("update sandboxes set status=$1,stopped_at=$2,deleted_at=$3 where id=$4", [
          status,
          stopped,
          deleted,
          id,
        ]),
      ).rejects.toThrow(message);
    }
    await db.query("update docker_hosts set revoked_at=now(),installation_id=$2 where id=$1", [
      host,
      crypto.randomUUID(),
    ]);
    await db.query("delete from members where org_id=$1 and user_id in ($2,$3)", [org, owner, issuer]);
    await db.query("update sandboxes set status='deleted',deleted_at=now() where id=$1", [id]);
    expect((await db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "deleted" }]);
    await db.query("update docker_hosts set revoked_at=null,installation_id=$2 where id=$1", [host, installation]);
    await db.query("insert into members(org_id,user_id,role) values ($1,$2,'member'),($1,$3,'member')", [
      org,
      owner,
      issuer,
    ]);
  });

  test("JWT writes cannot bypass service ownership through security-definer mutations", async () => {
    const id = await insert();
    // Model the existing privileged-RPC boundary; role must survive current_user elevation.
    await db.exec(`create function public.test_docker_update(target uuid) returns void language sql security definer as $$ update public.sandboxes set status='running' where id=target $$;
      create function public.test_docker_delete(target uuid) returns void language sql security definer as $$ delete from public.sandboxes where id=target $$;
      grant execute on function public.test_docker_update(uuid),public.test_docker_delete(uuid) to authenticated,anon;`);
    for (const role of ["authenticated", "anon"] as const) {
      await expect(
        asRole(role, owner, () => db.query("update sandboxes set docker_image=$1 where id=$2", [image, id])),
      ).rejects.toThrow(/permission denied/);
      await expect(asRole(role, owner, () => insert())).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, owner, () => db.query("update sandboxes set status='running' where id=$1", [id])),
      ).rejects.toThrow(/server only|permission denied/);
      for (const action of ["update", "delete"]) {
        await expect(
          asRole(role, owner, () => db.query(`select public.test_docker_${action}($1)`, [id])),
        ).rejects.toThrow(/Armada server only/);
      }
    }
  });

  test("Boat and Modal still require a golden and cannot receive Docker bindings; Docker goldens remain unsupported", async () => {
    for (const provider of ["boat", "modal"]) {
      await expect(
        insert({
          id: crypto.randomUUID(),
          org_id: org,
          owner_id: owner,
          provider,
          provider_sandbox_id: "no-golden",
          harness: "codex",
          status: "ready",
        }),
      ).rejects.toThrow(/sandbox golden does not exist/);
      const golden = crypto.randomUUID();
      await db.query(
        `insert into goldens(id,org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id) values ($1,$2,$3,$4,'private',$5,$6,$6,$6)`,
        [golden, org, owner, provider, provider, provider === "modal" ? "binding" : null],
      );
      const row = {
        id: crypto.randomUUID(),
        org_id: org,
        owner_id: owner,
        provider,
        golden_id: golden,
        provider_sandbox_id: `${provider}-valid`,
        harness: "codex",
        status: "ready",
      };
      await insert(row);
      await expect(
        insert({ ...row, id: crypto.randomUUID(), provider_sandbox_id: `${provider}-invalid`, docker_host_id: host }),
      ).rejects.toThrow(/sandboxes_docker_binding_chk/);
      await expect(insert(record({ golden_id: golden }))).rejects.toThrow(/sandboxes_golden_source_chk/);
    }
    await expect(
      db.query(
        `insert into goldens(org_id,owner_id,name,visibility,provider) values ($1,$2,'unsupported','private','docker')`,
        [org, owner],
      ),
    ).rejects.toThrow(/goldens_(provider_compat|modal_binding)_chk/);
  });
});
