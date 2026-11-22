import { isHarness, parseApplicationSecretBindings } from "@armada/core";
import { type Sql, VaultError, validateReadableVariables } from "@armada/core/server";
import { type RuntimeConfigurationInput, runtimeConfiguration } from "./runtime-configuration.ts";

/** Read frozen readable values and value-free, version-pinned application-secret references. */
export async function readRuntimeTemplateEnvironment(
  sql: Sql,
  actor: { userId: string; orgId: string },
  sandboxId: string,
  provider: "boat" | "modal",
) {
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
        actor_epoch: string;
        manifest: {
          actorEpoch?: number;
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
      r.id as request_id,r.actor_id,r.org_id as request_org,r.manifest,
      coalesce((select e.epoch from public.mcp_actor_epochs e where e.org_id=s.org_id and e.user_id=s.owner_id),0)::text as actor_epoch
      from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
      left join public.template_launch_requests r on r.sandbox_id=s.id
      where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.provider=$4
      and ((s.provider='modal' and s.runtime_transport='dialout') or (s.provider='boat' and s.boat_runtime)) and s.deleted_at is null`,
        [sandboxId, actor.userId, actor.orgId, provider],
      )
    ).rows;
    if (rows.length !== 1 || !rows[0]) throw Error();
    const row = rows[0];
    if (!isHarness(row.harness)) throw Error();
    if (!row.request_id) return { harness: row.harness, variables: {}, bindings: [] };
    const m = row.manifest;
    if (
      !m ||
      m.version !== 1 ||
      row.actor_id !== actor.userId ||
      row.request_org !== actor.orgId ||
      m.actorId !== actor.userId ||
      m.golden?.id !== row.golden_id ||
      m.golden.provider !== provider ||
      m.account?.id !== row.credential_id ||
      m.account.version !== row.credential_version ||
      m.definition?.provider !== provider ||
      m.definition.harness !== row.harness ||
      m.definition.model !== row.model ||
      m.definition.reasoningEffort !== row.reasoning_effort
    )
      throw Error();
    const values = validateReadableVariables(m.variables);
    if (
      !Array.isArray(m.definition.variables) ||
      JSON.stringify(Object.keys(values).sort()) !==
        JSON.stringify(m.definition.variables.map((binding) => binding.key).sort())
    )
      throw Error();
    const bindings = parseApplicationSecretBindings(m.definition.secrets === undefined ? [] : m.definition.secrets);
    if (
      bindings.length &&
      (String(m.actorEpoch) !== row.actor_epoch || bindings.some(({ key }) => Object.hasOwn(values, key)))
    )
      throw Error();
    return { harness: row.harness, variables: values, bindings };
  } catch {
    throw new VaultError("unavailable", "Frozen runtime readable configuration is unavailable.");
  }
}

/** Merge frozen readables only after private configuration admission succeeds. */
export async function runtimeConfigurationWithVariables(
  sql: Sql,
  input: RuntimeConfigurationInput,
  provider: "boat" | "modal",
  emptyMcpRevision: string,
) {
  const plan = await runtimeConfiguration(input, provider, emptyMcpRevision);
  const { variables } = await readRuntimeTemplateEnvironment(sql, input.actor, input.sandbox.id, provider);
  Object.assign(plan.configuration[`${input.sandbox.harness}Env`], variables);
  return { ...plan, configuration: { ...plan.configuration, readableVariables: variables } };
}
