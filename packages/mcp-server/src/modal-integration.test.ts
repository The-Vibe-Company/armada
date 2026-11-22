import { expect, test } from "bun:test";
import { encryptSecret, type ProviderTarget } from "@armada/core/server";
import { createModalIntegration } from "./modal-integration.ts";

test("the server's stored Modal provider refuses an unenrolled compute record", async () => {
  const encryptionKey = Buffer.alloc(32).toString("base64");
  const valueEnc = await encryptSecret(
    ["ak", "as"].map((prefix) => [prefix, "fixture0"].join("-")).join(" "),
    encryptionKey,
  );
  const caller = { userId: "owner" };
  const target: ProviderTarget = {
    provider: "modal",
    orgId: "org",
    visibility: "org",
    modal: { appId: "app", workspace: "app:app", environment: "main" },
  };
  const modal = createModalIntegration({
    encryptionKey,
    publicUrl: "https://armada.example",
    vault: {
      async credentials() {
        return [{ kind: "modal", status: "active", valueEnc }];
      },
      async orgBoatKey() {
        return null;
      },
    },
    sql: {
      async query<T>(statement: string) {
        let row: unknown;
        if (statement.includes("from public.modal_server_apps")) {
          row = { app_name: "armada-org", authority_scope: "org", authority_owner_id: target.orgId };
        } else if (statement.includes("from public.members")) {
          row = {};
        } else if (statement.includes("from public.modal_machines")) {
          row = { record: { info: { id: "machine", state: "ready" }, phase: "active", generation: 1 } };
        } else {
          throw new Error("Unexpected SQL during a stored Modal read.");
        }
        return { rows: [row as T], rowCount: 1 };
      },
    },
  });
  const provider = await modal.launchProviderFor(target, caller);
  await expect(provider.get("machine")).rejects.toThrow("This Modal connection requires Armada runtime enrolment.");
});
