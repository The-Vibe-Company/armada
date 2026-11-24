import { MODEL_CATALOG } from "@armada/core";
import { createSqlSandboxStore, type Harness, type PromptRequest } from "@armada/core/server";
import type { TestServer } from "./support.ts";

export async function seedPersistedBoat(
  { boat, db, people }: Pick<TestServer, "boat" | "db" | "people">,
  {
    golden = "shared",
    ownerId = people.member,
    harness = "claude",
    prompt,
    model = MODEL_CATALOG[harness].defaultModel,
    reasoningEffort = MODEL_CATALOG[harness].defaultReasoningEffort,
    credentialId,
  }: {
    golden?: string;
    ownerId?: string;
    harness?: Harness;
    prompt?: string;
    model?: string;
    reasoningEffort?: PromptRequest["reasoningEffort"];
    credentialId?: string;
  } = {},
) {
  const machine = await boat.provider.fork({ from: golden });
  const turn =
    prompt === undefined
      ? null
      : await boat.provider.prompt({ sandboxId: machine.id, harness, text: prompt, model, reasoningEffort });
  const id = crypto.randomUUID();
  const result = await db.query<{ credential_id: string; credential_version: number }>(
    `insert into sandboxes (id,golden_id,org_id,owner_id,provider,provider_sandbox_id,boat_id,
      harness,status,visibility,model,reasoning_effort,task_prompt_id,conversation_ids,credential_id,credential_version)
     select $1,g.id,g.org_id,$2,'boat',$3,$3,$4::harness,$5::sandbox_status,g.visibility,$6,$7,$8,array(select jsonb_array_elements_text($9::jsonb)),c.id,c.version
     from goldens g
     join credentials c on c.id=coalesce($11::uuid, (
       select id from credentials
       where kind::text=case when $4::text='codex' then 'openai' else 'claude_oauth' end
         and ((scope='org' and owner_id=g.org_id) or (scope='user' and owner_id=$2))
       order by (scope='user') desc limit 1
     ))
     where g.org_id=$10 and g.name=$12 returning credential_id,credential_version`,
    [
      id,
      ownerId,
      machine.id,
      harness,
      turn ? "running" : "ready",
      model,
      reasoningEffort,
      turn?.promptId ?? null,
      JSON.stringify(turn ? [turn.conversationId] : []),
      people.org,
      credentialId ?? null,
      golden,
    ],
  );
  const binding = result.rows[0];
  if (!binding) throw Error("Missing persisted Boat fixture golden or credential");
  if (turn)
    await createSqlSandboxStore(db, { turnModels: true }).recordTurnModel!(id, turn.promptId, model, {
      credentialId: binding.credential_id,
      credentialVersion: binding.credential_version,
    });
  return id;
}
