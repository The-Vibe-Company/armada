import { expect, test } from "bun:test";
import { type GoldenRecord, parseGoldenConfig } from "@armada/core";
import { encryptSecret } from "@armada/core/server";
import { prepareGoldenLaunchAccount } from "../src/launch-account-admission.ts";
import { launchCredentials } from "../src/launch-credentials.ts";

test("dispatch reauthorizes the selected account revision after provider setup", async () => {
  const key = Buffer.alloc(32, 23).toString("base64");
  const actor = { userId: "owner", orgId: "org", role: "member" as const };
  const account = {
    id: "account",
    kind: "openai" as const,
    status: "active",
    version: 1,
    valueEnc: await encryptSecret("fixture_key", key),
  };
  const credentials = launchCredentials({ credentials: async () => [account], orgBoatKey: async () => null }, key);
  const golden = {
    provider: "boat",
    id: "snapshot",
    name: "web",
    orgId: actor.orgId,
    ownerId: actor.userId,
    visibility: "org",
    modal: null,
    providerSnapshotId: "image",
    providerSandboxId: "builder",
    config: parseGoldenConfig({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }] }),
    createdAt: "",
  } satisfies GoldenRecord;
  const prepared = await prepareGoldenLaunchAccount(actor, golden, { harness: "codex" }, credentials, {
    boatRuntime: {
      async start() {
        throw Error("The test exercises account admission only");
      },
    },
  });

  account.version++;
  await expect(prepared.credentials.resolve(actor, "codex")).rejects.toMatchObject({ code: "credential_refused" });
});
