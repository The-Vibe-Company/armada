import type { Sql } from "@armada/core/server";
import { type RuntimeConfigurationInput, runtimeConfiguration } from "./runtime-configuration.ts";
import { readRuntimeVariables } from "./runtime-readable-variables.ts";

/** Project an ALREADY authorized launch/account pin. Not an account resolver or public DTO.
 * The caller holds launch admission and must send configuration only via encrypted enrolment.
 */
export async function boatRuntimeConfiguration(input: RuntimeConfigurationInput, sql: Sql) {
  const plan = await runtimeConfiguration(input, "boat", "boat_runtime_empty_v1");
  const variables = await readRuntimeVariables(sql, input.actor, input.sandbox.id, "boat");
  Object.assign(
    input.sandbox.harness === "claude" ? plan.configuration.claudeEnv : plan.configuration.codexEnv,
    variables,
  );
  return { ...plan, configuration: { ...plan.configuration, readableVariables: variables } };
}
