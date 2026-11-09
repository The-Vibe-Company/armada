/** OPT-IN BILLABLE. Receive explicit management/model configuration via PRIVATE stdin only.
 * The coordinator must expose listenPort with HTTPS ingress at ingestUrl before invoking.
 * No profile/environment/credential-file reads. Never print configuration, SDK causes or tokens.
 */

import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ModalClient } from "modal";
import { applyMigrations } from "../../../scripts/db/apply.ts";
import {
  type ComposedModalOptions,
  createComposedModalProvider,
  type GoldenSshRecipe,
  type HarnessEnvironment,
  loadRunnerArtifact,
  type ModalManagementProvenance,
  type ModalResourceReceipt,
  mergeModalResourceReceipts,
  runModalConformance,
  type Scope,
} from "../src/index.ts";
import { appJournal, cliAppAdapter, createOwnedApp, finalizeOwnedApp } from "./conformance-app.ts";

interface Input {
  tokenId?: string;
  tokenSecret?: string;
  /** Explicit operator opt-in to public SDK profile loading, never a manual credential-file read. */
  operatorProfile?: boolean;
  scope: Scope;
  /** Trusted operator-selected provenance, independent of this fixture's private/org access scope. */
  managementAuthority?: ModalManagementProvenance;
  appName?: never;
  /** New, exclusive local directory for durable non-secret run evidence. */
  receiptDirectory: string;
  artifact: Omit<ComposedModalOptions["artifact"], "bundle" | "sha256"> & { dist: string };
  ingestUrl: string;
  listenPort: number;
  models: boolean;
  /** Current production core generates these scripts; credentials remain private stdin only. */
  goldenRecipe?: GoldenSshRecipe & { scanCommand: string };
  harness: HarnessEnvironment;
}
async function main() {
  let input: Input;
  try {
    input = JSON.parse(await Bun.stdin.text()) as Input;
  } catch {
    console.error("Invalid private conformance configuration.");
    process.exit(2);
  }
  if (!input.tokenId || !input.tokenSecret || input.operatorProfile || input.appName || input.managementAuthority) {
    console.error("Owned conformance requires explicit private tokens; borrowed Apps/profiles/authority are refused.");
    process.exit(2);
  }
  const save = await appJournal(input.receiptDirectory);
  let client: ModalClient | undefined;
  let owned: Awaited<ReturnType<typeof createOwnedApp>> | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  let closeProvider: (() => void) | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;
  try {
    const sdk = new ModalClient({ tokenId: input.tokenId, tokenSecret: input.tokenSecret });
    client = sdk;
    const adapter = cliAppAdapter(
      input.tokenId,
      input.tokenSecret,
      async (name, environment) => (await sdk.apps.fromName(name, { environment, createIfMissing: true })).appId,
    );
    owned = await createOwnedApp(adapter, input.scope.binding.environment, save);
    input.scope = { ...input.scope, binding: { ...input.scope.binding, appId: owned.appId as string } };
    const db = new PGlite(join(input.receiptDirectory, "registry"));
    closeDatabase = () => db.close();
    await db.waitReady;
    await applyMigrations(db);
    await db.query("insert into auth.users(id) values($1)", [input.scope.userId]);
    await db.query("insert into orgs(id,name) values($1,'Modal conformance fixture')", [input.scope.orgId]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [
      input.scope.orgId,
      input.scope.userId,
    ]);
    const bytes = await loadRunnerArtifact(input.artifact.dist);

    const { provider, ingest, close } = await createComposedModalProvider({
      scope: input.scope,
      ...(input.managementAuthority ? { managementAuthority: input.managementAuthority } : {}),
      appName: owned.name,
      ingestUrl: input.ingestUrl,
      ...(client ? { client } : {}),
      ...(input.tokenId !== undefined ? { tokenId: input.tokenId } : {}),
      ...(input.tokenSecret !== undefined ? { tokenSecret: input.tokenSecret } : {}),
      sql: db,
      signingKey: crypto.getRandomValues(new Uint8Array(32)),
      artifact: { ...input.artifact, ...bytes },
      resolveHarnessEnvironment: async () => input.harness,
    });
    closeProvider = close;
    const path = new URL(input.ingestUrl).pathname;
    const server = Bun.serve({
      hostname: "0.0.0.0",
      port: input.listenPort,
      fetch: (request) =>
        new URL(request.url).pathname === path ? ingest(request) : new Response(null, { status: 404 }),
    });
    stopServer = () => server.stop(true);
    const receipts: ModalResourceReceipt[] = [];
    const remember = async (receipt: ModalResourceReceipt) => {
      receipts.push(receipt);
      await save({ app: owned, resource: receipt });
    };
    let completed = false;
    try {
      const result = await runModalConformance(provider, {
        models: input.models,
        ...(input.goldenRecipe ? { goldenRecipe: input.goldenRecipe } : {}),
        onReceipt: remember,
      });
      completed = result.preservedSandboxIds.length === 0;
      console.log(
        JSON.stringify({
          ...result,
          resources: mergeModalResourceReceipts([...receipts, ...(await provider.resourceReceipts())]),
        }),
      );
    } catch {
      console.log(
        JSON.stringify({
          status: "conformance_failed",
          resources: mergeModalResourceReceipts([...receipts, ...(await provider.resourceReceipts().catch(() => []))]),
        }),
      );
      process.exitCode = 1;
    } finally {
      try {
        // Read failures are not empty inventories. Historical receipts remain in the journal;
        // only a fresh durable read authorizes finalization after successful conformance cleanup.
        const resources = await provider.resourceReceipts();
        const images = await db.query("select name,record from public.modal_images");
        const proof = { complete: completed, resources, imageCount: images.rows.length };
        await save({
          app: owned,
          proof,
          observedResources: mergeModalResourceReceipts([...receipts, ...resources]),
          images: images.rows,
        });
        await finalizeOwnedApp(adapter, owned, proof, save);
      } catch {
        process.exitCode = 1;
        await save({ app: owned, status: "cleanup_incomplete" });
      }
      console.log(JSON.stringify({ app: owned, status: owned.finalization }));
    }
  } finally {
    try {
      // Preserve any pending creation journal; never adopt, retry or stop its App here.
      if (owned) await save({ app: owned, status: owned.finalization });
    } finally {
      try {
        try {
          await stopServer?.();
        } finally {
          try {
            closeProvider?.();
          } finally {
            await closeDatabase?.();
          }
        }
      } finally {
        client?.close();
      }
    }
  }
}

if (import.meta.main) {
  await main().catch(() => {
    console.error("Conformance incomplete; retain the fixture journal for recovery.");
    process.exitCode = 1;
  });
}
