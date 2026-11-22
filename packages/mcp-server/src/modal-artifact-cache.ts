import { createHash } from "node:crypto";
import { runtimeArtifactSet } from "./runtime-artifacts.ts";

export type ModalArtifactBinding = {
  appId: string;
  appName: string;
  environment: string;
  tokenId: string;
  tokenSecret: string;
};

type SeedRequest = ModalArtifactBinding & {
  directory: string;
  pins: NonNullable<ReturnType<typeof runtimeArtifactSet>>["artifacts"];
};

const seedFailures: Readonly<Record<number, string>> = {
  10: "Modal credential authentication failed",
  11: "Modal App lookup failed",
  12: "Modal App binding does not match the registry",
  13: "local runtime artifact is missing or invalid",
  14: "Modal volume read, upload or verification failed",
};

class ModalArtifactSeedError extends Error {}

export function modalArtifactFailure(error: unknown) {
  return error instanceof ModalArtifactSeedError ? error.message : "could not start or run the Modal artifact seeder";
}

async function seedVolume(request: SeedRequest, signal?: AbortSignal) {
  const process = Bun.spawn(["/opt/armada/modal/bin/python", "/opt/armada/modal-artifact-seed.py"], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "ignore",
    stderr: "ignore",
    env: { MODAL_CONFIG_PATH: "/dev/null" },
    timeout: 120_000,
    ...(signal ? { signal } : {}),
    killSignal: "SIGKILL",
  });
  const code = await process.exited;
  if (code !== 0)
    throw new ModalArtifactSeedError(seedFailures[code] ?? `Modal artifact seeder exited with status ${code}`);
}

export function createModalArtifactCache(
  manifest: unknown,
  directory: string,
  seed: (request: SeedRequest, signal?: AbortSignal) => Promise<void> = seedVolume,
) {
  const set = runtimeArtifactSet(manifest);
  if (!set) throw Error("Invalid Modal runtime artifact set.");
  const pins = [set.runtime, ...set.artifacts];
  const warmed = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const shutdown = new AbortController();
  const queued = new Map<string, () => Promise<void>>();
  let active = 0;
  const bindingKey = (binding: ModalArtifactBinding) =>
    createHash("sha256")
      .update(JSON.stringify([binding.appId, binding.environment, binding.tokenId, binding.tokenSecret]))
      .digest("hex");

  function startQueued() {
    while (active < 4) {
      const next = queued.entries().next().value;
      if (!next) return;
      const [key, run] = next;
      queued.delete(key);
      active++;
      void run();
    }
  }

  function warm(binding: ModalArtifactBinding, startupBudget?: AbortSignal) {
    const key = bindingKey(binding);
    if (warmed.has(key) || shutdown.signal.aborted) return Promise.resolve();
    const current = inFlight.get(key);
    if (current) return current;
    const signal = startupBudget ? AbortSignal.any([startupBudget, shutdown.signal]) : shutdown.signal;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    inFlight.set(key, promise);
    queued.set(key, async () => {
      try {
        signal.throwIfAborted();
        await seed({ ...binding, directory, pins }, signal);
        warmed.add(key);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        inFlight.delete(key);
        active--;
        queueMicrotask(startQueued);
      }
    });
    startQueued();
    return promise;
  }

  return {
    warm,
    beginWarming(binding: ModalArtifactBinding, logError: (line: string) => void) {
      if (inFlight.has(bindingKey(binding))) return;
      void warm(binding).catch((error) => {
        if (!shutdown.signal.aborted)
          logError(`Modal artifact warming failed for an enrolled App: ${modalArtifactFailure(error)}.`);
      });
    },
    async drain() {
      shutdown.abort();
      await Promise.allSettled(inFlight.values());
    },
  };
}
