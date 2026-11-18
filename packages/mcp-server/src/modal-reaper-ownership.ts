import type { ModalBinding, SandboxStatus, Sql } from "@armada/core";
import type { ProviderReaperSource } from "./provider-reaper.ts";

interface OwnershipEvidence {
  status: SandboxStatus | null;
  logical_id: string | null;
  physical_id: string | null;
  generation: string | null;
  same_binding: boolean | null;
  same_owner: boolean | null;
}

/** Ownership port for a Modal inventory already scoped to one verified binding.
 * The supplied SQL connection must bound statement time for the isolated lane.
 * This observation does not fence launch/resume and cannot authorize a delete.
 */
export function createModalReaperOwnership(sql: Sql, binding: ModalBinding): ProviderReaperSource["lookupOwnership"] {
  const { workspace, environment, appId } = binding;
  return async (machine, signal) => {
    signal.throwIfAborted();
    if (!machine.sandboxId?.trim()) return { kind: "unresolved" };
    // The provider's logical ID is in the tag. Check the reverse mapping too,
    // in case the tag disagrees with the persisted owner of this physical ID.
    // One statement observes both stores at the same snapshot.
    const { rows } = await sql.query<OwnershipEvidence>(
      `select s.status,
              m.id as logical_id,
              m.record->>'physicalId' as physical_id,
              m.record->>'generation' as generation,
              (c.context->'binding'->>'workspace'=$3::text
               and c.context->'binding'->>'environment'=$4::text
               and c.context->'binding'->>'appId'=$5::text
               and (s.id is null or (g.modal_workspace=$3 and g.modal_environment=$4 and g.modal_app_id=$5))) as same_binding,
              (m.org_id=s.org_id and m.owner_id=s.owner_id) as same_owner
       from (values ($1::text,$2::text)) as inventory(logical_id,physical_id)
       left join public.sandboxes s on s.provider='modal' and s.provider_sandbox_id=inventory.logical_id
       left join public.goldens g on g.id=s.golden_id
       left join public.modal_machines m on m.id=inventory.logical_id or m.record->>'physicalId'=inventory.physical_id
       left join public.modal_server_scopes c on c.scope=m.scope
       limit 2`,
      [machine.sandboxId, machine.machineId, workspace, environment, appId],
    );
    signal.throwIfAborted();
    const [evidence] = rows;
    if (
      rows.length !== 1 ||
      !evidence ||
      (evidence.logical_id !== null &&
        (evidence.logical_id !== machine.sandboxId ||
          !evidence.same_binding ||
          (evidence.status && !evidence.same_owner)))
    ) {
      return { kind: "unresolved" };
    }
    if (!evidence.status) return { kind: "absent" };
    const { generation } = evidence;
    const exactGeneration =
      evidence.physical_id === machine.machineId && generation && generation === machine.generation;
    return {
      kind: "owned",
      status: evidence.status,
      ...(exactGeneration ? { generation } : {}),
    };
  };
}
