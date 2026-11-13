import type { RuntimeConfigurationInput, RuntimeConfigurationTarget } from "./runtime-configuration.ts";
import { runtimeConfiguration } from "./runtime-configuration.ts";

/** Private server target: Docker configuration needs no golden or Boat compatibility aliases. */
interface DockerRuntimeTarget extends RuntimeConfigurationTarget {
  provider: "docker";
  harness: RuntimeConfigurationTarget["harness"];
  visibility: "private";
  repositoryDir: null;
  expiresAt: string;
  credentialId: string;
  credentialVersion: number;
}

/** Projection only; admission and encrypted delivery remain with the trusted caller. */
export function dockerRuntimeConfiguration(
  input: Omit<RuntimeConfigurationInput, "sandbox"> & { sandbox: DockerRuntimeTarget },
) {
  return runtimeConfiguration(input, "docker");
}
