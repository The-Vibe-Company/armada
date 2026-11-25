import { sha256Hex } from "@armada/auth";
import { type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { RuntimeResumeReceipt } from "./runtime-resume.ts";

export async function historicalModalResumeReceipt(
  sql: Sql,
  caller: Caller,
  input: { id: string; requestId: string; prompt: string },
) {
  const {
    rows: [saved],
  } = await sql.query<{
    id: string;
    conversation_id: string;
    request_hash: string;
    receipt: RuntimeResumeReceipt | null;
  }>(
    `select s.id,r.conversation_id,r.request_hash,r.receipt
       from public.runtime_resumes r join public.sandboxes s on s.id=r.sandbox_id
       join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
       where r.sandbox_id=$1 and r.request_id=$2 and s.owner_id=$3 and s.org_id=any($4::uuid[])
         and s.runtime_transport='dialout' and s.deleted_at is null`,
    [input.id, input.requestId, caller.userId, caller.orgs.map((org) => org.orgId)],
  );
  if (!saved) return;
  const digest = await sha256Hex(
    JSON.stringify({
      id: saved.id,
      requestId: input.requestId,
      conversation: saved.conversation_id,
      prompt: input.prompt,
    }),
  );
  if (digest !== saved.request_hash)
    throw new VaultError("conflict", "Reuse the original resume request ID with identical input.");
  if (!saved.receipt) throw new VaultError("conflict", "The historical resume has no accepted prompt receipt.");
  return saved.receipt;
}
