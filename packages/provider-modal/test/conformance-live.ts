/** OPT-IN BILLABLE. Receive explicit management/model configuration via PRIVATE stdin only.
 * The coordinator must expose listenPort with HTTPS ingress at ingestUrl before invoking.
 * No profile/environment/credential-file reads. Never print configuration, SDK causes or tokens.
 */
import { ModalClient } from "modal";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
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

interface Input {
  tokenId?: string;
  tokenSecret?: string;
  /** Explicit operator opt-in to public SDK profile loading, never a manual credential-file read. */
  operatorProfile?: boolean;
  scope: Scope;
  /** Trusted operator-selected provenance, independent of this fixture's private/org access scope. */
  managementAuthority?: ModalManagementProvenance;
  appName: string;
  artifact: Omit<ComposedModalOptions["artifact"], "bundle" | "sha256"> & { dist: string };
  ingestUrl: string;
  listenPort: number;
  models: boolean;
  /** Current production core generates these scripts; credentials remain private stdin only. */
  goldenRecipe?: GoldenSshRecipe & { scanCommand: string };
  harness: HarnessEnvironment;
}
if (import.meta.main) {
  let input: Input;
  try {
    input = JSON.parse(await Bun.stdin.text()) as Input;
  } catch {
    console.error("Invalid private conformance configuration.");
    process.exit(2);
  }
  const db = await openDatabase();
  await applyMigrations(db);
  await db.query("insert into auth.users(id) values($1)", [input.scope.userId]);
  await db.query("insert into orgs(id,name) values($1,'Modal conformance fixture')", [input.scope.orgId]);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [
    input.scope.orgId,
    input.scope.userId,
  ]);
  const bytes = await loadRunnerArtifact(input.artifact.dist);
  const client = input.operatorProfile ? new ModalClient() : undefined;
  const { provider, ingest, close } = await createComposedModalProvider({
    scope: input.scope,
    ...(input.managementAuthority ? { managementAuthority: input.managementAuthority } : {}),
    appName: input.appName,
    ingestUrl: input.ingestUrl,
    ...(client ? { client } : {}),
    ...(input.tokenId !== undefined ? { tokenId: input.tokenId } : {}),
    ...(input.tokenSecret !== undefined ? { tokenSecret: input.tokenSecret } : {}),
    sql: db,
    signingKey: crypto.getRandomValues(new Uint8Array(32)),
    artifact: { ...input.artifact, ...bytes },
    resolveHarnessEnvironment: async () => input.harness,
  });
  const path = new URL(input.ingestUrl).pathname;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: input.listenPort,
    fetch: (request) =>
      new URL(request.url).pathname === path ? ingest(request) : new Response(null, { status: 404 }),
  });
  const receipts: ModalResourceReceipt[] = [];
  const remember = (receipt: ModalResourceReceipt) => {
    receipts.push(receipt);
  };
  try {
    console.log(
      JSON.stringify({
        ...(await runModalConformance(provider, {
          models: input.models,
          ...(input.goldenRecipe ? { goldenRecipe: input.goldenRecipe } : {}),
          onReceipt: remember,
        })),
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
    await server.stop(true);
    close();
    client?.close();
    await db.close();
  }
}
