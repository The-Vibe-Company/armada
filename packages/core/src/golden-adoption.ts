import { assertGoldenMutation, type GoldenActor, type GoldenRecord } from "./golden.ts";
import { GoldenError } from "./golden-config.ts";
import type { Sql } from "./golden-store.ts";
import type { Provider } from "./provider.ts";

export type GoldenAdoption = (
  provider: Provider,
  actor: GoldenActor,
  golden: GoldenRecord,
  confirmation?: string,
) => Promise<{ goldenId: string; dryRun: boolean; confirmation: string }>;

/** No remote mutations. Both phases independently verify current account and snapshot provenance. */
export function createGoldenAdoption(sql: Sql): GoldenAdoption {
  return async (provider, actor, golden, confirmation) => {
    assertGoldenMutation(actor, golden);
    const unavailable = () => new GoldenError("conflict", "Canonical adoption unavailable. No golden was changed.");
    if (provider.id !== "boat" || golden.provider !== "boat" || !golden.providerSnapshotId || !golden.providerSandboxId)
      throw unavailable();
    try {
      const identity = await provider.backendIdentity?.();
      if (!identity?.id) throw unavailable();
      const snapshot = await provider.getSnapshot(golden.providerSnapshotId);
      if (
        snapshot.status !== "ready" ||
        snapshot.name !== golden.providerSnapshotId ||
        snapshot.sourceSandboxId !== golden.providerSandboxId
      )
        throw unavailable();
      // Confirm the source is accessible with the same verified account, not just a guessed snapshot name.
      const source = await provider.get(golden.providerSandboxId);
      if (source.id !== golden.providerSandboxId) throw unavailable();
      const result = await sql.query<{ receipt: string }>(
        "select public.adopt_canonical_boat_golden($1::uuid,$2::uuid,$3,$4,$5,$6::uuid) as receipt",
        [
          actor.userId,
          golden.id,
          identity.id,
          golden.providerSnapshotId,
          golden.providerSandboxId,
          confirmation ?? null,
        ],
      );
      const receipt = result.rows[0]?.receipt;
      if (!receipt) throw unavailable();
      return { goldenId: golden.id, dryRun: confirmation === undefined, confirmation: receipt };
    } catch {
      // Never propagate provider account identifiers or SQL uniqueness details across ACLs.
      throw unavailable();
    }
  };
}
