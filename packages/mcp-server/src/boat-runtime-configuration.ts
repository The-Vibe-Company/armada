import { type RuntimeConfigurationInput, runtimeConfiguration } from "./runtime-configuration.ts";

/** Project an ALREADY authorized launch/account pin. Not an account resolver or public DTO.
 * The caller holds launch admission and must send configuration only via encrypted enrolment.
 */
export async function boatRuntimeConfiguration(input: RuntimeConfigurationInput) {
  return runtimeConfiguration(input, "boat", "boat_runtime_empty_v1");
}
