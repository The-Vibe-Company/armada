import { installRuntimeArtifact, type RuntimeArtifact } from "../../agent-runtime/src/artifact-cache.ts";
import type { createDockerMachineExecutor, DockerMachineRequest } from "../../core/src/docker-machine.ts";

type Machine = Pick<ReturnType<typeof createDockerMachineExecutor>, "installRuntime">;

/** Trusted fresh-machine installation only. No host-level agent API or runtime hot-swap.
 * The caller owns admission/serialization; enrolment and harness setup remain runtime-owned.
 * The shared installer verifies the exact public artifact route, digest, size and private cache.
 */
export function dockerRuntimeInstaller(machine: Machine, request: typeof fetch = fetch) {
  return async (input: {
    machine: DockerMachineRequest;
    serverUrl: string;
    cacheDir: string;
    artifact: RuntimeArtifact;
  }): Promise<void> => {
    try {
      const path = await installRuntimeArtifact(
        { serverUrl: input.serverUrl, cacheDir: input.cacheDir, artifact: input.artifact },
        request,
      );
      await machine.installRuntime(input.machine, new Uint8Array(await Bun.file(path).arrayBuffer()));
    } catch {
      // Neither artifact transport output nor Docker diagnostics are public receipts.
      throw new Error("Docker runtime installation failed");
    }
  };
}
