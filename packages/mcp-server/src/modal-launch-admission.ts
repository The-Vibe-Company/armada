import type { GoldenActor, GoldenRecord, LaunchOptions, Sql } from "@armada/core";
import { type LaunchRequest, type LaunchStores, prepareGoldenLaunch, VaultError } from "@armada/core/server";
import { type ModalLaunchAdmission, replayModalLaunch } from "./jobs/modal-launch.ts";
import { requireLaunchAccountBinding } from "./launch-account-admission.ts";
import { preparePoolCandidates, readLaunchAccountDefault } from "./launch-account-pool.ts";

import { checkpointGoldenLaunch } from "./request-timing.ts";

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

const launchAuthority = {
  modal: async (_provider: import("@armada/core").Provider) => ({}),
  boat: async (provider: import("@armada/core").Provider) => {
    const management = await provider.managementIdentity?.();
    const backendId = (await provider.backendIdentity?.())?.id;
    if (!management || !backendId) throw new VaultError("unavailable", "Boat launch authority is unavailable.");
    return { boat: { scope: management.scope, backendId } };
  },
};

export function createModalLaunchAdmission(
  sql: Sql,
  placement: NonNullable<LaunchOptions["modalRuntimeDefault"]>,
  options: Pick<LaunchOptions, "extensionHeadroomSeconds">,
  admit: (input: ModalLaunchAdmission) => ReturnType<AdmitModalLaunch>,
) {
  const launch: AdmitModalLaunch = async (actor, golden, stores, request, admission) => {
    if (admission?.request) {
      const receipt = await replayModalLaunch(sql, actor, golden.id, admission.request, golden.provider);
      if (receipt) return receipt;
    }
    const provider = await placement.provider(actor, golden);
    checkpointGoldenLaunch("provider_resolution");
    const { pin, armadaAccess } = admission ?? {};
    const credentials = placement.credentials;
    let repositories: Promise<void> | undefined;
    const prepare = async (candidate: LaunchRequest, version?: number) =>
      (
        await prepareGoldenLaunch(
          provider,
          {
            ...stores,
            goldens: { ...stores.goldens, findByName: async () => [golden] },
            credentials: {
              ...credentials,
              async authorizeRepositories(...args) {
                repositories ??= credentials.authorizeRepositories?.(...args);
                await repositories;
              },
            },
            connections: placement.connections,
          },
          actor,
          candidate,
          {
            ...options,
            runtime: placement.policy,
            ...(armadaAccess ? { privateVisibility: true } : {}),
            ...(version !== undefined ? { credentialVersion: version } : {}),
          },
        )
      ).plan;
    const preference =
      request.credentialId === undefined && !pin
        ? await readLaunchAccountDefault(sql, actor.userId, request.harness)
        : undefined;
    const pool = preference?.credentialIds.length
      ? { harness: request.harness, credentialIds: preference.credentialIds, model: request.model ?? preference.model }
      : undefined;
    const candidates = pool
      ? await preparePoolCandidates(sql, actor.userId, pool, async (credentialId, model) =>
          prepare({ ...request, credentialId, model }),
        )
      : undefined;
    const plan = candidates ? candidates.values().next().value! : await prepare(request, pin?.credentialVersion);
    const prepared =
      candidates &&
      new Map(
        [...candidates].map(([id, candidate]) => [
          id,
          { ...candidate.choice, ...requireLaunchAccountBinding(candidate.credentials.binding) },
        ]),
      );
    if (plan.golden.id !== golden.id) throw new VaultError("conflict", "Modal launch golden changed.");
    const binding = requireLaunchAccountBinding(plan.credentials.binding);
    const project = plan.resourceProject;
    checkpointGoldenLaunch("account_resolution");
    const management = await launchAuthority[golden.provider](provider);
    return admit({
      ...management,
      ...(pool && prepared ? { accountPool: { pool, prepared } } : {}),
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
