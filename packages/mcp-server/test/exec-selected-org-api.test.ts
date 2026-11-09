import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAuthStore } from "@armada/auth";
import { createSqlVaultStore, type Provider } from "@armada/core";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { filePreferences } from "../../cli/src/preferences.ts";
import { run } from "../../cli/src/run.ts";
import { memorySessionStore } from "../../cli/src/session.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";

const user = "11111111-1111-4111-8111-111111111111";
const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sandboxB = "22222222-2222-4222-8222-222222222222";

test("exec command text after -- cannot bypass persisted selected-org HTTP scope", async () => {
  const db = await openDatabase();
  const directory = await mkdtemp(join(tmpdir(), "armada-exec-scope-"));
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users(id) values ($1)", [user]);
    await db.query("insert into orgs(id,name) values ($1,'Alpha'),($2,'Beta')", [orgA, orgB]);
    await db.query("insert into members(org_id,user_id,role) values ($1,$3,'admin'),($2,$3,'admin')", [
      orgA,
      orgB,
      user,
    ]);
    const golden = (
      await db.query<{ id: string }>(
        "insert into goldens(org_id,name,visibility,owner_id,boat_snapshot_id,config) values ($1,'web','org',$2,'snapshot',$3::jsonb) returning id",
        [
          orgB,
          user,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
        ],
      )
    ).rows[0];
    if (!golden) throw new Error("Missing golden fixture.");
    await db.query(
      "insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status) values ($1,'bx_beta',$2,$3,$4,'codex','ready')",
      [sandboxB, golden.id, orgB, user],
    );
    const authStore = createMemoryAuthStore();
    for (const [orgId, name] of [
      [orgA, "Alpha"],
      [orgB, "Beta"],
    ] as const)
      authStore.addMembership(user, { orgId, name, role: "admin" });
    const executed: string[] = [];
    const provider = {
      id: "boat",
      async exec(input: { command: string }) {
        executed.push(input.command);
        return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, truncated: false, detached: false };
      },
    } as unknown as Provider;
    const options: ControlOptions = {
      authStore,
      store: createSqlVaultStore(db),
      encryptionKey: Buffer.alloc(32, 7).toString("base64"),
      data: createSqlData(db),
      providers: { resolve: async () => provider },
      supabase: {
        supabaseUrl: "https://supabase.test",
        anonKey: "anon",
        fetch: async () => Response.json({ id: user }),
      },
    };
    const preferencesPath = join(directory, "preferences.json");
    await filePreferences(preferencesPath).write("https://armada.test", orgA);
    const requests: Record<string, unknown>[] = [];
    const statuses: number[] = [];
    let out = "";
    let err = "";
    const auth: AuthIo = {
      env: { ARMADA_URL: "https://armada.test" },
      preferences: filePreferences(preferencesPath),
      session: memorySessionStore({
        accessToken: `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: user })).replace(/=+$/, "")}.sig`,
        refreshToken: "fixture",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      now: () => new Date(),
      open: () => undefined,
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        expect(new URL(request.url).pathname).toBe("/api/v1/sandbox/exec");
        requests.push((await request.clone().json()) as Record<string, unknown>);
        const response = (await handleControlRequest(request, options)) ?? new Response(null, { status: 404 });
        statuses.push(response.status);
        return response;
      },
    };
    for (const commandFlag of ["--org", `--org=${orgB}`]) {
      expect(
        await run(
          ["exec", sandboxB, "--json", "--", "printf", commandFlag],
          { out: auth.out, err: auth.err },
          { auth },
        ),
      ).toBe(1);
      expect(requests.at(-1)).toMatchObject({ org: orgA, id: sandboxB, command: `printf ${commandFlag}` });
    }
    expect(executed).toEqual([]);
    expect(out).toBe("");
    expect(statuses).toEqual([404, 404]);
    expect(err).toContain("No sandbox with id");
    for (const explicit of [["--org", orgB], [`--org=${orgB}`]]) {
      expect(
        await run(["exec", sandboxB, ...explicit, "--", "printf", "--org"], { out: auth.out, err: auth.err }, { auth }),
      ).toBe(0);
      expect(requests.at(-1)).toMatchObject({ org: orgB, command: "printf --org" });
    }
    expect(executed).toEqual(["printf --org", "printf --org"]);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
