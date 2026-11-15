import type { Sql } from "@armada/core/server";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { runtimeConfigurationWithVariables } from "./runtime-readable-variables.ts";

/** Project an ALREADY authorized launch/account pin. Not an account resolver or public DTO.
 * The caller holds launch admission and must send configuration only via encrypted enrolment.
 */
export async function boatRuntimeConfiguration(input: RuntimeConfigurationInput, sql: Sql) {
  return runtimeConfigurationWithVariables(sql, input, "boat", "boat_runtime_empty_v1");
}
