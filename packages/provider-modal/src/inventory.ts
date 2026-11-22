import { createHash } from "node:crypto";
import type { ModalBinding, ProviderInventoryMachine } from "@armada/core";
import type { Machine } from "@armada/core/server";
import type { App, ModalClient } from "modal";
import { abortable, boundModalApp } from "./client.ts";
import { modalError, refusal } from "./errors.ts";

export const DEPLOYMENT_TAG = "armada_deployment";

export function modalDeploymentId(environment: string, publicUrl: string) {
  return createHash("sha256")
    .update(JSON.stringify([environment, new URL(publicUrl).origin]))
    .digest("hex");
}

export function createModalMachineInventory(
  client: Pick<ModalClient, "apps" | "cpClient">,
  appName: string,
  binding: ModalBinding,
  deploymentId: string | null,
) {
  return {
    listInventory: (signal?: AbortSignal) =>
      listModalInventory(client, () => boundModalApp(client, appName, binding), deploymentId, signal),
  } satisfies Required<Pick<Machine, "listInventory">>;
}

async function* listModalInventory(
  client: Pick<ModalClient, "cpClient">,
  bound: () => Promise<App>,
  deploymentId: string | null,
  signal?: AbortSignal,
) {
  if (deploymentId === undefined || deploymentId === "")
    throw refusal("provider_routing_unavailable", "Modal inventory requires a deployment identity.");
  signal?.throwIfAborted();
  try {
    const { appId } = await abortable(bound(), signal);
    const tags = deploymentId ? [{ tagName: DEPLOYMENT_TAG, tagValue: deploymentId }] : [];
    let beforeTimestamp: number | undefined;
    while (true) {
      signal?.throwIfAborted();
      const { sandboxes } = await client.cpClient.sandboxListV2(
        { appId, tags, includeFinished: false, ...(beforeTimestamp === undefined ? {} : { beforeTimestamp }) },
        signal ? { signal } : undefined,
      );
      if (sandboxes.length === 0) return;
      for (const sandbox of sandboxes) {
        signal?.throwIfAborted();
        const ownership = new Map(sandbox.tags.map(({ tagName, tagValue }) => [tagName, tagValue]));
        const owner = ownership.get(DEPLOYMENT_TAG);
        if (!owner || (deploymentId && owner !== deploymentId) || sandbox.appId !== appId) continue;
        const createdAt = new Date(sandbox.createdAt * 1000);
        if (sandbox.createdAt <= 0 || !Number.isFinite(createdAt.getTime()))
          throw refusal("unavailable", "Modal inventory returned an invalid creation time.");
        const sandboxId = ownership.get("armada_sandbox");
        const generation = ownership.get("armada_generation");
        yield {
          machineId: sandbox.id,
          deploymentId: owner,
          createdAt,
          ...(sandboxId ? { sandboxId } : {}),
          ...(generation ? { generation } : {}),
        } satisfies ProviderInventoryMachine;
      }
      const nextTimestamp = sandboxes.at(-1)?.createdAt;
      if (
        nextTimestamp === undefined ||
        !Number.isFinite(nextTimestamp) ||
        nextTimestamp <= 0 ||
        (beforeTimestamp !== undefined && nextTimestamp >= beforeTimestamp)
      )
        throw refusal("unavailable", "Modal inventory pagination did not advance.");
      beforeTimestamp = nextTimestamp;
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw modalError(error);
  }
}
