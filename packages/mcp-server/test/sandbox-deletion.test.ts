import { expect, test } from "bun:test";
import { createSqlVaultStore, ProviderError } from "@armada/core";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { run } from "../../cli/src/run.ts";
import { memorySessionStore } from "../../cli/src/session.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

// The shared HTTP/MCP boundary, real migrations and SQL activity CAS own deletion policy.
// A mocked store would miss authorization, archive cleanup and concurrent resume admission.
test("sandbox deletion authorizes live owners/admins, fences activity, and preserves history only after provider success", async () => {
  const server = await harness();
  try {
    const { people: p, db, boat } = server;
    const ownerToken = await server.token(p.owner);
    const memberToken = await server.token(p.member);
    const adminToken = await server.token(p.admin);
    const owner = await server.client(ownerToken);
    const store = createSqlVaultStore(db);
    const options: ControlOptions = {
      authStore: server.auth,
      store,
      encryptionKey: ENCRYPTION_KEY,
      supabase: { supabaseUrl: "https://project.supabase.co", anonKey: "anon" },
      data: createSqlData(db),
      providers: providerRegistry({ vault: store, encryptionKey: ENCRYPTION_KEY, providerFor: boat.providerFor }),
      now: () => server.clock.now,
    };
    const request = async (id: string, token = ownerToken, method = "DELETE") => {
      const response = await handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/sandboxes/${id}`, {
          method,
          headers: { authorization: `Bearer ${token}` },
        }),
        options,
      );
      if (!response) throw new Error("Missing deletion route.");
      return response;
    };
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    const insert = async (status = "stopped", providerId = `bx_${crypto.randomUUID()}`) => {
      const id = crypto.randomUUID();
      await db.query(
        `insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,visibility,stopped_at,model,reasoning_effort)
        values($1,$2,$3,$4,$5,'claude',$6::sandbox_status,'private',case when $6='stopped' then now() else null end,'claude-sonnet-4-6','medium')`,
        [id, providerId, golden.id, p.org, p.owner, status],
      );
      return id;
    };
    const state = async (id: string) =>
      (
        await db.query<{ status: string; deleted_at: Date | null; preservation_note: string | null }>(
          "select status::text,deleted_at,preservation_note from sandboxes where id=$1",
          [id],
        )
      ).rows[0]!;
    const calls: string[] = [];
    boat.provider.delete = async ({ sandboxId }) => {
      calls.push(sandboxId);
      return { status: "deleted" };
    };
    const id = await insert();
    await db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [
      id,
      new Uint8Array([1]),
    ]);
    await db.query("update sandboxes set preservation_note='preserved' where id=$1", [id]);
    expect((await request(id, memberToken)).status).toBe(404);
    expect((await request(id, ownerToken, "POST")).status).toBe(405);
    for (const status of ["starting", "ready", "running", "stopping"]) {
      const active = await insert(status);
      const refused = await request(active);
      expect(refused.status).toBe(409);
      expect((await state(active)).status).toBe(status);
    }
    expect(calls).toEqual([]);
    const removed = await request(id);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ id, status: "deleted" });
    const history = await state(id);
    expect(history.status).toBe("deleted");
    expect(history.deleted_at).not.toBeNull();
    expect(history.preservation_note).toBeNull();
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toEqual([]);
    expect((await request(id)).status).toBe(200);
    expect(await state(id)).toEqual(history);
    expect(calls).toHaveLength(1);
    const listed = await call(owner, "list");
    expect((listed.data.sandboxes as { id: string }[]).map((row) => row.id)).not.toContain(id);

    const failed = await insert("failed");
    boat.provider.delete = async () => {
      throw new ProviderError({ provider: "boat", code: "unavailable", message: "offline", retryable: true });
    };
    expect((await request(failed)).status).toBe(503);
    expect((await state(failed)).status).toBe("failed");
    expect((await state(failed)).deleted_at).toBeNull();
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [failed]);
    boat.provider.delete = async () => ({ status: "pending" });
    expect((await request(failed)).status).toBe(409);
    expect((await state(failed)).status).toBe("failed");
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [failed]);
    boat.provider.delete = async () => {
      throw new ProviderError({ provider: "boat", code: "not_found", message: "gone", retryable: false });
    };
    expect((await request(failed, adminToken)).status).toBe(200);

    const mcpId = await insert();
    expect((await call(owner, "delete", { id: mcpId })).data).toEqual({ id: mcpId, status: "deleted" });
    const parent = await insert();
    const orchestrator = crypto.randomUUID();
    await db.query("insert into orchestrators(id,org_id,owner_id,sandbox_id) values($1,$2,$3,$4)", [
      orchestrator,
      p.org,
      p.owner,
      parent,
    ]);
    const child = await insert();
    await db.query(
      "insert into orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)",
      [child, orchestrator, p.org, p.owner],
    );
    for (const managed of [parent, child]) {
      const refused = await request(managed);
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as { error: { message: string } };
      expect(body.error.message).toContain("own lifecycle");
      expect((await state(managed)).status).toBe("stopped");
    }

    const cliId = await insert();
    boat.provider.delete = async () => ({ status: "deleted" });
    let output = "",
      errors = "",
      sent = 0;
    const auth: AuthIo = {
      env: { ARMADA_URL: PUBLIC_URL, ARMADA_TOKEN: ownerToken },
      session: memorySessionStore(),
      now: () => server.clock.now,
      open: () => undefined,
      out: (s) => {
        output += s;
      },
      err: () => undefined,
      fetch: async (input, init) => {
        sent++;
        const req = new Request(String(input), init);
        expect(req.method).toBe("DELETE");
        expect(new URL(req.url).pathname).toBe(`/api/v1/sandboxes/${cliId}`);
        return (await handleControlRequest(req, options))!;
      },
    };
    const io = {
      out: (s: string) => {
        output += s;
      },
      err: (s: string) => {
        errors += s;
      },
    };
    expect(await run(["rm", cliId], io, { auth })).not.toBe(0);
    expect(errors).toContain("--yes");
    expect(sent).toBe(0);
    expect(await run(["rm", cliId, "--yes", "--json", "--org", p.org], io, { auth })).toBe(0);
    expect(JSON.parse(output)).toEqual({ id: cliId, status: "deleted" });
    expect(sent).toBe(1);

    const physical = await boat.provider.fork({ from: "snapshot" });
    await boat.provider.stop({ sandboxId: physical.id });
    const raced = await insert("stopped", physical.id);
    let admitted!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    boat.provider.delete = async () => {
      admitted();
      await wait;
      return { status: "deleted" };
    };
    const deletion = request(raced);
    await started;
    const resumed = await call(owner, "send", { id: raced, prompt: "resume" });
    expect(resumed.isError).toBe(true);
    expect(resumed.text).toContain("could not be updated");
    expect(boat.prompts).toHaveLength(0);
    release();
    expect((await deletion).status).toBe(200);
    expect((await state(raced)).status).toBe("deleted");
  } finally {
    await server.close();
  }
});
