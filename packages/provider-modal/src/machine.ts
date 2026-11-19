import { createHash } from "node:crypto";
import { type ModalBinding, machineCapacity } from "@armada/core";
import {
  capabilities,
  type Machine,
  type MachineIdentity,
  type MachineIncarnation,
  type RetainedMachine,
  runtimeBootstrapScript,
} from "@armada/core/server";
import type { ModalClient, Sandbox } from "modal";
import { modalError, refusal } from "./errors.ts";
import { boundModalApp, listModalInventory } from "./provider.ts";

type Create = Parameters<Machine["create"]>[0];
type Bootstrap = Parameters<Machine["bootstrap"]>[0];
type Stop = Parameters<Machine["stop"]>[0];
type Delete = Parameters<Machine["delete"]>[0];
type RuntimeTicket = {
  serverUrl: string;
  artifact: { sha256: string; bytes: number };
  cacheDir: string;
  enrolmentToken: string;
};

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
  client: Pick<ModalClient, "apps" | "sandboxes" | "images" | "cpClient">;
  appName: string;
  binding: ModalBinding;
  deploymentId: string;
  journal: ModalMachineJournal;
  resolveRuntimeTicket(request: Bootstrap): Promise<RuntimeTicket>;
  prepareCheckpoint(request: Stop, sandbox: Sandbox): Promise<void>;
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

async function optional<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (modalError(error).code !== "not_found") throw error;
  }
}

export function createModalMachine(options: ModalMachineOptions) {
  const { client, journal, binding, appName, deploymentId, prepareCheckpoint, resolveRuntimeTicket } = options;
  const bound = () => boundModalApp(client, appName, binding);
  const key = (id: MachineIncarnation) => digest([binding.appId, deploymentId, id.sandboxId, id.generation]);
  const name = (id: MachineIncarnation) => `armada-${key(id).slice(0, 48)}`;
  const tags = (id: MachineIncarnation) => ({
    armada_deployment: deploymentId,
    armada_sandbox: id.sandboxId,
    armada_generation: String(id.generation),
    armada_machine_key: key(id),
  });
  async function verify(sandbox: Sandbox, id: MachineIncarnation) {
    const actual = await sandbox.getTags();
    if (Object.entries(tags(id)).some(([name, value]) => actual[name] !== value))
      throw conflict("Modal machine ownership does not match the incarnation.");
    return sandbox;
  }

  async function save(id: MachineIncarnation, previous: RecordEntry | undefined, next: Omit<RecordEntry, "revision">) {
    const entry = { ...next, revision: (previous?.revision ?? 0) + 1 };
    if (!(await journal.compareAndSet(key(id), previous?.revision, entry)))
      throw refusal("unavailable", "Modal lifecycle receipt changed during dispatch.");
    return entry;
  }

  async function named(id: MachineIncarnation) {
    const sandbox = await optional(() =>
      client.sandboxes.fromName(appName, name(id), {
        environment: binding.environment,
        includeTerminated: true,
      }),
    );
    return sandbox && verify(sandbox, id);
  }

  async function exact(id: MachineIdentity, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return verify(await client.sandboxes.fromId(id.machineId), id);
  }

  async function current(id: MachineIdentity) {
    const entry = await journal.read(key(id));
    if (!entry || entry.machineId !== id.machineId)
      throw conflict("Modal receipt does not match the addressed machine.");
    return entry;
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
    const app = await bound();
    let entry = await journal.read(key(request));
    let sandbox: Sandbox | undefined;
    if (entry) {
      if (entry.intent !== intent) throw conflict("Modal allocation intent differs from the original request.");
      if (entry.machineId) return identity(request, entry.machineId);
      sandbox = await named(request);
      if (!sandbox) throw refusal("unavailable", "Modal create outcome is uncertain.");
    } else {
      await validateSource?.();
      const image = await client.images.fromId(source.ref);
      const capacity = size ? machineCapacity("modal", size) : null;
      signal?.throwIfAborted();
      entry = await save(request, undefined, { operation, intent, phase: "creating" });
      signal?.throwIfAborted();
      sandbox = await client.sandboxes.experimentalCreate(app, image, {
        name: name(request),
        tags: tags(request),
        runtime: "vm",
        timeoutMs: computeTtlSeconds * 1000,
        workdir: "/home/user",
        ...(capacity && {
          cpu: capacity.vcpus / 2,
          cpuLimit: capacity.vcpus / 2,
          memoryMiB: capacity.memoryMiB,
          memoryLimitMiB: capacity.memoryMiB,
        }),
      });
    }
    await save(request, entry, { ...entry, phase: "allocated", machineId: sandbox.sandboxId });
    return identity(request, sandbox.sandboxId);
  }

  async function terminate(sandbox: Sandbox, signal?: AbortSignal) {
    if ((await sandbox.poll()) === null) {
      signal?.throwIfAborted();
      await sandbox.terminate();
      signal?.throwIfAborted();
      if ((await sandbox.poll()) === null) throw refusal("unavailable", "Modal termination has not completed.");
    }
  }

  return {
    create: (request) => allocate(request, "create"),
    async bootstrap(request) {
      request.signal?.throwIfAborted();
      const entry = await current(request);
      const runtimeBinding = digest(request.bindingRef);
      if (entry.phase !== "allocated" || (entry.runtimeBinding && entry.runtimeBinding !== runtimeBinding))
        throw conflict("Modal machine conflicts with the runtime binding.");
      if (!entry.runtimeBinding) await save(request, entry, { ...entry, runtimeBinding });
      await bound();
      const sb = await exact(request, request.signal);
      const ticket = await resolveRuntimeTicket(request);
      request.signal?.throwIfAborted();
      await bootstrapRuntime(sb, request, ticket);
    },
    async stop(request) {
      let entry = await current(request);
      if (entry.phase === "allocated")
        entry = await save(request, entry, { ...entry, phase: "stopping", retain: request.retain });
      if ((entry.phase !== "stopping" && entry.phase !== "stopped") || entry.retain !== request.retain)
        throw conflict("Modal stop intent conflicts with the existing receipt.");
      if (entry.phase === "stopping") {
        await bound();
        const sb = await exact(request, request.signal);
        if (request.retain && !entry.recoveryImageId) {
          if (entry.snapshotDispatched) throw refusal("unavailable", "Modal snapshot outcome is uncertain.");
          if ((await sb.poll()) !== null) throw conflict("Modal checkpoint source already exited.");
          await prepareCheckpoint(request, sb);
          request.signal?.throwIfAborted();
          entry = await save(request, entry, { ...entry, snapshotDispatched: true });
          request.signal?.throwIfAborted();
          const image = await sb.snapshotFilesystem({ ttlMs: null });
          if (!image.imageId) throw refusal("unavailable", "Modal checkpoint returned no image.");
          entry = await save(request, entry, { ...entry, recoveryImageId: image.imageId });
        }
        await terminate(sb, request.signal);
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
      let entry = await current(request);
      if (entry.phase === "deleted") {
        if (entry.deleteScope === request.scope || entry.deleteScope === "physical-and-retained") return;
      } else if (entry.phase === "stopping" || (entry.phase === "deleting" && entry.deleteScope !== request.scope)) {
        throw conflict("Modal delete conflicts with a pending lifecycle intent.");
      }
      if (entry.phase !== "deleting")
        entry = await save(request, entry, { ...entry, phase: "deleting", deleteScope: request.scope });
      await bound();
      const sb = await optional(() => exact(request, request.signal));
      if (sb) await optional(() => terminate(sb, request.signal));
      const image = entry.recoveryImageId;
      if (request.scope === "physical-and-retained" && image) {
        request.signal?.throwIfAborted();
        await optional(() => client.images.delete(image));
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
        const machine = identity(request, sb.sandboxId);
        const running = (await sb.poll()) === null;
        if (!running && entry?.phase === "stopped") {
          const recovery = entry.recoveryImageId ? retained(request, entry.recoveryImageId) : null;
          return { kind: "present", machine, phase: "stopped", receipt: { operation: "stop", retained: recovery } };
        }
        const stopping = entry?.phase === "stopping" || entry?.phase === "deleting";
        const phase = running ? (stopping ? "stopping" : "running") : "stopped";
        return {
          kind: "present",
          machine,
          phase,
          ...(entry && { receipt: { operation: entry.operation, machine } }),
        };
      } catch {
        request.signal?.throwIfAborted();
        return { kind: "unknown" };
      }
    },
    async *listInventory(signal) {
      for await (const entry of listModalInventory(client, bound, null, signal)) {
        const generation = Number(entry.generation);
        if (entry.sandboxId && Number.isSafeInteger(generation) && generation > 0)
          yield { ...entry, sandboxId: entry.sandboxId, generation };
      }
    },
  } satisfies Machine;
}

async function bootstrapRuntime(sb: Sandbox, request: Bootstrap, ticket: RuntimeTicket) {
  const server = new URL(ticket.serverUrl);
  if (
    server.protocol !== "https:" ||
    server.origin !== ticket.serverUrl.replace(/\/$/, "") ||
    !ticket.cacheDir.startsWith("/") ||
    ticket.cacheDir === "/" ||
    ticket.cacheDir.includes("\0") ||
    !/^[a-f0-9]{64}$/.test(ticket.artifact.sha256) ||
    !Number.isSafeInteger(ticket.artifact.bytes) ||
    ticket.artifact.bytes <= 0 ||
    ticket.artifact.bytes > 512 * 1024 * 1024 ||
    !/^armada_enrol_[a-f0-9]{64}$/.test(ticket.enrolmentToken)
  )
    throw refusal("invalid_request", "Invalid enrolled Modal bootstrap.");

  const lock = `/run/armada-runtime-${digest(request.machineId)}.lock`;
  const baseScript = runtimeBootstrapScript(server.origin, ticket.artifact, ticket.cacheDir);
  const stdio = "stdio:['pipe','ignore','ignore']";
  if (!baseScript.includes(stdio)) throw refusal("unavailable", "Modal bootstrap could not pass its runtime lock.");
  const script = baseScript.replace(stdio, "stdio:['pipe','ignore','ignore',9]");
  const lockAndExec = `exec 9>"$1" || exit 1
shift
flock -n -E 75 9
case $? in
  0) exec "$@" ;;
  75) cat >/dev/null ;;
  *) exit 1 ;;
esac`;
  try {
    const child = await sb.exec(
      [
        "/usr/bin/env",
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "sh",
        "-c",
        lockAndExec,
        "sh",
        lock,
        "node",
        "-e",
        script,
      ],
      { env: {}, secrets: [], timeoutMs: 150_000, workdir: "/home/user", stdout: "ignore", stderr: "ignore" },
    );
    await child.stdin.writeText(JSON.stringify({ serverUrl: server.origin, enrolmentToken: ticket.enrolmentToken }));
    await child.stdin.close();
    if ((await child.wait()) !== 0) throw Error();
  } catch {
    throw refusal("unavailable", "Enrolled Modal bootstrap failed; reconcile the runtime binding.");
  }
}
