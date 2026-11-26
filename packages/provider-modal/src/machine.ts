import { createHash } from "node:crypto";
import { type ModalBinding, machineCapacity } from "@armada/core";
import {
  capabilities,
  type Machine,
  type MachineIdentity,
  type MachineIncarnation,
  type RetainedMachine,
  SHARED_ARTIFACT_CACHE_PATH,
} from "@armada/core/server";
import type { App, Image, ModalClient, Sandbox, SandboxCreateParams } from "modal";
import { boundModalApp, modalStopTimeout } from "./client.ts";
import { modalError, refusal } from "./errors.ts";
import { createModalMachineInventory } from "./inventory.ts";
import { bootstrapModalRuntime, type RuntimeTicket, validateRuntimeTicket } from "./runtime-bootstrap.ts";

type Create = Parameters<Machine["create"]>[0];
type Bootstrap = Parameters<Machine["bootstrap"]>[0];
type Stop = Parameters<Machine["stop"]>[0];
type Delete = Parameters<Machine["delete"]>[0];
type RecordEntry = {
  revision: number;
  intent: string;
  operation: "create" | "resume";
  phase: "creating" | "allocated" | "stopping" | "stopped" | "deleting" | "deleted";
  machineId?: string;
  retain?: boolean;
  recoveryImageId?: string;
  snapshotDispatched?: true;
  runtimeBinding?: string;
  deleteScope?: Delete["scope"];
};

export interface ModalMachineJournal {
  read(key: string): Promise<RecordEntry | undefined>;
  compareAndSet(key: string, revision: number | undefined, next: RecordEntry): Promise<boolean>;
}

export interface ModalMachineOptions {
  client: Pick<ModalClient, "apps" | "sandboxes" | "images" | "cpClient"> & {
    volumes?: ModalClient["volumes"] | undefined;
  };
  appName: string;
  binding: ModalBinding;
  deploymentId: string;
  journal: ModalMachineJournal;
  resolveRuntimeTicket(request: Bootstrap): Promise<RuntimeTicket | null>;
  prepareCheckpoint?(request: Stop, sandbox: Sandbox): Promise<void>;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function conflict(message: string) {
  return refusal("conflict", message);
}

function retained(id: MachineIncarnation, ref: string) {
  return { sandboxId: id.sandboxId, generation: id.generation, kind: "image", ref } satisfies RetainedMachine;
}

function identity(id: MachineIncarnation, machineId: string) {
  return { sandboxId: id.sandboxId, generation: id.generation, machineId } satisfies MachineIdentity;
}

type AllocationOptions = Pick<Create, "size" | "computeTtlSeconds"> &
  Pick<SandboxCreateParams, "runtime" | "volumes" | "unencryptedPorts"> & {
    name: string;
    tags: Record<string, string>;
  };

export function allocateModalCompute(
  create: ModalClient["sandboxes"]["create"],
  app: App,
  image: Image,
  { size, computeTtlSeconds, ...options }: AllocationOptions,
) {
  const capacity = size === null ? null : machineCapacity("modal", size);
  return create(app, image, {
    ...options,
    timeoutMs: computeTtlSeconds * 1000,
    workdir: "/home/user",
    ...(capacity && {
      cpu: capacity.vcpus / 2,
      cpuLimit: capacity.vcpus / 2,
      memoryMiB: capacity.memoryMiB,
      memoryLimitMiB: capacity.memoryMiB,
    }),
    secrets: [],
    env: {},
    includeOidcIdentityToken: false,
  });
}

export async function observeModalCompute(
  machine: MachineIdentity,
  sandbox: Pick<Sandbox, "sandboxId" | "poll">,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (sandbox.sandboxId !== machine.machineId) throw conflict("Modal observation returned a different machine.");
  const phase = (await sandbox.poll()) === null ? "running" : "stopped";
  signal?.throwIfAborted();
  return { kind: "present", machine, phase } as const;
}

export async function lookupModalCompute(
  client: Pick<ModalClient, "sandboxes">,
  machineId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const sandbox = await client.sandboxes.fromId(machineId);
  if (sandbox.sandboxId !== machineId) throw conflict("Modal lookup returned a different machine.");
  return sandbox;
}

export function lookupNamedModalCompute(
  client: Pick<ModalClient, "sandboxes">,
  appName: string,
  name: string,
  environment: string,
) {
  return client.sandboxes.fromName(appName, name, { environment, includeTerminated: true });
}

export function verifyModalComputeOwnership(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
) {
  if (Object.entries(expected).some(([tag, value]) => actual[tag] !== value))
    throw conflict("Modal machine ownership does not match the incarnation; resource not modified.");
}

async function snapshotModalRecoveryImage(sandbox: Sandbox, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const timeoutMs = modalStopTimeout(55_000);
  const image = await sandbox.snapshotFilesystem({ ttlMs: null, ...(timeoutMs < 55_000 && { timeoutMs }) });
  if (!image.imageId) throw refusal("unavailable", "Modal checkpoint returned no image.");
  return image.imageId;
}

async function terminateModalCompute(
  sandbox: Sandbox,
  { wait = true, signal }: { wait?: boolean; signal?: AbortSignal | undefined } = {},
) {
  signal?.throwIfAborted();
  const exitCode = await sandbox.poll();
  signal?.throwIfAborted();
  if (exitCode !== null) return;
  if (wait) await sandbox.terminate({ wait: true });
  else await sandbox.terminate();
  signal?.throwIfAborted();
  if ((await sandbox.poll()) === null) throw refusal("unavailable", "Modal termination has not completed.");
  signal?.throwIfAborted();
}

export async function stopModalCompute(
  sandbox: Sandbox,
  options: NonNullable<Parameters<typeof terminateModalCompute>[1]> & {
    runStep?<T>(stage: "modal_checkpoint_snapshot" | "modal_checkpoint_terminate", work: () => Promise<T>): Promise<T>;
    checkpoint?: {
      prepare(): Promise<void>;
      recordIntent(): Promise<void>;
      recordImage(imageId: string): Promise<void>;
    };
  },
) {
  const { checkpoint, signal, runStep = (_stage, work) => work() } = options;
  if (checkpoint) {
    await checkpoint.prepare();
    signal?.throwIfAborted();
    await checkpoint.recordIntent();
    const imageId = await runStep("modal_checkpoint_snapshot", () => snapshotModalRecoveryImage(sandbox, signal));
    await checkpoint.recordImage(imageId);
  }
  await runStep("modal_checkpoint_terminate", () => terminateModalCompute(sandbox, options));
}

async function optional<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (modalError(error).code !== "not_found") throw error;
  }
}

export async function deleteModalCompute(
  lookup: () => Promise<Sandbox>,
  options?: Parameters<typeof terminateModalCompute>[1],
) {
  await optional(async () => {
    const sandbox = await lookup();
    await terminateModalCompute(sandbox, options);
  });
}

export async function deleteModalRecoveryImage(client: Pick<ModalClient, "images">, imageId: string) {
  await optional(() => client.images.delete(imageId));
}

export function createModalMachine(options: ModalMachineOptions) {
  const { client, journal, binding, appName, deploymentId, prepareCheckpoint, resolveRuntimeTicket } = options;
  let verifiedApp: Promise<App> | undefined;
  const bound = () => {
    if (!verifiedApp) {
      const pending = boundModalApp(client, appName, binding).catch((error) => {
        if (verifiedApp === pending) verifiedApp = undefined;
        throw error;
      });
      verifiedApp = pending;
    }
    return verifiedApp;
  };
  const key = (id: MachineIncarnation) => digest([binding.appId, deploymentId, id.sandboxId, id.generation]);
  const handleKey = (id: MachineIdentity) => `${key(id)}:${id.machineId}`;
  const createdSandboxes = new Map<string, Sandbox>();
  const name = (id: MachineIncarnation) => `armada-${key(id).slice(0, 48)}`;
  const tags = (id: MachineIncarnation) => ({
    armada_deployment: deploymentId,
    armada_sandbox: id.sandboxId,
    armada_generation: String(id.generation),
    armada_machine_key: key(id),
  });
  function lookupArtifactVolume() {
    const volumes = client.volumes;
    if (!volumes) return Promise.resolve(undefined);
    return optional(() =>
      volumes.fromName("armada-runtime-artifacts", {
        environment: binding.environment,
        createIfMissing: false,
      }),
    );
  }
  async function verify(sandbox: Sandbox, id: MachineIncarnation) {
    verifyModalComputeOwnership(await sandbox.getTags(), tags(id));
    return sandbox;
  }

  async function save(id: MachineIncarnation, previous: RecordEntry | undefined, next: Omit<RecordEntry, "revision">) {
    const entry = { ...next, revision: (previous?.revision ?? 0) + 1 };
    if (!(await journal.compareAndSet(key(id), previous?.revision, entry)))
      throw refusal("unavailable", "Modal lifecycle receipt changed during dispatch.");
    return entry;
  }

  async function named(id: MachineIncarnation) {
    const sandbox = await optional(() => lookupNamedModalCompute(client, appName, name(id), binding.environment));
    return sandbox && verify(sandbox, id);
  }

  async function exact(id: MachineIdentity, signal?: AbortSignal) {
    return verify(await lookupModalCompute(client, id.machineId, signal), id);
  }

  async function current(id: MachineIdentity & { signal?: AbortSignal }, recovery?: "adopt-create") {
    const entry = await journal.read(key(id));
    if (entry && entry.machineId === id.machineId) return entry;
    if (
      recovery === "adopt-create" &&
      entry?.operation === "create" &&
      entry.phase === "creating" &&
      !entry.machineId
    ) {
      id.signal?.throwIfAborted();
      await bound();
      const sandbox = await named(id);
      id.signal?.throwIfAborted();
      if (sandbox?.sandboxId === id.machineId)
        return save(id, entry, { ...entry, phase: "allocated", machineId: sandbox.sandboxId });
    }
    throw conflict("Modal receipt does not match the addressed machine.");
  }

  async function allocate(request: Create, operation: "create" | "resume", validateSource?: () => Promise<void>) {
    const { signal, size, computeTtlSeconds, source } = request;
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(request.generation) ||
      request.generation < 1 ||
      !request.sandboxId ||
      !source.ref ||
      !Number.isSafeInteger(computeTtlSeconds) ||
      computeTtlSeconds < 1 ||
      computeTtlSeconds > capabilities("modal").maxTtlSeconds
    )
      throw refusal("invalid_request", "Invalid Modal machine allocation.");
    const intent = digest([operation, source.kind, source.ref, size, computeTtlSeconds]);
    let entry = await journal.read(key(request));
    let sandbox: Sandbox | undefined;
    let freshlyCreated = false;
    if (entry) {
      await bound();
      if (entry.intent !== intent) throw conflict("Modal allocation intent differs from the original request.");
      if (entry.machineId) return identity(request, entry.machineId);
      sandbox = await named(request);
      if (!sandbox) throw refusal("unavailable", "Modal create outcome is uncertain.");
    } else {
      await validateSource?.();
      const [app, image, artifactVolume] = await Promise.all([
        bound(),
        client.images.fromId(source.ref),
        lookupArtifactVolume(),
      ]);
      signal?.throwIfAborted();
      entry = await save(request, undefined, { operation, intent, phase: "creating" });
      signal?.throwIfAborted();
      try {
        sandbox = await allocateModalCompute(client.sandboxes.experimentalCreate.bind(client.sandboxes), app, image, {
          name: name(request),
          tags: tags(request),
          runtime: "vm",
          computeTtlSeconds,
          size,
          ...(artifactVolume
            ? { volumes: { [SHARED_ARTIFACT_CACHE_PATH]: artifactVolume.withMountOptions({ readOnly: true }) } }
            : {}),
        });
      } catch (error) {
        verifiedApp = undefined;
        throw error;
      }
      freshlyCreated = true;
    }
    await save(request, entry, { ...entry, phase: "allocated", machineId: sandbox.sandboxId });
    const result = identity(request, sandbox.sandboxId);
    if (freshlyCreated) createdSandboxes.set(handleKey(result), sandbox);
    return result;
  }

  return {
    create: (request) => allocate(request, "create"),
    async bootstrap(request) {
      request.signal?.throwIfAborted();
      const entry = await current(request, "adopt-create");
      request.signal?.throwIfAborted();
      const runtimeBinding = digest(request.bindingRef);
      if (entry.phase !== "allocated" || (entry.runtimeBinding && entry.runtimeBinding !== runtimeBinding))
        throw conflict("Modal machine conflicts with the runtime binding.");
      if (!entry.runtimeBinding) await save(request, entry, { ...entry, runtimeBinding });
      const cacheKey = handleKey(request);
      try {
        await bound();
        request.signal?.throwIfAborted();
        const cached = createdSandboxes.get(cacheKey);
        createdSandboxes.delete(cacheKey);
        const sb = cached?.sandboxId === request.machineId ? cached : await exact(request, request.signal);
        const ticket = await resolveRuntimeTicket(request);
        request.signal?.throwIfAborted();
        if (ticket)
          await bootstrapModalRuntime(
            sb,
            request.machineId,
            validateRuntimeTicket(ticket),
            ticket,
            "Enrolled Modal bootstrap failed; reconcile the runtime binding.",
          );
      } catch (error) {
        createdSandboxes.delete(cacheKey);
        verifiedApp = undefined;
        throw error;
      }
    },
    async stop(request) {
      let entry = await current(request);
      if (entry.phase === "allocated")
        entry = await save(request, entry, { ...entry, phase: "stopping", retain: request.retain });
      if ((entry.phase !== "stopping" && entry.phase !== "stopped") || entry.retain !== request.retain)
        throw conflict("Modal stop intent conflicts with the existing receipt.");
      if (entry.phase === "stopping") {
        const cacheKey = handleKey(request);
        createdSandboxes.delete(cacheKey);
        try {
          await bound();
          const sb = await exact(request, request.signal);
          const needsSnapshot = request.retain && !entry.recoveryImageId;
          if (needsSnapshot && entry.snapshotDispatched)
            throw refusal("unavailable", "Modal snapshot outcome is uncertain.");
          await stopModalCompute(sb, {
            wait: false,
            signal: request.signal,
            ...(needsSnapshot && {
              checkpoint: {
                async prepare() {
                  if ((await sb.poll()) !== null) throw conflict("Modal checkpoint source already exited.");
                  if (!prepareCheckpoint) throw conflict("Modal checkpoint preparation is unavailable.");
                  await prepareCheckpoint(request, sb);
                },
                async recordIntent() {
                  entry = await save(request, entry, { ...entry, snapshotDispatched: true });
                },
                async recordImage(recoveryImageId) {
                  entry = await save(request, entry, { ...entry, recoveryImageId });
                },
              },
            }),
          });
        } catch (error) {
          verifiedApp = undefined;
          throw error;
        }
        await save(request, entry, { ...entry, phase: "stopped" });
      }
      return entry.recoveryImageId ? retained(request, entry.recoveryImageId) : null;
    },
    async resume(request) {
      const { predecessor } = request;
      if (
        predecessor.kind !== "image" ||
        predecessor.sandboxId !== request.sandboxId ||
        predecessor.generation !== request.generation - 1
      )
        throw conflict("Modal resume requires the preceding incarnation's recovery image.");
      return allocate({ ...request, source: { kind: "snapshot", ref: predecessor.ref } }, "resume", async () => {
        const prior = await journal.read(key(predecessor));
        if (
          !prior ||
          (prior.phase !== "stopped" && !(prior.phase === "deleted" && prior.deleteScope === "physical-only")) ||
          prior.recoveryImageId !== predecessor.ref
        )
          throw conflict("Modal recovery image does not match a completed stop.");
      });
    },
    async delete(request) {
      request.signal?.throwIfAborted();
      let entry = await current(request, "adopt-create");
      request.signal?.throwIfAborted();
      const cacheKey = handleKey(request);
      createdSandboxes.delete(cacheKey);
      if (entry.phase === "deleted") {
        if (entry.deleteScope === request.scope || entry.deleteScope === "physical-and-retained") return;
      } else if (entry.phase === "stopping" || (entry.phase === "deleting" && entry.deleteScope !== request.scope)) {
        throw conflict("Modal delete conflicts with a pending lifecycle intent.");
      }
      if (entry.phase !== "deleting")
        entry = await save(request, entry, { ...entry, phase: "deleting", deleteScope: request.scope });
      try {
        await bound();
        await deleteModalCompute(() => exact(request, request.signal), { wait: false, signal: request.signal });
        const image = entry.recoveryImageId;
        if (request.scope === "physical-and-retained" && image) {
          request.signal?.throwIfAborted();
          await deleteModalRecoveryImage(client, image);
        }
      } finally {
        createdSandboxes.delete(cacheKey);
        verifiedApp = undefined;
      }
      await save(request, entry, { ...entry, phase: "deleted" });
    },
    async observe(request) {
      try {
        request.signal?.throwIfAborted();
        await bound();
        const entry = await journal.read(key(request));
        if (request.machineId && entry?.machineId && request.machineId !== entry.machineId) return { kind: "unknown" };
        if (entry?.phase === "deleted") return { kind: "absent", receipt: { operation: "delete" } };
        const sb = entry?.machineId
          ? await exact(identity(request, entry.machineId), request.signal)
          : await named(request);
        if (!sb) return { kind: entry || request.machineId ? "unknown" : "absent" };
        if (request.machineId && request.machineId !== sb.sandboxId) return { kind: "unknown" };
        const machine = identity(request, entry?.machineId ?? sb.sandboxId);
        const observation = await observeModalCompute(machine, sb, request.signal);
        if (observation.phase === "stopped" && entry?.phase === "stopped") {
          const recovery = entry.recoveryImageId ? retained(request, entry.recoveryImageId) : null;
          return { ...observation, receipt: { operation: "stop", retained: recovery } };
        }
        const stopping = entry?.phase === "stopping" || entry?.phase === "deleting";
        return {
          ...observation,
          phase: stopping && observation.phase === "running" ? "stopping" : observation.phase,
          ...(entry && { receipt: { operation: entry.operation, machine } }),
        };
      } catch {
        request.signal?.throwIfAborted();
        return { kind: "unknown" };
      }
    },
    ...createModalMachineInventory(client, appName, binding, null),
  } satisfies Machine;
}
