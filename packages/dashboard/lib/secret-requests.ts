// Secret requests carry names and reasons only. Values enter through one
// authorized vault write, sharing a transaction with its audit and decision.
import { type SecretRequestInput, type SecretRequestResult, secretNameRefusal } from "@armada/core/read";
import { type Database, transaction } from "./db";
import { addValidationInTransaction, decideValidationInTransaction, getValidation } from "./fleet-store";
import type { RequestResult } from "./requests";
import { type Actor, checkWorkerSecret, setSecretInTransaction, type VaultKey } from "./vault";

export async function requestSecret(
  db: Database,
  input: SecretRequestInput & { project: string; author: string | null; at: Date },
): Promise<SecretRequestResult> {
  if (secretNameRefusal(input.name)) throw new Error("invalid worker secret name");
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`validations:${input.project}`]);
    const set = await tx.query(
      `SELECT s.name FROM armada_secret s JOIN projects p ON p.organization_id = s."organizationId"
       WHERE p.slug = $1 AND s.project IN ('', $1) AND s."userId" = '' AND s.name = $2 LIMIT 1`,
      [input.project, input.name],
    );
    if (set.rows.length) return { state: "already-set" };
    const open = await tx.query<{ id: unknown }>(
      "SELECT id FROM validations WHERE project = $1 AND secret_name = $2 AND kind = 'secret' AND decided_at IS NULL",
      [input.project, input.name],
    );
    if (open.rows[0]) {
      const validation = await getValidation(tx, input.project, Number(open.rows[0].id));
      if (validation) return { state: "requested", validation };
    }
    const validation = await addValidationInTransaction(tx, {
      project: input.project,
      ticket: input.ticket,
      kind: "secret",
      secretName: input.name,
      what: `Set ${input.name}`,
      reason: input.reason,
      choices: null,
      pr: null,
      attachments: [],
      author: input.author,
      at: input.at,
    });
    return { state: "requested", validation };
  });
}

/** The server supplies organization, current role and actor; the form supplies only id and value. */
export async function answerSecretRequest(
  db: Database,
  vault: VaultKey,
  input: { organization: string; role: string; project: string; id: number; value: string; actor: Actor; now: Date },
): Promise<RequestResult> {
  if (input.role !== "owner" && input.role !== "admin")
    return { ok: false, code: "no-choice", message: "an owner or admin sets this secret" };
  if (!checkWorkerSecret(input.value))
    return { ok: false, code: "empty-answer", message: "enter a secret value of at most 32768 characters" };
  return transaction(db, async (tx) => {
    const project = await tx.query("SELECT slug FROM projects WHERE slug = $1 AND organization_id = $2", [
      input.project,
      input.organization,
    ]);
    if (!project.rows.length) return { ok: false, code: "unknown-project", message: "unknown project" };
    // Serialize request creation and completion, and prevent two saves replacing the value.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`validations:${input.project}`]);
    await tx.query("SELECT id FROM validations WHERE project = $1 AND id = $2 FOR UPDATE", [input.project, input.id]);
    const validation = await getValidation(tx, input.project, input.id);
    if (validation?.kind !== "secret" || !validation.secretName)
      return { ok: false, code: "no-validation", message: "no secret request" };
    if (validation.decision) return { ok: false, code: "validation-closed", message: "request already completed" };
    await setSecretInTransaction(tx, vault, {
      organization: input.organization,
      project: input.project,
      user: null,
      name: validation.secretName,
      value: input.value,
      actor: input.actor,
      now: input.now,
    });
    const result = await decideValidationInTransaction(tx, {
      project: input.project,
      id: input.id,
      decision: { outcome: "answered", answer: "set", note: null, by: input.actor.label },
      body: `${validation.secretName} is set for ${input.project}`,
      at: input.now,
    });
    if (!result) throw new Error("secret request completion failed");
    return { ok: true, id: result.item };
  });
}
