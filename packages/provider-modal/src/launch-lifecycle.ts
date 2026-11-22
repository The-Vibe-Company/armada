import { createHash, randomUUID } from "node:crypto";
import type { CreateGoldenRequest, ForkRequest, Provider, SandboxInfo } from "@armada/core";
import { mapHarnesses, ProviderError, parseMachineSize, resolveModelChoice } from "@armada/core";
import type { boundModalApp } from "./client.ts";
import { ModalOperationError, refusal } from "./errors.ts";
import type { createPhysicalLifecycle } from "./physical-lifecycle.ts";
import type { Machine, ModalManagementProvenance, ModalResourceReceipt, ModalStore, Scope } from "./ports.ts";
import { scopeKey } from "./store.ts";

export function createLaunchLifecycle({
  store,
  source,
  scope,
  commonRuntime,
  managementAuthority,
  bound,
  assertAuthority,
  assertMachineSource,
  create,
  sandboxInfo,
  resourceReceipt,
}: {
  store: ModalStore;
  source: { scope: Scope; store: ModalStore };
  scope: Scope;
  commonRuntime: true | undefined;
  managementAuthority: ModalManagementProvenance;
  bound: () => ReturnType<typeof boundModalApp>;
  assertAuthority(record: { managementAuthority?: ModalManagementProvenance }): void;
  assertMachineSource(row: Machine): void;
  create: ReturnType<typeof createPhysicalLifecycle>["create"];
  sandboxInfo(row: Machine): SandboxInfo;
  resourceReceipt(row: Machine): Promise<ModalResourceReceipt>;
}) {
  async function launch(request: CreateGoldenRequest | ForkRequest, golden: boolean) {
    let size: Machine["size"];
    if ("size" in request && request.size !== undefined) {
      try {
        size = parseMachineSize(request.size);
      } catch {
        throw refusal("invalid_request", "Size must be small, medium, large or xlarge.");
      }
    }
    await bound();
    const ttl = request.ttlSeconds ?? 3600;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400)
      throw refusal("invalid_request", "Modal machine TTL must be 1–86400 seconds (maximum 24 hours).");
    let imageId: string | undefined;
    let sourceImage: Machine["sourceImage"];
    let sourceId: string | undefined;
    if ("from" in request) {
      const snapshot = await source.store.image(request.from);
      assertAuthority(snapshot);
      if (snapshot.info.status !== "ready" || !snapshot.imageId)
        throw refusal("sandbox_not_ready", "Snapshot is not ready.");
      const sourceRow = await source.store.get(snapshot.sourceId);
      if (sourceRow.commonRuntime) throw refusal("invalid_request", "Enrolled Modal forks are not enabled.");
      sourceId = snapshot.sourceId;
      imageId = snapshot.imageId;
      sourceImage = { scopeKey: scopeKey(source.scope), name: request.from, imageId };
    }
    const key = request.idempotencyKey ?? randomUUID();
    const id = `modal_${randomUUID()}`;
    const row = await store.reserve(
      key,
      {
        info: {
          id,
          name: request.name ?? id,
          state: "starting",
          providerState: "reserved",
          labels: request.labels ?? {},
          createdAt: new Date(),
        },
        generation: 1,
        ...(!golden && commonRuntime ? { commonRuntime: true as const } : {}),
        ...(!golden ? { runtimePolicy: "explicit-vm-v1" as const } : {}),
        launchUserId: scope.userId,
        managementAuthority: { ...managementAuthority },
        modelDefaults: mapHarnesses((_, harness) => resolveModelChoice(harness, {})),
        phase: "reserved",
        golden,
        ttlSeconds: ttl,
        ...(size === undefined ? {} : { size }),
        physicalName: `armada-${createHash("sha256").update(id).digest("hex").slice(0, 32)}-1`,
        ...(imageId ? { imageId } : {}),
        ...(sourceImage ? { sourceImage } : {}),
      },
      sourceId,
    );
    const needsBoot = (row: Machine) => {
      if (
        row.golden !== golden ||
        (!golden && row.generation !== 1) ||
        Boolean(row.commonRuntime) !== Boolean(!golden && commonRuntime) ||
        row.size !== size ||
        row.imageId !== imageId ||
        row.sourceImage?.scopeKey !== sourceImage?.scopeKey ||
        row.sourceImage?.name !== sourceImage?.name
      )
        throw refusal("conflict", "Idempotency key belongs to another launch or generation.");
      assertMachineSource(row);
      if (row.phase === "active" || row.phase === "stopped") return false;
      if (!["reserved", "creating", "booting"].includes(row.phase))
        throw refusal("conflict", "Launch is in a terminal or checkpoint phase.");
      return true;
    };
    let observed = row;
    try {
      if (!needsBoot(row)) return sandboxInfo(row);
      return await store.lease(row.info.id, async (current, save) => {
        observed = current;
        if (!needsBoot(current)) return sandboxInfo(current);
        return create(current, save, "env" in request ? (request.env ?? {}) : {});
      });
    } catch (error) {
      if (
        observed.phase === "deleted" &&
        !observed.physicalId &&
        error instanceof ProviderError &&
        error.providerCode === "modal_builder_image_failed"
      )
        throw error;
      throw new ModalOperationError(error, await resourceReceipt(observed));
    }
  }

  return {
    createGolden: (r) => {
      if (source.scope.visibility !== scope.visibility)
        throw refusal("forbidden", "Split source/target adapter is fork-only for golden creation.");
      return launch(r, true);
    },
    fork: (r) => launch(r, false),
  } satisfies Pick<Provider, "createGolden" | "fork">;
}
