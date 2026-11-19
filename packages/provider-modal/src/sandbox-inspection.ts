import type { Provider, SandboxInfo, VmResourceReading } from "@armada/core";
import type { ModalClient } from "modal";
import { matchesManagementAuthority } from "./authority.ts";
import { refusal } from "./errors.ts";
import type {
  Machine,
  ModalManagementProvenance,
  ModalResourceReceipt,
  ModalStore,
  RunnerTransport,
  Scope,
} from "./ports.ts";
import { scopeKey } from "./store.ts";

interface SandboxInspectionOptions {
  store: ModalStore;
  client: Pick<ModalClient, "sandboxes">;
  runner: RunnerTransport;
  bound(): Promise<unknown>;
  assertMachineSource(row: Machine): void;
  managementAuthority: ModalManagementProvenance;
  sourceScope: Scope;
  scope: Scope;
  appName: string;
  storedReads: boolean;
}

export function createSandboxInspection({
  store,
  client,
  runner,
  bound,
  assertMachineSource,
  managementAuthority,
  sourceScope,
  scope,
  appName,
  storedReads,
}: SandboxInspectionOptions) {
  function sandboxInfo(row: Machine) {
    const { physicalGeneration: _ignored, ...info } = row.info;
    return { ...info, ...(row.physicalId ? { physicalGeneration: String(row.generation) } : {}) };
  }
  async function resourceReceipt(observed: Machine) {
    const durable = await store.get(observed.info.id).catch(() => undefined);
    const row = durable ?? observed;
    const images = await store.images(row.info.id).catch(() => []);
    const snapshots = [
      ...(row.snapshotImages ?? []),
      ...(observed.snapshotImages ?? []),
      ...images.flatMap((x) => (x.imageId ? [{ name: x.info.name, imageId: x.imageId }] : [])),
    ];
    const snapshotImages = [
      ...new Map(snapshots.map((x) => [`${x.name}:${x.imageId}`, { name: x.name, imageId: x.imageId }])).values(),
    ];
    const physicalId = row.physicalId ?? observed.physicalId,
      imageId = row.imageId ?? observed.imageId;
    return {
      sandboxId: row.info.id,
      phase: row.phase,
      observedPhase: observed.phase,
      registryConfirmed: !!durable,
      generation: row.generation,
      physicalName: row.physicalName,
      ...(physicalId ? { physicalId } : {}),
      ...(imageId ? { imageId } : {}),
      recoveryImageIds: [
        ...new Set([
          ...(row.retainedRecoveryIds ?? []),
          ...(observed.retainedRecoveryIds ?? []),
          ...(row.recoveryImageId ? [row.recoveryImageId] : []),
          ...(observed.recoveryImageId ? [observed.recoveryImageId] : []),
        ]),
      ],
      snapshotImages,
      ...(row.sourceImage ? { sourceImage: { ...row.sourceImage } } : {}),
      ...(row.managementAuthority ? { managementAuthority: { ...row.managementAuthority } } : {}),
      binding: { ...scope.binding },
      appName,
    } satisfies ModalResourceReceipt;
  }
  const get: Provider["get"] = async (id) => {
    if (!storedReads) await bound();
    const row = await store.get(id);
    assertMachineSource(row);
    if (row.phase === "deleted") throw refusal("not_found", "Sandbox was deleted.");
    let exited = false;
    if (row.phase === "active" && !storedReads) {
      if (!row.physicalId) throw refusal("sandbox_not_ready", "No current physical machine.");
      exited = (await (await client.sandboxes.fromId(row.physicalId)).poll()) !== null;
    }
    if (exited)
      return {
        ...sandboxInfo(row),
        state: "failed",
        providerState: "exited",
        physicalExitConfirmed: true,
        error: "Physical machine exited without a new verified checkpoint.",
      };
    return { ...sandboxInfo(row), providerState: row.phase };
  };
  const inspection = {
    async observeResources(id) {
      await bound();
      return store.lease(id, async (row) => {
        assertMachineSource(row);
        const evidence = row.runtimeEvidence;
        if (
          row.golden ||
          row.commonRuntime ||
          row.phase !== "active" ||
          !row.physicalId ||
          row.runtimePolicy !== "explicit-vm-v1" ||
          evidence?.version !== 1 ||
          evidence.runtime !== "vm" ||
          evidence.generation !== row.generation ||
          evidence.physicalId !== row.physicalId
        )
          return null;
        const reading = await runner.call<VmResourceReading | null>(row, "resourceObservation", {});
        if (!reading) return null;
        return {
          version: 1 as const,
          providerSandboxId: id,
          physicalId: row.physicalId,
          generation: String(row.generation),
          scope: "dedicated-vm" as const,
          runtimeProvenance: "modal-explicit-vm-v1" as const,
          reading,
          limitations: ["sampled-memory-not-peak", "hypervisor-throttling-unavailable"] as const,
        };
      });
    },
    get,
    async list(r = {}) {
      await bound();
      const limit = r.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw refusal("invalid_request", "Invalid page limit.");
      const candidates = (await store.list())
        .filter(
          (x) =>
            x.phase !== "deleted" &&
            matchesManagementAuthority(x.managementAuthority, managementAuthority) &&
            (x.sourceImage?.scopeKey ?? scopeKey(scope)) === scopeKey(sourceScope) &&
            (!r.cursor || x.info.id > r.cursor) &&
            Object.entries(r.labels ?? {}).every(([k, v]) => x.info.labels[k] === v),
        )
        .sort((a, b) => a.info.id.localeCompare(b.info.id));
      const rows: SandboxInfo[] = [];
      for (let offset = 0; offset < candidates.length; offset += 8) {
        const batch = await Promise.all(candidates.slice(offset, offset + 8).map((x) => get(x.info.id)));
        rows.push(...batch.filter((x) => !r.states || r.states.includes(x.state)));
        if (rows.length > limit) break;
      }
      return { items: rows.slice(0, limit), cursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null };
    },
    async resourceReceipts() {
      const rows = (await store.list()).filter(
        (row) =>
          matchesManagementAuthority(row.managementAuthority, managementAuthority) &&
          (row.sourceImage?.scopeKey ?? scopeKey(scope)) === scopeKey(sourceScope),
      );
      return Promise.all(rows.map(resourceReceipt));
    },
  } satisfies Pick<Provider, "observeResources" | "get" | "list"> & {
    resourceReceipts(): Promise<ModalResourceReceipt[]>;
  };
  return { sandboxInfo, resourceReceipt, inspection };
}
