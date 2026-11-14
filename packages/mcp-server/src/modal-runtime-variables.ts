import { type Sql, VaultError, validateReadableVariables } from "@armada/core/server";
import { type RuntimeConfigurationInput, runtimeConfiguration } from "./runtime-configuration.ts";

/** Readable values were copied at template admission. Never re-resolve mutable
 * variable sources on later turns/resume, and never decrypt application secrets.
 * This projection stays server-side until encrypted enrolment delivers it.
 */
export async function readModalRuntimeVariables(
  sql: Sql,
  actor: { userId: string; orgId: string },
  sandboxId: string,
): Promise<Record<string, string>> {
  try {
    const rows = (
      await sql.query<{
        golden_id: string;
        harness: string;
        credential_id: string | null;
        credential_version: number | null;
        model: string | null;
        reasoning_effort: string | null;
        request_id: string | null;
        actor_id: string | null;
        request_org: string | null;
        manifest: {
          actorId?: string;
          version?: number;
          golden?: { id?: string; provider?: string };
          account?: { id?: string; version?: number };
          definition?: {
            provider?: string;
            harness?: string;
            model?: string;
            reasoningEffort?: string;
            secrets?: unknown;
            variables?: { key?: unknown }[];
          };
          variables?: unknown;
        } | null;
      }>(
        `select s.golden_id,s.harness::text,s.credential_id,s.credential_version,s.model,s.reasoning_effort,
      r.id as request_id,r.actor_id,r.org_id as request_org,r.manifest
      from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
      left join public.template_launch_requests r on r.sandbox_id=s.id
      where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.provider='modal'
      and s.runtime_transport='dialout' and s.deleted_at is null`,
        [sandboxId, actor.userId, actor.orgId],
      )
    ).rows;
    if (rows.length !== 1 || !rows[0]) throw Error();
    const row = rows[0];
    if (!row.request_id) return {};
    const m = row.manifest;
    if (
      !m ||
      m.version !== 1 ||
      row.actor_id !== actor.userId ||
      row.request_org !== actor.orgId ||
      m.actorId !== actor.userId ||
      m.golden?.id !== row.golden_id ||
      m.golden.provider !== "modal" ||
      m.account?.id !== row.credential_id ||
      m.account.version !== row.credential_version ||
      m.definition?.provider !== "modal" ||
      m.definition.harness !== row.harness ||
      m.definition.model !== row.model ||
      m.definition.reasoningEffort !== row.reasoning_effort ||
      (m.definition.secrets !== undefined && (!Array.isArray(m.definition.secrets) || m.definition.secrets.length > 0))
    )
      throw Error();
    const values = validateReadableVariables(m.variables);
    if (
      !Array.isArray(m.definition.variables) ||
      JSON.stringify(Object.keys(values).sort()) !==
        JSON.stringify(m.definition.variables.map((binding) => binding.key).sort())
    )
      throw Error();
    return values;
  } catch {
    throw new VaultError("unavailable", "Frozen runtime readable configuration is unavailable.");
  }
}

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
