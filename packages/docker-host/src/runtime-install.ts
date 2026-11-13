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

/** Fixed non-interactive launcher: input remains data on private stdin, never
 * a shell argument/environment/file. Background output is disconnected before
 * the docker exec shell exits; the runtime thereafter owns its dial-out channel.
 */
const START_RUNTIME =
  '[ "$(command -v printf)" = printf ] || exit 1; payload=$(cat) || exit 1; (trap "" HUP; command printf "%s" "$payload" | "$1" dialout >/dev/null 2>&1) </dev/null >/dev/null 2>&1 &';

/** Called only after the daemon durably fences a newly admitted bootstrap job. */
export function dockerRuntimeStarter(
  machine: Machine & Pick<ReturnType<typeof createDockerMachineExecutor>, "bootstrap">,
  options: { serverUrl: string; cacheDir: string },
  request: typeof fetch = fetch,
) {
  const install = dockerRuntimeInstaller(machine, request);
  return async (
    target: DockerMachineRequest,
    bootstrap: import("../../core/src/docker-host-job.ts").BootstrapDescriptor,
  ) => {
    try {
      const server = new URL(options.serverUrl);
      if (
        server.protocol !== "https:" ||
        server.username ||
        server.password ||
        server.pathname !== "/" ||
        server.search ||
        server.hash ||
        bootstrap.serverUrl !== server.origin ||
        !/^armada_enrol_[a-f0-9]{64}$/.test(bootstrap.enrolmentToken)
      )
        throw new Error("Invalid runtime bootstrap");
      await install({
        machine: target,
        serverUrl: server.origin,
        cacheDir: options.cacheDir,
        artifact: bootstrap.artifact,
      });
      await machine.bootstrap(target, {
        command: ["/bin/sh", "-c", START_RUNTIME, "armada-runtime-start", "/home/user/armada-runtime"],
        stdin: JSON.stringify({ serverUrl: server.origin, enrolmentToken: bootstrap.enrolmentToken }),
      });
    } catch {
      throw new Error("Docker runtime bootstrap failed");
    }
  };
}
