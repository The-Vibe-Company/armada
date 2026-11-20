import { ProviderError, type ResumeStageObserver, type SandboxInfo } from "@armada/core";
import { SHARED_ARTIFACT_CACHE_PATH } from "@armada/core/server";
import { NotFoundError, type Sandbox } from "modal";
import type { boundModalApp, modalConnection } from "./client.ts";
import { modalBuilderImageError, modalError, refusal } from "./errors.ts";
import { DEPLOYMENT_TAG } from "./inventory.ts";
import {
  allocateModalCompute,
  lookupModalCompute,
  lookupNamedModalCompute,
  verifyModalComputeOwnership,
} from "./machine.ts";
import type { Machine, RunnerDistribution, RunnerTransport, Scope } from "./ports.ts";
import type { ModalProviderOptions } from "./provider.ts";
import { SSH_PORT } from "./ssh.ts";
import { scopeKey } from "./store.ts";

export function createPhysicalLifecycle(deps: {
  client: ReturnType<typeof modalConnection>;
  bound: () => ReturnType<typeof boundModalApp>;
  appName: string;
  scope: Scope;
  deploymentId?: string;
  distribution: RunnerDistribution;
  runner: RunnerTransport;
  measure: NonNullable<ModalProviderOptions["measure"]>;
  assertMachineSource(row: Machine): void;
  sandboxInfo(row: Machine): SandboxInfo;
}) {
  const {
    client,
    bound,
    appName,
    scope,
    deploymentId,
    distribution,
    runner,
    measure,
    assertMachineSource,
    sandboxInfo,
  } = deps;

  async function boundNotAbsence() {
    await bound().catch((error) => {
      if (modalError(error).code !== "not_found") throw error;
      throw refusal("unavailable", "Modal App lookup failed; the sandbox was not deleted.");
    });
  }
  async function physical(row: Machine, signal?: AbortSignal) {
    assertMachineSource(row);
    await bound();
    signal?.throwIfAborted();
    if (!row.physicalId) throw refusal("sandbox_not_ready", "No current physical machine.");
    return lookupModalCompute(client, row.physicalId, signal);
  }
  function ownershipTags(row: Machine) {
    return {
      armada_sandbox: row.info.id,
      armada_scope: scopeKey(scope),
      armada_generation: String(row.generation),
    };
  }
  async function namedOwned(row: Machine) {
    assertMachineSource(row);
    await boundNotAbsence();
    let sb: Sandbox;
    try {
      sb = await lookupNamedModalCompute(client, appName, row.physicalName, scope.binding.environment);
    } catch (error) {
      if (modalError(error).code === "not_found")
        throw refusal(
          "unavailable",
          "Named create outcome is still unknown; reservation preserved. Retry reconciliation, never create a replacement.",
        );
      throw refusal(
        "unavailable",
        "Named create reconciliation unavailable; reservation preserved. Retry delete after Modal recovers.",
      );
    }
    let tags: Record<string, string>;
    try {
      tags = await sb.getTags();
    } catch {
      throw refusal(
        "unavailable",
        "Named machine ownership verification is unavailable; reservation preserved. Retry reconciliation.",
      );
    }
    verifyModalComputeOwnership(tags, ownershipTags(row));
    return sb;
  }
  async function bootStage<T>(
    stage: "binding" | "runtime" | "baseline" | "fresh" | "start" | "health" | "active_publication",
    work: () => Promise<T>,
  ) {
    try {
      return await measure(`modal_boot_${stage}`, work);
    } catch (error) {
      const safe = modalError(error);
      throw new ProviderError({
        provider: "modal",
        code: safe.code,
        retryable: safe.retryable,
        ...(safe.status === undefined ? {} : { status: safe.status }),
        providerCode: `modal_boot_${stage}`,
        ...(safe.details ? { details: safe.details } : {}),
        message: "Modal bootstrap failed; inspect the durable lifecycle receipt.",
      });
    }
  }
  async function sealBaselineBeforeAdmission(
    sb: Sandbox,
    row: Machine,
    save: (row: Machine) => Promise<void>,
    runnerPid: unknown,
  ) {
    const baseline = row.processBaseline;
    if (baseline?.admissionState !== "pending") return;
    await bootStage("baseline", async () => {
      if (
        distribution.sealProcessBaseline &&
        typeof runnerPid === "number" &&
        Number.isSafeInteger(runnerPid) &&
        runnerPid >= 1
      )
        row.processBaseline = await distribution.sealProcessBaseline(sb, row, runnerPid);
      else row.processBaseline = { ...baseline, admissionState: "legacy" };
      await save(row);
    });
  }
  async function create(
    row: Machine,
    save: (row: Machine) => Promise<void>,
    env: Readonly<Record<string, string>>,
    onResumeStage?: ResumeStageObserver,
  ) {
    const app = await bound();
    let sb: Sandbox;
    if (row.phase === "creating") {
      sb = await namedOwned(row);
      if ((await sb.poll()) !== null)
        throw refusal("conflict", "Reconciled creation already terminated; manual recovery required.");
    } else if (row.phase === "reserved") {
      const image = await measure("modal_image", () =>
        row.imageId ? client.images.fromId(row.imageId) : distribution.image(client),
      );
      if (row.golden && !image.imageId) {
        try {
          await measure("modal_image", () => image.build(app));
        } catch (error) {
          row.phase = "deleted";
          await save(row);
          throw modalBuilderImageError(error);
        }
      }
      const artifactVolume = row.commonRuntime
        ? await client.volumes
            .fromName("armada-runtime-artifacts", {
              environment: scope.binding.environment,
              createIfMissing: false,
            })
            .catch((error: unknown) => {
              if (!(error instanceof NotFoundError)) throw error;
              return undefined;
            })
        : undefined;
      row.phase = "creating";
      row.grantExpiresAt = Date.now() + row.ttlSeconds * 1000;
      await save(row);
      sb = await measure("modal_sandbox_create", () =>
        allocateModalCompute(client, app, image, {
          ...(row.runtimePolicy === "explicit-vm-v1" ? { runtime: "vm" as const } : {}),
          ...(row.size === undefined ? {} : { size: row.size }),
          name: row.physicalName,
          tags: {
            ...ownershipTags(row),
            ...(!row.golden && deploymentId ? { [DEPLOYMENT_TAG]: deploymentId } : {}),
          },
          computeTtlSeconds: row.ttlSeconds,
          ...(artifactVolume
            ? { volumes: { [SHARED_ARTIFACT_CACHE_PATH]: artifactVolume.withMountOptions({ readOnly: true }) } }
            : {}),
          unencryptedPorts: [SSH_PORT],
        }),
      );
    } else {
      sb = await physical(row);
    }
    if (row.phase === "creating") await onResumeStage?.("provider_claimed");
    row.physicalId = sb.sandboxId;
    if (row.runtimePolicy === "explicit-vm-v1")
      row.runtimeEvidence = { version: 1, runtime: "vm", physicalId: sb.sandboxId, generation: row.generation };
    row.phase = "booting";
    await bootStage("binding", () => save(row));
    if (!row.commonRuntime && distribution.prepareRuntime)
      await bootStage("runtime", () => distribution.prepareRuntime!(sb, row));
    await bootStage("baseline", async () => {
      if (distribution.captureProcessBaseline && !row.processBaseline) {
        if (row.freshStatePreparedGeneration === row.generation)
          throw refusal(
            "conflict",
            "Cannot trust a control baseline captured after bootstrap; physical source retained.",
          );
        row.processBaseline = await distribution.captureProcessBaseline(sb, row);
        await save(row);
      }
      if (
        row.processBaseline &&
        (row.processBaseline.physicalId !== row.physicalId || row.processBaseline.generation !== row.generation)
      )
        throw refusal("conflict", "Physical process baseline does not match this incarnation.");
    });
    if (
      distribution.prepareFreshMachine &&
      (row.golden || row.generation === 1) &&
      row.freshStatePreparedGeneration !== row.generation
    ) {
      await bootStage("fresh", async () => {
        await distribution.prepareFreshMachine!(sb, row);
        row.freshStatePreparedGeneration = row.generation;
        await save(row);
      });
    }
    if (!row.commonRuntime) {
      await onResumeStage?.("machine_started");
      await bootStage("start", () => distribution.start(sb, row, env));
      let managedRunnerPid: unknown;
      await bootStage("health", async () => {
        let healthy = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            const health = await runner.call<{ generation?: string; ready?: boolean; pid?: unknown }>(
              row,
              "health",
              {},
            );
            if (health.generation !== String(row.generation) || health.ready !== true)
              throw refusal("conflict", "Runner health belongs to another or closed generation.");
            managedRunnerPid = health.pid;
            healthy = true;
            break;
          } catch (error) {
            if (attempt === 119) throw error;
            await Bun.sleep(250);
          }
        }
        if (!healthy) throw refusal("unavailable", "Runner did not become ready.");
      });
      await sealBaselineBeforeAdmission(sb, row, save, managedRunnerPid);
    }
    row.phase = "active";
    row.info.state = "ready";
    row.info.providerState = "active";
    row.info.expiresAt = new Date(row.grantExpiresAt ?? Date.now());
    await bootStage("active_publication", () => save(row));
    return sandboxInfo(row);
  }
  return { physical, namedOwned, boundNotAbsence, create, sealBaselineBeforeAdmission };
}
