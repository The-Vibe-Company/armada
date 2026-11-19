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
  if ((await process.exited) !== 0) throw Error("Modal runtime artifact seed failed.");
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
  const queued = new Map<string, { binding: ModalArtifactBinding; logError: (line: string) => void }>();
  const bindingKey = (binding: ModalArtifactBinding) =>
    createHash("sha256")
      .update(JSON.stringify([binding.appId, binding.environment, binding.tokenId, binding.tokenSecret]))
      .digest("hex");
  function warm(binding: ModalArtifactBinding, startupBudget?: AbortSignal) {
    const key = bindingKey(binding);
    if (warmed.has(key) || shutdown.signal.aborted) return Promise.resolve();
    const current = inFlight.get(key);
    if (current) return current;
    const signal = startupBudget ? AbortSignal.any([startupBudget, shutdown.signal]) : shutdown.signal;
    const pending = seed({ ...binding, directory, pins }, signal)
      .then(() => {
        warmed.add(key);
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, pending);
    return pending;
  }
  function startQueued() {
    while (!shutdown.signal.aborted && inFlight.size < 4) {
      const next = queued.entries().next().value;
      if (!next) return;
      const [key, { binding, logError }] = next;
      queued.delete(key);
      void warm(binding)
        .catch(() => {
          logError("Modal artifact warming failed for an enrolled App.");
        })
        .finally(startQueued);
    }
  }
  return {
    warm,
    beginWarming(binding: ModalArtifactBinding, logError: (line: string) => void) {
      if (shutdown.signal.aborted) return;
      const key = bindingKey(binding);
      if (warmed.has(key) || inFlight.has(key) || queued.has(key)) return;
      queued.set(key, { binding, logError });
      startQueued();
    },
    async drain() {
      shutdown.abort();
      queued.clear();
      await Promise.allSettled(inFlight.values());
    },
  };
}
