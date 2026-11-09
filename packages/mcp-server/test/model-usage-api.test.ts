import { expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { createSqlVaultStore, encryptSecret } from "@armada/core";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { productionAuthIo } from "../../cli/src/auth-commands.ts";
import { credsCommand } from "../../cli/src/vault-commands.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createModelUsageApi } from "../src/model-usage.ts";
import { fakeBoat } from "./support.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "66666666-6666-4666-8666-666666666666";
const ORG = "33333333-3333-4333-8333-333333333333";
const GOLDEN = "44444444-4444-4444-8444-444444444444";
const SANDBOX = "55555555-5555-4555-8555-555555555555";
const KEY = Buffer.alloc(32, 7).toString("base64");

test.each([
  ["user", "org", false],
  ["org", "org", true],
  ["org", "private", false],
] as const)(
  "real usage API authorizes %s account independently of %s sandbox visibility",
  async (scope, visibility, peerAllowed) => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      await db.query("insert into auth.users(id) values($1),($2),($3)", [OWNER, PEER, ADMIN]);
      await db.query("insert into orgs(id,name) values($1,'Usage')", [ORG]);
      await db.query(
        "insert into members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'member'),($1,$4,'admin')",
        [ORG, OWNER, PEER, ADMIN],
      );
      const authStore = createMemoryAuthStore();
      const tokens = new Map<string, string>();
      for (const id of [OWNER, PEER]) {
        authStore.addMembership(id, { orgId: ORG, name: "Usage", role: id === OWNER ? "admin" : "member" });
        const token = generateToken("service");
        await authStore.insertToken("service", {
          userId: id,
          orgId: ORG,
          hash: await sha256Hex(token),
          label: "usage-test",
          createdAt: new Date().toISOString(),
        });
        tokens.set(id, token);
      }
      const time = Date.parse("2026-11-09T12:00:00Z");
      const boat = fakeBoat();
      let reads = 0;
      boat.provider.events = async () => {
        reads++;
        return {
          hasMore: false,
          cursor: "quota",
          events: [
            {
              id: "limits",
              at: time,
              kind: "other",
              type: "account/rateLimits/updated",
              data: {
                rateLimits: { primary: { usedPercent: 25, resetsAt: null } },
                private: "never-return-native-envelope",
              },
            },
          ],
        };
      };
      const options: ControlOptions = {
        authStore,
        store: createSqlVaultStore(db),
        encryptionKey: KEY,
        supabase: { supabaseUrl: "https://unused.example", anonKey: "unused" },
        modelUsage: createModelUsageApi(db, () => new Date(time)),
        logs: async () => ({ provider: boat.provider, providerSandboxId: "native" }),
      };
      const auth = productionAuthIo(
        { out: () => {}, err: () => {} },
        { ARMADA_URL: "https://armada.example", ARMADA_TOKEN: tokens.get(OWNER) },
      );
      auth.fetch = (async (input, init) =>
        (await handleControlRequest(new Request(String(input), init), options)) ??
        new Response(null, { status: 404 })) as typeof fetch;
      await credsCommand(["set", "codex-auth", "--name", "Native", ...(scope === "org" ? ["--org", ORG] : [])], {
        auth,
        readFile: async () => "",
        readStdin: async () =>
          JSON.stringify({
            tokens: {
              access_token: "synthetic-access",
              refresh_token: "synthetic-refresh",
              account_id: "native-account",
            },
          }),
      });
      const account = (
        await db.query<{ id: string; version: number }>("select id,version from credentials where kind='codex_auth'")
      ).rows[0];
      if (!account) throw Error("Native import did not create an account");
      await db.query(
        "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'g','org',$4::jsonb)",
        [
          GOLDEN,
          ORG,
          OWNER,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web", branch: "main", dir: "web" }], init: [] }),
        ],
      );
      await db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,
      visibility,credential_id,credential_version) values($1,$2,$3,$4,'codex','ready','native','native',$5,$6,$7)`,
        [SANDBOX, ORG, OWNER, GOLDEN, visibility, account.id, account.version],
      );
      const request = async (id: string, withSandbox = true) => {
        const response = await handleControlRequest(
          new Request("https://armada.example/api/v1/creds/accounts/usage", {
            method: "POST",
            headers: { authorization: `Bearer ${tokens.get(id)}` },
            body: JSON.stringify({ id: account.id, ...(withSandbox ? { sandboxId: SANDBOX } : {}) }),
          }),
          options,
        );
        if (!response) throw Error("Missing usage route");
        return response;
      };
      const owner = await request(OWNER);
      expect(owner.status).toBe(200);
      expect(await owner.json()).toMatchObject({
        accountId: account.id,
        status: "fresh",
        windows: [{ usedPercent: 25 }],
      });
      expect((await request(OWNER, false)).status).toBe(200);
      const peer = await request(PEER);
      expect(peer.status).toBe(peerAllowed ? 200 : 404);
      expect(await peer.text()).not.toContain("never-return-native-envelope");
      const before = reads;
      await db.query("delete from members where org_id=$1 and user_id=$2", [ORG, OWNER]);
      expect((await request(OWNER)).status).toBe(404);
      expect(reads).toBe(before);
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [ORG, OWNER]);
      await db.query("update credentials set value_enc=$2 where id=$1", [
        account.id,
        await encryptSecret("synthetic-replacement", KEY),
      ]);
      expect((await request(OWNER)).status).toBe(404); // No fallback from the sandbox's old version.
      const accountOnly = await request(OWNER, false);
      expect(accountOnly.status).toBe(200);
      expect(await accountOnly.json()).toMatchObject({
        accountId: account.id,
        version: 2,
        status: "unavailable",
        observedAt: null,
        windows: [],
      });
      expect(reads).toBe(before);
    } finally {
      await db.close();
    }
  },
);
