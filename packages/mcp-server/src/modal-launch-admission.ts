import type { GoldenActor, GoldenRecord, LaunchOptions, Sql } from "@armada/core";
import { type LaunchRequest, type LaunchStores, prepareGoldenLaunch, VaultError } from "@armada/core/server";
import { type ModalLaunchAdmission, replayModalLaunch } from "./jobs/modal-launch.ts";
import { requireLaunchAccountBinding } from "./launch-account-admission.ts";

export type AdmitModalLaunch = (
  actor: GoldenActor,
  golden: GoldenRecord,
  stores: Pick<LaunchStores, "goldens" | "sandboxes" | "skillDefaults">,
  request: LaunchRequest,
  admission?: {
    request?: ModalLaunchAdmission["request"];
    armadaAccess?: ModalLaunchAdmission["armadaAccess"];
    pin?: {
      id: string;
      credentialVersion: number;
      revalidate: NonNullable<ModalLaunchAdmission["revalidateTemplate"]>;
    };
  },
) => Promise<import("@armada/core/contract").ModalLaunchReceipt>;

export function createModalLaunchAdmission(
  sql: Sql,
  placement: NonNullable<LaunchOptions["modalRuntimeDefault"]>,
  options: Pick<LaunchOptions, "extensionHeadroomSeconds">,
  admit: (input: ModalLaunchAdmission) => ReturnType<AdmitModalLaunch>,
) {
  const launch: AdmitModalLaunch = async (actor, golden, stores, request, admission) => {
    if (admission?.request) {
      const receipt = await replayModalLaunch(sql, actor, golden.id, admission.request);
      if (receipt) return receipt;
    }
    const provider = await placement.provider(actor, golden);
    const { pin, armadaAccess } = admission ?? {};
    const { plan } = await prepareGoldenLaunch(
      provider,
      {
        ...stores,
        goldens: { ...stores.goldens, findByName: async () => [golden] },
        credentials: placement.credentials,
        connections: placement.connections,
      },
      actor,
      request,
      {
        ...options,
        runtime: placement.policy,
        ...(armadaAccess ? { privateVisibility: true } : {}),
        ...(pin ? { credentialVersion: pin.credentialVersion } : {}),
      },
    );
    if (plan.golden.id !== golden.id) throw new VaultError("conflict", "Modal launch golden changed.");
    const binding = requireLaunchAccountBinding(plan.credentials.binding);
    const project = plan.resourceProject;
    return admit({
      orgId: actor.orgId,
      ownerId: actor.userId,
      sandbox: {
        ...binding,
        goldenId: golden.id,
        harness: plan.harness,
        ...plan.choice,
        repositoryDir: plan.repositoryDir,
        machineSize: plan.machineSize,
        effectiveTtlSeconds: plan.ttlSeconds,
        visibility: plan.visibility,
        ...(project
          ? { resourceProject: { version: 1, url: project.url, branch: project.branch, dir: project.dir } }
          : {}),
        ...(request.ttlSeconds === undefined ? {} : { requestedTtlSeconds: request.ttlSeconds }),
        ...(request.stopWhenWorkMerged === undefined ? {} : { stopWhenWorkMerged: request.stopWhenWorkMerged }),
        ...(request.externalRef === undefined ? {} : { externalRef: request.externalRef }),
      },
      allocation: {
        source: { kind: "snapshot", ref: plan.snapshot },
        computeTtlSeconds: plan.allocationTtlSeconds,
      },
      ...(admission?.request ? { request: admission.request } : {}),
      ...(armadaAccess ? { armadaAccess } : {}),
      ...(pin ? { templateReceiptId: pin.id, revalidateTemplate: pin.revalidate } : {}),
      ...(plan.prompt === undefined ? {} : { initialPrompt: plan.prompt }),
      ...(request.connections === undefined ? {} : { connections: request.connections }),
      ...(plan.request.skills ? { resolvedSkills: plan.request.skills } : {}),
      deadline: new Date(Date.now() + 15 * 60_000),
      maxAttempts: 3,
    });
  };
  return launch;
}
