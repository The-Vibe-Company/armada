import type { GoldenActor, HarnessCredentials, SandboxRecord } from "@armada/core";
import type { ModelAuthOwnership } from "./model-auth.ts";
import { runtimeConfiguration } from "./runtime-configuration.ts";

/** Project an ALREADY authorized launch/account pin. Not an account resolver or public DTO.
 * The caller holds launch admission and must send configuration only via encrypted enrolment.
 */
export async function boatRuntimeConfiguration(input: {
  actor: GoldenActor;
  sandbox: SandboxRecord;
  credentials: HarnessCredentials;
  manifest: unknown;
  architecture: "x64" | "arm64";
  modelAuth?: {
    state: Pick<ModelAuthOwnership["state"], "read">;
    broker?: Pick<NonNullable<ModelAuthOwnership["broker"]>, "access"> | undefined;
  };
}) {
  return runtimeConfiguration(input, "boat");
}
