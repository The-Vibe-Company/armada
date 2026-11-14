import { type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { SandboxView } from "./data.ts";

/** Caller owns the transaction. Keep membership -> credential before sandbox/epoch locks; no runtime I/O here. */
export async function lockRuntimeAccount(
  tx: Sql,
  caller: Pick<Caller, "userId">,
  sandbox: Pick<SandboxView, "orgId" | "credentialId" | "credentialVersion" | "harness">,
  accountError: string,
): Promise<void> {
  const member = (
    await tx.query("select user_id from public.members where user_id=$1 and org_id=$2 for update", [
      caller.userId,
      sandbox.orgId,
    ])
  ).rows[0];
  if (!member) throw new VaultError("not_found", "Runtime membership was revoked.");
  const account = (
    await tx.query(
      `select id from public.credentials where id=$1 and version=$2
       and status='active' and kind = any($5::public.credential_kind[]) and (expires_at is null or expires_at>now())
       and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for update`,
      [
        sandbox.credentialId,
        sandbox.credentialVersion,
        caller.userId,
        sandbox.orgId,
        sandbox.harness === "claude" ? ["anthropic", "claude_oauth"] : ["openai", "codex_auth"],
      ],
    )
  ).rows[0];
  if (!account) throw new VaultError("not_found", accountError);
}
