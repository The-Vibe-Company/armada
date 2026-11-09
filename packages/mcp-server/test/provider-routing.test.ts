import { afterEach, describe, expect, test } from "bun:test";
import { encryptSecret, type ModalBinding, type ModalTokenPair, type Provider } from "@armada/core";
import { call, ENCRYPTION_KEY, fakeBoat, harness, type TestServer } from "./support.ts";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const BINDING: ModalBinding = { workspace: "ws-acme", environment: "main", appId: "ap-0123456789abcdef" };
const PAIR = { token_id: "ak-orgtoken0001", token_secret: "as-orgsecret0001" };
const ROTATED = { token_id: "ak-orgtoken0002", token_secret: "as-orgsecret0002" };

/** A Modal golden named like the Boat org golden 'shared', written as the server would (service role). */
async function seedModal(target: TestServer) {
  const { db, people } = target;
  await db.query(
    `insert into goldens (org_id, name, visibility, owner_id, provider, provider_snapshot_id, modal_workspace,
       modal_environment, modal_app_id, config)
     values ($1, 'shared', 'org', $2, 'modal', 'im-modal-1', $3, $4, $5, $6::jsonb)`,
    [
      people.org,
      people.admin,
      BINDING.workspace,
      BINDING.environment,
      BINDING.appId,
      JSON.stringify({ repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }], init: [] }),
    ],
  );
  await setOrgModalPair(target, PAIR);
}

async function setOrgModalPair(target: TestServer, pair: typeof PAIR) {
  await target.db.query(
    `insert into credentials (scope, owner_id, kind, value_enc) values ('org', $1, 'modal', $2)
     on conflict (scope, owner_id, kind) where kind in ('boat','modal') do update set value_enc = excluded.value_enc`,
    [target.people.org, await encryptSecret(JSON.stringify(pair), ENCRYPTION_KEY)],
  );
}

describe("provider routing", () => {
  test("a same-name Modal golden is listed apart, named explicitly, and never launched on Boat", async () => {
    server = await harness();
    await seedModal(server);
    const mcp = await server.client(await server.token(server.people.member));

    const listed = await call(mcp, "golden_list");
    const shared = (listed.data.goldens as Record<string, unknown>[]).filter((golden) => golden.name === "shared");
    expect(
      shared.map(({ provider, boatSnapshotId, providerSnapshotId, modal }) => ({
        provider,
        boatSnapshotId: boatSnapshotId === null ? null : "set",
        providerSnapshotId: providerSnapshotId === null ? null : "set",
        modal,
      })),
    ).toEqual([
      { provider: "boat", boatSnapshotId: "set", providerSnapshotId: "set", modal: null },
      { provider: "modal", boatSnapshotId: null, providerSnapshotId: "set", modal: BINDING },
    ]);
    expect(listed.text).not.toContain(PAIR.token_secret);

    const ambiguous = await call(mcp, "launch", { golden: "shared", harness: "claude" });
    expect(ambiguous.text).toContain("exists on boat and modal");
    const unconfigured = await call(mcp, "launch", { golden: "shared", provider: "modal", harness: "claude" });
    expect(unconfigured.isError).toBe(true);
    expect(unconfigured.text).toContain("error code: provider_not_configured");
    expect(server.boat.forks).toEqual([]);

    const onBoat = await call(mcp, "launch", { golden: "shared", provider: "boat", harness: "claude" });
    expect(onBoat.data).toMatchObject({ provider: "boat", providerSandboxId: "bx_1", boatId: "bx_1" });
    expect(server.boat.forks).toHaveLength(1);
  });

  test("a Modal sandbox runs on the pinned App with the org's token pair, which a rotation never redirects", async () => {
    const modal = fakeBoat();
    const calls: { tokens: ModalTokenPair; binding: ModalBinding }[] = [];
    server = await harness({
      modalProviderFor: (tokens, binding) => {
        calls.push({ tokens, binding });
        return { ...modal.provider, id: "modal" } as Provider;
      },
    });
    await seedModal(server);
    const mcp = await server.client(await server.token(server.people.member));

    const tooLong = await call(mcp, "launch", {
      golden: "shared",
      provider: "modal",
      harness: "claude",
      ttl_seconds: 172_800,
    });
    expect(tooLong.text).toContain("24 hours on modal");
    expect(modal.forks).toEqual([]);

    await server.db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'modal',$2)", [
      server.people.member,
      await encryptSecret(
        JSON.stringify({ token_id: "ak-personal0001", token_secret: "as-personal0001" }),
        ENCRYPTION_KEY,
      ),
    ]);
    const launched = await call(mcp, "launch", {
      golden: "shared",
      provider: "modal",
      harness: "claude",
      visibility: "private",
    });
    expect(launched.data.visibility).toBe("org");
    const source = (
      await server.db.query<{ source_golden_visibility: string }>(
        "select source_golden_visibility from sandboxes where id=$1",
        [launched.data.id],
      )
    ).rows[0];
    expect(source?.source_golden_visibility).toBe("org");
    await expect(
      server.db.query("update sandboxes set source_golden_visibility='private' where id=$1", [launched.data.id]),
    ).rejects.toThrow(/immutable/);
    const otherMember = await server.client(await server.token(server.people.owner));
    const forbidden = await call(otherMember, "send", { id: launched.data.id, prompt: "impersonate" });
    expect(forbidden.isError).toBe(true);
    expect(launched.data).toMatchObject({ provider: "modal", providerSandboxId: "bx_1", boatId: null });
    expect(modal.forks[0]).toMatchObject({ from: "im-modal-1", noEnv: true });
    expect(JSON.stringify(modal.forks[0]?.env)).not.toContain(PAIR.token_secret);
    expect(JSON.stringify(modal.forks[0]?.env)).not.toContain(PAIR.token_id);
    expect(server.boat.forks).toEqual([]);

    await setOrgModalPair(server, ROTATED);
    await call(mcp, "send", { id: launched.data.id, prompt: "next" });
    expect(modal.prompts.map((prompt) => prompt.text)).toEqual(["next"]);
    // Every call is pinned to the golden's App; only the token follows the rotation.
    expect(calls.every(({ binding }) => JSON.stringify(binding) === JSON.stringify(BINDING))).toBe(true);
    expect(calls.map(({ tokens }) => tokens.tokenId)).toEqual([PAIR.token_id, PAIR.token_id, ROTATED.token_id]);
    expect(server.boat.prompts).toEqual([]);
  });
});
