import type { Sql } from "@armada/core/server";
import { type RuntimeConfigurationInput, runtimeConfiguration } from "./runtime-configuration.ts";
import { readRuntimeVariables } from "./runtime-readable-variables.ts";

export const readModalRuntimeVariables = (sql: Sql, actor: { userId: string; orgId: string }, sandboxId: string) =>
  readRuntimeVariables(sql, actor, sandboxId, "modal");

/** Credentials and frozen readables meet only in the private enrolment payload. */
export async function modalRuntimeConfiguration(sql: Sql, input: RuntimeConfigurationInput) {
  const plan = await runtimeConfiguration(input, "modal", "modal_runtime_empty_v1");
  const variables = await readModalRuntimeVariables(sql, input.actor, input.sandbox.id);
  Object.assign(
    input.sandbox.harness === "claude"
      ? plan.configuration.claudeEnv
      : input.sandbox.harness === "opencode"
        ? plan.configuration.opencodeEnv
        : plan.configuration.codexEnv,
    variables,
  );
  return { ...plan, configuration: { ...plan.configuration, readableVariables: variables } };
}
