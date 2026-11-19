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
  // The pinned Python SDK implements large-file uploads for both Volume versions.
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
  const warmed = new Map<string, Promise<void>>();
  return (binding: ModalArtifactBinding, signal?: AbortSignal): Promise<void> => {
    // Bind success to the verified App, environment and current credential.
    const key = createHash("sha256")
      .update(JSON.stringify([binding.appId, binding.environment, binding.tokenId, binding.tokenSecret]))
      .digest("hex");
    const current = warmed.get(key);
    if (current) return current;
    const pending = seed({ ...binding, directory, pins }, signal).catch((error: unknown) => {
      warmed.delete(key);
      throw error;
    });
    warmed.set(key, pending);
    return pending;
  };
}
