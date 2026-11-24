import { createHash } from "node:crypto";
import type { MachineSize } from "@armada/core";
import type { MachineIdentity, Sql } from "@armada/core/server";
import {
  captureProcessBaseline,
  type Machine,
  type ModalMachineOptions,
  type ModalManagementProvenance,
  type Scope,
  scopeKey,
} from "@armada/provider-modal";

export interface ModalLaunchPlacement {
  scope: Scope;
  sourceVisibility: Scope["visibility"];
  snapshot: string;
  imageId: string;
  managementAuthority: ModalManagementProvenance;
}

export interface ModalLaunchHandoff {
  scope: Scope;
  record: Machine;
}

export async function prepareModalLaunchHandoff(
  allocation: MachineIdentity,
  machine: Pick<ModalMachineOptions, "client" | "binding" | "deploymentId">,
  placement: ModalLaunchPlacement,
  compute: { computeTtlSeconds: number; size: MachineSize | null },
  computeExpiresAt: Date,
  signal: AbortSignal,
) {
  const { sandboxId, generation, machineId } = allocation;
  const { scope, sourceVisibility, snapshot, imageId, managementAuthority } = placement;
  signal.throwIfAborted();
  const sandbox = await machine.client.sandboxes.fromId(machineId);
  if (sandbox.sandboxId !== machineId) throw new Error("Modal handoff allocation changed.");
  signal.throwIfAborted();
  const physicalKey = createHash("sha256")
    .update(JSON.stringify([machine.binding.appId, machine.deploymentId, sandboxId, generation]))
    .digest("hex");
  const record: Machine = {
    info: {
      id: machineId,
      name: sandboxId,
      state: "ready",
      providerState: "active",
      labels: {},
      createdAt: new Date(),
      expiresAt: computeExpiresAt,
    },
    generation,
    commonRuntime: true,
    runtimePolicy: "explicit-vm-v1",
    runtimeEvidence: { version: 1, runtime: "vm", physicalId: machineId, generation },
    runtimeStartAttempted: true,
    launchUserId: scope.userId,
    managementAuthority,
    sourceImage: {
      scopeKey: scopeKey({ ...scope, visibility: sourceVisibility }),
      name: snapshot,
      imageId,
    },
    phase: "booting",
    golden: false,
    ttlSeconds: compute.computeTtlSeconds,
    ...(compute.size === null ? {} : { size: compute.size }),
    physicalName: `armada-${physicalKey.slice(0, 48)}`,
    physicalId: machineId,
  };
  record.processBaseline = await captureProcessBaseline(sandbox, record);
  signal.throwIfAborted();
  record.phase = "active";
  return { scope, record } satisfies ModalLaunchHandoff;
}

export async function installModalLaunchHandoff(tx: Sql, { scope, record }: ModalLaunchHandoff) {
  const key = scopeKey(scope);
  await tx.query(
    "insert into public.modal_server_scopes(scope,context) values($1,$2::jsonb) on conflict(scope) do nothing",
    [key, JSON.stringify(scope)],
  );
  await tx.query(
    `insert into public.modal_machines (scope,org_id,owner_id,visibility,id,request_key,record)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [key, scope.orgId, scope.userId, scope.visibility, record.info.id, record.info.name, JSON.stringify(record)],
  );
}

export function unresolvedModalLaunch(sandbox: string) {
  return `((${sandbox}.provider='modal' or ${sandbox}.boat_runtime) and exists(
    select 1 from public.jobs launch
    where launch.kind='launch' and launch.state in ('queued','leased')
      and launch.sandbox_id=${sandbox}.id and launch.generation=${sandbox}.lifecycle_generation
      and launch.org_id=${sandbox}.org_id and launch.request_owner_id=${sandbox}.owner_id
  ))`;
}
