import { expect, test } from "bun:test";
import { createSqlAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { createSkillCatalog, createSqlVaultStore, type Sql, setCredential } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

// Authorization owner: actual encrypted store + auth + control transport;
// only Skillpack's remote HTTP boundary is fake.
test("catalog uses current membership and launch credential precedence without leaking private metadata", async () => {
  const { db, people } = await database();
  try {
    const sql: Sql = { query: (s, p) => db.query(s, p), transaction: (work) => db.transaction((tx) => work(tx)) };
    const store = createSqlVaultStore(sql);
    const authStore = createSqlAuthStore(sql);
    const personal = "cmp_pat_" + "a".repeat(48),
      orgKey = "cmp_pat_" + "b".repeat(48);
    await setCredential(store, ENCRYPTION_KEY, people.admin, {
      scope: "org",
      org: people.org,
      kind: "skillpack",
      value: orgKey,
    });
    const sent: (string | null)[] = [];
    let revokeDuringRead = false;
    const options: ControlOptions = {
      store,
      authStore,
      encryptionKey: ENCRYPTION_KEY,
      skillCatalog: createSkillCatalog((async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("authorization"));
        if (revokeDuringRead)
          await db.query("delete from members where user_id=$1 and org_id=$2", [people.owner, people.org]);
        return Response.json([
          {
            slug: "notes",
            description: "Useful notes",
            current_version: "1.2.3",
            validation: "valid",
            share_token: "never-forward",
            storage_path: "private/path",
            display: { name: "Notes" },
          },
        ]);
      }) as typeof fetch),
      supabase: {
        supabaseUrl: "https://supabase.test",
        anonKey: "synthetic-anon",
        fetch: async () => Response.json({ id: people.owner }),
      },
    };
    const token = generateToken("service");
    await authStore.insertToken("service", {
      userId: people.owner,
      orgId: people.org,
      hash: await sha256Hex(token),
      label: "catalog",
      createdAt: new Date().toISOString(),
    });
    const api = (body: object, bearer = "eyJhbGciOiJIUzI1NiJ9.e30.sig", query = "") =>
      handleControlRequest(
        new Request("https://armada.test/api/v1/skillpack/catalog" + query, {
          method: "POST",
          headers: bearer ? { authorization: "Bearer " + bearer } : {},
          body: JSON.stringify(body),
        }),
        options,
      );
    const request = { org: people.org, source: "private" };
    expect((await api(request, ""))?.status).toBe(401);
    expect((await api({ ...request, org: people.otherOrg }, token))?.status).toBe(403);
    expect((await api({ ...request, apiUrl: "https://attacker.test" }))?.status).toBe(400);
    expect((await api(request, undefined, "?source=public"))?.status).toBe(400);
    expect(sent).toHaveLength(0);
    const fallback = await api(request);
    expect(fallback?.status).toBe(200);
    expect(fallback?.headers.get("cache-control")).toBe("no-store");
    const result = await fallback?.json();
    expect(result).toEqual({
      items: [
        { reference: "notes", name: "Notes", description: "Useful notes", visibility: "private", versions: ["1.2.3"] },
      ],
      nextOffset: null,
    });
    expect(sent).toEqual(["Bearer " + orgKey]);
    await setCredential(store, ENCRYPTION_KEY, people.owner, {
      scope: "user",
      org: undefined,
      kind: "skillpack",
      value: personal,
    });
    expect((await api(request))?.status).toBe(200);
    expect(sent.at(-1)).toBe("Bearer " + personal);
    await db.query("update credentials set status='revoked' where scope='user' and owner_id=$1 and kind='skillpack'", [
      people.owner,
    ]);
    expect((await api(request))?.status).toBe(422);
    expect(sent).toHaveLength(2);
    await db.query("update credentials set status='active' where scope='user' and owner_id=$1 and kind='skillpack'", [
      people.owner,
    ]);
    revokeDuringRead = true;
    expect((await api(request))?.status).toBe(404);
    expect((await api(request))?.status).toBe(404);
    expect(sent).toHaveLength(3);
  } finally {
    await db.close();
  }
});
