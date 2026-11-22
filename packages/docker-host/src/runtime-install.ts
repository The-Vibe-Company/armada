import { installRuntimeArtifact, type RuntimeArtifact } from "../../agent-runtime/src/artifact-cache.ts";
import type { createDockerMachineExecutor, DockerMachineRequest } from "../../core/src/docker-machine.ts";

type Machine = Pick<ReturnType<typeof createDockerMachineExecutor>, "installRuntime">;

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
      throw new Error("Docker runtime installation failed");
    }
  };
}

const START_RUNTIME =
  '[ "$(command -v printf)" = printf ] || exit 1; payload=$(cat) || exit 1; (trap "" HUP; command printf "%s" "$payload" | "$1" dialout >/dev/null 2>&1) </dev/null >/dev/null 2>&1 &';

export function dockerRuntimeStarter(
  machine: Machine & Pick<ReturnType<typeof createDockerMachineExecutor>, "bootstrap">,
  options: {
    serverUrl: string;
    cacheDir: string;
    warmSharedArtifacts?: (runtime: string) => unknown;
  },
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
    void options.warmSharedArtifacts?.(bootstrap.artifact.sha256);
  };
}
