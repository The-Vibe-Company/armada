import { createHash } from "node:crypto";
import { MACHINE_SIZE_CATALOG, type Provider } from "@armada/core";
import { type Machine, type MachineIdentity, type MachineIncarnation, ProviderError } from "@armada/core/server";
import { BoatApi, Configuration, type Sandbox } from "@boatdev/sdk";
import { invalidRequest, toProviderError, unexpectedAnswer } from "./errors.ts";
import type { BoatProviderOptions } from "./provider.ts";
import { startBoatRuntime } from "./runtime-bootstrap.ts";

type Bootstrap = Parameters<Machine["bootstrap"]>[0];
type Ticket = Omit<Parameters<typeof startBoatRuntime>[1], "sandboxId">;
type StopBinding = MachineIdentity &
  ({ readonly launchGeneration: number } | { readonly orgId: string; readonly ownerId: string });

export function createBoatMachine(
  options: BoatProviderOptions & {
    deploymentId: string;
    stopBinding?: StopBinding;
    onStopped?: (stoppedAt: Date | undefined) => void;
  },
  host: Provider,
  resolveTicket: (request: Bootstrap, expiresAt: number) => Promise<Ticket | null>,
  authorize: () => Promise<void>,
  bootstrapRuntime = startBoatRuntime,
) {
  const stopBinding = options.stopBinding && { ...options.stopBinding };
  const api = new BoatApi(
    new Configuration({
      basePath: options.baseUrl ?? "https://boat.dev/api/v1",
      accessToken: options.apiKey,
      ...(options.fetch ? { fetchApi: options.fetch } : {}),
    }),
  );
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const key = (id: MachineIncarnation) => hash(JSON.stringify([options.deploymentId, id.sandboxId, id.generation]));
  const labels = (id: MachineIncarnation) => ({
    armada: "sandbox",
    "armada.deployment": hash(options.deploymentId),
    "armada.machine": key(id),
    "armada.deployment_id": options.deploymentId,
    sandbox: id.sandboxId,
    generation: String(id.generation),
  });
  const matches = (
    sandbox: Pick<Sandbox, "labels"> | { labels: Readonly<Record<string, string>> },
    tags: Record<string, string | undefined>,
  ) => Object.entries(tags).every(([name, value]) => sandbox.labels?.[name] === value);
  function identity(id: MachineIncarnation, machineId: string) {
    return { sandboxId: id.sandboxId, generation: id.generation, machineId };
  }
  async function call<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      throw await toProviderError(error);
    }
  }
  async function* inventory(filter: Record<string, string>, signal?: AbortSignal) {
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const result = await call(() =>
        api.sandboxes(
          { label: Object.entries(filter).map(([name, value]) => `${name}=${value}`), cursor: cursor ?? null },
          { signal: signal ?? null },
        ),
      );
      yield* (result.sandboxes ?? []).filter((sandbox) => matches(sandbox, filter));
      const next = result.pageInfo?.hasMore ? result.pageInfo.nextCursor : undefined;
      if (result.pageInfo?.hasMore && (!next || next === cursor))
        throw invalidRequest("Invalid Boat inventory cursor.");
      cursor = next ?? undefined;
    } while (cursor);
  }
  function stopLabels(request: MachineIdentity) {
    if (!stopBinding) return labels(request);
    if (
      stopBinding.sandboxId !== request.sandboxId ||
      stopBinding.generation !== request.generation ||
      stopBinding.machineId !== request.machineId
    )
      throw invalidRequest("Boat machine incarnation changed.");
    if ("launchGeneration" in stopBinding) {
      const { launchGeneration } = stopBinding;
      if (!Number.isSafeInteger(launchGeneration) || launchGeneration < 1 || launchGeneration > request.generation)
        throw invalidRequest("Boat machine incarnation changed.");
      return labels({ ...request, generation: launchGeneration });
    }
    return {
      armada: "sandbox",
      sandbox: request.sandboxId,
      org: stopBinding.orgId,
      owner: stopBinding.ownerId,
      "armada.machine": undefined,
      generation: undefined,
    };
  }
  async function exact(
    request: MachineIdentity,
    signal?: AbortSignal,
    tags: Record<string, string | undefined> = labels(request),
  ) {
    const { sandbox } = await call(() => api.get({ sandboxId: request.machineId }, { signal: signal ?? null }));
    if (sandbox?.id !== request.machineId || !matches(sandbox, tags))
      throw invalidRequest("Boat machine incarnation changed.");
    return sandbox;
  }
  const missing = (error: unknown) =>
    error instanceof ProviderError && error.status === 404 && error.code === "not_found";
  const stopped = (sandbox: Sandbox) =>
    sandbox.state === "archived" && (!sandbox.stop || sandbox.stop.status === "completed");
  async function mutate<T>(signal: AbortSignal | undefined, fn: () => Promise<T>) {
    await authorize();
    signal?.throwIfAborted();
    return call(fn);
  }
  async function allocate(request: Parameters<Machine["create" | "resume"]>[0], source: string, restore = false) {
    const body = {
      noEnv: true,
      labels: labels(request),
      ttlSeconds: request.computeTtlSeconds,
      ...(request.size ? { type: MACHINE_SIZE_CATALOG[request.size].boatType } : {}),
    };
    const idempotencyKey = key(request);
    const transport = { signal: request.signal ?? null };
    const { sandbox } = await mutate<{ sandbox?: Sandbox | null }>(request.signal, () =>
      restore
        ? api.fork({ sandboxId: source, idempotencyKey, forkRequest: body }, transport)
        : api.create({ idempotencyKey, createSandboxRequest: { ...body, from: source } }, transport),
    );
    if (!sandbox?.id || (restore && sandbox.id === source) || !matches(sandbox, labels(request)))
      throw unexpectedAnswer("allocation identity");
    return identity(request, sandbox.id);
  }
  async function stopCompute(
    request: MachineIdentity & { signal?: AbortSignal },
    tags: Record<string, string | undefined> = labels(request),
  ) {
    const sandbox = await exact(request, request.signal, tags);
    if (stopped(sandbox)) return sandbox;
    if (!sandbox.stop || sandbox.stop.status === "superseded")
      await mutate(request.signal, () =>
        api.stop({ sandboxId: request.machineId }, { signal: request.signal ?? null }),
      );
    const archived = await exact(request, request.signal, tags);
    if (!stopped(archived)) throw invalidRequest("Boat stop is not confirmed.");
    return archived;
  }
  return {
    create(request) {
      if (request.source.kind !== "snapshot") throw invalidRequest("Boat requires a saved snapshot.");
      return allocate(request, request.source.ref);
    },
    async bootstrap(request) {
      const sandbox = await exact(request, request.signal);
      const expiresAt = sandbox.archiveAfter?.getTime();
      if (!expiresAt || !Number.isFinite(expiresAt)) throw invalidRequest("Boat compute deadline is unconfirmed.");
      const ticket = await resolveTicket(request, expiresAt);
      if (!ticket) return;
      const sshKey: Provider["sshKey"] = (key) => mutate(request.signal, () => host.sshKey(key));
      await bootstrapRuntime({ ...host, sshKey }, { ...ticket, sandboxId: request.machineId });
    },
    async stop(request) {
      const tags = stopLabels(request);
      const archived = await stopCompute(request, tags);
      const stoppedAt = archived.stoppedAt;
      options.onStopped?.(stoppedAt && Number.isFinite(stoppedAt.getTime()) ? stoppedAt : undefined);
      if (!request.retain) return null;
      const info = await host.get(request.machineId, request.signal ? { signal: request.signal } : undefined);
      if (info.id !== request.machineId || !matches(info, tags) || info.retainedSnapshot !== "usable")
        throw invalidRequest("Boat disk retention is unconfirmed.");
      return { sandboxId: request.sandboxId, generation: request.generation, kind: "disk", ref: request.machineId };
    },
    async resume(request) {
      const { predecessor } = request;
      if (
        predecessor.kind !== "disk" ||
        predecessor.sandboxId !== request.sandboxId ||
        predecessor.generation >= request.generation
      )
        throw invalidRequest("Boat retained predecessor changed.");
      const prior = await exact({ ...predecessor, machineId: predecessor.ref }, request.signal);
      const info = await host.get(prior.id, request.signal ? { signal: request.signal } : undefined);
      if (!stopped(prior) || info.retainedSnapshot !== "usable")
        throw invalidRequest("Boat disk retention is unconfirmed.");
      return allocate(request, predecessor.ref, true);
    },
    async delete(request) {
      try {
        if (request.scope === "physical-only") {
          await stopCompute(request);
          return;
        }
        await exact(request, request.signal);
        const { status } = await mutate(request.signal, () => host.delete({ sandboxId: request.machineId }));
        if (status !== "completed") throw invalidRequest("Boat deletion is not confirmed.");
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
    async observe(request) {
      try {
        const target = request.machineId ? { ...request, machineId: request.machineId } : undefined;
        const candidates = target
          ? [await exact(target, request.signal, stopLabels(target))]
          : await Array.fromAsync(inventory(labels(request), request.signal));
        const [sandbox] = candidates;
        if (!sandbox) return { kind: "absent" };
        if (!sandbox.id || candidates.length !== 1) return { kind: "unknown" };
        const machine = identity(request, sandbox.id);
        if (request.machineId && stopped(sandbox)) return { kind: "absent" };
        const active = ["running", "ready", "idle"].includes(sandbox.state);
        const phase = stopped(sandbox) ? "stopped" : active ? "running" : sandbox.stop ? "stopping" : "starting";
        return { kind: "present", machine, phase, receipt: { operation: "create", machine } };
      } catch (error) {
        if (request.machineId && missing(error)) return { kind: "absent", receipt: { operation: "delete" } };
        return { kind: "unknown" };
      }
    },
    async *listInventory(signal) {
      for await (const sandbox of inventory({ armada: "sandbox" }, signal)) {
        const deploymentId = sandbox.labels?.["armada.deployment_id"];
        const sandboxId = sandbox.labels?.sandbox;
        const generation = Number(sandbox.labels?.generation);
        if (
          !sandboxId ||
          !Number.isSafeInteger(generation) ||
          generation < 1 ||
          !deploymentId ||
          sandbox.labels?.["armada.deployment"] !== hash(deploymentId) ||
          !sandbox.createdAt ||
          !sandbox.id
        )
          continue;
        yield { sandboxId, generation, machineId: sandbox.id, deploymentId, createdAt: sandbox.createdAt };
      }
    },
  } satisfies Machine;
}
