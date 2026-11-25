import { createHash, randomUUID } from "node:crypto";
import type { CreateGoldenRequest, Provider, SandboxInfo } from "@armada/core";
import { ProviderError } from "@armada/core";
import type { boundModalApp } from "./client.ts";
import { ModalOperationError, refusal } from "./errors.ts";
import type { createPhysicalLifecycle } from "./physical-lifecycle.ts";
import type { Machine, ModalManagementProvenance, ModalResourceReceipt, ModalStore, Scope } from "./ports.ts";

export function createLaunchLifecycle({
  store,
  assertGoldenScope,
  scope,
  managementAuthority,
  bound,
  assertMachineSource,
  create,
  sandboxInfo,
  resourceReceipt,
}: {
  store: ModalStore;
  assertGoldenScope(): void;
  scope: Scope;
  managementAuthority: ModalManagementProvenance;
  bound: () => ReturnType<typeof boundModalApp>;
  assertMachineSource(row: Machine): void;
  create: ReturnType<typeof createPhysicalLifecycle>["create"];
  sandboxInfo(row: Machine): SandboxInfo;
  resourceReceipt(row: Machine): Promise<ModalResourceReceipt>;
}) {
  async function createGolden(request: CreateGoldenRequest) {
    assertGoldenScope();
    await bound();
    const ttl = request.ttlSeconds ?? 3600;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400)
      throw refusal("invalid_request", "Modal machine TTL must be 1–86400 seconds (maximum 24 hours).");
    const key = request.idempotencyKey ?? randomUUID();
    const id = `modal_${randomUUID()}`;
    const row = await store.reserve(key, {
      info: {
        id,
        name: request.name ?? id,
        state: "starting",
        providerState: "reserved",
        labels: request.labels ?? {},
        createdAt: new Date(),
      },
      generation: 1,
      launchUserId: scope.userId,
      managementAuthority: { ...managementAuthority },
      phase: "reserved",
      golden: true,
      ttlSeconds: ttl,
      physicalName: `armada-${createHash("sha256").update(id).digest("hex").slice(0, 32)}-1`,
    });
    const needsBoot = (row: Machine) => {
      if (!row.golden || row.commonRuntime || row.size !== undefined || row.imageId !== undefined || row.sourceImage)
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
        return create(current, save);
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

  return { createGolden } satisfies Pick<Provider, "createGolden">;
}
