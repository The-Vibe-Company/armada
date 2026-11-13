import { type RuntimeConfigurationInput, runtimeConfiguration } from "./runtime-configuration.ts";

/** Project an ALREADY authorized launch/account pin. Not an account resolver or public DTO.
 * The caller holds launch admission and must send configuration only via encrypted enrolment.
 */
export async function boatRuntimeConfiguration(input: RuntimeConfigurationInput) {
  const plan = await runtimeConfiguration(input, "boat");
  // A retained harness session must not resurrect old MCP defaults before explicit
  // current-epoch configuration. Upstream credentials remain gateway-owned.
  return { ...plan, configuration: { ...plan.configuration, mcp: { revision: "boat_runtime_empty_v1", servers: {} } } };
}
