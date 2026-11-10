import { expect, spyOn, test } from "bun:test";
import {
  createSqlSandboxStore,
  createSqlVaultStore,
  encryptSecret,
  type Provider,
  resolveGitHubAccess,
} from "@armada/core/server";
import { createLegacyGitHubPreparation, refreshLegacyGitHub } from "../src/github-legacy.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

test("opted-in next-prompt preparation repairs siblings and never blocks prompts on install failure", async () => {
  const { db, people } = await database();
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='mine'")).rows[0]!;
    const sandboxes = [];
    for (let i = 0; i < 12; i++)
      sandboxes.push(
        await createSqlSandboxStore(db).insert({
          id: crypto.randomUUID(),
          provider: "boat",
          providerSandboxId: `bx_legacy_${i}`,
          goldenId: golden.id,
          orgId: people.org,
          ownerId: people.owner,
          visibility: "private",
          harness: "claude",
          status: "ready",
          model: "claude-sonnet-4-6",
          reasoningEffort: "high",
        }),
      );
    let now = new Date();
    const expiry = new Date(now.getTime() + 61 * 60_000);
    let outage = false;
    let valid = "old-access",
      rotations = 0;
    await db.query(
      `insert into github_connections(user_id,github_id,login,refresh_token_enc,access_token_enc,access_expires_at)
      values($1,7,'owner',$2,$3,$4)`,
      [
        people.owner,
        await encryptSecret("old-refresh", ENCRYPTION_KEY),
        await encryptSecret(valid, ENCRYPTION_KEY),
        expiry,
      ],
    );
    const fetcher = (async (input, init) => {
      if (outage) return Response.json({ message: "Unavailable" }, { status: 503 });
      if (String(input).includes("/login/oauth/access_token")) {
        rotations++;
        valid = "new-access";
        return Response.json({ access_token: valid, refresh_token: "new-refresh", expires_in: 28_800 });
      }
      return new Headers(init?.headers).get("authorization") === `Bearer ${valid}`
        ? Response.json({ id: 7, login: "owner", name: null })
        : Response.json({ message: "Bad credentials" }, { status: 401 });
    }) as typeof fetch;
    const github = {
      store: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      app: { clientId: "fixture", clientSecret: "fixture" },
      now: () => now,
      fetch: fetcher,
    };
    const hydrated = new Map<string, string>();
    const provider = { id: "boat" } as Provider;
    const prepare = createLegacyGitHubPreparation({
      sql: db,
      github,
      hydrate: async (_provider, id, token) => {
        hydrated.set(id, token);
      },
    });
    // Existing workers take a healthy token even inside the new-launch threshold; preparing or
    // manually repairing one worker must not gratuitously invalidate its siblings.
    await Promise.all(sandboxes.map((sandbox) => prepare(provider, sandbox.id)));
    expect(rotations).toBe(0);
    now = new Date(now.getTime() + 2 * 60_000);
    await prepare(provider, sandboxes[0]!.id);
    expect(rotations).toBe(0);
    expect(await resolveGitHubAccess({ ...github, minimumLifetimeMs: 60 * 60_000 }, people.owner)).toMatchObject({
      token: "new-access",
    });
    expect(rotations).toBe(1);
    // This callback is the same preparation wired after the production prompt authorization hook.
    await Promise.all(sandboxes.map((sandbox) => prepare(provider, sandbox.id)));
    for (const sandbox of sandboxes) {
      expect(
        (
          await fetcher("https://api.github.com/user", {
            headers: { authorization: `Bearer ${hydrated.get(sandbox.providerSandboxId)}` },
          })
        ).status,
      ).toBe(200);
    }
    expect(rotations).toBe(1);
    // The automatic before-prompt callback must complete even if SSH/sudo/install refuses.
    // Explicit repair uses the same failure but remains strict; logs contain only a fixed event.
    const installError = new Error(`private transport detail ${valid}`);
    const failedHydrate = async () => {
      throw installError;
    };
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bestEffort = createLegacyGitHubPreparation({ sql: db, github, hydrate: failedHydrate });
      await expect(bestEffort(provider, sandboxes[0]!.id)).resolves.toBeUndefined();
      expect(log.mock.calls).toEqual([
        [JSON.stringify({ event: "github_legacy_hydration_failed", sandboxId: "bx_legacy_0" })],
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(valid);
      expect(JSON.stringify(log.mock.calls)).not.toContain(installError.message);
      await expect(refreshLegacyGitHub(provider, "bx_legacy_0", people.owner, github, failedHydrate)).rejects.toBe(
        installError,
      );
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }

    // Optional GitHub failure must not prevent dispatch of local/model work; explicit repair
    // remains strict. Neither path may hydrate unavailable or revoked access material.
    hydrated.clear();
    outage = true;
    await prepare(provider, sandboxes[0]!.id);
    await expect(
      refreshLegacyGitHub(provider, "bx_legacy_0", people.owner, github, async () => {
        throw Error("No hydration");
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(hydrated.size).toBe(0);
    outage = false;
    await db.query("update github_connections set revoked_at=now() where user_id=$1", [people.owner]);
    await prepare(provider, sandboxes[0]!.id);
    await expect(
      refreshLegacyGitHub(provider, "bx_legacy_0", people.owner, github, async () => {
        throw Error("No hydration");
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(hydrated.size).toBe(0);
    await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
    await expect(prepare(provider, sandboxes[0]!.id)).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    await db.close();
  }
});
