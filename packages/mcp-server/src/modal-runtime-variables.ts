import type { Sql } from "@armada/core/server";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { readRuntimeVariables, runtimeConfigurationWithVariables } from "./runtime-readable-variables.ts";

export const readModalRuntimeVariables = (sql: Sql, actor: { userId: string; orgId: string }, sandboxId: string) =>
  readRuntimeVariables(sql, actor, sandboxId, "modal");

/** Credentials and frozen readables meet only in the private enrolment payload. */
export async function modalRuntimeConfiguration(sql: Sql, input: RuntimeConfigurationInput) {
  return runtimeConfigurationWithVariables(sql, input, "modal", "modal_runtime_empty_v1");
}
